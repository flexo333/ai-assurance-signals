// Edition assembly — pure. Ranking, Top Signals selection and themed sections.
// Tested by rank.test.mjs.

export const AUTHORITY_WEIGHT = { official: 1.0, standards: 0.95, lab: 0.85, research: 0.8, news: 0.6 };

export const SECTIONS = [
  { id: "policy-legislation", title: "Australian Policy & Legislation" },
  { id: "regulator-guidance", title: "Regulator Guidance & Enforcement" },
  { id: "public-sector", title: "Public Sector AI" },
  { id: "standards-frameworks", title: "Standards & Frameworks" },
  { id: "frontier-labs", title: "Frontier Labs" },
  { id: "international", title: "International" },
  { id: "news-commentary", title: "News & Commentary" },
];

export const SECTION_CAP = 8;
export const TOP_MIN = 3;
export const TOP_MAX = 5;
export const TOP_MAX_NEWS = 2;

/** significance × authority × AU boost × recency (7-day half-life within the window). */
export function score(item, now = Date.now()) {
  const c = item.classification || {};
  const sig = c.significance ?? 2;
  const auth = AUTHORITY_WEIGHT[item.authority] ?? 0.6;
  const au = 1 + (0.5 * (c.au_relevance ?? 0)) / 3;
  const t = Date.parse(item.publishedAt || item.fetchedAt);
  const ageDays = Number.isFinite(t) ? Math.max(0, (now - t) / 864e5) : 7;
  const recency = 0.5 ** (ageDays / 14);
  const grounded = item.status === "summarised" ? 1 : 0.5;
  return Math.round(sig * auth * au * recency * grounded * 1000) / 1000;
}

/**
 * Where an item lives in the edition. News always goes to News & Commentary;
 * otherwise the model's theme, except lab items, which go to Frontier Labs, and
 * non-Australian official items, which go to International.
 */
export function sectionFor(item) {
  if (item.authority === "news") return "news-commentary";
  if (item.authority === "lab") return "frontier-labs";
  const theme = item.classification?.theme;
  const isAU = String(item.jurisdiction || "").startsWith("AU");
  if (!isAU && ["policy-legislation", "regulator-guidance", "public-sector"].includes(theme)) return "international";
  if (theme === "news-commentary" || !SECTIONS.some((s) => s.id === theme)) return isAU ? "policy-legislation" : "international";
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

export function buildEdition(items, { id, from, to, now = Date.parse(to) }) {
  const ranked = items
    .map((i) => ({ i, s: score(i, now) }))
    .sort((a, b) => b.s - a.s || String(a.i.id).localeCompare(String(b.i.id)));

  const top = [];
  let news = 0;
  for (const { i, s } of ranked) {
    if (top.length >= TOP_MAX) break;
    if (i.status !== "summarised") continue;
    if (i.authority === "news" && news >= TOP_MAX_NEWS) continue;
    // Below significance 3 only to make up the minimum. Ranking is by composite
    // score, so later items may still qualify — skip, don't stop.
    if ((i.classification?.significance ?? 0) < 3 && top.length >= TOP_MIN) continue;
    top.push({ id: i.id, score: s });
    if (i.authority === "news") news++;
  }
  const topIds = new Set(top.map((t) => t.id));

  const sections = SECTIONS.map((sec) => {
    const members = ranked.filter(({ i }) => !topIds.has(i.id) && sectionFor(i) === sec.id);
    return {
      id: sec.id,
      title: sec.title,
      items: members.slice(0, SECTION_CAP).map(({ i, s }) => ({ id: i.id, score: s })),
      // Beyond the cap: listed compactly (headline + source) so nothing is hidden.
      more: members.slice(SECTION_CAP).map(({ i, s }) => ({ id: i.id, score: s })),
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
      summarised: items.filter((i) => i.status === "summarised").length,
      headlineOnly: items.filter((i) => i.status === "headline-only").length,
    },
  };
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
