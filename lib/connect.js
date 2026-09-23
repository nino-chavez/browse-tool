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
  // A containerised browser (browser-box) has no host-side Chrome process: the
  // port is held by Docker's proxy, and profileOf() on that pid is null. The
  // ps-based ownership check cannot answer the question it exists to answer, so
  // running it would reject a correctly-attached browser on evidence it never
  // had. The container name in the state file is the identity here.
  if (state?.container) return;
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

// Browser-chrome WebUI rendered as a `page` target with no tab behind it: the
// "Separate Browsing?" sign-in bubble (chrome://signin-dice-web-intercept.top-chrome/)
// is the measured case. puppeteer.connect() waits, with no timeout, for every
// page and iframe it discovers to auto-attach through a tab. These never do, so
// every browse-* command hung inside connect while raw CDP to the same tab
// answered at once (2026-09-23: signing a second Google account in at
// authuser=1 raised the bubble). Nothing here drives browser UI, so skipping
// them loses nothing. Chrome reports most of these surfaces as `browser_ui`;
// the bubble is the one that still arrives as `page`.
export const isBrowserChromeUi = (url = "") => /^chrome:\/\/[^/]+\.top-chrome\//.test(url);

// One watchdog per command, labelled by phase, so a hang fails loudly instead of
// parking the caller forever. puppeteer's own protocolTimeout does not cover
// this: the two waits that actually hang are not protocol commands (connect's
// wait for initial targets, evaluate's wait for an execution context).
//
// Two budgets. Setup (connect + tab lookup) normally takes ~30ms, so it gets
// 20s. The command itself gets BROWSE_TIMEOUT seconds, default 90 — under the
// 120s an agent's Bash call usually allows, so the diagnosis is printed before
// the harness kills the process and throws it away. BROWSE_TIMEOUT=0 turns both
// off; a smaller BROWSE_TIMEOUT also caps setup. Commands whose job is to run
// long (event streams, crawls, waiting for a human's pick) pass
// { timeCommand: false }: setup stays timed, their own work does not.
const SETUP_TIMEOUT_S = 20;
const DEFAULT_TIMEOUT_S = 90;
let phase = "startup";
let watchdogTimer = null;
let watchdogPort = null;
let commandSeconds = DEFAULT_TIMEOUT_S;
let timeCommand = true;

/**
 * Label what the command is doing, for the timeout message. Moving to
 * "command" ends setup: the setup timer is swapped for the command budget, or
 * dropped for commands that opted out. Bins that never call activeOrFirstPage
 * must call setPhase("command") themselves once their page is in hand.
 */
export const setPhase = (p) => {
  phase = p;
  if (p !== "command" || watchdogPort === null) return;
  clearTimeout(watchdogTimer);
  watchdogTimer = null;
  if (timeCommand && commandSeconds > 0) armWatchdog(watchdogPort, commandSeconds);
};

function timeoutSeconds() {
  const raw = process.env.BROWSE_TIMEOUT;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_S;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`BROWSE_TIMEOUT must be a number of seconds (got '${raw}').`);
    process.exit(1);
  }
  return n;
}

// Page and iframe targets no client is attached to. Those are what connect's
// startup wait blocks on, so naming them is the diagnosis. Raw CDP over the
// browser endpoint rather than puppeteer, because puppeteer is what is stuck.
export async function unattachedTargets(port, ms = 3000) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(ms),
  }).then((r) => r.json());
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Target.getTargets did not answer"));
    }, ms);
    ws.onopen = () =>
      ws.send(JSON.stringify({ id: 1, method: "Target.getTargets", params: { filter: [{}] } }));
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("could not open the browser websocket"));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      resolve(
        (msg.result?.targetInfos ?? []).filter(
          (t) =>
            (t.type === "page" || t.type === "iframe") &&
            !t.attached &&
            !t.url.startsWith("chrome-extension://"),
        ),
      );
    };
  });
}

function armWatchdog(port, seconds) {
  const cmd = process.argv[1]?.split("/").pop() ?? "browse";
  watchdogTimer = setTimeout(async () => {
    const lines = [`${cmd}: timed out after ${seconds}s during ${phase}.`];
    if (phase === "connect") {
      try {
        const stuck = await unattachedTargets(port);
        lines.push(
          stuck.length
            ? "Page/iframe targets nothing is attached to (connect waits on these):\n" +
                stuck
                  .map(
                    (t) =>
                      `  ${t.type} ${t.targetId.slice(0, 8)} ${t.url.slice(0, 120)}` +
                      (t.parentId ? `  (parent ${t.parentId.slice(0, 8)})` : ""),
                  )
                  .join("\n")
            : "Every page/iframe target is attached; the wait is somewhere else.",
        );
      } catch (err) {
        lines.push(`Target diagnosis failed: ${err.message}`);
      }
    } else if (phase === "tab lookup") {
      lines.push("Resolving this session's leased tab hung. 'browse-tabs list' shows the tabs.");
    }
    lines.push("Change the command limit with BROWSE_TIMEOUT=<seconds> (0 turns timing off).");
    console.error(lines.join("\n"));
    // Exit without disconnect(): a hung connection can hang disconnect too.
    process.exit(124);
  }, seconds * 1000);
  // Unref: a command that finishes must not sit waiting for the watchdog.
  watchdogTimer.unref();
}

export async function connect(explicitPort, { timeCommand: timed = true } = {}) {
  const port = resolvePort(explicitPort);
  const state = readState(port);
  try {
    assertPortIdentity(state, port);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  timeCommand = timed;
  commandSeconds = timeoutSeconds();
  if (commandSeconds > 0) {
    watchdogPort = port;
    armWatchdog(port, Math.min(SETUP_TIMEOUT_S, commandSeconds));
  }
  try {
    setPhase("connect");
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${port}`,
      defaultViewport: null,
      targetFilter: (target) => !isBrowserChromeUi(target.url()),
    });
    setPhase("connected");
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
  setPhase("tab lookup");
  const page =
    process.env.BROWSE_SHARED_TAB === "1"
      ? await legacyActivePage(browser)
      : await sessionPage(browser, { port: browser.__browsePort });
  setPhase("command");
  return page;
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
