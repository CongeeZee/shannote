# second-brain — Specification

> Status: draft v0.1 · 2026-10-26 · Author: Eric (with Claude)

A personal, markdown-based second brain and day-to-day planner designed to be
operated **through an LLM**. The app owns storage, structure, search and sync.
Claude owns reasoning. They talk over the Model Context Protocol (MCP).

---

## 1. Goals and non-goals

### Goals

1. **Second brain** — capture anything quickly, find it later by meaning or by
   exact term, and have related ideas resurface when they matter.
2. **Daily planning** — a daily note that knows today's calendar, due tasks and
   relevant history; morning/evening/weekly review rituals.
3. **LLM-native** — every capability is exposed as an MCP tool or prompt, so any
   Claude client (Desktop, Code, claude.ai) can read and write the vault.
4. **Multi-device continuity** — a Claude on laptop B knows what a Claude on
   laptop A did, decided and left unfinished.
5. **Plain files, owned by Eric** — markdown + YAML frontmatter in a private git
   repo. The app can be deleted and the notes remain fully usable (e.g. in
   Obsidian).
6. **Runs on a Claude subscription** — no Anthropic API key required for normal use.

### Non-goals (for now)

- Building a full editor/UI. Obsidian (or any editor) is the editor until a real
  gap appears. A UI is Phase 6 and optional.
- Multi-user collaboration.
- Real-time sync. Sync is git-based and eventually consistent (seconds–minutes).

---

## 2. Key decisions

| Decision | Choice | Why |
|---|---|---|
| Storage | Markdown files in a **private git repo** ("the vault"), separate from this code repo | Portable, diffable, history = undo |
| Sync | **Git only** (no server) | Free, no infra, Eric's choice |
| LLM | **None inside the app.** Claude reasons via MCP | Works with a Claude subscription; no API key |
| Embeddings | **Local**, in-process (`@huggingface/transformers`, e.g. `bge-small-en-v1.5`) | Free, private, no Ollama needed |
| Index | SQLite (FTS5 + `sqlite-vec`), **per device, not synced** | Derived data; rebuildable; avoids binary merge conflicts |
| Language | TypeScript on Node 22 | Matches Eric's stack and the official MCP SDK |
| Calendar | Phase 1: Claude's **Google Calendar connector**. Later: optional built-in read-only sync | Zero OAuth work up front |
| Code repo | Public, `second-brain` | Portfolio. Vault stays private |

### 2.1 Using a Claude subscription — what works and what doesn't

| Use | Works on subscription? | How |
|---|---|---|
| Chatting with your notes in Claude Desktop / Claude Code | ✅ | Local stdio MCP server registered in the client |
| Morning brief, inbox triage, reviews (when you ask) | ✅ | MCP **prompts** that Claude runs using the tools |
| Scheduled/unattended jobs (e.g. 7am brief) | ⚠️ Partly | Run `claude -p "/morning_brief"` from cron/launchd on a laptop that is awake, using Claude Code's own subscription login. Nothing runs if all devices are asleep |
| Claude on your **phone** using the full tools | ❌ with git-only | claude.ai mobile can only use *remote* MCP servers (public URL). See §7 |
| The app calling Claude directly with your subscription | ❌ | Not supported. Subscription credentials are for Anthropic's own clients. Use an API key if this is ever needed |

**Design rule:** the app never calls an LLM. If a feature appears to need one
(summaries, triage, linking suggestions), it is written as an MCP prompt or a
tool that returns candidates for Claude to decide on.

---

## 3. Architecture

```
┌───────────────────────── Device (each laptop) ─────────────────────────┐
│                                                                         │
│  Claude Desktop / Claude Code ──stdio MCP──►  brain (Node process)     │
│        │                                      ├─ MCP server (tools,     │
│        └─ Google Calendar connector           │   prompts, resources)   │
│                                               ├─ Vault lib (parse md,   │
│  Obsidian / any editor ──edits files──┐       │   links, tasks, fm)     │
│                                       ▼       ├─ Indexer (watcher →     │
│                              ~/vault (git) ◄──┤   SQLite FTS + vectors) │
│                                       │       └─ Sync (git pull/commit/ │
│                                       │           push, conflicts)      │
└───────────────────────────────────────┼─────────────────────────────────┘
                                        ▼
                         GitHub private repo: <you>/vault
                                        ▲
                     Phone: Obsidian mobile + git, or Working Copy (iOS)
```

