import puppeteer from "puppeteer-core";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const STATE_FILE = join(tmpdir(), "browse-tool-state.json");
export const DEFAULT_PORT = 9222;

// Who is ACTUALLY listening on the port. The state file records a pid we
// spawned; it never proved that pid won the port. A headless orphan from an
// earlier session can hold it while the recorded pid runs portless, and then
// every browse-* command drives the orphan while reporting the intended
// profile. That failure is silent and total: navigation, screenshots and
// cookie reads all succeed, against the wrong browser.
// Returns [] when lsof is unavailable or nothing is listening — callers treat
// an empty list as "cannot determine" and fail open rather than block work.
export function portOwners(port = DEFAULT_PORT) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set(out.split("\n").map((s) => Number(s.trim())).filter(Boolean))];
  } catch {
    return [];
  }
}

// Profile name behind a pid, for error messages that name the squatter.
export function profileOf(pid) {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dir = cmd.match(/--user-data-dir=(\S+)/);
    const headless = /--headless/.test(cmd);
    return `${dir ? dir[1].split("/").pop() : "unknown"}${headless ? " [headless]" : ""}`;
  } catch {
    return "unknown";
  }
}

// Throws when the port is held by something other than the tracked pid.
// Only enforced when we have a tracked pid AND lsof answered — otherwise the
// caller is attaching to a Chrome it did not start, which stays allowed.
export function assertPortIdentity(state, port) {
  const owners = portOwners(port);
  if (!owners.length || !state?.pid) return;
  if (owners.includes(state.pid)) return;
  const who = owners.map((p) => `pid ${p} (profile: ${profileOf(p)})`).join(", ");
  throw new Error(
    `Port ${port} is held by ${who}, not the tracked pid ${state.pid} ` +
      `(profile: ${profileOf(state.pid)}).\n` +
      `Commands would silently drive the wrong browser. Run 'browse-stop' to clear it, then 'browse-start' again.`,
  );
}

export function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export async function connect() {
  const state = readState();
  const port = state?.port ?? DEFAULT_PORT;
  try {
    assertPortIdentity(state, port);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  try {
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${port}`,
      defaultViewport: null,
    });
    return browser;
  } catch (err) {
    console.error(
      `Cannot connect to Chrome on port ${port}. Run 'browse-start' first.\n${err.message}`,
    );
    process.exit(1);
  }
}

export async function activeOrFirstPage(browser) {
  const pages = await browser.pages();
  if (pages.length === 0) return browser.newPage();
  for (const p of pages) {
    try {
      const visible = await p.evaluate(() => document.visibilityState);
      if (visible === "visible") return p;
    } catch {}
  }
  return pages[pages.length - 1];
}

export function parseArgs(argv, spec = {}) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (spec[key] === "bool" || !next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}
