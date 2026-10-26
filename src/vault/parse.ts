import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { Heading, Link, ParsedNote, Task, TaskStatus } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
// Obsidian tag rules: preceded by start/whitespace, made of letters, digits, _ - /,
// and must contain at least one non-digit character.
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]+)/gu;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const TASK_RE = /^((?:[ \t]*>[ \t]?)*)([ \t]*)[-*+][ \t]+\[(.)\][ \t]+(.*)$/;
const FENCE_RE = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})/;

const DATE = "(\\d{4}-\\d{2}-\\d{2})";
const TASK_FIELDS: Array<[keyof Task, RegExp]> = [
  ["due", new RegExp(`(?:📅|📆|🗓️?)\\s*${DATE}`, "u")],
  ["scheduled", new RegExp(`⏳\\s*${DATE}`, "u")],
  ["start", new RegExp(`🛫\\s*${DATE}`, "u")],
  ["doneDate", new RegExp(`✅\\s*${DATE}`, "u")],
];
const RECURRENCE_RE = /🔁\s*([^📅📆🗓⏳🛫✅🆔⛔#\n]+?)\s*(?=[📅📆🗓⏳🛫✅🆔⛔#]|$)/u;
const ID_RE = /🆔\s*([A-Za-z0-9_-]+)/u;
const STRIP_MARKERS_RE =
  /\s*(?:(?:📅|📆|🗓️?|⏳|🛫|✅|➕|❌)\s*\d{4}-\d{2}-\d{2}|🆔\s*[A-Za-z0-9_-]+|⛔\s*[A-Za-z0-9_,-]+|🔁\s*[^📅📆🗓⏳🛫✅🆔⛔#\n]+|[🔺⏫🔼🔽⏬])/gu;

export function statusFromChar(c: string): TaskStatus {
  switch (c) {
    case " ":
      return "todo";
    case "x":
    case "X":
      return "done";
    case "-":
      return "cancelled";
    case "/":
      return "in_progress";
    default:
      return "other";
  }
}

/** Remove inline code spans so their contents aren't parsed as tags or links. */
function stripInlineCode(line: string): string {
  return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (m) => " ".repeat(m.length));
}

function parseLinkInner(inner: string): { target: string; heading?: string; alias?: string } {
  let rest = inner;
  let alias: string | undefined;
  // Obsidian allows `\|` inside tables to escape the pipe.
  const pipe = rest.search(/\\?\|/);
  if (pipe !== -1) {
    const m = rest.slice(pipe).match(/^\\?\|/)!;
    alias = rest.slice(pipe + m[0].length).trim() || undefined;
    rest = rest.slice(0, pipe);
  }
  let heading: string | undefined;
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    heading = rest.slice(hash + 1).trim() || undefined;
    rest = rest.slice(0, hash);
  }
  return { target: rest.trim(), heading, alias };
}

function linksInText(text: string, line: number, inFrontmatter: boolean): Link[] {
  const out: Link[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const { target, heading, alias } = parseLinkInner(m[2]!);
    // `[[#Heading]]` links to the same note: keep it with an empty target.
    if (!target && !heading) continue;
    out.push({ target, heading, alias, embed: m[1] === "!", inFrontmatter, line });
  }
  return out;
}

function collectFrontmatterStrings(value: unknown, acc: string[]): void {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) for (const v of value) collectFrontmatterStrings(v, acc);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectFrontmatterStrings(v, acc);
}

function normaliseTag(t: string): string {
  return t.replace(/^#/, "").trim().toLowerCase();
}

function frontmatterTags(fm: Record<string, unknown>): string[] {
  const raw = fm.tags ?? fm.tag;
  const list: string[] = [];
  if (typeof raw === "string") list.push(...raw.split(/[,\s]+/));
  else if (Array.isArray(raw)) for (const t of raw) if (t != null) list.push(String(t));
  return list.map(normaliseTag).filter(Boolean);
}

function inlineTags(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(TAG_RE)) {
    const tag = m[2]!.replace(/[/\-]+$/, "");
    if (tag && /[^\d]/.test(tag)) out.push(tag.toLowerCase());
  }
  return out;
}

export function taskId(path: string, text: string): string {
  return createHash("sha1").update(`${path}\0${text.trim()}`).digest("hex").slice(0, 12);
}

function parseTask(path: string, lineText: string, lineNo: number): Task | null {
  const m = lineText.match(TASK_RE);
  if (!m) return null;
  const indent = m[2]!.replace(/\t/g, "    ").length;
  const statusChar = m[3]!;
  const content = m[4]!;
  const task: Task = {
    id: "",
    line: lineNo,
    text: "",
    raw: lineText,
    statusChar,
    status: statusFromChar(statusChar),
    tags: inlineTags(stripInlineCode(content)),
    indent,
  };
  for (const [key, re] of TASK_FIELDS) {
    const f = content.match(re);
    if (f) (task as unknown as Record<string, unknown>)[key] = f[1];
  }
  const rec = content.match(RECURRENCE_RE);
  if (rec) task.recurrence = rec[1]!.trim();
  task.text = content.replace(STRIP_MARKERS_RE, "").replace(/\s+/g, " ").trim();
  const explicitId = content.match(ID_RE);
  task.id = explicitId ? explicitId[1]! : taskId(path, task.text);
  return task;
}

function fileStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

export function parseNote(path: string, content: string): ParsedNote {
  const src = content.replace(/^﻿/, "");
  let frontmatter: Record<string, unknown> = {};
  let frontmatterError: string | undefined;
  let body = src;
  let bodyLineOffset = 0;
  const links: Link[] = [];

  const fmMatch = src.match(FRONTMATTER_RE);
  if (fmMatch) {
    body = src.slice(fmMatch[0].length);
    bodyLineOffset = fmMatch[0].split("\n").length - 1;
    try {
      const parsed = parseYaml(fmMatch[1]!, { uniqueKeys: false });
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      } else if (parsed != null) {
        frontmatterError = "frontmatter is not a key/value mapping";
      }
    } catch (e) {
      frontmatterError = (e as Error).message.split("\n")[0];
    }
    // Links in frontmatter: scan parsed string values; fall back to raw text on YAML errors.
    const fmLines = fmMatch[1]!.split(/\r?\n/);
    if (frontmatterError) {
      fmLines.forEach((l, i) => links.push(...linksInText(l, i + 2, true)));
    } else {
      const strings: string[] = [];
      collectFrontmatterStrings(frontmatter, strings);
      for (const s of strings) {
        const idx = fmLines.findIndex((l) => l.includes(s.split("\n")[0]!));
        links.push(...linksInText(s, idx === -1 ? 1 : idx + 2, true));
      }
    }
  }

  const headings: Heading[] = [];
  const tasks: Task[] = [];
  const tags = new Set<string>(frontmatterTags(frontmatter));
  let fence: string | null = null;
  let inMath = false;
  let inComment = false;

  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1 + bodyLineOffset;

    const fm = raw.match(FENCE_RE);
    if (fence) {
      if (fm && fm[1]![0] === fence[0] && fm[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fm) {
      fence = fm[1]!;
      continue;
    }
    if (/^\s*\$\$/.test(raw)) {
      // A line like `$$x$$` opens and closes on the same line.
      const count = (raw.match(/\$\$/g) ?? []).length;
      if (count % 2 === 1) inMath = !inMath;
      continue;
    }
    if (inMath) continue;
    if (inComment) {
      if (raw.includes("%%")) inComment = false;
      continue;
    }
    if (/^\s*%%/.test(raw) && (raw.match(/%%/g) ?? []).length === 1) {
      inComment = true;
      continue;
    }

    const line = stripInlineCode(raw);
    const h = line.match(HEADING_RE);
    if (h) headings.push({ level: h[1]!.length, text: h[2]!.trim(), line: lineNo });
    links.push(...linksInText(line, lineNo, false));
    if (!h) for (const t of inlineTags(line)) tags.add(t);
    else for (const t of inlineTags(h[2]!)) tags.add(t);
    const task = parseTask(path, raw, lineNo);
    if (task) tasks.push(task);
  }

  const fmTitle = typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
  const h1 = headings.find((h) => h.level === 1)?.text;
  const title = fmTitle || h1 || fileStem(path);
  const wordCount = (body.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;

  return {
    path,
    title,
    frontmatter,
    frontmatterError,
    body,
    bodyLineOffset,
    headings,
    links,
    tags: [...tags],
    tasks,
    wordCount,
  };
}
