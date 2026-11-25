// Developer tool: show how a site can be ingested, to configure sitemap /
// html-list adapters (#12). Prints robots.txt sitemaps, sitemap URLs matching a
// pattern (newest lastmod first), links on a listing page matching a pattern,
// and advertised feeds. Read-only, robots-respecting, honest User-Agent.
//
// Usage: node probe-source.mjs <probe-id>...   (probes defined in PROBES below)
// Run it locally (a cloud dev session needs the site's host allowed in its
// environment, plus NODE_USE_ENV_PROXY=1 so Node's fetch uses the proxy).

import { get, robotsFor, USER_AGENT } from "./lib/http.js";
import { isAllowed, discoverFeedLinks, feedType, parseFeedItems } from "./lib/feed-pure.js";

export const PROBES = {
  asic: {
    origin: "https://asic.gov.au",
    listing: ["https://asic.gov.au/newsroom/media-releases/", "https://asic.gov.au/newsroom/"],
    pattern: /\/newsroom\/media-releases\/|\/about-asic\/news-centre\//,
  },
  apra: {
    origin: "https://www.apra.gov.au",
    listing: ["https://www.apra.gov.au/news-and-publications", "https://www.apra.gov.au/news-and-publications/media-releases"],
    pattern: /\/news-and-publications\//,
    feeds: ["https://www.apra.gov.au/rss.xml", "https://www.apra.gov.au/news-and-publications/rss"],
  },
};

const locs = (xml) =>
  [...String(xml).matchAll(/<(?:url|sitemap)>([\s\S]*?)<\/(?:url|sitemap)>/g)].map(([, b]) => ({
    loc: (b.match(/<loc>\s*([^<\s]+)\s*<\/loc>/) || [])[1],
    lastmod: (b.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/) || [])[1] || "",
  })).filter((x) => x.loc);

async function allowedGet(url) {
  if (!isAllowed((await robotsFor(url)).parsed, USER_AGENT, url)) return { ok: false, status: "robots-disallowed", body: "" };
  return get(url);
}

async function probe(id, p) {
  const out = [`\n## ${id} (${p.origin})`];
  const robots = await robotsFor(p.origin + "/");
  out.push(`robots.txt: HTTP ${robots.status}, state ${robots.parsed.state}, sitemaps: ${robots.parsed.sitemaps.join(", ") || "none"}`);

  // Sitemaps: robots-listed, else /sitemap.xml. Follow one level of index.
  const roots = robots.parsed.sitemaps.length ? robots.parsed.sitemaps : [`${p.origin}/sitemap.xml`];
  const matched = [];
  for (const root of roots.slice(0, 3)) {
    const r = await allowedGet(root);
    out.push(`sitemap ${root}: HTTP ${r.status}, ${r.body.length} bytes`);
    if (!r.ok) continue;
    let entries = locs(r.body);
    if (/<sitemapindex/i.test(r.body)) {
      out.push(`  index with ${entries.length} child sitemaps: ${entries.slice(0, 8).map((e) => e.loc).join(" | ")}`);
      const children = entries.filter((e) => /news|media|release|page|node/i.test(e.loc)).slice(0, 6);
      entries = [];
      for (const c of children.length ? children : locs(r.body).slice(0, 4)) {
        const cr = await allowedGet(c.loc);
        out.push(`  child ${c.loc}: HTTP ${cr.status}, ${locs(cr.body).length} urls`);
        if (cr.ok) entries.push(...locs(cr.body));
      }
    }
    matched.push(...entries.filter((e) => p.pattern.test(e.loc)));
  }
  matched.sort((a, b) => b.lastmod.localeCompare(a.lastmod));
  out.push(`sitemap URLs matching ${p.pattern}: ${matched.length}; newest 12:`);
  for (const e of matched.slice(0, 12)) out.push(`  ${e.lastmod || "(no lastmod)"}  ${e.loc}`);

  // Listing pages: matching links and advertised feeds.
  for (const url of p.listing || []) {
    const r = await allowedGet(url);
    out.push(`listing ${url}: HTTP ${r.status}`);
    if (!r.ok) continue;
    const links = [...new Set([...r.body.matchAll(/href="([^"#?]+)"/g)].map((m) => new URL(m[1], r.url).toString()).filter((h) => p.pattern.test(h)))];
    out.push(`  ${links.length} matching links; first 15:`);
    for (const l of links.slice(0, 15)) out.push(`    ${l}`);
    const feeds = discoverFeedLinks(r.body, r.url);
    out.push(`  advertised feeds: ${feeds.join(", ") || "none"}`);
    const cls = [...new Set([...r.body.matchAll(/class="([^"]*(?:list|teaser|card|item|result)[^"]*)"/gi)].map((m) => m[1]))].slice(0, 12);
    out.push(`  list-ish classes: ${cls.join(" · ") || "none"}`);
  }

  // Known feeds: what they actually contain.
  for (const url of p.feeds || []) {
    const r = await allowedGet(url);
    const items = r.ok && feedType(r.body) ? parseFeedItems(r.body) : [];
    out.push(`feed ${url}: HTTP ${r.status}, ${items.length} items`);
    for (const i of items.slice(0, 10)) out.push(`    ${i.date?.slice(0, 10) ?? "undated"}  ${i.title}  ${i.link}`);
  }
  return out.join("\n");
}

const ids = process.argv.slice(2);
for (const id of ids.length ? ids : Object.keys(PROBES)) {
  if (!PROBES[id]) {
    console.error(`unknown probe ${id}`);
    continue;
  }
  console.log(await probe(id, PROBES[id]));
}
