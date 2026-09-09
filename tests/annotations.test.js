import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, access, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";
import { openBatch } from "../lib/annotation-store.js";
import { runAnnotations } from "../lib/annotations.js";
import { installOverlay, checkAttachments } from "../lib/annotation-overlay.js";
import { writeLease, clearLease } from "../lib/session.js";

// Use Node's built-in runner and the browser library this CLI already ships.
// No extra runner, profile, browser process, or application dependency is needed.
const scratch = await mkdtemp(join(tmpdir(), "browse-annotations-test-"));
const missing = async (path) => { await assert.rejects(access(path), { code: "ENOENT" }); };

test("batch storage refuses overwrite and concurrent writers, resumes exact JSON", async () => {
  const dir = join(scratch, "storage");
  const store = await openBatch({ out: dir });
  try {
    await assert.rejects(openBatch({ out: dir }), { code: "EEXIST" });
    await assert.rejects(openBatch({ resume: dir }), /locked/);
    await assert.rejects(openBatch({ out: true }), /directory path/);
    await assert.rejects(openBatch({ out: dir, resume: dir }), /Choose/);
    const saved = JSON.parse(await readFile(join(dir, "feedback.json"), "utf8"));
    assert.equal(saved.id, store.batch.id);
  } finally { await store.close(); }
  await missing(join(dir, ".lock"));
  const resumed = await openBatch({ resume: dir });
  assert.equal(resumed.batch.id, store.batch.id);
  await resumed.close();
  await writeFile(join(dir, "feedback.json"), '{"version":99}');
  await assert.rejects(openBatch({ resume: dir }), /Unsupported/);
  await missing(join(dir, ".lock"));
});

