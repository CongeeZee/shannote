import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Brain } from "../core.js";
import { BrainError } from "../util.js";
import { PLAN_KINDS, renderPrompt, type PlanKind } from "../plan/planning.js";
import { renderCurate } from "../curate.js";

export const INSTRUCTIONS = `You are connected to Shannote, Eric's second brain: a markdown vault synced across his devices with git.

- At the start of any conversation that involves his notes, plans, tasks or projects, call brain_begin_session first. It pulls the latest changes and tells you what other devices (other Claude sessions) did and left unfinished.
- Before the conversation ends, or when Eric says "wrap up" / "hand off", call brain_end_session with a summary, decisions, next steps and open questions, so the next session on any device can continue.
- Prefer brain_edit operations (append_to_section, replace_text) over rewriting notes. Read a note before editing it and pass its hash as expected_hash.
- Never invent note contents. When answering from notes, cite their paths.
- For quick thoughts, use brain_capture (goes to the inbox) rather than creating new notes.
- For "plan my day", "how did today go", "weekly review" or "prep me for <meeting>", call brain_plan with kind morning / evening / weekly / meeting and follow the instructions it returns.
- For "triage my inbox" call brain_inbox (action "list", with_instructions true); for "suggest links" call brain_links (action "suggest", with_instructions true); for "give me context on X" call brain_context_pack.`;

type Json = Record<string, unknown> | unknown[];

