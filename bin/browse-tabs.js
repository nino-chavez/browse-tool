#!/usr/bin/env node
import { connect, parseArgs } from "../lib/connect.js";

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? "list";

const browser = await connect();

try {
  const pages = await browser.pages();

  if (cmd === "list") {
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const title = await p.title().catch(() => "");
      console.log(`[${i}] ${p.url()}  ${title}`);
    }
  } else if (cmd === "close") {
    const idx = Number(args._[1]);
    if (Number.isNaN(idx) || !pages[idx]) {
      console.error("Usage: browse-tabs close <index>");
      process.exit(1);
    }
    await pages[idx].close();
    console.log(`Closed tab ${idx}`);
  } else {
    console.error("Usage: browse-tabs [list|close <index>]");
    process.exit(1);
  }
} finally {
  browser.disconnect();
}
