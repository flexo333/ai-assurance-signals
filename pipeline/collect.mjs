// Collector — runs in the Sydney Lambda (action: "collect").
//
// For each active feed source: fetch the feed (robots-checked), keep items in
// the window that aren't already known, apply the AI keyword pre-filter for
// broad sources, then fetch + extract each article (robots-checked; paywalled
// sources keep the feed description only). Returns raw items for the
// Actions-side processor (summarise + ground + commit). No LLM calls here.

import { get, robotsFor, USER_AGENT } from "./lib/http.js";
import { parseFeedItems, isAllowed, feedType, discoverFeedLinks, newestItem, parseSitemap, selectSitemapEntries, extractListingLinks, reconcileUrlDate } from "./lib/feed-pure.js";
import { parseCitizenSpaceItems, parseCsBody } from "./lib/citizen-space.js";
import { buildLegislationQueryUrl, parseLegislationTitles, formatLegislationText, DEFAULT_LEGISLATION_API } from "./lib/legislation.js";
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
  if (src.discover !== false && src.homepage && isAllowed((await robotsFor(src.homepage)).parsed, USER_AGENT, src.homepage)) {
    const home = await get(src.homepage);
    if (home.ok) for (const url of discoverFeedLinks(home.body, home.url)) await tryUrl(url);
  }
  candidates.sort((a, b) => b.newest.localeCompare(a.newest));
  return candidates[0] || null;
}

const DEFAULT_SITEMAP_PAGES = 25;

/**
 * Sitemap adapter (#12) for sources without a usable feed. sources.yaml:
 *   method: sitemap · sitemap: <url> or [urls] · include / exclude: URL regex
 *   strings · max_pages: pages to check per run (default 25)
 * Takes the newest unknown URLs (by lastmod), fetches each page (robots-checked),
 * dates it from the page itself (metadata, "Published" label; lastmod as a
 * fallback, since CMSs bump lastmod on edits) and applies the AI keyword check
 * to the BODY text (official releases often mention AI only in the body).
 * Pages that are out of window or not about AI are returned in `dropped`, so
 * they're recorded as seen and not re-fetched; the backfill then progresses.
 */
async function listSitemap(src, { since, known }) {
  const roots = [].concat(src.sitemap || []);
  const log = { id: src.id, feed: roots[0] || null, method: "sitemap", status: "ok", feedItems: 0, inWindow: 0, keywordDropped: 0, collected: 0, skipped: { known: 0, old: 0, badUrl: 0 }, sample: null };
  const dropped = [];
  const fetchXml = async (url) => {
    if (!isAllowed((await robotsFor(url)).parsed, USER_AGENT, url)) return null;
    const r = await get(url);
    return r.ok ? parseSitemap(r.body) : null;
  };
  const entries = [];
  let okCount = 0;
  for (const rootUrl of roots) {
    const root = await fetchXml(rootUrl);
    if (!root) continue;
    okCount++;
    if (root.isIndex) {
      for (const child of root.entries.slice(0, 8)) entries.push(...((await fetchXml(child.loc))?.entries || []));
    } else {
      entries.push(...root.entries);
    }
  }
  if (!okCount) return { log: { ...log, status: "sitemap-unavailable" }, candidates: [], dropped };
  if (okCount < roots.length) log.status = `partial (${okCount}/${roots.length} sitemaps)`;
  log.feedItems = entries.length;
  const picked = selectSitemapEntries(entries, { include: src.include, exclude: src.exclude, since, known, idOf: idOfUrl, limit: src.max_pages || DEFAULT_SITEMAP_PAGES });
  return checkPages(src, picked, { since, log, dropped });
}

const idOfUrl = (u) => {
  try {
    return itemId(canonicalUrl(u));
  } catch {
    return null;
  }
};

/**
 * Listing adapter (#12, #31) for sources whose only index is an HTML listing
 * page (e.g. a bank newsroom's "Technology and AI" page). sources.yaml:
 *   method: listing · listing: <url> or [urls] · include / exclude: URL regex
 *   strings · max_pages (default 25)
 * Links are taken in page order (listings are newest first); pages are then
 * checked exactly like sitemap pages.
 */
