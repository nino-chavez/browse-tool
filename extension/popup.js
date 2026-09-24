const $ = (selector) => document.querySelector(selector);
const send = async (request) => {
  const reply = await chrome.runtime.sendMessage({ channel: "page-feedback", request });
  if (!reply?.ok) throw new Error(reply?.error || "Could not contact the feedback helper.");
  return reply.result;
};
let tab;
const action = async (fn) => {
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  $("#status").textContent = "Working…";
  try { await fn(); $("#status").textContent = "Review opened on the page."; window.close(); }
  catch (error) { $("#status").textContent = error.message; }
  finally { $("#create").disabled = false; $("#resume").disabled = !$("#batches").value; }
};
$("form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    if (!tab?.id) throw new Error("Open the page you want to review first.");
    const { batchId } = await send({ action: "create", title: $("#title").value });
    await send({ action: "attach", batchId, tabId: tab.id });
  });
};
$("#resume").onclick = () => action(() => send({ action: "attach", batchId: $("#batches").value, tabId: tab.id }));
$("#batches").onchange = () => { $("#resume").disabled = !$("#batches").value; };
(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("#tab-context").textContent = tab?.url ? `${tab.title || "Current page"} · ${new URL(tab.url).host}` : "No page selected";
  const select = $("#batches"); select.replaceChildren(new Option("Choose a review", ""));
  let offset = 0;
  do {
    const { batches, nextOffset } = await send({ action: "list", offset });
    for (const batch of batches) select.append(new Option(`${batch.title} — ${batch.open} open`, batch.batchId));
    offset = nextOffset;
  } while (offset !== null);
  if (select.options.length === 1) select.options[0].textContent = "No saved reviews yet";
  select.dataset.loaded = "true";
})().catch((error) => { $("#status").textContent = error.message; });
