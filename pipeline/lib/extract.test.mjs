import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPublished, extractStandfirst, firstVisibleDate, labelledDate, pagePublished } from "./extract.js";

test("extractPublished reads AEM publication-date and display-date meta tags", () => {
  const html = `<html><head><meta name="publication-date" content="2026-08-24T10:00:00.000+10:00"/></head><body></body></html>`;
  assert.equal(extractPublished(html), "2026-08-24T00:00:00.000Z");
});

test("firstVisibleDate and labelledDate accept abbreviated months and optional comma", () => {
  assert.equal(firstVisibleDate("Digital Economy Infographic\n28 Sep, 2026\nBody text"), "2026-09-28T00:00:00.000Z");
  assert.equal(labelledDate("<div><span>Published</span> <span>12 Nov 2026</span></div>"), "2026-11-12T00:00:00.000Z");
  assert.equal(pagePublished("<html><body><main><p>16 December 2026 — AusPayNet update</p></main></body></html>"), "2026-12-16T00:00:00.000Z");
});

test("extractStandfirst returns only meta description and ignores article body", () => {
  const html = `<html><head><meta property="og:description" content="Standfirst summary only."/></head><body><article><p>Paywalled body text that must never be stored.</p></article></body></html>`;
  assert.equal(extractStandfirst(html), "Standfirst summary only.");
});
