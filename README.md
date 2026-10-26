# second-brain

A markdown second brain and daily planner built to be used **through Claude**.

- Your notes are plain markdown files in a private git repo (Obsidian-compatible).
- An MCP server lets Claude search, read, edit and plan with them.
- Claude on each of your devices knows where the others left off, through session handoff logs synced over git.
- No API key needed: Claude does the reasoning under your normal Claude subscription, and embeddings run locally.

> **Status:** Phase 1 done (parser, index, CLI). MCP server is next. See [`docs/SPEC.md`](docs/SPEC.md).

## Quick start

```bash
npm install
npm run build
npm link                      # puts `brain` on your PATH

brain init ~/vault --device laptop-home   # new vault (never overwrites files)
brain status
brain search "page tables"
brain doctor                  # broken links, bad frontmatter, duplicate names

# Point at any existing Obsidian vault without changing it:
brain status --vault ~/path/to/obsidian-vault
```

The search index lives in `~/.cache/second-brain/`, not in your vault.

## How it works

```
Claude (Desktop / Code) ──MCP──► brain ──► ~/vault (markdown + git) ◄──► GitHub (private)
                                   └─ local index: SQLite full-text + embeddings
```

| Area | What you get |
|---|---|
| Second brain | Hybrid keyword + semantic search, backlinks, related-note suggestions, inbox triage |
| Planning | Daily notes, Obsidian-style tasks, morning brief / evening review / weekly review prompts, calendar via Claude's Google Calendar connector |
| Continuity | `brain_begin_session` / `brain_end_session` handoffs and per-topic threads shared across devices |
| Safety | Every write is a git commit. Edits use exact-match operations. Deletes are soft. |

## Roadmap

0. Repo + tooling
1. Vault parser + full-text index + CLI
2. MCP server, git sync, session handoff
3. Local embeddings + hybrid search
4. Planning prompts
5. Inbox triage, linking, phone capture guide
6. (optional) Web UI
7. (optional) Hosted hub for phone/remote access

## License

MIT
