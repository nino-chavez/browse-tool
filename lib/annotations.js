import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, activeOrFirstPage } from "./connect.js";
import { openBatch } from "./annotation-store.js";
import { installOverlay, checkAttachments } from "./annotation-overlay.js";

export async function runAnnotations(page, store, { signal } = {}) {
  const bridge = `__browse_annotation_${randomUUID().replaceAll("-", "")}`;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  let pending = Promise.resolve();
  let stopped = false;
  const check = async () => {
    const results = await page.evaluate(checkAttachments, store.batch.annotations);
    for (const result of results) {
      const { id, ...attachment } = result;
      store.batch.annotations.find((item) => item.id === id).attachment = attachment;
    }
    await store.persist();
    return store.batch.annotations;
  };
  const handle = async (request) => {
    if (stopped) throw new Error("Annotation session has ended.");
    if (request.action === "finish") { finish("finished"); return null; }
    if (request.action === "check") return check();
    if (request.action === "status") {
      const item = store.batch.annotations.find((item) => item.id === request.id);
      if (!item || !["open", "resolved"].includes(request.status)) throw new Error("Unknown comment or status.");
      const previous = { status: item.status, updatedAt: item.updatedAt };
      item.status = request.status;
      item.updatedAt = new Date().toISOString();
      try { await store.persist(); } catch (error) { Object.assign(item, previous); throw error; }
      return store.batch.annotations;
    }
    if (request.action !== "save") throw new Error("Unknown annotation action.");
    if (!["element", "region", "page"].includes(request.kind) || typeof request.comment !== "string" || !request.comment.trim() || request.comment.length > 10000) throw new Error("Choose a target and enter a comment (up to 10,000 characters).");
    // Treat the page binding as untrusted input: it cannot choose paths or commands.
    if (JSON.stringify(request).length > 40000) throw new Error("Annotation is too large.");
    const current = await page.evaluate(() => ({ url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, scroll: { x: scrollX, y: scrollY } }));
    if (JSON.stringify(current) !== JSON.stringify(request.context)) throw new Error("Page changed before capture. Select the target again.");
    const id = randomUUID();
    const item = { id, kind: request.kind, status: "open", comment: request.comment.trim(), createdAt: new Date().toISOString(), context: current, target: request.target, screenshot: `screenshots/${id}.png` };
    if (item.kind === "element") {
      const [attachment] = await page.evaluate(checkAttachments, [item]);
      if (attachment.state !== "matched") throw new Error("Selected element changed before capture.");
    }
    const screenshot = await page.screenshot({ type: "png", captureBeyondViewport: false });
    if (page.url() !== current.url) throw new Error("Page navigated during capture. Select the target again.");
    await writeFile(join(store.dir, item.screenshot), screenshot, { flag: "wx", mode: 0o600 });
    item.attachment = { state: item.kind === "element" ? "matched" : "snapshot", checkedAt: item.createdAt };
    store.batch.annotations.push(item);
    try { await store.persist(); } catch (error) { store.batch.annotations.pop(); throw error; }
    return store.batch.annotations;
  };
  const stop = () => finish("interrupted");
  const install = async () => {
    await check();
    await page.evaluate(installOverlay, { bridge, items: store.batch.annotations });
  };
  const onLoad = () => {
    pending = pending.then(install).catch((error) => { console.error(`Could not reopen annotations: ${error.message}`); finish("interrupted"); });
  };
  try {
    await page.exposeFunction(bridge, (request) => {
      const result = pending.then(() => handle(request));
      pending = result.catch(() => {});
      return result;
    });
    page.on("close", stop);
    page.on("error", stop);
    page.browser().on("disconnected", stop);
    signal?.addEventListener("abort", stop, { once: true });
    await install();
    page.on("domcontentloaded", onLoad);
    if (signal?.aborted) stop();
    return await finished;
  } finally {
    stopped = true;
    page.off("domcontentloaded", onLoad);
    page.off("close", stop);
    page.off("error", stop);
    page.browser().off("disconnected", stop);
    signal?.removeEventListener("abort", stop);
    await pending;
    await page.evaluate((owner) => {
      const host = document.getElementById("__browse_annotations__");
      if (host?.dataset.browseBridge === owner) host.dispatchEvent(new Event("browse-annotations-close"));
    }, bridge).catch(() => {});
    await page.removeExposedFunction(bridge).catch(() => {});
  }
}

export async function annotate(args) {
  // Validate arguments before connecting; acquire output lock only after connection.
  if (args.out && args.resume) throw new Error("Use either --out or --resume.");
  for (const key of ["out", "resume"]) if (args[key] !== undefined && typeof args[key] !== "string") throw new Error(`--${key} requires a directory path.`);
  const browser = await connect(args.port);
  let store;
  const abort = new AbortController();
  const stop = () => abort.abort();
  try {
    const page = await activeOrFirstPage(browser);
    store = await openBatch(args);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.error(`Annotating ${page.url()}\nSaving each comment to ${store.dir}\nUse Finish in the page to prepare the handoff. Ctrl+C keeps saved comments.`);
    await runAnnotations(page, store, { signal: abort.signal });
    console.log(join(store.dir, "feedback.md"));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await store?.close();
    browser.disconnect();
  }
}
