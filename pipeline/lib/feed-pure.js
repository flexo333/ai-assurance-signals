// Pure, dependency-free helpers for feed detection and robots.txt.
// No network, no npm deps — smoke-tested by feed-pure.test.mjs under `node --test`.

import { stripHtml } from "./text-pure.js";

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/** 'rss' | 'atom' | 'rdf' | null — sniffed from the document head. */
export function feedType(body) {
  if (typeof body !== "string") return null;
  const head = body.slice(0, 2000).replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  if (/<rss[\s>]/i.test(head)) return "rss";
  if (/<feed[\s>]/i.test(head)) return "atom";
  if (/<rdf:RDF[\s>]/i.test(head)) return "rdf";
  return null;
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : null;
}

function rawTag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return null;
  const inner = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Escaped HTML (&lt;p&gt;) is common in RSS descriptions — unescape before stripping.
  return /&lt;\/?[a-z]/i.test(inner) ? inner.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : inner;
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel=["']alternate["']/i.test(a)) || links.find((a) => !/rel=/i.test(a)) || links[0];
  const href = pick && pick.match(/href=["']([^"']+)["']/i);
  return href ? decode(href[1]) : null;
}

/**
 * Parse feed items into [{ title, link, date }] (date = ISO string or null).
 * Deliberately forgiving: this is for checking and light ingestion, not a
 * general-purpose XML parser.
 */
export function parseFeedItems(body) {
  const type = feedType(body);
  if (!type) return [];
  const re = type === "atom" ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;
  return [...body.matchAll(re)].map(([block]) => {
    const title = tag(block, "title");
    const link = type === "atom" ? atomLink(block) : tag(block, "link") || tag(block, "guid");
    const rawDate =
      tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") || tag(block, "dc:date");
    const t = rawDate ? Date.parse(rawDate) : NaN;
    const rawSummary =
      rawTag(block, "content:encoded") || rawTag(block, "description") || rawTag(block, "summary") || rawTag(block, "content");
    const summary = rawSummary ? stripHtml(rawSummary).slice(0, 4000) : null;
    return { title, link, date: Number.isNaN(t) ? null : new Date(t).toISOString(), summary };
  });
}

/** Newest item by date (items without dates are ignored); null if none dated. */
export function newestItem(items) {
  return items.filter((i) => i.date).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}

/** RSS/Atom URLs advertised via <link rel="alternate" type="application/(rss|atom)+xml">. */
export function discoverFeedLinks(html, baseUrl) {
  if (typeof html !== "string") return [];
  const out = [];
  for (const [, attrs] of html.matchAll(/<link\b([^>]*)>/gi)) {
    if (!/rel=["']?alternate/i.test(attrs)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(attrs)) continue;
    const href = attrs.match(/href=["']([^"']+)["']/i);
    if (!href) continue;
    try {
      out.push(new URL(decode(href[1]), baseUrl).toString());
    } catch {
      /* ignore malformed hrefs */
    }
  }
  return [...new Set(out)];
}

/**
 * Parse robots.txt into { groups: [{ agents[], rules: [{ allow, path }] }], sitemaps[] }.
 */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow means "allow everything" — no rule needed.
      if (value) current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return { groups, sitemaps };
}

function ruleMatches(rulePath, path) {
  // Supports '*' wildcards and a trailing '$' anchor (Google/RFC 9309 style).
  const anchored = rulePath.endsWith("$");
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

/**
 * RFC 9309: pick the most specific matching group for `agent` (falling back
 * to '*'), then the longest matching rule wins; ties go to Allow.
 */
export function isAllowed(robots, agent, url) {
  const { pathname, search } = new URL(url);
  const path = pathname + search;
  const ua = agent.toLowerCase();
  const named = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const groups = named.length ? named : robots.groups.filter((g) => g.agents.includes("*"));
  const rules = groups.flatMap((g) => g.rules).filter((r) => ruleMatches(r.path, path));
  if (!rules.length) return true;
  rules.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return rules[0].allow;
}

/**
 * RFC 9309 §2.3.1: robots rules from an HTTP fetch of /robots.txt.
 *   2xx                → parse the body
 *   4xx (incl. 404)    → no restrictions ("unavailable" file)
 *   5xx / network fail → assume complete disallow ("unreachable"), and retry later
 */
export function robotsFromResponse(status, body) {
  if (status >= 200 && status < 300) return { ...parseRobots(body), state: "ok" };
  if (status >= 400 && status < 500) return { groups: [], sitemaps: [], state: "absent" };
  return {
    groups: [{ agents: ["*"], rules: [{ allow: false, path: "/" }] }],
    sitemaps: [],
    state: "unreachable",
  };
}

/**
 * Parse a sitemap or sitemap index.
 * @returns { isIndex, entries: [{ loc, lastmod }] } — lastmod as ISO string or null.
 */
export function parseSitemap(xml) {
  const body = String(xml ?? "");
  const isIndex = /<sitemapindex[\s>]/i.test(body);
  const entries = [...body.matchAll(/<(?:url|sitemap)>([\s\S]*?)<\/(?:url|sitemap)>/gi)]
    .map(([, b]) => {
      const loc = (b.match(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)/i) || [])[1];
      const lm = (b.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i) || [])[1];
      const t = lm ? Date.parse(lm) : NaN;
      return loc ? { loc: loc.replace(/&amp;/g, "&"), lastmod: Number.isNaN(t) ? null : new Date(t).toISOString() } : null;
    })
    .filter(Boolean);
  return { isIndex, entries };
}

