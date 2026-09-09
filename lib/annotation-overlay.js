// These functions execute in the page. Keep them self-contained for Puppeteer.
export function checkAttachments(items) {
  return items.map((item) => {
    const checkedAt = new Date().toISOString();
    const result = (state, reason) => ({ id: item.id, state, reason, checkedAt });
    if (item.context.url !== location.href) return result("unverified", "Open the original URL to check this comment.");
    if (item.kind !== "element") return result("snapshot", "Refer to the original screenshot.");
    try {
      const matches = document.querySelectorAll(item.target.selector);
      if (matches.length !== 1) return result("stale", "The original selector is missing or ambiguous.");
      const el = matches[0];
      const text = (el.innerText || el.textContent || "").trim().slice(0, 2000);
      if (el.tagName.toLowerCase() !== item.target.tag || text !== item.target.text || el.outerHTML.slice(0, 8000) !== item.target.html) {
        return result("stale", "The element changed. Compare with the original screenshot.");
      }
      return result("matched", "Selector, text, and markup match; appearance still needs review.");
    } catch { return result("stale", "The original selector cannot be checked."); }
  });
}

export function installOverlay({ bridge, items, reviewTitle = "" }) {
  if (document.getElementById("__browse_annotations__")) throw new Error("An annotation panel is already open in this tab.");
  const previousFocus = document.activeElement;
  const host = document.createElement("div");
  host.id = "__browse_annotations__";
  host.dataset.browseBridge = bridge;
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { color-scheme:light; }
      * { box-sizing:border-box; }
      .panel { position:fixed;top:16px;right:16px;width:320px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);overflow:auto;pointer-events:auto;background:#fff;color:#20252b;border:1px solid #bfc7d0;border-radius:12px;box-shadow:0 8px 32px #10182026;padding:16px;font:14px/1.45 system-ui,sans-serif; }
      h2 { font-size:16px;margin:0; } p { margin:8px 0 12px; }
      .muted { color:#526171;font-size:12px; }
      .row { display:flex;gap:6px;flex-wrap:wrap;align-items:center; }
      .head { justify-content:space-between;margin-bottom:8px; }
      button { appearance:none;font:inherit;background:#fff;color:#253747;border:1px solid #bcc7d0;border-radius:6px;padding:7px 10px;cursor:pointer;min-height:36px; }
      button:hover { background:#eef3f7; } button:focus-visible,textarea:focus-visible { outline:3px solid #185abc;outline-offset:2px; }
      button[aria-pressed=true], .primary { background:#185abc;color:white;border-color:#185abc; }
      button:disabled { opacity:.55;cursor:default; }
      label { display:block;margin:12px 0 5px;font-weight:600; }
      textarea { display:block;width:100%;min-height:80px;resize:vertical;padding:9px;border:1px solid #a7b3c1;border-radius:6px;font:inherit;color:inherit;background:white; }
      .actions { margin:10px 0; } .message { min-height:20px;margin-top:10px; }
      .footer { position:sticky;bottom:-16px;background:#fff;padding:12px 0;margin-bottom:-4px;border-top:1px solid #dce2e8; }
      ol { list-style:none;padding:0;margin:12px 0; } li { border-top:1px solid #dce2e8;padding:10px 0; }
      li p { margin:4px 0 8px;white-space:pre-wrap;overflow-wrap:anywhere; }
      .outline { position:fixed;display:none;pointer-events:none;border:2px solid #185abc;background:#185abc12; }
      .pin { position:fixed;pointer-events:none;background:#185abc;color:#fff;border:2px solid white;border-radius:50%;min-width:24px;height:24px;text-align:center;font:600 12px/20px system-ui; }
      [hidden] { display:none!important; }
      @media(max-width:500px) { .panel { top:auto;bottom:12px;right:12px;max-width:calc(100vw - 24px);max-height:56dvh; } }
    </style>
    <div class="outline"></div><div class="pins"></div>
    <section class="panel" role="region" aria-label="Page annotations">
      <div class="row head"><h2>Page feedback</h2><button id="move" title="Move panel to the other side">Move panel</button></div>
      <p id="review-context" class="muted" style="overflow-wrap:anywhere" hidden></p>
      <p class="muted">Choose what to comment on. Saved comments stay on your Mac.</p>
      <div class="row" aria-label="Comment target">
        <button id="element" aria-pressed="false">Element</button><button id="region" aria-pressed="false">Region</button><button id="page" aria-pressed="false">Whole page</button>
      </div>
      <p id="hint" class="muted">Choose Element, Region, or Whole page to begin.</p>
      <form hidden>
        <label for="comment">What should change?</label><textarea id="comment" maxlength="10000" required></textarea>
        <div class="row actions"><button class="primary" id="save" type="submit">Save comment</button><button id="reselect" type="button">Reselect target</button><button id="cancel" type="button">Cancel comment</button></div>
      </form>
      <div class="message" role="status" aria-live="polite"></div>
      <ol aria-label="Saved comments"></ol>
      <div class="row footer"><button id="check">Check attachments</button><button id="finish" class="primary">Finish review</button></div>
    </section>`;
  document.documentElement.appendChild(host);
  const $ = (selector) => root.querySelector(selector);
  if (reviewTitle) { $("#review-context").hidden = false; $("#review-context").textContent = `${reviewTitle} · ${location.host}`; }
  const call = window[bridge];
  let mode = null, target = null, context = null, start = null, busy = false, removed = false;
  let comments = items;
  const abort = new AbortController();
  const listen = (event, fn) => document.addEventListener(event, fn, { capture: true, signal: abort.signal });
  const inside = (event) => event.composedPath().includes(host);
  const message = (text) => { $(".message").textContent = text; };
  const getContext = () => ({ url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, scroll: { x: scrollX, y: scrollY } });
  const box = (rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  const outline = (rect) => {
    const node = $(".outline");
    node.style.cssText = rect ? `display:block;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;` : "display:none";
  };
  const selectorFor = (el) => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let node = el; node?.nodeType === 1; node = node.parentElement) {
      const index = node.parentElement ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName).indexOf(node) + 1 : 1;
      parts.unshift(`${CSS.escape(node.tagName.toLowerCase())}:nth-of-type(${index})`);
    }
    return parts.join(" > ");
  };
  const captureTarget = (el) => ({ selector: selectorFor(el), tag: el.tagName.toLowerCase(), text: (el.innerText || el.textContent || "").trim().slice(0, 2000), html: el.outerHTML.slice(0, 8000), rect: box(el.getBoundingClientRect()) });
  const reset = () => {
    mode = target = context = start = null;
    $("form").hidden = true;
    $("#comment").value = "";
    outline(null);
    for (const kind of ["element", "region", "page"]) $(`#${kind}`).setAttribute("aria-pressed", "false");
    $("#hint").textContent = "Choose Element, Region, or Whole page to begin.";
  };
  const selected = () => {
    context = getContext();
    $("form").hidden = false;
    $("#hint").textContent = mode === "element" ? `Selected ${target.tag}${target.text ? `: ${target.text.slice(0, 70)}` : ""}` : mode === "region" ? "Selected region. Its location is saved with the screenshot." : "Commenting on the whole page.";
    $("#comment").focus({ preventScroll: true });
  };
  const begin = (kind) => {
    if (busy) return;
    if ($("#comment").value.trim()) { message("Save or cancel your current comment first."); return; }
    reset(); mode = kind;
    $(`#${kind}`).setAttribute("aria-pressed", "true");
    message("");
    if (kind === "page") { target = {}; selected(); }
    else $("#hint").textContent = kind === "element" ? "Click an element on the page. Escape cancels." : "Drag a box around a region. Escape cancels.";
  };
  for (const kind of ["element", "region", "page"]) $(`#${kind}`).onclick = () => begin(kind);
  $("#cancel").onclick = () => { if (!busy) { reset(); message(""); } };
  $("#reselect").onclick = () => {
    if (busy) return;
    target = context = start = null;
    outline(null);
    message("Your comment is kept. Select the target again, then save.");
    if (mode === "page") { target = {}; selected(); }
    else $("#hint").textContent = mode === "region" ? "Draw the region again. Your comment is kept." : "Click the element again. Your comment is kept.";
  };
  $("#move").onclick = () => {
    const panel = $(".panel");
    if (innerWidth <= 500) {
      const top = panel.style.top === "12px";
      panel.style.top = top ? "auto" : "12px";
      panel.style.bottom = top ? "12px" : "auto";
      return;
    }
    const left = panel.style.left === "16px";
    panel.style.left = left ? "auto" : "16px";
    panel.style.right = left ? "16px" : "auto";
  };
  const drawPins = () => {
    $(".pins").replaceChildren();
    comments.forEach((item, index) => {
      if (item.status !== "open" || item.kind !== "element" || item.context.url !== location.href || item.attachment?.state !== "matched") return;
      try {
        const el = document.querySelector(item.target.selector);
        // Do not keep a pin on a changed element between explicit checks.
        if (!el || el.outerHTML.slice(0, 8000) !== item.target.html) return;
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return;
        const pin = document.createElement("span"); pin.className = "pin"; pin.textContent = String(index + 1);
        pin.style.left = `${Math.max(0, Math.min(innerWidth - 24, rect.left - 12))}px`;
        pin.style.top = `${Math.max(0, Math.min(innerHeight - 24, rect.top - 12))}px`;
        $(".pins").append(pin);
      } catch { /* stale selectors are reported by Check attachments */ }
    });
  };
  const render = () => {
    $("ol").replaceChildren();
    comments.forEach((item, index) => {
      const row = document.createElement("li");
      const label = document.createElement("div"); label.className = "muted";
      const stateLabels = { matched: "Target found", stale: "Target changed", snapshot: "Original screenshot", unverified: "Different page" };
      label.textContent = `${index + 1} · ${item.status} · ${item.kind} · ${stateLabels[item.attachment?.state || "snapshot"]}`;
      const note = document.createElement("p"); note.textContent = item.comment;
      const button = document.createElement("button");
      button.textContent = item.status === "open" ? "Mark resolved" : "Reopen";
      button.onclick = () => act(async () => {
        comments = await call({ action: "status", id: item.id, status: item.status === "open" ? "resolved" : "open" });
        render(); message("Status saved.");
      });
      row.append(label, note, button); $("ol").append(row);
    });
    drawPins();
  };
  const act = async (fn) => {
    if (busy) return;
    busy = true;
    root.querySelectorAll("button,textarea").forEach((node) => { node.disabled = true; });
    try { await fn(); } catch (error) { message(`Could not save: ${error.message}. Your comment is still here.`); }
    finally { busy = false; root.querySelectorAll("button,textarea").forEach((node) => { node.disabled = false; }); }
  };
  $("form").onsubmit = (event) => {
    event.preventDefault();
    const comment = $("#comment").value.trim();
    if (!comment || !target) return;
    act(async () => {
      const current = getContext();
      if (current.url !== context.url) throw new Error("The page address changed. Use Reselect target");
      if (current.viewport.width !== context.viewport.width || current.viewport.height !== context.viewport.height || current.viewport.devicePixelRatio !== context.viewport.devicePixelRatio) {
        throw new Error(`The page dimensions changed from ${context.viewport.width}×${context.viewport.height} at ${context.viewport.devicePixelRatio}× scale to ${current.viewport.width}×${current.viewport.height} at ${current.viewport.devicePixelRatio}× scale. Use Reselect target`);
      }
      if (Math.abs(current.scroll.x - context.scroll.x) > 0.5 || Math.abs(current.scroll.y - context.scroll.y) > 0.5) {
        throw new Error(`The page scroll position changed from (${context.scroll.x}, ${context.scroll.y}) to (${current.scroll.x}, ${current.scroll.y}). Use Reselect target`);
      }
      // Titles can change for notifications without moving the selected region.
      // Refresh harmless metadata and subpixel scroll rounding before capture.
      context = current;
      if (mode === "element") {
        const matches = document.querySelectorAll(target.selector);
        if (matches.length !== 1 || matches[0].outerHTML.slice(0, 8000) !== target.html) throw new Error("The selected element changed. Use Reselect target");
      }
      message("Saving comment and screenshot…");
      host.style.setProperty("visibility", "hidden", "important");
      try { comments = await call({ action: "save", kind: mode === "page" ? "page" : mode, comment, target, context }); }
      finally { host.style.removeProperty("visibility"); }
      reset(); render(); message("Comment and screenshot saved.");
    });
  };
  $("#check").onclick = () => act(async () => { comments = await call({ action: "check" }); render(); message("Attachments checked. Original screenshots are unchanged."); });
  $("#finish").onclick = () => {
    if ($("#comment").value.trim()) { message("Save or cancel your current comment before finishing."); return; }
    act(async () => { await call({ action: "finish" }); cleanup(); });
  };
  const suppress = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  listen("pointerdown", (event) => {
    if (inside(event) || !mode || target || busy || event.button !== 0) return;
    suppress(event);
    if (mode === "region") start = { x: event.clientX, y: event.clientY };
  });
  listen("pointermove", (event) => {
    if (inside(event) || !mode || target || busy) return;
    if (mode === "element") outline(event.target.getBoundingClientRect());
    if (mode === "region" && start) outline({ x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(start.x - event.clientX), height: Math.abs(start.y - event.clientY) });
  });
  listen("pointerup", (event) => {
    if (!start || busy) return;
    suppress(event);
    const rect = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(start.x - event.clientX), height: Math.abs(start.y - event.clientY) };
    start = null;
    if (rect.width < 4 || rect.height < 4) { message("Drag a larger region."); return; }
    target = { rect }; outline(rect); selected();
  });
  listen("click", (event) => {
    if (inside(event) || !mode || busy) return;
    // Keep selecting from activating a link, button, or page click handler.
    suppress(event);
    if (mode === "element" && !target) { target = captureTarget(event.target); outline(target.rect); selected(); }
  });
  listen("keydown", (event) => {
    if (event.key === "Escape" && mode && !busy) { suppress(event); reset(); message("Comment cancelled."); }
  });
  listen("scroll", drawPins);
  window.addEventListener("resize", drawPins, { signal: abort.signal });
  const cleanup = () => {
    if (removed) return;
    removed = true; abort.abort(); host.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
  host.addEventListener("browse-annotations-close", cleanup, { once: true });
  render();
  $("#element").focus({ preventScroll: true });
}
