/**
 * Desktop launcher: lets Shannote be opened like any other application.
 *
 * `brain app` starts the web server in the background if it isn't running and
 * opens it in its own window (a Chromium-family browser in --app mode: no tabs or
 * address bar). `brain app install` adds a launcher entry, so it shows up when you
 * search your applications. Linux uses a freedesktop .desktop file; macOS gets a
 * small .app in ~/Applications.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cacheRoot } from "./config.js";
import { ICON } from "./web/server.js";

export const APP_ID = "shannote";
/** Launcher id used before the rename; cleaned up on install/uninstall. */
const LEGACY_ID = "second-brain";

const BROWSERS = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "brave-browser",
  "brave",
  "microsoft-edge",
  "microsoft-edge-stable",
  "vivaldi",
  "thorium-browser",
];

const MAC_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function which(cmd: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** A browser that supports --app windows, or null (we'll fall back to the default browser). */
export function findAppBrowser(): string | null {
  if (process.env.BRAIN_APP_BROWSER) return process.env.BRAIN_APP_BROWSER;
  if (process.platform === "darwin") return MAC_BROWSERS.find((p) => existsSync(p)) ?? null;
  for (const b of BROWSERS) {
    const p = which(b);
    if (p) return p;
  }
  // Flatpak installs
  const flatpak = which("flatpak");
  if (flatpak) {
    for (const id of ["org.chromium.Chromium", "com.google.Chrome", "com.brave.Browser"]) {
      if (spawnSync("flatpak", ["info", id], { stdio: "ignore" }).status === 0) return `flatpak run ${id}`;
    }
  }
  return null;
}

async function isUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

const pidFile = () => join(cacheRoot(), "web.pid");
const logFile = () => join(cacheRoot(), "web.log");

/** Starts `brain web` detached (survives the window closing). Resolves once it answers. */
export async function ensureServer(port: number, cli: { node: string; script: string }, vault?: string): Promise<"running" | "started"> {
  if (await isUp(port)) return "running";
  mkdirSync(cacheRoot(), { recursive: true });
  const out = openSync(logFile(), "a");
  const args = [cli.script, "web", "--port", String(port), ...(vault ? ["--vault", vault] : [])];
  const child = spawn(cli.node, args, { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  writeFileSync(pidFile(), String(child.pid));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isUp(port)) return "started";
    if (child.exitCode !== null) break;
  }
  throw new Error(`The web server didn't start. See ${logFile()}`);
}

export function stopServer(): boolean {
  if (!existsSync(pidFile())) return false;
  const pid = Number(readFileSync(pidFile(), "utf8"));
  rmSync(pidFile(), { force: true });
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** Opens the app window. Returns how it was opened. */
export function openWindow(url: string): "app-window" | "browser-tab" {
  const browser = findAppBrowser();
  if (browser) {
    const profile = join(homedir(), ".local", "share", APP_ID, "browser-profile");
    mkdirSync(profile, { recursive: true });
    const [cmd, ...pre] = browser.split(" ");
    const args = [
      ...pre,
      `--app=${url}`,
      `--class=${APP_ID}`, // X11 window class, matches StartupWMClass in the .desktop file
      `--user-data-dir=${profile}`, // own profile: separate window, no interference with your browser
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1320,880",
    ];
    spawn(cmd!, args, { detached: true, stdio: "ignore" }).unref();
    return "app-window";
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  return "browser-tab";
}

// ---------------------------------------------------------------- install

function svgToPng(svg: string, dest: string): boolean {
  // Optional: some launchers prefer PNG. Use rsvg-convert or ImageMagick if present.
  const tmp = `${dest}.svg`;
  writeFileSync(tmp, svg);
  const tools: Array<[string, string[]]> = [
    ["rsvg-convert", ["-w", "256", "-h", "256", tmp, "-o", dest]],
    ["magick", ["-background", "none", "-density", "384", tmp, "-resize", "256x256", dest]],
    ["convert", ["-background", "none", "-density", "384", tmp, "-resize", "256x256", dest]],
  ];
  let ok = false;
  for (const [t, a] of tools) {
    if (which(t) && spawnSync(t, a, { stdio: "ignore" }).status === 0) {
      ok = true;
      break;
    }
  }
  rmSync(tmp, { force: true });
  return ok;
}

function quoteExec(s: string): string {
  // Desktop Entry spec: quote args containing spaces or reserved characters.
  return /[\s"'\\$`<>~|&;*?#()]/.test(s) ? `"${s.replace(/(["\\$`])/g, "\\$1")}"` : s;
}

export interface InstallResult {
  files: string[];
  notes: string[];
}

export function installLauncher(cli: { node: string; script: string }, opts: { port?: number } = {}): InstallResult {
  const exec = [cli.node, cli.script, "app", ...(opts.port ? ["--port", String(opts.port)] : [])];
  const files: string[] = [];
  const notes: string[] = [];
  if (removeLegacyLauncher().length) notes.push("Removed the old “Second Brain” launcher.");

  if (process.platform === "darwin") {
    const app = join(homedir(), "Applications", "Shannote.app");
    const macos = join(app, "Contents", "MacOS");
    mkdirSync(macos, { recursive: true });
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Shannote</string>
<key>CFBundleIdentifier</key><string>dev.shannote.app</string>
<key>CFBundleExecutable</key><string>shannote</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
    );
    const launcher = join(macos, "shannote");
    writeFileSync(launcher, `#!/bin/sh\nexec ${exec.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}\n`);
    chmodSync(launcher, 0o755);
    files.push(app);
    notes.push("Find it with Spotlight as “Shannote”. Icon: macOS shows a generic icon until you paste one in Get Info.");
    return { files, notes };
  }

  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const iconDir = join(dataHome, "icons", "hicolor");
  const svgPath = join(iconDir, "scalable", "apps", `${APP_ID}.svg`);
  mkdirSync(dirname(svgPath), { recursive: true });
  writeFileSync(svgPath, ICON);
  files.push(svgPath);
  const pngPath = join(iconDir, "256x256", "apps", `${APP_ID}.png`);
  mkdirSync(dirname(pngPath), { recursive: true });
  if (svgToPng(ICON, pngPath)) files.push(pngPath);

  const desktop = join(dataHome, "applications", `${APP_ID}.desktop`);
  mkdirSync(dirname(desktop), { recursive: true });
  writeFileSync(
    desktop,
    `[Desktop Entry]
Type=Application
Version=1.5
Name=Shannote
GenericName=Notes & Planner
Comment=Your markdown second brain and daily planner, made for Claude
Exec=${exec.map(quoteExec).join(" ")}
Icon=${APP_ID}
Terminal=false
Categories=Office;Utility;
Keywords=notes;brain;second brain;planner;tasks;inbox;vault;shannon;
StartupNotify=true
StartupWMClass=${APP_ID}
Actions=capture;

[Desktop Action capture]
Name=Quick capture
Exec=${[cli.node, cli.script, "app", "--path", "/#/inbox"].map(quoteExec).join(" ")}
`,
  );
  chmodSync(desktop, 0o755);
  files.push(desktop);
  if (which("update-desktop-database")) spawnSync("update-desktop-database", [dirname(desktop)], { stdio: "ignore" });
  if (which("gtk-update-icon-cache")) spawnSync("gtk-update-icon-cache", ["-f", "-t", iconDir], { stdio: "ignore" });

  if (!findAppBrowser())
    notes.push("No Chromium-based browser found, so it will open as a tab in your default browser. Install chromium for a separate app window.");
  notes.push("Search for “Shannote” in your launcher (it may take a few seconds to appear, or a re-login on some desktops).");
  return { files, notes };
}

function launcherFiles(id: string, macName: string): string[] {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return [
    join(dataHome, "applications", `${id}.desktop`),
    join(dataHome, "icons", "hicolor", "scalable", "apps", `${id}.svg`),
    join(dataHome, "icons", "hicolor", "256x256", "apps", `${id}.png`),
    join(homedir(), "Applications", `${macName}.app`),
  ];
}

/** Removes the launcher from before the rename ("Second Brain"), if present. */
export function removeLegacyLauncher(): string[] {
  const removed: string[] = [];
  for (const p of launcherFiles(LEGACY_ID, "Second Brain"))
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    }
  return removed;
}

export function uninstallLauncher(): string[] {
  const removed: string[] = removeLegacyLauncher();
  for (const p of launcherFiles(APP_ID, "Shannote")) {
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    }
  }
  return removed;
}
