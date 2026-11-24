// Build-time data access: reads ../data (items, editions) and ../sources.yaml.
// Astro runs builds with cwd = site/.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const ROOT = resolve(process.cwd(), "..");
const DATA = join(ROOT, "data");

function walkJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walkJson(p);
    return e.name.endsWith(".json") ? [JSON.parse(readFileSync(p, "utf8"))] : [];
  });
}

let cache;
export function loadAll() {
  if (cache) return cache;
  const items = walkJson(join(DATA, "items"));
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const editions = walkJson(join(DATA, "editions")).sort((a, b) => b.id.localeCompare(a.id));
  const { sources } = parse(readFileSync(join(ROOT, "sources.yaml"), "utf8"));
  const keyDatesFile = join(DATA, "key-dates.yaml");
  const curatedDates = existsSync(keyDatesFile) ? parse(readFileSync(keyDatesFile, "utf8")).dates || [] : [];
  // Which edition each item appeared in (for item pages).
  const editionOf = new Map();
  for (const e of [...editions].reverse()) {
    for (const ref of [...e.topSignals, ...e.sections.flatMap((s) => [...s.items, ...(s.more || [])])]) editionOf.set(ref.id, e.id);
  }
  cache = { items, itemsById, editions, sources, curatedDates, editionOf };
  return cache;
}

export const AUTHORITY_LABEL = {
  official: "Official",
  standards: "Standards",
  lab: "Frontier Lab",
  research: "Research",
  news: "News",
};

const dateFmt = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Sydney" });
export const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : "");

/** "2026-W48" → "Week 48, 2026" */
export const editionLabel = (id) => {
  const [y, w] = id.split("-W");
  return `Week ${Number(w)}, ${y}`;
};

export const THEME_LABEL = {
  "policy-legislation": "Policy & legislation",
  "regulator-guidance": "Regulator guidance",
  "public-sector": "Public sector",
  "standards-frameworks": "Standards & frameworks",
  "frontier-labs": "Frontier labs",
  international: "International",
  "news-commentary": "News & commentary",
};

export const isPublishable = (i) => i.status === "summarised" || i.status === "headline-only";

const todayIso = () => new Date().toISOString().slice(0, 10);

/** Open consultations (grounded closing date in the future) and recent ones without a stated date. */
export function consultations(items, today = todayIso()) {
  const c = items.filter((i) => isPublishable(i) && i.classification?.is_consultation);
  const open = c.filter((i) => i.classification.closing_date && i.classification.closing_date >= today)
    .sort((a, b) => a.classification.closing_date.localeCompare(b.classification.closing_date));
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString();
  const undated = c.filter((i) => !i.classification.closing_date && (i.publishedAt || i.fetchedAt) >= cutoff)
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  const closed = c.filter((i) => i.classification.closing_date && i.classification.closing_date < today)
    .sort((a, b) => b.classification.closing_date.localeCompare(a.classification.closing_date))
    .slice(0, 10);
  return { open, undated, closed };
}

/**
 * Key dates: curated entries plus grounded dates from Official-authority items.
 * Upcoming first; "recently commenced" = within the past 12 months.
 */
export function keyDates(curated, items, today = todayIso()) {
  const fromItems = items
    .filter((i) => i.status === "summarised" && i.authority === "official")
    .flatMap((i) => (i.dates_mentioned || []).map((d) => ({
      date: d.date,
      title: d.what,
      detail: i.headline,
      jurisdiction: i.jurisdiction,
      source: { name: i.sourceName, url: i.url },
      quote: d.quote,
      auto: true,
    })));
  const seen = new Set();
  const all = [...curated.map((d) => ({ ...d, date: String(d.date) })), ...fromItems]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .filter((d) => {
      const k = `${d.date}|${d.title.toLowerCase()}`;
      return seen.has(k) ? false : seen.add(k);
    });
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  return {
    upcoming: all.filter((d) => d.date >= today).sort((a, b) => a.date.localeCompare(b.date)),
    recent: all.filter((d) => d.date < today && d.date >= yearAgo).sort((a, b) => b.date.localeCompare(a.date)),
  };
}

const dayFmt = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
export const fmtDay = (ymd) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));
