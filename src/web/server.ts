import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Brain } from "../core.js";
import { recentSessions } from "../session/sessions.js";
import { BrainError } from "../util.js";
import { LinkResolver } from "../vault/resolve.js";
import { splitFrontmatter } from "../vault/edit.js";
import { renderMarkdown } from "./render.js";
import { loadEditor, loadFont, UI_HTML } from "./ui.js";
import { findGuest, listGuests, type Guest } from "../share/spaces.js";

const MAX_BODY = 1_000_000;

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(type === "text/html"
      ? {
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        }
      : {}),
  });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new BrainError("Request too large", "invalid");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function resolverFor(brain: Brain): LinkResolver {
  const paths = (brain.db.prepare("SELECT path FROM notes").all() as Array<{ path: string }>).map((r) => r.path);
  return new LinkResolver(paths);
}

const MANIFEST = JSON.stringify({
  name: "Shannote",
  short_name: "Shannote",
  start_url: "/#/today",
  display: "standalone",
  background_color: "#f3ebdf",
  theme_color: "#f3ebdf",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
});
export const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#8f5a3a"/><g fill="none" stroke="#fff8f0" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 27h29v9a14 14 0 0 1-14 14h-1a14 14 0 0 1-14-14Z"/><path d="M43 30h4a6 6 0 0 1 0 12h-4"/><path d="M22 10c-2 3 2 5 0 8M31 10c-2 3 2 5 0 8"/></g></svg>`;

export interface WebOptions {
  /** Also accept connections from other devices (phone) that present this token. */
  lanToken?: string;
  /** Guest links (scoped to one shared space). Defaults to this device's config. */
  guests?: () => Guest[];
}

/** What a guest may call. Everything else is refused. */
const GUEST_ROUTES = new Set([
  "GET /api/me",
  "GET /api/tree",
  "GET /api/note",
  "GET /api/note/hash",
  "GET /api/search",
  "POST /api/note/save",
  "POST /api/note/create",
]);

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function tokenMatches(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  return (req.headers.cookie ?? "")
    .split(/;\s*/)
    .map((c) => c.split("="))
    .find(([k]) => k === name)?.[1];
}

/**
 * Web app. By default binds to 127.0.0.1 and accepts only localhost Host headers
 * (blocks DNS rebinding). Writes need a custom header (blocks cross-site form
 * posts, since browsers won't send it cross-origin without CORS).
 *
 * With `lanToken` (brain web --lan) it also binds to the network so a phone on
 * the same Wi-Fi/Tailscale can use it. Non-local requests must present the token
 * once (?token=…), which is then kept in an HttpOnly, SameSite=Strict cookie.
 */