### 3.1 Components

- **vault** — reads/writes markdown, parses frontmatter (`gray-matter`), wikilinks,
  tags, headings and tasks (`remark`/`mdast`). Pure functions, heavily tested.
- **indexer** — watches the vault (`chokidar`), keeps `.brain-cache/index.db`
  current: notes, headings, links, tags, tasks, FTS5 table, embedding vectors
  per chunk (chunked by heading, ~300–500 tokens). Full rebuild via
  `brain index --rebuild`.
- **search** — hybrid: BM25 (FTS5) + vector similarity, merged with reciprocal
  rank fusion. Filters: folder, tag, date range, type.
- **sync** — wraps git. Pull before reads (debounced), commit after every write,
  push in the background (debounced). Conflict handling in §5.4.
- **mcp** — `@modelcontextprotocol/sdk` server over stdio. Tools in §6, prompts in §6.3.
- **cli** — `brain init | serve | index | sync | doctor | status`.

### 3.2 Tech stack

Node 22, TypeScript (strict), `@modelcontextprotocol/sdk`, `zod`,
`better-sqlite3` + `sqlite-vec`, `@huggingface/transformers`, `chokidar`,
`gray-matter`, `unified`/`remark-parse`, `simple-git` (or shelling out to `git`),
`vitest`, `tsup`.

---

## 4. Vault layout and conventions

```
vault/
├── inbox/                      # quick capture, one file per device per day
│   └── 2026-10-26-laptop-home.md
├── daily/                      # one per day
│   └── 2026-10-26.md
├── notes/                      # evergreen / topic notes (flat or nested, free-form)
├── projects/                   # one note per active project
├── people/                     # one note per person
├── meetings/                   # 2026-10-26-thesis-sync.md
├── _brain/                     # app-managed, still human-readable
│   ├── sessions/2026/10/       # session handoff logs (append-only, §5)
│   ├── threads/                # open threads, one file each (§5)
│   ├── templates/              # daily.md, meeting.md, person.md, project.md
│   ├── trash/                  # soft-deleted notes
│   └── config.yml              # vault settings (timezone, folders, devices)
├── .gitattributes              # merge=union for inbox/ and _brain/sessions/
└── .gitignore                  # .brain-cache/, .obsidian/workspace*
```

### 4.1 Note format

```markdown
---
id: 01JB8Z3K4M        # ULID, stable across renames
title: Thesis scope
type: note            # note | daily | project | person | meeting | thread | session
tags: [thesis]
created: 2026-10-26T14:30:00+11:00
updated: 2026-10-26T15:02:00+11:00
updated_by: claude@laptop-home   # or eric@phone, eric@laptop-home
---

# Thesis scope

Body. Links like [[Jane Doe]] and [[projects/robot-dog]].

- [ ] Draft lit review outline 📅 2026-10-31 #thesis
```

- **Tasks** use Obsidian Tasks syntax (`- [ ]`, `📅 due`, `⏳ scheduled`,
  `✅ done date`, `🔁 recurrence`), so they also work in Obsidian.
- **Provenance**: `updated_by` records who last wrote the note. Sections added
  by Claude can optionally be wrapped with `<!-- ai -->…<!-- /ai -->`. Off by
  default; configurable.

---

## 5. Multi-device continuity

Two problems: **(a) the files** must converge across devices, and **(b) the
Claudes** on each device must know what the others did.

### 5.1 Device identity

`brain init` asks for a device name (`laptop-home`, `laptop-uni`, `phone`) and
stores it in `~/.config/second-brain/device.json` (not in the vault).
Every commit, session log and `updated_by` field carries it.

