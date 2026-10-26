import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startWebServer } from "../src/web/server.js";
import { twoDevices, type TwoDevices } from "./helpers.js";

let t: TwoDevices;
let server: Server;
let port: number;

beforeEach(async () => {
  t = twoDevices();
  await t.a.fresh();
  // Port 0 = pick a free port. The allowed Host list is built from the port we ask for,
  // so find a free port first, then start on it.
  const probe = startWebServer(t.a, 0);
  await new Promise((r) => probe.once("listening", r));
  const free = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  server = startWebServer(t.a, free);
  await new Promise((r) => server.once("listening", r));
  port = free;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  t.cleanup();
});

function http(path: string, opts: { method?: string; body?: unknown; host?: string; brainHeader?: boolean } = {}) {
  return new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method ?? (data ? "POST" : "GET"),
        headers: {
          host: opts.host ?? `localhost:${port}`,
          ...(data ? { "content-type": "application/json" } : {}),
          ...(opts.brainHeader === false ? {} : { "x-brain": "1" }),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("web app", () => {
  it("serves the UI and status", async () => {
    const ui = await http("/");
    expect(ui.status).toBe(200);
    expect(ui.text).toContain("<title>Shannote</title>");
    const s = await http("/api/status");
    expect(s.json.notes).toBe(7);
  });

  it("renders notes with resolved wikilinks and escaped HTML", async () => {
    const n = await http(`/api/note?path=${encodeURIComponent("notes/Hybrid Search.md")}`);
    expect(n.json.html).toContain('href="#/note/notes%2FReciprocal%20Rank%20Fusion.md"');
    expect(n.json.related.backlinks.map((b: { path: string }) => b.path)).toContain("notes/Reciprocal Rank Fusion.md");
  });

  it("blocks foreign Host headers and POSTs without the app header", async () => {
    expect((await http("/api/status", { host: "evil.example" })).status).toBe(403);
    expect((await http("/api/capture", { body: { text: "x" }, brainHeader: false })).status).toBe(403);
  });

  it("captures and toggles tasks", async () => {
    const c = await http("/api/capture", { body: { text: "from the web" } });
    expect(c.status).toBe(200);
    const tasks = await http("/api/tasks");
    const id = tasks.json.find((x: { text: string }) => x.text === "Order spare battery").id;
    const done = await http("/api/task", { body: { id, done: true } });
    expect(done.json.line).toMatch(/\[x\] Order spare battery/);
    expect((await http("/api/task", { body: { id: "nope", done: true } })).status).toBe(404);
  });
});
