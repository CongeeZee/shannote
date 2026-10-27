# Shannote — Specification

> Status: draft v0.6 · 2026-10-26 · Phases 1–5 built (4–5 awaiting real use) · Author: Eric (with Claude)

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

- ~~Building a full editor.~~ Changed in Phase 6 at Eric's request: the web app has a
  markdown editor (live preview, optional vim keys). Obsidian still works on the same files.
- ~~Multi-user collaboration.~~ Changed in Phase 6: shared spaces (separate git repos)
  and guest links. Still no real-time co-editing (see §18).
- Real-time sync. Sync is git-based and eventually consistent (seconds–minutes).

---

## 2. Key decisions

| Decision | Choice | Why |
|---|---|---|
| Storage | Markdown files in a **private git repo** ("the vault"), separate from this code repo | Portable, diffable, history = undo |
| Sync | **Git only** (no server) | Free, no infra, Eric's choice |
| LLM | **None inside the app.** Claude reasons via MCP | Works with a Claude subscription; no API key |
| Embeddings | **Local**, in-process (`@huggingface/transformers`, e.g. `bge-small-en-v1.5`) | Free, private, no Ollama needed |
| Index | SQLite (FTS5 + `sqlite-vec`), **per device, not synced**, stored in `~/.cache/shannote/<vault-hash>/index.db` | Derived data; rebuildable; kept outside the vault so it never reaches git or Obsidian |
| Language | TypeScript on Node 22 | Matches Eric's stack and the official MCP SDK |
| Calendar | Phase 1: Claude's **Google Calendar connector**. Later: optional built-in read-only sync | Zero OAuth work up front |
| Code repo | Public, `shannote` | Portfolio. Vault stays private |

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
- **indexer** — watches the vault (`chokidar`), keeps the index (`~/.cache/shannote/<vault-hash>/index.db`, outside the vault)
  current: notes, headings, links, tags, tasks, FTS5 table, embedding vectors
  per chunk (chunked by heading, ~300–500 tokens). Full rebuild via
  `brain index --rebuild`.
- **search** — hybrid: BM25 (FTS5) + vector similarity, merged with reciprocal
  rank fusion. Filters: folder, tag, date range, type.
- **sync** — wraps git. Pull before reads (debounced), commit after every write,
  push in the background (debounced). Conflict handling in §5.4.
- **mcp** — `@modelcontextprotocol/sdk` server over stdio. Tools in §6, prompts in §6.3.
- **cli** — `brain init | serve | index | search | sync | doctor | status`.

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
stores it in `~/.config/shannote/device.json` (not in the vault).
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

> You are connected to Shannote, Eric's second brain. At the start of any conversation
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
- **Built in Phase 4**: read-only calendars from private iCal URLs (`brain calendar add`),
  see §15. The original plan below is kept for reference.
- **Originally planned**: `brain calendar sync` pulls a read-only window (−7 to +14
  days) via Google Calendar API or a private ICS URL into the per-device cache directory, so
  `begin_session` and scheduled `claude -p` runs see events without relying on
  connector availability. OAuth tokens live in `~/.config/shannote/`, never in the vault.

---

## 9. Phased build plan

Each phase ends with something Eric uses daily for about a week before moving on.

| Phase | Deliverable | Done when |
|---|---|---|
| **0** | Repo, spec, tooling (lint, test, build, CI) | `npm test` green in CI |
| **1** ✅ | `vault` lib + `indexer` (FTS only) + CLI `init/index/status/search/doctor`. Templates. | Can index a real vault of 500+ notes in < 5s; parser tests pass. *Met: 1,000 notes in < 1s; 148-note real vault in ~0.35s.* |
| **2** ✅ | MCP server: read/search/create/edit/tasks/daily/capture + git sync + **session handoff + threads**. Plus local web app (`brain web`). | Two laptops: a session on one is visible in `begin_session` on the other. *Met: covered by `test/sync.test.ts` with two clones of a bare remote.* |
| **3** ✅ | Local embeddings + hybrid search + `brain_related` | Semantic queries find notes with no keyword overlap. *Met: real-model test in `test/semantic.test.ts`; on Eric's 148-note vault, "keeping data consistent after a crash" finds the journalling notes.* |
| **4** 🟡 | Planning prompts (`morning_brief`, `evening_review`, `weekly_review`, `meeting_prep`) + optional scheduled `claude -p` runner | Eric's daily note is produced from the morning brief for a week. *Built and tested; the week of real use hasn't happened yet.* |
| **5** 🟡 | Second-brain prompts (`triage_inbox`, `link_suggestions`, `context_pack`), phone capture setup guide | Inbox reaches zero via triage. *Built (incl. web Inbox page and `brain web --lan` for phones); needs real use.* |
| **6** 🟡 | Web app, round 2: **note editor** (live preview, vim keys, conflict-safe autosave, new notes) ✅, **shared spaces + guest links** ✅; graph view and calendar strip still to do | Eric edits in the app instead of Obsidian, and shares at least one space. *Started before 4–5 had their week of use, because Eric asked for editing and sharing.* |
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
6. **Resolved**: headless `claude -p` runs can't use claude.ai connectors, so scheduled
   briefs read the calendar from private iCal URLs instead (§15).
