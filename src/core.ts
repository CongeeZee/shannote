/**
 * The Brain: one object that owns the vault, index and sync for a process.
 * Both the MCP server and the web app call into this, so behaviour (write
 * safety, commits, session tracking) is identical whichever way you use it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, posix } from "node:path";
import { indexPath } from "./config.js";
import { openDb, type DB } from "./index/db.js";
import { indexVault } from "./index/indexer.js";
import { doctor, vaultStatus } from "./index/queries.js";
import type { Embedder } from "./search/embed.js";
import { type SearchOptions } from "./search/keyword.js";
import { embedPending, hybridSearch, pendingCount, VectorStore, type SearchMode } from "./search/semantic.js";
import {
  listThreads,
  readThread,
  recentSessions,
  updateThread,
  writeSessionLog,
  type ThreadStatus,
  type ThreadUpdate,
} from "./session/sessions.js";
import { GitSync, type PullResult } from "./sync/git.js";
import { addDays, BrainError, localDate, localIso, sha1, ulid } from "./util.js";
import {
  appendText,
  appendToSection,
  prependText,
  replaceSection,
  replaceText,
  rewriteLinks,
  setFrontmatter,
  setTaskLine,
  stamp,
} from "./vault/edit.js";
import { parseNote } from "./vault/parse.js";
import { parseInbox, type InboxEntry } from "./inbox.js";
import { findUnlinkedMentions, linkMention } from "./links.js";
import { readdirSync, unlinkSync } from "node:fs";
import { eventsBetween, type CalendarEvent } from "./plan/calendar.js";
import { isWhenDone, nextOccurrence } from "./plan/recur.js";
import { parseSchedule, sectionOf } from "./plan/schedule.js";
import { isoWeek, weekRange, type PlanKind } from "./plan/planning.js";
import { LinkResolver } from "./vault/resolve.js";
import { renderTemplate, TEMPLATES } from "./vault/templates.js";

export type EditOp =
  | { op: "append"; text: string }
  | { op: "prepend"; text: string }
  | { op: "append_to_section"; heading: string; text: string }
  | { op: "replace_section"; heading: string; text: string }
  | { op: "replace_text"; old_text: string; new_text: string }
  | { op: "set_frontmatter"; fields: Record<string, unknown> };

export interface TaskRow {
  id: string;
  path: string;
  line: number;
  text: string;
  status: string;
  due: string | null;
  scheduled: string | null;
  done_date: string | null;
  note_title: string;
}

export interface TaskFilter {
  status?: "open" | "done" | "all";
  due_before?: string;
  due_after?: string;
  overdue?: boolean;
  path?: string;
  tag?: string;
  /** Completed on or after / before (YYYY-MM-DD), for reviews. */
  done_after?: string;
  done_before?: string;
  limit?: number;
}

export interface BrainOptions {
  vault: string;
  device: string;
  client?: string;
  /** Push automatically after writes (debounced). Default true. */
  autoPush?: boolean;
  dbFile?: string;
  /** Track writes as a Claude session (implicit handoff on exit). Off for the web app. */
  trackSessions?: boolean;
  /** Embedder for semantic search; null/undefined = keyword search only. */
  embedder?: Embedder | null;
  /** Embed new/changed sections in the background after each index run. Default true. */
  backgroundEmbed?: boolean;
}

export interface EmbedState {
  model: string | null;
  running: boolean;
  embedded: number;
  total: number;
  error?: string;
}

const PULL_INTERVAL_MS = 60_000;

