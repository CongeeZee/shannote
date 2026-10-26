import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb } from "../src/index/db.js";
import { indexVault } from "../src/index/indexer.js";
import { initVault } from "../src/vault/init.js";
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
