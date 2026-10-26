import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Brain } from "../src/core.js";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDate } from "../src/util.js";
import { git, twoDevices, type TwoDevices } from "./helpers.js";

let t: TwoDevices;
beforeEach(() => (t = twoDevices()));
afterEach(() => t.cleanup());

const lastSubject = (p: string) => git(p, "log", "-1", "--format=%s").trim();

describe("Brain writes", () => {
  it("reads by title, path or wikilink text and returns a hash", async () => {
    const byTitle = await t.a.read("Robot Dog");
    expect(byTitle.path).toBe("projects/Robot Dog.md");
    expect((await t.a.read("[[projects/Robot Dog]]")).path).toBe("projects/Robot Dog.md");
    const section = await t.a.read("Robot Dog", "Navigation");
    expect(section.content.startsWith("## Navigation")).toBe(true);
    expect(byTitle.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("creates notes, commits each write, and refuses to overwrite", async () => {
    const r = await t.a.create({ title: "Go2: SLAM notes?", folder: "projects", content: "Body" });
    expect(r.path).toBe("projects/Go2 SLAM notes.md");
    const text = readFileSync(join(t.pathA, r.path), "utf8");
    expect(text).toContain('title: "Go2: SLAM notes?"');
    expect(text).toContain("updated_by: claude@laptop-a");
    expect(lastSubject(t.pathA)).toBe("brain(laptop-a): create projects/Go2 SLAM notes.md");
    await expect(t.a.create({ title: "Go2: SLAM notes?", folder: "projects" })).rejects.toThrow(/already exists/);
  });

  it("creates from templates", async () => {
    const r = await t.a.create({ title: "Sync with Jane", folder: "meetings", template: "meeting" });
    const n = await t.a.read(r.path);
    expect(n.frontmatter.type).toBe("meeting");
    expect(n.headings).toContain("## Decisions");
  });

  it("rejects paths outside the vault or in managed folders", async () => {
    await expect(t.a.create({ title: "x", path: "../escape.md" })).rejects.toThrow(/outside the vault/);
    await expect(t.a.create({ title: "x", path: ".git/hooks/x" })).rejects.toThrow(/outside the vault|hidden/);
    await expect(t.a.create({ title: "x", path: "_brain/templates/x" })).rejects.toThrow(/managed/);
  });

  it("edits with optimistic concurrency", async () => {
    const n = await t.a.read("Robot Dog");
    await t.a.edit("Robot Dog", { op: "append_to_section", heading: "Navigation", text: "Added by Claude." }, n.hash);
    expect(readFileSync(join(t.pathA, "projects/Robot Dog.md"), "utf8")).toContain("Added by Claude.");
    // The old hash is now stale.
    await expect(
      t.a.edit("Robot Dog", { op: "append", text: "again" }, n.hash),
    ).rejects.toThrow(/changed since you last read it/);
  });

  it("moves notes and updates links that point at them", async () => {
    const r = await t.a.move("Reciprocal Rank Fusion", "notes/search/RRF.md");
    expect(r.linksUpdatedIn).toEqual(["notes/Hybrid Search.md"]);
    const hybrid = readFileSync(join(t.pathA, "notes/Hybrid Search.md"), "utf8");
    expect(hybrid).toContain('"[[RRF]]"');
    expect(hybrid).toContain("[[RRF|RRF]]");
    expect((await t.a.related("RRF")).backlinks).toHaveLength(1);
  });

  it("soft-deletes to the trash", async () => {
    const r = await t.a.delete("Jane Doe");
    expect(existsSync(join(t.pathA, "people/Jane Doe.md"))).toBe(false);
    expect(existsSync(join(t.pathA, r.trashedTo))).toBe(true);
    await expect(t.a.read("Jane Doe")).rejects.toThrow(/not found/);
  });

  it("queries and updates tasks by id", async () => {
    const open = await t.a.tasks();
    expect(open.map((x) => x.text)).toContain("Order spare battery");
    const battery = open.find((x) => x.text === "Order spare battery")!;
    expect(battery.id).toBe("batt01");
    await t.a.taskUpdate({ id: "batt01", done: true });
    const line = readFileSync(join(t.pathA, "projects/Robot Dog.md"), "utf8").split("\n").find((l) => l.includes("battery"))!;
    expect(line).toMatch(/^> - \[x\] Order spare battery .*✅ \d{4}-\d{2}-\d{2}$/);
    expect((await t.a.tasks()).map((x) => x.id)).not.toContain("batt01");
    expect((await t.a.tasks({ status: "done" })).map((x) => x.id)).toContain("batt01");
  });

  it("finds a task even if lines shifted after indexing", async () => {
    const [task] = await t.a.tasks({ path: "Hybrid Search" });
    const file = join(t.pathA, "notes/Hybrid Search.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("# Hybrid Search\n", "# Hybrid Search\n\nNew line\n\n"));
    // Index is stale (same second mtime) only if we skip fresh; taskUpdate calls fresh, which reindexes.
    await t.a.taskUpdate({ id: task!.id, due: "2026-12-01" });
    expect(readFileSync(file, "utf8")).toContain("Benchmark on 1k notes #search 📅 2026-12-01");
  });

  it("creates the daily note from the template and captures to the inbox", async () => {
    const d = await t.a.daily();
    expect(d!.path).toBe(`daily/${localDate()}.md`);
    expect(d!.headings).toContain("## Plan");
    const c = await t.a.capture("Remember the battery");
    expect(c.path).toBe(`inbox/${localDate()}-laptop-a.md`);
    await t.a.capture("Second thought");
    const inbox = readFileSync(join(t.pathA, c.path), "utf8");
    expect(inbox.match(/^- \d\d:\d\d /gm)).toHaveLength(2);
  });
});

describe("folders not set up with brain init", () => {
  it("never commit, pull or push (safe to point at an existing Obsidian vault)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-plain-"));
    cpSync(join(__dirname, "fixtures/vault"), dir, { recursive: true });
    rmSync(join(dir, "_brain/config.yml"));
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "theirs");
    const brain = new Brain({ vault: dir, device: "x", dbFile: ":memory:" });
    expect(brain.syncEnabled).toBe(false);
    await brain.capture("hello");
    await brain.beginSession();
    expect(git(dir, "log", "--format=%s").trim()).toBe("theirs");
    await expect(brain.syncNow()).rejects.toThrow(/Sync is off/);
    brain.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
