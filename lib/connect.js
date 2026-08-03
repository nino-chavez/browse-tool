import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { sessionPage } from "./session.js";
import { DEFAULT_PORT, resolvePort, readState } from "./state.js";

// Re-exported for the bins and for examples/ scripts that build on this module
// directly. readLease/writeLease/clearLease stay internal to session.js: a lease
// written without a tab is a dangling pointer, and clearLease is port-blind, so
// callers outside want clearLeasesForPort instead.
export {
  sessionPage,
  createSessionPage,
  sessionId,
  allLeases,
  isLive,
  clearLeasesForPort,
} from "./session.js";
export { DEFAULT_PORT, resolvePort, stateFile, readState } from "./state.js";

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

function psCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * The --user-data-dir a Chrome pid was launched with, or null if unresolvable.
 *
 * ps flattens argv, so the value cannot be recovered by delimiter alone. Two
 * attempts at this were both wrong in opposite directions: `\S+` truncated any
 * profile name containing a space, and matching up to the next " --" swallowed
 * whatever followed when the next argument was NOT a flag — a trailing URL made
 * it report the profile as "example.com", and a Finder-launched Chrome's
 * "-psn_0_12345" landed inside the name. Both produced browse-start hard-erroring
 * "a Chrome running a DIFFERENT profile" about the right browser.
 *
 * There is no delimiter that works, so the filesystem arbitrates: cut at the next
 * " --" flag, then trim words from the right until what remains is a directory
 * that exists. Returns null rather than a guess — callers must not read that as a
 * mismatch.
 */
export function userDataDirOf(pid) {
  const cmd = psCommand(pid);
  if (!cmd) return null;
  const m = cmd.match(/--user-data-dir=([\s\S]*)$/);
  if (!m) return null;
  let rest = m[1];
  const flag = rest.search(/ --/);
  if (flag !== -1) rest = rest.slice(0, flag);
  rest = rest.trimEnd();
  if (existsSync(rest)) return rest;
  const parts = rest.split(" ");
  while (parts.length > 1) {
    parts.pop();
    const candidate = parts.join(" ");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Profile name behind a pid, for messages that name the squatter. Display only —
// compare userDataDirOf() against a known path when the answer decides something.
export function profileOf(pid) {
  const cmd = psCommand(pid);
  if (!cmd) return "unknown";
  const dir = userDataDirOf(pid);
  const headless = /--headless/.test(cmd);
  return `${dir ? dir.split("/").pop() : "unknown"}${headless ? " [headless]" : ""}`;
}

// Debugging port(s) a Chrome pid was launched with — the inverse of portOwners,
// for when you have the process and need the port. Read from the command line
// rather than lsof, because the pid in Chrome's SingletonLock is the browser
// process and its flags are authoritative.
export function portsOf(pid) {
  const cmd = psCommand(pid);
  if (!cmd) return [];
  return [...cmd.matchAll(/--remote-debugging-port=(\d+)/g)].map((m) => Number(m[1]));
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

export async function connect(explicitPort) {
  const port = resolvePort(explicitPort);
  const state = readState(port);
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
    browser.__browsePort = port;
    return browser;
  } catch (err) {
    console.error(
      `Cannot connect to Chrome on port ${port}. Run 'browse-start' first.` +
        (port === DEFAULT_PORT ? "" : ` (BROWSE_PORT=${port})`) +
        `\n${err.message}`,
    );
    process.exit(1);
  }
}

// Kept for API compatibility: all seven browse-* commands call this. It now
// resolves the CALLING SESSION's leased tab instead of "whichever page looks
// active", because a shared browser makes the old behaviour a collision — two
// independent processes provably selected the same tab. Set BROWSE_SHARED_TAB=1
// to restore the pre-lease behaviour (single-session use, or driving a tab a
// human opened by hand).
export async function activeOrFirstPage(browser) {
  if (process.env.BROWSE_SHARED_TAB === "1") return legacyActivePage(browser);
  return sessionPage(browser, { port: browser.__browsePort });
}

export async function legacyActivePage(browser) {
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

// --key value AND --key=value. The equals form is not cosmetic: without it
// `--port=9223` parsed as the KEY "port=9223" with no value, so args.port stayed
// undefined, resolvePort read that as "not provided", and every command quietly
// addressed 9222 instead. For browse-stop that meant killing the shared browser
// while reporting success — and the live-lease guard could not catch it, since
// the session's own lease is excluded by design.
export function parseArgs(argv, spec = {}) {
  const args = { _: [] };
  const asBool = (v) => v !== "false" && v !== "0" && v !== "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      const key = body.slice(0, eq);
      const value = body.slice(eq + 1);
      args[key] = spec[key] === "bool" ? asBool(value) : value;
      continue;
    }
    const next = argv[i + 1];
    if (spec[body] === "bool" || !next || next.startsWith("--")) {
      args[body] = true;
    } else {
      args[body] = next;
      i++;
    }
  }
  return args;
}
