#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { assertNotCodeRepo, deviceName, indexPath, resolveVault, saveConfig } from "./config.js";
import { openDb } from "./index/db.js";
import { indexVault } from "./index/indexer.js";
import { doctor, vaultStatus } from "./index/queries.js";
import { embedderFromEnv } from "./search/embed.js";
import { embedPending, hybridSearch, VectorStore, type SearchMode } from "./search/semantic.js";
import { initVault } from "./vault/init.js";
import { Brain } from "./core.js";

const HELP = `shannote — a markdown second brain operated through Claude
(\`brain\` is a short alias for every command below)

Usage:
  brain init <path> [--device <name>]   Create a vault (or adopt an existing folder)
  brain index [--rebuild]               Update the search index
  brain status                          Vault and task counts
  brain search <query> [--mode hybrid|keyword|semantic] [--folder F] [--tag T] [--limit N]
  brain embed                           Build the semantic index (downloads a ~23 MB model once)
  brain doctor                          Broken links, bad frontmatter, duplicate names
  brain web [--port 4567] [--open]      Local web app at http://localhost:4567
            [--lan] [--new-token]       …also reachable from your phone with a secret link
  brain app [--port 4567]               Open the web app in its own window (starts it if needed)
  brain app install | uninstall | stop  Add/remove Shannote in your applications menu
  brain serve [--client NAME]           MCP server over stdio (for Claude Desktop / Code)
  brain sync                            Pull, commit outside edits, push
  brain calendar add <ics-url> [--name N] | list | remove <n> | show [date]
                                        Read-only calendars from private iCal URLs
  brain plan morning|evening|weekly|meeting [--date D] [--event E]
                                        Print a planning prompt (what Claude gets)
  brain brief morning|evening [--if-missing]
                                        Have Claude Code write today's brief/review now (subscription)
  brain schedule                        Show scheduled briefs (or a cron line on other systems)
  brain schedule install [--morning 07:30] [--evening HH:MM]
                                        Run the brief daily (systemd timer; catches up after sleep)
  brain schedule remove                 Stop scheduled briefs

Sharing (each shared space is its own git repo under shared/; the rest of the vault stays private):
  brain share create <name> [--github]  New shared space (--github: make a private GitHub repo for it)
  brain share invite <space> <github-user>   Give a GitHub user edit access (needs gh)
  brain share join <git-url> [--name N] Clone a space someone shared with you
  brain share guest <space> <person> [--read-only]
                                        Browser link for someone without GitHub (see docs/SHARING.md)
  brain share url <https://…>           Public address for guest links (e.g. Tailscale Funnel)
  brain share list | revoke <guest|space>

Global options:
  --vault <path>   Vault to use (default: BRAIN_VAULT or the path saved by init)
  --json           Machine-readable output
  -h, --help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    vault: { type: "string" },
    device: { type: "string" },
    rebuild: { type: "boolean", default: false },
    folder: { type: "string" },
    tag: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean", default: false },
    port: { type: "string" },
    open: { type: "boolean", default: false },
    lan: { type: "boolean", default: false },
    "new-token": { type: "boolean", default: false },
    path: { type: "string" },
    client: { type: "string" },
    mode: { type: "string" },
    name: { type: "string" },
    date: { type: "string" },
    github: { type: "boolean", default: false },
    "read-only": { type: "boolean", default: false },
    event: { type: "string" },
    morning: { type: "string" },
    evening: { type: "string" },
    "if-missing": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [cmd, ...args] = positionals;
const out = (data: unknown, text: () => string) =>
  console.log(values.json ? JSON.stringify(data, null, 2) : text());

async function withIndex<T>(fn: (db: ReturnType<typeof openDb>, vault: string) => Promise<T> | T) {
  const vault = resolveVault(values.vault);
  const db = openDb(indexPath(vault));
  try {
    return await fn(db, vault);
  } finally {
    db.close();
  }
}

async function main(): Promise<number> {
  if (values.help || !cmd) {
    console.log(HELP);
    return 0;
  }

  switch (cmd) {
    case "init": {
      const given = args[0] ?? values.vault;
      if (!given) {
        console.error("Say where the vault should go, e.g. `brain init ~/vault` (use `brain init .` for the current folder).");
        return 1;
      }
      const target = resolve(given.replace(/^~(?=$|\/)/, homedir()));
      assertNotCodeRepo(target);
      const result = initVault(target);
      const cfg = saveConfig({ vault: target, device: values.device ?? deviceName() });
      out({ vault: target, device: cfg.device, ...result }, () =>
        [
          `Vault: ${target}`,
          `Device: ${cfg.device}`,
          result.created.length ? `Created: ${result.created.join(", ")}` : "Nothing new to create",
          result.skipped.length ? `Kept existing: ${result.skipped.join(", ")}` : "",
          result.gitInitialised ? "Initialised git repository" : "",
          "",
          "Next: add a private remote and push, then run `brain index`.",
        ]
          .filter((l) => l !== "")
          .join("\n"),
      );
      return 0;
    }

    case "index":
      return withIndex(async (db, vault) => {
        const r = await indexVault(db, vault, { rebuild: values.rebuild });
        out(r, () =>
          `Indexed ${r.total} notes in ${r.durationMs} ms ` +
          `(${r.added} added, ${r.updated} updated, ${r.removed} removed, ${r.unchanged} unchanged)`,
        );
        return 0;
      });

    case "status":
      return withIndex(async (db, vault) => {
        await indexVault(db, vault);
        const s = vaultStatus(db);
        out({ vault, device: deviceName(), ...s }, () =>
          [
            `Vault:   ${vault}`,
            `Device:  ${deviceName()}`,
            `Notes:   ${s.notes} (${s.words.toLocaleString()} words)`,
            `Links:   ${s.links} (${s.unresolvedLinks} unresolved)`,
            `Tags:    ${s.tags}`,
            `Tasks:   ${s.tasks.open} open · ${s.tasks.dueToday} due today · ${s.tasks.overdue} overdue · ${s.tasks.done} done`,
          ].join("\n"),
        );
        return 0;
      });

    case "search": {
      const query = args.join(" ").trim();
      if (!query) {
        console.error("usage: brain search <query>");
        return 1;
      }
      return withIndex(async (db, vault) => {
        await indexVault(db, vault);
        const mode = (values.mode ?? "hybrid") as SearchMode;
        const embedder = mode === "keyword" ? null : embedderFromEnv();
        const r = await hybridSearch(db, embedder ? new VectorStore(db, embedder.id) : null, embedder, query, {
          folder: values.folder,
          tag: values.tag,
          limit: values.limit ? Number(values.limit) : 10,
          mode,
        });
        out(r, () =>
          (r.semantic === "unavailable" && mode !== "keyword" ? "(semantic index empty: run `brain embed`; keyword results only)\n" : "") +
          (r.hits.length
            ? r.hits
                .map((h, i) => `${i + 1}. ${h.title}  (${h.path}${h.section ? ` › ${h.section}` : ""})  [${h.matched.join("+")}]\n   ${h.snippet}`)
                .join("\n")
            : "No results."),
        );
        return 0;
      });
    }

    case "embed":
      return withIndex(async (db, vault) => {
        await indexVault(db, vault);
        const embedder = embedderFromEnv();
        if (!embedder) {
          console.error("Embeddings are turned off (BRAIN_EMBEDDINGS=off).");
          return 1;
        }
        const t0 = Date.now();
        process.stderr.write(`Loading ${embedder.id} (first run downloads it)…\n`);
        const n = await embedPending(db, embedder, {
          onProgress: ({ done, total }) => {
            if (done === total || done % 160 === 0) process.stderr.write(`\rEmbedding sections: ${done}/${total}`);
          },
        });
        process.stderr.write(n ? "\n" : "");
        out({ embedded: n, model: embedder.id, seconds: (Date.now() - t0) / 1000 }, () =>
          n ? `Embedded ${n} sections in ${((Date.now() - t0) / 1000).toFixed(1)}s.` : "Semantic index is up to date.",
        );
        return 0;
      });

    case "calendar": {
      const { loadConfig, saveConfig: save } = await import("./config.js");
      const { eventsBetween } = await import("./plan/calendar.js");
      const cfg = loadConfig() as { calendars?: Array<{ url: string; name?: string }> };
      const cals = cfg.calendars ?? [];
      const sub = args[0] ?? "list";
      if (sub === "add") {
        const url = args[1];
        if (!url) {
          console.error("usage: brain calendar add <ics-url> [--name Uni]");
          return 1;
        }
        const entry = { url, name: values.name ?? `calendar ${cals.length + 1}` };
        try {
          const r = await eventsBetween(new Date().toISOString().slice(0, 10), new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), [entry]);
          if (r.errors.length) throw new Error(r.errors.join("; "));
          console.log(`Added "${entry.name}" (${r.events.length} events in the next 7 days).`);
        } catch (e) {
          console.error(`Couldn't read that calendar: ${(e as Error).message}`);
          return 1;
        }
        save({ calendars: [...cals, entry] } as never);
        console.log("Stored in ~/.config/shannote/config.json (this device only; the URL is a secret).");
        return 0;
      }
      if (sub === "remove") {
        const i = Number(args[1]) - 1;
        if (!(i >= 0 && i < cals.length)) {
          console.error("usage: brain calendar remove <number from `brain calendar list`>");
          return 1;
        }
        const [gone] = cals.splice(i, 1);
        save({ calendars: cals } as never);
        console.log(`Removed "${gone!.name}".`);
        return 0;
      }
      if (sub === "show") {
        const { localDate } = await import("./util.js");
        const day = args[1] ?? values.date ?? localDate();
        const r = await eventsBetween(day, day);
        if (!r.configured) console.log("No calendars yet. Add one with `brain calendar add <ics-url>`.");
        for (const e of r.events)
          console.log(e.allDay ? `  all day  ${e.title}` : `  ${e.start.slice(11, 16)}–${e.end.slice(11, 16)}  ${e.title}${e.location ? `  (${e.location})` : ""}`);
        for (const err of r.errors) console.error(`  ! ${err}`);
        return 0;
      }
      if (!cals.length) console.log("No calendars yet. Add one with `brain calendar add <ics-url> --name Uni`.");
      cals.forEach((c, i) => console.log(`${i + 1}. ${c.name}  ${c.url.replace(/(private-)[^/]+/, "$1…")}`));
      return 0;
    }

    case "plan": {
      const kind = args[0] as "morning" | "evening" | "weekly" | "meeting";
      if (!["morning", "evening", "weekly", "meeting"].includes(kind)) {
        console.error("usage: brain plan morning|evening|weekly|meeting [--date YYYY-MM-DD] [--event TITLE]");
        return 1;
      }
      const { renderPrompt } = await import("./plan/planning.js");
      const brain = new Brain({ vault: resolveVault(values.vault), device: deviceName(), autoPush: false, trackSessions: false, embedder: embedderFromEnv(), backgroundEmbed: false });
      try {
        console.log(renderPrompt(kind, await brain.planContext(kind, { date: values.date, event: values.event })));
      } finally {
        brain.shutdown();
      }
      return 0;
    }

    case "brief": {
      const kind = (args[0] ?? "morning") as "morning" | "evening";
      if (kind !== "morning" && kind !== "evening") {
        console.error("Usage: brain brief morning|evening [--if-missing]");
        return 1;
      }
      const vault = resolveVault(values.vault);
      const { readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { localDate } = await import("./util.js");
      const { sectionOf } = await import("./plan/schedule.js");
      const stamp = () => new Date().toLocaleString();
      if (values["if-missing"]) {
        // Catch-up runs after sleep: skip if it's already written, or if it's too late to be useful.
        const daily = join(vault, "daily", `${localDate()}.md`);
        const section = kind === "morning" ? "Plan" : "Review";
        const written = existsSync(daily) && (sectionOf(readFileSync(daily, "utf8"), section) ?? "").trim().length > 0;
        const hour = new Date().getHours();
        const tooLate = kind === "morning" ? hour >= 14 : hour < 12;
        if (written || tooLate) {
          console.log(`[${stamp()}] ${kind}: skipped (${written ? `today's ${section} section is already written` : "too late in the day"})`);
          return 0;
        }
      }
      const { findClaude, runClaude, saveUsage, loadUsage, UNATTENDED } = await import("./agent/claude.js");
      const bin = findClaude();
      if (!bin) {
        console.error(`[${stamp()}] ${kind}: Claude Code (claude) isn't installed or isn't on PATH.`);
        return 1;
      }
      const prompt = kind === "morning"
        ? `Run my morning brief: call brain_plan with kind morning and follow its instructions.
If Google Calendar is connected, also list today's events from all my calendars and add any that brain_calendar missed to the Schedule section.
If Gmail is connected, finish the Plan section with a "**Email**" list: at most 5 important emails from the last day that need me (who, what it's about, what I need to do), or "Nothing important". Skip promotions, newsletters and game or app notifications.`
        : "Run my evening review: call brain_plan with kind evening and follow its instructions.";
      let failed: string | null = null;
      let text = "";
      const usage = loadUsage();
      await runClaude({
        prompt, vault, bin, node: process.execPath, cli: process.argv[1]!, client: "scheduled", system: UNATTENDED(localDate()),
        onEvent: (e) => {
          if (e.type === "text") text += e.text;
          else if (e.type === "tool") console.log(`[${stamp()}] ${kind}: ${e.name}${e.detail ? ` · ${e.detail}` : ""}`);
          else if (e.type === "usage") saveUsage({ ...e.usage, model: usage?.model });
          else if (e.type === "error") failed = e.message;
        },
      }).done;
      if (failed) {
        console.error(`[${stamp()}] ${kind}: failed: ${failed}`);
        return 1;
      }
      console.log(`[${stamp()}] ${kind}: done. ${text.trim().replace(/\s*\n\s*/g, " ")}`);
      return 0;
    }

    case "schedule": {
      const { installSchedule, removeSchedule, scheduleStatus, parseTime } = await import("./agent/schedule.js");
      const { cacheRoot } = await import("./config.js");
      const { join } = await import("node:path");
      const log = join(cacheRoot(), "scheduled.log");
      if (args[0] === "install") {
        const list: { kind: "morning" | "evening"; time: string }[] = [{ kind: "morning", time: parseTime(values.morning ?? "07:30") }];
        if (values.evening) list.push({ kind: "evening", time: parseTime(values.evening) });
        const vault = resolveVault(values.vault);
        const done = installSchedule(list, { node: process.execPath, cli: process.argv[1]!, vault, log });
        console.log(`Scheduled ${list.map((u) => `${u.kind === "morning" ? "morning brief" : "evening review"} at ${u.time}`).join(" and ")} (${done.join(", ")}).
If the laptop is asleep or off then, it runs when it wakes up, unless the brief is already written
or it's past 2pm (morning) / before noon (evening). Log: ${log}
Each run uses a little of your Claude subscription. Undo with \`shannote schedule remove\`.`);
        return 0;
      }
      if (args[0] === "remove") {
        const removed = removeSchedule();
        console.log(removed.length ? `Removed ${removed.join(", ")}.` : "No scheduled briefs were installed.");
        return 0;
      }
      const status = process.platform === "linux" ? scheduleStatus() : [];
      if (status.length) {
        for (const s of status) console.log(`${s.kind === "morning" ? "Morning brief" : "Evening review"}: next ${s.next ?? "?"}${s.last ? `, last ran ${s.last}` : ""}`);
        console.log(`Log: ${log}. Change times with \`shannote schedule install --morning HH:MM\`.`);
        return 0;
      }
      const [mh, mm] = parseTime(values.morning ?? "07:30").split(":");
      console.log(`No scheduled briefs yet.${process.platform === "linux" ? " Set one up with: shannote schedule install [--morning 07:30] [--evening 21:30]" : ""}

${process.platform === "linux" ? "Or, with" : "With"} cron (\`crontab -e\`; missed runs don't catch up):
   ${Number(mm)} ${Number(mh)} * * * ${process.execPath} ${process.argv[1]} brief morning --if-missing >> ${log} 2>&1`);
      return 0;
    }

    case "doctor":
      return withIndex(async (db, vault) => {
        await indexVault(db, vault);
        const r = doctor(db);
        out(r, () => {
          const lines: string[] = [];
          lines.push(`Frontmatter errors: ${r.frontmatterErrors.length}`);
          for (const e of r.frontmatterErrors) lines.push(`  ${e.path}: ${e.error}`);
          lines.push(`Unresolved link targets: ${r.unresolvedLinks.length}`);
          for (const u of r.unresolvedLinks.slice(0, 25))
            lines.push(`  [[${u.target}]] ×${u.count} — from ${u.from.slice(0, 3).join(", ")}`);
          lines.push(`Ambiguous note names: ${r.ambiguousNames.length}`);
          for (const a of r.ambiguousNames) lines.push(`  ${a.name}: ${a.paths.join(", ")}`);
          lines.push(`Empty notes: ${r.emptyNotes.length}`);
          for (const p of r.emptyNotes) lines.push(`  ${p}`);
          return lines.join("\n");
        });
        return 0;
      });

    case "serve": {
      // stdout is the MCP channel: nothing else may be printed to it.
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { createMcpServer } = await import("./mcp/server.js");
      const brain = new Brain({
        vault: resolveVault(values.vault),
        device: deviceName(),
        client: values.client ?? "mcp",
        embedder: embedderFromEnv(),
      });
      const server = createMcpServer(brain);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          brain.shutdown();
        } finally {
          process.exit(0);
        }
      };
      process.on("SIGINT", close);
      process.on("SIGTERM", close);
      process.stdin.on("close", close);
      await server.connect(new StdioServerTransport());
      process.stderr.write(`[brain] MCP server ready (vault ${brain.vault}, device ${brain.device})\n`);
      return new Promise<number>(() => {}); // run until the client disconnects
    }

    case "app": {
      const app = await import("./app.js");
      const { fileURLToPath } = await import("node:url");
      const cli = { node: process.execPath, script: fileURLToPath(import.meta.url) };
      const sub = args[0];
      if (sub === "install") {
        // Make sure the vault is configured before adding a launcher that depends on it.
        resolveVault(values.vault);
        const r = app.installLauncher(cli, { port: values.port ? Number(values.port) : undefined });
        console.log(`Installed:\n${r.files.map((f) => `  ${f}`).join("\n")}\n\n${r.notes.join("\n")}`);
        return 0;
      }
      if (sub === "uninstall") {
        const removed = app.uninstallLauncher();
        console.log(removed.length ? `Removed:\n${removed.map((f) => `  ${f}`).join("\n")}` : "Nothing to remove.");
        return 0;
      }
      if (sub === "stop") {
        console.log(app.stopServer() ? "Stopped the background web server." : "No background web server was running (that this command started).");
        return 0;
      }
      const port = Number(values.port ?? 4567);
      const state = await app.ensureServer(port, cli, values.vault);
      const how = app.openWindow(`http://localhost:${port}${values.path ?? "/#/today"}`);
      console.log(`${state === "started" ? "Started the server and opened" : "Opened"} Shannote${how === "browser-tab" ? " in your default browser" : ""}. It keeps running in the background; \`brain app stop\` stops it.`);
      return 0;
    }

    case "web": {
      const { startWebServer } = await import("./web/server.js");
      const port = Number(values.port ?? 4567);
      const brain = new Brain({
        vault: resolveVault(values.vault),
        device: deviceName(),
        client: "web",
        trackSessions: false,
        embedder: embedderFromEnv(),
      });
      await brain.fresh();
      let lanToken: string | undefined;
      if (values.lan) {
        const { loadConfig, saveConfig: save } = await import("./config.js");
        const { randomBytes } = await import("node:crypto");
        lanToken = (loadConfig() as { webToken?: string }).webToken;
        if (!lanToken || values["new-token"]) {
          lanToken = randomBytes(18).toString("base64url");
          save({ webToken: lanToken } as never);
        }
      }
      const server = startWebServer(brain, port, values.lan ? "0.0.0.0" : "127.0.0.1", { lanToken });
      server.on("error", (e: NodeJS.ErrnoException) => {
        console.error(e.code === "EADDRINUSE" ? `Port ${port} is in use. Try --port ${port + 1}.` : e.message);
        process.exit(1);
      });
      server.on("listening", () => {
        const url = `http://localhost:${port}`;
        console.log(`Shannote is running at ${url}  (vault ${brain.vault})`);
        if (lanToken) {
          import("node:os").then(({ networkInterfaces }) => {
            const ips = Object.values(networkInterfaces())
              .flat()
              .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal)
              .map((i) => i.address);
            console.log("\nOn your phone (same Wi-Fi or Tailscale), open once:");
            for (const ip of ips) console.log(`  http://${ip}:${port}/?token=${lanToken}`);
            console.log("Then use your browser's \"Add to Home Screen\". The link is a password: anyone with it can read your notes.");
            console.log("Plain Wi-Fi isn't encrypted; prefer Tailscale or a network you trust. `--new-token` revokes the old link.");
            console.log("\nPress Ctrl+C to stop.");
          });
        } else console.log("Press Ctrl+C to stop.");
        if (values.open) {
          const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
          import("node:child_process").then(({ spawn }) => spawn(opener, [url], { stdio: "ignore", detached: true }).unref());
        }
      });
      const stop = () => {
        brain.shutdown();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return new Promise<number>(() => {});
    }

    case "share": {
      const sp = await import("./share/spaces.js");
      const { loadConfig, saveConfig: save } = await import("./config.js");
      const { spawnSync } = await import("node:child_process");
      const vault = resolveVault(values.vault);
      const sub = args[0] ?? "list";
      const gh = (a: string[], cwd?: string) => {
        const r = spawnSync("gh", a, { cwd, encoding: "utf8", timeout: 60_000 });
        if (r.error) throw new Error("This needs the GitHub CLI (`gh`). Install it and run `gh auth login`.");
        if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim());
        return r.stdout.trim();
      };
      const publicUrl = (loadConfig() as { publicUrl?: string }).publicUrl;

      if (sub === "create") {
        const name = args.slice(1).join(" ").trim();
        if (!name) throw new Error("Usage: brain share create <name> [--github]");
        const s = sp.createSpace(vault, name, deviceName());
        console.log(`Created ${s.dir}/ ("${s.name}"). Notes in that folder are shared; everything else stays private.`);
        if (values.github) {
          const repoName = `shannote-${s.slug}`;
          gh(["repo", "create", repoName, "--private", "--source=.", "--push"], `${vault}/${s.dir}`);
          console.log(`Pushed to a new private GitHub repo: ${repoName}. Invite people with \`brain share invite ${s.slug} <github-user>\`.`);
        } else {
          console.log(`To share with GitHub users: \`cd ${vault}/${s.dir} && gh repo create shannote-${s.slug} --private --source=. --push\`.`);
          console.log(`For people without GitHub: \`brain share guest ${s.slug} <their name>\`.`);
        }
        return 0;
      }
      if (sub === "join") {
        const url = args[1];
        if (!url) throw new Error("Usage: brain share join <git-url> [--name N]");
        const s = sp.joinSpace(vault, url, values.name, deviceName());
        console.log(`Joined "${s.name}" at ${s.dir}/. It syncs along with your vault.`);
        return 0;
      }
      if (sub === "invite") {
        const [, ref, user] = args;
        if (!ref || !user) throw new Error("Usage: brain share invite <space> <github-user>");
        const s = sp.getSpace(vault, ref);
        const repo = sp.githubRepo(s.remote);
        if (!repo) throw new Error(`${s.dir} isn't on GitHub yet. Run \`brain share create\` with --github, or add a GitHub remote to it.`);
        gh(["api", "-X", "PUT", `repos/${repo}/collaborators/${user.replace(/^@/, "")}`, "-f", "permission=push", "--silent"]);
        console.log(`Invited ${user} to ${repo}. Once they accept (GitHub emails them), they run:\n  brain share join https://github.com/${repo} --name "${s.name}"`);
        return 0;
      }
      if (sub === "guest") {
        const [, ref, ...who] = args;
        if (!ref || !who.length) throw new Error("Usage: brain share guest <space> <person's name> [--read-only]");
        const s = sp.getSpace(vault, ref);
        const { guest, token } = sp.createGuest(s.slug, who.join(" "), { readOnly: values["read-only"] });
        console.log(`Share link for ${guest.name} (${guest.readOnly ? "read-only" : "can edit"} "${s.name}" only). Send it privately; it's shown only now.\n`);
        if (publicUrl) console.log(`  ${publicUrl.replace(/\/+$/, "")}/?guest=${token}\n`);
        else {
          const { networkInterfaces } = await import("node:os");
          const ips = Object.values(networkInterfaces()).flat()
            .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal).map((i) => i.address);
          for (const ip of ips) console.log(`  http://${ip}:4567/?guest=${token}`);
          console.log("\nThese addresses only work on your network, while `brain web --lan` runs. For friends anywhere,");
          console.log("set up Tailscale Funnel and run `brain share url https://<your-machine>.<tailnet>.ts.net` (docs/SHARING.md),");
          console.log("then make a new link.\n");
        }
        console.log(`Turn it off any time: brain share revoke ${guest.id}`);
        return 0;
      }
      if (sub === "url") {
        const u = args[1];
        if (!u || !/^https:\/\//.test(u)) throw new Error("Usage: brain share url https://<address>  (must be https)");
        save({ publicUrl: u.replace(/\/+$/, "") } as never);
        console.log(`Guest links will use ${u}. Existing links keep working at the new address too.`);
        return 0;
      }
      if (sub === "revoke") {
        const ref = args.slice(1).join(" ").trim();
        if (!ref) throw new Error("Usage: brain share revoke <guest id | name | space>");
        const gone = sp.revokeGuest(ref);
        console.log(`Turned off ${gone.length} link${gone.length === 1 ? "" : "s"}: ${gone.map((g) => `${g.name} (${g.space})`).join(", ")}`);
        return 0;
      }
      if (sub === "list") {
        const spaces = sp.listSpaces(vault);
        const guests = sp.listGuests();
        out({ spaces, guests: guests.map(({ tokenHash: _t, ...g }) => g), publicUrl }, () => {
          if (!spaces.length) return "No shared spaces yet. `brain share create <name>` makes one.";
          return spaces.map((x) => {
            const g = guests.filter((y) => y.space === x.slug);
            return `${x.name}  (${x.dir})\n  repo: ${x.remote ?? "local only"}\n` +
              (g.length ? g.map((y) => `  guest: ${y.name}${y.readOnly ? " (read-only)" : ""}  id ${y.id}`).join("\n") : "  no guest links");
          }).join("\n\n");
        });
        return 0;
      }
      throw new Error(`Unknown share command "${sub}". See \`brain --help\`.`);
    }

    case "sync": {
      const brain = new Brain({ vault: resolveVault(values.vault), device: deviceName(), autoPush: false, trackSessions: false });
      try {
        const r = await brain.syncNow();
        out(r, () =>
          [
            `Pull: ${r.pull?.status ?? "skipped"}${r.pull?.error ? ` (${r.pull.error})` : ""}`,
            ...(r.pull?.conflicts ?? []).map((c) => `  conflict: kept ${c.path}, other version saved as ${c.copy}`),
            `Committed outside edits: ${r.committed ? "yes" : "none"}`,
            `Push: ${r.push.status}${"error" in r.push && r.push.error ? ` (${r.push.error})` : ""}`,
            `Unpushed commits: ${r.status.ahead}`,
          ].join("\n"),
        );
      } finally {
        brain.shutdown();
      }
      return 0;
    }

    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  },
);