async function listListing(src, { since, known }) {
  const urls = [].concat(src.listing || []);
  const log = { id: src.id, feed: urls[0] || null, method: "listing", status: "ok", feedItems: 0, inWindow: 0, keywordDropped: 0, collected: 0, skipped: { known: 0, old: 0, badUrl: 0 }, sample: null };
  const dropped = [];
  const entries = [];
  let okCount = 0;
  for (const url of urls) {
    if (!isAllowed((await robotsFor(url)).parsed, USER_AGENT, url)) continue;
    const r = await get(url);
    if (r.ok) {
      okCount++;
      entries.push(...extractListingLinks(r.body, r.url));
    }
  }
  if (!entries.length) return { log: { ...log, status: "listing-unavailable" }, candidates: [], dropped };
  if (okCount < urls.length) log.status = `partial (${okCount}/${urls.length} listings)`;
  log.feedItems = entries.length;
  const picked = selectSitemapEntries(entries, { include: src.include, exclude: src.exclude, since, known, idOf: idOfUrl, limit: src.max_pages || DEFAULT_SITEMAP_PAGES });
  return checkPages(src, picked, { since, log, dropped });
}

// Fetch each picked page (robots-checked), date it from the page, apply the
// AI keyword check (non-ai_specific sources) and must_match. Paywalled sources
// extract the standfirst only (never full body text).
// Out-of-window and rejected pages go to `dropped` (recorded as seen).
async function checkPages(src, picked, { since, log, dropped }) {
  const candidates = [];
  for (const e of picked) {
    const id = idOfUrl(e.loc);
    if (!id) continue;
    if (!isAllowed((await robotsFor(e.loc)).parsed, USER_AGENT, e.loc)) continue;
    const page = await get(e.loc);
    if (!page.ok) continue; // transient: retried next run
    const ex = src.paywalled
      ? { text: extractStandfirst(page.body), title: null, method: "standfirst" }
      : extractMainText(page.body, page.url);
    const date = reconcileUrlDate(pagePublished(page.body, src.paywalled ? "" : ex.text) || e.lastmod || null, e.loc);
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
      prefetched: { text: ex.text, textSource: src.paywalled ? "standfirst" : "article", extractMethod: ex.method },
    });
  }
  return { log, candidates, dropped };
}

/**
 * Federal Register of Legislation OData v4 + EPUB XHTML adapter (#12).
 * Queries OPC's public REST API for newly registered Acts and Legislative
 * Instruments, then fetches the static Explanatory Statement (or primary text)
 * XHTML on www.legislation.gov.au (which is otherwise an Angular SPA shell).
 */
async function listLegislation(src, { since, known }) {
  const queryUrl = buildLegislationQueryUrl({ apiBase: src.api || DEFAULT_LEGISLATION_API, since, top: 100 });
  const log = { id: src.id, feed: queryUrl, method: "legislation", status: "ok", feedItems: 0, inWindow: 0, keywordDropped: 0, collected: 0, skipped: { known: 0, old: 0, badUrl: 0 }, sample: null };
  const dropped = [];
  if (!isAllowed((await robotsFor(queryUrl)).parsed, USER_AGENT, queryUrl)) {
    return { log: { ...log, status: "robots-disallowed" }, candidates: [], dropped };
  }
  const res = await get(queryUrl);
  if (!res.ok) return { log: { ...log, status: "api-unavailable" }, candidates: [], dropped };
  const picked = parseLegislationTitles(res.body, {
    webBase: src.homepage,
    collections: src.collections,
    include: src.include,
    exclude: src.exclude,
    since,
    known,
    idOf: idOfUrl,
    limit: src.max_pages || DEFAULT_SITEMAP_PAGES,
  });
  if (!picked) return { log: { ...log, status: "api-unavailable" }, candidates: [], dropped };
  log.feedItems = picked.length;

  const candidates = [];
  for (const entry of picked) {
    const id = idOfUrl(entry.url);
    if (!id) continue;
    log.sample ??= { link: entry.url, date: entry.date, since };
    log.inWindow++;
    let bodyText = "";
    let docFetched = false;
    for (const docUrl of entry.docUrls) {
      if (!isAllowed((await robotsFor(docUrl)).parsed, USER_AGENT, docUrl)) continue;
      const docRes = await get(docUrl);
      if (!docRes.ok) continue;
      docFetched = true;
      const ex = extractMainText(docRes.body, docRes.url);
      if (ex.text) {
        bodyText = ex.text;
        break;
      }
    }
    if (!docFetched && !isAiRelated(entry.title)) continue; // transient doc failure: retry next run
    const fullText = formatLegislationText(entry, bodyText);
    if ((!src.ai_specific && !isAiRelated(fullText)) || !passesMustMatch(src.must_match, fullText)) {
      log.keywordDropped++;
      dropped.push(id);
      continue;
    }
    candidates.push({
      id,
      url: canonicalUrl(entry.url),
      title: entry.title,
      date: entry.date,
      summary: null,
      src,
      prefetched: { text: fullText, textSource: "article", extractMethod: "legislation-epub" },
    });
    if (candidates.length >= MAX_ITEMS_PER_SOURCE) break;
  }
  return { log, candidates, dropped };
}

