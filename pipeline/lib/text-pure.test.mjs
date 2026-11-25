import { test } from "node:test";
import assert from "node:assert/strict";
import { stripHtml, canonicalUrl, itemId, truncate, decodeEntities } from "./text-pure.js";

test("stripHtml keeps paragraph breaks and decodes entities", () => {
  assert.equal(stripHtml("<p>AI &amp; privacy</p><p>Second&nbsp;para</p><script>x()</script>"), "AI & privacy\nSecond para");
  assert.equal(decodeEntities("it&rsquo;s &#8216;x&#x2019;"), "it’s ‘x’");
});

test("canonicalUrl strips tracking, fragments, www and trailing slash", () => {
  assert.equal(
    canonicalUrl("http://www.Example.gov.au/news/item/?utm_source=x&b=2&a=1#top"),
    "https://example.gov.au/news/item/?a=1&b=2",
  );
  assert.equal(canonicalUrl("https://example.com/a/"), "https://example.com/a");
  assert.equal(canonicalUrl("https://example.com/"), "https://example.com/");
});

test("itemId is stable across URL noise", () => {
  const a = itemId("https://www.example.com/post/?utm_medium=rss");
  assert.equal(a, itemId("http://example.com/post"));
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("truncate cuts on a word boundary", () => {
  assert.equal(truncate("one two three four", 9), "one two …");
  assert.equal(truncate("short", 10), "short");
});

import { extractStandfirst } from "./extract.js";

test("extractStandfirst returns only the meta description, never body text", () => {
  const html = `<html><head><meta property="og:description" content="The federal government will legislate AI audits &amp; disclosure."></head>
    <body><p>Paywalled body text that must never be used.</p></body></html>`;
  assert.equal(extractStandfirst(html), "The federal government will legislate AI audits & disclosure.");
  assert.equal(extractStandfirst("<html><body><p>Body only</p></body></html>"), "");
});

import { extractPublished, extractTitle } from "./extract.js";

test("extractPublished reads common date metadata; extractTitle trims site suffix", () => {
  assert.equal(extractPublished(`<head><meta property="article:published_time" content="2026-11-24T15:39:41+11:00"></head>`), "2026-11-24T04:39:41.000Z");
  assert.equal(extractPublished(`<head><meta name="dcterms.date" content="2026-11-20"></head>`), "2026-11-20T00:00:00.000Z");
  assert.equal(extractPublished(`<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-11-19T09:00:00Z"}</script>`), "2026-11-19T09:00:00.000Z");
  assert.equal(extractPublished(`<body><time datetime="2026-11-18">18 Nov</time></body>`), "2026-11-18T00:00:00.000Z");
  assert.equal(extractPublished(`<body>no date</body>`), null);
  assert.equal(extractPublished(`<head><meta name="displayDate" content="25 November 2026" /></head>`), "2026-11-25T00:00:00.000Z"); // ASIC
  assert.equal(extractTitle(`<head><title>APRA releases stress test results | APRA</title></head>`), "APRA releases stress test results");
  assert.equal(extractTitle(`<head><meta property="og:title" content="26-290MR Director charged"></head>`), "26-290MR Director charged");
});

import { labelledDate, pagePublished, mainTextFallback } from "./extract.js";

test("labelledDate reads 'Published <date>' pills; mainTextFallback strips chrome", () => {
  const html = `<html><body><nav class="anx-mega-menu">1 January 2024 menu</nav><main>
    <div class="anx-pill"><div class="anx-pill__label-first">Published</div><div class="anx-pill__label-last">12 November 2026</div></div>
    <p>APRA is strengthening supervisory engagement on AI-related risks.</p></main><footer>Footer</footer></body></html>`;
  assert.equal(labelledDate(html), "2026-11-12T00:00:00.000Z");
  assert.equal(pagePublished(html), "2026-11-12T00:00:00.000Z");
  const text = mainTextFallback(html);
  assert.ok(text.includes("AI-related risks"));
  assert.ok(!text.includes("menu") && !text.includes("Footer"));
});