test("browser: capture, reopen, stale targets, navigation, errors, and cleanup", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${process.env.BROWSE_PORT || 9222}`, defaultViewport: null });
  const fixture = await readFile(new URL("./fixtures/annotations.html", import.meta.url), "utf8");
  const server = createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(fixture); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage(); // test-owned tab, never another session's lease
  await page.setViewport({ width: 1100, height: 820 });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dir = join(scratch, "browser");
  let store = await openBatch({ out: dir });
  let abort = new AbortController();
  let running;
  const panel = "#__browse_annotations__ >>> ";
  const click = (selector) => page.click(panel + selector);
  const waitMessage = (text) => page.waitForFunction((needle) => document.getElementById("__browse_annotations__")?.shadowRoot.querySelector(".message").textContent.includes(needle), {}, text);
  const add = async (kind, comment) => {
    await click(`#${kind}`);
    if (kind === "element") await page.click('[id="review:button"]');
    if (kind === "region") { await page.mouse.move(50, 100); await page.mouse.down(); await page.mouse.move(310, 230); await page.mouse.up(); }
    await page.type(panel + "textarea", comment);
    await click("#save");
    await waitMessage("Comment and screenshot saved");
  };
  try {
    await page.goto(url);
    running = runAnnotations(page, store, { signal: abort.signal });
    await page.waitForSelector(panel + "#element");
    await t.test("a second annotator cannot remove the first panel", async () => {
      const second = await openBatch({ out: join(scratch, "second-annotator") });
      try { await assert.rejects(runAnnotations(page, second), /already open/); }
      finally { await second.close(); }
      assert.ok(await page.$(panel + "#element"));
    });
    await t.test("saving an element does not activate it; screenshot and exact context survive", async () => {
      await add("element", "Make this label more specific.\nKeep the action available.");
      if (process.env.ANNOTATION_EVIDENCE_DIR) {
        await mkdir(process.env.ANNOTATION_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.ANNOTATION_EVIDENCE_DIR, "annotations-desktop.png") });
        await writeFile(join(process.env.ANNOTATION_EVIDENCE_DIR, "captured-page.png"), await readFile(join(dir, store.batch.annotations[0].screenshot)));
      }
      const [item] = store.batch.annotations;
      assert.equal(item.target.selector, "#review\\:button");
      assert.equal(item.context.url, url + "/");
      assert.equal(item.context.viewport.width, 1100);
      assert.equal(await page.$eval('[id="review:button"]', (el) => el.dataset.clicked), undefined);
      const png = await readFile(join(dir, item.screenshot));
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      const md = await readFile(join(dir, "feedback.md"), "utf8");
      assert.match(md, /> Make this label more specific\.\n> Keep the action available\./);
      assert.equal(JSON.parse(await readFile(join(dir, "feedback.json"), "utf8")).annotations.length, 1);
    });
    await t.test("region and whole-page comments both save", async () => {
      await add("region", "Give this area more breathing room.");
      await add("page", "The page needs a clearer next action.");
      assert.equal(store.batch.annotations.length, 3);
      assert.deepEqual(store.batch.annotations[1].target.rect, { x: 50, y: 100, width: 260, height: 130 });
      assert.equal(store.batch.annotations[2].kind, "page");
    });
    await t.test("resolved status persists and can be reopened", async () => {
      await click("li button"); await waitMessage("Status saved");
      assert.equal(store.batch.annotations[0].status, "resolved");
      assert.equal(JSON.parse(await readFile(join(dir, "feedback.json"), "utf8")).annotations[0].status, "resolved");
      await click("li button"); await waitMessage("Status saved");
      assert.equal(store.batch.annotations[0].status, "open");
    });
    await t.test("replaced or ambiguous elements become stale, other URLs stay unverified", async () => {
      await page.$eval('[id="review:button"]', (el) => { el.textContent = "A different action"; });
      await click("#check"); await waitMessage("Attachments checked");
      assert.equal(store.batch.annotations[0].attachment.state, "stale");
      await page.goto(url + "/second");
      await page.waitForSelector(panel + "#check");
      assert.equal(store.batch.annotations[0].attachment.state, "unverified");
      await page.goto(url);
      await page.waitForSelector(panel + "#check");
      assert.equal(store.batch.annotations[0].attachment.state, "matched");
      await page.$eval('[id="review:button"]', (el) => el.after(el.cloneNode(true)));
      const checked = await page.evaluate(checkAttachments, store.batch.annotations);
      assert.equal(checked[0].state, "stale");
      await page.goto(url); await page.waitForSelector(panel + "#check");
    });
    await t.test("write failure retains the draft; Finish cannot discard it", async () => {
      const persist = store.persist;
      store.persist = async () => { throw new Error("simulated disk failure"); };
      await click("#page");
      await page.type(panel + "textarea", "Do not lose this draft.");
      await click("#save"); await waitMessage("simulated disk failure");
      assert.equal(store.batch.annotations.length, 3);
      assert.equal(await page.$eval(panel + "textarea", (el) => el.value), "Do not lose this draft.");
      assert.equal(await page.$eval("#__browse_annotations__", (el) => getComputedStyle(el).visibility), "visible");
      await click("#finish"); await waitMessage("Save or cancel");
      store.persist = persist;
      await click("#save"); await waitMessage("Comment and screenshot saved");
      assert.equal(store.batch.annotations.length, 4);
    });
    await t.test("finish cleans up listeners, and a new session resumes the batch", async () => {
      await click("#finish"); assert.equal(await running, "finished");
      assert.equal(await page.$("#__browse_annotations__"), null);
      await page.click('[id="review:button"]');
      assert.equal(await page.$eval('[id="review:button"]', (el) => el.dataset.clicked), "yes");
      await store.close();
      store = await openBatch({ resume: dir });
      abort = new AbortController();
      running = runAnnotations(page, store, { signal: abort.signal });
      await page.waitForSelector(panel + "li");
      assert.equal(await page.$$eval(panel + "li", (rows) => rows.length), 4);
      abort.abort(); assert.equal(await running, "interrupted");
      assert.equal(await page.$("#__browse_annotations__"), null);
    });
    await t.test("narrow viewport: keyboard comment, Escape, and move controls remain usable", async () => {
      await page.setViewport({ width: 390, height: 844 });
      abort = new AbortController();
      running = runAnnotations(page, store, { signal: abort.signal });
      await page.waitForSelector(panel + "#page");
      await click("#page"); await page.type(panel + "textarea", "Draft to cancel"); await page.keyboard.press("Escape");
      assert.equal(await page.$eval(panel + "form", (el) => el.hidden), true);
      const bounds = await page.$eval(panel + ".panel", (el) => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, bottom: r.bottom }; });
      assert.ok(bounds.x >= 0 && bounds.right <= 390 && bounds.bottom <= 844);
      const finishBounds = await page.$eval(panel + "#finish", (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
      assert.ok(finishBounds.top >= 0 && finishBounds.bottom <= 844, "Finish batch remains visible without scrolling the panel");
      if (process.env.ANNOTATION_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.ANNOTATION_EVIDENCE_DIR, "annotations-mobile.png") });
      await click("#move");
      assert.equal(await page.$eval(panel + ".panel", (el) => el.getBoundingClientRect().top), 12);
      await click("#finish"); await running;
    });
    await t.test("CLI honors the tab lease, writes a handoff, and keeps saves on SIGINT", async () => {
      await store.close();
      await page.setViewport({ width: 1100, height: 820 });
      const lease = `annotation-cli-test-${process.pid}`;
      const cdp = await page.createCDPSession();
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      await cdp.detach();
      writeLease({ targetId: targetInfo.targetId, port: Number(process.env.BROWSE_PORT || 9222) }, lease);
      const childDir = join(scratch, "cli");
      const child = spawn(process.execPath, [new URL("../bin/browse-pick", import.meta.url).pathname, "--annotate", "--out", childDir, "--port", process.env.BROWSE_PORT || "9222"], {
        env: { ...process.env, BROWSE_SESSION: lease, BROWSE_INCOGNITO: "0", BROWSE_SHARED_TAB: "0" }, stdio: ["ignore", "pipe", "pipe"], timeout: 15000,
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
      const ended = once(child, "exit");
      try {
        await page.waitForSelector(panel + "#page");
        await add("page", "Saved through the actual command.");
        child.kill("SIGINT");
        const [code] = await ended;
        assert.equal(code, 0, stderr);
        assert.equal(stdout.trim(), join(childDir, "feedback.md"));
        assert.equal(JSON.parse(await readFile(join(childDir, "feedback.json"), "utf8")).annotations.length, 1);
        await missing(join(childDir, ".lock"));
        assert.equal(await page.$("#__browse_annotations__"), null);
      } finally { if (child.exitCode === null) child.kill(); clearLease(lease); }
    });
    assert.deepEqual(errors, []);
    console.log(`Annotation test evidence: ${dir}`);
  } finally {
    abort.abort();
    await running?.catch(() => {});
    await store.close();
    await page.close();
    browser.disconnect();
    server.close();
  }
});


