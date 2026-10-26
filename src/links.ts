/**
 * Link suggestions: places where a note mentions another note's title in plain
 * text ("unlinked mentions"), plus notes that are about similar things.
 */
export interface Mention {
  target: string; // path of the note being mentioned
  title: string;
  /** The exact text found, e.g. "page tables". */
  text: string;
  line: number; // 1-based
  context: string;
}

const FENCE_RE = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Titles too generic to suggest as links on their own. */
export function linkableTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < 4) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(t) || /^\d{4}-W\d{2}/.test(t)) return false; // dates, week reviews
  if (/^(readme|index|ideas|thoughts|notes|todo|inbox|questions|untitled|overview|summary)$/i.test(t)) return false;
  return t.includes(" ") || t.length >= 8; // multi-word or a long, specific name
}

/**
 * Finds plain-text mentions of other notes' titles in `content`, skipping code,
 * existing [[links]], markdown links, URLs, frontmatter and headings.
 */
export function findUnlinkedMentions(
  content: string,
  candidates: Array<{ path: string; title: string }>,
  opts: { selfPath?: string; linked?: Set<string>; limit?: number } = {},
): Mention[] {
  const titles = candidates
    .filter((c) => c.path !== opts.selfPath && !opts.linked?.has(c.path) && linkableTitle(c.title))
    .sort((a, b) => b.title.length - a.title.length); // prefer the longest match
  if (!titles.length) return [];
  const lines = content.split("\n");
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) start = end + 1;
  }
  const found: Mention[] = [];
  const seenTargets = new Set<string>();
  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!;
    const f = raw.match(FENCE_RE);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      continue;
    }
    if (/^#{1,6}\s/.test(raw)) continue;
    // Blank out things that must not be matched, keeping positions.
    const masked = raw
      .replace(/(`+)[^`]*?\1/g, (m) => " ".repeat(m.length))
      .replace(/!?\[\[[^\]]*\]\]/g, (m) => " ".repeat(m.length))
      .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => " ".repeat(m.length))
      .replace(/https?:\/\/\S+/g, (m) => " ".repeat(m.length));
    for (const c of titles) {
      if (seenTargets.has(c.path)) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(c.title)}(?![\\p{L}\\p{N}_])`, "iu");
      const m = masked.match(re);
      if (!m || m.index === undefined) continue;
      seenTargets.add(c.path);
      found.push({
        target: c.path,
        title: c.title,
        text: raw.slice(m.index, m.index + m[0].length),
        line: i + 1,
        context: raw.trim().slice(0, 160),
      });
      if (found.length >= (opts.limit ?? 20)) return found;
    }
  }
  return found;
}

/** Turns the first unlinked mention on `line` into a wikilink, keeping the original wording. */
export function linkMention(content: string, m: { line: number; text: string }, linkTarget: string): string {
  const lines = content.split("\n");
  const raw = lines[m.line - 1];
  if (raw === undefined) throw new Error("Line not found; the note changed. Get suggestions again.");
  const idx = raw.indexOf(m.text);
  if (idx === -1) throw new Error("Mention not found on that line; the note changed. Get suggestions again.");
  // [[Exact Title]] when the wording matches exactly, otherwise keep the wording as an alias.
  const same = linkTarget.split("/").pop()! === m.text;
  const link = same ? `[[${m.text}]]` : `[[${linkTarget}|${m.text}]]`;
  lines[m.line - 1] = raw.slice(0, idx) + link + raw.slice(idx + m.text.length);
  return lines.join("\n");
}
