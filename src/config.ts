import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

/** Per-machine settings. Never stored in the vault. */
export interface MachineConfig {
  vault?: string;
  device?: string;
}

export function configDir(): string {
  return (
    process.env.BRAIN_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "second-brain")
  );
}

export function cacheRoot(): string {
  return (
    process.env.BRAIN_CACHE_DIR ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "second-brain")
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
  if (!existsSync(abs)) throw new Error(`Vault not found: ${abs}`);
  return abs;
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