test("draft recovery distinguishes geometry changes from title updates", { timeout: 20000 }, async () => {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${process.env.BROWSE_PORT || 9222}`, defaultViewport: null });
  const page = await browser.newPage();
  const saved = [];
  const panel = "#__browse_annotations__ >>> ";
  try {
    await page.setViewport({ width: 1100, height: 820 });
    await page.setContent(await readFile(new URL("./fixtures/annotations.html", import.meta.url), "utf8"));
    await page.exposeFunction("__draftTest", async (request) => { if (request.action === "save") saved.push(request); return []; });
    await page.evaluate(installOverlay, { bridge: "__draftTest", items: [] });
    await page.click(panel + "#region");
    await page.mouse.move(50,100); await page.mouse.down(); await page.mouse.move(300,200); await page.mouse.up();
    await page.type(panel + "textarea", "Keep this exact draft.");
    await page.evaluate(() => { document.title = "New chat notification"; });
    await page.click(panel + "#save");
    await page.waitForFunction(() => document.getElementById("__browse_annotations__").shadowRoot.querySelector(".message").textContent.includes("Comment and screenshot saved"), { timeout: 3000 });
    assert.equal(saved[0].context.title, "New chat notification");
    await page.click(panel + "#region");
    await page.mouse.move(50,100); await page.mouse.down(); await page.mouse.move(300,200); await page.mouse.up();
    await page.type(panel + "textarea", "Keep this after resizing.");
    await page.setViewport({ width: 1150, height: 820 });
    await page.click(panel + "#save");
    const error = await page.$eval(panel + ".message", e => e.textContent);
    assert.match(error, /1100.*1150/);
    assert.equal(saved.length, 1, "Changed geometry must not save against stale coordinates");
    await page.click(panel + "#reselect");
    await page.mouse.move(60,110); await page.mouse.down(); await page.mouse.move(320,220); await page.mouse.up();
    assert.equal(await page.$eval(panel + "textarea", e => e.value), "Keep this after resizing.");
    await page.click(panel + "#save");
    await page.waitForFunction(() => document.getElementById("__browse_annotations__").shadowRoot.querySelector(".message").textContent.includes("Comment and screenshot saved"), { timeout: 3000 });
    assert.equal(saved.length, 2);
    assert.equal(saved[1].context.viewport.width, 1150);
    assert.deepEqual(saved[1].target.rect, { x: 60, y: 110, width: 260, height: 110 });
  } finally { await page.close(); browser.disconnect(); }
});
