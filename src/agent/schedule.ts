/**
 * Scheduled briefs: systemd user timers on Linux, launchd LaunchAgents on macOS. Unlike
 * cron, both run a brief that was missed while the laptop slept once it wakes up (systemd
 * also after a reboot, thanks to `Persistent=true`), and `brief --if-missing` makes that
 * catch-up run a no-op if the brief already exists.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { launchAgentsDir, launchdInstall, launchdRemove, plist, servicePath, unitDir } from "./service.js";

export { unitDir };

export type BriefKind = "morning" | "evening";

export interface ScheduleUnit { kind: BriefKind; time: string }

const unitName = (kind: BriefKind) => `shannote-brief-${kind}`;
const agentLabel = (kind: BriefKind) => `com.shannote.brief-${kind}`;

/** The LaunchAgent for one brief on macOS. */
export function briefPlist(o: ScheduleUnit & { node: string; cli: string; vault: string; log: string }): string {
  const [hour, minute] = o.time.split(":").map(Number) as [number, number];
  return plist({ label: agentLabel(o.kind), args: [o.node, o.cli, "--vault", o.vault, "brief", o.kind, "--if-missing"], log: o.log, path: servicePath(o.node), at: { hour, minute } });
}

/** "7:30" / "07:30" → "07:30"; throws on anything else. */
export function parseTime(t: string): string {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Use a 24-hour time like 07:30, not "${t}"`);
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

/** The .service and .timer for one brief. Paths are absolute so the timer doesn't depend on a login shell. */
export function units(o: ScheduleUnit & { node: string; cli: string; vault: string; log: string }) {
  const q = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/["\\]/g, "\\$&")}"` : s);
  const label = o.kind === "morning" ? "morning brief" : "evening review";
  const service = `[Unit]
Description=Shannote ${label}
After=network-online.target

[Service]
Type=oneshot
ExecStart=${[o.node, o.cli, "--vault", o.vault, "brief", o.kind, "--if-missing"].map(q).join(" ")}
Environment=PATH=${[dirname(o.node), join(homedir(), ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"].join(":")}
StandardOutput=append:${o.log}
StandardError=append:${o.log}
`;
  const timer = `[Unit]
Description=Shannote ${label} at ${o.time}

[Timer]
OnCalendar=*-*-* ${o.time}:00
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

const systemctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function installSchedule(list: ScheduleUnit[], o: { node: string; cli: string; vault: string; log: string }): string[] {
  if (process.platform === "darwin") {
    mkdirSync(dirname(o.log), { recursive: true });
    for (const u of list) launchdInstall(agentLabel(u.kind), briefPlist({ ...u, ...o }));
    return list.map((u) => `${agentLabel(u.kind)}.plist`);
  }
  if (process.platform !== "linux") throw new Error("Automatic scheduling is set up for Linux (systemd) and macOS (launchd). `shannote schedule` shows a cron line you can use instead.");
  mkdirSync(unitDir(), { recursive: true });
  mkdirSync(dirname(o.log), { recursive: true });
  const written: string[] = [];
  for (const u of list) {
    const { service, timer } = units({ ...u, ...o });
    writeFileSync(join(unitDir(), `${unitName(u.kind)}.service`), service);
    writeFileSync(join(unitDir(), `${unitName(u.kind)}.timer`), timer);
    written.push(`${unitName(u.kind)}.timer`);
  }
  systemctl("daemon-reload");
  for (const t of written) systemctl("enable", "--now", t);
  return written;
}

export function removeSchedule(kinds: BriefKind[] = ["morning", "evening"]): string[] {
  if (process.platform === "darwin") return kinds.filter((k) => launchdRemove(agentLabel(k))).map((k) => `${agentLabel(k)}.plist`);
  const removed: string[] = [];
  for (const kind of kinds) {
    const timer = join(unitDir(), `${unitName(kind)}.timer`);
    if (!existsSync(timer)) continue;
    try { systemctl("disable", "--now", `${unitName(kind)}.timer`); } catch { /* already stopped */ }
    rmSync(timer, { force: true });
    rmSync(join(unitDir(), `${unitName(kind)}.service`), { force: true });
    removed.push(`${unitName(kind)}.timer`);
  }
  if (removed.length) systemctl("daemon-reload");
  return removed;
}

/** Installed briefs and when they next run, from systemd. */
export function scheduleStatus(): { kind: BriefKind; next: string | null; last: string | null }[] {
  const found: { kind: BriefKind; next: string | null; last: string | null }[] = [];
  if (process.platform === "darwin") {
    for (const kind of ["morning", "evening"] as BriefKind[]) {
      const file = join(launchAgentsDir(), `${agentLabel(kind)}.plist`);
      if (!existsSync(file)) continue;
      const m = readFileSync(file, "utf8").match(/<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/);
      found.push({ kind, next: m ? `daily at ${m[1]!.padStart(2, "0")}:${m[2]!.padStart(2, "0")}` : "daily", last: null });
    }
    return found;
  }
  for (const kind of ["morning", "evening"] as BriefKind[]) {
    if (!existsSync(join(unitDir(), `${unitName(kind)}.timer`))) continue;
    let next: string | null = null, last: string | null = null;
    try {
      const props = systemctl("show", `${unitName(kind)}.timer`, "--property=NextElapseUSecRealtime,LastTriggerUSec");
      next = props.match(/NextElapseUSecRealtime=(.+)/)?.[1]?.trim() || null;
      last = props.match(/LastTriggerUSec=(.+)/)?.[1]?.trim() || null;
      if (last === "n/a") last = null;
    } catch { /* systemd not reachable */ }
    found.push({ kind, next, last });
  }
  return found;
}
