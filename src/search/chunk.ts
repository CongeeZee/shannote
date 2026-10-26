import { sha1 } from "../util.js";
import type { ParsedNote } from "../vault/types.js";

export interface Chunk {
  ord: number;
  /** Heading path, e.g. "Navigation › Frontier exploration". Empty for the intro. */
  heading: string;
  /** Text that gets embedded: note title and heading path, then the section text. */
  text: string;
  hash: string;
}

const MAX_CHARS = 1400; // ≈ 300 tokens, under MiniLM's 256-token window after the title prefix
const MIN_CHARS = 200;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** Shrinks code blocks to their first few lines; long code embeds poorly and drowns the prose. */
function compactCode(lines: string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  let kept = 0;
  for (const l of lines) {
    const f = l.match(FENCE_RE);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) {
        fence = null;
        out.push(l);
      } else if (kept++ < 4) out.push(l);
      else if (kept === 5) out.push("…");
      continue;
    }
    if (f) {
      fence = f[1]!;
      kept = 0;
    }
    out.push(l);
  }
  return out;
}

function clean(text: string): string {
  return text
    .replace(/!?\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, t, a) => a || t) // [[x|y]] → y
    .replace(/^\s*>\s?\[!\w+\][-+]?\s*/gm, "") // callout markers
    .replace(/^\s*>\s?/gm, "")
    .replace(/[📅📆🗓⏳🛫✅]️?\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const parts: string[] = [];
  let cur = "";
  for (const para of text.split(/\n\s*\n/)) {
    if (para.length > MAX_CHARS) {
      // Very long paragraph (or a big table): split on lines, then hard-wrap.
      for (const line of para.split("\n")) {
        for (let i = 0; i < line.length; i += MAX_CHARS) {
          const piece = line.slice(i, i + MAX_CHARS);
          if (cur.length + piece.length + 1 > MAX_CHARS && cur) {
            parts.push(cur);
            cur = "";
          }
          cur += (cur ? "\n" : "") + piece;
        }
      }
      continue;
    }
    if (cur.length + para.length + 2 > MAX_CHARS && cur) {
      parts.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + para;
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * Splits a note into sections at headings (H1–H3), merges tiny sections into the
 * previous one, and splits long ones at paragraph boundaries. Each chunk is
 * prefixed with the note title and heading path so it carries its context.
 */
export function chunkNote(note: Pick<ParsedNote, "title" | "body">): Chunk[] {
  const lines = compactCode(note.body.split(/\r?\n/));
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: "", lines: [] }];
  const stack: string[] = [];
  let fence: string | null = null;
  for (const l of lines) {
    const f = l.match(FENCE_RE);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      sections.at(-1)!.lines.push(l);
      continue;
    }
    if (f) fence = f[1]!;
    const h = !fence && l.match(HEADING_RE);
    if (h && h[1]!.length <= 3) {
      const level = h[1]!.length;
      stack.length = level - 1;
      stack[level - 1] = h[2]!.trim();
      // The H1 is usually the title; leave it out of heading paths.
      const path = stack.filter((x, i) => x && !(i === 0 && x === note.title)).join(" › ");
      sections.push({ heading: path, lines: [] });
      continue;
    }
    sections.at(-1)!.lines.push(l);
  }

  const merged: Array<{ heading: string; text: string }> = [];
  for (const s of sections) {
    const text = clean(s.lines.join("\n"));
    if (!text) continue;
    const prev = merged.at(-1);
    if (prev && text.length < MIN_CHARS && prev.text.length + text.length < MAX_CHARS) {
      prev.text += `\n\n${s.heading ? `${s.heading}: ` : ""}${text}`;
    } else merged.push({ heading: s.heading, text });
  }
  if (!merged.length) merged.push({ heading: "", text: "" });

  const chunks: Chunk[] = [];
  for (const m of merged) {
    for (const part of splitLong(m.text)) {
      const text = `${note.title}${m.heading ? ` › ${m.heading}` : ""}\n${part}`.trim();
      chunks.push({ ord: chunks.length, heading: m.heading, text, hash: sha1(text) });
    }
  }
  return chunks;
}
