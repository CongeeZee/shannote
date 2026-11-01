# An always-on Shannote server (spare MacBook)

Run Shannote 24/7 on a spare laptop so your phone (and anything else on your Tailscale
network) can use it even when your main computer is off. It's the same app with the same
vault: notes, tasks, the dashboard, Claude chat and voices, calendar and Gmail. Your
laptops keep each other up to date through the vault's private GitHub repo, as they
already do.

```
phone ──Tailscale (HTTPS)──► MacBook: tailscale serve → Shannote (127.0.0.1:4567) ─┐
                                                                                   ├─ git ─► GitHub vault ◄─ your laptop
                                             Claude Code (your subscription) ◄─────┘
```

Replace `<you>` below with your GitHub username.

## 1. Tools

In Terminal:

```bash
xcode-select --install                      # git and build tools
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@22 gh
gh auth login                               # lets git reach your private vault
curl -fsSL https://claude.ai/install.sh | bash
claude                                      # sign in with your Claude account, then /exit
```

In `claude`, `/mcp` should list your claude.ai connectors (Gmail, Google Calendar). If one
says it needs authentication, sign in to it there; Shannote's chat and briefs use them.

## 2. Shannote and your vault

```bash
git clone https://github.com/<you>/shannote.git ~/projects/shannote
cd ~/projects/shannote && npm install && npm run build && npm link
git clone https://github.com/<you>/vault.git ~/vault
shannote init ~/vault --device macbook      # adopts the existing vault; pick any device name
shannote embed                              # search by meaning (downloads a small model once)
```

## 3. Tailscale

1. Install Tailscale for Mac from <https://tailscale.com/download> and sign in with the same
   account as your phone. In its menu, enable the command-line tool so `tailscale` works in
   Terminal.
2. In the Tailscale admin console → DNS, make sure **MagicDNS** and **HTTPS Certificates** are
   on (`tailscale serve` needs them for the `https://…ts.net` address).

## 4. Start the server

```bash
shannote server install
```

It sets Shannote up as a LaunchAgent (starts when you log in, restarts if it stops, and
keeps the Mac from idle-sleeping while it runs), publishes it with `tailscale serve`, and
prints a link like `https://macbook.tail1234.ts.net/?token=…`.

- `shannote server status` shows whether it's running; the log is `~/.cache/shannote/server.log`.
- `shannote server remove` takes it down; `tailscale serve reset` stops publishing it.
- The link is a password. `shannote server install --new-token` replaces it.

## 5. Keep it awake

- Keep it plugged in. In System Settings → Battery → Options, turn on "Prevent automatic
  sleeping on power adapter when the display is off".
- A MacBook still sleeps when you close the lid. To run it closed:
  `sudo pmset -a disablesleep 1` (undo with `sudo pmset -a disablesleep 0`), or leave the lid
  open with the screen dimmed.
- Set it to log in automatically (System Settings → Users & Groups), so the server comes back
  after a restart or power cut.

## 6. Move the morning brief here

Run the brief on the machine that's always on, and only there, so you don't get two:

```bash
shannote schedule install --morning 07:30   # on the MacBook (launchd; catches up after sleep)
shannote schedule remove                    # on your other laptop
```

## 7. Your phone (Android)

1. Install Tailscale from the Play Store and sign in with the same account.
2. Open the link from step 4 in Chrome, once. It swaps the token for a cookie.
3. Chrome menu → **Add to Home Screen**. It opens full-screen like an app.
4. Allow the microphone the first time you press the mic button.

## Updating

```bash
cd ~/projects/shannote && git pull && npm install && npm run build && shannote server install
```

## Good to know

- If you edit the same note on two machines at once, Shannote keeps a conflict copy rather
  than merging; nothing is lost.
- Phone chats run Claude Code on the MacBook under your subscription and count towards your
  usage like any other.
- Share-link guests still see only their shared space; the server changes nothing there.
