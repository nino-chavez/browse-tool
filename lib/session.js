// Per-session tab leases over ONE shared browser.
//
// Why this exists: browse-start used to derive the profile name from
// basename(process.cwd()), so every repo, worktree and scratch directory minted
// its own Chrome profile. That reached 102 profiles / 74 GB — five of which had
// each independently downloaded the same 4 GB on-device model. The directory a
// session happens to sit in is not an identity; it was never meant to be one.
//
// The fix is one shared profile driven by one Chrome, with sessions isolated at
// the TAB level rather than the profile level. That needs a lease, because
// activeOrFirstPage() picks the same page from every process — verified: two
// independent processes both selected the same tab, so without a lease parallel
// sessions silently drive each other's browser.
//
// Leases live one-file-per-session under ~/.browse-tool/leases/. Deliberately
// NOT in the shared state file: every browse-* command is a separate process,
// and concurrent read-modify-write on one JSON file is the race this feature
// would otherwise introduce. One file per session means no contention at all.
//
// Genuinely-separate profiles remain available via --profile-name, and are only
// warranted for simultaneous distinct authenticated identities on the same
// origin (meta-admin vs meta-setup). For a logged-out view, prefer
// BROWSE_INCOGNITO=1 — a BrowserContext is addressable across separate CLI
// processes (verified), so it gives isolated cookies without a second profile.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePort } from "./state.js";

export const LEASE_DIR = join(homedir(), ".browse-tool", "leases");
const STALE_MS = 12 * 60 * 60 * 1000; // a lease untouched this long is abandoned

/** Stable per-session id from whichever harness is driving. */
export function sessionId() {
  const explicit =
    process.env.BROWSE_SESSION ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CODEX_COMPANION_SESSION_ID;
  if (explicit) return explicit.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  // No harness id (a plain shell). Fall back to the parent pid so repeated
  // commands from the same shell reuse one tab instead of opening a new one
  // each time.
  return `ppid-${process.ppid}`;
}

// A session holds one lease PER ISOLATION MODE, not one lease overall.
//
// Isolation is part of a tab's identity: the shared-profile tab and the incognito
// tab are different tabs with different cookie jars, and a session legitimately
// wants both. With a single lease, flipping BROWSE_INCOGNITO discarded whichever
// tab you were not currently asking for, so flipping back handed you a fresh
// about:blank and silently lost the page (and cookies) you had. Keying the lease
// by mode makes the round trip return you to the tab you left.
const leaseName = (id, incognito) => `${id}${incognito ? ".incognito" : ""}.json`;
const leaseFile = (id = sessionId(), incognito = false) =>
  join(LEASE_DIR, leaseName(id, incognito));

export function readLease(id = sessionId(), incognito = false) {
  try {
    return JSON.parse(readFileSync(leaseFile(id, incognito), "utf8"));
  } catch {
    return null;
  }
}

export function writeLease(data, id = sessionId(), incognito = false) {
  try {
    mkdirSync(LEASE_DIR, { recursive: true });
    const tmp = join(LEASE_DIR, `.${leaseName(id, incognito)}.tmp`);
    writeFileSync(tmp, JSON.stringify({ ...data, ts: Date.now() }, null, 2));
    renameSync(tmp, leaseFile(id, incognito)); // atomic
  } catch {}
}

/** Drop this session's lease(s): one mode, or both when unspecified. */
export function clearLease(id = sessionId(), incognito = null) {
  const modes = incognito === null ? [false, true] : [incognito];
  for (const m of modes) {
    try {
      unlinkSync(leaseFile(id, m));
    } catch {}
  }
}

/** Every lease on the machine, tagged with the session that owns it. */
export function allLeases() {
  const out = [];
  try {
    if (!existsSync(LEASE_DIR)) return out;
    for (const f of readdirSync(LEASE_DIR)) {
      if (!f.endsWith(".json") || f.startsWith(".")) continue;
      try {
        const d = JSON.parse(readFileSync(join(LEASE_DIR, f), "utf8"));
        out.push({ ...d, id: f.replace(/(\.incognito)?\.json$/, ""), file: f });
      } catch {}
    }
  } catch {}
  return out;
}

