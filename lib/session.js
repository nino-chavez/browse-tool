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

export const LEASE_DIR = join(homedir(), ".browse-tool", "leases");
const STALE_MS = 12 * 60 * 60 * 1000; // a lease older than this is abandoned

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

const leaseFile = (id = sessionId()) => join(LEASE_DIR, `${id}.json`);

export function readLease(id = sessionId()) {
  try {
    return JSON.parse(readFileSync(leaseFile(id), "utf8"));
  } catch {
    return null;
  }
}

export function writeLease(data, id = sessionId()) {
  try {
    mkdirSync(LEASE_DIR, { recursive: true });
    const tmp = join(LEASE_DIR, `.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify({ ...data, ts: Date.now() }, null, 2));
    renameSync(tmp, leaseFile(id)); // atomic
  } catch {}
}

export function clearLease(id = sessionId()) {
  try {
    unlinkSync(leaseFile(id));
  } catch {}
}

export function clearAllLeases() {
  try {
    for (const f of readdirSync(LEASE_DIR)) {
      if (f.endsWith(".json")) unlinkSync(join(LEASE_DIR, f));
    }
  } catch {}
}

/** Live (non-stale) lease count — used to refuse a destructive reseed. */
export function liveLeaseCount() {
  try {
    if (!existsSync(LEASE_DIR)) return 0;
    const now = Date.now();
    let n = 0;
    for (const f of readdirSync(LEASE_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const d = JSON.parse(readFileSync(join(LEASE_DIR, f), "utf8"));
        if (now - (d.ts ?? 0) < STALE_MS) n++;
      } catch {}
    }
    return n;
  } catch {
    return 0;
  }
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

/**
 * The page belonging to THIS session, creating it on first use.
 *
 * Resolution order:
 *   1. the leased tab, if it still exists in the browser
 *   2. a fresh tab (in an isolated BrowserContext when BROWSE_INCOGNITO=1)
 *
 * Falls back to the old "active or first page" behaviour only when tab creation
 * fails, so a broken lease degrades to the previous semantics rather than to an
 * error — this runs inside every browse-* command and must not become a new way
 * for them to fail.
 */
export async function sessionPage(browser, opts = {}) {
  const incognito = opts.incognito ?? process.env.BROWSE_INCOGNITO === "1";
  const lease = readLease();

  if (lease?.targetId) {
    for (const p of await browser.pages()) {
      if ((await targetIdOf(p)) === lease.targetId) {
        try {
          await p.bringToFront();
        } catch {}
        return p;
      }
    }
  }

  try {
    let page;
    let contextId = null;
    if (incognito) {
      // Reuse this session's context across processes when it survived.
      let ctx = lease?.contextId
        ? browser.browserContexts().find((c) => c.id === lease.contextId)
        : null;
      if (!ctx) ctx = await browser.createBrowserContext();
      contextId = ctx.id ?? null;
      page = await ctx.newPage();
    } else {
      page = await browser.newPage();
    }
    writeLease({ targetId: await targetIdOf(page), contextId, incognito });
    return page;
  } catch {
    const pages = await browser.pages();
    if (!pages.length) return browser.newPage();
    return pages[pages.length - 1];
  }
}
