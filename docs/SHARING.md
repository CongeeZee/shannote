# Sharing notes with other people

Your vault stays private. Anything you want to share goes in a **shared space**: a
folder under `shared/` that is its own git repo. The vault repo ignores `shared/`,
so nothing outside that folder can leak into it, and nothing in it goes into your
private vault repo.

There are two ways to let someone in. You can use both on the same space.

| | GitHub collaborator | Guest link |
|---|---|---|
| They need | GitHub account, Shannote or Obsidian + git | A browser |
| Works when your laptop is off | Yes | No (your laptop serves the page) |
| Their edits | Synced through the space's GitHub repo | Saved straight into your copy, committed as `guest(Name)` |
| Best for | Uni/dev friends | Everyone else |

Neither is live co-editing like Google Docs. The editor checks for changes every
few seconds and loads other people's edits when you haven't typed anything since. If
you have typed, you choose between "Load their version" and "Keep mine", so neither
version is overwritten silently.

## Create a space

```bash
shannote share create "Thesis Group" --github   # also makes a private GitHub repo, shannote-thesis-group
```

Without `--github` the space stays local until you add a remote. Write in it like any
other folder: in the app (Notes → **+ New note**, pick `shared/thesis-group`), in Obsidian,
or through Claude.

## GitHub collaborators

```bash
shannote share invite thesis-group their-github-username
```

GitHub emails them an invite. Once they accept, they run (with Shannote installed):

```bash
shannote share join https://github.com/<you>/shannote-thesis-group --name "Thesis Group"
```

The space then syncs with the vault on every pull/push (`shannote sync`, the app's
**Sync now**, or automatically while the app or Claude is running). Obsidian users can
just clone the repo and use the Obsidian Git plugin.

## Guest links (no account needed)

```bash
shannote share guest thesis-group "Alex Smith"            # can edit
shannote share guest thesis-group "Sam" --read-only       # can only read
```

That prints a link once. Send it privately. Opening it shows only that space (Notes and
Search); they can't see your other notes, tasks, inbox, calendar or handoffs, and
can't follow a link out of the space. Each person gets their own link, so their edits
carry their name and you can turn one off without affecting the others:

```bash
shannote share list
shannote share revoke <id or name>
```

### Making the link reachable

The link is served by your laptop, so it works only while the laptop is awake and
Shannote's web server is running (the desktop app, `shannote web`, or `shannote web --lan`).

**Same Wi-Fi only:** run `shannote web --lan`; the printed `http://192.168.…` link works on
your network.

**From anywhere, Tailscale Funnel (recommended):**

1. Install Tailscale and sign in: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`.
2. In the Tailscale admin console, enable **HTTPS certificates** and **Funnel** for your tailnet.
3. Run `tailscale funnel --bg 4567`. It prints your public address, like
   `https://core.tail1234.ts.net`. (Check `tailscale funnel --help` if your version's syntax differs.)
4. Tell Shannote about the address, then make the guest link:
   ```bash
   shannote share url https://core.tail1234.ts.net
   shannote share guest thesis-group "Alex Smith"
   ```

**Or a Cloudflare Tunnel**, if you already use `cloudflared`: point a named tunnel at
`http://localhost:4567` and run `shannote share url https://<your-hostname>`. Quick tunnels
(`cloudflared tunnel --url …`) get a new address each run, which breaks old links.

### What's exposed, and to whom

Funnel/Tunnel put your Shannote server on the public internet. Here's what that exposes:

- Requests that come through the public address are never treated as you. Without a
  valid guest link (or your `--lan` token) they get "forbidden", and the full app (vault,
  tasks, calendar, handoffs) is not reachable that way.
- A guest link is a password for that one space. Only a hash is stored in
  `~/.config/shannote/config.json`, and that file is readable only by you.
- Guests can create and edit notes in their space. They can't delete or move notes. Every
  edit is a git commit in the space's repo, so you can undo anything with `git revert` there.
- When you stop sharing, turn Funnel off (`tailscale funnel reset`) or stop the tunnel.

## Claude and shared spaces

Claude sees shared spaces like any other folder, and is told that their contents are visible
to other people, so it shouldn't copy private material into them unless you ask it to.
Guest edits are commits named `guest(Name): …` in the space's repo (`git log` in that folder).
