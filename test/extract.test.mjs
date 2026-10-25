import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown } from "../lib/extract.js";

const article = `<!doctype html><html><head><title>Capture example</title></head><body>
  <nav>Navigation-only text</nav><main><article><h1>Capture example</h1>
  ${"<p>This synthetic article describes a saved browser observation. Its source URL identifies the page, while its capture time identifies when the HTML was collected. Neither field proves that the page contains all relevant evidence.</p>".repeat(6)}
  </article></main></body></html>`;
const url = "https://example.test/article";

test("article extraction reports Readability without including navigation", () => {
  const result = htmlToMarkdown(article, url);
  assert.equal(result.extraction_method, "readability");
  assert.equal(result.title, "Capture example");
  assert.match(result.markdown, /saved browser observation/);
  assert.doesNotMatch(result.markdown, /Navigation-only text/);
});

test("a page without article content reports the body fallback", () => {
  const result = htmlToMarkdown(
    '<html><head><title>Draft editor</title></head><body><form><input aria-label="Title"><button>Save draft</button></form></body></html>',
    url,
  );
  assert.equal(result.extraction_method, "body_fallback");
  assert.equal(result.title, "Draft editor");
  assert.match(result.markdown, /Save draft/);
});

test("raw extraction reports the explicit body choice even for an article", () => {
  const result = htmlToMarkdown(article, url, { raw: true });
  assert.equal(result.extraction_method, "raw_body");
  assert.match(result.markdown, /Navigation-only text/);
  assert.match(result.markdown, /saved browser observation/);
});
