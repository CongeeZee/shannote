import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { parseNote } from "../vault/parse.js";
import { localIso, slugify, ulid } from "../util.js";

export const SESSIONS_DIR = "_brain/sessions";
export const THREADS_DIR = "_brain/threads";

export interface SessionLog {
  path: string;
  device: string;
  client?: string;
  started?: string;
  ended: string;
  handoff: boolean;
  touched: string[];
  threads: string[];
  summary: string;
  decisions: string[];
  nextSteps: string[];
  openQuestions: string[];
}

export interface SessionInput {
  device: string;
  client?: string;
  started?: string;
  touched: string[];
  threads?: string[];
  summary: string;
  decisions?: string[];
  nextSteps?: string[];
  openQuestions?: string[];
  handoff?: boolean;
}

function section(title: string, items: string[] | string, checkbox = false): string {
  if (typeof items === "string") return `## ${title}\n${items.trim()}\n`;
  if (!items.length) return "";
  return `## ${title}\n${items.map((i) => `- ${checkbox ? "[ ] " : ""}${i.trim()}`).join("\n")}\n`;
}

/** Writes a new session log. Each log is its own file, so devices never conflict. */
export function writeSessionLog(root: string, s: SessionInput, now = new Date()): string {
  const ended = localIso(now);
  const stamp = ended.slice(0, 19).replace(/:/g, "");
  const rel = `${SESSIONS_DIR}/${ended.slice(0, 4)}/${ended.slice(5, 7)}/${stamp}-${slugify(s.device, 30)}-${ulid().slice(-6).toLowerCase()}.md`;
  const fm = {
    type: "session",
    device: s.device,
    client: s.client ?? null,
    started: s.started ?? null,
    ended,
    handoff: s.handoff ?? true,
    touched: s.touched,
    threads: s.threads ?? [],
  };
  const body = [
    section("Summary", s.summary || "(no summary)"),
    section("Decisions", s.decisions ?? []),
    section("Next steps", s.nextSteps ?? [], true),
    section("Open questions", s.openQuestions ?? []),
  ]
    .filter(Boolean)
    .join("\n");
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\n${stringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n${body}`);
  return rel;
}

function listItems(body: string, heading: string): string[] {
  const m = body.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"));
  if (!m) return [];
  return m[1]!
    .split("\n")
    .map((l) => l.match(/^\s*[-*]\s+(?:\[.\]\s+)?(.*)$/)?.[1]?.trim())
    .filter((l): l is string => !!l);
}

function sectionText(body: string, heading: string): string {
  const m = body.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"));
  return m ? m[1]!.trim() : "";
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

export function readSessionLog(root: string, rel: string): SessionLog {
  const n = parseNote(rel, readFileSync(join(root, rel), "utf8"));
  const fm = n.frontmatter;
  return {
    path: rel,
    device: String(fm.device ?? "unknown"),
    client: fm.client ? String(fm.client) : undefined,
    started: fm.started ? String(fm.started) : undefined,
    ended: String(fm.ended ?? ""),
    handoff: fm.handoff !== false,
    touched: arr(fm.touched),
    threads: arr(fm.threads),
    summary: sectionText(n.body, "Summary"),
    decisions: listItems(n.body, "Decisions"),
    nextSteps: listItems(n.body, "Next steps"),
    openQuestions: listItems(n.body, "Open questions"),
  };
}

/** Most recent session logs across all devices, newest first. */
export function recentSessions(root: string, limit = 5): SessionLog[] {
  const dir = join(root, SESSIONS_DIR);
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}/${e.name}`);
      else if (e.name.endsWith(".md")) files.push(`${rel}/${e.name}`);
    }
  };
  walk(dir, SESSIONS_DIR);
  // File names start with the local timestamp, so a path sort is chronological.
  files.sort((a, b) => b.split("/").pop()!.localeCompare(a.split("/").pop()!));
  return files.slice(0, limit).map((f) => readSessionLog(root, f));
}

// ---------------------------------------------------------------- threads

export type ThreadStatus = "open" | "waiting" | "done";

export interface Thread {
  slug: string;
  path: string;
  title: string;
  status: ThreadStatus;
  lastTouched?: string;
  lastDevice?: string;
  description: string;
  log: string[];
}

export function readThread(root: string, slug: string): Thread | null {
  const rel = `${THREADS_DIR}/${slug}.md`;
  const abs = join(root, rel);
  if (!existsSync(abs)) return null;
  const n = parseNote(rel, readFileSync(abs, "utf8"));
  const fm = n.frontmatter;
  const desc = n.body.split(/^## Log/m)[0]!.replace(/^#[^\n]*\n/, "").trim();
  return {
    slug,
    path: rel,
    title: n.title,
    status: (["open", "waiting", "done"].includes(String(fm.status)) ? fm.status : "open") as ThreadStatus,
    lastTouched: fm.last_touched ? String(fm.last_touched) : undefined,
    lastDevice: fm.last_device ? String(fm.last_device) : undefined,
    description: desc,
    log: listItems(n.body, "Log"),
  };
}

export function listThreads(root: string, status?: ThreadStatus | "active"): Thread[] {
  const dir = join(root, THREADS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readThread(root, f.slice(0, -3))!)
    .filter((t) =>
      !status ? true : status === "active" ? t.status !== "done" : t.status === status,
    )
    .sort((a, b) => (b.lastTouched ?? "").localeCompare(a.lastTouched ?? ""));
}

export interface ThreadUpdate {
  /** Slug or title. A new thread is created if none matches and `title` is given. */
  thread: string;
  title?: string;
  description?: string;
  note?: string;
  status?: ThreadStatus;
}

/** Creates or updates a thread file. Returns its vault-relative path. */
export function updateThread(
  root: string,
  u: ThreadUpdate,
  device: string,
  now = new Date(),
): { path: string; created: boolean } {
  const slug = slugify(u.thread);
  const rel = `${THREADS_DIR}/${slug}.md`;
  const abs = join(root, rel);
  const when = localIso(now);
  const existing = readThread(root, slug);

  const title = u.title ?? existing?.title ?? u.thread;
  const status = u.status ?? existing?.status ?? "open";
  const description = u.description ?? existing?.description ?? "";
  const log = [...(existing?.log ?? [])];
  if (u.note) log.push(`${when.slice(0, 16).replace("T", " ")} (${device}): ${u.note.trim()}`);
  else if (u.status && existing && u.status !== existing.status)
    log.push(`${when.slice(0, 16).replace("T", " ")} (${device}): status → ${u.status}`);

  const fm = {
    title,
    type: "thread",
    status,
    created: existing ? undefined : when,
    last_touched: when,
    last_device: device,
  };
  // Preserve the original created date if present.
  if (existing) {
    const prev = parseNote(rel, readFileSync(abs, "utf8")).frontmatter.created;
    if (prev) (fm as Record<string, unknown>).created = String(prev);
  }
  const content =
    `---\n${stringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n# ${title}\n\n` +
    (description ? `${description}\n\n` : "") +
    `## Log\n${log.map((l) => `- ${l}`).join("\n")}\n`;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { path: rel, created: !existing };
}
