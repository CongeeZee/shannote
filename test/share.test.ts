import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGuest, createSpace, findGuest, joinSpace, listGuests, revokeGuest, type Guest } from "../src/share/spaces.js";
import { startWebServer } from "../src/web/server.js";
import { git, twoDevices, type TwoDevices } from "./helpers.js";

let t: TwoDevices;
let cfg: string;
const saved = process.env.BRAIN_CONFIG_DIR;

beforeEach(async () => {
  cfg = mkdtempSync(join(tmpdir(), "brain-cfg-"));
  process.env.BRAIN_CONFIG_DIR = cfg;
  t = twoDevices();
  await t.a.fresh();
});
afterEach(() => {
  t.cleanup();
  rmSync(cfg, { recursive: true, force: true });
  if (saved === undefined) delete process.env.BRAIN_CONFIG_DIR;
  else process.env.BRAIN_CONFIG_DIR = saved;
});

const log = (cwd: string) => git(cwd, "log", "--format=%an|%s");

describe("editor saves", () => {
  it("writes the whole note, refuses stale saves, and commits after a pause", async () => {
    const note = await t.a.read("Robot Dog");
    const r = await t.a.save({ path: note.path, content: "# Robot Dog\n\nRewritten.\n", expectedHash: note.hash });
    expect(readFileSync(join(t.pathA, note.path), "utf8")).toBe("# Robot Dog\n\nRewritten.\n");

    // A save based on the old version is refused, and the error carries the current text.
    const err = await t.a.save({ path: note.path, content: "stale", expectedHash: note.hash }).catch((e) => e);
    expect(err.code).toBe("conflict");
    expect(err.details.hash).toBe(r.hash);
    expect(err.details.content).toContain("Rewritten.");
    await t.a.save({ path: note.path, content: "forced\n", expectedHash: note.hash, force: true });

    // Not committed yet (typing would make hundreds of commits) until flushed.
    expect(log(t.pathA)).not.toContain("edit projects/Robot Dog.md");
    t.a.flushSaves();
    expect(log(t.pathA).split("\n")[0]).toMatch(/^.+\|edit\(laptop-a\): edit projects\/Robot Dog\.md$/);
  });

  it("only allows paths inside the vault", async () => {
    await expect(t.a.save({ path: "../outside.md", content: "x" })).rejects.toThrow(/outside the vault/);
    await expect(t.a.save({ path: "_brain/config.md", content: "x" })).rejects.toThrow(/managed by the app/);
  });
});

describe("shared spaces", () => {
  it("is its own repo, ignored by the vault repo", async () => {
    const s = createSpace(t.pathA, "Thesis Group", "laptop-a");
    expect(s.dir).toBe("shared/thesis-group");
    expect(existsSync(join(t.pathA, s.dir, ".git"))).toBe(true);
    expect(readFileSync(join(t.pathA, ".gitignore"), "utf8")).toContain("/shared/");
    expect(git(t.pathA, "status", "--porcelain").trim()).toBe(""); // .gitignore change was committed

    const created = await t.a.create({ title: "Reading list", folder: s.dir, content: "- paper one\n" });
    expect(created.path).toBe("shared/thesis-group/Reading list.md");
    expect(log(join(t.pathA, s.dir)).split("\n")[0]).toContain("create shared/thesis-group/Reading list.md");
    expect(log(t.pathA)).not.toContain("Reading list");
    // Indexed and searchable like any note.
    const hits = await t.a.search("paper one");
    expect(hits.results.map((h) => h.path)).toContain(created.path);
  });

  it("syncs between people through the space's own remote", async () => {
    const remote = join(t.root, "space.git");
    git(t.root, "init", "-q", "--bare", "-b", "main", remote);
    const s = createSpace(t.pathA, "Club", "laptop-a");
    git(join(t.pathA, s.dir), "remote", "add", "origin", remote);
    await t.a.create({ title: "Agenda", folder: s.dir, content: "Item one\n" });
    const r = await t.a.syncNow();
    expect(r.spaces[s.dir]?.status).toBe("pushed");

    // Device B joins, edits, syncs back.
    const joined = joinSpace(t.pathB, remote, "Club", "laptop-b");
    expect(joined.dir).toBe("shared/club");
    await t.b.fresh();
    const a = await t.b.read("shared/club/Agenda.md");
    await t.b.save({ path: a.path, content: "Item one\nItem two\n", expectedHash: a.hash, prefix: "guest(Sam)", author: "Sam (guest) <g@x>" });
    await t.b.syncNow();
    expect(git(remote, "log", "-1", "--format=%an|%s")).toBe("Sam (guest)|guest(Sam): edit shared/club/Agenda.md\n");

    await t.a.syncNow();
    expect(readFileSync(join(t.pathA, "shared/club/Agenda.md"), "utf8")).toContain("Item two");
  });
});

