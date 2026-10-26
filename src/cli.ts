#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { deviceName, indexPath, resolveVault, saveConfig } from "./config.js";
import { openDb } from "./index/db.js";
import { indexVault } from "./index/indexer.js";
import { doctor, vaultStatus } from "./index/queries.js";
import { keywordSearch } from "./search/keyword.js";
import { initVault } from "./vault/init.js";

const HELP = `brain — a markdown second brain operated through Claude

Usage:
  brain init <path> [--device <name>]   Create a vault (or adopt an existing folder)
  brain index [--rebuild]               Update the search index
  brain status                          Vault and task counts
  brain search <query> [--folder F] [--tag T] [--limit N]
  brain doctor                          Broken links, bad frontmatter, duplicate names

Not yet implemented: serve (Phase 2), sync (Phase 2)

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
      const target = resolve(args[0] ?? values.vault ?? ".");
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
        const hits = keywordSearch(db, query, {
          folder: values.folder,
          tag: values.tag,
          limit: values.limit ? Number(values.limit) : 10,
        });
        out(hits, () =>
          hits.length
            ? hits.map((h, i) => `${i + 1}. ${h.title}  (${h.path})\n   ${h.snippet}`).join("\n")
            : "No results.",
        );
        return 0;
      });
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

    case "serve":
    case "sync":
      console.error(`brain ${cmd}: not implemented yet (Phase 2, see docs/SPEC.md §9)`);
      return 1;

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
