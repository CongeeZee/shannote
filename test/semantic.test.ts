import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Brain } from "../src/core.js";
import { openDb, type DB } from "../src/index/db.js";
import { indexVault } from "../src/index/indexer.js";
import { chunkNote } from "../src/search/chunk.js";
import { HashEmbedder, TransformersEmbedder, type Embedder } from "../src/search/embed.js";
import { embedPending, hybridSearch, pendingCount, VectorStore } from "../src/search/semantic.js";
import { parseNote } from "../src/vault/parse.js";

describe("chunkNote", () => {
  it("splits at headings, carries title and heading path, merges tiny sections", () => {
    const body = `# Robot Dog\n\nIntro paragraph that is long enough to stand alone as its own chunk, ${"word ".repeat(40)}\n\n## Navigation\n\n${"Frontier exploration details. ".repeat(10)}\n\n### Sensors\n\nLidar.\n\n## Hardware\n\n${"Battery and motors. ".repeat(12)}`;
    const chunks = chunkNote({ title: "Robot Dog", body });
    expect(chunks.map((c) => c.heading)).toEqual(["", "Navigation", "Hardware"]);
    expect(chunks[1]!.text.startsWith("Robot Dog › Navigation\n")).toBe(true);
    // The tiny "Sensors" section was merged into Navigation, keeping its heading as context.
    expect(chunks[1]!.text).toContain("Navigation › Sensors: Lidar.");
  });

  it("splits long sections, strips link syntax and shortens code", () => {
    const code = "```py\n" + Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n") + "\n```";
    const body = `## Long\n\n${Array.from({ length: 12 }, (_, i) => `Paragraph ${i} about [[Page Tables|page tables]] ${"text ".repeat(40)}`).join("\n\n")}\n\n${code}`;
    const chunks = chunkNote({ title: "T", body });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.text.length <= 1500)).toBe(true);
    expect(chunks[0]!.text).toContain("about page tables");
    expect(chunks[0]!.text).not.toContain("[[");
    const all = chunks.map((c) => c.text).join("\n");
    expect(all).toContain("line3");
    expect(all).not.toContain("line20");
  });

  it("produces stable hashes, so unchanged sections keep their vectors", () => {
    const a = chunkNote({ title: "T", body: "## A\n" + "alpha ".repeat(60) + "\n## B\n" + "beta ".repeat(60) });
    const b = chunkNote({ title: "T", body: "## A\n" + "alpha ".repeat(60) + "\n## B\n" + "gamma ".repeat(60) });
    expect(a[0]!.hash).toBe(b[0]!.hash);
    expect(a[1]!.hash).not.toBe(b[1]!.hash);
  });

  it("handles empty notes", () => {
    expect(chunkNote(parseNote("x.md", "---\ntitle: Empty\n---\n"))).toHaveLength(1);
  });
});

describe("semantic index and hybrid search (hash embedder)", () => {
  let dir: string;
  let db: DB;
  const embedder = new HashEmbedder();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "brain-sem-"));
    cpSync(join(__dirname, "fixtures/vault"), dir, { recursive: true });
    db = openDb(":memory:");
    await indexVault(db, dir);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("embeds every chunk once, and only changed chunks after an edit", async () => {
    const first = await embedPending(db, embedder);
    expect(first).toBeGreaterThan(0);
    expect(pendingCount(db, embedder.id).pending).toBe(0);
    expect(await embedPending(db, embedder)).toBe(0);

    writeFileSync(join(dir, "people/Jane Doe.md"), "---\ntitle: Jane Doe\n---\nNow prefers phone calls.\n");
    await indexVault(db, dir);
    expect(await embedPending(db, embedder)).toBe(1);
    // The old vector is pruned.
    const vectors = (db.prepare("SELECT COUNT(*) n FROM embeddings").get() as { n: number }).n;
    const chunks = (db.prepare("SELECT COUNT(DISTINCT hash) n FROM chunks").get() as { n: number }).n;
    expect(vectors).toBe(chunks);
  });

  it("vectors survive a full index rebuild", async () => {
    await embedPending(db, embedder);
    await indexVault(db, dir, { rebuild: true });
    expect(pendingCount(db, embedder.id).pending).toBe(0);
  });

  it("falls back to keyword results when nothing is embedded", async () => {
    const r = await hybridSearch(db, new VectorStore(db, embedder.id), embedder, "frontier");
    expect(r.semantic).toBe("unavailable");
    expect(r.hits[0]!.path).toBe("projects/Robot Dog.md");
  });

  it("merges keyword and semantic rankings and reports which matched", async () => {
    await embedPending(db, embedder);
    const store = new VectorStore(db, embedder.id);
    const r = await hybridSearch(db, store, embedder, "frontier exploration rescue");
    expect(r.semantic).toBe("used");
    expect(r.hits[0]!.path).toBe("projects/Robot Dog.md");
    expect(r.hits[0]!.matched.sort()).toEqual(["keyword", "semantic"]);
    expect(r.hits[0]!.section).toBe("Navigation");

    const sem = await hybridSearch(db, store, embedder, "exploration", { mode: "semantic" });
    expect(sem.hits.every((h) => h.matched.join() === "semantic")).toBe(true);
    const kw = await hybridSearch(db, store, embedder, "exploration", { mode: "keyword" });
    expect(kw.semantic).toBe("skipped");
  });

  it("applies folder and tag filters to semantic results", async () => {
    await embedPending(db, embedder);
    const store = new VectorStore(db, embedder.id);
    const r = await hybridSearch(db, store, embedder, "hybrid search ranking", { mode: "semantic", folder: "archive" });
    expect(r.hits.map((h) => h.path)).toEqual(["archive/old/Hybrid Search.md"]);
  });
});

