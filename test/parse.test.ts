import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNote } from "../src/vault/parse.js";

const FIXTURES = join(__dirname, "fixtures/vault");
const load = (p: string) => parseNote(p, readFileSync(join(FIXTURES, p), "utf8"));

describe("parseNote: frontmatter and title", () => {
  it("reads frontmatter and prefers its title", () => {
    const n = load("notes/Hybrid Search.md");
    expect(n.title).toBe("Hybrid Search");
    expect(n.frontmatter.tags).toEqual(["search", "ai-ml"]);
    expect(n.frontmatterError).toBeUndefined();
    expect(n.bodyLineOffset).toBe(7);
  });

  it("falls back to the first H1, then the file name", () => {
    expect(load("notes/Reciprocal Rank Fusion.md").title).toBe("Reciprocal Rank Fusion");
    expect(parseNote("a/My File.md", "no heading here").title).toBe("My File");
  });

  it("survives invalid YAML and still parses the body", () => {
    const n = load("inbox/broken.md");
    expect(n.frontmatterError).toBeTruthy();
    expect(n.frontmatter).toEqual({});
    expect(n.links.map((l) => l.target)).toContain("Hybrid Search");
    expect(n.title).toBe("broken");
  });

  it("accepts a comma or space separated tags string", () => {
    const n = parseNote("x.md", "---\ntags: one, two three\n---\nbody");
    expect(n.tags.sort()).toEqual(["one", "three", "two"]);
  });

  it("handles a BOM and CRLF line endings", () => {
    const n = parseNote("x.md", "﻿---\r\ntitle: T\r\n---\r\n# H\r\n- [ ] a\r\n");
    expect(n.title).toBe("T");
    expect(n.headings).toEqual([{ level: 1, text: "H", line: 4 }]);
    expect(n.tasks).toHaveLength(1);
  });
});

describe("parseNote: headings, links, tags", () => {
  const n = load("notes/Hybrid Search.md");

  it("ignores headings inside code fences", () => {
    expect(n.headings.map((h) => h.text)).toEqual(["Hybrid Search"]);
    expect(n.headings[0]!.line).toBe(9);
  });

  it("parses aliases, headings and frontmatter links", () => {
    const fm = n.links.filter((l) => l.inFrontmatter);
    expect(fm).toHaveLength(1);
    expect(fm[0]!.target).toBe("Reciprocal Rank Fusion");

    const rrf = n.links.find((l) => !l.inFrontmatter && l.target === "Reciprocal Rank Fusion");
    expect(rrf?.alias).toBe("RRF");

    const nav = n.links.find((l) => l.target === "projects/Robot Dog");
    expect(nav?.heading).toBe("Navigation");
    expect(nav?.line).toBe(12);
  });

  it("skips links and tags in code blocks, inline code and math", () => {
    const targets = n.links.map((l) => l.target);
    expect(targets).not.toContain("Not A Link");
    expect(targets).not.toContain("Nope");
    expect(n.tags.sort()).toEqual(["ai-ml", "retrieval", "search"]);
  });

  it("detects embeds and same-note heading links", () => {
    const m = parseNote("x.md", "![[diagram.png]] and [[#Local Heading]]");
    expect(m.links[0]).toMatchObject({ target: "diagram.png", embed: true });
    expect(m.links[1]).toMatchObject({ target: "", heading: "Local Heading" });
  });

  it("handles escaped pipes in table links", () => {
    const m = parseNote("x.md", "| [[Note\\|alias]] | b |");
    expect(m.links[0]).toMatchObject({ target: "Note", alias: "alias" });
  });

  it("does not treat numbers, URLs or headings as tags", () => {
    const m = parseNote("x.md", "# Title\nissue #123 and https://x.com/#frag and #real-tag/sub");
    expect(m.tags).toEqual(["real-tag/sub"]);
  });
});

describe("parseNote: tasks", () => {
  it("parses status, dates and strips markers from text", () => {
    const [todo, done] = load("notes/Hybrid Search.md").tasks;
    expect(todo).toMatchObject({
      status: "todo",
      due: "2026-10-30",
      text: "Benchmark on 1k notes #search",
      tags: ["search"],
    });
    expect(done).toMatchObject({ status: "done", doneDate: "2026-10-20" });
  });

  it("parses tasks in callouts, explicit ids, recurrence and custom statuses", () => {
    const tasks = load("projects/Robot Dog.md").tasks;
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ id: "batt01", scheduled: "2026-10-28", status: "todo" });
    expect(tasks[0]!.text).toBe("Order spare battery");
    expect(tasks[1]).toMatchObject({
      status: "in_progress",
      recurrence: "every week",
      due: "2026-10-27",
      text: "Write ROS2 launch files",
    });
    expect(tasks[2]!.status).toBe("cancelled");
  });

  it("gives tasks ids that survive moving lines but not text edits", () => {
    const a = parseNote("n.md", "- [ ] do thing").tasks[0]!;
    const b = parseNote("n.md", "\n\n\n- [ ] do thing").tasks[0]!;
    const c = parseNote("n.md", "- [ ] do other thing").tasks[0]!;
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  it("ignores tasks inside code fences", () => {
    expect(parseNote("x.md", "```\n- [ ] no\n```\n- [ ] yes").tasks.map((t) => t.text)).toEqual([
      "yes",
    ]);
  });
});
