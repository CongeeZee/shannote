# Using Shannote from your phone

There are three ways, from least to most setup. Pick one; they can be combined.

## 1. The web app over Tailscale or home Wi-Fi (recommended)

Good for: quick capture, ticking tasks, today's schedule, inbox triage, search, reading notes.

1. On the laptop: `brain web --lan`. It prints a link like
   `http://192.168.1.20:4567/?token=…`.
2. Open that link once on the phone. The token is swapped for a cookie, so later visits
   just use `http://192.168.1.20:4567`.
3. Browser menu → **Add to Home Screen**. It opens full-screen like an app.

Things to know:
- The laptop must be on and `brain web --lan` running.
- **The link is a password.** Anyone who has it and can reach the laptop can read and
  edit your notes. Run `brain web --lan --new-token` to revoke it.
- Plain Wi-Fi traffic isn't encrypted. On a network you don't control (uni Wi-Fi), use
  [Tailscale](https://tailscale.com): install it on the laptop and the phone, sign in to
  both, and use the laptop's Tailscale IP (`100.x.y.z`) instead. Traffic is then
  encrypted and the laptop is reachable from anywhere, not just at home.
- Captures from the phone go to `inbox/<date>-phone.md`.

## 2. Obsidian on the phone, synced with git

Good for: reading and writing notes offline; works when the laptop is off.

**Android**: install Obsidian and the **Obsidian Git** community plugin. Clone your
private vault repo (Settings → Obsidian Git → Clone), using a GitHub fine-grained token
with access to that one repo. Turn on "Auto pull on startup" and "Auto commit-and-sync
after stopping file edits".

**iOS**: Obsidian Git is unreliable on iOS. Instead install **Working Copy**, clone the
vault there, then in Obsidian choose "Open folder as vault" and pick the Working Copy
folder. Pull and push from Working Copy (it can be automated with Shortcuts).

Capture into `inbox/` (e.g. a file per day like `inbox/2026-10-26-phone.md`, one bullet
per thought, or plain paragraphs). The laptop picks it up on the next pull, and the
Inbox page or Claude's `triage_inbox` files it.

## 3. Claude on the phone

The Claude mobile app can't use the local MCP server (it only connects to servers with
a public URL). Two partial options:
- Ask Claude in the mobile app with the **GitHub connector** pointed at your vault repo:
  fine for "what's on my plan today?", read-only.
- Paste a context pack (Search → *Copy context pack* in the web app) into a mobile chat.

Full Claude-with-tools on the phone needs the hosted hub (Phase 7).
