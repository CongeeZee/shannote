/**
 * Shannote as an always-on server, for a spare laptop that your phone (and other devices)
 * reach over Tailscale. macOS uses launchd (a LaunchAgent that starts at login and is kept
 * alive), Linux a systemd user service. The server listens on 127.0.0.1 only; `tailscale
 * serve` gives it an HTTPS address on your tailnet (HTTPS is what lets a phone browser use
 * the microphone), and every request coming through it must carry the web token.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServerOptions { node: string; cli: string; vault: string; log: string; port: number }

export const unitDir = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
const SERVER_LABEL = "com.shannote.server";
const SERVER_UNIT = "shannote-server";

// ------------------------------------------------------------------ launchd (macOS)

export const launchAgentsDir = () => join(homedir(), "Library", "LaunchAgents");
const plistPath = (label: string) => join(launchAgentsDir(), `${label}.plist`);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A LaunchAgent: either kept running (`keepAlive`) or started at a time of day (`at`). */
export function plist(o: { label: string; args: string[]; log: string; path: string; keepAlive?: boolean; at?: { hour: number; minute: number } }): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xml(o.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...o.args.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    `  <dict><key>PATH</key><string>${xml(o.path)}</string></dict>`,
    `  <key>WorkingDirectory</key><string>${xml(homedir())}</string>`,
    `  <key>StandardOutPath</key><string>${xml(o.log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(o.log)}</string>`,
  ];
  if (o.keepAlive) lines.push("  <key>RunAtLoad</key><true/>", "  <key>KeepAlive</key><true/>");
  if (o.at)
    lines.push( // launchd runs a missed time once the Mac wakes up
      "  <key>StartCalendarInterval</key>",
      `  <dict><key>Hour</key><integer>${o.at.hour}</integer><key>Minute</key><integer>${o.at.minute}</integer></dict>`,
    );
  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

const uid = () => String(process.getuid?.() ?? "");
const launchctl = (...args: string[]) => execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function launchdInstall(label: string, body: string): void {
  mkdirSync(launchAgentsDir(), { recursive: true });
  launchdRemove(label); // replace an older version cleanly
  writeFileSync(plistPath(label), body);
  try { launchctl("bootstrap", `gui/${uid()}`, plistPath(label)); }
  catch { launchctl("load", "-w", plistPath(label)); } // older macOS
}

export function launchdRemove(label: string): boolean {
  if (!existsSync(plistPath(label))) return false;
  try { launchctl("bootout", `gui/${uid()}/${label}`); }
  catch { try { launchctl("unload", "-w", plistPath(label)); } catch { /* wasn't loaded */ } }
  rmSync(plistPath(label), { force: true });
  return true;
}

export function launchdRunning(label: string): boolean {
  try { return /\bpid = \d+/.test(launchctl("print", `gui/${uid()}/${label}`)); } catch { return false; }
}

// ------------------------------------------------------------------ the server

/** PATH for the service: node's folder first, so `claude` and git are found without a login shell. */
export const servicePath = (node: string) =>
  [dirname(node), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

export const serverArgs = (o: ServerOptions) => [o.node, o.cli, "--vault", o.vault, "web", "--remote", "--port", String(o.port)];

export function serverUnit(o: ServerOptions): string {
  const q = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/["\\]/g, "\\$&")}"` : s);
  return `[Unit]
Description=Shannote server (reachable over Tailscale)
After=network-online.target

[Service]
ExecStart=${serverArgs(o).map(q).join(" ")}
Restart=always
RestartSec=5
Environment=PATH=${servicePath(o.node)}
StandardOutput=append:${o.log}
StandardError=append:${o.log}

[Install]
WantedBy=default.target
`;
}

export function serverPlist(o: ServerOptions): string {
  // caffeinate -i keeps the Mac from idle-sleeping while the server runs (closing the lid still
  // sleeps it unless sleep is disabled; see docs/SERVER.md).
  return plist({ label: SERVER_LABEL, args: ["/usr/bin/caffeinate", "-i", ...serverArgs(o)], log: o.log, path: servicePath(o.node), keepAlive: true });
}

const systemctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function installServer(o: ServerOptions): string {
  mkdirSync(dirname(o.log), { recursive: true });
  if (process.platform === "darwin") {
    launchdInstall(SERVER_LABEL, serverPlist(o));
    return `${plistPath(SERVER_LABEL)} (launchd: starts at login, restarts if it stops)`;
  }
  if (process.platform === "linux") {
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), `${SERVER_UNIT}.service`), serverUnit(o));
    systemctl("daemon-reload");
    systemctl("enable", "--now", `${SERVER_UNIT}.service`);
    systemctl("restart", `${SERVER_UNIT}.service`);
    return `${SERVER_UNIT}.service (systemd user service; run \`loginctl enable-linger\` to keep it up while logged out)`;
  }
  throw new Error("The always-on server is set up for macOS and Linux only.");
}

export function removeServer(): boolean {
  if (process.platform === "darwin") return launchdRemove(SERVER_LABEL);
  const unit = join(unitDir(), `${SERVER_UNIT}.service`);
  if (process.platform !== "linux" || !existsSync(unit)) return false;
  try { systemctl("disable", "--now", `${SERVER_UNIT}.service`); } catch { /* already stopped */ }
  rmSync(unit, { force: true });
  systemctl("daemon-reload");
  return true;
}

export function serverStatus(): { installed: boolean; running: boolean } {
  if (process.platform === "darwin") return { installed: existsSync(plistPath(SERVER_LABEL)), running: launchdRunning(SERVER_LABEL) };
  if (process.platform === "linux") {
    const installed = existsSync(join(unitDir(), `${SERVER_UNIT}.service`));
    let running = false;
    try { running = systemctl("is-active", `${SERVER_UNIT}.service`).trim() === "active"; } catch { /* inactive */ }
    return { installed, running };
  }
  return { installed: false, running: false };
}

// ------------------------------------------------------------------ Tailscale

/** This machine's name on the tailnet (e.g. "macbook.tail1234.ts.net"), or why there isn't one. */
export function tailscaleName(): { name?: string; problem?: string } {
  let out: string;
  try { out = execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch { return { problem: "Tailscale isn't installed (or its command-line tool isn't on PATH)." }; }
  try {
    const j = JSON.parse(out) as { BackendState?: string; Self?: { DNSName?: string } };
    if (j.BackendState !== "Running") return { problem: "Tailscale is installed but not signed in. Sign in, then run this again." };
    const name = j.Self?.DNSName?.replace(/\.$/, "");
    return name ? { name } : { problem: "Tailscale didn't report a name for this machine (is MagicDNS on?)." };
  } catch { return { problem: "Couldn't read `tailscale status`." }; }
}

/** `tailscale serve --bg <port>`: HTTPS on the tailnet name, relayed to the local server. */
export function tailscaleServe(port: number): { ok: boolean; message: string } {
  try {
    execFileSync("tailscale", ["serve", "--bg", String(port)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    return { ok: true, message: "" };
  } catch (e) {
    const err = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").slice(0, 3).join(" ");
    return { ok: false, message: err };
  }
}
