import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startWebServer } from "../src/web/server.js";
import { twoDevices, type TwoDevices } from "./helpers.js";

// Stands in for `claude -p --output-format stream-json`: echoes what it was given, so tests
// can check the flags, and behaves differently for a few magic prompts.
const FAKE_CLAUDE = `#!/usr/bin/env node
let prompt = "";
process.stdin.on("data", (d) => (prompt += d)).on("end", async () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  const args = process.argv.slice(2);
  if (prompt === "fail") { process.stderr.write("Error: not logged in\\n"); process.exit(1); }
  const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
  out({ type: "system", subtype: "init", session_id: resume ?? "sess-12345678" });
  if (prompt === "slow") await new Promise((r) => setTimeout(r, 3000));
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "You said: " + prompt } } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__shannote__brain_search", input: { query: "page tables" } }] } });
  out({ type: "stream_event", event: { type: "message_start" } });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: JSON.stringify({ args, key: process.env.ANTHROPIC_API_KEY ?? null }) } } });
  out({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1793512200 }, seven_day: { utilization: 0.06, resetsAt: 1793977200 } } } });
  out({ type: "result", subtype: "success", is_error: false, session_id: resume ?? "sess-12345678", num_turns: 2 });
});
`;

let t: TwoDevices;
let server: Server;
let port: number;
let dir: string;

async function start(claudeBin: string | null) {
  const probe = startWebServer(t.a, 0, "127.0.0.1", { claudeBin });
  await new Promise((r) => probe.once("listening", r));
  const free = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  server = startWebServer(t.a, free, "127.0.0.1", { claudeBin, cliPath: "/opt/shannote/cli.js" });
  await new Promise((r) => server.once("listening", r));
  port = free;
}

beforeEach(async () => {
  t = twoDevices();
  await t.a.fresh();
  dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  process.env.BRAIN_CACHE_DIR = dir; // keeps the usage file out of the real cache
  process.env.ANTHROPIC_API_KEY = "sk-should-not-reach-claude";
  await start(bin);
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.BRAIN_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  t.cleanup();
});

