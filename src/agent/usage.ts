/**
 * Claude Code usage history for the dashboard, read from the session logs Claude Code
 * keeps on this computer (`~/.claude/projects/**\/*.jsonl`). Only token counts, models,
 * dates and project folders are read out; prompts and replies are never returned.
 *
 * Each assistant reply is logged once per content block with the same usage, so replies
 * are de-duplicated by message id. Files are cached by size and mtime, so a refresh only
 * re-reads logs that grew.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

interface Reply { id: string; day: string; model: string; session: string; project: string; input: number; output: number; cacheRead: number; cacheWrite: number }
interface FileCache { size: number; mtimeMs: number; replies: Reply[] }

export interface UsageDay { date: string; messages: number; sessions: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface UsageHistory {
  days: UsageDay[];
  totals: Omit<UsageDay, "date">;
  models: { model: string; messages: number; output: number }[];
  projects: { project: string; messages: number; output: number }[];
}

const cache = new Map<string, FileCache>();

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** "/home/me/projects/shannote" → "shannote"; scratch and temp folders keep their last part too. */
const projectName = (cwd: string | undefined, dir: string) => (cwd ? basename(cwd) : dir.replace(/^-/, "").split("-").pop()) || "?";

function logFiles(root: string, since: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try { if (statSync(p).mtimeMs >= since) out.push(p); } catch { /* vanished */ }
      }
    }
  };
  walk(root, 0);
  return out;
}

async function readReplies(file: string, dir: string): Promise<Reply[]> {
  const replies: Reply[] = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    const u = j.message?.usage;
    if (j.type !== "assistant" || !u || !j.timestamp || j.message.model === "<synthetic>") continue; // <synthetic>: Claude Code's own placeholder replies
    replies.push({
      id: j.message.id ?? j.requestId ?? j.uuid,
      day: localDay(j.timestamp),
      model: j.message.model ?? "unknown",
      session: j.sessionId ?? file,
      project: projectName(j.cwd, dir),
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
  }
  return replies;
}

/** Usage per local day for the last `days` days (oldest first, every day present). */
export async function usageHistory(days = 30, root = claudeProjectsDir()): Promise<UsageHistory> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const firstDay = localDay(start.toISOString());
  const byDay = new Map<string, UsageDay & { sessionSet: Set<string> }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = localDay(d.toISOString());
    byDay.set(key, { date: key, messages: 0, sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessionSet: new Set() });
  }
  const models = new Map<string, { messages: number; output: number }>();
  const projects = new Map<string, { messages: number; output: number }>();
  const seen = new Set<string>();
  const allSessions = new Set<string>();

  if (existsSync(root)) {
    for (const file of logFiles(root, start.getTime())) {
      let st;
      try { st = statSync(file); } catch { continue; }
      let c = cache.get(file);
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
        const dir = basename(file.slice(root.length + 1).split("/")[0] ?? "");
        c = { size: st.size, mtimeMs: st.mtimeMs, replies: await readReplies(file, dir) };
        cache.set(file, c);
      }
      for (const r of c.replies) {
        if (r.day < firstDay || seen.has(r.id)) continue;
        seen.add(r.id);
        const d = byDay.get(r.day);
        if (!d) continue;
        d.messages++; d.input += r.input; d.output += r.output; d.cacheRead += r.cacheRead; d.cacheWrite += r.cacheWrite;
        d.sessionSet.add(r.session);
        allSessions.add(r.session);
        const m = models.get(r.model) ?? { messages: 0, output: 0 };
        m.messages++; m.output += r.output; models.set(r.model, m);
        const p = projects.get(r.project) ?? { messages: 0, output: 0 };
        p.messages++; p.output += r.output; projects.set(r.project, p);
      }
    }
  }

  const list = [...byDay.values()].map(({ sessionSet, ...d }) => ({ ...d, sessions: sessionSet.size }));
  const sum = (k: keyof Omit<UsageDay, "date">) => list.reduce((a, d) => a + d[k], 0);
  const byOutput = (a: { output: number }, b: { output: number }) => b.output - a.output;
  return {
    days: list,
    totals: { messages: sum("messages"), sessions: allSessions.size, input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite") },
    models: [...models].map(([model, v]) => ({ model, ...v })).sort(byOutput).slice(0, 6),
    projects: [...projects].map(([project, v]) => ({ project, ...v })).sort(byOutput).slice(0, 6),
  };
}
