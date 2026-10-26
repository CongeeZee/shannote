# CLAUDE.md — guidance for Claude working on this repo

This repo is the **code** for `second-brain`. Eric's actual notes live in a
separate private vault repo and must never be committed here (this repo is public).

## Source of truth
- `docs/SPEC.md` is the spec. If an implementation choice diverges from it,
  update the spec in the same PR and say why.
- Build in the phase order in SPEC §9. Don't start a phase before the
  previous one's "done when" criterion is met.

## Rules
- The app must never call an LLM API. Intelligence lives in MCP prompts run by
  the client (SPEC §2.1).
- No personal data in fixtures, tests or docs. Use synthetic examples.
- TypeScript strict, ESM, Node 22. Tests with vitest. Keep the `vault/` module
  pure (no I/O beyond what's injected) so it stays easy to test.
- Every tool that writes to the vault: goes through `sync.commit()`, is covered
  by a test against `test/fixtures/vault`, and never removes content without an
  explicit `old_text`/section match.
- Keep MCP tool count small and descriptions precise. Changing a tool
  name or description is a behaviour change. Note it in the PR.

## Layout (target)
```
src/
  vault/     parse + write markdown, frontmatter, links, tasks
  index/     SQLite FTS5 + sqlite-vec, watcher
  search/    hybrid ranking
  sync/      git provider, conflict handling, device identity
  session/   begin/end session, threads
  mcp/       server, tools, prompts, resources
  cli.ts     brain init|serve|index|sync|doctor|status
test/
  fixtures/vault/
```

## Commands
- `npm run build` · `npm test` · `npm run typecheck` · `npm run dev -- <command>`
