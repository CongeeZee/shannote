import type { DB } from "../index/db.js";
import type { Embedder } from "./embed.js";
import { keywordSearchWithMode, type SearchHit, type SearchOptions } from "./keyword.js";

export interface EmbedProgress {
  done: number;
  total: number;
}

/** Number of distinct chunks still waiting for a vector from this model. */
export function pendingCount(db: DB, model: string): { pending: number; total: number } {
  const total = (db.prepare("SELECT COUNT(DISTINCT hash) n FROM chunks").get() as { n: number }).n;
  const done = (
    db
      .prepare("SELECT COUNT(DISTINCT c.hash) n FROM chunks c JOIN embeddings e ON e.hash = c.hash AND e.model = ?")
      .get(model) as { n: number }
  ).n;
  return { pending: total - done, total };
}

/**
 * Embeds every chunk that has no vector for this model yet. Vectors are keyed by
 * chunk content hash, so editing one section of a note only re-embeds that section.
 */
export async function embedPending(
  db: DB,
  embedder: Embedder,
  opts: { batchSize?: number; onProgress?: (p: EmbedProgress) => void; shouldStop?: () => boolean } = {},
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT c.hash, MIN(c.text) AS text FROM chunks c
        WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.hash = c.hash AND e.model = ?)
        GROUP BY c.hash`,
    )
    .all(embedder.id) as Array<{ hash: string; text: string }>;
  const insert = db.prepare("INSERT OR REPLACE INTO embeddings (hash, model, dims, vector) VALUES (?, ?, ?, ?)");
  const batch = opts.batchSize ?? 16;
  let done = 0;
  for (let i = 0; i < rows.length; i += batch) {
    if (opts.shouldStop?.()) break;
    const slice = rows.slice(i, i + batch);
    const vecs = await embedder.embed(slice.map((r) => r.text), "passage");
    db.transaction(() => {
      slice.forEach((r, j) => {
        const v = vecs[j]!;
        insert.run(r.hash, embedder.id, v.length, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
      });
    })();
    done += slice.length;
    opts.onProgress?.({ done, total: rows.length });
  }
  // Drop vectors no chunk uses any more (old versions of edited sections).
  db.prepare("DELETE FROM embeddings WHERE model = ? AND hash NOT IN (SELECT hash FROM chunks)").run(embedder.id);
  return done;
}

interface ChunkVec {
  path: string;
  heading: string;
  text: string;
  vec: Float32Array;
}

/**
 * In-memory copy of all chunk vectors for brute-force cosine search. For a
 * personal vault (thousands of chunks × 384 dims) a full scan takes a few
 * milliseconds, so no vector index is needed.
 */
export class VectorStore {
  private items: ChunkVec[] = [];
  private stamp = "";

  constructor(
    private db: DB,
    private model: string,
  ) {}

  /** Reloads if chunks or embeddings changed since the last load. */
  refresh(): ChunkVec[] {
    const s = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM chunks) || ':' || (SELECT IFNULL(MAX(rowid),0) FROM chunks) || ':' ||
                (SELECT COUNT(*) FROM embeddings WHERE model = ?) AS s`,
      )
      .get(this.model) as { s: string };
    if (s.s === this.stamp) return this.items;
    const rows = this.db
      .prepare(
        `SELECT c.path, c.heading, c.text, e.vector FROM chunks c
           JOIN embeddings e ON e.hash = c.hash AND e.model = ?`,
      )
      .all(this.model) as Array<{ path: string; heading: string; text: string; vector: Buffer }>;
    this.items = rows.map((r) => ({
      path: r.path,
      heading: r.heading,
      text: r.text,
      // Copy into an aligned buffer; SQLite blobs may not be 4-byte aligned.
      vec: new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength)),
    }));
    this.stamp = s.s;
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  /** Best-matching chunk per note, highest score first. */
  searchNotes(query: Float32Array, opts: { limit?: number; exclude?: Set<string>; filter?: (path: string) => boolean } = {}) {
    const best = new Map<string, { score: number; item: ChunkVec }>();
    for (const item of this.refresh()) {
      if (opts.exclude?.has(item.path) || (opts.filter && !opts.filter(item.path))) continue;
      const score = dot(query, item.vec);
      const prev = best.get(item.path);
      if (!prev || score > prev.score) best.set(item.path, { score, item });
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10);
  }

  /** Mean of a note's chunk vectors, normalised: a "what is this note about" vector. */
  centroid(path: string): Float32Array | null {
    const vs = this.refresh().filter((i) => i.path === path);
    if (!vs.length) return null;
    const c = new Float32Array(vs[0]!.vec.length);
    for (const v of vs) for (let i = 0; i < c.length; i++) c[i]! += v.vec[i]!;
    let n = 0;
    for (let i = 0; i < c.length; i++) n += c[i]! * c[i]!;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < c.length; i++) c[i]! /= n;
    return c;
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