7. **Open**: Obsidian vs this app's conventions drift. Keep conventions compatible
   with Obsidian core + Tasks plugin.

---

## 12. Implementation notes (Phase 1)

- **Index location.** Moved from `<vault>/.brain-cache/` to the user cache directory
  (`$XDG_CACHE_HOME` or `~/.cache`, override with `BRAIN_CACHE_DIR`), keyed by a hash of
  the vault path. Reason: pointing `brain` at an existing Obsidian vault must not add
  files to it.
- **Machine config** lives in `~/.config/shannote/config.json` (`vault`, `device`).
  Override with `BRAIN_CONFIG_DIR`, `BRAIN_VAULT`, `BRAIN_DEVICE`.
- **Parsing rules.** Code fences, inline code, `$$` math and `%%` comments are skipped for
  links, tags, headings and tasks. Wikilinks inside frontmatter values (e.g. `related:`)
  are indexed and flagged `in_frontmatter`. Invalid YAML is reported, not fatal.
- **Link resolution** follows Obsidian: exact path → same folder → path suffix → file name
  (shortest path wins). Ambiguous names are reported by `brain doctor`.
- **Task ids** use an explicit `🆔` when present, else `sha1(path + text)`. Ids survive
  moving a task within a note but change when its text changes. Phase 2's
  `brain_task_update` will match by id and fall back to exact text.
- **Search** is BM25 with weights title 10, headings 4, tags 3, body 1; AND first, then OR.
  Snippets mark matches with `«…»` (not `**`, which collides with markdown bold).
- **Ignored folders:** hidden folders (`.git`, `.obsidian`, `.trash`, …),
  `_brain/trash`, `_brain/templates`.

## 13. Implementation notes (Phase 2)

- **One core, two front ends.** `src/core.ts` (`Brain`) owns vault, index, git and
  session state. The MCP server (`src/mcp/server.ts`) and the web app (`src/web/`) are thin
  layers over it, so write rules are identical.
- **Writes**: each write is validated (no paths outside the vault, no hidden folders, no
  writes into `_brain/` except threads/sessions), applied, stamped (`updated`,
  `updated_by: claude@<device>` or `eric@<device>`, only on notes that already have
  frontmatter), committed as `brain(<device>): <op> <path>`, then re-indexed. Pushes are
  debounced 10 s; `end_session` pushes immediately.
- **Sync**: pulls are `fetch` + `merge --no-edit` (never rebase), at most once a minute
  and on every `begin_session`. Outside edits are committed as `edit(<device>): …` before a
  merge. Conflicts keep the local file and write the other side to
  `<name>.conflict-<timestamp>.md`; the briefing lists these. `GIT_TERMINAL_PROMPT=0` and
  timeouts mean a missing credential shows as "offline" instead of hanging.
- **Sync only in initialised vaults**: git operations run only when `_brain/config.yml`
  exists (created by `brain init`). Pointing `brain web`/`serve` at an existing folder never
  commits, pulls or pushes there.
- **Sessions**: `brain_begin_session` returns the briefing in §5.2; the server also tracks
  touched files and, if the process exits without `brain_end_session`, writes a
  `handoff: false` log listing them. The web app doesn't create sessions.
- **Tasks**: `brain_task_update` finds the task by id, verifies the indexed line still
  matches, and falls back to an exact-line search if the file shifted. Session-log
  "next steps" are checkbox lines but are excluded from task queries and counts.
- **Index concurrency**: index runs are serialised per process, rows are re-checked
  inside the write transaction, and SQLite waits up to 5 s on locks, so the MCP server and
  web app can share one index.
- **Web app security**: binds to 127.0.0.1, rejects non-localhost `Host` headers (DNS
  rebinding), requires an `x-brain: 1` header on POSTs (blocks cross-site form posts), and
  escapes raw HTML in notes. CSP disallows external resources.
- **Not yet**: MCP prompts (`morning_brief` etc.) are Phase 4. Recurring tasks are
  completed like normal tasks (no next occurrence is created yet).

## 14. Implementation notes (Phase 3)

- **Model**: `Xenova/all-MiniLM-L6-v2` (384-d, ~23 MB quantised) via transformers.js on
  CPU, downloaded once to `~/.cache/shannote/models`. Chosen over bge-small because
  it's the model the real-model test was run against. Override with `BRAIN_EMBED_MODEL`
  or `embeddingModel` in config; `BRAIN_EMBEDDINGS=off` disables; `BRAIN_MODEL_PATH`
  loads from a local folder with no downloads.
