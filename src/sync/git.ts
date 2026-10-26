import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PullResult {
  status: "no_repo" | "no_remote" | "offline" | "up_to_date" | "merged" | "conflicts";
  /** Files changed by the pull (other devices' work). */
  changed: string[];
  /** Conflict copies written, as `{ path, copy }`. */
  conflicts: Array<{ path: string; copy: string }>;
  error?: string;
}

export interface SyncStatus {
  repo: boolean;
  remote: boolean;
  branch?: string;
  ahead: number;
  behind: number;
  dirty: string[];
  lastPull?: string;
  lastPush?: string;
}

export interface LogEntry {
  sha: string;
  date: string;
  subject: string;
  device?: string;
  files: string[];
}

interface LocalState {
  lastPull?: string;
  lastPush?: string;
  lastSessionStart?: string;
}

const NETWORK_TIMEOUT_MS = 20_000;

/**
 * Git-backed sync. Every app write is committed immediately; pulls merge (not
 * rebase) so history is never rewritten, and conflicts never leave markers in
 * notes: the local version stays in place and the other version is saved as
 * `<name>.conflict-<timestamp>.md` next to it.
 */
export class GitSync {
  private stateFile: string;

  constructor(
    readonly root: string,
    readonly device: string,
  ) {
    this.stateFile = join(root, ".git", "brain-sync.json");
  }

