import puppeteer from "puppeteer-core";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const STATE_FILE = join(tmpdir(), "browse-tool-state.json");
export const DEFAULT_PORT = 9222;

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
