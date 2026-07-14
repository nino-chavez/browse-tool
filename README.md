# browse-tool

Minimal Bash-invokable browser tools for coding agents. Replaces Chrome DevTools MCP and Playwright MCP with ~9 small CLI scripts totaling a few hundred tokens to describe. Agents rely on standard DOM/JS knowledge instead of memorizing tool schemas.

Inspired by Mario Zechner's [What if you don't need MCP at all?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/).

## Install

```bash
cd /Users/nino/Workspace/dev/tools/browse-tool
npm install
```

Put the bins on your PATH, e.g. in `~/.zshrc`:

```bash
export PATH="$HOME/Workspace/dev/tools/browse-tool/bin:$PATH"
```

Or launch Claude Code with the bins on PATH:

```bash
alias cl='PATH=$HOME/Workspace/dev/tools/browse-tool/bin:$PATH claude'
```

Then `/add-dir /Users/nino/Workspace/dev/tools/browse-tool` in Claude Code so the agent can `@README.md` for reference.

## Commands

All commands connect to a single long-lived Chrome started by `browse-start`. State lives in `$TMPDIR/browse-tool-state.json`.

### `browse-start [--profile] [--profile-name <name>] [--reseed] [--headless] [--port 9222]`
Launch Chrome with remote debugging. Profiles live persistently under `~/.browse-tool/profiles/<name>` so your logged-in state survives between sessions.

- **Default profile name** is the basename of the current working directory — launching from `~/Workspace/dev/apps/rally-hq` auto-selects `~/.browse-tool/profiles/rally-hq`. Override with `--profile-name foo`.
- **`--profile`** on first run rsyncs your real Chrome default profile (cookies, logins, extensions) into the target directory — **only when the target is empty**. Your real Chrome profile is never modified. On subsequent runs the flag is a no-op; the persistent profile is reused as-is.
- **`--reseed`** forces a fresh rsync over an existing profile (useful after you log into a new account in real Chrome).
- **`--headless`** runs without a visible window.

Parallel with real Chrome on macOS: browse-tool Chrome runs as its own process but macOS merges it with your real Chrome in the Dock (same app bundle). Use `Cmd+~` to cycle between their windows, or install Chromium / Chrome Canary and set `CHROME_PATH=/path/to/Chromium.app/Contents/MacOS/Chromium` for a truly separate Dock app.

### `browse-stop`
Kill the managed Chrome and clear state.

### `browse-nav <url> [--new] [--wait]`
Navigate the active tab (or a new one with `--new`). `https://` is auto-prepended if the URL has no scheme. `--wait` waits for `networkidle2` instead of `domcontentloaded`. Prints final URL and title.

### `browse-eval '<js>'` | `browse-eval --file script.js` | `echo '…' | browse-eval --stdin`
Run JavaScript in the active page. Code is wrapped in `async () => { … }`, so use `return` for a value and `await` freely. Result is JSON-serialized to stdout. Prefer writing scripts to files for anything non-trivial.

Examples:
```bash
browse-eval 'return document.title'
browse-eval 'return [...document.querySelectorAll("h2")].map(h => h.innerText)'
browse-eval 'const r = await fetch("/api/me"); return r.status'
```

### `browse-screenshot [--full] [--out path.png]`
Capture the viewport (or full page with `--full`) as PNG. Prints the path so you can `Read` it.

### `browse-shot <url> [--out path.png] [--full] [--wait] [--wait-ms <n>] [--wait-for <selector>]`
Navigate to URL, wait for readiness, optionally wait for a selector or additional time, then screenshot in one command. Replaces the `browse-nav && sleep N && browse-screenshot` pattern. Prints the output path.

### `browse-markdown <url> [--wait] [--wait-ms <n>] [--wait-for <selector>] [--raw]`
Navigate to URL, strip nav/ads/boilerplate with Readability, convert the main content to markdown with Turndown. Prints `# title` + markdown body to stdout. Falls back to the full page body if Readability finds no article-shaped content (dashboards, SPAs, listings) — `--raw` skips Readability entirely and always converts the full body. Use this instead of `browse-eval 'return document.body.innerText'` when you want clean, LLM-ready text from an article/blog/docs page rather than raw eval output.

### `browse-crawl <start-url> [--depth N] [--include prefix] [--max N] [--out dir] [--wait]`
BFS crawl from `start-url`, following same-origin links (or links matching `--include prefix` for a narrower scope) up to `--depth` levels deep (default `1`: the start page plus its direct links), capped at `--max` pages total (default `20`). Each visited page is written as clean markdown (Readability + Turndown, same extraction as `browse-markdown`) to `--out dir` (default a fresh temp dir), plus a `manifest.json` listing `{url, title, file}` for every page. Prints each file path to stdout as it's written; prints the final page count and output dir to stderr. Visited URLs are deduped (fragment-stripped) so it never re-fetches a page.

### `browse-tabs [list | close <index>]`
List open tabs with their URL/title, or close a tab by index.

### `browse-pick`
Enable an interactive element picker in the active tab. Hover highlights elements, click to pick, Cmd/Ctrl+click to add multiple, Enter to finish, Esc to cancel. Returns JSON with tag, id, class, text, html, bounding rect, and a heuristic selector for each picked element. Use this when you need the human to point at something instead of guessing at selectors.

## Recipes

**Scrape headlines:**
```bash
browse-start
browse-nav https://news.ycombinator.com
browse-eval 'return [...document.querySelectorAll(".titleline > a")].slice(0,10).map(a => ({title: a.innerText, url: a.href}))'
```

**Check a dev server and screenshot it:**
```bash
browse-start
browse-nav http://localhost:5173 --wait
browse-screenshot --out /tmp/home.png
browse-eval 'return document.querySelectorAll("[data-testid]").length'
```

**Form a selector with human help:**
```bash
browse-pick  # human clicks the element in Chrome
```

**Read an article as clean markdown:**
```bash
browse-start
browse-markdown https://example.com/blog/some-post > /tmp/post.md
```

**Crawl a small docs site (depth-limited, same-origin):**
```bash
browse-start
browse-crawl https://example.com/docs --depth 2 --max 30 --out /tmp/docs-crawl
cat /tmp/docs-crawl/manifest.json
```

## Why not MCP?

- Playwright MCP ≈ 13.7k tokens of tool schema, always loaded.
- Chrome DevTools MCP ≈ 18.0k tokens.
- This README ≈ a few hundred tokens, loaded only when needed.
- Outputs can be piped, saved, and composed with ordinary shell tools.
- Adding a new command is a single file — no protocol, no rebuild, no restart.

## State & troubleshooting

- State file: `$TMPDIR/browse-tool-state.json`
- If `browse-nav` says "Cannot connect", run `browse-start`.
- If Chrome is already open with your real profile, quit it first or pick a different `--port`. browse-tool always launches into a temp `--user-data-dir`, so it will never touch your real profile directly.
- Override Chrome path with `CHROME_PATH=/path/to/chrome`.