  run(args: string[], opts: { timeout?: number; input?: string } = {}): GitResult {
    const r = spawnSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      timeout: opts.timeout ?? 10_000,
      input: opts.input,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
    });
    return {
      code: r.status ?? (r.error ? 1 : 0),
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
    };
  }

  private git(args: string[], opts?: { timeout?: number }): string {
    const r = this.run(args, opts);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  }

  isRepo(): boolean {
    return existsSync(join(this.root, ".git"));
  }

  hasRemote(): boolean {
    return this.isRepo() && this.run(["remote"]).stdout.split("\n").includes("origin");
  }

  branch(): string | undefined {
    const r = this.run(["symbolic-ref", "--short", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  private identityArgs(): string[] {
    const name = this.run(["config", "user.name"]).stdout.trim();
    const email = this.run(["config", "user.email"]).stdout.trim();
    const args: string[] = [];
    if (!name) args.push("-c", `user.name=shannote (${this.device})`);
    if (!email) args.push("-c", `user.email=brain@${this.device}.local`);
    return args;
  }

  readState(): LocalState {
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8")) as LocalState;
    } catch {
      return {};
    }
  }

  writeState(update: Partial<LocalState>): void {
    if (!this.isRepo()) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify({ ...this.readState(), ...update }, null, 2));
  }

  /**
   * Commits the given paths (or everything when omitted). Deletions and
   * renames are included. Returns the commit sha, or null if nothing changed.
   */
  commit(message: string, paths?: string[]): string | null {
    if (!this.isRepo()) return null;
    if (paths && paths.length) this.git(["add", "-A", "--", ...paths]);
    else this.git(["add", "-A"]);
    const staged = this.run(["diff", "--cached", "--quiet"]);
    if (staged.code === 0) return null;
    this.git([...this.identityArgs(), "commit", "-q", "--no-verify", "-m", message]);
    return this.git(["rev-parse", "--short", "HEAD"]).trim();
  }

  /** Commits edits made outside the app (Obsidian, a text editor). */
  commitExternalEdits(): string | null {
    const dirty = this.dirtyFiles();
    if (!dirty.length) return null;
    const shown = dirty.slice(0, 5).join(", ") + (dirty.length > 5 ? ` (+${dirty.length - 5})` : "");
    return this.commit(`edit(${this.device}): ${shown}`);
  }

  dirtyFiles(): string[] {
    if (!this.isRepo()) return [];
    return this.run(["status", "--porcelain", "--no-renames", "-uall", "-z"])
      .stdout.split("\0")
      .filter(Boolean)
      .map((l) => l.slice(3))
      .filter((p) => p && !p.startsWith(".git/"));
  }

  pull(): PullResult {
    const empty = { changed: [], conflicts: [] };
    if (!this.isRepo()) return { status: "no_repo", ...empty };
    if (!this.hasRemote()) return { status: "no_remote", ...empty };
    const branch = this.branch() ?? "main";

    const fetch = this.run(["fetch", "-q", "origin"], { timeout: NETWORK_TIMEOUT_MS });
    if (fetch.code !== 0) return { status: "offline", ...empty, error: fetch.stderr.trim() };
    this.writeState({ lastPull: new Date().toISOString() });

    const remoteRef = `origin/${branch}`;
    if (this.run(["rev-parse", "--verify", "-q", remoteRef]).code !== 0) {
      return { status: "up_to_date", ...empty }; // remote branch doesn't exist yet
    }
    const behind = Number(this.git(["rev-list", "--count", `HEAD..${remoteRef}`]).trim());
    if (behind === 0) return { status: "up_to_date", ...empty };

    // Never merge over uncommitted work.
    this.commitExternalEdits();
    const before = this.run(["rev-parse", "HEAD"]);
    const hasHead = before.code === 0;
    const changed = hasHead
      ? this.git(["diff", "--name-only", `HEAD...${remoteRef}`]).split("\n").filter(Boolean)
      : [];

    const merge = this.run([
      ...this.identityArgs(),
      "merge",
      "--no-edit",
      "-m",
      `merge(${this.device}): sync from origin`,
      remoteRef,
    ]);
    if (merge.code === 0) return { status: "merged", changed, conflicts: [] };

    const conflicted = this.git(["diff", "--name-only", "--diff-filter=U"])
      .split("\n")
      .filter(Boolean);
    if (!conflicted.length) {
      this.run(["merge", "--abort"]);
      return { status: "offline", ...empty, error: merge.stderr.trim() };
    }
    const conflicts = this.resolveConflicts(conflicted);
    this.git([
      ...this.identityArgs(),
      "commit",
      "-q",
      "--no-verify",
      "-m",
      `merge(${this.device}): ${conflicts.length} conflict(s) kept as copies`,
    ]);
    return { status: "conflicts", changed, conflicts };
  }

  private resolveConflicts(paths: string[]): Array<{ path: string; copy: string }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    const out: Array<{ path: string; copy: string }> = [];
    for (const p of paths) {
      const ours = this.run(["show", `:2:${p}`]);
      const theirs = this.run(["show", `:3:${p}`]);
      const abs = join(this.root, p);
      if (ours.code === 0 && theirs.code === 0) {
        const dot = p.lastIndexOf(".");
        const copy =
          dot > p.lastIndexOf("/") ? `${p.slice(0, dot)}.conflict-${stamp}${p.slice(dot)}` : `${p}.conflict-${stamp}`;
        writeFileSync(abs, ours.stdout);
        writeFileSync(join(this.root, copy), theirs.stdout);
        this.git(["add", "--", p, copy]);
        out.push({ path: p, copy });
      } else if (ours.code === 0) {
        writeFileSync(abs, ours.stdout); // deleted remotely, edited here: keep ours
        this.git(["add", "--", p]);
      } else if (theirs.code === 0) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, theirs.stdout); // deleted here, edited remotely: keep theirs
        this.git(["add", "--", p]);
      } else {
        this.git(["rm", "-q", "--cached", "--", p]);
      }
    }
    return out;
  }

  push(): { status: "no_remote" | "pushed" | "nothing" | "failed"; error?: string } {
    if (!this.hasRemote()) return { status: "no_remote" };
    const s = this.status();
    if (s.ahead === 0 && s.behind === 0 && this.run(["rev-parse", "--verify", "-q", "@{u}"]).code === 0)
      return { status: "nothing" };
    let r = this.run(["push", "-q", "-u", "origin", "HEAD"], { timeout: NETWORK_TIMEOUT_MS });
    if (r.code !== 0 && /non-fast-forward|fetch first|rejected/i.test(r.stderr)) {
      this.pull();
      r = this.run(["push", "-q", "-u", "origin", "HEAD"], { timeout: NETWORK_TIMEOUT_MS });
    }
    if (r.code !== 0) return { status: "failed", error: r.stderr.trim() };
    this.writeState({ lastPush: new Date().toISOString() });
    return { status: "pushed" };
  }

  status(): SyncStatus {
    const state = this.readState();
    if (!this.isRepo()) return { repo: false, remote: false, ahead: 0, behind: 0, dirty: [] };
    let ahead = 0;
    let behind = 0;
    const counts = this.run(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    if (counts.code === 0) {
      const [a, b] = counts.stdout.trim().split(/\s+/).map(Number);
      ahead = a ?? 0;
      behind = b ?? 0;
    } else if (this.hasRemote() && this.run(["rev-parse", "--verify", "-q", "HEAD"]).code === 0) {
      // Remote exists but this branch was never pushed: everything is unpushed.
      ahead = Number(this.run(["rev-list", "--count", "HEAD"]).stdout.trim()) || 0;
    }
    return {
      repo: true,
      remote: this.hasRemote(),
      branch: this.branch(),
      ahead,
      behind,
      dirty: this.dirtyFiles(),
      lastPull: state.lastPull,
      lastPush: state.lastPush,
    };
  }

  log(opts: { since?: string; limit?: number; path?: string } = {}): LogEntry[] {
    if (!this.isRepo() || this.run(["rev-parse", "--verify", "-q", "HEAD"]).code !== 0) return [];
    const args = [
      "log",
      `-n${opts.limit ?? 50}`,
      "--no-merges",
      "--name-only",
      "--format=%x1e%h%x1f%aI%x1f%s",
    ];
    if (opts.since) args.push(`--since=${opts.since}`);
    if (opts.path) args.push("--", opts.path);
    return this.git(args)
      .split("\x1e")
      .filter((b) => b.trim())
      .map((block) => {
        const [header, ...rest] = block.split("\n");
        const [sha, date, subject] = header!.split("\x1f") as [string, string, string];
        const device = subject.match(/^\w+\(([^)]+)\):/)?.[1];
        return { sha, date, subject, device, files: rest.map((f) => f.trim()).filter(Boolean) };
      });
  }
}