- **Optional dependency**: `@huggingface/transformers` is an `optionalDependency` and is
  kept out of the bundle. If it's missing or the model can't load, everything falls back
  to keyword search and the reason is shown in search results and on the Health page.
- **Chunking**: sections at H1–H3, tiny sections merged into the previous one, long ones
  split at paragraphs (≤ 1,400 chars). Each chunk is prefixed with `Title › Heading path`.
  Link syntax, callout markers and task dates are stripped; code blocks are cut to 4 lines.
- **Vector storage**: float32 BLOBs in SQLite keyed by `(chunk hash, model)`, so an edit
  re-embeds only the changed section and vectors survive index rebuilds. Search is a
  brute-force cosine scan in memory instead of `sqlite-vec`: a few ms for thousands of
  chunks, and no native extension to install.
- **Hybrid ranking**: reciprocal rank fusion (k = 60) of BM25 note ranks and best-chunk
  semantic ranks. Keyword hits from the OR fallback count half. Semantic matches under
  cosine 0.25 are dropped. Results say whether they matched words, meaning or both, and
  which section matched.
- **Similar notes**: `brain_related` compares the note's centroid vector with all
  chunks, excluding notes already linked either way (cut-off 0.35).
- **Background embedding**: the MCP server and web app embed new or changed sections
  after each index run, single-flight; failures back off for 10 minutes. `brain embed`
  runs it in the foreground with progress. First full run on Eric's vault: 1,889
  sections, ~85 s with the fp32 model in the cloud sandbox; the default q8 model is
  faster.

## 15. Implementation notes (Phase 4)