export const isLive = (lease) => Date.now() - (lease?.ts ?? 0) < STALE_MS;

/**
 * Drop leases pointing at the browser on `port`.
 *
 * Scoped, not global: browse-stop kills one browser, and wiping every session's
 * lease would orphan the tabs of sessions driving a different port entirely.
 */
export function clearLeasesForPort(port) {
  let n = 0;
  for (const lease of allLeases()) {
    if (lease.port !== port) continue;
    try {
      unlinkSync(join(LEASE_DIR, lease.file));
      n++;
    } catch {}
  }
  return n;
}

/** Live (non-stale) lease count — used to refuse a destructive reseed. */
export function liveLeaseCount() {
  return allLeases().filter(isLive).length;
}

async function targetIdOf(page) {
  // Public CDP surface — page.target()._targetId is private and version-fragile.
  try {
    const cdp = await page.createCDPSession();
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await cdp.detach().catch(() => {});
    return targetInfo?.targetId ?? null;
  } catch {
    return null;
  }
}

const wantsIncognito = (opts) =>
  opts.incognito ?? process.env.BROWSE_INCOGNITO === "1";

/**
 * A brand-new tab for this session, which takes over the session's lease.
 *
 * `browse-nav --new` needs this. Calling browser.newPage() directly leaves the
 * lease pointing at the PREVIOUS tab, which is still open — so the next
 * browse-eval / browse-screenshot resolves that one and silently reads the wrong
 * page. Creating the tab and claiming the lease has to be one operation.
 */
export async function createSessionPage(browser, opts = {}) {
  const incognito = wantsIncognito(opts);
  const port = opts.port ?? resolvePort();
  const lease = readLease(sessionId(), incognito);

  let page;
  let contextId = null;
  if (incognito) {
    // Reuse this session's context across processes when it survived, so an
    // incognito session keeps one cookie jar instead of a fresh one per command.
    let ctx = lease?.contextId
      ? browser.browserContexts().find((c) => c.id === lease.contextId)
      : null;
    if (!ctx) ctx = await browser.createBrowserContext();
    contextId = ctx.id ?? null;
    page = await ctx.newPage();
  } else {
    page = await browser.newPage();
  }
  writeLease(
    { targetId: await targetIdOf(page), contextId, incognito, port },
    sessionId(),
    incognito,
  );
  return page;
}

/**
 * The page belonging to THIS session, creating it on first use.
 *
 * Resolution order:
 *   1. the tab leased for the requested isolation mode, if it still exists
 *   2. a fresh tab (in an isolated BrowserContext when BROWSE_INCOGNITO=1)
 *
 * Looking the lease up BY MODE is what makes BROWSE_INCOGNITO actually work. A
 * single lease per session meant any session that had already run one command
 * held a shared-profile tab, and the next `BROWSE_INCOGNITO=1 browse-nav` simply
 * resolved that lease and handed back the logged-in context — no isolation, no
 * warning.
 *
 * Falls back to the old "active or first page" behaviour only when tab creation
 * fails, so a broken lease degrades to the previous semantics rather than to an
 * error — this runs inside every browse-* command and must not become a new way
 * for them to fail.
 */
export async function sessionPage(browser, opts = {}) {
  const incognito = wantsIncognito(opts);
  const port = opts.port ?? resolvePort();
  const lease = readLease(sessionId(), incognito);

  if (lease?.targetId) {
    for (const p of await browser.pages()) {
      if ((await targetIdOf(p)) === lease.targetId) {
        try {
          await p.bringToFront();
        } catch {}
        // Refresh ts on USE, not just on creation. Otherwise a lease records the
        // tab's birth time, a session working longer than STALE_MS drops out of
        // liveLeaseCount() while genuinely live, and browse-start --reseed then
        // rsyncs --delete over Default/ underneath a running Chrome — exactly
        // what that guard exists to prevent.
        writeLease({ ...lease, port }, sessionId(), incognito);
        return p;
      }
    }
  }

  try {
    return await createSessionPage(browser, { ...opts, incognito, port });
  } catch {
    const pages = await browser.pages();
    if (!pages.length) return browser.newPage();
    return pages[pages.length - 1];
  }
}
