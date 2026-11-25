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
import { buildLegislationQueryUrl, parseODataPage, parseLegislationTitles, isLegislationAppShell, DEFAULT_LEGISLATION_API, DEFAULT_COLLECTIONS } from "./lib/legislation.js";
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

// The working, robots-permitted feeds to read for a source. Every configured
// `feed` / `feeds` entry that works is read (a source may split its coverage
// across feeds, e.g. AFR technology + policy); <link rel=alternate>
// autodiscovery on the homepage adds its freshest feed only when it is newer
// than every configured one (or none works), since some configured candidates
// work but are stale — e.g. a gov.uk search feed returning months-old items
// while the organisation feed is current. Stale feeds cost nothing extra:
// their items fall outside the window.
async function resolveFeeds(src) {
  const tried = new Set();
  const fetchFeed = async (url) => {
    if (!url || tried.has(url)) return null;
    tried.add(url);
    if (!isAllowed((await robotsFor(url)).parsed, USER_AGENT, url)) return null;
    const r = await get(url);
    if (!r.ok || !feedType(r.body)) return null;
    const items = parseFeedItems(r.body);
    if (!items.length) return null;
    return { url: r.url, body: r.body, newest: newestItem(items)?.date || "" };
  };
  const configured = [];
  for (const url of [src.feed, ...(src.feeds || [])]) {
    const f = await fetchFeed(url);
    if (f) configured.push(f);
  }
  const discovered = [];
  if (src.discover !== false && src.homepage && isAllowed((await robotsFor(src.homepage)).parsed, USER_AGENT, src.homepage)) {
    const home = await get(src.homepage);
    if (home.ok) {
      for (const url of discoverFeedLinks(home.body, home.url)) {
        const f = await fetchFeed(url);
        if (f) discovered.push(f);
      }
    }
  }
  discovered.sort((a, b) => b.newest.localeCompare(a.newest));
  const freshestConfigured = configured.reduce((m, f) => (f.newest > m ? f.newest : m), "");
  const out = [...configured];
  if (discovered[0] && (!configured.length || discovered[0].newest > freshestConfigured)) out.push(discovered[0]);
  return out;
}

const DEFAULT_SITEMAP_PAGES = 25;
const LEGISLATION_PAGE_SIZE = 100;
const LEGISLATION_MAX_PAGES = 10;

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
  const collections = src.collections || DEFAULT_COLLECTIONS;
  const apiBase = src.api || DEFAULT_LEGISLATION_API;
  const firstUrl = buildLegislationQueryUrl({ apiBase, since, top: LEGISLATION_PAGE_SIZE, collections });
  const log = { id: src.id, feed: firstUrl, method: "legislation", status: "ok", feedItems: 0, inWindow: 0, keywordDropped: 0, collected: 0, skipped: { known: 0, old: 0, badUrl: 0 }, sample: null };
  const dropped = [];
  if (!isAllowed((await robotsFor(firstUrl)).parsed, USER_AGENT, firstUrl)) {
    return { log: { ...log, status: "robots-disallowed" }, candidates: [], dropped };
  }
  // Page through every title registered in the window (following
  // @odata.nextLink, else $skip), so a busy week can't push titles past one page.
  const rows = [];
  let url = firstUrl;
  let pages = 0;
  while (url && pages < LEGISLATION_MAX_PAGES) {
    const res = await get(url);
    const page = res.ok ? parseODataPage(res.body) : null;
    if (!page) {
      if (!pages) return { log: { ...log, status: "api-unavailable" }, candidates: [], dropped };
      log.status = `partial (${pages} pages)`;
      break;
    }
    pages++;
    rows.push(...page.rows);
    if (page.nextLink) url = new URL(page.nextLink, url).toString();
    else if (page.rows.length >= LEGISLATION_PAGE_SIZE) url = buildLegislationQueryUrl({ apiBase, since, top: LEGISLATION_PAGE_SIZE, skip: pages * LEGISLATION_PAGE_SIZE, collections });
    else url = null;
  }
  if (url && pages >= LEGISLATION_MAX_PAGES) log.status = `truncated (${pages} pages)`;
  const picked = parseLegislationTitles(rows, {
    webBase: src.homepage,
    collections,
    include: src.include,
    exclude: src.exclude,
    since,
    known,
    idOf: idOfUrl,
    limit: src.max_pages || DEFAULT_SITEMAP_PAGES,
  });
  log.feedItems = rows.length;

  const candidates = [];
  for (const entry of picked) {
    const id = idOfUrl(entry.url);
    if (!id) continue;
    log.sample ??= { link: entry.url, date: entry.date, since };
    log.inWindow++;
    let bodyText = "";
    let answered = false; // the register gave a definitive answer for this title
    for (const docUrl of entry.docUrls) {
      if (!isAllowed((await robotsFor(docUrl)).parsed, USER_AGENT, docUrl)) continue;
      const docRes = await get(docUrl);
      if (!docRes.ok) continue;
      answered = true;
      // The SPA answers unknown routes (e.g. an instrument with no ES) with its
      // app shell: no document there, so try the next kind.
      if (isLegislationAppShell(docRes.body)) continue;
      const ex = extractMainText(docRes.body, docRes.url);
      if (ex.text) {
        bodyText = ex.text;
        break;
      }
    }
    if (!answered) continue; // transient doc failure: retried next run
    // Keyword check on the title and the document; the model is given the
    // register's own document text only (nothing synthesised to ground against).
    const hay = `${entry.title}\n${bodyText}`;
    if ((!src.ai_specific && !isAiRelated(hay)) || !passesMustMatch(src.must_match, hay)) {
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
      prefetched: { text: bodyText, textSource: "article", extractMethod: bodyText ? "legislation-epub" : "legislation-no-document" },
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
  const feeds = await resolveFeeds(src);
  if (!feeds.length) return { log: { ...log, status: "no-feed" }, candidates: [] };
  log.feed = feeds.map((f) => f.url).join(" + ");
  const parsed = feeds
    .flatMap((f) => parseFeedItems(f.body).map((i) => ({ ...i, feedUrl: f.url })))
    .filter((i) => i.link && i.title)
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  log.feedItems = parsed.length;
  const candidates = [];
  const listedIds = new Set();
  for (const { feedUrl, ...i } of parsed) {
    let url;
    log.sample ??= { link: i.link, date: i.date, since };
    try {
      url = canonicalUrl(new URL(i.link, feedUrl).toString());
    } catch {
      log.skipped.badUrl++;
      continue;
    }
    const id = itemId(url);
    if (listedIds.has(id)) continue; // same item in two of the source's feeds
    listedIds.add(id);
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
