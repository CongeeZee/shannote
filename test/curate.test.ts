import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseInbox } from "../src/inbox.js";
import { findUnlinkedMentions, linkableTitle, linkMention } from "../src/links.js";
import { localDate } from "../src/util.js";
import { startWebServer } from "../src/web/server.js";
import { git, twoDevices, type TwoDevices } from "./helpers.js";

describe("parseInbox", () => {
  it("splits list items (with continuation lines) and paragraphs into entries", () => {
    const md = `---\ntitle: Inbox\n---\n\n- 09:12 Idea: frontier exploration\n  with lidar\n- Buy batteries\n\nA paragraph typed on the phone\nspanning two lines.\n\n## Heading\nAfter heading`;
    const e = parseInbox("inbox/2026-10-26-phone.md", md);
    expect(e.map((x) => [x.time, x.text])).toEqual([
      ["09:12", "Idea: frontier exploration\nwith lidar"],
      [undefined, "Buy batteries"],
      [undefined, "A paragraph typed on the phone\nspanning two lines."],
      [undefined, "After heading"],
    ]);
    expect(e[0]!.date).toBe("2026-10-26");
    expect(md.split("\n").slice(e[0]!.start, e[0]!.end)).toEqual(["- 09:12 Idea: frontier exploration", "  with lidar"]);
    expect(new Set(e.map((x) => x.id)).size).toBe(4);
  });
});

describe("unlinked mentions", () => {
  const notes = [
    { path: "notes/Hybrid Search.md", title: "Hybrid Search" },
    { path: "notes/Page Tables.md", title: "Page Tables" },
    { path: "notes/Ideas.md", title: "Ideas" },
    { path: "daily/2026-10-26.md", title: "2026-10-26" },
    { path: "notes/TLB.md", title: "TLB" },
  ];

  it("ignores generic, short and date titles", () => {
    expect(linkableTitle("Ideas")).toBe(false);
    expect(linkableTitle("2026-10-26")).toBe(false);
    expect(linkableTitle("TLB")).toBe(false);
    expect(linkableTitle("Page Tables")).toBe(true);
  });

  it("finds whole-word mentions outside code, links and frontmatter", () => {
    const md = "---\ntitle: x\nsummary: page tables\n---\n# Page Tables heading\nWe use hybrid search here.\n`page tables` in code\n[[Page Tables]] already linked\nAnd page tables again.\nsubhybrid searching";
    const m = findUnlinkedMentions(md, notes, { selfPath: "notes/x.md" });
    expect(m.map((x) => [x.title, x.line, x.text])).toEqual([
      ["Hybrid Search", 6, "hybrid search"],
      ["Page Tables", 9, "page tables"],
    ]);
    const linked = findUnlinkedMentions(md, notes, { linked: new Set(["notes/Page Tables.md"]) });
    expect(linked.map((x) => x.title)).toEqual(["Hybrid Search"]);
  });

  it("links a mention keeping the original wording", () => {
    const md = "a\nWe use hybrid search here.";
    expect(linkMention(md, { line: 2, text: "hybrid search" }, "Hybrid Search")).toBe("a\nWe use [[Hybrid Search|hybrid search]] here.");
    expect(linkMention(md, { line: 2, text: "hybrid search" }, "hybrid search")).toBe("a\nWe use [[hybrid search]] here.");
    expect(() => linkMention(md, { line: 2, text: "nope" }, "X")).toThrow(/changed/);
  });
});

