#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { connect, activeOrFirstPage, parseArgs } from "../lib/connect.js";

const args = parseArgs(process.argv.slice(2), { stdin: "bool" });

let code;
if (args.file) {
  code = readFileSync(args.file, "utf8");
} else if (args.stdin || args._.length === 0) {
  code = readFileSync(0, "utf8");
} else {
  code = args._.join(" ");
}

if (!code.trim()) {
  console.error("Usage: browse-eval '<js>'  |  browse-eval --file script.js  |  echo '<js>' | browse-eval --stdin");
  process.exit(1);
}

const browser = await connect();
const page = await activeOrFirstPage(browser);

try {
  const wrapped = `(async () => { ${code} })()`;
  const result = await page.evaluate(async (src) => {
    const fn = new Function(`return ${src}`);
    const out = await fn();
    try {
      return { ok: true, value: JSON.parse(JSON.stringify(out)) };
    } catch {
      return { ok: true, value: String(out) };
    }
  }, wrapped);

  const v = result.value;
  if (v === undefined) {
    console.log("undefined");
  } else if (typeof v === "string") {
    console.log(v);
  } else {
    console.log(JSON.stringify(v, null, 2));
  }
} catch (err) {
  console.error(`Eval failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  browser.disconnect();
}
