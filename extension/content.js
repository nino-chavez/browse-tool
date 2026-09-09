// Bundled with the shared overlay inside Chrome's isolated content-script world.
(async () => {
  if (document.getElementById("__browse_annotations__")) return;
  const bridge = `__feedback_${crypto.randomUUID().replaceAll("-", "")}`;
  const send = async (request) => {
    const response = await chrome.runtime.sendMessage({ channel: "page-feedback", request });
    if (!response?.ok) throw new Error(response?.error || "The extension disconnected. Reopen it from the toolbar.");
    return response.result;
  };
  const review = await send({ action: "get" });
  let items = review.items;
  window[bridge] = async (request) => {
    if (request.action === "check") {
      items = (await send({ action: "get" })).items;
      request.results = checkAttachments(items);
    }
    if (request.action === "save") {
      // Wait for hidden overlay paint before the service worker captures the tab.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }
    const result = await send(request);
    if (Array.isArray(result)) items = result;
    if (request.action === "finish") delete window[bridge];
    return result;
  };
  items = await window[bridge]({ action: "check" });
  installOverlay({ bridge, items, reviewTitle: review.title });
})().catch((error) => {
  // A visible error is essential: a service-worker console error is not a handoff.
  const notice = document.createElement("div");
  notice.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;background:white;color:#20252b;padding:16px;border:2px solid #ad3229;max-width:340px;font:14px/1.5 system-ui;";
  notice.textContent = `Page Feedback: ${error.message}`;
  const dismiss = document.createElement("button"); dismiss.textContent = "Dismiss"; dismiss.onclick = () => notice.remove();
  notice.append(document.createElement("br"), dismiss); document.documentElement.append(notice);
});
