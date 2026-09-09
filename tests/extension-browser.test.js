import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { readState, userDataDirOf } from "../lib/connect.js";
import { FeedbackRepository } from "../lib/feedback-repository.js";

test("real extension toolbar, native save, CLI read, reload, and status", { timeout: 45000 }, async () => {
  const source = fileURLToPath(new URL("../", import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), "feedback-extension-"));
  const inbox = join(scratch, "inbox");
  const prepared = JSON.parse(execFileSync(process.execPath, [join(source, "scripts/prepare-feedback.mjs"), "--out", scratch, "--root", inbox], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }));
  const port = Number(process.env.BROWSE_PORT || 9222);
  const profile = userDataDirOf(readState(port)?.pid);
  if (!profile) throw new Error("Cannot identify the automation browser for temporary native-host registration.");
  const hostFile = join(profile, "NativeMessagingHosts/com.browse_tool.page_feedback.json");
  await mkdir(join(profile, "NativeMessagingHosts"), { recursive: true });
  // Never overwrite a user's installed host. This file is owned by this test only.
  await writeFile(hostFile, await readFile(join(scratch, "com.browse_tool.page_feedback.json")), { flag: "wx" });
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  const cdp = await browser.target().createCDPSession();
  const fixture = await readFile(new URL("./fixtures/annotations.html", import.meta.url), "utf8");
  const server = createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(fixture); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const { targetId: ownedTargetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true, width: 1100, height: 940 });
  const page = await (await browser.waitForTarget((target) => target._targetId === ownedTargetId)).asPage();
  page.setDefaultTimeout(7000);
  let popup, loaded = false;
  const panel = "#__browse_annotations__ >>> ";
  const ui = (selector) => page.click(panel + selector);
  const savedMessage = () => page.waitForFunction(() => document.getElementById("__browse_annotations__")?.shadowRoot.querySelector(".message").textContent.includes("Comment and screenshot saved"));
  try {
    // Refuse an existing installation; its ownership cannot be inferred from its ID.
    const installed = await cdp.send("Extensions.getExtensions");
    assert.ok(!installed.extensions.some((item) => item.id === prepared.extensionId), "The feedback extension is already installed; leave it untouched");
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: join(scratch, "chrome-extension") });
    loaded = true;
    assert.equal(id, prepared.extensionId);
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.bringToFront();
    const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }] });
    const tabTarget = targetInfos.find((target) => target.type === "tab" && target.url === page.url());
    assert.ok(tabTarget, "Find the test tab target, not its child page target");
    await cdp.send("Extensions.triggerAction", { id, targetId: tabTarget.targetId });
    popup = await (await browser.waitForTarget((target) => target.url() === `chrome-extension://${id}/popup.html`, { timeout: 7000 })).asPage();
    await popup.waitForSelector('#batches[data-loaded="true"]');
    await popup.type("#title", "Real extension review");
    if (process.env.ANNOTATION_EVIDENCE_DIR) { await mkdir(process.env.ANNOTATION_EVIDENCE_DIR, { recursive: true }); await popup.screenshot({ path: join(process.env.ANNOTATION_EVIDENCE_DIR, "extension-popup.png") }); }
    await popup.click("#create");
    await page.waitForSelector(panel + "#element");
    await ui("#element"); await page.click('[id="review:button"]');
    await page.type(panel + "textarea", "Captured through the real Chrome extension."); await ui("#save"); await savedMessage();
    const repository = await new FeedbackRepository(inbox).init();
    const { batches } = await repository.list(); assert.equal(batches.length, 1);
    const batchId = batches[0].batchId;
    const batch = await repository.read(batchId); assert.equal(batch.annotations.length, 1);
    const png = await repository.screenshot(batchId, batch.annotations[0].id); assert.equal(png.subarray(1, 4).toString(), "PNG");
    if (process.env.ANNOTATION_EVIDENCE_DIR) await writeFile(join(process.env.ANNOTATION_EVIDENCE_DIR, "extension-saved-page.png"), png);
    const cli = JSON.parse(execFileSync(process.execPath, [join(source, "bin/browse-feedback"), "read", "--root", inbox, "--batch", batchId], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }));
    assert.equal(cli.annotations[0].comment, "Captured through the real Chrome extension.");
    await repository.status(batchId, batch.annotations[0].id, "resolved");
    await ui("#check");
    await page.waitForFunction(() => document.getElementById("__browse_annotations__").shadowRoot.querySelector("li").textContent.includes("resolved"));
    await page.reload(); await page.waitForSelector(panel + "li");
    if (process.env.ANNOTATION_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.ANNOTATION_EVIDENCE_DIR, "extension-in-page.png") });
    // Fault injection: force a valid but clipped PNG at Chrome's capture boundary.
    const clipped = await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 }, encoding: "base64" });
    const worker = await browser.waitForTarget((target) => target.type() === "service_worker" && target.url() === `chrome-extension://${id}/background.js`);
    const workerSession = await worker.createCDPSession();
    await workerSession.send("Runtime.evaluate", { expression: `chrome.tabs.captureVisibleTab = async () => ${JSON.stringify("data:image/png;base64," + clipped)}` });
    await workerSession.detach();
    await ui("#page"); await page.type(panel + "textarea", "Reject a clipped capture."); await ui("#save");
    await page.waitForFunction(() => document.getElementById("__browse_annotations__").shadowRoot.querySelector(".message").textContent.includes("Screenshot dimensions do not match"));
    assert.equal((await repository.read(batchId)).annotations.length, 1, "A clipped screenshot must not be saved");
    await ui("#cancel");
    await ui("#finish"); await page.waitForFunction(() => !document.getElementById("__browse_annotations__"));
    console.log(`Real extension evidence: ${inbox}`);
  } catch (error) {
    console.error("Annotation panel:", await page.$eval(panel + ".message", (el) => el.textContent).catch(() => "not present"));
    throw error;
  } finally {
    await popup?.close().catch(() => {}); await page.close();
    if (loaded) await cdp.send("Extensions.uninstall", { id: prepared.extensionId }).catch(() => {});
    await cdp.detach(); browser.disconnect(); server.close();
    await unlink(hostFile);
  }
});