describe("Brain: inbox, links, context packs", () => {
  let t: TwoDevices;
  beforeEach(() => (t = twoDevices()));
  afterEach(() => t.cleanup());

  it("lists inbox entries with suggestions and files them", async () => {
    await t.a.capture("Frontier exploration idea for the rescue robot");
    await t.a.capture("Call the dentist");
    await t.a.capture("random noise");
    const inbox = await t.a.inbox();
    expect(inbox.count).toBe(4); // + the fixture's inbox/broken.md
    const [idea, call, noise] = inbox.entries;
    expect(idea!.suggestions[0]!.path).toBe("projects/Robot Dog.md");

    const r1 = await t.a.inboxResolve({ id: idea!.id, action: "move", target: idea!.suggestions[0]!.path, heading: "Navigation" });
    expect(r1).toMatchObject({ destination: "projects/Robot Dog.md", remaining: 3 });
    expect(readFileSync(join(t.pathA, "projects/Robot Dog.md"), "utf8")).toMatch(/## Navigation\n[\s\S]*- Frontier exploration idea for the rescue robot/);

    await t.a.inboxResolve({ id: call!.id, action: "task", due: "2026-10-30" });
    expect(readFileSync(join(t.pathA, `daily/${localDate()}.md`), "utf8")).toContain("- [ ] Call the dentist 📅 2026-10-30");

    const r3 = await t.a.inboxResolve({ id: noise!.id, action: "discard" });
    expect(r3.remaining).toBe(1);
    // Empty inbox files are removed; every resolution is logged.
    expect(existsSync(join(t.pathA, `inbox/${localDate()}-laptop-a.md`))).toBe(false);
    const log = readFileSync(join(t.pathA, `_brain/inbox-log/${localDate().slice(0, 7)}.md`), "utf8");
    expect(log.match(/^- /gm)).toHaveLength(3);
    expect(log).toContain("discard: random noise");
    expect(git(t.pathA, "status", "--porcelain").trim()).toBe("");
    await expect(t.a.inboxResolve({ id: noise!.id, action: "archive" })).rejects.toThrow(/not found/);
  });

  it("suggests and adds links (mention, frontmatter related:, Related section)", async () => {
    writeFileSync(join(t.pathA, "notes/Planning.md"), "---\ntitle: Planning\nrelated: []\n---\nThe robot dog needs frontier work. See reciprocal rank fusion too.\n");
    const s = await t.a.linkSuggestions({ note: "notes/Planning.md" });
    const mentions = s[0]!.mentions;
    expect(mentions.map((m) => m.title).sort()).toEqual(["Reciprocal Rank Fusion", "Robot Dog"]);

    const m = mentions.find((x) => x.title === "Robot Dog")!;
    expect((await t.a.addLink({ note: "notes/Planning.md", target: m.target, line: m.line, text: m.text })).how).toBe("mention");
    expect(readFileSync(join(t.pathA, "notes/Planning.md"), "utf8")).toContain("The [[Robot Dog|robot dog]] needs");

    expect((await t.a.addLink({ note: "notes/Planning.md", target: "Jane Doe" })).how).toBe("frontmatter");
    expect(readFileSync(join(t.pathA, "notes/Planning.md"), "utf8")).toMatch(/related:\n\s+- "?\[\[Jane Doe\]\]"?/);
    expect((await t.a.addLink({ note: "notes/Planning.md", target: "Jane Doe" })).how).toBe("already linked");

    expect((await t.a.addLink({ note: "Reciprocal Rank Fusion", target: "Robot Dog" })).how).toBe("section");
    expect(readFileSync(join(t.pathA, "notes/Reciprocal Rank Fusion.md"), "utf8")).toContain("## Related\n- [[Robot Dog]]");
    // Links resolve in the index afterwards.
    expect((await t.a.related("Robot Dog")).backlinks.map((b: any) => b.path)).toEqual(
      expect.arrayContaining(["notes/Planning.md", "notes/Reciprocal Rank Fusion.md"]),
    );
  });

  it("builds a context pack within budget", async () => {
    const r = await t.a.contextPack("frontier exploration", { budget: 1500 });
    expect(r.sources[0]).toBe("projects/Robot Dog.md");
    expect(r.pack).toContain("# Context: frontier exploration");
    expect(r.pack).toContain("## Robot Dog");
    expect(r.chars).toBeLessThanOrEqual(1500);
  });
});

describe("web app LAN mode", () => {
  let t: TwoDevices;
  let port: number;
  let server: ReturnType<typeof startWebServer>;
  beforeEach(async () => {
    t = twoDevices();
    await t.a.fresh();
    server = startWebServer(t.a, 0, "127.0.0.1", { lanToken: "secret-token-123" });
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  const get = (path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });

  it("requires the token for non-local hosts and swaps it for a cookie", async () => {
    // A Host other than localhost is treated like a remote device.
    expect((await get("/api/status", { host: "192.168.1.20:4567" })).status).toBe(401);
    expect((await get("/api/status", { host: "192.168.1.20:4567", cookie: "brain_token=wrong" })).status).toBe(401);
    const login = await get("/?token=secret-token-123", { host: "192.168.1.20:4567" });
    expect(login.status).toBe(302);
    expect(String(login.headers["set-cookie"])).toMatch(/brain_token=secret-token-123; HttpOnly; SameSite=Strict/);
    const ok = await get("/api/status", { host: "192.168.1.20:4567", cookie: "brain_token=secret-token-123" });
    expect(ok.status).toBe(200);
    // Localhost still works without a token.
    expect((await get("/api/status", { host: `localhost:${port}` })).status).toBe(200);
    expect((await get("/manifest.webmanifest", { host: `localhost:${port}` })).body).toContain("Shannote");
    void readdirSync;
  });
});
