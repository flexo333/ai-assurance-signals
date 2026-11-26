// Edition assembly — pure. Ranking, Top Signals selection and themed sections.
// Tested by rank.test.mjs.

import { clusterItems, coverageBoost } from "./cluster.js";

// industry: banks, insurers, super funds and FS peak bodies; vendor: cloud and
// enterprise vendors' customer stories (#31).
export const AUTHORITY_WEIGHT = { official: 1.0, standards: 0.95, lab: 0.85, research: 0.8, industry: 0.75, news: 0.6, vendor: 0.5 };

export const SECTIONS = [
  { id: "policy-legislation", title: "Australian Policy & Legislation" },
  { id: "regulator-guidance", title: "Regulator Guidance & Enforcement" },
  { id: "public-sector", title: "Public Sector AI" },
  { id: "standards-frameworks", title: "Standards & Frameworks" },
  { id: "frontier-labs", title: "Frontier Labs" },
  { id: "international", title: "International" },
  { id: "financial-services", title: "Financial Services" },
  { id: "news-commentary", title: "News & Commentary" },
];

// Item kinds that never lead an edition and rank lower within sections (#13).
// Items analysed before PROMPT_VERSION 2 have no item_kind and weigh 1.0.
export const NON_SIGNAL_KINDS = new Set(["product", "business", "prediction"]);
export const KIND_WEIGHT = { product: 0.6, business: 0.5, prediction: 0.5, commentary: 0.85 };
// Top Signals beyond the minimum need at least this significance (#13).
export const TOP_EXTRA_MIN_SIGNIFICANCE = 4;

export const SECTION_CAP = 8;
export const TOP_MIN = 3;
export const TOP_MAX = 5;
export const TOP_MAX_NEWS = 2;

/** significance × authority × AU boost × recency × grounding × kind weight. */
export function score(item, now = Date.now()) {
  const c = item.classification || {};
  const sig = c.significance ?? 2;
  const auth = AUTHORITY_WEIGHT[item.authority] ?? 0.6;
  const au = 1 + (0.5 * (c.au_relevance ?? 0)) / 3;
  const t = Date.parse(item.publishedAt || item.fetchedAt);
  const ageDays = Number.isFinite(t) ? Math.max(0, (now - t) / 864e5) : 7;
  const recency = 0.5 ** (ageDays / 14);
  const grounded = item.status === "summarised" ? 1 : 0.5;
  const kind = KIND_WEIGHT[c.item_kind] ?? 1;
  return Math.round(sig * auth * au * recency * grounded * kind * 1000) / 1000;
}

/**
 * Financial Services item (#31): flagged by the model, themed so, or from a
 * source marked `sector: financial-services` in sources.yaml (the record's
 * `sector`, copied from its source).
 */
export function isFinancialServices(item) {
  const c = item.classification || {};
  return c.is_financial_services === true || c.theme === "financial-services" || item.sector === "financial-services";
}

// Official items of these kinds are regulation and go to a regulatory section
// even when they also concern financial services (#48).
export const REGULATORY_KINDS = new Set(["legislation", "regulation", "regulator-guidance", "enforcement", "government-policy", "consultation"]);
const REGULATORY_THEMES = ["policy-legislation", "regulator-guidance", "public-sector"];
const REGULATOR_KIND_SECTION = { "regulator-guidance": "regulator-guidance", enforcement: "regulator-guidance", regulation: "regulator-guidance" };

/**
 * The regulatory section of an official regulatory item (by item_kind), or
 * null. Australian items: the model's theme if it is regulatory, else by kind
 * (guidance, enforcement and regulation → Regulator Guidance; legislation,
 * policy and consultations → Policy & Legislation). Others: International.
 */
export function regulatorySectionFor(item) {
  if (item.authority !== "official" || !REGULATORY_KINDS.has(item.classification?.item_kind)) return null;
  if (!String(item.jurisdiction || "").startsWith("AU")) return "international";
  const theme = item.classification.theme;
  if (REGULATORY_THEMES.includes(theme)) return theme;
  return REGULATOR_KIND_SECTION[item.classification.item_kind] || "policy-legislation";
}

/**
 * Where an item lives in the edition. Regulation comes first: official
 * regulatory items go to their regulatory section, even financial-services
 * regulators' (they still appear on the Financial Services page). Then other
 * Financial Services items (any authority) go to Financial Services; other
 * news and vendor items to News & Commentary; otherwise the model's theme,
 * except lab items, which go to Frontier Labs, and non-Australian official
 * items, which go to International.
 */
export function sectionFor(item) {
  const regulatory = regulatorySectionFor(item);
  if (regulatory) return regulatory;
  if (isFinancialServices(item)) return "financial-services";
  if (item.authority === "news" || item.authority === "vendor") return "news-commentary";
  if (item.authority === "lab") return "frontier-labs";
  const theme = item.classification?.theme;
  const isAU = String(item.jurisdiction || "").startsWith("AU");
  if (!isAU && REGULATORY_THEMES.includes(theme)) return "international";
  if (theme === "news-commentary" || theme === "financial-services" || !SECTIONS.some((s) => s.id === theme)) return isAU ? "policy-legislation" : "international";
  return theme;
}

