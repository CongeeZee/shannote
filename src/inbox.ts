/**
 * Inbox entries: quick captures waiting to be filed. Any markdown file in
 * `inbox/` counts, whether written by `brain_capture`, the web app, or typed on
 * a phone in Obsidian. Each top-level list item or paragraph is one entry.
 */
import { sha1 } from "./util.js";
import { splitFrontmatter } from "./vault/edit.js";

export interface InboxEntry {
  /** Stable id: hash of file path and entry text. */
  id: string;
  path: string;
  /** 0-based line range [start, end) within the file, frontmatter included. */
  start: number;
  end: number;
  /** "HH:MM" when the entry was captured with a timestamp. */
  time?: string;
  /** Date from the file name (YYYY-MM-DD…) if present. */
  date?: string;
  text: string;
}

const ITEM_RE = /^[-*+]\s+(?:\[.\]\s+)?(?:(\d{2}:\d{2})\s+)?(.*)$/;

export function parseInbox(path: string, content: string): InboxEntry[] {
  const { fm, body } = splitFrontmatter(content);
  const offset = fm == null ? 0 : content.slice(0, content.length - body.length).split("\n").length - 1;
  const lines = body.split("\n");
  const date = path.split("/").pop()!.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  const entries: InboxEntry[] = [];
  let cur: { kind: "item" | "para"; start: number; end: number; time?: string; lines: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const text = cur.lines.map((l) => l.trim()).join("\n").trim();
    if (text)
      entries.push({ id: sha1(`${path}\0${text}`).slice(0, 12), path, start: cur.start + offset, end: cur.end + offset, time: cur.time, date, text });
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,6}\s/.test(line) || /^\s*(---|\*\*\*)\s*$/.test(line)) {
      flush();
      continue;
    }
    const item = line.match(ITEM_RE);
    if (item) {
      flush();
      cur = { kind: "item", start: i, end: i + 1, time: item[1], lines: [item[2]!] };
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // Indented lines continue a list item; any text continues a paragraph.
    if (cur && (cur.kind === "para" || /^\s+\S/.test(line))) {
      cur.lines.push(line);
      cur.end = i + 1;
      continue;
    }
    flush();
    cur = { kind: "para", start: i, end: i + 1, lines: [line] };
  }
  flush();
  return entries;
}
