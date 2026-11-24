// Collector — runs in the Sydney Lambda (action: "collect").
//
// For each active feed source: fetch the feed (robots-checked), keep items in
// the window that aren't already known, apply the AI keyword pre-filter for
// broad sources, then fetch + extract each article (robots-checked; paywalled
// sources keep the feed description only). Returns raw items for the
// Actions-side processor (summarise + ground + commit). No LLM calls here.

import { get, robotsFor, USER_AGENT } from "./lib/http.js";
import { parseFeedItems, isAllowed, feedType, discoverFeedLinks } from "./lib/feed-pure.js";
import { isAiRelated } from "./lib/keywords.js";
import { canonicalUrl, itemId, sha256, truncate } from "./lib/text-pure.js";
import { extractMainText } from "./lib/extract.js";

const MAX_TEXT_CHARS = 20_000;
const MAX_ITEMS_PER_SOURCE = 15;
const MAX_RESPONSE_BYTES = 5_000_000; // Lambda sync response limit is 6 MB
const CONCURRENCY = 6;

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// First working, robots-permitted feed: configured `feed`, then `feeds`
// candidates, then <link rel=alternate> autodiscovery on the homepage.
async function resolveFeed(src) {
  const tried = new Set();
  const tryUrl = async (url) => {
    if (!url || tried.has(url)) return null;
    tried.add(url);
    if (!isAllowed((await robotsFor(url)).parsed, USER_AGENT, url)) return null;
    const r = await get(url);
    return r.ok && feedType(r.body) && parseFeedItems(r.body).length ? { url: r.url, body: r.body } : null;
  };
  for (const url of [src.feed, ...(src.feeds || [])]) {
    const hit = await tryUrl(url);
    if (hit) return hit;
  }
  if (src.homepage && isAllowed((await robotsFor(src.homepage)).parsed, USER_AGENT, src.homepage)) {
    const home = await get(src.homepage);
    if (home.ok) {
      for (const url of discoverFeedLinks(home.body, home.url)) {
        const hit = await tryUrl(url);
        if (hit) return hit;
      }
    }
  }
  return null;
}

async function collectSource(src, { since, known }) {
  const log = { id: src.id, feed: null, status: "ok", feedItems: 0, inWindow: 0, keywordDropped: 0, collected: 0, skipped: { known: 0, old: 0, badUrl: 0 }, sample: null };
  const feed = await resolveFeed(src);
  if (!feed) return { log: { ...log, status: "no-feed" }, items: [] };
  log.feed = feed.url;

  const parsed = parseFeedItems(feed.body).filter((i) => i.link && i.title);
  log.feedItems = parsed.length;
  const fresh = [];
  for (const i of parsed) {
    let url;
    log.sample ??= { link: i.link, date: i.date, since };
    try {
      url = canonicalUrl(new URL(i.link, feed.url).toString());
    } catch {
      log.skipped.badUrl++;
      continue;
    }
    const id = itemId(url);
    if (known.has(id)) {
      log.skipped.known++;
      continue;
    }
    // Undated items are kept (once) — the known-id set stops them repeating.
    if (i.date && i.date < since) {
      log.skipped.old++;
      continue;
    }
    log.inWindow++;
    if (!src.ai_specific && !isAiRelated(`${i.title}\n${i.summary || ""}`)) {
      log.keywordDropped++;
      continue;
    }
    fresh.push({ ...i, url, id });
    if (fresh.length >= MAX_ITEMS_PER_SOURCE) break;
  }

  const items = [];
  for (const i of fresh) {
    let text = i.summary || "";
    let textSource = "feed";
    let extractMethod = null;
    if (!src.paywalled && isAllowed((await robotsFor(i.url)).parsed, USER_AGENT, i.url)) {
      const page = await get(i.url);
      if (page.ok) {
        const ex = extractMainText(page.body, page.url);
        extractMethod = ex.method;
        if (ex.text && ex.text.length > text.length) {
          text = ex.text;
          textSource = "article";
        }
      } else {
        extractMethod = `http-${page.status}`;
      }
    }
    text = truncate(text, MAX_TEXT_CHARS);
    items.push({
      id: i.id,
      sourceId: src.id,
      url: i.url,
      title: i.title,
      publishedAt: i.date,
      feedSummary: i.summary ? truncate(i.summary, 1500) : null,
      text,
      textSource,
      extractMethod,
      textSha256: sha256(text),
      fetchedAt: new Date().toISOString(),
    });
  }
  log.collected = items.length;
  return { log, items };
}

/**
 * @param sources   active sources: [{ id, homepage, feed?, feeds?, ai_specific, paywalled, ... }]
 * @param knownIds  item ids already stored (skipped)
 * @param sinceDays only items published within this many days (undated items pass)
 */
export async function runCollect({ sources, knownIds = [], sinceDays = 8 }) {
  const known = new Set(knownIds);
  const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
  const results = await pool(sources.filter((s) => s.status !== "blocked"), CONCURRENCY, (s) => collectSource(s, { since, known }));

  let items = results.flatMap((r) => r.items);
  // Same article via two feeds → keep the first.
  const seen = new Set();
  items = items.filter((i) => (seen.has(i.id) ? false : seen.add(i.id)));

  let deferred = 0;
  while (items.length && Buffer.byteLength(JSON.stringify(items)) > MAX_RESPONSE_BYTES) {
    items.pop(); // picked up again on the next run (still unknown, still in window)
    deferred++;
  }
  return { since, items, deferred, sources: results.map((r) => r.log) };
}