export function startWebServer(brain: Brain, port: number, host = "127.0.0.1", opts: WebOptions = {}) {
  // Built from the real port once listening (port 0 means "pick one").
  let allowedHosts = new Set<string>();
  const by = `eric@${brain.device}`;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const q = url.searchParams;
      const local = isLoopback(req) && allowedHosts.has(req.headers.host ?? "");
      let guest: Guest | undefined;
      if (!local) {
        // Guest links work through --lan or a tunnel (Tailscale Funnel); they only see one shared space.
        const gGiven = q.get("guest") ?? cookie(req, "shannote_guest");
        guest = gGiven ? findGuest(gGiven, (opts.guests ?? listGuests)()) : undefined;
        if (guest && q.get("guest")) {
          res.writeHead(302, {
            location: "/#/notes",
            "set-cookie": `shannote_guest=${q.get("guest")}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`,
          });
          return res.end();
        }
      }
      if (!local && !guest) {
        const given = q.get("token") ?? cookie(req, "brain_token");
        if (!opts.lanToken || !tokenMatches(given ?? undefined, opts.lanToken)) {
          if (gGivenButInvalid(req, q))
            return send(res, 401, "<!doctype html><meta name=viewport content='width=device-width'><p style='font:16px system-ui;padding:24px'>This share link has been turned off or is wrong. Ask for a new one.</p>", "text/html");
          if (!opts.lanToken) return send(res, 403, { error: "forbidden host" });
          return send(res, 401, "<!doctype html><meta name=viewport content='width=device-width'><p style='font:16px system-ui;padding:24px'>Open the link with <code>?token=…</code> printed by <code>brain web --lan</code>.</p>", "text/html");
        }
        if (q.get("token")) {
          // Swap the token in the URL for a cookie, then reload without it.
          res.writeHead(302, {
            location: "/#/today",
            "set-cookie": `brain_token=${opts.lanToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          });
          return res.end();
        }
      }
      const source = local ? brain.device : "phone";
      const spaceDir = guest ? `shared/${guest.space}` : null;
      const inSpace = (p: string) => !spaceDir || p.startsWith(`${spaceDir}/`);
      if (guest && !brain.spaces().some((sp) => sp.slug === guest!.space))
        return send(res, 410, { error: "This shared space no longer exists." });

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html"))
        return send(res, 200, UI_HTML, "text/html");
      if (req.method === "GET" && url.pathname === "/manifest.webmanifest") return send(res, 200, MANIFEST, "application/manifest+json");
      if (req.method === "GET" && url.pathname === "/icon.svg") return send(res, 200, ICON, "image/svg+xml");
      if (req.method === "GET" && url.pathname === "/editor.js") {
        const js = loadEditor();
        if (!js) return send(res, 404, "// editor not built: run npm run build", "text/javascript");
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
        return res.end(js);
      }
      const font = req.method === "GET" && url.pathname.match(/^\/fonts\/(fraunces|literata|nunito)\.woff2$/);
      if (font) {
        const data = loadFont(font[1]!);
        if (!data) return send(res, 404, { error: "font not found" });
        res.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" });
        return res.end(data);
      }

      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      if (req.method === "POST" && req.headers["x-brain"] !== "1")
        return send(res, 403, { error: "missing x-brain header" });

      const route = `${req.method} ${url.pathname}`;
      if (guest && !GUEST_ROUTES.has(route)) return send(res, 403, { error: "Not available with a share link" });
      if (guest?.readOnly && req.method === "POST") return send(res, 403, { error: "This share link is read-only" });
      const editor = guest ? `${guest.name} (guest)` : `eric@${brain.device}`;
      const commitAs = guest
        ? { prefix: `guest(${guest.name})`, author: `${guest.name} (guest) <guest-${guest.id}@shannote.local>` }
        : {};
      switch (route) {
        case "GET /api/me": {
          const sp = spaceDir ? brain.spaces().find((x) => x.slug === guest!.space) : undefined;
          return send(res, 200, guest
            ? { role: "guest", name: guest.name, space: { slug: guest.space, name: sp?.name ?? guest.space, dir: spaceDir }, readOnly: !!guest.readOnly }
            : { role: "owner", device: brain.device, spaces: brain.spaces().map((x) => ({ slug: x.slug, name: x.name, dir: x.dir, shared: !!x.remote })) });
        }

        case "GET /api/note/hash": {
          const r = brain.hashOf(q.get("path") ?? "");
          if (!inSpace(r.path)) return send(res, 404, { error: "Note not found" });
          return send(res, 200, r);
        }

        case "POST /api/note/save": {
          const b = await readJson(req);
          const path = brain.safePath(String(b.path ?? ""));
          if (!inSpace(path)) return send(res, 403, { error: "Not in your shared space" });
          return send(res, 200, await brain.save({
            path,
            content: String(b.content ?? ""),
            expectedHash: typeof b.hash === "string" ? b.hash : undefined,
            force: b.force === true,
            ...commitAs,
          }));
        }

        case "POST /api/note/create": {
          const b = await readJson(req);
          const title = String(b.title ?? "").trim();
          if (!title) throw new BrainError("Give the note a title", "invalid");
          let folder = String(b.folder ?? "").trim().replace(/^\/+|\/+$/g, "") || (spaceDir ?? "notes");
          if (spaceDir && !(folder === spaceDir || folder.startsWith(`${spaceDir}/`))) folder = spaceDir;
          return send(res, 200, await brain.create({ title, folder, by: editor, ...commitAs }));
        }

        case "GET /api/status":
          return send(res, 200, await brain.status());

        case "GET /api/today":
          return send(res, 200, await brain.today(q.get("date") ?? undefined).then((t) => ({
            ...t,
            dailyHtml: t.daily
              ? renderMarkdown(withoutSection(stripTitle(splitFrontmatter(t.daily.content).body), "Schedule"), resolverFor(brain), t.daily.path)
              : null,
          })));

        case "GET /api/search":
          return send(
            res,
            200,
            await brain.search(q.get("q") ?? "", {
              folder: spaceDir && !(q.get("folder") ?? "").startsWith(`${spaceDir}/`) ? spaceDir : q.get("folder") || undefined,
              tag: q.get("tag") || undefined,
              limit: Number(q.get("limit") ?? 30),
              mode: (["hybrid", "keyword", "semantic"].includes(q.get("mode") ?? "") ? q.get("mode") : "hybrid") as "hybrid",
            }),
          );

        case "GET /api/note": {
          if (spaceDir) {
            // Exact paths only: resolving a title could land on a private note.
            const path = brain.safePath(q.get("path") ?? "");
            if (!inSpace(path)) return send(res, 404, { error: "Note not found" });
            const note = await brain.read(path);
            const { body } = splitFrontmatter(note.content);
            const paths = (brain.db.prepare("SELECT path FROM notes WHERE substr(path, 1, ?) = ?").all(spaceDir.length + 1, `${spaceDir}/`) as Array<{ path: string }>).map((r) => r.path);
            return send(res, 200, {
              ...note,
              html: renderMarkdown(stripTitle(body), new LinkResolver(paths), note.path),
              related: { backlinks: [], outgoing: [], unresolved: [], similar: [] },
            });
          }
          const note = await brain.read(q.get("path") ?? "");
          const related = await brain.related(note.path);
          const { body } = splitFrontmatter(note.content);
          return send(res, 200, {
            ...note,
            html: renderMarkdown(stripTitle(body), resolverFor(brain), note.path),
            related,
            absPath: `${brain.vault}/${note.path}`,
            vaultName: brain.vault.split("/").pop(),
          });
        }

        case "GET /api/tasks":
          return send(
            res,
            200,
            await brain.tasks({
              status: (q.get("status") as "open" | "done" | "all") ?? "open",
              overdue: q.get("overdue") === "1",
              due_before: q.get("due_before") ?? undefined,
              due_after: q.get("due_after") ?? undefined,
              tag: q.get("tag") ?? undefined,
              limit: Number(q.get("limit") ?? 300),
            }),
          );

        case "GET /api/tree": {
          await brain.fresh();
          const rows = brain.db
            .prepare("SELECT path, title, word_count, mtime_ms FROM notes ORDER BY path")
            .all() as Array<{ path: string }>;
          return send(res, 200, spaceDir ? rows.filter((r) => inSpace(r.path)) : rows);
        }

        case "GET /api/handoffs":
          await brain.fresh();
          return send(res, 200, {
            sessions: recentSessions(brain.vault, Number(q.get("limit") ?? 30)),
            threads: await brain.threads("all"),
          });

        case "GET /api/doctor":
          return send(res, 200, {
            doctor: await brain.doctor(),
            sync: { ...brain.sync.status(), enabled: brain.syncEnabled },
            embeddings: brain.embedState(),
          });

        case "GET /api/recent":
          return send(res, 200, await brain.recent({ limit: Number(q.get("limit") ?? 30) }));

        case "POST /api/capture": {
          const body = await readJson(req);
          const text = String(body.text ?? "").trim();
          if (!text) throw new BrainError("Nothing to capture", "invalid");
          return send(res, 200, await brain.capture(text, source));
        }

        case "GET /api/inbox":
          return send(res, 200, await brain.inbox({ suggestions: q.get("suggestions") !== "0" }));

        case "POST /api/inbox/resolve": {
          const b = await readJson(req);
          const action = String(b.action) as "move" | "task" | "archive" | "discard";
          if (!["move", "task", "archive", "discard"].includes(action)) throw new BrainError("Unknown action", "invalid");
          return send(
            res,
            200,
            await brain.inboxResolve({
              id: String(b.id),
              action,
              target: typeof b.target === "string" && b.target ? b.target : undefined,
              heading: typeof b.heading === "string" && b.heading ? b.heading : undefined,
              by,
            }),
          );
        }

        case "GET /api/links":
          return send(res, 200, await brain.linkSuggestions({ note: q.get("note") || undefined, days: Number(q.get("days") ?? 7) }));

        case "POST /api/links/add": {
          const b = await readJson(req);
          return send(
            res,
            200,
            await brain.addLink({
              note: String(b.note),
              target: String(b.target),
              line: typeof b.line === "number" ? b.line : undefined,
              text: typeof b.text === "string" ? b.text : undefined,
            }),
          );
        }

        case "GET /api/context":
          return send(res, 200, await brain.contextPack(q.get("topic") ?? "", { limit: Number(q.get("limit") ?? 6) }));

        case "POST /api/task": {
          const b = await readJson(req);
          return send(
            res,
            200,
            await brain.taskUpdate({
              id: String(b.id),
              done: typeof b.done === "boolean" ? b.done : undefined,
              due: b.due === null ? null : typeof b.due === "string" ? b.due : undefined,
              by,
            }),
          );
        }

        case "POST /api/daily": {
          const b = await readJson(req);
          await brain.daily(typeof b.date === "string" ? b.date : undefined, true);
          return send(res, 200, { ok: true });
        }

        case "POST /api/sync":
          return send(res, 200, await brain.syncNow());

        default:
          return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      const status = e instanceof BrainError ? ({ not_found: 404, conflict: 409, exists: 409 } as Record<string, number>)[e.code] ?? 400 : 500;
      if (status === 500) process.stderr.write(`[brain web] ${(e as Error).stack}\n`);
      send(res, status, { error: (e as Error).message, ...((e as { details?: object }).details ?? {}) });
    }
  });

  server.on("listening", () => {
    const p = (server.address() as { port: number }).port;
    allowedHosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
  });
  server.listen(port, host);
  return server;
}

function gGivenButInvalid(req: IncomingMessage, q: URLSearchParams): boolean {
  return !!(q.get("guest") || cookie(req, "shannote_guest"));
}

/** The page header already shows the title, so drop a leading H1. */
function stripTitle(body: string): string {
  return body.replace(/^\s*#[ \t]+[^\n]*\n/, "");
}

/** The Today page shows the schedule as its own card, so drop it from the note body there. */
function withoutSection(body: string, heading: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "i").test(l.trim()));
  if (start === -1) return body;
  const level = lines[start]!.match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i]!.match(/^(#{1,6})\s/);
    if (h && h[1]!.length <= level) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start);
  return lines.join("\n");
}
