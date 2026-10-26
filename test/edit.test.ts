import { describe, expect, it } from "vitest";
import {
  appendText,
  appendToSection,
  prependText,
  replaceSection,
  replaceText,
  rewriteLinks,
  setFrontmatter,
  setTaskLine,
  stamp,
} from "../src/vault/edit.js";

const NOTE = `---
title: Plan
# keep this comment
tags: [a]
---
# Plan

## Today
- one

## Later
- two
`;

describe("edit operations", () => {
  it("appends and prepends (prepend goes after frontmatter and H1)", () => {
    expect(appendText("a", "b")).toBe("a\nb\n");
    const p = prependText(NOTE, "Intro line");
    expect(p).toContain("# Plan\n\nIntro line\n\n## Today");
    expect(p.startsWith("---\ntitle: Plan")).toBe(true);
  });

  it("appends to the end of a section, before the next heading", () => {
    const r = appendToSection(NOTE, "Today", "- new");
    expect(r).toContain("## Today\n- one\n- new\n\n## Later");
    expect(appendToSection(NOTE, "## Later", "- three")).toMatch(/- two\n- three\n?$/);
  });

  it("replaces a section body but keeps the heading", () => {
    const r = replaceSection(NOTE, "today", "- replaced");
    expect(r).toContain("## Today\n- replaced\n\n## Later\n- two");
  });

  it("refuses ambiguous or missing headings", () => {
    const dup = "## A\nx\n## A\ny\n";
    expect(() => appendToSection(dup, "A", "z")).toThrow(/appears 2 times/);
    expect(() => appendToSection(NOTE, "Nope", "z")).toThrow(/not found/);
  });

  it("ignores headings inside code fences", () => {
    const md = "## Real\nx\n```\n## Fake\n```\n";
    expect(appendToSection(md, "Real", "y")).toBe("## Real\nx\n```\n## Fake\n```\ny\n");
  });

  it("replace_text requires exactly one match", () => {
    expect(replaceText("a b c", "b", "B")).toBe("a B c");
    expect(() => replaceText("a a", "a", "b")).toThrow(/more than once/);
    expect(() => replaceText("a", "z", "b")).toThrow(/not found/);
  });

  it("sets frontmatter keys and keeps comments and order", () => {
    const r = setFrontmatter(NOTE, { status: "active", title: "Plan v2" });
    expect(r).toContain("# keep this comment");
    expect(r).toMatch(/title: Plan v2\n# keep this comment\ntags: \[ ?a ?\]\nstatus: active/);
    expect(setFrontmatter(NOTE, { tags: null })).not.toContain("tags:");
    expect(setFrontmatter("# T\n", { a: 1 })).toBe("---\na: 1\n---\n# T\n");
  });

  it("stamps notes that have frontmatter and leaves others alone", () => {
    expect(stamp(NOTE, "claude@x", "2026-10-26T10:00:00+11:00")).toContain("updated_by: claude@x");
    expect(stamp("# no fm\n", "claude@x", "t")).toBe("# no fm\n");
  });

  it("completes, reopens, reschedules and rewords tasks", () => {
    const line = "- [ ] Email Jane 📅 2026-10-30 🆔 abc";
    const done = setTaskLine(line, { done: true }, "2026-10-26");
    expect(done).toBe("- [x] Email Jane 📅 2026-10-30 🆔 abc ✅ 2026-10-26");
    expect(setTaskLine(done, { done: false }, "x")).toBe("- [ ] Email Jane 📅 2026-10-30 🆔 abc");
    expect(setTaskLine(line, { due: "2026-11-02" }, "x")).toBe("- [ ] Email Jane 🆔 abc 📅 2026-11-02");
    expect(setTaskLine(line, { due: null }, "x")).toBe("- [ ] Email Jane 🆔 abc");
    expect(setTaskLine(line, { text: "Call Jane" }, "x")).toBe("- [ ] Call Jane 📅 2026-10-30 🆔 abc");
    expect(setTaskLine("> - [ ] in callout", { done: true }, "2026-10-26")).toBe("> - [x] in callout ✅ 2026-10-26");
    expect(() => setTaskLine("not a task", { done: true }, "x")).toThrow();
  });

  it("rewrites wikilinks to a moved note, keeping headings and aliases", () => {
    const md = "See [[Old Name]], [[old name#Sec|alias]], ![[Old Name]] and [[Other]].";
    expect(rewriteLinks(md, ["Old Name"], "New Name")).toBe(
      "See [[New Name]], [[New Name#Sec|alias]], ![[New Name]] and [[Other]].",
    );
  });
});
