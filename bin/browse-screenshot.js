#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { connect, activeOrFirstPage, parseArgs } from "../lib/connect.js";

const args = parseArgs(process.argv.slice(2), { full: "bool" });

const out = args.out
  ? resolve(args.out)
  : join(tmpdir(), `browse-tool-shot-${Date.now()}.png`);

mkdirSync(dirname(out), { recursive: true });

const browser = await connect();
const page = await activeOrFirstPage(browser);

try {
  await page.screenshot({ path: out, fullPage: !!args.full, type: "png" });
  console.log(out);
} catch (err) {
  console.error(`Screenshot failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  browser.disconnect();
}
