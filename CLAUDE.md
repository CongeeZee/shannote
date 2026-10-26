# CLAUDE.md — guidance for Claude working on this repo

This repo is the **code** for Shannote (CLI: `shannote`, alias `brain`). Eric's actual notes live in a
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

## Layout
```
src/
  config.ts   machine config, vault/device resolution, index path
  util.ts     ids, local timestamps, slugs, BrainError
  core.ts     Brain: the single entry point for reads/writes/sync/sessions
  vault/      parse, resolve links, walk, edit ops (pure), init, templates
  index/      SQLite schema, incremental indexer, status/doctor queries
  search/     keyword (FTS5/BM25), chunking, embeddings, hybrid ranking (RRF)
  sync/       git: commit, pull (merge + conflict copies), push, log
  session/    session logs and threads
  plan/       calendar (iCal), schedule parsing, recurrence, planning rituals
  inbox.ts    inbox entry parsing · links.ts unlinked mentions · curate.ts triage/link prompts
  mcp/        MCP server (tools, resource, instructions)
  web/        local web app: HTTP API, markdown rendering, ui.html (vanilla JS)
  app.ts      desktop launcher (.desktop / macOS .app) and app-mode window
  cli.ts      brain init|app|index|status|search|embed|calendar|plan|schedule|doctor|web|serve|sync
test/
  fixtures/vault/   synthetic notes covering edge cases
  helpers.ts        twoDevices(): bare remote + two clones, one Brain each
```

## Rules for new features
- New capabilities go in `core.ts` (or a module it calls), then get exposed through
  MCP and/or the web API. Don't put logic in the front ends.
- Anything that writes must go through `Brain` so it's validated, stamped, committed
  and re-indexed.

## Testing against a real vault
Use `--vault <path>` (or `BRAIN_VAULT`) with `BRAIN_CACHE_DIR`/`BRAIN_CONFIG_DIR`
pointed at a scratch folder. The index never writes inside the vault.

## Semantic search in tests
Unit tests use `HashEmbedder` (bag of words) so they never download a model. The
real-model test runs only with `BRAIN_TEST_MODEL_PATH=<folder containing Xenova/all-MiniLM-L6-v2>`.

## Commands
- `npm run build` · `npm test` · `npm run typecheck` · `npm run dev -- <command>`
