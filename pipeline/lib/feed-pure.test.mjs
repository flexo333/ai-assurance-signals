import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedType,
  parseFeedItems,
  newestItem,
  discoverFeedLinks,
  parseRobots,
  isAllowed,
} from "./feed-pure.js";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>X</title>
<item><title><![CDATA[Privacy &amp; AI guidance]]></title><link>https://ex.gov.au/a</link><pubDate>Tue, 18 Nov 2026 01:00:00 GMT</pubDate></item>
<item><title>Older</title><link>https://ex.gov.au/b</link><pubDate>Mon, 03 Nov 2026 01:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?><!-- c --><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Policy paper</title><link rel="alternate" href="https://gov.uk/p"/><updated>2026-11-20T09:00:00Z</updated></entry>
</feed>`;

test("feedType sniffs rss/atom/html", () => {
  assert.equal(feedType(RSS), "rss");
  assert.equal(feedType(ATOM), "atom");
  assert.equal(feedType("<!doctype html><html></html>"), null);
  assert.equal(feedType(undefined), null);
});

test("parseFeedItems handles RSS with CDATA and entities", () => {
  const items = parseFeedItems(RSS);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Privacy & AI guidance");
  assert.equal(items[0].link, "https://ex.gov.au/a");
  assert.equal(items[0].date, "2026-11-18T01:00:00.000Z");
});

test("parseFeedItems handles Atom alternate links", () => {
  const [item] = parseFeedItems(ATOM);
  assert.deepEqual(item, { title: "Policy paper", link: "https://gov.uk/p", date: "2026-11-20T09:00:00.000Z" });
});

test("newestItem ignores undated items", () => {
  assert.equal(newestItem(parseFeedItems(RSS)).link, "https://ex.gov.au/a");
  assert.equal(newestItem([{ title: "x", date: null }]), null);
});

test("discoverFeedLinks resolves relative hrefs and dedupes", () => {
  const html = `<head>
    <link rel="alternate" type="application/rss+xml" href="/news/rss.xml">
    <link type="application/atom+xml" rel="alternate" href="https://ex.gov.au/feed.atom">
    <link rel="alternate" type="application/rss+xml" href="/news/rss.xml">
    <link rel="stylesheet" href="/s.css"></head>`;
  assert.deepEqual(discoverFeedLinks(html, "https://ex.gov.au/news"), [
    "https://ex.gov.au/news/rss.xml",
    "https://ex.gov.au/feed.atom",
  ]);
});

test("robots: longest match wins, named agent group beats *", () => {
  const robots = parseRobots(`
User-agent: *
Disallow: /private/
Allow: /private/public-page
Disallow: /*.pdf$

User-agent: BadBot
Disallow: /

Sitemap: https://ex.gov.au/sitemap.xml
`);
  assert.deepEqual(robots.sitemaps, ["https://ex.gov.au/sitemap.xml"]);
  const ua = "AIAssuranceSignalsBot/1.0";
  assert.equal(isAllowed(robots, ua, "https://ex.gov.au/news"), true);
  assert.equal(isAllowed(robots, ua, "https://ex.gov.au/private/x"), false);
  assert.equal(isAllowed(robots, ua, "https://ex.gov.au/private/public-page"), true);
  assert.equal(isAllowed(robots, ua, "https://ex.gov.au/doc.pdf"), false);
  assert.equal(isAllowed(robots, ua, "https://ex.gov.au/doc.pdf?x=1"), true);
  assert.equal(isAllowed(robots, "BadBot/2", "https://ex.gov.au/news"), false);
});

test("robots: grouped user-agents share rules; empty Disallow allows all", () => {
  const robots = parseRobots("User-agent: a\nUser-agent: *\nDisallow:\n");
  assert.equal(robots.groups.length, 1);
  assert.equal(isAllowed(robots, "anything", "https://ex.com/x"), true);
  assert.equal(isAllowed(parseRobots(""), "x", "https://ex.com/"), true);
});