describe("guest links", () => {
  it("stores only a hash, finds by token and revokes", () => {
    const { guest, token } = createGuest("club", "Sam");
    expect(readFileSync(join(cfg, "config.json"), "utf8")).not.toContain(token);
    expect(findGuest(token)?.id).toBe(guest.id);
    expect(findGuest(token + "x")).toBeUndefined();
    expect(findGuest(undefined)).toBeUndefined();
    revokeGuest(guest.id);
    expect(findGuest(token)).toBeUndefined();
    expect(listGuests()).toEqual([]);
  });

  describe("web access", () => {
    let server: Server;
    let port: number;
    let token: string;
    let guests: Guest[];
    const PUBLIC = "laptop.example.ts.net";

    beforeEach(async () => {
      createSpace(t.pathA, "Club", "laptop-a");
      await t.a.create({ title: "Agenda", folder: "shared/club", content: "Shared text\n" });
      const g = createGuest("club", "Sam");
      token = g.token;
      guests = [g.guest];
      server = startWebServer(t.a, 0, "127.0.0.1", { guests: () => guests });
      await new Promise((r) => server.once("listening", r));
      port = (server.address() as AddressInfo).port;
    });
    afterEach(async () => {
      await new Promise((r) => server.close(r));
    });

    // Requests through a tunnel (Tailscale Funnel) arrive from localhost with the public Host.
    function http(path: string, opts: { body?: unknown; cookie?: string; host?: string } = {}) {
      return new Promise<{ status: number; json: any; headers: Record<string, unknown> }>((resolve, reject) => {
        const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: data ? "POST" : "GET",
            headers: {
              host: opts.host ?? PUBLIC,
              "x-brain": "1",
              ...(data ? { "content-type": "application/json" } : {}),
              ...(opts.cookie ? { cookie: opts.cookie } : {}),
            },
          },
          (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => {
              let json: unknown;
              try { json = JSON.parse(text); } catch { json = text; }
              resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
            });
          },
        );
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
      });
    }

    it("swaps the link for a cookie and limits the guest to their space", async () => {
      const first = await http(`/?guest=${token}`);
      expect(first.status).toBe(302);
      expect(String(first.headers["set-cookie"])).toContain("HttpOnly");
      const cookie = `shannote_guest=${token}`;

      const me = await http("/api/me", { cookie });
      expect(me.json).toMatchObject({ role: "guest", name: "Sam", space: { slug: "club", dir: "shared/club" } });

      const tree = await http("/api/tree", { cookie });
      expect(tree.json.map((r: { path: string }) => r.path)).toEqual(["shared/club/Agenda.md", "shared/club/README.md"]);

      // Private notes: not readable by path or by title, not writable, not searchable.
      expect((await http(`/api/note?path=${encodeURIComponent("projects/Robot Dog.md")}`, { cookie })).status).toBe(404);
      expect((await http(`/api/note?path=Robot%20Dog`, { cookie })).status).toBe(404);
      expect((await http("/api/note/save", { cookie, body: { path: "projects/Robot Dog.md", content: "pwned" } })).status).toBe(403);
      const s = await http(`/api/search?q=robot&folder=projects`, { cookie });
      expect(s.json.results.every((h: { path: string }) => h.path.startsWith("shared/club/"))).toBe(true);

      // Owner-only features are closed.
      for (const p of ["/api/today", "/api/inbox", "/api/handoffs", "/api/doctor", "/api/status"])
        expect((await http(p, { cookie })).status).toBe(403);
      expect((await http("/api/capture", { cookie, body: { text: "x" } })).status).toBe(403);
      expect((await http("/api/sync", { cookie, body: {} })).status).toBe(403);

      // Their space: read, edit, create. Edits are attributed to them.
      const n = await http(`/api/note?path=${encodeURIComponent("shared/club/Agenda.md")}`, { cookie });
      expect(n.json.content).toContain("Shared text");
      expect(n.json.absPath).toBeUndefined();
      const saved = await http("/api/note/save", { cookie, body: { path: n.json.path, content: "Edited by Sam\n", hash: n.json.hash } });
      expect(saved.status).toBe(200);
      const made = await http("/api/note/create", { cookie, body: { title: "Ideas", folder: "notes" } });
      expect(made.json.path).toBe("shared/club/Ideas.md"); // folder outside the space is ignored
      t.a.flushSaves();
      const spaceLog = log(join(t.pathA, "shared/club"));
      expect(spaceLog).toContain("Sam (guest)|guest(Sam): edit shared/club/Agenda.md");
      expect(spaceLog).toContain("Sam (guest)|guest(Sam): create shared/club/Ideas.md");
    });

    it("rejects revoked or wrong links and read-only guests' writes", async () => {
      const bad = await http("/api/me", { cookie: "shannote_guest=nope" });
      expect(bad.status).toBe(401);
      guests = [];
      expect((await http("/api/me", { cookie: `shannote_guest=${token}` })).status).toBe(401);

      const ro = createGuest("club", "Viewer", { readOnly: true });
      guests = [ro.guest];
      const cookie = `shannote_guest=${ro.token}`;
      expect((await http("/api/me", { cookie })).json.readOnly).toBe(true);
      expect((await http("/api/note/save", { cookie, body: { path: "shared/club/Agenda.md", content: "x" } })).status).toBe(403);
    });

    it("leaves the owner's local app unaffected", async () => {
      const me = await http("/api/me", { host: `localhost:${port}` });
      expect(me.json.role).toBe("owner");
      expect(me.json.spaces.map((s: { slug: string }) => s.slug)).toEqual(["club"]);
      // Without a guest link or LAN token, the public address gets nothing.
      expect((await http("/api/me")).status).toBe(403);
    });
  });
});