function http(path: string, body?: unknown) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { host: "127.0.0.1", port, path, method: data ? "POST" : "GET", headers: { host: `localhost:${port}`, "x-brain": "1", ...(data ? { "content-type": "application/json" } : {}) } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const events = (text: string) => text.trim().split("\n").map((l) => JSON.parse(l));

describe("dashboard chat (Claude Code)", () => {
  it("streams text, tool calls, usage and the session id", async () => {
    const r = await http("/api/claude", { prompt: "what's due?" });
    expect(r.status).toBe(200);
    const ev = events(r.text);
    expect(ev[0]).toEqual({ type: "session", id: "sess-12345678" });
    expect(ev).toContainEqual({ type: "text", text: "You said: what's due?" });
    expect(ev).toContainEqual({ type: "tool", name: "brain_search", detail: "page tables" });
    expect(ev).toContainEqual({ type: "text", text: "\n\n" });
    expect(ev.find((e) => e.type === "usage").usage.fiveHour.utilization).toBe(0.25);
    expect(ev.at(-1)).toMatchObject({ type: "done", session: "sess-12345678", turns: 2 });
    // Usage is remembered for the meter.
    expect(JSON.parse((await http("/api/claude")).text).usage.sevenDay.utilization).toBe(0.06);
  });

  it("gives Claude only the Shannote tools, on the subscription", async () => {
    const r = await http("/api/claude", { prompt: "hi" });
    const echoed = JSON.parse(events(r.text).filter((e) => e.type === "text").at(-1).text);
    const args: string[] = echoed.args;
    expect(echoed.key).toBeNull(); // API keys are dropped
    expect(args[args.indexOf("--tools") + 1]).toBe(""); // no shell or file tools
    const allowed = args[args.indexOf("--allowedTools") + 1]!.split(",");
    expect(allowed[0]).toBe("mcp__shannote");
    // Google is read-only, except that the chat (where the user is asking) may add calendar events.
    const writes = allowed.filter((t) => t !== "mcp__shannote" && !/__(list|search|get)_\w+$/.test(t));
    expect(writes).toEqual(["mcp__claude_ai_Google_Calendar__create_event"]);
    expect(allowed.some((t) => /send|draft|update|delete|respond/.test(t))).toBe(false);
    const denied = args[args.indexOf("--disallowedTools") + 1]!.split(",");
    expect(denied).toEqual(expect.arrayContaining(["mcp__claude_ai_Google_Calendar__update_event", "mcp__claude_ai_Google_Calendar__delete_event"]));
    expect(denied).not.toContain("mcp__claude_ai_Google_Calendar__create_event");
    expect(denied).toEqual(expect.arrayContaining(["mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Gmail__reply", "mcp__claude_ai_Gmail__forward", "mcp__claude_ai_Gmail__trash_thread"]));
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
    expect(mcp.mcpServers.shannote.args).toEqual(["/opt/shannote/cli.js", "--vault", t.pathA, "serve", "--client", "dashboard"]);
    expect(args).not.toContain("hi"); // the prompt goes in on stdin
  });

  it("asks for short spoken answers when the question was spoken", async () => {
    const sys = async (body: object) => {
      const args: string[] = JSON.parse(events((await http("/api/claude", body)).text).filter((e) => e.type === "text").at(-1).text).args;
      return args[args.indexOf("--append-system-prompt") + 1]!;
    };
    expect(await sys({ prompt: "hi", voice: true })).toContain("read aloud");
    expect(await sys({ prompt: "hi" })).not.toContain("read aloud");
  });

  it("continues a conversation with --resume", async () => {
    const r = await http("/api/claude", { prompt: "and tomorrow?", session: "sess-abcdef12" });
    const ev = events(r.text);
    expect(ev[0]).toEqual({ type: "session", id: "sess-abcdef12" });
    // A malformed session id is ignored rather than passed to the CLI.
    const bad = events((await http("/api/claude", { prompt: "x", session: "--dangerous" })).text);
    expect(bad[0]).toEqual({ type: "session", id: "sess-12345678" });
  });

  it("runs one chat at a time, and Stop ends it", async () => {
    const slow = http("/api/claude", { prompt: "slow" });
    await new Promise((r) => setTimeout(r, 300));
    expect((await http("/api/claude", { prompt: "again" })).status).toBe(409);
    expect(JSON.parse((await http("/api/claude")).text).running).toBe(true);
    await http("/api/claude/stop", {});
    const ev = events((await slow).text);
    expect(ev.at(-1)).toEqual({ type: "error", message: "Stopped." });
    expect((await http("/api/claude", { prompt: "after" })).status).toBe(200);
  });

  it("refreshes the limits with a tiny run", async () => {
    const r = await http("/api/claude/usage/refresh", {});
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).usage).toMatchObject({ fiveHour: { utilization: 0.25 }, sevenDay: { utilization: 0.06 } });
    expect(JSON.parse((await http("/api/claude")).text).usage.fiveHour.resetsAt).toBe(new Date(1793512200 * 1000).toISOString());
  });

  it("reports Claude Code's own errors", async () => {
    const ev = events((await http("/api/claude", { prompt: "fail" })).text);
    expect(ev.at(-1)).toEqual({ type: "error", message: "Error: not logged in" });
  });

  it("is off when Claude Code isn't installed", async () => {
    await new Promise((r) => server.close(r));
    await start(null);
    expect(JSON.parse((await http("/api/claude")).text).available).toBe(false);
    expect((await http("/api/claude", { prompt: "hi" })).status).toBe(503);
  });
});

describe("projects", () => {
  it("groups project folders and counts their open tasks", async () => {
    await t.a.create({ title: "COMP9999 - Compilers", folder: "uni/COMP9999 Compilers", content: "- [ ] Lab 1 📅 2026-11-04\n- [ ] Lab 2 📅 2026-11-02\n- [x] Lab 0" });
    await t.a.create({ title: "week 1", folder: "uni/COMP9999 Compilers/notes", content: "Lexing." });
    await t.a.create({ title: "Loose", folder: "uni", content: "Not a project." });
    const r = await t.a.projects();
    const course = r.find((p) => p.path === "uni/COMP9999 Compilers")!;
    expect(course).toMatchObject({ name: "COMP9999 Compilers", notes: 2, openTasks: 2, nextDue: "2026-11-02", hub: "uni/COMP9999 Compilers/COMP9999 - Compilers.md" });
    expect(r.find((p) => p.path === "projects/Robot Dog.md")).toMatchObject({ name: "Robot Dog", hub: "projects/Robot Dog.md" });
    expect(r.some((p) => p.path.startsWith("uni/Loose") || p.path.startsWith("daily") || p.path.startsWith("notes"))).toBe(false);
  });
});

