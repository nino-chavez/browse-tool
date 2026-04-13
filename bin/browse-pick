#!/usr/bin/env node
import { connect, activeOrFirstPage } from "../lib/connect.js";

const browser = await connect();
const page = await activeOrFirstPage(browser);

try {
  const result = await page.evaluate(() => {
    return new Promise((resolve) => {
      const picked = [];
      const style = document.createElement("style");
      style.textContent = `
        .__browse_hover__ { outline: 2px solid #00e5ff !important; outline-offset: 1px !important; }
        .__browse_picked__ { outline: 3px solid #ff3b30 !important; outline-offset: 1px !important; }
        #__browse_banner__ {
          position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
          background: rgba(0,0,0,.85); color: #fff; padding: 8px 14px;
          border-radius: 8px; font: 13px system-ui, sans-serif; z-index: 2147483647;
          box-shadow: 0 4px 20px rgba(0,0,0,.3); pointer-events: none;
        }
      `;
      document.head.appendChild(style);

      const banner = document.createElement("div");
      banner.id = "__browse_banner__";
      banner.textContent = "Click to pick • Cmd/Ctrl+Click for multi • Enter to finish • Esc to cancel";
      document.body.appendChild(banner);

      let hovered = null;
      const updateBanner = () =>
        (banner.textContent = `Picked ${picked.length} • Click to add • Enter to finish • Esc to cancel`);

      const onMove = (e) => {
        const el = e.target;
        if (hovered && hovered !== el) hovered.classList.remove("__browse_hover__");
        hovered = el;
        if (el && el !== banner) el.classList.add("__browse_hover__");
      };
      const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = e.target;
        if (!el || el === banner) return;
        if (!e.metaKey && !e.ctrlKey) {
          picked.forEach((p) => p.classList.remove("__browse_picked__"));
          picked.length = 0;
        }
        if (!picked.includes(el)) {
          picked.push(el);
          el.classList.add("__browse_picked__");
        }
        updateBanner();
      };
      const finish = (cancelled) => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        if (hovered) hovered.classList.remove("__browse_hover__");
        picked.forEach((p) => p.classList.remove("__browse_picked__"));
        banner.remove();
        style.remove();
        if (cancelled) return resolve({ cancelled: true, items: [] });
        resolve({
          cancelled: false,
          items: picked.map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              class: el.className || null,
              text: (el.innerText || "").slice(0, 200),
              html: el.outerHTML.slice(0, 500),
              rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
              selector: (() => {
                if (el.id) return `#${el.id}`;
                const path = [];
                let cur = el;
                while (cur && cur.nodeType === 1 && path.length < 5) {
                  let s = cur.tagName.toLowerCase();
                  if (cur.className && typeof cur.className === "string") {
                    s += "." + cur.className.trim().split(/\s+/).slice(0, 2).join(".");
                  }
                  path.unshift(s);
                  cur = cur.parentElement;
                }
                return path.join(" > ");
              })(),
            };
          }),
        });
      };
      const onKey = (e) => {
        if (e.key === "Enter") finish(false);
        else if (e.key === "Escape") finish(true);
      };

      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
    });
  });

  if (result.cancelled) {
    console.error("Cancelled.");
    process.exit(1);
  }
  console.log(JSON.stringify(result.items, null, 2));
} catch (err) {
  console.error(`Pick failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  browser.disconnect();
}