const GRACE_MS = 7 * 864e5;

/**
 * Publishable items for an edition window (from, to].
 *   current  — published in the window, or collected in it if published at
 *              most 7 days before it (late arrivals); never collected after `to`
 *   backfill — published in the window (collected any time, for past weeks)
 * `exclude` holds ids already placed in other editions.
 */
export function selectWindow(items, { from, to, mode = "current", exclude = new Set() }) {
  const graceFrom = new Date(Date.parse(from) - GRACE_MS).toISOString();
  return items.filter((i) => {
    if (i.status !== "summarised" && i.status !== "headline-only") return false;
    if (exclude.has(i.id)) return false;
    const d = i.publishedAt || i.fetchedAt;
    if (mode === "backfill") return d > from && d <= to;
    if (i.fetchedAt > to) return false;
    const publishedIn = d > from && d <= to;
    const lateArrival = i.fetchedAt > from && d > graceFrom;
    return publishedIn || lateArrival;
  });
}

/** Weekly cutoffs (Fridays 04:17 UTC) after `startIso` and strictly before `beforeIso`. */
export function weeklyCutoffs(startIso, beforeIso, { weekday = 5, hour = 4, minute = 17 } = {}) {
  const d = new Date(startIso);
  d.setUTCHours(hour, minute, 0, 0);
  while (d.getUTCDay() !== weekday || d.toISOString() <= startIso) d.setUTCDate(d.getUTCDate() + 1);
  const out = [];
  while (d.toISOString() < beforeIso) {
    out.push(d.toISOString());
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

/**
 * Assemble an edition. Items reporting the same event are grouped into one
 * story (see cluster.js): the story ranks and is placed by its lead item, with
 * the lead's score plus a small boost per extra source, and its other items
 * are recorded as `also` on the lead's entry. Caps count stories, not items.
 */
export function buildEdition(items, { id, from, to, now = Date.parse(to) }) {
  const ref = (st) => ({ id: st.lead.id, score: st.s, ...(st.also.length ? { also: st.also.map((i) => i.id) } : {}) });
  const ranked = clusterItems(items)
    .map((st) => ({ ...st, i: st.lead, s: Math.round(score(st.lead, now) * coverageBoost(st) * 1000) / 1000 }))
    .sort((a, b) => b.s - a.s || String(a.i.id).localeCompare(String(b.i.id)));

  const top = [];
  let news = 0;
  for (const st of ranked) {
    const { i } = st;
    if (top.length >= TOP_MAX) break;
    if (i.status !== "summarised") continue;
    if (i.authority === "news" && news >= TOP_MAX_NEWS) continue;
    // Vendor-written case studies never lead an edition (#31).
    if (i.authority === "vendor") continue;
    // Products, business news and predictions never lead an edition (#13).
    if (NON_SIGNAL_KINDS.has(i.classification?.item_kind)) continue;
    // Significance gates (ranking is by composite score, so later items may still
    // qualify: skip, don't stop). Up to the minimum, sig >= 3 suffices (lower only
    // to make up the minimum); beyond it, sig >= TOP_EXTRA_MIN_SIGNIFICANCE.
    const sig = i.classification?.significance ?? 0;
    if (top.length >= TOP_MIN && sig < TOP_EXTRA_MIN_SIGNIFICANCE) continue;
    top.push(ref(st));
    if (i.authority === "news") news++;
  }
  const topIds = new Set(top.map((t) => t.id));

  const sections = SECTIONS.map((sec) => {
    const members = ranked.filter(({ i }) => !topIds.has(i.id) && sectionFor(i) === sec.id);
    return {
      id: sec.id,
      title: sec.title,
      items: members.slice(0, SECTION_CAP).map(ref),
      // Beyond the cap: listed compactly (headline + source) so nothing is hidden.
      more: members.slice(SECTION_CAP).map(ref),
      overflow: Math.max(0, members.length - SECTION_CAP),
    };
  }).filter((s) => s.items.length);

  return {
    id,
    window: { from, to },
    topSignals: top,
    sections,
    counts: {
      candidates: items.length,
      stories: ranked.length,
      summarised: items.filter((i) => i.status === "summarised").length,
      headlineOnly: items.filter((i) => i.status === "headline-only").length,
    },
  };
}

/** Every item id an edition places, including grouped `also` items. */
export function editionItemIds(edition) {
  return [...edition.topSignals, ...edition.sections.flatMap((s) => [...s.items, ...(s.more || [])])].flatMap((r) => [r.id, ...(r.also || [])]);
}

/** ISO-8601 week id (e.g. "2026-W48") for a date, evaluated in Australia/Sydney. */
export function isoWeekId(date, timeZone = "Australia/Sydney") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const [y, m, d] = parts.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 864e5 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
