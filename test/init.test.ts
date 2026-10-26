import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb } from "../src/index/db.js";
import { indexVault } from "../src/index/indexer.js";
import { initVault } from "../src/vault/init.js";
import { assertNotCodeRepo } from "../src/config.js";
import { renderTemplate, TEMPLATES } from "../src/vault/templates.js";
import { parseNote } from "../src/vault/parse.js";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "brain-init-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("creates the vault layout, templates and git repo", () => {
  const r = initVault(dir, { timezone: "Australia/Sydney" });
  for (const p of ["inbox", "daily", "_brain/sessions", "_brain/threads", "_brain/templates/daily.md"])
    expect(existsSync(join(dir, p))).toBe(true);
  expect(readFileSync(join(dir, ".gitattributes"), "utf8")).toContain("_brain/sessions/** merge=union");
  expect(readFileSync(join(dir, "_brain/config.yml"), "utf8")).toContain("Australia/Sydney");
  expect(r.gitInitialised).toBe(true);
});

it("never overwrites existing files", () => {
  writeFileSync(join(dir, ".gitignore"), "mine\n");
  const r = initVault(dir);
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("mine\n");
  expect(r.skipped).toContain(".gitignore");
  expect(initVault(dir).created).toEqual([]);
});

it("does not index templates", async () => {
  initVault(dir);
  const db = openDb(":memory:");
  expect((await indexVault(db, dir)).total).toBe(0);
  db.close();
});

it("renders templates into valid notes", () => {
  const note = renderTemplate(TEMPLATES["daily.md"]!, {
    id: "01TEST",
    date: "2026-10-26",
    datetime: "2026-10-26T09:00:00+11:00",
  });
  const n = parseNote("daily/2026-10-26.md", note);
  expect(n.frontmatterError).toBeUndefined();
  expect(n.frontmatter.type).toBe("daily");
  expect(n.headings.map((h) => h.text)).toContain("Plan");
});

it("refuses to treat a code project as a vault", () => {
  writeFileSync(join(dir, "package.json"), "{}");
  expect(() => assertNotCodeRepo(dir)).toThrow(/looks like a code project/);
});

it("moves config and cache folders from the old second-brain name", async () => {
  const { configDir, cacheRoot } = await import("../src/config.js");
  const saved = { c: process.env.XDG_CONFIG_HOME, k: process.env.XDG_CACHE_HOME, bc: process.env.BRAIN_CONFIG_DIR, bk: process.env.BRAIN_CACHE_DIR };
  delete process.env.BRAIN_CONFIG_DIR;
  delete process.env.BRAIN_CACHE_DIR;
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  mkdirSync(join(dir, "config/second-brain"), { recursive: true });
  writeFileSync(join(dir, "config/second-brain/config.json"), '{"vault":"/x"}');
  mkdirSync(join(dir, "cache/second-brain"), { recursive: true });
  try {
    expect(configDir()).toBe(join(dir, "config/shannote"));
    expect(readFileSync(join(dir, "config/shannote/config.json"), "utf8")).toContain("/x");
    expect(existsSync(join(dir, "config/second-brain"))).toBe(false);
    expect(cacheRoot()).toBe(join(dir, "cache/shannote"));
  } finally {
    for (const [k, v] of [["XDG_CONFIG_HOME", saved.c], ["XDG_CACHE_HOME", saved.k], ["BRAIN_CONFIG_DIR", saved.bc], ["BRAIN_CACHE_DIR", saved.bk]] as const)
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
