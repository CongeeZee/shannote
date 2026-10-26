import { LinkResolver } from "../vault/resolve.js";
import { localDate } from "../util.js";
import { getMeta, type DB } from "./db.js";

export { localDate };

export interface VaultStatus {
  notes: number;
  words: number;
  links: number;
  unresolvedLinks: number;
  tags: number;
  tasks: { open: number; done: number; overdue: number; dueToday: number };
  lastIndexed?: string;
}

export function vaultStatus(db: DB, today = localDate()): VaultStatus {
  const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;
  // Next steps inside session logs are handoff notes, not tasks.
  const T = "path NOT LIKE '\\_brain/sessions/%' ESCAPE '\\'";
  const notes = one<{ n: number; w: number | null }>(
    "SELECT COUNT(*) n, SUM(word_count) w FROM notes",
  );
  return {
    notes: notes.n,
    words: notes.w ?? 0,
    links: one<{ n: number }>("SELECT COUNT(*) n FROM links").n,
    unresolvedLinks: one<{ n: number }>("SELECT COUNT(*) n FROM links WHERE target_path IS NULL")
      .n,
    tags: one<{ n: number }>("SELECT COUNT(DISTINCT tag) n FROM tags").n,
    tasks: {
      open: one<{ n: number }>(`SELECT COUNT(*) n FROM tasks WHERE status IN ('todo','in_progress') AND ${T}`)
        .n,
      done: one<{ n: number }>(`SELECT COUNT(*) n FROM tasks WHERE status = 'done' AND ${T}`).n,
      overdue: one<{ n: number }>(
        `SELECT COUNT(*) n FROM tasks WHERE status IN ('todo','in_progress') AND due < ? AND ${T}`,
        today,
      ).n,
      dueToday: one<{ n: number }>(
        `SELECT COUNT(*) n FROM tasks WHERE status IN ('todo','in_progress') AND due = ? AND ${T}`,
        today,
      ).n,
    },
    lastIndexed: getMeta(db, "last_indexed"),
  };
}

export interface DoctorReport {
  frontmatterErrors: Array<{ path: string; error: string }>;
  unresolvedLinks: Array<{ target: string; count: number; from: string[] }>;
  ambiguousNames: Array<{ name: string; paths: string[] }>;
  emptyNotes: string[];
}

/** Finds problems worth fixing before (or while) porting notes. */
export function doctor(db: DB): DoctorReport {
  const frontmatterErrors = db
    .prepare("SELECT path, fm_error AS error FROM notes WHERE fm_error IS NOT NULL ORDER BY path")
    .all() as DoctorReport["frontmatterErrors"];

  const unresolvedRows = db
    .prepare(
      `SELECT target_raw AS target, COUNT(*) AS count, GROUP_CONCAT(DISTINCT src) AS srcs
         FROM links WHERE target_path IS NULL
        GROUP BY lower(target_raw) ORDER BY count DESC, target`,
    )
    .all() as Array<{ target: string; count: number; srcs: string }>;

  const paths = (db.prepare("SELECT path FROM notes").all() as Array<{ path: string }>).map(
    (r) => r.path,
  );
  const ambiguousNames = new LinkResolver(paths).duplicates();

  const emptyNotes = (
    db.prepare("SELECT path FROM notes WHERE word_count = 0 ORDER BY path").all() as Array<{
      path: string;
    }>
  ).map((r) => r.path);

  return {
    frontmatterErrors,
    unresolvedLinks: unresolvedRows.map((r) => ({
      target: r.target,
      count: r.count,
      from: r.srcs.split(","),
    })),
    ambiguousNames,
    emptyNotes,
  };
}