/**
 * Delib Citizen Space v2.4 public JSON API adapter (#14) for official
 * consultation hubs (consultations.ag.gov.au, consultation.accc.gov.au,
 * consultations.tga.gov.au, consultations.health.gov.au) whose parent agency
 * websites block automated HTTP clients.
 *
 * Always fetches `?st=open` (small, fast ~1s) so active consultations never
 * time out; also attempts `?fields=minimal` to include closed consultations
 * within the window (e.g. backfill) when the hub responds within timeout.
 */
async function listCitizenSpace(src, { since, known }) {
  const origin = new URL(src.api || src.homepage).origin;
  const openUrl = `${origin}/api/2.4/json_search_results?st=open`;
  const archiveUrl = `${origin}/api/2.4/json_search_results?fields=minimal`;
  const log = { id: src.id, feed: openUrl, method: "citizen-space", status: "ok", open: null, archive: null, feedItems: 0, inWindow: 0, keywordDropped: 0, collected: 0, skipped: { known: 0, old: 0, badUrl: 0, undated: 0 }, sample: null };
  const robots = await robotsFor(openUrl);
  if (!isAllowed(robots.parsed, USER_AGENT, openUrl)) {
    return { log: { ...log, status: "robots-disallowed" }, candidates: [] };
  }
  // Each response's outcome is logged, so a failing archive (timeout, WAF page,
  // truncated JSON) shows in the run summary instead of passing as "ok".
  const outcome = (res) => (!res.ok ? (res.status ? `http-${res.status}` : `error:${res.error || "?"}`) : parseCsBody(res.body) ? "ok" : "invalid-json");
  const openRes = await get(openUrl);
  log.open = outcome(openRes);
  // The open response goes first: parseCitizenSpaceItems gives it priority.
  const bodies = [openRes.ok ? openRes.body : null];
  if (src.open_only) log.archive = "skipped";
  else if (!isAllowed(robots.parsed, USER_AGENT, archiveUrl)) log.archive = "robots-disallowed";
  else {
    const archiveRes = await get(archiveUrl);
    log.archive = outcome(archiveRes);
    if (archiveRes.ok) bodies.push(archiveRes.body);
  }
  const parsed = parseCitizenSpaceItems(bodies, { baseUrl: origin, include: src.include, exclude: src.exclude });
  if (!parsed) return { log: { ...log, status: `api-unavailable (open: ${log.open}, archive: ${log.archive})` }, candidates: [] };
  if (log.open !== "ok") log.status = `partial (open: ${log.open})`;
  else if (log.archive !== "ok" && log.archive !== "skipped") log.status = `partial (archive: ${log.archive})`;
  log.feedItems = parsed.length;

  const candidates = [];
  for (const i of parsed) {
    log.sample ??= { link: i.link, date: i.date, since };
    let url;
    try {
      url = canonicalUrl(i.link);
    } catch {
      log.skipped.badUrl++;
      continue;
    }
    const id = itemId(url);
    if (known.has(id)) {
      log.skipped.known++;
      continue;
    }
    // Every published Citizen Space consultation has a start date. A record
    // without one (e.g. a sparse `fields=minimal` archive row) can't be placed
    // in the window and would sort ahead of everything in runCollect, so it's
    // skipped rather than collected as if new.
    if (!i.date) {
      log.skipped.undated++;
      continue;
    }
    if (i.date < since) {
      log.skipped.old++;
      continue;
    }
    log.inWindow++;
    if ((!src.ai_specific && !isAiRelated(`${i.title}\n${i.text}`)) || !passesMustMatch(src.must_match, `${i.title}\n${i.text}\n${i.link}`)) {
      log.keywordDropped++;
      continue;
    }
    candidates.push({
      id,
      url,
      title: i.title,
      date: i.date,
      summary: i.summary,
      src,
      prefetched: { text: i.text, textSource: "article", extractMethod: "citizen-space-v2.4" },
    });
    if (candidates.length >= MAX_ITEMS_PER_SOURCE) break;
  }
  return { log, candidates };
}

