/**
 * Pure text operations on note content. No I/O, so they are easy to test and
 * reuse from the MCP server and the web app.
 */
import { parseDocument } from "yaml";
import { BrainError } from "../util.js";

const FM_RE = /^(﻿?)---\r?\n([\s\S]*?)\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/;
const FENCE_RE = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

export function splitFrontmatter(content: string): { fm: string | null; body: string } {
  const m = content.match(FM_RE);
  if (!m) return { fm: null, body: content };
  return { fm: m[2]!, body: content.slice(m[0].length) };
}

function joinFrontmatter(fm: string | null, body: string): string {
  if (fm == null) return body;
  return `---\n${fm.replace(/\n+$/, "")}\n---\n${body}`;
}

function ensureTrailingNewline(s: string): string {
  return s.length === 0 || s.endsWith("\n") ? s : `${s}\n`;
}

export function appendText(content: string, text: string): string {
  const base = ensureTrailingNewline(content);
  return `${base}${ensureTrailingNewline(text)}`;
}

export function prependText(content: string, text: string): string {
  const { fm, body } = splitFrontmatter(content);
  const block = ensureTrailingNewline(text);
  // Keep a leading H1 at the top: insert after it.
  const h1 = body.match(/^(\s*#[ \t]+[^\n]*\n)/);
  const next = h1 ? `${h1[1]}\n${block}${body.slice(h1[1]!.length)}` : `${block}${body}`;
  return joinFrontmatter(fm, next);
}

interface Section {
  /** Line index of the heading. */
  headingLine: number;
  level: number;
  /** Line index where the section's content ends (exclusive). */
  end: number;
}

/**
 * Finds a section by heading text (case-insensitive, `#` prefix optional).
 * A section runs until the next heading of the same or higher level.
 */
export function findSection(lines: string[], heading: string): Section {
  const wanted = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  const wantedLevel = heading.match(/^(#+)\s/)?.[1]!.length;
  const headings: Array<{ line: number; level: number; text: string }> = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i]!.match(FENCE_RE);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      continue;
    }
    const h = lines[i]!.match(HEADING_RE);
    if (h) headings.push({ line: i, level: h[1]!.length, text: h[2]!.trim().toLowerCase() });
  }
  const matches = headings.filter(
    (h) => h.text === wanted && (wantedLevel === undefined || h.level === wantedLevel),
  );
  if (matches.length === 0) throw new BrainError(`Heading not found: ${heading}`, "no_match");
  if (matches.length > 1)
    throw new BrainError(
      `Heading "${heading}" appears ${matches.length} times; include the level, e.g. "## ${heading}"`,
      "ambiguous",
    );
  const h = matches[0]!;
  const next = headings.find((o) => o.line > h.line && o.level <= h.level);
  return { headingLine: h.line, level: h.level, end: next ? next.line : lines.length };
}

function trimBlankTail(lines: string[], start: number, end: number): number {
  let e = end;
  while (e > start && lines[e - 1]!.trim() === "") e--;
  return e;
}

export function appendToSection(content: string, heading: string, text: string): string {
  const { fm, body } = splitFrontmatter(content);
  const lines = body.split("\n");
  const s = findSection(lines, heading);
  const insertAt = trimBlankTail(lines, s.headingLine + 1, s.end);
  const newLines = text.replace(/\n+$/, "").split("\n");
  // Keep a blank line between the inserted text and a following heading.
  const gap = lines[insertAt] !== undefined && lines[insertAt]!.trim() !== "" ? [""] : [];
  lines.splice(insertAt, 0, ...newLines, ...gap);
  return joinFrontmatter(fm, lines.join("\n"));
}

export function replaceSection(content: string, heading: string, text: string): string {
  const { fm, body } = splitFrontmatter(content);
  const lines = body.split("\n");
  const s = findSection(lines, heading);
  const replacement = text.replace(/\n+$/, "").split("\n");
  const tail = s.end < lines.length ? [""] : [];
  lines.splice(s.headingLine + 1, s.end - s.headingLine - 1, ...replacement, ...tail);
  return joinFrontmatter(fm, lines.join("\n"));
}

export function replaceText(content: string, oldText: string, newText: string): string {
  if (!oldText) throw new BrainError("old_text must not be empty", "invalid");
  const first = content.indexOf(oldText);
  if (first === -1) throw new BrainError("old_text not found in note", "no_match");
  if (content.indexOf(oldText, first + 1) !== -1)
    throw new BrainError("old_text matches more than once; include more context", "ambiguous");
  return content.slice(0, first) + newText + content.slice(first + oldText.length);
}

/**
 * Sets or removes frontmatter keys while preserving the rest of the YAML
 * (comments, key order). `null` removes a key. Creates frontmatter if missing.
 */
export function setFrontmatter(content: string, updates: Record<string, unknown>): string {
  const { fm, body } = splitFrontmatter(content);
  const doc = parseDocument(fm ?? "");
  if (doc.errors.length) throw new BrainError(`Invalid frontmatter: ${doc.errors[0]!.message}`);
  if (doc.contents == null) doc.contents = doc.createNode({}) as never;
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === undefined) doc.delete(k);
    else doc.set(k, v);
  }
  const yaml = doc.toString({ lineWidth: 0 }).replace(/\n+$/, "");
  if (yaml === "{}" || yaml === "") return body;
  return joinFrontmatter(yaml, fm == null ? body.replace(/^(?!\n)/, "") : body);
}

