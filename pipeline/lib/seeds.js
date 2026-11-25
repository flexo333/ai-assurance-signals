// Seed URLs and re-checks (#31) — pure. Tested by seeds.test.mjs.
//
// Seeds: landmark pages on allow-listed sources that sit outside rolling
// feed/sitemap windows, curated in data/seed-urls.yaml. A seed must belong to
// a listed, non-blocked source and be on that source's own host (its homepage
// host, or one of its `hosts`), so seeding can never widen the allow-list.
//
// Re-checks: items stored as "irrelevant" under an older prompt, re-fetched
// and re-analysed a few at a time (within the daily Gemini budget) so items
// the v3 Financial Services scope now accepts aren't lost.

import { canonicalUrl, itemId } from "./text-pure.js";

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); // as canonicalUrl does
  } catch {
    return null;
  }
};

/** Hosts a source's content may come from: its homepage host plus any `hosts`. */
export const sourceHosts = (src) => new Set([hostOf(src.homepage), ...[].concat(src.hosts || []).map((h) => String(h).toLowerCase().replace(/^www\./, ""))].filter(Boolean));

/**
 * Validate seed entries against the allow-list. Returns { seeds, rejected }:
 * seeds = [{ id, url, sourceId }] not yet stored; rejected = [{ url, reason }].
 */
export function planSeeds(entries, sources, knownIds = new Set()) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const seeds = [];
  const rejected = [];
  const seen = new Set();
  for (const e of entries || []) {
    const url = e?.url;
    const src = byId.get(e?.source);
    if (!url || !src) {
      rejected.push({ url, reason: `unknown source ${e?.source}` });
      continue;
    }
    if (src.status === "blocked" || src.status === "pending") {
      rejected.push({ url, reason: `source ${src.id} is ${src.status}` });
      continue;
    }
    let canon;
    try {
      canon = canonicalUrl(url);
    } catch {
      rejected.push({ url, reason: "bad url" });
      continue;
    }
    if (!sourceHosts(src).has(hostOf(canon))) {
      rejected.push({ url, reason: `host not on source ${src.id}` });
      continue;
    }
    const id = itemId(canon);
    if (knownIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    // Fetched as written; id from the canonical URL. A curated `published`
    // date (YYYY-MM-DD) wins over the page's, for pages with no usable date.
    const pub = e.published instanceof Date ? e.published.toISOString().slice(0, 10) : String(e.published || "");
    const published = /^\d{4}-\d{2}-\d{2}$/.test(pub) ? `${pub}T00:00:00.000Z` : null;
    seeds.push({ id, url: String(url).trim(), sourceId: src.id, ...(published ? { publishedAt: published } : {}) });
  }
  return { seeds, rejected };
}

/**
 * Stored items to re-analyse: status "irrelevant", analysed under a prompt
 * older than `promptVersion`, from news, industry or vendor sources or a
 * financial-services source, newest first, at most `limit`. Each keeps its id,
 * title and dates so the record is replaced in place.
 */
export function pickRechecks(items, sources, { limit = 0, promptVersion }) {
  if (!limit) return [];
  const byId = new Map(sources.map((s) => [s.id, s]));
  return items
    .filter((i) => i.status === "irrelevant" && (i.provenance?.promptVersion ?? 0) < promptVersion)
    .filter((i) => !((i.recheck?.promptVersion ?? 0) >= promptVersion)) // already tried (page unavailable)
    .filter((i) => {
      const s = byId.get(i.sourceId);
      return s && s.status !== "blocked" && (["news", "industry", "vendor"].includes(s.authority) || s.sector === "financial-services");
    })
    .sort((a, b) => String(b.publishedAt || b.fetchedAt).localeCompare(String(a.publishedAt || a.fetchedAt)))
    .slice(0, limit)
    .map((i) => ({ id: i.id, url: i.url, sourceId: i.sourceId, title: i.title, publishedAt: i.publishedAt, fetchedAt: i.fetchedAt, recheck: true }));
}
