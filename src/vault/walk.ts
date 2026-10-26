import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Directories never indexed. `_brain/trash` holds soft-deleted notes. */
export const DEFAULT_IGNORES = [
  ".git",
  ".obsidian",
  ".trash",
  ".brain-cache",
  ".claude",
  "node_modules",
  "_brain/trash",
  "_brain/templates",
];

export interface VaultFile {
  /** Vault-relative POSIX path. */
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
}

/** Lists every markdown file in the vault, skipping ignored and hidden directories. */
export async function walkVault(root: string, ignores = DEFAULT_IGNORES): Promise<VaultFile[]> {
  const ignoreSet = new Set(ignores);
  const out: VaultFile[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (e) => {
        const abs = join(dir, e.name);
        const rel = relative(root, abs).split(sep).join("/");
        if (e.isDirectory()) {
          if (e.name.startsWith(".") || ignoreSet.has(rel) || ignoreSet.has(e.name)) return;
          await visit(abs);
        } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
          const s = await stat(abs);
          out.push({ path: rel, absPath: abs, mtimeMs: s.mtimeMs, size: s.size });
        }
      }),
    );
  }

  await visit(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
