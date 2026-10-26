import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, twoDevices, type TwoDevices } from "./helpers.js";

let t: TwoDevices;
beforeEach(() => (t = twoDevices()));
afterEach(() => t.cleanup());

describe("multi-device handoff", () => {
  it("a session on laptop A shows up in laptop B's briefing", async () => {
    await t.a.beginSession();
    await t.a.edit("Robot Dog", { op: "append_to_section", heading: "Navigation", text: "Chose frontier exploration." });
    const end = await t.a.endSession({
      summary: "Scoped navigation for the robot dog.",
      decisions: ["Use frontier exploration"],
      next_steps: ["Email Jane the plan"],
      threads: [{ thread: "Robot dog navigation", note: "Scoped approach", description: "Choosing a nav stack" }],
    });
    expect(end.session_log).toMatch(/^_brain\/sessions\/\d{4}\/\d{2}\/.*-laptop-a-\w{6}\.md$/);
    t.a.sync.push();

    const brief = await t.b.beginSession();
    expect(brief.sync.pull).toBe("merged");
    expect(brief.recent_sessions[0]).toMatchObject({
      device: "laptop-a",
      handoff: true,
      summary: "Scoped navigation for the robot dog.",
      next_steps: ["Email Jane the plan"],
    });
    expect(brief.open_threads[0]).toMatchObject({ thread: "robot-dog-navigation", last_device: "laptop-a" });
    const fromA = brief.changes_from_other_devices_since_last_session;
    expect(fromA.some((c) => c.device === "laptop-a" && c.what.startsWith("append_to_section"))).toBe(true);
    // Laptop B sees A's edit.
    expect((await t.b.read("Robot Dog")).content).toContain("Chose frontier exploration.");
  });

  it("writes an implicit log when a session ends without a handoff", async () => {
    await t.a.beginSession();
    await t.a.capture("quick idea");
    t.a.shutdown();
    const dir = join(t.pathA, "_brain/sessions");
    const files = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".md"));
    expect(files).toHaveLength(1);
    const log = readFileSync(join(dir, String(files[0])), "utf8");
    expect(log).toContain("handoff: false");
    expect(log).toMatch(/inbox\/\d{4}-\d{2}-\d{2}-laptop-a\.md/);
  });

  it("merges concurrent appends to session logs and inboxes without conflicts", async () => {
    await t.a.endSession({ summary: "A" });
    await t.b.endSession({ summary: "B" });
    t.a.sync.push();
    const r = t.b.sync.pull();
    expect(r.status).toBe("merged");
    t.b.sync.push();
    t.a.sync.pull();
    const count = (p: string) =>
      readdirSync(join(p, "_brain/sessions"), { recursive: true }).filter((f) => String(f).endsWith(".md")).length;
    expect(count(t.pathA)).toBe(2);
    expect(count(t.pathB)).toBe(2);
  });

  it("keeps a conflict copy instead of conflict markers when both devices edit a note", async () => {
    await t.a.edit("Jane Doe", { op: "replace_text", old_text: "Prefers email.", new_text: "Prefers Slack." });
    await t.b.edit("Jane Doe", { op: "replace_text", old_text: "Prefers email.", new_text: "Prefers phone." });
    t.a.sync.push();
    const r = t.b.sync.pull();
    expect(r.status).toBe("conflicts");
    expect(r.conflicts).toHaveLength(1);
    const local = readFileSync(join(t.pathB, "people/Jane Doe.md"), "utf8");
    const copy = readFileSync(join(t.pathB, r.conflicts[0]!.copy), "utf8");
    expect(local).toContain("Prefers phone.");
    expect(copy).toContain("Prefers Slack.");
    expect(local).not.toMatch(/<<<<<<<|>>>>>>>/);
    expect(git(t.pathB, "status", "--porcelain").trim()).toBe("");
    // The briefing flags it.
    const brief = await t.b.beginSession();
    expect(brief.sync.conflict_copies_awaiting_merge).toEqual([r.conflicts[0]!.copy]);
  });

  it("commits edits made outside the app (e.g. in Obsidian) before pulling", async () => {
    writeFileSync(join(t.pathB, "notes/Obsidian edit.md"), "# Typed in Obsidian\n");
    await t.a.capture("from A");
    t.a.sync.push();
    const r = t.b.sync.pull();
    expect(r.status).toBe("merged");
    expect(git(t.pathB, "log", "--format=%s").split("\n")).toContain("edit(laptop-b): notes/Obsidian edit.md");
    expect(existsSync(join(t.pathB, "notes/Obsidian edit.md"))).toBe(true);
  });

  it("works offline and reports it", async () => {
    git(t.pathA, "remote", "set-url", "origin", join(t.root, "does-not-exist.git"));
    const brief = await t.a.beginSession();
    expect(brief.sync.pull).toBe("offline");
    await t.a.capture("still works");
    expect(t.a.sync.status().dirty).toEqual([]);
  });
});
