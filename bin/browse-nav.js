#!/usr/bin/env node
import { connect, activeOrFirstPage, parseArgs } from "../lib/connect.js";

const args = parseArgs(process.argv.slice(2), { new: "bool", wait: "bool" });
const url = args._[0];
if (!url) {
  console.error("Usage: browse-nav <url> [--new] [--wait]");
  process.exit(1);
}

const browser = await connect();
const page = args.new ? await browser.newPage() : await activeOrFirstPage(browser);

try {
  await page.goto(url, {
    waitUntil: args.wait ? "networkidle2" : "domcontentloaded",
    timeout: 30000,
  });
  const title = await page.title();
  console.log(`${page.url()}\n${title}`);
} catch (err) {
  console.error(`Navigation failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  browser.disconnect();
}
