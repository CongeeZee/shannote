# Shannote

A markdown second brain and daily planner built to be used **through Claude**.
The name is a nod to Claude Shannon, the father of information theory, plus *note*.

The CLI is `shannote`; `brain` is a short alias for every command.

- Your notes are plain markdown files in a private git repo (Obsidian-compatible).
- An MCP server lets Claude search, read, edit and plan with them.
- Claude on each of your devices knows where the others left off, through session handoff logs synced over git.
- No API key needed: Claude does the reasoning under your normal Claude subscription, and embeddings run locally.

> **Status:** Phase 6 in progress: an in-app markdown editor (live preview, vim keys) and
> sharing (shared spaces + guest links), on top of inbox triage, planning, calendar, search,
> sync, handoffs and the web app.
> See [`docs/SPEC.md`](docs/SPEC.md).

## Setup (per device)

```bash
git clone https://github.com/<you>/shannote && cd shannote
npm install && npm run build && npm link     # puts `brain` on your PATH

# First device: create the vault and push it to a PRIVATE repo
brain init ~/vault --device laptop-home
cd ~/vault && git add -A && git commit -m "init vault"
gh repo create vault --private --source=. --push

# Other devices: clone the vault, then register this device
git clone https://github.com/<you>/vault ~/vault
brain init ~/vault --device laptop-uni        # keeps existing files
```

`brain init` remembers the vault path and device name in `~/.config/shannote/config.json`.

**Semantic search** (search by meaning): run `brain embed` once per device. It downloads a
~23 MB model (all-MiniLM-L6-v2) and embeds your notes locally; nothing is sent anywhere.
After that, `brain web` and `brain serve` keep it up to date in the background. Without
it, search falls back to keywords.

**Calendar** (optional, read-only): in Google Calendar open Settings → your calendar →
*Secret address in iCal format*, then:

```bash
brain calendar add "https://calendar.google.com/calendar/ical/…/basic.ics" --name Uni
brain calendar show            # today's events
```

The URL is stored only on this device (it's a secret). Repeat per calendar and per device.

## Use it

**As a desktop app**

```bash
brain app install         # adds Shannote to your applications menu
```

Then search for **Shannote** in your launcher. It starts the web server in the
background if needed and opens it in its own window (Chromium, Chrome, Brave, Edge or
Vivaldi in app mode; otherwise a tab in your default browser). Right-click the launcher
for **Quick capture**. `brain app stop` stops the background server; `brain app uninstall`
removes the launcher. Re-run `brain app install` if you move the repo or change Node
versions (the launcher stores absolute paths).

**Web app** (same thing, in a terminal)

```bash
brain web --open          # http://localhost:4567
```

Today view (schedule, daily note, overdue/due/upcoming tasks, latest handoffs, threads),
an Inbox page that files captures with one click, search (with "copy context pack"),
tasks, a notes browser with link suggestions, handoffs, and a health page. The
capture bar at the top appends to today's inbox. Keys: `/` search, `c` capture, `t` today,
`e` edit the open note.

**Editing**: open a note and switch to **Edit**. You write markdown and it's styled as you go
(the markup shows only on the line you're on). It saves as you type, and if Claude or another
device changed the note meanwhile it asks before overwriting. Toggle **Vim** in the editor bar
(`:w` saves, `:q` goes back to reading). Ctrl-click a link to follow it, Ctrl-Enter toggles a
task. **+ New note** is on the Notes page.

**Sharing**: `brain share create "Thesis Group" --github` makes `shared/thesis-group/`, a folder
with its own private repo. Invite GitHub users with `brain share invite`, or give anyone a
browser link with `brain share guest thesis-group "Alex"`. Guests only ever see that space.
See [`docs/SHARING.md`](docs/SHARING.md).

**Claude Desktop**: add to `~/.config/Claude/claude_desktop_config.json` (Linux) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), then restart Claude:

```json
{
  "mcpServers": {
    "brain": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/shannote/dist/cli.js", "serve", "--client", "claude-desktop"]
    }
  }
}
```

Use absolute paths (`which node`): Claude Desktop doesn't load your shell's PATH, so `nvm` installs aren't found otherwise.

**Claude Code**

```bash
claude mcp add brain --scope user -- node /absolute/path/to/shannote/dist/cli.js serve --client claude-code
```

Then just talk to Claude: "triage my inbox", "suggest links for my recent notes",
"give me context on my thesis", "plan my day", "how did today go?", "weekly review",
"prep me for the thesis meeting", "what did I do on my other laptop?", "what's overdue?",
"add 'email Jane' to today's plan", "wrap up". The planning ones are also MCP prompts
(`morning_brief`, `evening_review`, `weekly_review`, `meeting_prep`): in Claude Code
they're `/mcp__brain__morning_brief` etc.

**Phone**: `brain web --lan` and open the printed link on your phone (same Wi-Fi or
Tailscale), then Add to Home Screen. See [`docs/PHONE.md`](docs/PHONE.md) for that and
other options.

**Automatic morning brief / evening review**: `brain schedule` prints the cron lines
(runs `claude -p` with your subscription while the laptop is awake). Claude calls `brain_begin_session` at the start
and `brain_end_session` when you wrap up, which is what lets the next device continue.

**CLI**: `brain app [install|stop] | status | search <q> [--mode …] | embed | calendar … | share … | plan <kind> | schedule | doctor | sync | index`

> Git sync only runs in folders set up with `brain init`. You can safely run
> `brain web --vault ~/path/to/obsidian-vault` to look around: it won't commit, pull or push
> there (though ticking a task or capturing will still edit files, as you'd expect).

## How it works

```
Claude (Desktop / Code) ──MCP──► brain ──► ~/vault (markdown + git) ◄──► GitHub (private)
                                   └─ local index: SQLite full-text + MiniLM embeddings
```

| Area | What you get |
|---|---|
| Second brain | Hybrid search (keywords + meaning), backlinks, similar-note suggestions, inbox capture |
| Planning | Daily notes, Obsidian-style tasks, morning brief / evening review / weekly review prompts, calendar via Claude's Google Calendar connector |
| Continuity | `brain_begin_session` / `brain_end_session` handoffs and per-topic threads shared across devices |
| Safety | Every write is a git commit. Edits use exact-match operations. Deletes are soft. |

## Roadmap

0. ✅ Repo + tooling
1. ✅ Vault parser + full-text index + CLI
2. ✅ MCP server, git sync, session handoff, local web app
3. ✅ Local embeddings + hybrid search
4. 🟡 Planning prompts, calendar, rollover, recurring tasks (built; needs a week of use)
5. 🟡 Inbox triage, link suggestions, context packs, phone access (built; needs use)
6. 🟡 Web app: editor ✅, sharing ✅, graph and calendar strip to do
7. (optional) Hosted hub for phone/remote access

## License

MIT
