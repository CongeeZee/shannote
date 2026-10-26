import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openDb } from "../src/index/db.js";
import { indexVault } from "../src/index/indexer.js";

// Phase 1 "done when": index a vault of 500+ notes in under 5 seconds.
const N = 1000;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-perf-"));
  const words = "kernel page table scheduler robot planner thesis golf search index".split(" ");
  for (let i = 0; i < N; i++) {
    const folder = join(dir, `area-${i % 20}`);
    mkdirSync(folder, { recursive: true });
    const body = Array.from({ length: 800 }, (_, j) => words[(i * 7 + j) % words.length]).join(" ");
    writeFileSync(
      join(folder, `Note ${i}.md`),
      `---\ntitle: Note ${i}\ntags: [t${i % 10}]\nrelated:\n  - "[[Note ${(i + 1) % N}]]"\n---\n` +
        `# Note ${i}\n\n## Section\n\n${body}\n\n- [ ] Task ${i} 📅 2026-11-0${(i % 9) + 1}\n` +
        `See [[Note ${(i + 2) % N}]] and [[Note ${(i + 3) % N}#Section|alias]].\n`,
    );
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it(`indexes ${N} notes in under 5s, and re-indexes unchanged notes in under 1s`, async () => {
  const db = openDb(join(dir, ".cache/index.db"));
  const cold = await indexVault(db, dir);
  expect(cold.total).toBe(N);
  expect(cold.durationMs).toBeLessThan(5000);

  const warm = await indexVault(db, dir);
  expect(warm.unchanged).toBe(N);
  expect(warm.durationMs).toBeLessThan(1000);

  const unresolved = db.prepare("SELECT COUNT(*) n FROM links WHERE target_path IS NULL").get() as {
    n: number;
  };
  expect(unresolved.n).toBe(0);
  console.log(`cold ${cold.durationMs} ms, warm ${warm.durationMs} ms`);
  db.close();
}, 20_000);