/**
 * Pure: pick sitemap entries for a source.
 * include/exclude are regex strings matched against the URL; newest lastmod first;
 * entries with lastmod older than `since` are dropped (undated entries kept).
 */
export function selectSitemapEntries(entries, { include, exclude, since, known = new Set(), idOf, limit = 25 }) {
  const inc = include ? new RegExp(include) : null;
  const exc = exclude ? new RegExp(exclude, "i") : null;
  return entries
    .filter((e) => (!inc || inc.test(e.loc)) && !(exc && exc.test(e.loc)))
    .filter((e) => !e.lastmod || !since || e.lastmod >= since)
    .filter((e) => !known.has(idOf(e.loc)))
    .sort((a, b) => String(b.lastmod || "").localeCompare(String(a.lastmod || "")))
    .slice(0, limit);
}

/**
 * Listing adapter (#12, #31): article links on an HTML listing page, as
 * sitemap-style entries ({ loc, lastmod: "" }) in page order, deduplicated.
 * Fragments are dropped; only http(s) links on the listing's own host are kept.
 * Use selectSitemapEntries for include/exclude/known filtering.
 */
export function extractListingLinks(html, baseUrl) {
  if (typeof html !== "string") return [];
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const out = new Map();
  for (const [, href] of html.matchAll(/<a\b[^>]*?\bhref=["']([^"'#][^"']*)["']/gi)) {
    let u;
    try {
      u = new URL(decode(href), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || u.host !== base.host) continue;
    u.hash = "";
    const loc = u.toString();
    if (loc !== base.toString() && !out.has(loc)) out.set(loc, { loc, lastmod: "" });
  }
  return [...out.values()];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * Month a URL is filed under (/2026/11/ or /2026/November/), as the first of
 * that month (ISO), or null. Many newsrooms show no machine-readable date.
 */
export function dateFromUrl(url) {
  const m = String(url).match(/\/(20\d\d)\/(\d\d|[A-Za-z]{3,9})\//);
  if (!m) return null;
  const mm = /^\d\d$/.test(m[2]) ? Number(m[2]) : MONTHS.findIndex((n) => n.startsWith(m[2].toLowerCase()) && m[2].length >= 3) + 1;
  if (!(mm >= 1 && mm <= 12)) return null;
  return `${m[1]}-${String(mm).padStart(2, "0")}-01T00:00:00.000Z`;
}

/**
 * A page date checked against the month in its URL: when the URL names a month
 * and the page date falls in another one (CMS templates often carry a stale
 * datePublished), the URL month wins.
 */
export function reconcileUrlDate(pageDate, url) {
  const u = dateFromUrl(url);
  if (!u) return pageDate || null;
  return pageDate && pageDate.slice(0, 7) === u.slice(0, 7) ? pageDate : u;
}
