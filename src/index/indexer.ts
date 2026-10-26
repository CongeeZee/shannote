import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseNote } from "../vault/parse.js";
import { LinkResolver } from "../vault/resolve.js";
import type { ParsedNote } from "../vault/types.js";
import { walkVault, type VaultFile } from "../vault/walk.js";
import { resetDb, setMeta, type DB } from "./db.js";

export interface IndexResult {
  total: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  durationMs: number;
}

export interface IndexOptions {
  rebuild?: boolean;
}

interface Existing {
  path: string;
  mtime_ms: number;
  size: number;
  hash: string;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Brings the index in line with the vault on disk. Only files whose size or
 * mtime changed are re-read; of those, only files whose content hash changed
 * are re-parsed. Link targets are re-resolved for the whole vault at the end
 * because adding or removing one note can change where other links point.
 */
export async function indexVault(
  db: DB,
  root: string,
  opts: IndexOptions = {},
): Promise<IndexResult> {
  const t0 = performance.now();
  if (opts.rebuild) resetDb(db);

  const files = await walkVault(root);
  const existing = new Map(
    (db.prepare("SELECT path, mtime_ms, size, hash FROM notes").all() as Existing[]).map((r) => [
      r.path,
      r,
    ]),
  );

  const candidates = files.filter((f) => {
    const e = existing.get(f.path);
    return !e || e.mtime_ms !== f.mtimeMs || e.size !== f.size;
  });

  const loaded = await Promise.all(
    candidates.map(async (f) => {
      const content = await readFile(f.absPath, "utf8");
      return { file: f, content, hash: createHash("sha1").update(content).digest("hex") };
    }),
  );

  const onDisk = new Set(files.map((f) => f.path));
  const removed = [...existing.keys()].filter((p) => !onDisk.has(p));
  let added = 0;
  let updated = 0;

  const deleteNote = db.prepare("DELETE FROM notes WHERE path = ?");
  const deleteFts = db.prepare("DELETE FROM notes_fts WHERE path = ?");
  const touch = db.prepare("UPDATE notes SET mtime_ms = ?, size = ? WHERE path = ?");
  const insertNote = db.prepare(`
    INSERT INTO notes (path, id, title, type, frontmatter, fm_error, mtime_ms, size, hash,
                       word_count, created, updated, indexed_at)
    VALUES (@path, @id, @title, @type, @frontmatter, @fm_error, @mtime_ms, @size, @hash,
            @word_count, @created, @updated, @indexed_at)`);
  const insertHeading = db.prepare(
    "INSERT INTO headings (path, level, text, line) VALUES (?, ?, ?, ?)",
  );
  const insertLink = db.prepare(`
    INSERT INTO links (src, target_raw, target_path, heading, alias, embed, in_frontmatter, line)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`);
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)");
  const insertTask = db.prepare(`
    INSERT INTO tasks (id, path, line, text, raw, status, status_char, due, scheduled, start,
                       done_date, recurrence, tags)
    VALUES (@id, @path, @line, @text, @raw, @status, @status_char, @due, @scheduled, @start,
            @done_date, @recurrence, @tags)`);
  const insertFts = db.prepare(
    "INSERT INTO notes_fts (path, title, headings, tags, body) VALUES (?, ?, ?, ?, ?)",
  );

  const writeNote = (file: VaultFile, note: ParsedNote, hash: string) => {
    const fm = note.frontmatter;
    insertNote.run({
      path: note.path,
      id: str(fm.id),
      title: note.title,
      type: str(fm.type),
      frontmatter: JSON.stringify(fm, (_k, v) => (v instanceof Date ? v.toISOString() : v)),
      fm_error: note.frontmatterError ?? null,
      mtime_ms: file.mtimeMs,
      size: file.size,
      hash,
      word_count: note.wordCount,
      created: str(fm.created ?? fm.date),
      updated: str(fm.updated),
      indexed_at: new Date().toISOString(),
    });
    for (const h of note.headings) insertHeading.run(note.path, h.level, h.text, h.line);
    for (const l of note.links)
      insertLink.run(
        note.path,
        l.target,
        l.heading ?? null,
        l.alias ?? null,
        l.embed ? 1 : 0,
        l.inFrontmatter ? 1 : 0,
        l.line,
      );
    for (const t of note.tags) insertTag.run(note.path, t);
    for (const t of note.tasks)
      insertTask.run({
        id: t.id,
        path: note.path,
        line: t.line,
        text: t.text,
        raw: t.raw,
        status: t.status,
        status_char: t.statusChar,
        due: t.due ?? null,
        scheduled: t.scheduled ?? null,
        start: t.start ?? null,
        done_date: t.doneDate ?? null,
        recurrence: t.recurrence ?? null,
        tags: JSON.stringify(t.tags),
      });
    insertFts.run(
      note.path,
      note.title,
      note.headings.map((h) => h.text).join("\n"),
      note.tags.join(" "),
      note.body,
    );
  };

  db.transaction(() => {
    for (const p of removed) {
      deleteNote.run(p);
      deleteFts.run(p);
    }
    for (const { file, content, hash } of loaded) {
      const prev = existing.get(file.path);
      if (prev && prev.hash === hash) {
        touch.run(file.mtimeMs, file.size, file.path);
        continue;
      }
      if (prev) {
        deleteNote.run(file.path);
        deleteFts.run(file.path);
        updated++;
      } else {
        added++;
      }
      writeNote(file, parseNote(file.path, content), hash);
    }
    resolveLinks(db, files.map((f) => f.path));
    setMeta(db, "last_indexed", new Date().toISOString());
    setMeta(db, "vault_root", root);
  })();

  return {
    total: files.length,
    added,
    updated,
    removed: removed.length,
    unchanged: files.length - added - updated,
    durationMs: Math.round(performance.now() - t0),
  };
}

function resolveLinks(db: DB, paths: string[]): void {
  const resolver = new LinkResolver(paths);
  const rows = db.prepare("SELECT rowid, src, target_raw FROM links").all() as Array<{
    rowid: number;
    src: string;
    target_raw: string;
  }>;
  const update = db.prepare("UPDATE links SET target_path = ? WHERE rowid = ?");
  for (const r of rows) update.run(resolver.resolve(r.target_raw, r.src), r.rowid);
}