describe("Brain with embeddings", () => {
  let dir: string;
  let brain: Brain;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-semb-"));
    cpSync(join(__dirname, "fixtures/vault"), dir, { recursive: true });
    brain = new Brain({ vault: dir, device: "t", dbFile: ":memory:", embedder: new HashEmbedder(), autoPush: false });
  });
  afterEach(() => {
    brain.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("embeds in the background and suggests similar unlinked notes", async () => {
    await brain.fresh();
    await brain.startEmbedding();
    const s = brain.embedState();
    expect(s.embedded).toBe(s.total);
    // The archived duplicate is similar to Hybrid Search but not linked from it.
    // The hash embedder scores lower than real models, so drop the cut-off here.
    const rel = await brain.related("notes/Hybrid Search.md", 0);
    expect(rel.similar.map((x) => x.path)).toContain("archive/old/Hybrid Search.md");
    expect(rel.similar.map((x) => x.path)).not.toContain("notes/Reciprocal Rank Fusion.md"); // already linked
    const r = await brain.search("frontier exploration");
    expect(r.semantic).toBe("used");
    expect(r.results[0]!.path).toBe("projects/Robot Dog.md");
  });

  it("records embedding failures without breaking search", async () => {
    const broken: Embedder = { id: "broken", dims: 3, embed: async () => { throw new Error("model download blocked"); } };
    const b = new Brain({ vault: dir, device: "t", dbFile: ":memory:", embedder: broken, autoPush: false });
    await b.fresh();
    await b.startEmbedding();
    expect(b.embedState().error).toBe("model download blocked");
    const r = await b.search("frontier");
    expect(r.semantic).toBe("unavailable");
    expect(r.results[0]!.path).toBe("projects/Robot Dog.md");
    expect(r.note).toContain("model download blocked");
    // Even with vectors present, a failing query embedding falls back to keywords.
    const good = new HashEmbedder();
    await embedPending(b.db, { ...good, id: "broken", embed: good.embed.bind(good) } as Embedder);
    const r2 = await b.search("frontier");
    expect(r2.semantic).toBe("unavailable");
    expect(r2.results[0]!.path).toBe("projects/Robot Dog.md");
    b.shutdown();
  });
});

// Real-model check: runs only when a local model folder is provided, e.g.
// BRAIN_TEST_MODEL_PATH=/path/to/models (containing Xenova/all-MiniLM-L6-v2).
const MODEL_PATH = process.env.BRAIN_TEST_MODEL_PATH;
describe.skipIf(!MODEL_PATH)("real embedding model", () => {
  it("finds notes by meaning with no keyword overlap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-real-"));
    const notes: Record<string, string> = {
      "os/Page Tables.md": "# Page Tables\nThe MMU walks a multi-level page table to map virtual pages onto physical frames; the TLB caches recent entries.",
      "philosophy/Absurdism.md": "# Absurdism\nCamus: the conflict between our search for meaning and a silent universe. One must imagine Sisyphus happy.",
      "golf/Handicap.md": "# Handicap\nA golfer's index is the average of the best 8 differentials from the last 20 rounds.",
    };
    for (const [p, c] of Object.entries(notes)) {
      const abs = join(dir, p);
      require("node:fs").mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, c);
    }
    const db = openDb(":memory:");
    await indexVault(db, dir);
    const e = new TransformersEmbedder("Xenova/all-MiniLM-L6-v2", { localModelPath: MODEL_PATH, dtype: process.env.BRAIN_EMBED_DTYPE ?? "fp32" });
    await embedPending(db, e);
    const store = new VectorStore(db, e.id);
    const q = async (text: string) => (await hybridSearch(db, store, e, text, { mode: "semantic" })).hits[0]?.path;
    expect(await q("how does the computer translate addresses in RAM")).toBe("os/Page Tables.md");
    expect(await q("finding purpose in a meaningless life")).toBe("philosophy/Absurdism.md");
    expect(await q("scoring system for amateur players")).toBe("golf/Handicap.md");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