// Phase A (cheap): resolve the feed and list fresh candidates — no article fetches.
async function listSource(src, { since, known }) {
  if (src.method === "sitemap") return listSitemap(src, { since, known });
  if (src.method === "listing") return listListing(src, { since, known });
  if (src.method === "citizen-space") return listCitizenSpace(src, { since, known });
  if (src.method === "legislation") return listLegislation(src, { since, known });
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
    // Sitemap/listing/API candidates were already fetched in Phase A.
    text = c.prefetched.text || "";
    textSource = c.prefetched.textSource || "article";
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
 * Seed URLs (#31): curated landmark pages on allow-listed sources
 * (data/seed-urls.yaml), and earlier items picked for re-analysis under a new
 * prompt (`recheck`). Fetched regardless of the window and keyword filters,
 * but always robots-checked; paywalled sources still give the standfirst only.
 * Returns null when the page can't be fetched (retried on a later run).
 */
async function fetchSeed(seed, src) {
  const fetchUrl = String(seed.url).trim();
  const url = canonicalUrl(fetchUrl);
  if (!isAllowed((await robotsFor(fetchUrl)).parsed, USER_AGENT, fetchUrl)) return null;
  const page = await get(fetchUrl);
  if (!page.ok) return null;
  let text;
  let textSource;
  let extractMethod;
  const ex = extractMainText(page.body, page.url);
  if (src.paywalled) {
    text = extractStandfirst(page.body);
    textSource = "standfirst";
    extractMethod = "standfirst";
  } else {
    text = ex.text || "";
    textSource = "article";
    extractMethod = ex.method;
  }
  text = truncate(text, MAX_TEXT_CHARS);
  return {
    id: seed.id || itemId(url),
    sourceId: src.id,
    url,
    title: seed.title || extractTitle(page.body) || ex.title || url,
    // A re-check keeps its stored date exactly (even null), so the record is
    // replaced in place rather than written to another month's directory.
    publishedAt: seed.recheck ? (seed.publishedAt ?? null) : seed.publishedAt || reconcileUrlDate(pagePublished(page.body, ex.text), fetchUrl),
    feedSummary: null,
    text,
    textSource,
    extractMethod,
    textSha256: sha256(text),
    fetchedAt: seed.fetchedAt || new Date().toISOString(),
    seed: seed.recheck ? "recheck" : "seed-url",
  };
}

/**
 * @param sources   active sources: [{ id, homepage, feed?, feeds?, ai_specific, paywalled, ... }]
 * @param knownIds  item ids already stored (skipped)
 * @param sinceDays only items published within this many days (undated items pass)
 * @param maxItems  fetch articles for at most this many (newest first); seeds count
 * @param seeds     [{ url, sourceId, id?, title?, publishedAt?, fetchedAt?, recheck? }] (#31),
 *                  fetched first; already filtered against stored items by the caller
 */
export async function runCollect({ sources, knownIds = [], sinceDays = 8, maxItems = Infinity, seeds = [] }) {
  const known = new Set(knownIds);
  const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
  const listed = await pool(sources.filter((s) => s.status !== "blocked" && s.status !== "pending"), CONCURRENCY, (s) => listSource(s, { since, known }));

  // Dedupe across feeds, then take the newest first: only as many as the
  // processor can analyse today (its Gemini budget). The rest stay unknown and
  // are picked up on later runs — so a backfill drains over a few days while
  // the current week is always handled first.
  const seen = new Set();
  const all = listed
    .flatMap((l) => l.candidates)
    .filter((c) => (seen.has(c.id) ? false : seen.add(c.id)))
    .sort((a, b) => String(b.date || "9999").localeCompare(String(a.date || "9999")));
  // Seeds go first (they are few and curated), within the same item budget.
  const srcById = new Map(sources.map((s) => [s.id, s]));
  const seedList = seeds.filter((sd) => srcById.has(sd.sourceId)).slice(0, maxItems);
  const seedFetched = await pool(seedList, CONCURRENCY, (sd) => fetchSeed(sd, srcById.get(sd.sourceId)).catch(() => null));
  const seedItems = seedFetched.filter(Boolean);
  // Re-checks whose page couldn't be fetched: reported so the processor marks
  // them and the paced re-check moves on instead of retrying them daily.
  const recheckFailed = seedList.filter((sd, k) => sd.recheck && !seedFetched[k]).map((sd) => sd.id);
  const seedIds = new Set(seedItems.map((i) => i.id));
  const rest = all.filter((c) => !seedIds.has(c.id));
  const selected = rest.slice(0, Math.max(0, maxItems - seedList.length));
  let items = [...seedItems, ...(await pool(selected, CONCURRENCY, fetchCandidate))];

  let deferred = rest.length - selected.length;
  while (items.length && Buffer.byteLength(JSON.stringify(items)) > MAX_RESPONSE_BYTES) {
    items.pop();
    deferred++;
  }
  const collectedBy = new Map();
  for (const i of items) collectedBy.set(i.sourceId, (collectedBy.get(i.sourceId) || 0) + 1);
  for (const l of listed) l.log.collected = collectedBy.get(l.log.id) || 0;
  // Sitemap pages checked and rejected (not AI / out of window): recorded as seen.
  const dropped = listed.flatMap((l) => l.dropped || []);
  return { since, items, deferred, candidates: all.length, dropped, seeds: { requested: seeds.length, fetched: seedItems.length, recheckFailed }, sources: listed.map((l) => l.log) };
}
