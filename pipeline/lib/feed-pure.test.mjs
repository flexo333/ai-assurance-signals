import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedType,
  parseFeedItems,
  newestItem,
  discoverFeedLinks,
  parseRobots,
  isAllowed,
  robotsFromResponse,
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
  assert.deepEqual(item, { title: "Policy paper", link: "https://gov.uk/p", date: "2026-11-20T09:00:00.000Z", summary: null });
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

test("robotsFromResponse follows RFC 9309 for 4xx vs 5xx/network failures", () => {
  const ua = "AIAssuranceSignalsBot/1.0";
  const url = "https://ex.gov.au/news";
  assert.equal(isAllowed(robotsFromResponse(200, "User-agent: *\nDisallow: /news"), ua, url), false);
  assert.equal(robotsFromResponse(404, "<html>").state, "absent");
  assert.equal(isAllowed(robotsFromResponse(404, ""), ua, url), true);
  for (const status of [503, 500, 0]) {
    const r = robotsFromResponse(status, "");
    assert.equal(r.state, "unreachable");
    assert.equal(isAllowed(r, ua, url), false);
  }
});

test("parseFeedItems extracts descriptions, unescaping HTML", () => {
  const rss = `<rss><channel><item><title>T</title><link>https://x/a</link>
    <description>&lt;p&gt;APRA has written to &lt;b&gt;banks&lt;/b&gt; about AI.&lt;/p&gt;</description></item>
    <item><title>U</title><link>https://x/b</link><content:encoded><![CDATA[<p>Full <em>content</em> here.</p>]]></content:encoded><description>short</description></item>
  </channel></rss>`;
  const [a, b] = parseFeedItems(rss);
  assert.equal(a.summary, "APRA has written to banks about AI.");
  assert.equal(b.summary, "Full content here.");
});

import { parseSitemap, selectSitemapEntries } from "./feed-pure.js";

test("parseSitemap handles urlsets and indexes", () => {
  const idx = parseSitemap(`<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x.gov.au/sitemap.xml?page=1</loc></sitemap><sitemap><loc>https://x.gov.au/sitemap.xml?page=2&amp;a=1</loc></sitemap></sitemapindex>`);
  assert.equal(idx.isIndex, true);
  assert.deepEqual(idx.entries.map((e) => e.loc), ["https://x.gov.au/sitemap.xml?page=1", "https://x.gov.au/sitemap.xml?page=2&a=1"]);
  const set = parseSitemap(`<urlset><url><loc>https://x.gov.au/a</loc><lastmod>2026-11-25T08:55:12+11:00</lastmod></url><url><loc>https://x.gov.au/b</loc></url></urlset>`);
  assert.equal(set.isIndex, false);
  assert.deepEqual(set.entries, [{ loc: "https://x.gov.au/a", lastmod: "2026-11-24T21:55:12.000Z" }, { loc: "https://x.gov.au/b", lastmod: null }]);
});

test("selectSitemapEntries filters by include/exclude/window/known and sorts newest first", () => {
  const entries = [
    { loc: "https://apra.gov.au/news-and-publications/stress-test-ai", lastmod: "2026-11-20T00:00:00.000Z" },
    { loc: "https://apra.gov.au/news-and-publications/quarterly-statistics", lastmod: "2026-11-24T00:00:00.000Z" },
    { loc: "https://apra.gov.au/news-and-publications/cyber-penalty", lastmod: "2026-11-24T05:00:00.000Z" },
    { loc: "https://apra.gov.au/industries/banking", lastmod: "2026-11-24T00:00:00.000Z" },
    { loc: "https://apra.gov.au/news-and-publications/old", lastmod: "2026-01-01T00:00:00.000Z" },
    { loc: "https://apra.gov.au/news-and-publications/seen", lastmod: "2026-11-23T00:00:00.000Z" },
  ];
  const got = selectSitemapEntries(entries, {
    include: "/news-and-publications/",
    exclude: "statistics",
    since: "2026-07-01T00:00:00.000Z",
    known: new Set(["id:https://apra.gov.au/news-and-publications/seen"]),
    idOf: (u) => `id:${u}`,
  });
  assert.deepEqual(got.map((e) => e.loc.split("/").pop()), ["cyber-penalty", "stress-test-ai"]);
});

test("extractListingLinks: same-host links in page order, deduplicated, no fragments", async () => {
  const { extractListingLinks, selectSitemapEntries } = await import("./feed-pure.js");
  const html = `<a href="/articles/newsroom/2026/11/b.html">B</a>
    <a class="x" href="https://www.commbank.com.au/articles/newsroom/2026/10/a.html#top">A</a>
    <a href="/articles/newsroom/2026/11/b.html">B again</a>
    <a href="https://other.example/articles/newsroom/2026/11/c.html">off-site</a>
    <a href="mailto:x@y">mail</a><a href="#nav">skip</a>`;
  const links = extractListingLinks(html, "https://www.commbank.com.au/newsroom/technology-and-ai.html");
  assert.deepEqual(links.map((l) => l.loc), [
    "https://www.commbank.com.au/articles/newsroom/2026/11/b.html",
    "https://www.commbank.com.au/articles/newsroom/2026/10/a.html",
  ]);
  const picked = selectSitemapEntries(links, { include: "/articles/newsroom/20\\d\\d/", known: new Set(), idOf: (u) => u, limit: 1 });
  assert.deepEqual(picked.map((l) => l.loc), ["https://www.commbank.com.au/articles/newsroom/2026/11/b.html"]); // page order kept
});

test("dateFromUrl / reconcileUrlDate (#31)", async () => {
  const { dateFromUrl, reconcileUrlDate } = await import("./feed-pure.js");
  assert.equal(dateFromUrl("https://www.commbank.com.au/articles/newsroom/2026/11/x.html"), "2026-11-01T00:00:00.000Z");
  assert.equal(dateFromUrl("https://www.anz.com.au/bluenotes/2026/November/ai-in-action-at-anz/"), "2026-11-01T00:00:00.000Z");
  assert.equal(dateFromUrl("https://www.anz.com.au/bluenotes/2026/sept/x/"), "2026-09-01T00:00:00.000Z");
  assert.equal(dateFromUrl("https://asic.gov.au/news/2026-releases/x/"), null);
  assert.equal(dateFromUrl("https://x/2026/13/y/"), null);
  assert.equal(dateFromUrl("https://x/2026/news/y/"), null);
  const u = "https://www.anz.com.au/bluenotes/2026/November/ai-in-action-at-anz/";
  assert.equal(reconcileUrlDate("2026-05-01", u), "2026-11-01T00:00:00.000Z"); // stale template date
  assert.equal(reconcileUrlDate("2026-11-19T00:00:00.000Z", u), "2026-11-19T00:00:00.000Z");
  assert.equal(reconcileUrlDate(null, u), "2026-11-01T00:00:00.000Z");
  assert.equal(reconcileUrlDate("2026-05-01", "https://x/no-date/"), "2026-05-01");
});