export type SearchMode = "hybrid" | "keyword" | "semantic";

export interface HybridHit extends SearchHit {
  /** Which rankers found it. */
  matched: Array<"keyword" | "semantic">;
  /** Heading of the best-matching section, when found semantically. */
  section?: string;
}

function excerpt(text: string, max = 220): string {
  const body = text.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
  return body.length > max ? `${body.slice(0, max).replace(/\s\S*$/, "")} …` : body;
}

function pathFilter(db: DB, opts: SearchOptions): ((p: string) => boolean) | undefined {
  const folder = opts.folder?.replace(/\/+$/, "");
  const tag = opts.tag?.replace(/^#/, "").toLowerCase();
  const exclude = (opts.exclude ?? []).map((f) => `${f.replace(/\/+$/, "")}/`);
  if (!folder && !tag && !exclude.length) return undefined;
  const tagged = tag
    ? new Set((db.prepare("SELECT path FROM tags WHERE tag = ?").all(tag) as Array<{ path: string }>).map((r) => r.path))
    : null;
  return (p) => (!folder || p.startsWith(`${folder}/`)) && (!tagged || tagged.has(p)) && !exclude.some((e) => p.startsWith(e));
}

/**
 * Hybrid search: keyword (BM25) and semantic (cosine) rankings merged with
 * reciprocal rank fusion. Notes found by both rank highest; notes found only by
 * meaning still surface when no keyword matches. Falls back to keyword-only if
 * there are no vectors yet.
 */
export async function hybridSearch(
  db: DB,
  store: VectorStore | null,
  embedder: Embedder | null,
  query: string,
  opts: SearchOptions & { mode?: SearchMode } = {},
): Promise<{ hits: HybridHit[]; semantic: "used" | "unavailable" | "skipped"; error?: string }> {
  const limit = opts.limit ?? 10;
  const mode = opts.mode ?? "hybrid";
  const k = 60;
  const kw =
    mode === "semantic"
      ? { hits: [], mode: "and" as const }
      : keywordSearchWithMode(db, query, { ...opts, limit: Math.max(limit * 3, 30) });
  const keyword = kw.hits;
  // When no note had every query word, keyword hits are loose (any word); trust them less.
  const keywordWeight = kw.mode === "or" ? 0.5 : 1;

  let semantic: Array<{ score: number; item: ChunkVec }> = [];
  let status: "used" | "unavailable" | "skipped" = "skipped";
  if (mode !== "keyword") {
    if (!store || !embedder || store.refresh().length === 0) status = "unavailable";
    else {
      let qv: Float32Array | undefined;
      try {
        [qv] = await embedder.embed([query], "query");
      } catch (e) {
        // Model missing or broken: keyword results are better than an error.
        return {
          hits: keyword.slice(0, limit).map((h) => ({ ...h, matched: ["keyword"] })),
          semantic: "unavailable",
          error: (e as Error).message,
        };
      }
      semantic = store.searchNotes(qv!, { limit: Math.max(limit * 3, 30), filter: pathFilter(db, opts) });
      // Drop weak matches so unrelated notes don't pad the results.
      semantic = semantic.filter((s) => s.score >= 0.25);
      status = "used";
    }
  }
  if (mode === "keyword" || status !== "used") {
    return { hits: keyword.slice(0, limit).map((h) => ({ ...h, matched: ["keyword"] })), semantic: status };
  }

  const merged = new Map<string, HybridHit & { rrf: number }>();
  keyword.forEach((h, i) => merged.set(h.path, { ...h, matched: ["keyword"], rrf: keywordWeight / (k + i + 1) }));
  semantic.forEach((s, i) => {
    const prev = merged.get(s.item.path);
    const add = 1 / (k + i + 1);
    if (prev) {
      prev.rrf += add;
      prev.matched.push("semantic");
      prev.section ??= s.item.heading || undefined;
    } else {
      const title = (db.prepare("SELECT title FROM notes WHERE path = ?").get(s.item.path) as { title: string } | undefined)?.title;
      merged.set(s.item.path, {
        path: s.item.path,
        title: title ?? s.item.path,
        snippet: excerpt(s.item.text),
        score: 0,
        matched: ["semantic"],
        section: s.item.heading || undefined,
        rrf: add,
      });
    }
  });
  const hits = [...merged.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ rrf, ...h }) => ({ ...h, score: Number((rrf * 1000).toFixed(2)) }));
  return { hits, semantic: status };
}