/** Shortens text to at most `max` chars, cutting at a paragraph, line or sentence end. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 2);
  const at = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf("\n"), cut.lastIndexOf(". ") + 1);
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut.replace(/\s+\S*$/, "")).trimEnd()} …`;
}
const PUSH_DEBOUNCE_MS = 10_000;
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

export class Brain {
  readonly vault: string;
  readonly device: string;
  readonly client?: string;
  readonly db: DB;
  readonly sync: GitSync;

  private lastPullAt = 0;
  private pushTimer: NodeJS.Timeout | null = null;
  private autoPush: boolean;
  private trackSessions: boolean;
  /**
   * Git sync only runs in vaults set up with `brain init` (they have
   * `_brain/config.yml`). Pointing the app at some other folder, like an existing
   * Obsidian vault, never commits, pulls or pushes there.
   */
  readonly syncEnabled: boolean;
  private session: { started: string; touched: Set<string>; ended: boolean } | null = null;
  readonly embedder: Embedder | null;
  private store: VectorStore | null;
  private backgroundEmbed: boolean;
  private embedRun: Promise<number> | null = null;
  private embedError: { message: string; at: number } | null = null;
  private stopping = false;

  constructor(opts: BrainOptions) {
    this.vault = opts.vault;
    this.device = opts.device;
    this.client = opts.client;
    this.autoPush = opts.autoPush ?? true;
    this.trackSessions = opts.trackSessions ?? true;
    this.syncEnabled = existsSync(join(opts.vault, "_brain", "config.yml"));
    this.db = openDb(opts.dbFile ?? indexPath(opts.vault));
    this.sync = new GitSync(opts.vault, opts.device);
    this.embedder = opts.embedder ?? null;
    this.store = this.embedder ? new VectorStore(this.db, this.embedder.id) : null;
    this.backgroundEmbed = opts.backgroundEmbed ?? true;
  }

  // ------------------------------------------------------------ lifecycle

  /** Pull (at most once a minute) and bring the index up to date. */
  async fresh(opts: { forcePull?: boolean } = {}): Promise<PullResult | null> {
    let pulled: PullResult | null = null;
    if (this.syncEnabled && (opts.forcePull || Date.now() - this.lastPullAt > PULL_INTERVAL_MS)) {
      this.lastPullAt = Date.now();
      try {
        pulled = this.sync.pull();
      } catch (e) {
        pulled = { status: "offline", changed: [], conflicts: [], error: (e as Error).message };
      }
    }
    await this.reindex();
    return pulled;
  }

  private indexing: Promise<unknown> = Promise.resolve();

  /** Serialises index runs within this process. */
  reindex(): Promise<unknown> {
    const run = this.indexing.then(() => indexVault(this.db, this.vault));
    this.indexing = run.catch(() => undefined);
    if (this.backgroundEmbed) void run.then(() => this.startEmbedding()).catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------ embeddings

  /**
   * Embeds new or changed sections. Single-flight: concurrent calls share one run.
   * After a failure (e.g. model download blocked) it waits 10 minutes before retrying.
   */
  startEmbedding(onProgress?: (done: number, total: number) => void): Promise<number> {
    if (!this.embedder || this.stopping) return Promise.resolve(0);
    if (this.embedRun) return this.embedRun;
    if (this.embedError && Date.now() - this.embedError.at < 10 * 60_000 && !onProgress) return Promise.resolve(0);
    const embedder = this.embedder;
    this.embedRun = (async () => {
      try {
        const n = await embedPending(this.db, embedder, {
          onProgress: (p) => onProgress?.(p.done, p.total),
          shouldStop: () => this.stopping,
        });
        this.embedError = null;
        return n;
      } catch (e) {
        this.embedError = { message: (e as Error).message, at: Date.now() };
        if (onProgress) throw e;
        process.stderr.write(`[brain] embedding failed: ${(e as Error).message}\n`);
        return 0;
      } finally {
        this.embedRun = null;
      }
    })();
    return this.embedRun;
  }

  embedState(): EmbedState {
    if (!this.embedder) return { model: null, running: false, embedded: 0, total: 0 };
    const { pending, total } = pendingCount(this.db, this.embedder.id);
    return {
      model: this.embedder.id,
      running: !!this.embedRun,
      embedded: total - pending,
      total,
      error: this.embedError?.message,
    };
  }

  /** Flush pending pushes and write an implicit session log if needed. Synchronous. */
  shutdown(): void {
    this.stopping = true;
    if (this.session && !this.session.ended && this.session.touched.size > 0) {
      const rel = writeSessionLog(this.vault, {
        device: this.device,
        client: this.client,
        started: this.session.started,
        touched: [...this.session.touched],
        summary: "Session ended without a handoff. Files touched are listed above.",
        handoff: false,
      });
      this.session.ended = true;
      try {
        if (this.syncEnabled) this.sync.commit(`session(${this.device}): implicit log`, [rel]);
      } catch {
        /* best effort */
      }
    }
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
      if (this.autoPush && this.syncEnabled) this.sync.push();
    }
    this.db.close();
  }

  private schedulePush(): void {
    if (!this.autoPush || !this.syncEnabled) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.sync.push();
    }, PUSH_DEBOUNCE_MS);
    this.pushTimer.unref?.();
  }

  private touch(paths: string[]): void {
    if (!this.trackSessions) return;
    if (!this.session) this.session = { started: localIso(), touched: new Set(), ended: false };
    for (const p of paths) this.session.touched.add(p);
  }

  // ------------------------------------------------------------ paths

  /** Validates a vault-relative note path. Adds `.md` if missing. */
  safePath(input: string): string {
    let p = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!p) throw new BrainError("Empty path", "invalid_path");
    if (!/\.md$/i.test(p)) p += ".md";
    const norm = posix.normalize(p);
    if (norm.startsWith("../") || norm === ".." || norm.split("/").some((s) => s.startsWith(".")))
      throw new BrainError(`Path is outside the vault or hidden: ${input}`, "invalid_path");
    if (norm.startsWith("_brain/") && !/^_brain\/(threads|sessions)\//.test(norm))
      throw new BrainError("The _brain folder is managed by the app", "invalid_path");
    return norm;
  }

  private abs(rel: string): string {
    return join(this.vault, normalize(rel));
  }

  /** Resolves a path, title, file name or frontmatter id to a note path. */
  resolveRef(ref: string): string {
    const r = ref.trim().replace(/^\[\[|\]\]$/g, "");
    if (!r) throw new BrainError("Empty note reference", "invalid");
    const byPath = this.db.prepare("SELECT path FROM notes WHERE path = ? OR path = ?").get(r, `${r}.md`) as
      | { path: string }
      | undefined;
    if (byPath) return byPath.path;
    const byId = this.db.prepare("SELECT path FROM notes WHERE id = ?").get(r) as { path: string } | undefined;
    if (byId) return byId.path;
    const byTitle = this.db
      .prepare("SELECT path FROM notes WHERE lower(title) = lower(?) ORDER BY length(path) LIMIT 2")
      .all(r) as Array<{ path: string }>;
    if (byTitle.length === 1) return byTitle[0]!.path;
    const paths = (this.db.prepare("SELECT path FROM notes").all() as Array<{ path: string }>).map((x) => x.path);
    const resolved = new LinkResolver(paths).resolve(r);
    if (resolved) return resolved;
    if (byTitle.length) return byTitle[0]!.path;
    throw new BrainError(`Note not found: ${ref}`, "not_found");
  }

  // ------------------------------------------------------------ reads

  async read(ref: string, heading?: string) {
    await this.fresh();
    const path = this.resolveRef(ref);
    const content = readFileSync(this.abs(path), "utf8");
    const note = parseNote(path, content);
    let text = content;
    if (heading) {
      const h = note.headings.find((x) => x.text.toLowerCase() === heading.replace(/^#+\s*/, "").toLowerCase());
      if (!h) throw new BrainError(`Heading not found: ${heading}`, "no_match");
      const next = note.headings.find((x) => x.line > h.line && x.level <= h.level);
      const lines = content.split("\n");
      text = lines.slice(h.line - 1, next ? next.line - 1 : lines.length).join("\n").trimEnd();
    }
    return {
      path,
      title: note.title,
      hash: sha1(content).slice(0, 16),
      frontmatter: note.frontmatter,
      headings: note.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`),
      content: text,
    };
  }

  async search(query: string, opts: SearchOptions & { mode?: SearchMode } = {}) {
    await this.fresh();
    const r = await hybridSearch(this.db, this.store, this.embedder, query, opts);
    const state = this.embedState();
    return {
      results: r.hits,
      semantic: r.semantic,
      ...(r.semantic !== "skipped" && state.embedded < state.total
        ? { note: `Semantic index ${state.embedded}/${state.total} sections; results may be incomplete.` }
        : {}),
      ...(r.semantic === "unavailable"
        ? {
            note:
              r.error || state.error
                ? `Semantic search unavailable (${r.error ?? state.error}); keyword results only.`
                : "Semantic index is still empty; keyword results only.",
          }
        : {}),
    };
  }

  /** @param minSimilarity cosine cut-off for `similar` (tuned for MiniLM-class models). */
  async related(ref: string, minSimilarity = 0.35) {
    await this.fresh();
    const path = this.resolveRef(ref);
    const backlinks = this.db
      .prepare(
        `SELECT l.src AS path, n.title, COUNT(*) AS count FROM links l JOIN notes n ON n.path = l.src
          WHERE l.target_path = ? AND l.src != ? GROUP BY l.src ORDER BY count DESC, n.title`,
      )
      .all(path, path);
    const outgoing = this.db
      .prepare(
        `SELECT l.target_path AS path, n.title, COUNT(*) AS count FROM links l JOIN notes n ON n.path = l.target_path
          WHERE l.src = ? AND l.target_path != ? GROUP BY l.target_path ORDER BY count DESC, n.title`,
      )
      .all(path, path);
    const unresolved = (
      this.db
        .prepare("SELECT DISTINCT target_raw FROM links WHERE src = ? AND target_path IS NULL")
        .all(path) as Array<{ target_raw: string }>
    ).map((r) => r.target_raw);
    // Notes about similar things that aren't linked yet: candidates for new links.
    let similar: Array<{ path: string; title: string; score: number; section?: string }> = [];
    if (this.store) {
      const centroid = this.store.centroid(path);
      if (centroid) {
        const linked = new Set<string>([path, ...(backlinks as Array<{ path: string }>).map((b) => b.path), ...(outgoing as Array<{ path: string }>).map((o) => o.path)]);
        const titleOf = this.db.prepare("SELECT title FROM notes WHERE path = ?");
        similar = this.store
          .searchNotes(centroid, { limit: 8, exclude: linked, filter: (p) => !p.startsWith("_brain/") })
          .filter((h) => h.score >= minSimilarity)
          .map((h) => ({
            path: h.item.path,
            title: (titleOf.get(h.item.path) as { title: string } | undefined)?.title ?? h.item.path,
            score: Number(h.score.toFixed(3)),
            section: h.item.heading || undefined,
          }));
      }
    }
    return { path, backlinks, outgoing, unresolved, similar };
  }

  async tasks(f: TaskFilter = {}): Promise<TaskRow[]> {
    await this.fresh();
    const where: string[] = [];
    const p: Record<string, unknown> = { limit: f.limit ?? 100 };
    const status = f.status ?? "open";
    if (status === "open") where.push("t.status IN ('todo','in_progress')");
    if (status === "done") where.push("t.status = 'done'");
    if (f.overdue) {
      where.push("t.due < @today");
      p.today = localDate();
    }
    if (f.due_before) {
      where.push("t.due <= @due_before");
      p.due_before = f.due_before;
    }
    if (f.due_after) {
      where.push("t.due >= @due_after");
      p.due_after = f.due_after;
    }
    if (f.done_after) {
      where.push("t.done_date >= @done_after");
      p.done_after = f.done_after;
    }
    if (f.done_before) {
      where.push("t.done_date <= @done_before");
      p.done_before = f.done_before;
    }
    if (f.path) {
      where.push("t.path = @path");
      p.path = this.resolveRef(f.path);
    }
    if (f.tag) {
      where.push("(EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = @tag) OR EXISTS (SELECT 1 FROM tags g WHERE g.path = t.path AND g.tag = @tag))");
      p.tag = f.tag.replace(/^#/, "").toLowerCase();
    }
    // Ignore the app's own logs and templates.
    where.push("t.path NOT LIKE '\\_brain/sessions/%' ESCAPE '\\'");
    return this.db
      .prepare(
        `SELECT t.id, t.path, t.line, t.text, t.status, t.due, t.scheduled, t.done_date, n.title AS note_title
           FROM tasks t JOIN notes n ON n.path = t.path
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY t.due IS NULL, t.due, t.scheduled IS NULL, t.scheduled, t.path, t.line
          LIMIT @limit`,
      )
      .all(p) as TaskRow[];
  }

  async recent(opts: { since?: string; device?: string; limit?: number } = {}) {
    await this.fresh();
    let entries = this.sync.log({ since: opts.since, limit: (opts.limit ?? 20) * 3 });
    if (opts.device) entries = entries.filter((e) => e.device === opts.device);
    return entries.slice(0, opts.limit ?? 20);
  }

  async status() {
    await this.fresh();
    return {
      vault: this.vault,
      device: this.device,
      ...vaultStatus(this.db),
      sync: { ...this.sync.status(), enabled: this.syncEnabled },
      embeddings: this.embedState(),
      inbox: this.allInboxEntries().length,
    };
  }

  async doctor() {
    await this.fresh();
    return doctor(this.db);
  }

  // ------------------------------------------------------------ writes

  private writeAndCommit(paths: string[], message: string): string | null {
    let sha: string | null = null;
    try {
      if (this.syncEnabled) sha = this.sync.commit(`brain(${this.device}): ${message}`, paths);
    } catch (e) {
      // A failed commit must not lose the write; it will be picked up as an external edit.
      process.stderr.write(`[brain] commit failed: ${(e as Error).message}\n`);
    }
    this.touch(paths);
    if (sha) this.schedulePush();
    return sha;
  }

  private writeFile(rel: string, content: string): void {
    const abs = this.abs(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  private readTemplate(name: string): string {
    const custom = join(this.vault, "_brain/templates", name);
    if (existsSync(custom)) return readFileSync(custom, "utf8");
    const builtin = TEMPLATES[name];
    if (!builtin) throw new BrainError(`Unknown template: ${name}`, "not_found");
    return builtin;
  }

  async create(input: {
    title: string;
    path?: string;
    folder?: string;
    template?: string;
    content?: string;
    frontmatter?: Record<string, unknown>;
  }) {
    await this.fresh();
    const fileName = input.title.replace(ILLEGAL_NAME_CHARS, " ").replace(/\s+/g, " ").trim() || "Untitled";
    const rel = this.safePath(input.path ?? `${(input.folder ?? "notes").replace(/\/+$/, "")}/${fileName}.md`);
    if (existsSync(this.abs(rel))) throw new BrainError(`A note already exists at ${rel}`, "exists");
    const now = localIso();
    let content: string;
    if (input.template) {
      const t = input.template.endsWith(".md") ? input.template : `${input.template}.md`;
      content = renderTemplate(this.readTemplate(t), {
        id: ulid(),
        title: input.title,
        date: now.slice(0, 10),
        datetime: now,
        device: this.device,
      });
      if (input.content) content = appendText(content, input.content);
    } else {
      content = `---\nid: ${ulid()}\ntitle: ${JSON.stringify(input.title)}\ncreated: ${now}\n---\n\n# ${input.title}\n\n${input.content ?? ""}`;
    }
    if (input.frontmatter && Object.keys(input.frontmatter).length)
      content = setFrontmatter(content, input.frontmatter);
    content = stamp(content, `claude@${this.device}`, now);
    this.writeFile(rel, content);
    this.writeAndCommit([rel], `create ${rel}`);
    await this.reindex();
    return { path: rel, hash: sha1(content).slice(0, 16) };
  }

  async edit(ref: string, op: EditOp, expectedHash?: string, by = `claude@${this.device}`) {
    await this.fresh();
    const path = this.resolveRef(ref);
    const abs = this.abs(path);
    const before = readFileSync(abs, "utf8");
    if (expectedHash && sha1(before).slice(0, 16) !== expectedHash)
      throw new BrainError(
        `${path} changed since you last read it. Read it again before editing.`,
        "conflict",
      );
    let after: string;
    switch (op.op) {
      case "append":
        after = appendText(before, op.text);
        break;
      case "prepend":
        after = prependText(before, op.text);
        break;
      case "append_to_section":
        after = appendToSection(before, op.heading, op.text);
        break;
      case "replace_section":
        after = replaceSection(before, op.heading, op.text);
        break;
      case "replace_text":
        after = replaceText(before, op.old_text, op.new_text);
        break;
      case "set_frontmatter":
        after = setFrontmatter(before, op.fields);
        break;
    }
    if (op.op !== "set_frontmatter" || !("updated" in op.fields)) after = stamp(after, by, localIso());
    this.writeFile(path, after);
    this.writeAndCommit([path], `${op.op} ${path}`);
    await this.reindex();
    return { path, hash: sha1(after).slice(0, 16) };
  }

  async move(ref: string, newPath: string) {
    await this.fresh();
    const from = this.resolveRef(ref);
    const to = this.safePath(newPath);
    if (existsSync(this.abs(to))) throw new BrainError(`A note already exists at ${to}`, "exists");
    const inbound = this.db
      .prepare("SELECT src, target_raw FROM links WHERE target_path = ? AND src != ?")
      .all(from, from) as Array<{ src: string; target_raw: string }>;

    mkdirSync(dirname(this.abs(to)), { recursive: true });
    renameSync(this.abs(from), this.abs(to));

    // Link by file name if that stays unambiguous, otherwise by path.
    const paths = (this.db.prepare("SELECT path FROM notes WHERE path != ?").all(from) as Array<{ path: string }>)
      .map((r) => r.path)
      .concat(to);
    const name = to.split("/").pop()!.replace(/\.md$/i, "");
    const target = new LinkResolver(paths).resolve(name) === to ? name : to.replace(/\.md$/i, "");

    const bySrc = new Map<string, string[]>();
    for (const l of inbound) bySrc.set(l.src, [...(bySrc.get(l.src) ?? []), l.target_raw]);
    const changed: string[] = [];
    for (const [src, targets] of bySrc) {
      const abs = this.abs(src);
      const before = readFileSync(abs, "utf8");
      const after = rewriteLinks(before, targets, target);
      if (after !== before) {
        writeFileSync(abs, after);
        changed.push(src);
      }
    }
    this.writeAndCommit([from, to, ...changed], `move ${from} → ${to}`);
    await this.reindex();
    return { from, to, linksUpdatedIn: changed };
  }

  async delete(ref: string) {
    await this.fresh();
    const path = this.resolveRef(ref);
    const stampStr = localIso().slice(0, 19).replace(/[:T]/g, "-");
    const trash = `_brain/trash/${stampStr}-${path.replace(/\//g, "__")}`;
    mkdirSync(dirname(this.abs(trash)), { recursive: true });
    renameSync(this.abs(path), this.abs(trash));
    this.writeAndCommit([path, trash], `delete ${path}`);
    await this.reindex();
    return { path, trashedTo: trash };
  }

  async taskUpdate(input: {
    id: string;
    done?: boolean;
    due?: string | null;
    text?: string;
    by?: string;
  }) {
    await this.fresh();
    const row = this.db.prepare("SELECT path, line, raw, text FROM tasks WHERE id = ?").get(input.id) as
      | { path: string; line: number; raw: string; text: string }
      | undefined;
    if (!row) throw new BrainError(`Task not found: ${input.id}. Query tasks again.`, "not_found");
    const abs = this.abs(row.path);
    const lines = readFileSync(abs, "utf8").split("\n");
    let idx = row.line - 1;
    if (lines[idx]?.replace(/\r$/, "") !== row.raw) {
      // The file changed since indexing: find the task by its exact line instead.
      idx = lines.findIndex((l) => l.replace(/\r$/, "") === row.raw);
      if (idx === -1) throw new BrainError("Task moved or changed; query tasks again.", "conflict");
    }
    const cr = lines[idx]!.endsWith("\r") ? "\r" : "";
    const original = lines[idx]!.replace(/\r$/, "");
    lines[idx] = setTaskLine(original, { done: input.done, due: input.due, text: input.text }, localDate()) + cr;
    // Completing a recurring task creates the next occurrence above it (as Obsidian Tasks does).
    let next: string | undefined;
    const parsed = parseNote(row.path, original).tasks[0];
    if (input.done === true && parsed?.recurrence && parsed.status !== "done") {
      const today = localDate();
      const base = isWhenDone(parsed.recurrence) ? today : parsed.due ?? parsed.scheduled ?? today;
      const nextDate = nextOccurrence(parsed.recurrence, base);
      if (nextDate) {
        const shift = (d: string) => addDays(d, Math.round((Date.parse(nextDate) - Date.parse(base)) / 86400000));
        next = original
          .replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/u, "")
          .replace(/\s*🆔\s*[A-Za-z0-9_-]+/u, "")
          .replace(/((?:📅|📆|🗓️?)\s*)(\d{4}-\d{2}-\d{2})/u, (_m, p, d) => `${p}${shift(d)}`)
          .replace(/(⏳\s*)(\d{4}-\d{2}-\d{2})/u, (_m, p, d) => `${p}${shift(d)}`)
          .replace(/(🛫\s*)(\d{4}-\d{2}-\d{2})/u, (_m, p, d) => `${p}${shift(d)}`);
        if (!parsed.due && !parsed.scheduled) next = `${next} 📅 ${nextDate}`;
        lines.splice(idx, 0, next + cr);
        idx++;
      }
    }
    let content = lines.join("\n");
    content = stamp(content, input.by ?? `claude@${this.device}`, localIso());
    writeFileSync(abs, content);
    const verb = input.done === true ? "complete" : input.done === false ? "reopen" : "update";
    this.writeAndCommit([row.path], `${verb} task in ${row.path}`);
    await this.reindex();
    return { path: row.path, line: lines[idx]!.trim(), ...(next ? { next_occurrence: next.trim() } : {}) };
  }

  /**
   * Moves unfinished tasks from one daily note to another: the originals are
   * marked `[>]` (forwarded) and copies are appended to the target's Plan section.
   */
  async rolloverTasks(input: { from?: string; to?: string } = {}) {
    await this.fresh();
    const from = input.from ?? localDate();
    const to = input.to ?? addDays(from, 1);
    const fromRel = this.dailyPath(from);
    if (!existsSync(this.abs(fromRel))) return { moved: [], from: fromRel, to: this.dailyPath(to) };
    const lines = readFileSync(this.abs(fromRel), "utf8").split("\n");
    const moved: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^(\s*[-*+]\s+\[)([ /])(\]\s+.*)$/);
      if (!m) continue;
      moved.push(`- [${m[2]}${m[3]!.replace(/\s*🆔\s*[A-Za-z0-9_-]+/u, "")}`.replace(/^- \[\/\]/, "- [/]"));
      lines[i] = `${m[1]}>${m[3]}`;
    }
    if (!moved.length) return { moved: [], from: fromRel, to: this.dailyPath(to) };
    await this.daily(to, true); // make sure the target exists
    const toRel = this.dailyPath(to);
    const target = readFileSync(this.abs(toRel), "utf8");
    const block = moved.map((t) => `${t} (from [[${from}]])`).join("\n");
    let next: string;
    try {
      next = appendToSection(target, "Plan", block);
    } catch {
      next = appendText(target, `\n## Plan\n${block}`);
    }
    const now = localIso();
    writeFileSync(this.abs(fromRel), stamp(lines.join("\n"), `claude@${this.device}`, now));
    writeFileSync(this.abs(toRel), stamp(next, `claude@${this.device}`, now));
    this.writeAndCommit([fromRel, toRel], `roll over ${moved.length} task(s) ${from} → ${to}`);
    await this.reindex();
    return { moved, from: fromRel, to: toRel };
  }

  // ------------------------------------------------------------ calendar & planning

  async events(from = localDate(), to = from) {
    return eventsBetween(from, to);
  }

  private compactTask = (t: TaskRow) => ({ id: t.id, text: t.text, due: t.due ?? undefined, note: t.path });

  private dailySection(date: string, heading: string): string | null {
    const rel = this.dailyPath(date);
    if (!existsSync(this.abs(rel))) return null;
    return sectionOf(readFileSync(this.abs(rel), "utf8"), heading);
  }

  /** Facts for a planning ritual; Claude turns them into a plan or review. */
  async planContext(kind: PlanKind, opts: { date?: string; event?: string } = {}) {
    await this.fresh();
    const date = opts.date ?? localDate();
    const weekday = new Date(`${date}T12:00:00`).toLocaleDateString("en-AU", { weekday: "long" });
    const base = { kind, date, weekday, device: this.device };
    const calendar = async (from: string, to: string) => {
      const r = await this.events(from, to);
      return { configured: r.configured, events: r.events, ...(r.errors.length ? { errors: r.errors } : {}) };
    };
    const threads = (await this.threads("active")).map((t) => ({
      thread: t.slug, title: t.title, status: t.status, last_touched: t.lastTouched, latest: t.log.at(-1),
    }));

    if (kind === "morning") {
      return {
        ...base,
        daily_note: existsSync(this.abs(this.dailyPath(date))) ? this.dailyPath(date) : null,
        calendar: await calendar(date, date),
        tasks: {
          overdue: (await this.tasks({ overdue: true, limit: 20 })).map(this.compactTask),
          due_today: (await this.tasks({ due_after: date, due_before: date, limit: 20 })).map(this.compactTask),
          next_3_days: (await this.tasks({ due_after: addDays(date, 1), due_before: addDays(date, 3), limit: 20 })).map(this.compactTask),
        },
        open_threads: threads,
        recent_handoffs: recentSessions(this.vault, 3).map((s) => ({ when: s.ended, device: s.device, summary: s.summary, next_steps: s.nextSteps })),
        yesterday_review: this.dailySection(addDays(date, -1), "Review"),
      };
    }

    if (kind === "evening") {
      const rel = this.dailyPath(date);
      return {
        ...base,
        daily_note: existsSync(this.abs(rel)) ? rel : null,
        plan: this.dailySection(date, "Plan"),
        schedule: this.dailySection(date, "Schedule"),
        completed_today: (await this.tasks({ status: "done", done_after: date, done_before: date, limit: 50 })).map(this.compactTask),
        still_open_in_daily_note: existsSync(this.abs(rel)) ? (await this.tasks({ path: rel })).map(this.compactTask) : [],
        changes_today: this.sync.log({ since: `${date}T00:00:00`, limit: 30 }).map((e) => `${e.device ?? "?"}: ${e.subject.replace(/^\w+\([^)]*\):\s*/, "")}`),
        tomorrow: await calendar(addDays(date, 1), addDays(date, 1)),
      };
    }

    if (kind === "weekly") {
      const { start, end } = weekRange(date);
      const week = isoWeek(start);
      const cal = await calendar(start, end);
      const hours = new Map<string, number>();
      for (const e of cal.events)
        if (!e.allDay) hours.set(e.title, (hours.get(e.title) ?? 0) + (Date.parse(e.end) - Date.parse(e.start)) / 3600000);
      const reviews: Record<string, string> = {};
      for (let d = start; d <= end; d = addDays(d, 1)) {
        const r = this.dailySection(d, "Review");
        if (r) reviews[d] = r;
      }
      const changed = this.sync.log({ since: `${start}T00:00:00`, limit: 300 });
      const files = new Map<string, number>();
      for (const e of changed) for (const f of e.files) if (f.endsWith(".md") && !f.startsWith("_brain/")) files.set(f, (files.get(f) ?? 0) + 1);
      const weekAgo = addDays(date, -7);
      return {
        ...base,
        week,
        range: { start, end },
        review_path: `daily/${week}-review.md`,
        review_exists: existsSync(this.abs(`daily/${week}-review.md`)),
        completed: (await this.tasks({ status: "done", done_after: start, done_before: end, limit: 100 })).map(this.compactTask),
        overdue: (await this.tasks({ overdue: true, limit: 30 })).map(this.compactTask),
        daily_reviews: reviews,
        calendar: {
          configured: cal.configured,
          hours_by_event: Object.fromEntries([...hours].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v * 10) / 10])),
          total_hours: Math.round([...hours.values()].reduce((a, b) => a + b, 0) * 10) / 10,
        },
        threads: (await this.threads("all")).map((t) => ({
          thread: t.slug, title: t.title, status: t.status, last_touched: t.lastTouched,
          stalled: t.status !== "done" && (!t.lastTouched || t.lastTouched.slice(0, 10) < weekAgo),
        })),
        sessions: recentSessions(this.vault, 30).filter((s) => s.ended.slice(0, 10) >= start).map((s) => ({ when: s.ended, device: s.device, summary: s.summary })),
        notes_changed: [...files].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([f, n]) => ({ path: f, commits: n })),
      };
    }

    // meeting
    const upcoming = (await this.events(date, addDays(date, 7))).events.filter((e) => !e.allDay);
    const q = (opts.event ?? "").toLowerCase();
    const matches = q ? upcoming.filter((e) => e.uid === opts.event || e.title.toLowerCase().includes(q)) : upcoming.slice(0, 5);
    const event: CalendarEvent | { title: string } | null = matches[0] ?? (opts.event ? { title: opts.event } : null);
    const title = event?.title ?? "";
    const when = event && "start" in event ? event.start.slice(0, 10) : date;
    const fileTitle = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
    const search = title ? (await this.search(title, { limit: 6 })).results : [];
    const previous = title ? (await this.search(title, { folder: "meetings", limit: 5 })).results : [];
    return {
      ...base,
      event,
      other_matches: matches.slice(1, 4),
      meeting_path: title ? `meetings/${when} ${fileTitle}.md` : null,
      related_notes: search.map((h) => ({ path: h.path, title: h.title, section: h.section })),
      previous_meetings: previous.map((h) => ({ path: h.path, title: h.title })),
      open_tasks_mentioning: title
        ? (await this.tasks({ limit: 200 })).filter((t) => title.toLowerCase().split(/\s+/).some((w) => w.length > 3 && t.text.toLowerCase().includes(w))).slice(0, 10).map(this.compactTask)
        : [],
    };
  }

  dailyPath(date = localDate()): string {
    return `daily/${date}.md`;
  }

  async daily(date = localDate(), create = true) {
    await this.fresh();
    const rel = this.dailyPath(date);
    if (!existsSync(this.abs(rel))) {
      if (!create) return null;
      const content = renderTemplate(this.readTemplate("daily.md"), {
        id: ulid(),
        title: date,
        date,
        datetime: localIso(),
        device: this.device,
      });
      this.writeFile(rel, content);
      this.writeAndCommit([rel], `create daily ${date}`);
      await this.reindex();
    }
    return this.read(rel);
  }

  /** @param source who captured it; becomes part of the inbox file name (device, "phone"…). */
  async capture(text: string, source = this.device) {
    await this.fresh();
    const now = localIso();
    const rel = `inbox/${now.slice(0, 10)}-${source.replace(ILLEGAL_NAME_CHARS, "-")}.md`;
    const abs = this.abs(rel);
    const entry = `- ${now.slice(11, 16)} ${text.trim().replace(/\n/g, "\n  ")}`;
    const before = existsSync(abs)
      ? readFileSync(abs, "utf8")
      : `---\ntitle: Inbox ${now.slice(0, 10)} (${source})\ntype: inbox\ncreated: ${now}\n---\n\n`;
    this.writeFile(rel, appendText(before, entry));
    this.writeAndCommit([rel], `capture to ${rel}`);
    await this.reindex();
    return { path: rel, entry };
  }

  // ------------------------------------------------------------ inbox triage

  private inboxFiles(): string[] {
    const dir = this.abs("inbox");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !/^readme\.md$/i.test(e.name))
      .map((e) => `inbox/${e.name}`)
      .sort();
  }

  private allInboxEntries(): InboxEntry[] {
    return this.inboxFiles().flatMap((rel) => parseInbox(rel, readFileSync(this.abs(rel), "utf8")));
  }

  /** Inbox entries, oldest first, each with likely destinations from search. */
  async inbox(opts: { suggestions?: boolean; limit?: number } = {}) {
    await this.fresh();
    const entries = this.allInboxEntries().slice(0, opts.limit ?? 50);
    const out = [];
    for (const e of entries) {
      let suggestions: Array<{ path: string; title: string; section?: string; matched: string[] }> = [];
      if (opts.suggestions !== false) {
        const r = await hybridSearch(this.db, this.store, this.embedder, e.text.slice(0, 300), { limit: 8, exclude: ["inbox", "_brain", "daily"] });
        suggestions = r.hits
          .filter((h) => !h.path.startsWith("inbox/") && !h.path.startsWith("_brain/") && !h.path.startsWith("daily/"))
          .slice(0, 3)
          .map((h) => ({ path: h.path, title: h.title, section: h.section, matched: h.matched }));
      }
      out.push({ ...e, suggestions });
    }
    return { count: this.allInboxEntries().length, entries: out };
  }

  /**
   * Files one inbox entry and removes it from the inbox. Actions:
   * - move: append the text to a note (optionally under a heading)
   * - task: add it as a task (default: today's daily note, Plan section)
   * - archive: it's been dealt with elsewhere; just clear it
   * - discard: not worth keeping
   * Every resolution is logged to _brain/inbox-log/YYYY-MM.md.
   */
  async inboxResolve(input: {
    id: string;
    action: "move" | "task" | "archive" | "discard";
    target?: string;
    heading?: string;
    text?: string;
    due?: string;
    by?: string;
  }) {
    await this.fresh();
    const entry = this.allInboxEntries().find((e) => e.id === input.id);
    if (!entry) throw new BrainError(`Inbox entry not found: ${input.id}. List the inbox again.`, "not_found");
    const by = input.by ?? `claude@${this.device}`;
    const now = localIso();
    const text = (input.text ?? entry.text).trim();
    const changed: string[] = [];
    let destination: string | undefined;

    const appendTo = (rel: string, block: string, heading?: string) => {
      const abs = this.abs(rel);
      const before = readFileSync(abs, "utf8");
      let after: string;
      if (heading) {
        try {
          after = appendToSection(before, heading, block);
        } catch (e) {
          if ((e as BrainError).code !== "no_match") throw e;
          after = appendText(before, `\n## ${heading.replace(/^#+\s*/, "")}\n${block}`);
        }
      } else after = appendText(before, block);
      writeFileSync(abs, stamp(after, by, now));
      changed.push(rel);
    };

    if (input.action === "move") {
      if (!input.target) throw new BrainError("target is required for move", "invalid");
      destination = this.resolveRef(input.target);
      const block = /^[-*+] /.test(text) ? text : `- ${text.replace(/\n/g, "\n  ")}`;
      appendTo(destination, block, input.heading);
    } else if (input.action === "task") {
      const first = text.split("\n")[0]!.replace(/^[-*+]\s+(\[.\]\s+)?/, "");
      const line = `- [ ] ${first}${input.due ? ` 📅 ${input.due}` : ""}`;
      if (input.target) {
        destination = this.resolveRef(input.target);
        appendTo(destination, line, input.heading);
      } else {
        await this.daily(undefined, true);
        destination = this.dailyPath();
        appendTo(destination, line, input.heading ?? "Plan");
      }
    }

    // Remove the entry from its inbox file; delete the file once it's empty.
    const abs = this.abs(entry.path);
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.splice(entry.start, entry.end - entry.start);
    const rest = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    if (parseInbox(entry.path, rest).length === 0) unlinkSync(abs);
    else writeFileSync(abs, rest);
    changed.push(entry.path);

    const logRel = `_brain/inbox-log/${now.slice(0, 7)}.md`;
    const logAbs = this.abs(logRel);
    mkdirSync(dirname(logAbs), { recursive: true });
    const logBefore = existsSync(logAbs) ? readFileSync(logAbs, "utf8") : `# Inbox log ${now.slice(0, 7)}\n\n`;
    const where = destination ? ` → [[${destination.replace(/\.md$/, "")}]]` : "";
    writeFileSync(logAbs, appendText(logBefore, `- ${now.slice(0, 16).replace("T", " ")} ${input.action}${where}: ${text.split("\n")[0]!.slice(0, 200)}`));
    changed.push(logRel);

    this.writeAndCommit(changed, `inbox ${input.action}${destination ? ` → ${destination}` : ""}`);
    await this.reindex();
    return { action: input.action, destination, remaining: this.allInboxEntries().length };
  }

  // ------------------------------------------------------------ links & context packs

  private linkName(path: string): string {
    const stem = path.split("/").pop()!.replace(/\.md$/i, "");
    const paths = (this.db.prepare("SELECT path FROM notes").all() as Array<{ path: string }>).map((r) => r.path);
    return new LinkResolver(paths).resolve(stem) === path ? stem : path.replace(/\.md$/i, "");
  }

  /**
   * Link suggestions for one note, or for notes changed in the last `days` days:
   * plain-text mentions of other notes' titles, and similar notes not yet linked.
   */
  async linkSuggestions(opts: { note?: string; days?: number; limit?: number } = {}) {
    await this.fresh();
    const candidates = this.db.prepare("SELECT path, title FROM notes WHERE path NOT LIKE '\\_brain/%' ESCAPE '\\' AND path NOT LIKE 'inbox/%'").all() as Array<{ path: string; title: string }>;
    let notes: string[];
    if (opts.note) notes = [this.resolveRef(opts.note)];
    else {
      const since = Date.now() - (opts.days ?? 7) * 86400000;
      notes = (this.db
        .prepare("SELECT path FROM notes WHERE mtime_ms >= ? AND path NOT LIKE '\\_brain/%' ESCAPE '\\' AND path NOT LIKE 'inbox/%' ORDER BY mtime_ms DESC LIMIT ?")
        .all(since, opts.limit ?? 15) as Array<{ path: string }>).map((r) => r.path);
    }
    const out = [];
    for (const path of notes) {
      const rel = await this.related(path);
      const linked = new Set<string>([...(rel.outgoing as Array<{ path: string }>).map((o) => o.path)]);
      const mentions = findUnlinkedMentions(readFileSync(this.abs(path), "utf8"), candidates, { selfPath: path, linked, limit: 10 });
      const title = (this.db.prepare("SELECT title FROM notes WHERE path = ?").get(path) as { title: string }).title;
      if (mentions.length || rel.similar.length) out.push({ path, title, mentions, similar: rel.similar.slice(0, 5) });
    }
    return out;
  }

  /**
   * Adds a link from `note` to `target`. With `line` + `text` (from a mention
   * suggestion) the mention itself becomes the link; otherwise the link is added
   * to the note's `related:` frontmatter if it has one, or a "Related" section.
   */
  async addLink(input: { note: string; target: string; line?: number; text?: string }) {
    await this.fresh();
    const path = this.resolveRef(input.note);
    const target = this.resolveRef(input.target);
    const name = this.linkName(target);
    const abs = this.abs(path);
    const before = readFileSync(abs, "utf8");
    let after: string;
    let how: string;
    if (input.line && input.text) {
      try {
        after = linkMention(before, { line: input.line, text: input.text }, name);
      } catch (e) {
        throw new BrainError((e as Error).message, "conflict");
      }
      how = "mention";
    } else {
      const fm = parseNote(path, before).frontmatter;
      if (Array.isArray(fm.related)) {
        const list = fm.related.map(String);
        if (list.some((r) => r.replace(/^\[\[|\]\]$/g, "").split("|")[0]!.toLowerCase() === name.toLowerCase()))
          return { path, target, how: "already linked" };
        after = setFrontmatter(before, { related: [...list, `[[${name}]]`] });
        how = "frontmatter";
      } else {
        try {
          after = appendToSection(before, "Related", `- [[${name}]]`);
        } catch {
          after = appendText(before, `\n## Related\n- [[${name}]]`);
        }
        how = "section";
      }
    }
    writeFileSync(abs, stamp(after, `claude@${this.device}`, localIso()));
    this.writeAndCommit([path], `link ${path} → ${target}`);
    await this.reindex();
    return { path, target, how };
  }

  /**
   * A compact briefing on a topic, built from the most relevant notes: what each
   * note is about, the matching section, open tasks, related handoff decisions.
   * Meant to paste into another chat or tool. ~`budget` characters.
   */
  async contextPack(topic: string, opts: { limit?: number; budget?: number } = {}) {
    await this.fresh();
    const budget = opts.budget ?? 8000;
    const hits = (await hybridSearch(this.db, this.store, this.embedder, topic, { limit: (opts.limit ?? 6) + 4, exclude: ["_brain", "inbox"] })).hits
      .filter((h) => !h.path.startsWith("_brain/") && !h.path.startsWith("inbox/"))
      .slice(0, opts.limit ?? 6);
    const parts: string[] = [`# Context: ${topic}`, `_From Eric's notes, ${localDate()}. ${hits.length} sources._`];
    const perNote = Math.floor((budget - 600) / Math.max(1, hits.length));
    for (const h of hits) {
      const content = readFileSync(this.abs(h.path), "utf8");
      const n = parseNote(h.path, content);
      const summary =
        typeof n.frontmatter.summary === "string"
          ? n.frontmatter.summary
          : n.body.replace(/^#[^\n]*\n/, "").split(/\n\s*\n/).find((p) => p.trim() && !p.startsWith("#") && !p.startsWith(">"))?.trim() ?? "";
      let section = "";
      if (h.section) {
        try {
          section = (await this.read(h.path, h.section.split(" › ").pop())).content;
        } catch {
          section = "";
        }
      }
      const open = n.tasks.filter((t) => t.status === "todo" || t.status === "in_progress").slice(0, 5);
      const tasks = open.length ? `\n\nOpen tasks:\n${open.map((t) => `- [ ] ${t.text}`).join("\n")}` : "";
      let block = `\n## ${n.title}\n_${h.path}_\n\n${clip(summary, 350)}`;
      const room = perNote - block.length - tasks.length - 4;
      if (section && room > 150) block += `\n\n${clip(section.replace(/^#+\s+/, "### "), room)}`;
      parts.push(block + tasks);
    }
    const decisions = recentSessions(this.vault, 40)
      .filter((s) => [s.summary, ...s.decisions].join(" ").toLowerCase().includes(topic.toLowerCase().split(/\s+/)[0] ?? ""))
      .slice(0, 3);
    if (decisions.length)
      parts.push(`\n## Recent decisions\n${decisions.flatMap((s) => (s.decisions.length ? s.decisions : [s.summary]).map((d) => `- ${d} (${s.ended.slice(0, 10)}, ${s.device})`)).join("\n")}`);
    const pack = clip(parts.join("\n"), budget);
    return { topic, sources: hits.map((h) => h.path), chars: pack.length, pack };
  }

  // ------------------------------------------------------------ sessions & threads

  async beginSession() {
    const pull = await this.fresh({ forcePull: true });
    const external = this.syncEnabled ? this.sync.commitExternalEdits() : null;
    if (external) this.schedulePush();
    const state = this.sync.readState();
    const since = state.lastSessionStart;
    this.sync.writeState({ lastSessionStart: new Date().toISOString() });
    if (!this.session || this.session.ended)
      this.session = { started: localIso(), touched: new Set(), ended: false };

    const today = localDate();
    const otherDeviceChanges = this.sync
      .log({ since, limit: 40 })
      .filter((e) => e.device && e.device !== this.device)
      .slice(0, 15)
      .map((e) => ({ when: e.date, device: e.device, what: e.subject.replace(/^\w+\([^)]*\):\s*/, ""), files: e.files.slice(0, 5) }));

    const conflictCopies = (
      this.db.prepare("SELECT path FROM notes WHERE path LIKE '%.conflict-%'").all() as Array<{ path: string }>
    ).map((r) => r.path);

    const dailyExists = existsSync(this.abs(this.dailyPath(today)));
    const sessions = recentSessions(this.vault, 5).map((s) => ({
      when: s.ended,
      device: s.device,
      handoff: s.handoff,
      summary: s.summary,
      decisions: s.decisions,
      next_steps: s.nextSteps,
      open_questions: s.openQuestions,
      touched: s.handoff ? undefined : s.touched,
    }));
    const threads = listThreads(this.vault, "active").map((t) => ({
      thread: t.slug,
      title: t.title,
      status: t.status,
      last_touched: t.lastTouched,
      last_device: t.lastDevice,
      latest: t.log.at(-1),
    }));
    const overdue = await this.tasks({ overdue: true, limit: 15 });
    const dueToday = await this.tasks({ due_after: today, due_before: today, limit: 15 });
    const sync = this.sync.status();

    return {
      device: this.device,
      today,
      sync: {
        pull: pull?.status ?? "skipped",
        conflicts_from_this_pull: pull?.conflicts ?? [],
        unpushed_commits: sync.ahead,
        uncommitted_files: sync.dirty.length,
        conflict_copies_awaiting_merge: conflictCopies,
        remote: sync.remote,
      },
      recent_sessions: sessions,
      open_threads: threads,
      changes_from_other_devices_since_last_session: otherDeviceChanges,
      daily_note: dailyExists ? this.dailyPath(today) : null,
      tasks: {
        overdue: overdue.map((t) => ({ id: t.id, text: t.text, due: t.due, note: t.path })),
        due_today: dueToday.map((t) => ({ id: t.id, text: t.text, note: t.path })),
      },
    };
  }

  async endSession(input: {
    summary: string;
    decisions?: string[];
    next_steps?: string[];
    open_questions?: string[];
    threads?: Array<{ thread: string; note?: string; status?: ThreadStatus; title?: string; description?: string }>;
  }) {
    await this.fresh();
    const touched = [...(this.session?.touched ?? [])];
    const threadPaths: string[] = [];
    const threadSlugs: string[] = [];
    for (const t of input.threads ?? []) {
      const r = updateThread(this.vault, t as ThreadUpdate, this.device);
      threadPaths.push(r.path);
      threadSlugs.push(r.path.split("/").pop()!.replace(/\.md$/, ""));
    }
    const rel = writeSessionLog(this.vault, {
      device: this.device,
      client: this.client,
      started: this.session?.started,
      touched,
      threads: threadSlugs,
      summary: input.summary,
      decisions: input.decisions,
      nextSteps: input.next_steps,
      openQuestions: input.open_questions,
    });
    if (this.syncEnabled) this.sync.commit(`session(${this.device}): handoff`, [rel, ...threadPaths]);
    if (this.session) this.session.ended = true;
    this.session = null;
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    const push = this.autoPush && this.syncEnabled ? this.sync.push() : { status: this.syncEnabled ? "disabled" : "sync_off" };
    await this.reindex();
    return { session_log: rel, threads_updated: threadPaths, push: push.status };
  }

  async threads(status?: ThreadStatus | "active" | "all") {
    await this.fresh();
    return listThreads(this.vault, status === "all" ? undefined : (status ?? "active"));
  }

  async threadUpdate(u: ThreadUpdate) {
    await this.fresh();
    const r = updateThread(this.vault, u, this.device);
    this.writeAndCommit([r.path], `${r.created ? "create" : "update"} thread ${r.path}`);
    await this.reindex();
    return { ...r, thread: readThread(this.vault, r.path.split("/").pop()!.replace(/\.md$/, "")) };
  }

  /** Data for the web app's Today view. */
  async today(date = localDate()) {
    await this.fresh();
    const dailyRel = this.dailyPath(date);
    const daily = existsSync(this.abs(dailyRel)) ? await this.read(dailyRel) : null;
    const cal = await this.events(date, date).catch((e: Error) => ({ events: [], configured: true, errors: [e.message] }));
    return {
      date,
      daily,
      schedule: {
        calendar: cal.events,
        calendarConfigured: cal.configured,
        calendarErrors: cal.errors,
        fromNote: daily ? parseSchedule(sectionOf(daily.content, "Schedule") ?? "") : [],
      },
      overdue: await this.tasks({ overdue: true, limit: 50 }),
      dueToday: await this.tasks({ due_after: date, due_before: date, limit: 50 }),
      upcoming: await this.tasks({ due_after: addDays(date, 1), due_before: addDays(date, 7), limit: 50 }),
      sessions: recentSessions(this.vault, 5),
      threads: listThreads(this.vault, "active"),
    };
  }

  async syncNow() {
    if (!this.syncEnabled) throw new BrainError("Sync is off: this folder wasn't set up with `brain init`.", "invalid");
    const pull = await this.fresh({ forcePull: true });
    const committed = this.sync.commitExternalEdits();
    const push = this.sync.push();
    await this.reindex();
    return { pull, committed, push, status: this.sync.status() };
  }
}
