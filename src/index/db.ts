import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

/** Bump when the schema changes; a mismatch triggers a full rebuild. */
export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS notes (
  path        TEXT PRIMARY KEY,
  id          TEXT,
  title       TEXT NOT NULL,
  type        TEXT,
  frontmatter TEXT NOT NULL,          -- JSON
  fm_error    TEXT,
  mtime_ms    REAL NOT NULL,
  size        INTEGER NOT NULL,
  hash        TEXT NOT NULL,
  word_count  INTEGER NOT NULL,
  created     TEXT,
  updated     TEXT,
  indexed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS headings (
  path  TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  text  TEXT NOT NULL,
  line  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS headings_path ON headings(path);

CREATE TABLE IF NOT EXISTS links (
  src            TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  target_raw     TEXT NOT NULL,
  target_path    TEXT,                -- NULL when unresolved
  heading        TEXT,
  alias          TEXT,
  embed          INTEGER NOT NULL,
  in_frontmatter INTEGER NOT NULL,
  line           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_src ON links(src);
CREATE INDEX IF NOT EXISTS links_target ON links(target_path);

CREATE TABLE IF NOT EXISTS tags (
  path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  tag  TEXT NOT NULL,
  PRIMARY KEY (path, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT NOT NULL,
  path        TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  line        INTEGER NOT NULL,
  text        TEXT NOT NULL,
  raw         TEXT NOT NULL,
  status      TEXT NOT NULL,
  status_char TEXT NOT NULL,
  due         TEXT,
  scheduled   TEXT,
  start       TEXT,
  done_date   TEXT,
  recurrence  TEXT,
  tags        TEXT NOT NULL           -- JSON array
);
CREATE INDEX IF NOT EXISTS tasks_path ON tasks(path);
CREATE INDEX IF NOT EXISTS tasks_status_due ON tasks(status, due);

-- Sections of notes for semantic search. hash = sha1(text) keys the vector cache.
CREATE TABLE IF NOT EXISTS chunks (
  path    TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  ord     INTEGER NOT NULL,
  heading TEXT NOT NULL,
  text    TEXT NOT NULL,
  hash    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS chunks_hash ON chunks(hash);

-- Vector cache, keyed by chunk content and model. Survives index rebuilds.
CREATE TABLE IF NOT EXISTS embeddings (
  hash   TEXT NOT NULL,
  model  TEXT NOT NULL,
  dims   INTEGER NOT NULL,
  vector BLOB NOT NULL,          -- float32, little-endian, unit length
  PRIMARY KEY (hash, model)
);

-- Full-text search. path is stored but not indexed; rowid ties rows to notes.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  path UNINDEXED,
  title,
  headings,
  tags,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
`;

export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  // The MCP server and web app may share one index file; wait instead of failing on locks.
  db.pragma("busy_timeout = 5000");

  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();
  const version = hasMeta
    ? (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
        | { value: string }
        | undefined)
    : undefined;
  if (version && Number(version.value) !== SCHEMA_VERSION) resetDb(db);

  db.exec(SCHEMA);
  setMeta(db, "schema_version", String(SCHEMA_VERSION));
  return db;
}

/** Drops all tables (except the vector cache) so the next index run rebuilds from scratch. */
export function resetDb(db: DB): void {
  db.exec(`
    DROP TABLE IF EXISTS notes_fts;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS tags;
    DROP TABLE IF EXISTS links;
    DROP TABLE IF EXISTS headings;
    DROP TABLE IF EXISTS notes;
    DROP TABLE IF EXISTS meta;
  `);
  db.exec(SCHEMA);
  setMeta(db, "schema_version", String(SCHEMA_VERSION));
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
