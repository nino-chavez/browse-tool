# browser-box

A real headed browser that isn't on your screen.

Google Chrome runs inside a container on a virtual display. You drive it over CDP with
the ordinary `browse-*` commands; you watch it, when you want to, in a browser
tab. Your desktop stays yours.

```bash
browser-box start
BROWSE_PORT=9400 browse-nav "https://example.com"
BROWSE_PORT=9400 browse-eval 'return document.title'
browser-box view          # watch it work
browser-box stop
```

## Why this exists

Two failure modes, one fix.

**Headless silently no-ops on real sites.** Facebook's menus, mention typeaheads,
and file choosers do nothing under `--headless=new` — buttons work, menu items
don't, and nothing errors. You get a script that appears to run and posts
nothing.

**Headed takes over your machine.** A visible Chrome steals focus and the
screen for as long as the automation runs, which makes any long job
mutually exclusive with using your own computer.

A virtual display is both: Chrome composites into a genuine X server, so it
behaves exactly like a desktop browser, and that server is inside a container
rather than attached to your monitor. This is the same shape Anthropic's
computer-use reference implementation uses — a container plus a way to view it —
for the same reason.

Verified on start: the User-Agent contains no `Headless` token.

## Profiles and logins

Each profile is a directory on the host bind-mounted to `/profile`, so logins
survive restarts:

```bash
browser-box start --profile social      # ~/.browser-box/profiles/social
browser-box start --profile scraping --port 9401
browser-box status
```

**Log in once, inside the box.** `browser-box view` opens the live screen in a
tab; sign in there as you would anywhere, and the cookies persist in that
profile.

Getting a password in is the awkward part, so don't use the clipboard. Click the
field in the viewer, then pipe the secret straight to the box's keyboard:

```bash
op read "op://Private/Facebook/password" | browser-box type --profile social
```

`type` reads **stdin**, never an argument, so the secret stays out of `argv`
(where `ps` would show it), out of shell history, and out of the transcript of
any agent driving this.

If you do use the viewer's clipboard panel, note that the remote desktop is
Linux: paste inside the page is **`Ctrl+V`**, not `Cmd+V`. `Cmd+V` fails
silently there, which reads like a broken clipboard.

You cannot copy a macOS Chrome profile in to skip this. macOS Chrome encrypts
its cookie database with a key held in the login Keychain (`v10` records), and
that key does not exist in the container — the copy yields a browser that looks
configured and is signed out of everything. Expect the site to treat the first
in-container login as a new device. (Two Linux profiles *do* migrate by copying
`Cookies`; see below. It is the Keychain, not the format, that stops the Mac.)

Chrome Sync is the supported way to carry passwords and extensions in, and it
works because this is real Chrome — see the arm64 note below for why that is not
a given. Weigh it before turning it on: sync pulls a Google password vault into a
container running `--no-sandbox` behind unauthenticated CDP, and this file
already says anything that can reach that port can act as you. A Google account
dedicated to the box gets the sync without staking the primary one.

Verified end to end: a cookie set in one container was still readable after
`stop` destroyed that container and `start` built a new one from a rebuilt
image.

**A fresh login needs about 30 seconds before the box is destroyed.** Chrome
holds new cookies in memory and commits them to SQLite on a timer — measured at
~30s here, with the on-disk table reading empty for the first three checks after
a cookie was set and populated by t+40s. `browser-box stop` shuts down
gracefully so this is handled, but `docker kill` on the container, or a laptop
losing power seconds after you sign in, loses that login. Sign in, then give it
a moment before tearing anything down.

Deleting a profile deletes its logins, so `rm` asks you to type the name:

```bash
browser-box rm --profile social
```

## Using it with browse-tool

`start` writes the same state file `browse-tool` reads, so every `browse-*`
command works against a box by setting `BROWSE_PORT`. Nothing about browse-tool
changes for local browsers.

Two things in browse-tool are container-aware, both deliberately:

- `assertPortIdentity()` skips its ownership check when the state file names a
  container. That check reads the port owner's `--user-data-dir` out of `ps`; a
  published Docker port is held by `docker-proxy`, so the check has no evidence
  to reason about and would reject a correctly attached browser.
- `browse-stop` refuses outright and points you at `browser-box stop`. Its kill
  list comes from the same `portOwners()` call, which on a mapped port means it
  would signal Docker's proxy — tearing down the port mapping while leaving the
  browser running.

## Driving a site that needs a human first

`fb-composer.mjs` in letspepper is a consumer of this, not part of it:

```bash
browser-box start --profile social
browser-box view                      # log into Facebook once, in the box
BROWSE_PORT=9400 FB_PAGE_MATCH=facebook.com \
  node scripts/social-publish/fb-composer.mjs click "What's on your mind" partial
```

Nothing in the box is site-specific.

## Details that cost time to rediscover

**Google Chrome, native arm64 — and Google does publish one.** This image ran
Debian's `chromium` first, on the belief that `google-chrome-stable` on Apple
silicon meant amd64 emulation. That is false, and checking Google's own apt
index settles it in one command:

```bash
curl -s https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-arm64/Packages \
  | grep -E '^(Package|Version)'
```

The switch is not cosmetic. Debian builds Chromium without Google's API keys,
which disables Chrome Sync outright — no signing in with a Google account, no
synced passwords, no synced extensions. Extensions still install by hand in
either build; only sync is gated.

**A profile migrates between the two builds by copying `Default/Cookies`.**
`--password-store=basic` derives the encryption key rather than storing it, so a
cookie database written by one build decrypts under the other. Verified in this
direction (bookworm Chromium → Chrome 151): LinkedIn and Substack sessions
survived intact. Copy `Cookies` alone — `Local State` holds browser-variant
metadata and buys nothing. Stop the box, swap the file, start it again.

Sessions held by something other than a cookie do not travel. A dev.to login in
the same profile did not survive, because it is a magic-link session rather than
a password one.

**`--shm-size=2g` is required.** Docker's default 64MB `/dev/shm` crashes
Chrome on any substantial page. This is the most common containerised-Chrome
failure and it presents as a tab dying, not as an out-of-memory message.

**socat has to listen on the container IP at the same port number.** Chrome
binds DevTools to `127.0.0.1` and ignores `--remote-debugging-address`, so a
mapped port answers nothing. Forwarding fixes reachability, but the port numbers
must match on both sides: `puppeteer.connect({browserURL})` fetches
`/json/version` and then dials the `webSocketDebuggerUrl` it finds there
verbatim. Chrome advertises `ws://127.0.0.1:<port>/…`, which is only correct on
the host when the host port is the same number. Different ports on either side
produce a working `/json/version` and a websocket that connects to nothing.

**`--init` is what makes a graceful stop possible.** `exec google-chrome-stable` puts
Chrome at PID 1, and Linux discards signals to PID 1 that have no installed
handler — so `docker stop` did nothing and Chrome died by SIGKILL when the
timeout expired, losing anything it had not committed. tini at PID 1 forwards
the signal so shutdown actually runs.

**Stale locks are cleared on every start, and both are required.** The box
restarts in place, so `/tmp/.X99-lock` survives a crash and turns one transient
failure into a permanent loop ("Server is already active for display 99"). And
Chrome's `SingletonLock` records the holding hostname, which in a container is
the container ID — after any recreate it names a host that cannot exist and
Chrome reports the profile as in use by another process.

**`--password-store=basic`.** Otherwise Chrome picks a cookie-encryption
backend based on whether a keyring is present, and a profile written under one
backend is unreadable under the other — logins vanish on restart with no error.

## What this box is exposed to

Worth being exact about, because the answer is "your machine, not your network,"
and the two get conflated.

**Nothing off the machine.** `-p 127.0.0.1:$port:9400` publishes to loopback
only. Verified: CDP and the viewer both refuse a connection to this Mac's LAN
address and answer on `127.0.0.1`.

**Every local process, yes — that is the real exposure.** CDP has no
authentication of any kind. Anything running as you can read the browser's
websocket UUID from `127.0.0.1:<port>/json/version`, connect, and drive a fully
logged-in browser: read mail, post as you, take a session cookie. No password,
no prompt, nothing logged. An npm postinstall script qualifies.

**`--remote-allow-origins` is deliberately absent**, which keeps a *visited web
page* out of that local case. Chrome rejects a DevTools websocket handshake
carrying an `Origin` header unless the flag permits it, and `'*'` permits every
origin — measured: with the flag, `Origin: https://evil.example` was answered
`101`; without it, `403`. Puppeteer connects from Node and sends no `Origin` at
all, which Chrome allows either way, so nothing here needed the flag. What still
stands between a random page and the box even with it set is that the UUID is
unguessable and `/json/list` returns no CORS header — but that is one bug away,
and this is the layer that exists for it.

**The profile directory is effectively a plaintext credential store.**
`--password-store=basic` derives its key from a fixed string, so anything that
can read `~/.browser-box/profiles/<name>/` can decrypt the cookies. Don't sync it
or put it in an off-machine backup. With Chrome Sync on, that directory holds
synced passwords too.

## Requirements

Docker Desktop running (`open -a Docker`). First `start` builds the image.
