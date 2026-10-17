#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { htmlToMarkdown } from "../../lib/extract.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const manifest = JSON.parse(await readFile(join(here, "manifest.json"), "utf8"));
const out = join(here, "results");
const state = join(here, ".state");
const py = join(root, ".venv/bin/python");
const adapter = join(here, "scrapling_runner.py");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const elapsed = (start) => Math.round((performance.now() - start) * 1e6);
await rm(out, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); await mkdir(out, { recursive: true });
function score(output, required, excluded) { return { required_found: required.filter(x => output.includes(x)), required_missing: required.filter(x => !output.includes(x)), excluded_found: excluded.filter(x => output.includes(x)) }; }
function pass(result, absent) { return absent ? !result.selected : result.required_missing.length === 0 && result.excluded_found.length === 0; }
function python(request) {
  const start = performance.now();
  const child = spawnSync(py, [adapter], { input: JSON.stringify(request), encoding: "utf8", cwd: root });
  if (child.status !== 0) throw new Error(child.stderr);
  return { ...JSON.parse(child.stdout), startup_ns: elapsed(start) };
}
const results = { schema: 1, frozen_configuration: manifest.frozen_configuration, fixture_hashes: {}, answer_hashes: {}, arms: { A: "actual browse-tool htmlToMarkdown default (Readability plus Turndown)", B: "Scrapling Response.markdown(main_content_only=true), parser-only", C: "Scrapling adaptive selection learned on BEFORE; selected subtree formatted by incumbent Turndown" }, cases: [] };
for (const item of manifest.cases) {
  const beforePath = join(here, item.before), afterPath = join(here, item.after);
  const before = await readFile(beforePath, "utf8"), after = await readFile(afterPath, "utf8");
  results.fixture_hashes[item.before] = hash(before); results.fixture_hashes[item.after] = hash(after);
  results.answer_hashes[item.id] = hash(JSON.stringify({ required: item.required, excluded: item.excluded, expected_absent: !!item.expected_absent }));
  // htmlToMarkdown intentionally returns title separately; browse-markdown prints both.
  const aStart = performance.now(), extracted = htmlToMarkdown(after, item.url), aText = `# ${extracted.title}\n\n${extracted.markdown}`;
  const bRaw = python({ mode: "generic", html_path: afterPath, url: item.url });
  const storage = join(state, `${item.id}.sqlite`);
  const learn = python({ mode: "adaptive", html_path: beforePath, url: item.url, selector: item.selector, identifier: item.id, adaptive: false, auto_save: true, storage_file: storage });
  if (!learn.selected) throw new Error(`BEFORE selector did not select ${item.id}`);
  const selected = python({ mode: "adaptive", html_path: afterPath, url: item.url, selector: item.selector, identifier: item.id, adaptive: true, auto_save: false, storage_file: storage });
  const cText = selected.selected ? htmlToMarkdown(`<html><body>${selected.output}</body></html>`, item.url, { raw: true }).markdown : "";
  const arm = (output, raw, extra = {}) => ({ ...score(output, item.required, item.excluded), selected: raw.selected, parse_ns: raw.parse_ns, startup_ns: raw.startup_ns, ...extra });
  const row = { id: item.id, expected_absent: !!item.expected_absent, a: arm(aText, { selected: true, parse_ns: elapsed(aStart), startup_ns: 0 }), b: arm(bRaw.output, bRaw), c: arm(cText, selected, { learn_parse_ns: learn.parse_ns, learn_startup_ns: learn.startup_ns }) };
  for (const key of ["a", "b", "c"]) row[key].pass = pass(row[key], row.expected_absent);
  results.cases.push(row);
  await Promise.all([writeFile(join(out, `${item.id}.A.md`), aText), writeFile(join(out, `${item.id}.B.md`), bRaw.output), writeFile(join(out, `${item.id}.C.md`), cText)]);
}
const corrupted = { selected: true, required_missing: ["deliberately-corrupted-required-token"], excluded_found: [] };
results.harness_negative_control = { case: results.cases[0].id, deliberately_corrupted_output_rejected: !pass(corrupted, false) };
if (!results.harness_negative_control.deliberately_corrupted_output_rejected) throw new Error("Scorer accepted corrupted output");
await writeFile(join(here, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
await rm(state, { recursive: true, force: true });
console.log(`wrote ${join(here, "results.json")}`);