- **Rituals = instructions + facts.** `brain_plan(kind)` and the MCP prompts
  `morning_brief`, `evening_review`, `weekly_review`, `meeting_prep` return the same
  text: step-by-step instructions (`src/plan/planning.ts`) plus a JSON context bundle
  gathered by `Brain.planContext()` (calendar, overdue/due/upcoming tasks, threads, recent
  handoffs, yesterday's review, completed tasks, git changes…). The app still never calls
  an LLM. A tool version exists because some clients don't surface MCP prompts.
- **Where results go**: the morning brief writes the daily note's `## Schedule`
  (`- HH:MM–HH:MM Title` lines) and `## Plan` (Top 3 + Blocks; existing tasks are
  referenced, not copied). The evening review writes `## Review` and rolls tasks over. The
  weekly review creates `daily/YYYY-Www-review.md`. Meeting prep creates
  `meetings/YYYY-MM-DD <title>.md` from the meeting template.
- **Calendar**: private iCal URLs (Google Calendar: Settings → your calendar → "Secret
  address in iCal format") stored per device in machine config; never in the vault.
  15-minute cache with stale fallback. Supports TZID/UTC/floating/all-day times, DURATION,
  RRULE (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY incl. `1TU`,
  BYMONTHDAY), EXDATE, RECURRENCE-ID overrides and cancelled events, and keeps wall-clock
  time across DST. Not supported: BYSETPOS, BYWEEKNO, RDATE, Windows time-zone names
  (treated as local time).
- **Today page** merges calendar events with the daily note's Schedule lines (deduped by
  time + title), dims past events and highlights the next one.
- **Rollover** (`brain_rollover_tasks`): open tasks in one day's daily note are marked
  `[>]` and appended to the next day's Plan with `(from [[date]])`. Only daily-note tasks
  move; tasks that live in project notes stay where they are.
- **Recurring tasks**: completing a `🔁` task inserts the next occurrence above it, with
  due/scheduled/start dates shifted (Obsidian Tasks behaviour). Rules: every
  day/week/month/year, every N …, every weekday, every <weekday list>, "when done".
- **Scheduled runs**: `brain schedule` prints the `claude mcp add` command and crontab
  lines for `claude -p` runs at the morning/evening times. Printing rather than installing
  is deliberate: cron jobs that spend usage should be added knowingly.

## 16. Implementation notes (Phase 5)

- **Inbox entries** are top-level list items (with indented continuation lines) or
  paragraphs in any `inbox/*.md` file, so phone captures typed in Obsidian work too.
  Ids hash file + text. `brain_inbox` lists them with three suggested destinations from
  hybrid search (excluding inbox/, daily/, _brain/).
- **Resolving** an entry (move / task / archive / discard) appends it to the destination,
  removes it from the inbox file (deleting the file once empty), logs it to
  `_brain/inbox-log/YYYY-MM.md` (not indexed), and commits everything in one commit.
  Claude's triage prompt must show a plan and wait for approval before resolving.
- **Link suggestions**: plain-text, whole-word, case-insensitive mentions of other notes'
  titles, outside code, links, URLs, headings and frontmatter. Titles need a space or ≥ 8
  characters (dates and words like "Ideas" are skipped) to keep noise down. Plus semantic
  "similar, not linked" from Phase 3. `brain_links add` turns a mention into
  `[[Title|original wording]]`, or adds to `related:` frontmatter if the note has one
  (Eric's existing convention), else a `## Related` section.
- **Context packs**: top hybrid-search notes for a topic, each with its summary
  (frontmatter `summary` or first paragraph), the best-matching section and open tasks,
  plus recent handoff decisions; clipped at paragraph/sentence boundaries to a budget
  (default 8,000 chars). Available as a tool, a prompt, and a "Copy context pack" button.
- **Phone**: `brain web --lan` binds to all interfaces and requires a random token for
  non-local requests (`?token=` once, then an HttpOnly SameSite=Strict cookie; constant-time
  comparison; `--new-token` rotates it). Localhost behaviour is unchanged. The app is
  installable (web manifest). Guide: `docs/PHONE.md` (LAN/Tailscale, Obsidian + git on
  Android/iOS, limits of Claude mobile).
- **Tool count** is now 22. That's past the "keep it small" aim in §6; related actions
  were folded into `brain_inbox` and `brain_links` (an `action` argument) to limit
  growth. Watch for Claude picking the wrong tool; consolidate further if it does.

## 17. Client setup

```jsonc
// Claude Desktop: claude_desktop_config.json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["-y", "shannote", "serve"],
      "env": { "BRAIN_VAULT": "/Users/you/vault" }
    }
  }
}
```

```bash
# Claude Code
claude mcp add brain --scope user -- npx -y shannote serve
```

## 18. Implementation notes (Phase 6: editor and sharing)

- **Editor**: CodeMirror 6, bundled with esbuild to `dist/editor.js` (`src/web/editor/`,
  its own tsconfig with DOM types). Live preview hides markdown markup except on the
  line(s) with the cursor; tasks become clickable checkboxes, bullets become "•",
  `[[links]]` and `[text](url)` show as links (Ctrl/Cmd-click to follow), frontmatter folds
  into a "Properties" chip. Vim mode is `@replit/codemirror-vim` in a compartment, toggled
  per browser (`:w` saves, `:q` / `:wq` return to reading). Read/Edit mode is remembered;
  `e` toggles it.
- **Saving**: `Brain.save` replaces the whole file, guarded by the hash the editor loaded
  (409 with the current text and hash on mismatch; the UI offers "Load their version" /
  "Keep mine", which re-saves with `force`). Saves are debounced ~1s in the browser; the
  file is written immediately, but the **commit** waits 30s after the last save to the
  note (flushed before any pull, sync or exit), so a typing session is one commit. Editor
  saves aren't stamped with `updated`/`updated_by` (git records the author, and stamping
  would rewrite text under the cursor). Not exposed over MCP: Claude keeps using exact-match
  `brain_edit` ops. The editor polls the note's hash every 4s and reloads it when it
  changed elsewhere and there are no unsaved local edits.
- **Shared spaces**: `shared/<slug>/` folders that are their own git repos (with a
  `.shannote-space.json` holding the display name). The vault's `.gitignore` gets
  `/shared/` (committed) when the first space is made or joined. `Brain` routes every write
  to the repo that owns the path (one commit per repo when a change spans both), pulls
  spaces on the same once-a-minute schedule as the vault, and pushes all repos together.
  Spaces are indexed and searchable like any folder. CLI: `share create [--github] | join |
  invite | list`. GitHub invites use `gh api …/collaborators/<user>` with push permission.
- **Guest links**: a random 24-byte token per person per space; only its SHA-256 is stored,
  in the machine config (now written with mode 0600). A request counts as the owner only
  if it comes from loopback with a localhost Host header, so traffic arriving through
  Tailscale Funnel or a tunnel (loopback, public Host) is never the owner. `?guest=` is
  swapped for an HttpOnly SameSite=Lax cookie (Lax so the link works when opened from a
  chat app). Guests get an allow-list of seven API routes; every path is checked to be
  inside their space, notes are fetched by exact path (titles could resolve to private
  notes), links render against the space only, search is forced into the space, and
  related/backlinks are not returned. Guest edits are committed with
  `--author "Name (guest) <guest-id@shannote.local>"` and subject `guest(Name): …`.
  `--read-only` links refuse all POSTs. `share url` stores the public https base used to
  print links. Guide: `docs/SHARING.md`.
- **Known limits**: no merge of simultaneous edits to the same note (last save loses only
  after an explicit "Keep mine"); guest links need the owner's laptop awake; there's no
  per-guest rate limiting (tokens are 192-bit, so guessing isn't practical); guests can't
  delete or move notes.
