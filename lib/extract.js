import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

function newTurndown() {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  turndown.remove(["script", "style", "noscript"]);
  return turndown;
}

// html: full page HTML. url: the page's final URL (for relative-link resolution).
// raw: skip Readability, always convert the full body.
// Returns { title, markdown }.
export function htmlToMarkdown(html, url, { raw = false } = {}) {
  const dom = new JSDOM(html, { url });
  const turndown = newTurndown();

  let title, contentHtml;
  if (raw) {
    title = dom.window.document.title;
    contentHtml = dom.window.document.body.innerHTML;
  } else {
    const article = new Readability(dom.window.document).parse();
    if (article) {
      title = article.title;
      contentHtml = article.content;
    } else {
      // Readability found no article-shaped content (dashboards, SPAs, listings) — fall back to full body.
      title = dom.window.document.title;
      contentHtml = dom.window.document.body.innerHTML;
    }
  }

  const markdown = turndown.turndown(contentHtml || "").trim();
  return { title, markdown };
}

// html: page HTML. baseUrl: page's final URL (for relative-link resolution).
// Returns deduped array of absolute link URLs (fragment stripped), same origin as baseUrl.
export function sameOriginLinks(html, baseUrl) {
  const dom = new JSDOM(html, { url: baseUrl });
  const origin = new URL(baseUrl).origin;
  const seen = new Set();
  for (const a of dom.window.document.querySelectorAll("a[href]")) {
    let href;
    try {
      href = new URL(a.getAttribute("href"), baseUrl);
    } catch {
      continue;
    }
    if (href.origin !== origin) continue;
    href.hash = "";
    seen.add(href.href);
  }
  return [...seen];
}
