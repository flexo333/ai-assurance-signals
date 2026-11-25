// Collector — runs in the Sydney Lambda (action: "collect").
//
// For each active feed source: fetch the feed (robots-checked), keep items in
// the window that aren't already known, apply the AI keyword pre-filter for
// broad sources, then fetch + extract each article (robots-checked; paywalled
// sources keep the feed description only). Returns raw items for the
// Actions-side processor (summarise + ground + commit). No LLM calls here.

import { get, robotsFor, USER_AGENT } from "./lib/http.js";
import { parseFeedItems, isAllowed, feedType, discoverFeedLinks, newestItem, parseSitemap, selectSitemapEntries } from "./lib/feed-pure.js";
import { isAiRelated, passesMustMatch } from "./lib/keywords.js";
import { canonicalUrl, itemId, sha256, truncate } from "./lib/text-pure.js";
import { extractMainText, extractStandfirst, extractTitle, pagePublished } from "./lib/extract.js";

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

// The freshest working, robots-permitted feed among the configured `feed`,
// the `feeds` candidates and <link rel=alternate> autodiscovery on the
// homepage. "Freshest" (newest dated item), not "first": some configured
// candidates work but are stale — e.g. a gov.uk search feed returning
// months-old items while the organisation feed is current.
async function resolveFeed(src) {
  const tried = new Set();
  const candidates = [];
  const tryUrl = async (url) => {
    if (!url || tried.has(url)) return;
    tried.add(url);
    if (!isAllowed((await robotsFor(url)).parsed, USER_AGENT, url)) return;
    const r = await get(url);
    if (!r.ok || !feedType(r.body)) return;
    const items = parseFeedItems(r.body);
    if (!items.length) return;
    candidates.push({ url: r.url, body: r.body, newest: newestItem(items)?.date || "" });
  };
  for (const url of [src.feed, ...(src.feeds || [])]) await tryUrl(url);
  if (src.homepage && isAllowed((await robotsFor(src.homepage)).parsed, USER_AGENT, src.homepage)) {
    const home = await get(src.homepage);
    if (home.ok) for (const url of discoverFeedLinks(home.body, home.url)) await tryUrl(url);
  }
  candidates.sort((a, b) => b.newest.localeCompare(a.newest));
  return candidates[0] || null;
}

const DEFAULT_SITEMAP_PAGES = 25;

/**
 * Sitemap adapter (#12) for sources without a usable feed. sources.yaml:
 *   method: sitemap · sitemap: <url> · include / exclude: URL regex strings ·
 *   max_pages: pages to check per run (default 25)
 * Takes the newest unknown URLs (by lastmod), fetches each page (robots-checked),
 * dates it from the page itself (metadata, "Published" label; lastmod as a
 * fallback, since CMSs bump lastmod on edits) and applies the AI keyword check
 * to the BODY text (official releases often mention AI only in the body).
 * Pages that are out of window or not about AI are returned in `dropped`, so
 * they're recorded as seen and not re-fetched; the backfill then progresses.
 */
async function listSitemap(src, { since, known }) {
  const log = { id: src.id, feed: src.sitemap, method: "sitemap", status: "ok", feedItems: 0, inWindow: 0, keywordDropped: 0, collected: 0, skipped: { known: 0, old: 0, badUrl: 0 }, sample: null };
  const dropped = [];
  const fetchXml = async (url) => {
    if (!isAllowed((await robotsFor(url)).parsed, USER_AGENT, url)) return null;
    const r = await get(url);
    return r.ok ? parseSitemap(r.body) : null;
  };
  const root = await fetchXml(src.sitemap);
  if (!root) return { log: { ...log, status: "sitemap-unavailable" }, candidates: [], dropped };
  let entries = root.entries;
  if (root.isIndex) {
    entries = [];
    for (const child of root.entries.slice(0, 8)) entries.push(...((await fetchXml(child.loc))?.entries || []));
  }
  log.feedItems = entries.length;
  const idOf = (u) => {
    try {
      return itemId(canonicalUrl(u));
    } catch {
      return null;
    }
  };
  const picked = selectSitemapEntries(entries, { include: src.include, exclude: src.exclude, since, known, idOf, limit: src.max_pages || DEFAULT_SITEMAP_PAGES });
  const candidates = [];
  for (const e of picked) {
    const id = idOf(e.loc);
    if (!id) continue;
    if (!isAllowed((await robotsFor(e.loc)).parsed, USER_AGENT, e.loc)) continue;
    const page = await get(e.loc);
    if (!page.ok) continue; // transient: retried next run
    const ex = extractMainText(page.body, page.url);
    const date = pagePublished(page.body, ex.text) || e.lastmod;
    log.sample ??= { link: e.loc, date, since };
    if (date && date < since) {
      log.skipped.old++;
      dropped.push(id);
      continue;
    }
    log.inWindow++;
    const title = extractTitle(page.body) || ex.title || decodeURIComponent(e.loc.split("/").filter(Boolean).pop() || "").replace(/-/g, " ");
    if ((!src.ai_specific && !isAiRelated(`${title}\n${ex.text}`)) || !passesMustMatch(src.must_match, `${title}\n${ex.text}`)) {
      log.keywordDropped++;
      dropped.push(id);
      continue;
    }
    candidates.push({
      id,
      url: canonicalUrl(page.url || e.loc),
      title,
      date,
      summary: null,
      src,
      prefetched: { text: ex.text, extractMethod: ex.method },
    });
  }
  return { log, candidates, dropped };
}

