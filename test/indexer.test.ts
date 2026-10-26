import { cpSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/index/db.js";
import { indexVault } from "../src/index/indexer.js";
import { doctor, vaultStatus } from "../src/index/queries.js";
import { keywordSearch, toFtsQuery } from "../src/search/keyword.js";

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  cpSync(join(__dirname, "fixtures/vault"), dir, { recursive: true });
  db = openDb(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("indexVault", () => {
  it("indexes markdown files and skips ignored folders", async () => {
    const r = await indexVault(db, dir);
    expect(r).toMatchObject({ total: 7, added: 7, updated: 0, removed: 0 });
    const paths = (db.prepare("SELECT path FROM notes ORDER BY path").all() as { path: string }[])
      .map((p) => p.path);
    expect(paths).not.toContain(".obsidian/app.md");
    expect(paths).not.toContain("_brain/trash/old.md");
  });

  it("is incremental: unchanged files are skipped, edits and deletes are picked up", async () => {
    await indexVault(db, dir);
    expect(await indexVault(db, dir)).toMatchObject({ added: 0, updated: 0, unchanged: 7 });

    // Touching a file without changing it doesn't count as an update.
    const rrf = join(dir, "notes/Reciprocal Rank Fusion.md");
    const future = new Date(Date.now() + 60_000);
    utimesSync(rrf, future, future);
    expect(await indexVault(db, dir)).toMatchObject({ updated: 0, unchanged: 7 });

    writeFileSync(rrf, "# Reciprocal Rank Fusion\n\nNow mentions zebras.\n");
    unlinkSync(join(dir, "archive/old/Hybrid Search.md"));
    writeFileSync(join(dir, "notes/New.md"), "# New\n[[Missing Note]] is now [[New]]");
    expect(await indexVault(db, dir)).toMatchObject({ added: 1, updated: 1, removed: 1 });

    expect(keywordSearch(db, "zebras")[0]?.path).toBe("notes/Reciprocal Rank Fusion.md");
    // The old body text is gone from the index.
    expect(keywordSearch(db, "simple way merge").map((h) => h.path)).not.toContain(
      "notes/Reciprocal Rank Fusion.md",
    );
  });

  it("resolves links and re-resolves them when the target appears", async () => {
    await indexVault(db, dir);
    const unresolved = () =>
      (
        db.prepare("SELECT target_raw FROM links WHERE target_path IS NULL").all() as {
          target_raw: string;
        }[]
      ).map((r) => r.target_raw);
    expect(unresolved()).toEqual(["Missing Note"]);

    writeFileSync(join(dir, "notes/Missing Note.md"), "# Missing Note\nfound");
    await indexVault(db, dir);
    expect(unresolved()).toEqual([]);

    const backlinks = db
      .prepare("SELECT DISTINCT src FROM links WHERE target_path = ? ORDER BY src")
      .all("notes/Hybrid Search.md") as { src: string }[];
    expect(backlinks.map((b) => b.src)).toEqual([
      "inbox/broken.md",
      "notes/Reciprocal Rank Fusion.md",
    ]);
  });

  it("survives concurrent index runs on the same database", async () => {
    await indexVault(db, dir);
    writeFileSync(join(dir, "notes/Concurrent.md"), "# Concurrent\n");
    const results = await Promise.all([1, 2, 3, 4].map(() => indexVault(db, dir)));
    expect(results.every((r) => r.total === 8)).toBe(true);
    const n = db.prepare("SELECT COUNT(*) n FROM notes").get() as { n: number };
    expect(n.n).toBe(8);
  });

  it("rebuild starts from scratch", async () => {
    await indexVault(db, dir);
    expect(await indexVault(db, dir, { rebuild: true })).toMatchObject({ added: 7 });
  });
});

describe("keywordSearch", () => {
  beforeEach(async () => {
    await indexVault(db, dir);
  });

  it("ranks title matches first and returns highlighted snippets", () => {
    // "Hybrid Search" mentions RRF in its body and links, but RRF has it in the title.
    const hits = keywordSearch(db, "reciprocal rank fusion");
    expect(hits[0]!.path).toBe("notes/Reciprocal Rank Fusion.md");
    expect(hits.map((h) => h.path)).toContain("notes/Hybrid Search.md");
    expect(hits.some((h) => h.snippet.includes("«"))).toBe(true);
  });

  it("stems words and supports prefix matching on the last term", () => {
    expect(keywordSearch(db, "ranking")[0]?.path).toBeDefined();
    expect(keywordSearch(db, "frontier explor")[0]?.path).toBe("projects/Robot Dog.md");
  });

  it("falls back to OR when no note has every term", () => {
    const hits = keywordSearch(db, "zebra frontier");
    expect(hits.map((h) => h.path)).toContain("projects/Robot Dog.md");
  });

  it("filters by folder and tag", () => {
    expect(keywordSearch(db, "hybrid", { folder: "archive" }).map((h) => h.path)).toEqual([
      "archive/old/Hybrid Search.md",
    ]);
    expect(keywordSearch(db, "rank", { tag: "#AI-ML" }).map((h) => h.path)).toEqual([
      "notes/Hybrid Search.md",
    ]);
  });

  it("never throws on FTS syntax in user input", () => {
    for (const q of ['"unclosed', "a AND OR (", "*", "NEAR(", "col:value", "-x"]) {
      expect(() => keywordSearch(db, q)).not.toThrow();
    }
    expect(toFtsQuery("   ")).toBeNull();
    expect(toFtsQuery('"exact phrase" word')).toBe('"exact phrase" "word"*');
  });
});

describe("status and doctor", () => {
  beforeEach(async () => {
    await indexVault(db, dir);
  });

  it("counts notes, links and tasks relative to today", () => {
    const s = vaultStatus(db, "2026-10-28");
    expect(s.notes).toBe(7);
    expect(s.unresolvedLinks).toBe(1);
    // open = todo + in_progress: benchmark, battery, ROS2, email
    expect(s.tasks).toEqual({ open: 4, done: 1, overdue: 2, dueToday: 0 });
  });

  it("reports frontmatter errors, unresolved links and ambiguous names", () => {
    const r = doctor(db);
    expect(r.frontmatterErrors.map((e) => e.path)).toEqual(["inbox/broken.md"]);
    expect(r.unresolvedLinks).toEqual([
      { target: "Missing Note", count: 1, from: ["people/Jane Doe.md"] },
    ]);
    expect(r.ambiguousNames[0]!.name).toBe("hybrid search");
  });
});
