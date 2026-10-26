import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES } from "./templates.js";

export const VAULT_DIRS = [
  "inbox",
  "daily",
  "notes",
  "projects",
  "people",
  "meetings",
  "_brain/sessions",
  "_brain/threads",
  "_brain/templates",
  "_brain/trash",
];

const GITATTRIBUTES = `# Append-only files: concurrent appends from two devices merge cleanly.
inbox/** merge=union
_brain/sessions/** merge=union
`;

const GITIGNORE = `.brain-cache/
.obsidian/workspace*.json
.obsidian/cache
.trash/
.DS_Store
`;

export interface InitResult {
  created: string[];
  skipped: string[];
  gitInitialised: boolean;
}

/** Creates the vault layout. Never overwrites existing files. */
export function initVault(root: string, opts: { timezone?: string } = {}): InitResult {
  const created: string[] = [];
  const skipped: string[] = [];
  mkdirSync(root, { recursive: true });

  for (const d of VAULT_DIRS) {
    const abs = join(root, d);
    if (!existsSync(abs)) {
      mkdirSync(abs, { recursive: true });
      // Keep empty folders in git.
      writeFileSync(join(abs, ".gitkeep"), "");
      created.push(`${d}/`);
    }
  }

  const timezone = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const files: Record<string, string> = {
    ".gitattributes": GITATTRIBUTES,
    ".gitignore": GITIGNORE,
    "_brain/config.yml": `# second-brain vault settings (synced across devices)
timezone: ${timezone}
daily_folder: daily
inbox_folder: inbox
`,
  };
  for (const [name, body] of Object.entries(TEMPLATES)) files[`_brain/templates/${name}`] = body;

  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    if (existsSync(abs)) {
      skipped.push(rel);
      continue;
    }
    writeFileSync(abs, body);
    created.push(rel);
  }

  let gitInitialised = false;
  if (!existsSync(join(root, ".git"))) {
    const r = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    gitInitialised = r.status === 0;
  }
  return { created, skipped, gitInitialised };
}
