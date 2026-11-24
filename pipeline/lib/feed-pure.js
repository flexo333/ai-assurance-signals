// Pure, dependency-free helpers for feed detection and robots.txt.
// No network, no npm deps — smoke-tested by feed-pure.test.mjs under `node --test`.

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
    return { title, link, date: Number.isNaN(t) ? null : new Date(t).toISOString() };
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
