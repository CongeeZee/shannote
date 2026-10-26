import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain } from "../src/core.js";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

export interface TwoDevices {
  root: string;
  remote: string;
  a: Brain;
  b: Brain;
  pathA: string;
  pathB: string;
  cleanup(): void;
}

/** A bare "GitHub" remote plus two clones, each with its own Brain (device). */
export function twoDevices(): TwoDevices {
  const root = mkdtempSync(join(tmpdir(), "brain-sync-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  cpSync(join(__dirname, "fixtures/vault"), seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "seed");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "-u", "origin", "main");
  const pathA = join(root, "laptop-a");
  const pathB = join(root, "laptop-b");
  git(root, "clone", "-q", remote, pathA);
  git(root, "clone", "-q", remote, pathB);
  for (const p of [pathA, pathB]) {
    git(p, "config", "user.name", "t");
    git(p, "config", "user.email", "t@t");
  }
  const a = new Brain({ vault: pathA, device: "laptop-a", client: "test", dbFile: ":memory:", autoPush: false });
  const b = new Brain({ vault: pathB, device: "laptop-b", client: "test", dbFile: ":memory:", autoPush: false });
  return {
    root,
    remote,
    a,
    b,
    pathA,
    pathB,
    cleanup() {
      try { a.db.close(); } catch { /* closed */ }
      try { b.db.close(); } catch { /* closed */ }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