function ok(data: Json | string) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function fail(e: unknown) {
  const msg = e instanceof BrainError ? `${e.code}: ${e.message}` : `error: ${(e as Error).message}`;
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

/** Wraps a handler so thrown errors become MCP tool errors instead of crashing. */
function handle<A>(fn: (args: A) => Promise<Json | string>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export function createMcpServer(brain: Brain, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "shannote", version }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    "brain_begin_session",
    {
      description:
        "Call first in any conversation about Eric's notes, tasks or plans. Pulls the latest vault from other devices and returns a briefing: recent sessions from all devices (summaries, next steps), open threads, changes made elsewhere, overdue and due-today tasks, and sync health.",
      inputSchema: {},
      annotations: readOnly,
    },
    handle(async () => brain.beginSession()),
  );

  server.registerTool(
    "brain_end_session",
    {
      description:
        "Write a handoff so the next Claude session on any device knows where this one left off. Call when the conversation wraps up. Optionally log progress on threads (ongoing pieces of work).",
      inputSchema: {
        summary: z.string().describe("2-5 sentences: what was done and why"),
        decisions: z.array(z.string()).optional(),
        next_steps: z.array(z.string()).optional(),
        open_questions: z.array(z.string()).optional(),
        threads: z
          .array(
            z.object({
              thread: z.string().describe("Thread slug or title; created if new"),
              note: z.string().optional().describe("One-line progress note"),
              status: z.enum(["open", "waiting", "done"]).optional(),
              description: z.string().optional().describe("Only when creating a thread"),
            }),
          )
          .optional(),
      },
      annotations: write,
    },
    handle(async (a) => brain.endSession(a)),
  );

  server.registerTool(
    "brain_search",
    {
      description:
        "Search notes by meaning and keywords. Default 'hybrid' finds notes that match the words or the idea (e.g. 'memory translation' finds notes on page tables). Use 'keyword' for exact names, codes or quoted phrases; 'semantic' for concepts. Returns paths, titles, snippets (keyword matches marked «like this») and the best-matching section.",
      inputSchema: {
        query: z.string(),
        mode: z.enum(["hybrid", "keyword", "semantic"]).optional(),
        folder: z.string().optional().describe("Limit to a vault folder, e.g. 'Uni/Thesis'"),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: readOnly,
    },
    handle(async (a) => brain.search(a.query, a)),
  );

  server.registerTool(
    "brain_read",
    {
      description:
        "Read a note by path, title or file name. Optionally just one section. Returns content and a hash to pass as expected_hash when editing.",
      inputSchema: {
        note: z.string().describe("Path, title, or [[wikilink]] text"),
        heading: z.string().optional().describe("Return only this section"),
      },
      annotations: readOnly,
    },
    handle(async (a) => brain.read(a.note, a.heading)),
  );

  server.registerTool(
    "brain_create",
    {
      description:
        "Create a new note. Fails if one exists at that path. Use a template ('meeting', 'person', 'project') when it fits. For quick thoughts use brain_capture instead.",
      inputSchema: {
        title: z.string(),
        folder: z.string().optional().describe("Default 'notes'"),
        path: z.string().optional().describe("Full vault path; overrides folder/title"),
        template: z.enum(["meeting", "person", "project"]).optional(),
        content: z.string().optional().describe("Markdown body"),
        frontmatter: z.record(z.string(), z.unknown()).optional().describe("e.g. { tags: ['thesis'] }"),
      },
      annotations: write,
    },
    handle(async (a) => brain.create(a)),
  );

  server.registerTool(
    "brain_edit",
    {
      description:
        "Edit a note with one operation. append / prepend: add text. append_to_section: add to the end of a heading's section. replace_section: replace a section's body (keeps the heading). replace_text: replace an exact snippet that must occur exactly once. set_frontmatter: set keys (null removes).",
      inputSchema: {
        note: z.string(),
        op: z.enum(["append", "prepend", "append_to_section", "replace_section", "replace_text", "set_frontmatter"]),
        text: z.string().optional().describe("For append, prepend, *_section"),
        heading: z.string().optional().describe("For *_section, e.g. 'Plan' or '## Plan'"),
        old_text: z.string().optional().describe("For replace_text"),
        new_text: z.string().optional().describe("For replace_text"),
        fields: z.record(z.string(), z.unknown()).optional().describe("For set_frontmatter"),
        expected_hash: z.string().optional().describe("Hash from brain_read; edit is refused if the note changed"),
      },
      annotations: write,
    },
    handle(async (a) => {
      const need = (k: keyof typeof a) => {
        if (a[k] === undefined) throw new BrainError(`${String(k)} is required for ${a.op}`, "invalid");
        return a[k] as never;
      };
      const op =
        a.op === "append" || a.op === "prepend"
          ? { op: a.op, text: need("text") }
          : a.op === "append_to_section" || a.op === "replace_section"
            ? { op: a.op, heading: need("heading"), text: need("text") }
            : a.op === "replace_text"
              ? { op: a.op, old_text: need("old_text"), new_text: need("new_text") }
              : { op: a.op, fields: need("fields") };
      return brain.edit(a.note, op, a.expected_hash);
    }),
  );

  server.registerTool(
    "brain_move",
    {
      description: "Rename or move a note. Wikilinks pointing to it are updated in other notes.",
      inputSchema: { note: z.string(), new_path: z.string() },
      annotations: write,
    },
    handle(async (a) => brain.move(a.note, a.new_path)),
  );

  server.registerTool(
    "brain_delete",
    {
      description: "Move a note to the trash (_brain/trash). Recoverable. Only when Eric asks.",
      inputSchema: { note: z.string() },
      annotations: { ...write, destructiveHint: true },
    },
    handle(async (a) => brain.delete(a.note)),
  );

  server.registerTool(
    "brain_related",
    {
      description:
        "Backlinks (notes linking here), outgoing links, unresolved links, and similar notes that aren't linked yet (good candidates for new [[links]]).",
      inputSchema: { note: z.string() },
      annotations: readOnly,
    },
    handle(async (a) => brain.related(a.note)),
  );

  server.registerTool(
    "brain_tasks",
    {
      description:
        "Query tasks (`- [ ]` lines) across the vault. Defaults to open tasks sorted by due date. Each task has an id for brain_task_update.",
      inputSchema: {
        status: z.enum(["open", "done", "all"]).optional(),
        overdue: z.boolean().optional(),
        due_before: date.optional(),
        due_after: date.optional(),
        note: z.string().optional().describe("Only tasks in this note"),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: readOnly,
    },
    handle(async (a) => brain.tasks({ ...a, path: a.note })),
  );

  server.registerTool(
    "brain_task_update",
    {
      description: "Complete, reopen, reschedule (due date) or reword a task by id (from brain_tasks or the briefing).",
      inputSchema: {
        id: z.string(),
        done: z.boolean().optional(),
        due: date.nullable().optional().describe("New due date, or null to clear"),
        text: z.string().optional().describe("New task wording (dates are kept)"),
      },
      annotations: write,
    },
    handle(async (a) => brain.taskUpdate(a)),
  );

  server.registerTool(
    "brain_daily",
    {
      description: "Get the daily note for a date (default today), creating it from the template if missing.",
      inputSchema: { date: date.optional(), create: z.boolean().optional() },
      annotations: write,
    },
    handle(async (a) => (await brain.daily(a.date, a.create ?? true)) ?? "No daily note for that date."),
  );

  server.registerTool(
    "brain_capture",
    {
      description: "Append a quick thought, idea or todo to today's inbox for this device. Fast; no need to choose a location.",
      inputSchema: { text: z.string() },
      annotations: write,
    },
    handle(async (a) => brain.capture(a.text)),
  );

  server.registerTool(
    "brain_recent",
    {
      description: "Recent changes from git history across devices (who changed what, when).",
      inputSchema: {
        since: z.string().optional().describe("e.g. '2 days ago' or an ISO date"),
        device: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: readOnly,
    },
    handle(async (a) => brain.recent(a)),
  );

  server.registerTool(
    "brain_threads",
    {
      description: "List threads: ongoing pieces of work that span sessions and devices.",
      inputSchema: { status: z.enum(["active", "open", "waiting", "done", "all"]).optional() },
      annotations: readOnly,
    },
    handle(async (a) => brain.threads(a.status)),
  );

  server.registerTool(
    "brain_thread_update",
    {
      description: "Create a thread, add a progress note to one, or change its status.",
      inputSchema: {
        thread: z.string().describe("Slug or title"),
        note: z.string().optional(),
        status: z.enum(["open", "waiting", "done"]).optional(),
        title: z.string().optional(),
        description: z.string().optional(),
      },
      annotations: write,
    },
    handle(async (a) => brain.threadUpdate(a)),
  );

  server.registerTool(
    "brain_plan",
    {
      description:
        "Start a planning ritual. Returns step-by-step instructions plus the facts needed (calendar, tasks, threads, handoffs, reviews). kind: morning (plan the day), evening (review + roll over), weekly (week review), meeting (prep for a meeting; pass event).",
      inputSchema: {
        kind: z.enum(["morning", "evening", "weekly", "meeting"]),
        date: date.optional().describe("Default today"),
        event: z.string().optional().describe("For meeting: event title (or part of it) or uid"),
      },
      annotations: readOnly,
    },
    handle(async (a) => renderPrompt(a.kind, await brain.planContext(a.kind, { date: a.date, event: a.event }))),
  );

  server.registerTool(
    "brain_rollover_tasks",
    {
      description:
        "Carry unfinished tasks from one day's daily note to another's Plan section (default today → tomorrow). Originals are marked [>] so they aren't counted twice.",
      inputSchema: { from: date.optional(), to: date.optional() },
      annotations: write,
    },
    handle(async (a) => brain.rolloverTasks(a)),
  );

  server.registerTool(
    "brain_calendar",
    {
      description:
        "Events from Eric's calendars (private iCal URLs configured with `brain calendar add`). Returns configured:false if none are set up; then use another calendar tool if you have one.",
      inputSchema: { from: date.optional().describe("Default today"), to: date.optional().describe("Default = from") },
      annotations: readOnly,
    },
    handle(async (a) => brain.events(a.from, a.to ?? a.from)),
  );

  server.registerTool(
    "brain_inbox",
    {
      description:
        "Inbox triage. action 'list': entries waiting to be filed, each with suggested destinations (set with_instructions to get the triage procedure). action 'resolve': file one entry by id — move (append to target note, optional heading), task (as a task; default today's Plan), archive (handled elsewhere), discard. Resolving removes it from the inbox.",
      inputSchema: {
        action: z.enum(["list", "resolve"]),
        with_instructions: z.boolean().optional(),
        id: z.string().optional(),
        resolution: z.enum(["move", "task", "archive", "discard"]).optional(),
        target: z.string().optional().describe("Note for move/task"),
        heading: z.string().optional(),
        text: z.string().optional().describe("Reworded text (default: the entry as captured)"),
        due: date.optional().describe("For task"),
      },
      annotations: write,
    },
    handle(async (a) => {
      if (a.action === "list") {
        const r = await brain.inbox();
        return a.with_instructions ? renderCurate("triage", r) : r;
      }
      if (!a.id || !a.resolution) throw new BrainError("id and resolution are required to resolve", "invalid");
      return brain.inboxResolve({ id: a.id, action: a.resolution, target: a.target, heading: a.heading, text: a.text, due: a.due });
    }),
  );

  server.registerTool(
    "brain_links",
    {
      description:
        "Link upkeep. action 'suggest': for a note (or notes changed in the last N days), plain-text mentions of other notes' titles and similar unlinked notes. action 'add': link note → target; pass line + text from a mention to turn that mention into a [[link]], otherwise it's added to related:/Related.",
      inputSchema: {
        action: z.enum(["suggest", "add"]),
        with_instructions: z.boolean().optional(),
        note: z.string().optional(),
        days: z.number().int().min(1).max(90).optional(),
        target: z.string().optional(),
        line: z.number().int().optional(),
        text: z.string().optional(),
      },
      annotations: write,
    },
    handle(async (a) => {
      if (a.action === "suggest") {
        const r = await brain.linkSuggestions({ note: a.note, days: a.days });
        return a.with_instructions ? renderCurate("links", r) : r;
      }
      if (!a.note || !a.target) throw new BrainError("note and target are required to add a link", "invalid");
      return brain.addLink({ note: a.note, target: a.target, line: a.line, text: a.text });
    }),
  );

  server.registerTool(
    "brain_context_pack",
    {
      description:
        "A compact markdown briefing on a topic from Eric's notes (summaries, matching sections, open tasks, recent decisions), for pasting into another chat or for grounding a long task.",
      inputSchema: { topic: z.string(), limit: z.number().int().min(1).max(15).optional(), budget: z.number().int().min(1000).max(30000).optional() },
      annotations: readOnly,
    },
    handle(async (a) => (await brain.contextPack(a.topic, a)).pack),
  );

  server.registerPrompt(
    "triage_inbox",
    { title: "Triage inbox", description: "File every inbox entry: move, task, new note or discard" },
    async () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: renderCurate("triage", await brain.inbox()) } }] }),
  );
  server.registerPrompt(
    "link_suggestions",
    { title: "Suggest links", description: "Find unlinked mentions and similar notes in recent notes", argsSchema: { note: z.string().optional() } },
    async (args: { note?: string }) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: renderCurate("links", await brain.linkSuggestions({ note: args.note || undefined })) } }],
    }),
  );
  server.registerPrompt(
    "context_pack",
    { title: "Context pack", description: "Gather what Eric's notes say about a topic", argsSchema: { topic: z.string() } },
    async (args: { topic: string }) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: `Here is what my notes say about "${args.topic}". Use it as background for what I ask next.\n\n${(await brain.contextPack(args.topic)).pack}` } }],
    }),
  );

  const promptInfo: Record<PlanKind, { name: string; title: string; description: string }> = {
    morning: { name: "morning_brief", title: "Morning brief", description: "Plan today: schedule, top 3, time blocks" },
    evening: { name: "evening_review", title: "Evening review", description: "Review today and roll unfinished tasks to tomorrow" },
    weekly: { name: "weekly_review", title: "Weekly review", description: "Wins, time spent, stalled work, next week's priorities" },
    meeting: { name: "meeting_prep", title: "Meeting prep", description: "Prepare a meeting note and a 30-second brief" },
  };
  for (const kind of PLAN_KINDS) {
    const info = promptInfo[kind];
    server.registerPrompt(
      info.name,
      {
        title: info.title,
        description: info.description,
        argsSchema:
          kind === "meeting"
            ? { event: z.string().optional().describe("Meeting title or part of it"), date: z.string().optional() }
            : { date: z.string().optional().describe("YYYY-MM-DD, default today") },
      },
      async (args: { date?: string; event?: string }) => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: renderPrompt(kind, await brain.planContext(kind, { date: args.date || undefined, event: args.event || undefined })) },
          },
        ],
      }),
    );
  }

  server.registerResource(
    "today",
    "brain://today",
    { description: "Today's daily note", mimeType: "text/markdown" },
    async (uri) => {
      const d = await brain.daily(undefined, false);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: d?.content ?? "(no daily note yet)" }] };
    },
  );

  return server;
}