### 5.2 Session handoff protocol

A **session** is one Claude conversation that used the vault.

**Start — `brain_begin_session`** (Claude is told to call this first via the MCP
server `instructions` field):

1. `git pull --rebase` (with timeout; works offline and reports staleness).
2. Returns a compact briefing (< ~1.5k tokens):
   - the last 3–5 **session logs across all devices** (summary, decisions, next steps)
   - **open threads** (status `open`/`waiting`), sorted by last touched
   - **recent changes** by other devices since this device last synced
     (from `git log`: files + one-line commit summaries)
   - today's daily note highlights and overdue tasks
   - sync health: unpushed commits, conflicts awaiting review, last pull time

**End — `brain_end_session`** (Claude calls it when the conversation wraps up, or
when Eric says "hand off" / "wrap up"):

Writes `_brain/sessions/YYYY/MM/<ISO-time>-<device>-<shortid>.md`:

```markdown
---
type: session
device: laptop-home
client: claude-desktop
started: 2026-10-26T14:30:00+11:00
ended: 2026-10-26T15:10:00+11:00
touched: [notes/thesis-scope.md, daily/2026-10-26.md]
threads: [thesis-lit-review]
---
## Summary
Narrowed thesis scope to a single research question.
## Decisions
- Use approach A over approach B.
## Next steps
- [ ] Email supervisor the revised scope
## Open questions
- Which dataset does the lab already have?
```

Then commits and pushes immediately (not debounced).

Each session is a **new file with a unique name**, so two devices can never
conflict on handoffs.

### 5.3 Threads