describe("usage history", () => {
  const day = (offset: number, hour = 12) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(hour, 0, 0, 0); return d; };
  const reply = (id: string, when: Date, output: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "assistant", timestamp: when.toISOString(), sessionId: "s1", cwd: "/work/alpha", message: { id, model: "claude-test-1", usage: { input_tokens: 3, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } }, ...extra });

  it("totals tokens per day, counting each reply once", async () => {
    const { usageHistory } = await import("../src/agent/usage.js");
    const root = join(dir, "projects");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, "-work-alpha"), { recursive: true });
    writeFileSync(join(root, "-work-alpha", "a.jsonl"), [
      reply("m1", day(0), 50), reply("m1", day(0), 50), // same reply logged per content block
      reply("m2", day(-2), 20, { sessionId: "s2", cwd: "/work/beta" }),
      JSON.stringify({ type: "user", timestamp: day(0).toISOString(), message: { content: "hi" } }),
      reply("m3", day(0), 0, { message: { id: "m3", model: "<synthetic>", usage: { output_tokens: 0 } } }),
      reply("old", day(-40), 999),
      "not json",
    ].join("\n"));
    const h = await usageHistory(7, root);
    expect(h.days).toHaveLength(7);
    expect(h.days.at(-1)).toMatchObject({ messages: 1, output: 50, input: 3, cacheRead: 100, cacheWrite: 10, sessions: 1 });
    expect(h.days.at(-3)).toMatchObject({ messages: 1, output: 20 });
    expect(h.totals).toMatchObject({ messages: 2, output: 70, sessions: 2 });
    expect(h.models).toEqual([{ model: "claude-test-1", messages: 2, output: 70 }]);
    expect(h.projects.map((p) => p.project)).toEqual(["alpha", "beta"]);
  });

  it("is served at /api/claude/usage", async () => {
    process.env.CLAUDE_CONFIG_DIR = join(dir, "no-claude-here");
    try {
      const r = JSON.parse((await http("/api/claude/usage?days=7")).text);
      expect(r.days).toHaveLength(7);
      expect(r.totals.messages).toBe(0);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
});

describe("scheduled briefs", () => {
  it("can't add calendar events: unattended runs stay read-only", async () => {
    const { runClaude } = await import("../src/agent/claude.js");
    const seen: string[] = [];
    await runClaude({ prompt: "hi", vault: t.pathA, node: process.execPath, cli: "/x/cli.js", bin: join(dir, "claude"), client: "scheduled", onEvent: (e) => { if (e.type === "text") seen.push(e.text); } }).done;
    const args: string[] = JSON.parse(seen.at(-1)!).args;
    expect(args[args.indexOf("--allowedTools") + 1]).not.toContain("create_event");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("mcp__claude_ai_Google_Calendar__create_event");
  });

  it("writes a systemd timer that catches up after sleep and skips briefs already written", async () => {
    const { units, parseTime } = await import("../src/agent/schedule.js");
    expect(parseTime("7:30")).toBe("07:30");
    expect(() => parseTime("25:00")).toThrow(/24-hour/);
    const u = units({ kind: "morning", time: "07:30", node: "/usr/bin/node", cli: "/opt/my app/cli.js", vault: "/home/x/vault", log: "/tmp/s.log" });
    expect(u.timer).toContain("OnCalendar=*-*-* 07:30:00");
    expect(u.timer).toContain("Persistent=true");
    expect(u.service).toContain('ExecStart=/usr/bin/node "/opt/my app/cli.js" --vault /home/x/vault brief morning --if-missing');
    expect(u.service).toContain("StandardOutput=append:/tmp/s.log");
  });
});

describe("Claude's voice (Kokoro)", () => {
  it("encodes Kokoro's samples as 16-bit mono WAV", async () => {
    const { toWav } = await import("../src/agent/tts.js");
    const wav = toWav(new Float32Array([0, 1, -1, 2, 0.5]), 24000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(10);
    expect([0, 1, 2, 3, 4].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([0, 32767, -32767, 32767, 16384]); // clipped, scaled
  });

  it("offers a British male and a British female voice", async () => {
    const r = JSON.parse((await http("/api/tts")).text);
    expect(r.voices.map((v: { id: string }) => v.id)).toEqual(["bm_fable", "bf_emma"]);
    expect(typeof r.available).toBe("boolean");
  });
});