// Phase A (cheap): resolve the feed and list fresh candidates — no article fetches.
async function listSource(src, { since, known }) {
  if (src.method === "sitemap") return listSitemap(src, { since, known });
  const log = { id: src.id, feed: null, status: "ok", feedItems: 0, inWindow: 0, keywordDropped: 0, collected: 0, skipped: { known: 0, old: 0, badUrl: 0 }, sample: null };
  const feed = await resolveFeed(src);
  if (!feed) return { log: { ...log, status: "no-feed" }, candidates: [] };
  log.feed = feed.url;
  const parsed = parseFeedItems(feed.body).filter((i) => i.link && i.title);
  log.feedItems = parsed.length;
  const candidates = [];
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
    // Per-source must_match (#31): checked before any article fetch or LLM call.
    if (!passesMustMatch(src.must_match, `${i.title}\n${i.summary || ""}\n${i.link}`)) {
      log.keywordDropped++;
      continue;
    }
    candidates.push({ ...i, url, id, src });
    if (candidates.length >= MAX_ITEMS_PER_SOURCE) break;
  }
  return { log, candidates };
}

// Phase B: fetch + extract the article for one selected candidate.
async function fetchCandidate(c) {
  const src = c.src;
  let text = c.summary || "";
  let textSource = "feed";
  let extractMethod = null;
  if (c.prefetched) {
    // Sitemap candidates were already fetched (to check the body for AI).
    text = c.prefetched.text || "";
    textSource = "article";
    extractMethod = c.prefetched.extractMethod;
  } else if (src.paywalled && text.length < 120 && isAllowed((await robotsFor(c.url)).parsed, USER_AGENT, c.url)) {
    // Paywalled: the page's standfirst (meta description) only — never body text.
    const page = await get(c.url);
    if (page.ok) {
      const sf = extractStandfirst(page.body);
      extractMethod = "standfirst";
      if (sf.length > text.length) {
        text = sf;
        textSource = "standfirst";
      }
    } else {
      extractMethod = `http-${page.status}`;
    }
  } else if (!src.paywalled && isAllowed((await robotsFor(c.url)).parsed, USER_AGENT, c.url)) {
    const page = await get(c.url);
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
  return {
    id: c.id,
    sourceId: src.id,
    url: c.url,
    title: c.title,
    publishedAt: c.date,
    feedSummary: c.summary ? truncate(c.summary, 1500) : null,
    text,
    textSource,
    extractMethod,
    textSha256: sha256(text),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * @param sources   active sources: [{ id, homepage, feed?, feeds?, ai_specific, paywalled, ... }]
 * @param knownIds  item ids already stored (skipped)
 * @param sinceDays only items published within this many days (undated items pass)
 * @param maxItems  fetch articles for at most this many (newest first)
 */
export async function runCollect({ sources, knownIds = [], sinceDays = 8, maxItems = Infinity }) {
  const known = new Set(knownIds);
  const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
  const listed = await pool(sources.filter((s) => s.status !== "blocked"), CONCURRENCY, (s) => listSource(s, { since, known }));

  // Dedupe across feeds, then take the newest first: only as many as the
  // processor can analyse today (its Gemini budget). The rest stay unknown and
  // are picked up on later runs — so a backfill drains over a few days while
  // the current week is always handled first.
  const seen = new Set();
  const all = listed
    .flatMap((l) => l.candidates)
    .filter((c) => (seen.has(c.id) ? false : seen.add(c.id)))
    .sort((a, b) => String(b.date || "9999").localeCompare(String(a.date || "9999")));
  const selected = all.slice(0, maxItems);
  let items = await pool(selected, CONCURRENCY, fetchCandidate);

  let deferred = all.length - selected.length;
  while (items.length && Buffer.byteLength(JSON.stringify(items)) > MAX_RESPONSE_BYTES) {
    items.pop();
    deferred++;
  }
  const collectedBy = new Map();
  for (const i of items) collectedBy.set(i.sourceId, (collectedBy.get(i.sourceId) || 0) + 1);
  for (const l of listed) l.log.collected = collectedBy.get(l.log.id) || 0;
  // Sitemap pages checked and rejected (not AI / out of window): recorded as seen.
  const dropped = listed.flatMap((l) => l.dropped || []);
  return { since, items, deferred, candidates: all.length, dropped, sources: listed.map((l) => l.log) };
}