A **thread** is a unit of ongoing work that spans sessions or devices ("thesis
lit review", "internship applications"). One file per thread in
`_brain/threads/<slug>.md`, with frontmatter `status: open | waiting | done`,
`last_touched`, `last_device`, and a short running log appended at the end of
each session. One-file-per-thread keeps conflicts rare and local.

Tools: `brain_threads` (list/filter), `brain_thread_update` (append log entry,
change status).

### 5.4 Sync and conflict handling

- **Pull**: on `begin_session`, before any read if more than 60s since the last pull,
  and every 5 min while the server runs.
- **Commit**: after every write tool, message `brain(<device>): <tool> <path>`.
- **Push**: debounced 10s after the last commit, plus immediately on `end_session`.
- **Edits made outside Claude** (Obsidian): the watcher sees them. `brain sync`
  (or the next tool call) commits them as `edit(<device>): <paths>`.
- **Append-only files** (`inbox/*`, `_brain/sessions/*`) use
  `.gitattributes merge=union`, so concurrent appends merge cleanly.
- **Real conflicts** (the same note edited on two devices offline): the sync layer
  never leaves conflict markers in a note. It keeps the local version at the original path, writes the
  remote version to `<name>.conflict-<device>-<timestamp>.md`, commits both,
  and lists the conflict in the next `begin_session` briefing. Claude then helps
  merge and deletes the copy.
- **Offline**: everything works locally. Pushes queue up, and the briefing shows
  "N unpushed commits".
- The index is **never** synced. Each device indexes its own checkout.

### 5.5 Why not a sync server?

Eric chose git-only. Known costs, accepted for now:
- No phone MCP (see §7).
- Scheduled jobs only run on an awake laptop.
- Two devices editing the same note offline produces conflict copies.

The code keeps sync behind an interface (`SyncProvider`), so a hosted hub
(§9 Phase 7) can be added without touching the tools.

---

## 6. MCP interface

Keep the tool count small and the descriptions precise. Tool choice quality
depends on it. All tools take/return JSON. Paths are vault-relative.

### 6.1 Tools

| Tool | Purpose | Writes? |
|---|---|---|
| `brain_begin_session` | Pull, return briefing (§5.2) | no |
| `brain_end_session` | Write session log, update threads, push | yes |
| `brain_search` | Hybrid search. Args: `query`, `mode` (hybrid/keyword/semantic), `filters`, `limit`. Returns snippets + path + heading + score | no |
| `brain_read` | Read a note by path, title or id. Optional `heading` to read one section | no |
| `brain_create` | Create a note from optional template. Fails if path exists | yes |
| `brain_edit` | Edit operations: `append`, `prepend`, `append_to_section`, `replace_section`, `replace_text` (requires exact `old_text`, must match once), `set_frontmatter` | yes |
| `brain_move` | Rename/move a note and rewrite inbound links | yes |
| `brain_delete` | Soft delete to `_brain/trash/` | yes |
| `brain_related` | Backlinks, outgoing links, and semantic neighbours (not yet linked) for a note | no |
| `brain_tasks` | Query tasks: status, due range, overdue, tag, project, path | no |
| `brain_task_update` | Complete, reopen, reschedule, or edit a task by stable task id | yes |
| `brain_daily` | Get (or create from template) the daily note for a date | maybe |
| `brain_capture` | Append text to this device's inbox file for today | yes |
| `brain_recent` | Recent changes across devices (git log), filterable by device/path/time | no |
| `brain_threads` | List/filter threads | no |
| `brain_thread_update` | Create a thread, append a log entry, change status | yes |

**Write safety rules**
- No tool can delete note content except `replace_section`/`replace_text`, both of which
  require the caller to state what is being replaced.
- Every write is its own commit, so `git revert` is the undo button.
- `brain_edit` refuses if the note changed on disk since Claude last read it
  (optimistic concurrency via content hash returned by `brain_read`).

### 6.2 Resources

- `brain://today` — today's daily note
- `brain://note/{path}` — any note
- `brain://briefing` — same content as `begin_session`, for clients that prefer resources

### 6.3 Prompts (the "intelligence" layer, run by Claude)

| Prompt | What Claude does |
|---|---|
| `morning_brief` | Read calendar (connector) + tasks + threads + recent sessions. Write a "Plan" section into today's daily note: schedule, top 3 priorities, time blocks, prep notes per meeting from past notes |
| `evening_review` | Compare plan vs done. Roll unfinished tasks forward. Append "Review" section. End session |
| `weekly_review` | Time spent (calendar) vs stated priorities, stalled threads/projects, neglected notes, wins. Writes `daily/YYYY-Www-review.md` |
| `triage_inbox` | Propose where each inbox item goes, links, tags, extracted tasks. **Shows the proposal and waits for approval**, then applies it |
| `link_suggestions` | For a note or the week's notes: propose `[[links]]` from `brain_related` neighbours |
| `context_pack` | Given a topic, assemble a compact brief (key notes, decisions, open questions) for use in another chat or tool |
| `meeting_prep` | For an upcoming event: create/open meeting note, pull history with attendees/project |

### 6.4 Server instructions (sent to every client)

> You are connected to Eric's second brain. At the start of any conversation
> that involves his notes, plans, tasks or projects, call `brain_begin_session`
> first. Before ending, or when Eric says "wrap up"/"hand off", call
> `brain_end_session` with a summary, decisions, next steps and open questions.
> Prefer `brain_edit` operations over rewriting whole notes. Never invent note
> contents. Cite note paths when answering from notes.

---

## 7. Phone

With git-only sync, the phone is a **capture and viewing** device, not a full
Claude-with-tools device.

- **Android**: Obsidian mobile + Obsidian Git plugin (auto pull/push).
- **iOS**: Working Copy (git client) + Obsidian pointed at the Working Copy
  folder, or Working Copy's editor directly. The Obsidian Git plugin on iOS is
  unreliable for larger vaults.
- Capture goes to `inbox/<date>-phone.md` (union-merged).
- Claude mobile app: can read the vault via the **GitHub connector** on claude.ai
  (read-only, no tools). Good for "what's on today?" questions, not for edits.

**Limitation (stated plainly):** full Claude-with-tools on the phone requires a remote
MCP endpoint, which requires a server. That's Phase 7, if wanted.

---

## 8. Calendar

- **Phase 1–4**: no calendar code. Prompts instruct Claude to use its Google
  Calendar connector (already connected on Eric's account) alongside the brain
  tools. Event → meeting note linking is done by Claude writing
  `event_id` / `event_start` into meeting-note frontmatter.
- **Later (optional)**: `brain calendar sync` pulls a read-only window (−7 to +14
  days) via Google Calendar API or a private ICS URL into `.brain-cache`, so
  `begin_session` and scheduled `claude -p` runs see events without relying on
  connector availability. OAuth tokens live in `~/.config/second-brain/`, never in the vault.

---

## 9. Phased build plan

Each phase ends with something Eric uses daily for about a week before moving on.

| Phase | Deliverable | Done when |
|---|---|---|
| **0** | Repo, spec, tooling (lint, test, build, CI) | `npm test` green in CI |
| **1** | `vault` lib + `indexer` (FTS only) + CLI `init/index/status`. Templates. | Can index a real vault of 500+ notes in < 5s; parser tests pass |
| **2** | MCP server: read/search/create/edit/tasks/daily/capture + git sync + **session handoff + threads** | Two laptops: a session on one is visible in `begin_session` on the other |
| **3** | Local embeddings + hybrid search + `brain_related` | Semantic queries find notes with no keyword overlap |
| **4** | Planning prompts (`morning_brief`, `evening_review`, `weekly_review`, `meeting_prep`) + optional scheduled `claude -p` runner | Eric's daily note is produced from the morning brief for a week |
| **5** | Second-brain prompts (`triage_inbox`, `link_suggestions`, `context_pack`), phone capture setup guide | Inbox reaches zero via triage |
| **6** | (Optional) UI: local web app — today view, tasks, inbox, search | Only if a concrete gap in Obsidian is identified |
| **7** | (Optional) Hosted hub: remote MCP endpoint (auth), server-side scheduled jobs, phone Claude access | Only if git-only limits bite |

---

## 10. Testing

- **Unit**: parser (frontmatter, links, tasks, headings), edit operations, task ids.
- **Golden files**: fixture vault in `test/fixtures/vault`. Edits are snapshot-tested.
- **Sync**: integration tests with two clones of a bare repo in a temp dir to
  simulate two devices, including offline divergence and conflict-copy behaviour.
- **MCP**: in-memory client from the SDK calling each tool against the fixture vault.
- **Eval (later)**: a handful of scripted conversations checking that Claude picks
  the right tools (description quality regression).

---

## 11. Risks and open questions

1. **Claude forgetting to call `end_session`.** Mitigations: server instructions;
   an automatic "implicit session" log written from the commit list when the MCP
   process exits without a handoff; `begin_session` shows "previous session on
   laptop-uni ended without a handoff, touched X, Y".
2. **Git conflicts from editing in Obsidian and Claude at the same time** on one
   device: same working tree, so no git conflict. The content-hash check in
   `brain_edit` prevents Claude overwriting a fresh manual edit.
3. **Embedding model size** (~130MB for bge-small) downloaded per device on first
   run. Acceptable. Configurable to a smaller model.
4. **Subscription limits**: heavy prompts (weekly review over many notes) consume
   usage. Tools return snippets, not whole notes, by default.
5. **Public code repo**: no personal data, tokens or vault contents in this repo.
   Fixtures are synthetic.
6. **Open**: how does Claude Code headless (`claude -p`) pick up the Google Calendar
   connector for scheduled briefs? Verify in Phase 4. Fallback: built-in calendar sync (§8).
7. **Open**: Obsidian vs this app's conventions drift. Keep conventions compatible
   with Obsidian core + Tasks plugin.

---

## 12. Client setup (target)

```jsonc
// Claude Desktop: claude_desktop_config.json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["-y", "second-brain", "serve"],
      "env": { "BRAIN_VAULT": "/Users/you/vault" }
    }
  }
}
```

```bash
# Claude Code
claude mcp add brain --scope user -- npx -y second-brain serve
```