/** Records who last wrote the note, but only for notes that already have frontmatter. */
export function stamp(content: string, by: string, when: string): string {
  if (!FM_RE.test(content)) return content;
  try {
    return setFrontmatter(content, { updated: when, updated_by: by });
  } catch {
    return content; // never block a write because of someone's odd YAML
  }
}

const TASK_LINE_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*[-*+][ \t]+\[)(.)(\][ \t]+)(.*)$/;

export function setTaskLine(
  line: string,
  change: { done?: boolean; due?: string | null; text?: string },
  today: string,
): string {
  const m = line.match(TASK_LINE_RE);
  if (!m) throw new BrainError("Line is not a task", "invalid");
  let [, pre, status, mid, rest] = m as unknown as [string, string, string, string, string];
  if (change.text !== undefined) {
    // Keep date/id markers, replace the descriptive text.
    const markers = rest.match(/\s*(?:[📅📆🗓⏳🛫✅➕❌🆔⛔🔁🔺⏫🔼🔽⏬].*)$/u)?.[0] ?? "";
    rest = `${change.text.trim()}${markers ? ` ${markers.trim()}` : ""}`;
  }
  if (change.done === true && status !== "x" && status !== "X") {
    status = "x";
    rest = `${rest.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/u, "")} ✅ ${today}`;
  } else if (change.done === false) {
    status = " ";
    rest = rest.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/u, "");
  }
  if (change.due !== undefined) {
    rest = rest.replace(/\s*(?:📅|📆|🗓️?)\s*\d{4}-\d{2}-\d{2}/u, "");
    if (change.due) {
      // Put the due date before a done marker if there is one.
      const done = rest.match(/\s*✅\s*\d{4}-\d{2}-\d{2}/u);
      rest = done
        ? `${rest.slice(0, done.index)} 📅 ${change.due}${rest.slice(done.index)}`
        : `${rest} 📅 ${change.due}`;
    }
  }
  return `${pre}${status}${mid}${rest.replace(/\s+$/, "")}`;
}

/** Rewrites wikilinks whose target matches one of `oldTargets` (case-insensitive). */
export function rewriteLinks(content: string, oldTargets: string[], newTarget: string): string {
  const olds = new Set(oldTargets.map((t) => t.toLowerCase().replace(/\.md$/i, "")));
  return content.replace(/(!?\[\[)([^\[\]\n|#]*)([^\[\]\n]*\]\])/g, (m, open, target, rest) =>
    olds.has(String(target).trim().toLowerCase().replace(/\.md$/i, ""))
      ? `${open}${newTarget}${rest}`
      : m,
  );
}
