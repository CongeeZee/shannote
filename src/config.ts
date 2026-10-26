import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

/** Per-machine settings. Never stored in the vault. */
export interface MachineConfig {
  vault?: string;
  device?: string;
}

/** Moves a pre-rename (second-brain) folder to the new name, once. */
function migrated(base: string): string {
  const next = join(base, "shannote");
  const old = join(base, "second-brain");
  if (!existsSync(next) && existsSync(old)) {
    try {
      renameSync(old, next);
    } catch {
      return old; // couldn't move it (permissions, another process): keep using it
    }
  }
  return next;
}

export function configDir(): string {
  return process.env.BRAIN_CONFIG_DIR ?? migrated(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
}

export function cacheRoot(): string {
  return (
    process.env.BRAIN_CACHE_DIR ?? migrated(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"))
  );
}

export function loadConfig(): MachineConfig {
  const file = join(configDir(), "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as MachineConfig;
  } catch {
    return {};
  }
}

export function saveConfig(update: MachineConfig): MachineConfig {
  const next = { ...loadConfig(), ...update };
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(join(configDir(), "config.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Vault path from, in order: --vault flag, BRAIN_VAULT, saved config. */
export function resolveVault(flag?: string): string {
  const v = flag ?? process.env.BRAIN_VAULT ?? loadConfig().vault;
  if (!v) {
    throw new Error(
      "No vault configured. Run `brain init <path>` or pass --vault / set BRAIN_VAULT.",
    );
  }
  const abs = resolve(v.replace(/^~(?=$|\/)/, homedir()));
  const fromConfig = !flag && !process.env.BRAIN_VAULT;
  const where = fromConfig ? ` (saved in ${join(configDir(), "config.json")})` : "";
  if (!existsSync(abs)) throw new Error(`Vault not found: ${abs}${where}. Run \`brain init ~/vault\` to create one.`);
  try {
    assertNotCodeRepo(abs);
  } catch (e) {
    if (!fromConfig) throw e;
    throw new Error(
      `Your saved vault is ${abs}, which is this app's code folder, not a vault (probably from running \`brain init\` there). ` +
        "Run `brain init ~/vault` to create a real vault; that also replaces the saved setting.",
    );
  }
  return abs;
}

/**
 * Refuses to treat a code project (anything with a package.json, including this
 * app's own repo) as a vault. The app commits and pushes vault changes, so a
 * vault inside a public code repo would publish personal notes.
 */
export function assertNotCodeRepo(dir: string): void {
  if (existsSync(join(dir, "package.json"))) {
    throw new Error(
      `${dir} looks like a code project (it has a package.json), not a vault. ` +
        "Your notes must live in their own folder and private repo, e.g. `brain init ~/vault`.",
    );
  }
}

export function deviceName(): string {
  return process.env.BRAIN_DEVICE ?? loadConfig().device ?? hostname().split(".")[0]!;
}

/**
 * The index is derived data, so it lives in the user cache directory rather
 * than inside the vault. That keeps it out of git and out of Obsidian.
 */
export function indexPath(vault: string): string {
  const key = createHash("sha1").update(resolve(vault)).digest("hex").slice(0, 12);
  return join(cacheRoot(), key, "index.db");
}
