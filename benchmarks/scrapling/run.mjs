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
function score(output, required, excluded) { return { required_found: required.filter(x => output.includes(x)), required_missing: required.filter(x => !output.includes(x)), excluded_found: excluded.filter(x => output.includes(x)) }; }
function pass(result, absent) { return absent ? !result.selected : result.required_missing.length === 0 && result.excluded_found.length === 0; }
// Audit retained outputs without consuming another candidate experiment run.
if (process.argv.includes("--verify-saved")) {
  const saved = JSON.parse(await readFile(join(here, "results.json"), "utf8"));
  const review = { schema: 1, source: "results.json and preserved Markdown outputs; no extraction rerun", fixture_hashes_match: true, answer_hashes_match: true, cases: [] };
  for (const item of manifest.cases) {
    for (const rel of [item.before, item.after]) {
      if (hash(await readFile(join(here, rel), "utf8")) !== saved.fixture_hashes[rel]) throw new Error(`Fixture changed: ${rel}`);
    }
    const answer = hash(JSON.stringify({ required: item.required, excluded: item.excluded, expected_absent: !!item.expected_absent }));
    if (answer !== saved.answer_hashes[item.id]) throw new Error(`Answer changed: ${item.id}`);
    const row = { id: item.id, expected_absent: !!item.expected_absent };
    for (const key of ["a", "b", "c"]) {
      const output = await readFile(join(out, `${item.id}.${key.toUpperCase()}.md`), "utf8");
      const measured = { ...score(output, item.required, item.excluded), selected: key === "a" || !!output.trim() };
      row[key] = { ...measured, pass: item.expected_absent && key !== "c" ? null : pass(measured, !!item.expected_absent) };
    }
    review.cases.push(row);
  }
  const first = manifest.cases[0];
  const clean = await readFile(join(out, `${first.id}.A.md`), "utf8");
  const evaluate = (output) => pass({ ...score(output, first.required, first.excluded), selected: true }, false);
  review.scorer_controls = {
    retained_clean_output_passes: evaluate(clean),
    removed_required_text_fails: !evaluate(clean.replaceAll(first.required[0], "CORRUPTED")),
    injected_noise_fails: !evaluate(`${clean}\n${first.excluded[0]}`),
    selected_decoy_fails_absence: !pass({ selected: true }, true),
    empty_selection_passes_absence: pass({ selected: false }, true),
  };
  if (!Object.values(review.scorer_controls).every(Boolean)) throw new Error("Scorer control failed");
  await writeFile(join(here, "results.review.json"), `${JSON.stringify(review, null, 2)}\n`);
  console.log("Verified saved fixture hashes, answer hashes, outputs, and scorer controls; no candidate rerun.");
  process.exit(0);
}
await rm(out, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); await mkdir(out, { recursive: true });
function python(request) {
  const start = performance.now();
  const child = spawnSync(py, [adapter], { input: JSON.stringify(request), encoding: "utf8", cwd: root, timeout: 30000 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(child.stderr);
  return { ...JSON.parse(child.stdout), subprocess_wall_ns: elapsed(start) };
}
const results = { schema: 1, frozen_configuration: manifest.frozen_configuration, fixture_hashes: {}, answer_hashes: {}, arms: { A: "actual browse-tool htmlToMarkdown default (Readability plus Turndown)", B: "Scrapling Response.markdown(main_content_only=true), parser-only", C: "Scrapling adaptive selection learned on BEFORE; selected subtree formatted by incumbent Turndown" }, cases: [] };
for (const item of manifest.cases) {
  const beforePath = join(here, item.before), afterPath = join(here, item.after);
  const before = await readFile(beforePath, "utf8"), after = await readFile(afterPath, "utf8");
  results.fixture_hashes[item.before] = hash(before); results.fixture_hashes[item.after] = hash(after);
  results.answer_hashes[item.id] = hash(JSON.stringify({ required: item.required, excluded: item.excluded, expected_absent: !!item.expected_absent }));
  // htmlToMarkdown intentionally returns title separately; browse-markdown prints both.
  const aStart = performance.now(), extracted = htmlToMarkdown(after, item.url), aText = `# ${extracted.title}\n\n${extracted.markdown}`;
  const aParseNs = elapsed(aStart);
  const bRaw = python({ mode: "generic", html_path: afterPath, url: item.url });
  const storage = join(state, `${item.id}.sqlite`);
  const learn = python({ mode: "adaptive", html_path: beforePath, url: item.url, selector: item.selector, identifier: item.id, adaptive: false, auto_save: true, storage_file: storage });
  if (!learn.selected) throw new Error(`BEFORE selector did not select ${item.id}`);
  const selected = python({ mode: "adaptive", html_path: afterPath, url: item.url, selector: item.selector, identifier: item.id, adaptive: true, auto_save: false, storage_file: storage });
  const cText = selected.selected ? htmlToMarkdown(`<html><body>${selected.output}</body></html>`, item.url, { raw: true }).markdown : "";
  const arm = (output, raw, extra = {}) => ({ ...score(output, item.required, item.excluded), selected: raw.selected, parse_ns: raw.parse_ns, subprocess_wall_ns: raw.subprocess_wall_ns, ...extra });
  const row = { id: item.id, expected_absent: !!item.expected_absent, a: arm(aText, { selected: true, parse_ns: aParseNs }), b: arm(bRaw.output, bRaw), c: arm(cText, selected, { learn_parse_ns: learn.parse_ns, learn_subprocess_wall_ns: learn.subprocess_wall_ns }) };
  for (const key of ["a", "b", "c"]) row[key].pass = row.expected_absent && key !== "c" ? null : pass(row[key], row.expected_absent);
  results.cases.push(row);
  await Promise.all([writeFile(join(out, `${item.id}.A.md`), aText), writeFile(join(out, `${item.id}.B.md`), bRaw.output), writeFile(join(out, `${item.id}.C.md`), cText)]);
}
const first = manifest.cases[0];
const corrupted = (await readFile(join(out, `${first.id}.A.md`), "utf8")).replaceAll(first.required[0], "CORRUPTED");
results.harness_negative_control = { case: first.id, deliberately_corrupted_output_rejected: !pass({ ...score(corrupted, first.required, first.excluded), selected: true }, false) };
if (!results.harness_negative_control.deliberately_corrupted_output_rejected) throw new Error("Scorer accepted corrupted output");
await writeFile(join(here, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
await rm(state, { recursive: true, force: true });
console.log(`wrote ${join(here, "results.json")}`);
