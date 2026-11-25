// Phase 1 source verification. Probes every entry in ../sources.yaml:
//   robots.txt → homepage (+ feed autodiscovery) → candidate feeds → sitemaps
// and recommends an ingest method per source.
//
// Usage: node source-check.mjs [--only id1,id2] [--out ../data/source-check.json]
//        node source-check.mjs --from-json result.json   (print a report for a saved run,
//                                                          e.g. one returned by the Sydney Lambda)
// Writes JSON (machine-readable) and prints a Markdown report; in Actions the
// report is also appended to $GITHUB_STEP_SUMMARY.
//
// Also imported by lambda/source-check-handler.mjs (runCheck), so it must not
// do anything at import time.

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  feedType,
  parseFeedItems,
  newestItem,
  discoverFeedLinks,
  isAllowed,
} from "./lib/feed-pure.js";
import { parseCitizenSpaceItems } from "./lib/citizen-space.js";
import { buildLegislationQueryUrl, parseLegislationTitles, DEFAULT_LEGISLATION_API } from "./lib/legislation.js";
import { get, robotsFor, clearRobotsCache, USER_AGENT } from "./lib/http.js";

export { USER_AGENT };
import { isAiRelated } from "./lib/keywords.js";

const CONCURRENCY = 6;
const RECENT_DAYS = 30;

const here = dirname(fileURLToPath(import.meta.url));

async function checkFeed(url) {
  const robots = await robotsFor(url);
  if (!isAllowed(robots.parsed, USER_AGENT, url)) return { url, allowed: false };
  const r = await get(url);
  const type = r.ok ? feedType(r.body) : null;
  if (!type) return { url, allowed: true, status: r.status, error: r.error, isFeed: false };
  const items = parseFeedItems(r.body);
  const cutoff = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString();
  const recent = items.filter((i) => i.date && i.date >= cutoff);
  const newest = newestItem(items);
  return {
    url: r.url,
    allowed: true,
    status: r.status,
    isFeed: true,
    type,
    items: items.length,
    recent30d: recent.length,
    aiRecent30d: recent.filter((i) => isAiRelated(i.title)).length,
    newest: newest ? { title: newest.title, date: newest.date, link: newest.link } : null,
  };
}

