import type { DB } from "../index/db.js";

export interface SearchOptions {
  limit?: number;
  /** Only notes under this vault-relative folder. */
  folder?: string;
  /** Only notes with this tag (without `#`). */
  tag?: string;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

/**
 * Turns free text into a safe FTS5 query. Each word becomes a quoted term so
 * user input can't trigger FTS syntax errors; the last word is a prefix match
 * so partial words still find results. `"exact phrases"` are kept intact.
 */
export function toFtsQuery(input: string, mode: "and" | "or" = "and"): string | null {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (const m of input.matchAll(re)) {
    if (m[1]) {
      const phrase = m[1].replace(/"/g, "").trim();
      if (phrase) terms.push(`"${phrase}"`);
    } else {
      const word = m[2]!.replace(/["()*:^{}]/g, "").replace(/^[-+]+/, "");
      if (word) terms.push(`"${word}"`);
    }
  }
  if (!terms.length) return null;
  const last = terms[terms.length - 1]!;
  if (!last.includes(" ")) terms[terms.length - 1] = `${last}*`;
  return terms.join(mode === "and" ? " " : " OR ");
}

/**
 * BM25 keyword search. Matches in titles count most, then headings and tags,
 * then body text. Tries an AND query first and falls back to OR when nothing
 * matches all terms.
 */
export function keywordSearch(db: DB, query: string, opts: SearchOptions = {}): SearchHit[] {
  const limit = opts.limit ?? 10;
  for (const mode of ["and", "or"] as const) {
    const fts = toFtsQuery(query, mode);
    if (!fts) return [];
    const where: string[] = ["notes_fts MATCH @fts"];
    const params: Record<string, unknown> = { fts, limit };
    if (opts.folder) {
      where.push("substr(f.path, 1, length(@folder) + 1) = @folder || '/'");
      params.folder = opts.folder.replace(/\/+$/, "");
    }
    if (opts.tag) {
      where.push("EXISTS (SELECT 1 FROM tags t WHERE t.path = f.path AND t.tag = @tag)");
      params.tag = opts.tag.replace(/^#/, "").toLowerCase();
    }
    const rows = db
      .prepare(
        `SELECT f.path AS path, n.title AS title,
                snippet(notes_fts, 4, '«', '»', ' … ', 24) AS snippet,
                bm25(notes_fts, 0.0, 10.0, 4.0, 3.0, 1.0) AS rank
           FROM notes_fts f
           JOIN notes n ON n.path = f.path
          WHERE ${where.join(" AND ")}
          ORDER BY rank
          LIMIT @limit`,
      )
      .all(params) as Array<{ path: string; title: string; snippet: string; rank: number }>;
    if (rows.length || mode === "or" || !query.trim().includes(" ")) {
      return rows.map((r) => ({
        path: r.path,
        title: r.title,
        snippet: r.snippet.replace(/\s+/g, " ").trim(),
        score: Number((-r.rank).toFixed(3)),
      }));
    }
  }
  return [];
}
