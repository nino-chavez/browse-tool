const HOST = "com.browse_tool.page_feedback";
const key = (tabId) => `tab-${tabId}`;
const native = async (request) => {
  let reply;
  try { reply = await chrome.runtime.sendNativeMessage(HOST, request); }
  catch (error) { throw new Error(`Local feedback helper is unavailable. Install the native host, then reopen the extension. ${error.message}`); }
  if (!reply?.ok) throw new Error(reply?.error || "Local helper returned an invalid response.");
  return reply.result;
};
const readAll = async (batchId) => {
  let offset = 0; const items = [];
  do { const batch = await native({ action: "get", batchId, offset, limit: 20 }); items.push(...batch.annotations); offset = batch.nextOffset; } while (offset !== null);
  return items;
};
const bindingFor = async (tabId) => (await chrome.storage.session.get(key(tabId)))[key(tabId)];

async function attach(tabId, batchId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//.test(tab.url || "")) throw new Error("Open a normal http or https page, then click the extension icon.");
  const [{ result: existing }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!document.getElementById("__browse_annotations__") });
  if (existing) throw new Error("Finish the annotation panel already open in this tab before opening another batch.");
  const batch = await native({ action: "get", batchId, limit: 1 });
  const binding = { batchId, title: batch.title || batchId, origin: new URL(tab.url).origin };
  await chrome.storage.session.set({ [key(tabId)]: binding });
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] }); }
  catch (error) { await chrome.storage.session.remove(key(tabId)); throw error; }
  return { batchId };
}

function captureState() {
  return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, scroll: { x: scrollX, y: scrollY } };
}

// Chrome messages may reorder object keys. Compare values, not JSON serialization.
const sameContext = (a, b) => a.url === b.url && a.title === b.title &&
  a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height &&
  a.viewport.devicePixelRatio === b.viewport.devicePixelRatio && a.scroll.x === b.scroll.x && a.scroll.y === b.scroll.y;

async function capture(tabId, expected) {
  const before = await chrome.tabs.get(tabId);
  if (!before.active || before.url !== expected.url) throw new Error("Keep the page you are annotating in the active tab while saving.");
  const [{ result: context }] = await chrome.scripting.executeScript({ target: { tabId }, func: captureState });
  if (!sameContext(context, expected)) throw new Error("The page moved or changed. Select the target again.");
  const screenshot = await chrome.tabs.captureVisibleTab(before.windowId, { format: "png" });
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  const dimensionsMatch = Math.abs(bitmap.width - context.viewport.width * context.viewport.devicePixelRatio) <= 1 && Math.abs(bitmap.height - context.viewport.height * context.viewport.devicePixelRatio) <= 1;
  bitmap.close();
  if (!dimensionsMatch) throw new Error("Screenshot dimensions do not match this page. Turn off device emulation and save again.");
  const after = await chrome.tabs.get(tabId);
  const [{ result: latest }] = await chrome.scripting.executeScript({ target: { tabId }, func: captureState });
  if (!after.active || after.url !== before.url || !sameContext(latest, context)) throw new Error("The tab or page changed during capture. Save again with the original tab active.");
  return screenshot;
}

async function dispatch(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error("Unknown extension sender.");
  const { request } = message;
  if (!request || typeof request.action !== "string") throw new Error("Invalid request.");
  if (sender.url === chrome.runtime.getURL("popup.html")) {
    if (request.action === "list") return native({ action: "list", offset: request.offset || 0 });
    if (request.action === "create") return native({ action: "create", title: request.title });
    if (request.action === "attach") return attach(request.tabId, request.batchId);
    throw new Error("Unknown popup operation.");
  }
  if (!sender.tab || sender.frameId !== 0) throw new Error("Annotations are limited to the top page.");
  const binding = await bindingFor(sender.tab.id);
  if (!binding || new URL(sender.url).origin !== binding.origin) throw new Error("Click the extension icon on this page to start a review.");
  const batchId = binding.batchId;
  if (request.action === "get") return { title: binding.title, items: await readAll(batchId) };
  if (request.action === "finish") { await chrome.storage.session.remove(key(sender.tab.id)); return null; }
  if (request.action === "save") {
    const screenshot = await capture(sender.tab.id, request.context);
    const { kind, comment, target, context } = request;
    await native({ action: "save", batchId, annotation: { kind, comment, target, context }, screenshot });
  } else if (request.action === "status") await native({ action: "status", batchId, id: request.id, status: request.status });
  else if (request.action === "check") await native({ action: "attachments", batchId, results: request.results });
  else throw new Error("Unknown annotation operation.");
  return readAll(batchId);
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.channel !== "page-feedback") return;
  dispatch(message, sender).then((result) => reply({ ok: true, result }), (error) => reply({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(key(tabId)); });
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status !== "complete") return;
  const binding = await bindingFor(tabId);
  if (!binding) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (new URL(tab.url).origin !== binding.origin) { await chrome.storage.session.remove(key(tabId)); return; }
    await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
  } catch { /* activeTab grant expired: the user reopens from the toolbar */ }
});