async function checkSource(src) {
  if (src.method === "citizen-space") {
    const origin = new URL(src.api || src.homepage).origin;
    const apiUrl = `${origin}/api/2.4/json_search_results?st=open`;
    const robots = await robotsFor(apiUrl);
    const allowed = isAllowed(robots.parsed, USER_AGENT, apiUrl);
    const res = allowed ? await get(apiUrl) : null;
    const items = res?.ok ? parseCitizenSpaceItems(res.body, { baseUrl: origin, include: src.include, exclude: src.exclude }) : null;
    const ok = Array.isArray(items);
    const cutoff = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString();
    const recent = ok ? items.filter((i) => i.date && i.date >= cutoff) : [];
    const newest = ok ? newestItem(items) : null;
    const feedEntry = {
      url: apiUrl,
      allowed,
      status: res?.status ?? null,
      error: res?.error,
      isFeed: ok,
      ...(ok ? {
        type: "citizen-space",
        items: items.length,
        recent30d: recent.length,
        aiRecent30d: recent.filter((i) => isAiRelated(`${i.title}\n${i.text}`)).length,
        newest: newest ? { title: newest.title, date: newest.date, link: newest.link } : null,
      } : {}),
    };
    const status = ok
      ? "ok"
      : robots.parsed.state === "unreachable"
        ? "robots-unreachable"
        : !allowed
          ? "robots-disallowed"
          : res?.status
            ? `http-${res.status}`
            : `unreachable:${res?.error || "?"}`;
    return {
      id: src.id,
      name: src.name,
      authority: src.authority,
      jurisdiction: src.jurisdiction,
      paywalled: !!src.paywalled,
      homepage: src.homepage,
      robotsStatus: robots.status,
      robotsState: robots.parsed.state,
      homeAllowed: allowed,
      homeStatus: res?.status ?? null,
      homeError: res?.error,
      discoveredFeeds: [],
      sitemaps: robots.parsed.sitemaps,
      feeds: [feedEntry],
      recommended: { method: ok ? "citizen-space" : "none", status, feed: ok ? apiUrl : null },
      checkedAt: new Date().toISOString(),
    };
  }

  if (src.method === "legislation") {
    const cutoff = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString();
    const apiUrl = buildLegislationQueryUrl({ apiBase: src.api || DEFAULT_LEGISLATION_API, since: cutoff, top: 30 });
    const robots = await robotsFor(apiUrl);
    const allowed = isAllowed(robots.parsed, USER_AGENT, apiUrl);
    const res = allowed ? await get(apiUrl) : null;
    const items = res?.ok ? parseLegislationTitles(res.body, { webBase: src.homepage, collections: src.collections, include: src.include, exclude: src.exclude, limit: 30 }) : null;
    const ok = Array.isArray(items);
    const newest = ok ? newestItem(items) : null;
    const feedEntry = {
      url: apiUrl,
      allowed,
      status: res?.status ?? null,
      error: res?.error,
      isFeed: ok,
      ...(ok ? {
        type: "legislation",
        items: items.length,
        recent30d: items.length,
        aiRecent30d: items.filter((i) => isAiRelated(i.title)).length,
        newest: newest ? { title: newest.title, date: newest.date, link: newest.link } : null,
      } : {}),
    };
    const status = ok
      ? "ok"
      : robots.parsed.state === "unreachable"
        ? "robots-unreachable"
        : !allowed
          ? "robots-disallowed"
          : res?.status
            ? `http-${res.status}`
            : `unreachable:${res?.error || "?"}`;
    return {
      id: src.id,
      name: src.name,
      authority: src.authority,
      jurisdiction: src.jurisdiction,
      paywalled: !!src.paywalled,
      homepage: src.homepage,
      robotsStatus: robots.status,
      robotsState: robots.parsed.state,
      homeAllowed: allowed,
      homeStatus: res?.status ?? null,
      homeError: res?.error,
      discoveredFeeds: [],
      sitemaps: robots.parsed.sitemaps,
      feeds: [feedEntry],
      recommended: { method: ok ? "legislation" : "none", status, feed: ok ? apiUrl : null },
      checkedAt: new Date().toISOString(),
    };
  }

  const robots = await robotsFor(src.homepage);
  const homeAllowed = isAllowed(robots.parsed, USER_AGENT, src.homepage);
  const home = homeAllowed ? await get(src.homepage) : null;
  const discovered = src.discover !== false && home?.ok ? discoverFeedLinks(home.body, home.url) : [];
  const candidates = src.method === "sitemap" || src.method === "listing"
    ? []
    : [...new Set([...(src.feed ? [src.feed] : []), ...(src.feeds || []), ...discovered])];
  const feeds = [];
  for (const url of candidates) feeds.push(await checkFeed(url));
  const working = feeds
    .filter((f) => f.isFeed && f.items > 0)
    .sort((a, b) => (b.newest?.date || "").localeCompare(a.newest?.date || ""));

  // A working feed that robots permits is usable even if the homepage itself
  // is disallowed (checkFeed applies robots per feed URL).
  let method;
  let status;
  if (working.length) [method, status] = [working[0].type === "atom" ? "atom" : "rss", "ok"];
  else if (robots.parsed.state === "unreachable") [method, status] = ["none", "robots-unreachable"];
  else if (!homeAllowed) [method, status] = ["none", "robots-disallowed"];
  else if (src.method === "sitemap" && home?.ok) [method, status] = ["sitemap", "ok"];
  else if (src.method === "listing" && home?.ok) [method, status] = ["listing", "ok"];
  else if (home?.ok && robots.parsed.sitemaps.length) [method, status] = ["sitemap", "needs-config"];
  else if (home?.ok) [method, status] = ["html-list", "needs-selector"];
  else [method, status] = ["none", home?.status ? `http-${home.status}` : `unreachable:${home?.error || "?"}`];

  const recFeed = working[0]?.url || (status === "ok" && (src.method === "sitemap" || src.method === "listing") ? [].concat(src.sitemap || src.listing)[0] || null : null);

  return {
    id: src.id,
    name: src.name,
    authority: src.authority,
    jurisdiction: src.jurisdiction,
    paywalled: !!src.paywalled,
    homepage: src.homepage,
    robotsStatus: robots.status,
    robotsState: robots.parsed.state,
    homeAllowed,
    homeStatus: home?.status ?? null,
    homeError: home?.error,
    discoveredFeeds: discovered,
    sitemaps: robots.parsed.sitemaps,
    feeds,
    recommended: { method, status, feed: recFeed },
    checkedAt: new Date().toISOString(),
  };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Check every source; returns per-source results. Safe to call repeatedly (warm Lambdas). */
export async function runCheck(sources, { concurrency = CONCURRENCY } = {}) {
  clearRobotsCache();
  const ids = new Set();
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error(`duplicate source id: ${s.id}`);
    ids.add(s.id);
  }
  return pool(sources, concurrency, checkSource);
}

export function report(results, { location = "GitHub Actions", generatedAt = new Date().toISOString() } = {}) {
  const by = (s) => results.filter((r) => r.recommended.status === s).length;
  const lines = [
    `## Source check from ${location} — ${generatedAt.slice(0, 16)}Z`,
    "",
    `${results.length} sources · **${by("ok")} with a working feed** · ${by("needs-config")} sitemap · ${by("needs-selector")} HTML list · ${results.filter((r) => r.recommended.method === "none").length} blocked/unreachable`,
    "",
    "| Source | Authority | Method | Status | Feed items (30d / AI 30d) | Newest item |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    const f = r.feeds.find((x) => x.url === r.recommended.feed);
    const counts = f ? `${f.items} (${f.recent30d} / ${f.aiRecent30d})` : "—";
    const newest = f?.newest ? `${f.newest.date?.slice(0, 10)} ${String(f.newest.title).slice(0, 60)}` : "—";
    lines.push(`| ${r.id}${r.paywalled ? " 🔒" : ""} | ${r.authority} | ${r.recommended.method} | ${r.recommended.status} | ${counts} | ${newest.replace(/\|/g, "/")} |`);
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const argVal = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  let md;
  const fromJson = argVal("--from-json");
  if (fromJson) {
    const saved = JSON.parse(await readFile(resolve(fromJson), "utf8"));
    md = report(saved.results, { location: saved.location, generatedAt: saved.generatedAt });
  } else {
    const only = argVal("--only")?.split(",");
    const outPath = resolve(argVal("--out") || resolve(here, "../data/source-check.json"));
    const { sources } = parseYaml(await readFile(resolve(here, "../sources.yaml"), "utf8"));
    const selected = only ? sources.filter((s) => only.includes(s.id)) : sources;
    const generatedAt = new Date().toISOString();
    const results = await runCheck(selected);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ generatedAt, location: "GitHub Actions", userAgent: USER_AGENT, results }, null, 2) + "\n");
    md = report(results, { generatedAt });
  }
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
