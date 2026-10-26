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

## Layout
```
src/
  config.ts  machine config, vault/device resolution, index path   (Phase 1 ✅)
  vault/     parse markdown, resolve links, walk vault, init, templates (Phase 1 ✅)
  index/     SQLite schema, incremental indexer, status/doctor queries (Phase 1 ✅)
  search/    keyword (FTS5/BM25) ✅; hybrid ranking (Phase 3)
  sync/      git provider, conflict handling           (Phase 2)
  session/   begin/end session, threads                (Phase 2)
  mcp/       server, tools, prompts, resources         (Phase 2)
  cli.ts     brain init|index|status|search|doctor ✅; serve|sync (Phase 2)
test/
  fixtures/vault/   synthetic notes covering edge cases (code fences, callouts,
                    broken YAML, duplicate names, frontmatter links)
```

## Testing against a real vault
Use `--vault <path>` (or `BRAIN_VAULT`) with `BRAIN_CACHE_DIR`/`BRAIN_CONFIG_DIR`
pointed at a scratch folder. The index never writes inside the vault.

## Commands
- `npm run build` · `npm test` · `npm run typecheck` · `npm run dev -- <command>`
