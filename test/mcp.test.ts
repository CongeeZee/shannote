import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { twoDevices, type TwoDevices } from "./helpers.js";

let t: TwoDevices;
let client: Client;

beforeEach(async () => {
  t = twoDevices();
  const server = createMcpServer(t.a);
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(s), client.connect(c)]);
});
afterEach(async () => {
  await client.close();
  t.cleanup();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = r.content[0]!.text;
  return { isError: !!r.isError, text, json: () => JSON.parse(text) };
};

describe("MCP server", () => {
  it("advertises instructions and all tools", async () => {
    expect(client.getInstructions()).toContain("brain_begin_session");
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([
      "brain_begin_session", "brain_calendar", "brain_capture", "brain_context_pack", "brain_create", "brain_daily",
      "brain_delete", "brain_edit", "brain_end_session", "brain_inbox", "brain_links", "brain_move", "brain_plan",
      "brain_read", "brain_recent", "brain_related", "brain_rollover_tasks", "brain_search", "brain_task_update",
      "brain_tasks", "brain_thread_update", "brain_threads",
    ]);
  });

  it("offers planning prompts that embed instructions and context", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "context_pack", "evening_review", "link_suggestions", "meeting_prep", "morning_brief", "triage_inbox", "weekly_review",
    ]);
    const p = await client.getPrompt({ name: "morning_brief", arguments: { date: "2026-10-26" } });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toContain("Morning brief for Eric");
    expect(text).toContain('"weekday": "Monday"');
    const plan = await call("brain_plan", { kind: "evening", date: "2026-10-26" });
    expect(plan.text).toContain("Evening review for Eric");
  });

  it("runs a full session: begin, search, read, edit, end", async () => {
    const brief = (await call("brain_begin_session")).json();
    expect(brief.device).toBe("laptop-a");

    const hits = (await call("brain_search", { query: "frontier" })).json();
    expect(hits.results[0].path).toBe("projects/Robot Dog.md");
    expect(hits.semantic).toBe("unavailable"); // no embedder in this test

    const note = (await call("brain_read", { note: "Robot Dog" })).json();
    const edited = await call("brain_edit", {
      note: note.path, op: "append_to_section", heading: "Navigation", text: "- MCP was here", expected_hash: note.hash,
    });
    expect(edited.isError).toBe(false);

    const end = (await call("brain_end_session", { summary: "Tested MCP", next_steps: ["Ship it"] })).json();
    expect(end.session_log).toContain("_brain/sessions/");
  });

  it("returns tool errors instead of crashing", async () => {
    const r = await call("brain_read", { note: "Does not exist" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^not_found:/);
    const bad = await call("brain_edit", { note: "Robot Dog", op: "replace_text", old_text: "x" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("new_text is required");
  });

  it("serves today's note as a resource", async () => {
    await call("brain_daily", {});
    const r = await client.readResource({ uri: "brain://today" });
    expect((r.contents[0] as { text: string }).text).toContain("## Plan");
  });
});
