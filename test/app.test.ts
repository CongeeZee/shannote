import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installLauncher, uninstallLauncher } from "../src/app.js";

let dir: string;
const saved = process.env.XDG_DATA_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-app-"));
  process.env.XDG_DATA_HOME = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = saved;
  rmSync(dir, { recursive: true, force: true });
});

it.skipIf(process.platform === "darwin")("writes a valid launcher entry and icon, and removes them", () => {
  // A launcher from before the rename is replaced.
  mkdirSync(join(dir, "applications"), { recursive: true });
  writeFileSync(join(dir, "applications/second-brain.desktop"), "[Desktop Entry]\nName=Second Brain\n");
  const r = installLauncher({ node: "/home/me/.nvm/versions/node/v22/bin/node", script: "/home/me/my projects/shannote/dist/cli.js" });
  expect(existsSync(join(dir, "applications/second-brain.desktop"))).toBe(false);
  expect(r.notes.join(" ")).toContain("Removed the old");
  const desktop = readFileSync(join(dir, "applications/shannote.desktop"), "utf8");
  expect(desktop).toContain("Name=Shannote");
  expect(desktop).toContain("Icon=shannote");
  expect(desktop).toContain("StartupWMClass=shannote");
  // Paths with spaces and '#' are quoted per the Desktop Entry spec.
  expect(desktop).toContain('Exec=/home/me/.nvm/versions/node/v22/bin/node "/home/me/my projects/shannote/dist/cli.js" app\n');
  expect(desktop).toContain('app --path "/#/inbox"');
  expect(readFileSync(join(dir, "icons/hicolor/scalable/apps/shannote.svg"), "utf8")).toContain("<svg");
  expect(r.files.length).toBeGreaterThanOrEqual(2);
  expect(uninstallLauncher().length).toBeGreaterThanOrEqual(2);
  expect(uninstallLauncher()).toEqual([]);
});
