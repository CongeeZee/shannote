import { spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../config.js";
import { BrainError, slugify } from "../util.js";

/**
 * Shared spaces: folders under `shared/` that are their own git repos, so they
 * can be shared (on GitHub) with other people without exposing the rest of the
 * vault. The vault's own repo ignores `shared/`.
 */
export const SHARED_DIR = "shared";
const META = ".shannote-space.json";

export interface Space {
  slug: string;
  name: string;
  /** Vault-relative folder, e.g. "shared/thesis-group". */
  dir: string;
  remote?: string;
}

function git(cwd: string, args: string[], timeout = 20_000) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? (r.error ? String(r.error) : "")).trim() };
}

export function listSpaces(vault: string): Space[] {
  const root = join(vault, SHARED_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(root, e.name, ".git")))
    .map((e) => readSpace(vault, e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readSpace(vault: string, slug: string): Space {
  const abs = join(vault, SHARED_DIR, slug);
  let name = slug;
  try {
    name = (JSON.parse(readFileSync(join(abs, META), "utf8")) as { name?: string }).name || slug;
  } catch {
    /* no metadata: use the folder name */
  }
  const remote = git(abs, ["remote", "get-url", "origin"]);
  return { slug, name, dir: `${SHARED_DIR}/${slug}`, remote: remote.code === 0 ? remote.out : undefined };
}

export function getSpace(vault: string, ref: string): Space {
  const spaces = listSpaces(vault);
  const s = spaces.find((x) => x.slug === ref || x.name.toLowerCase() === ref.toLowerCase() || x.slug === slugify(ref));
  if (!s) throw new BrainError(`No shared space "${ref}". Spaces: ${spaces.map((x) => x.slug).join(", ") || "none yet"}`, "not_found");
  return s;
}

/** The space a vault-relative path belongs to, if any. */
export function spaceSlugOf(rel: string): string | null {
  const m = rel.match(/^shared\/([^/]+)\//);
  return m ? m[1]! : null;
}

/** Makes sure the vault repo never picks up shared spaces (they have their own repos). */
export function ensureVaultIgnoresShared(vault: string, device = "app"): void {
  const gi = join(vault, ".gitignore");
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (/^\/?shared\/?$/m.test(cur)) return;
  appendFileSync(gi, `${cur && !cur.endsWith("\n") ? "\n" : ""}# Shared spaces are separate git repos\n/shared/\n`);
  if (existsSync(join(vault, ".git"))) {
    git(vault, ["add", "--", ".gitignore"]);
    git(vault, ["-c", `user.name=shannote (${device})`, "-c", `user.email=brain@${device}.local`, "commit", "-q", "--no-verify", "-m", `space(${device}): keep shared spaces out of the vault repo`, "--", ".gitignore"]);
  }
}

export function createSpace(vault: string, name: string, device: string): Space {
  const slug = slugify(name);
  if (!slug) throw new BrainError("Give the space a name", "invalid");
  const abs = join(vault, SHARED_DIR, slug);
  if (existsSync(abs)) throw new BrainError(`shared/${slug} already exists`, "exists");
  ensureVaultIgnoresShared(vault, device);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, META), JSON.stringify({ name, created: new Date().toISOString() }, null, 2) + "\n");
  writeFileSync(
    join(abs, "README.md"),
    `# ${name}\n\nA shared Shannote space. Everything in this folder is visible to everyone it's shared with.\n`,
  );
  writeFileSync(join(abs, ".gitattributes"), "* text=auto\n");
  let r = git(abs, ["init", "-q", "-b", "main"]);
  if (r.code !== 0) r = git(abs, ["init", "-q"]);
  if (r.code !== 0) throw new BrainError(`git init failed: ${r.err}`, "invalid");
  git(abs, ["add", "-A"]);
  git(abs, ["-c", `user.name=shannote (${device})`, "-c", `user.email=brain@${device}.local`, "commit", "-q", "-m", `space(${device}): create ${name}`]);
  return readSpace(vault, slug);
}

/** Clones someone's shared space into shared/<name>. */
export function joinSpace(vault: string, url: string, name?: string, device = "app"): Space {
  const slug = slugify(name ?? url.replace(/\.git$/, "").split(/[/:]/).pop() ?? "");
  if (!slug) throw new BrainError("Couldn't pick a folder name; pass one", "invalid");
  const abs = join(vault, SHARED_DIR, slug);
  if (existsSync(abs)) throw new BrainError(`shared/${slug} already exists`, "exists");
  ensureVaultIgnoresShared(vault, device);
  mkdirSync(join(vault, SHARED_DIR), { recursive: true });
  const r = git(join(vault, SHARED_DIR), ["clone", "-q", url, slug], 120_000);
  if (r.code !== 0) throw new BrainError(`git clone failed: ${r.err}`, "invalid");
  if (!existsSync(join(abs, META)) && name) writeFileSync(join(abs, META), JSON.stringify({ name }, null, 2) + "\n");
  return readSpace(vault, slug);
}

/** "owner/repo" from a GitHub remote URL. */
export function githubRepo(remote: string | undefined): string | null {
  const m = remote?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// ------------------------------------------------------------------ guests

/**
 * A guest link gives one person read/write access to one space through the web
 * app, with no account. Only a hash of the token is stored (in this device's
 * config), so a leaked config file doesn't leak working links.
 */
export interface Guest {
  id: string;
  name: string;
  space: string;
  tokenHash: string;
  created: string;
  readOnly?: boolean;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function listGuests(): Guest[] {
  return ((loadConfig() as { guests?: Guest[] }).guests ?? []).slice();
}

export function createGuest(space: string, name: string, opts: { readOnly?: boolean } = {}): { guest: Guest; token: string } {
  const clean = name.trim().replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 40);
  if (!clean) throw new BrainError("Give the guest a name (it's shown on their edits)", "invalid");
  const token = randomBytes(24).toString("base64url");
  const guest: Guest = {
    id: randomBytes(4).toString("hex"),
    name: clean,
    space,
    tokenHash: hash(token),
    created: new Date().toISOString(),
    ...(opts.readOnly ? { readOnly: true } : {}),
  };
  saveConfig({ guests: [...listGuests(), guest] } as never);
  return { guest, token };
}

export function revokeGuest(ref: string): Guest[] {
  const all = listGuests();
  const gone = all.filter((g) => g.id === ref || g.name.toLowerCase() === ref.toLowerCase() || g.space === ref);
  if (!gone.length) throw new BrainError(`No guest link matches "${ref}"`, "not_found");
  saveConfig({ guests: all.filter((g) => !gone.includes(g)) } as never);
  return gone;
}

export function findGuest(token: string | undefined, guests = listGuests()): Guest | undefined {
  if (!token || token.length > 200) return undefined;
  const h = Buffer.from(hash(token));
  return guests.find((g) => {
    const b = Buffer.from(g.tokenHash);
    return b.length === h.length && timingSafeEqual(b, h);
  });
}
