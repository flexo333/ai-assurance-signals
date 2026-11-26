// Build-time data access: reads ../data (items, editions) and ../sources.yaml.
// Astro runs builds with cwd = site/.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
// Pure pipeline module: the edition's sections and how items are placed in them.
import { SECTIONS, sectionFor, regulatorySectionFor } from "../../../pipeline/lib/rank.js";

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

/** An edition's entries: Top Signals, then each section's items and overflow. */
export const editionRefs = (e) => [...e.topSignals, ...e.sections.flatMap((s) => [...s.items, ...(s.more || [])])];

/** Number of items an edition places, counting grouped coverage. */
export const editionItemCount = (e) => editionRefs(e).reduce((n, r) => n + 1 + (r.also?.length || 0), 0);

let cache;
export function loadAll() {
  if (cache) return cache;
  const items = walkJson(join(DATA, "items"));
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const editions = walkJson(join(DATA, "editions")).sort((a, b) => b.id.localeCompare(a.id));
  const { sources } = parse(readFileSync(join(ROOT, "sources.yaml"), "utf8"));
  const keyDatesFile = join(DATA, "key-dates.yaml");
  const curatedDates = existsSync(keyDatesFile) ? parse(readFileSync(keyDatesFile, "utf8")).dates || [] : [];
  // Which edition each item appeared in, and story groupings (for item pages).
  const editionOf = new Map();
  const alsoOf = new Map(); // lead id → grouped item ids
  const leadOf = new Map(); // grouped item id → lead id
  for (const e of [...editions].reverse()) {
    for (const ref of editionRefs(e)) {
      editionOf.set(ref.id, e.id);
      if (ref.also?.length) alsoOf.set(ref.id, ref.also);
      for (const id of ref.also || []) {
        editionOf.set(id, e.id);
        leadOf.set(id, ref.id);
      }
    }
  }
  cache = { items, itemsById, editions, sources, curatedDates, editionOf, alsoOf, leadOf };
  return cache;
}

export const AUTHORITY_LABEL = {
  official: "Official",
  standards: "Standards",
  lab: "Frontier Lab",
  research: "Research",
  industry: "Industry",
  news: "News",
  vendor: "Vendor",
};

/** Badge order (highest authority first), for listings such as /sources/. */
export const AUTHORITY_ORDER = ["official", "standards", "lab", "research", "industry", "news", "vendor"];

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
  "financial-services": "Financial services",
  "news-commentary": "News & commentary",
};

export const isPublishable = (i) => i.status === "summarised" || i.status === "headline-only";

// Today's calendar date in Sydney (en-CA formats as YYYY-MM-DD). The daily
// build runs at 19:41 UTC, already the next day in Australia.
const todayIso = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

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
  const yearAgo = todayIso(new Date(Date.now() - 365 * 864e5));
  return {
    upcoming: all.filter((d) => d.date >= today).sort((a, b) => a.date.localeCompare(b.date)),
    recent: all.filter((d) => d.date < today && d.date >= yearAgo).sort((a, b) => b.date.localeCompare(a.date)),
  };
}

// ── Financial Services tracker (#31) ─────────────────────────────────────
// Mirrors pipeline/lib/rank.js isFinancialServices: model flag, FS theme, or a
// source marked `sector: financial-services` in sources.yaml.
export function isFinancialServices(item, sectorOf = new Map()) {
  const c = item.classification || {};
  return c.is_financial_services === true || c.theme === "financial-services" || (item.sector || sectorOf.get(item.sourceId)) === "financial-services";
}

const REGULATOR_KINDS = new Set(["legislation", "regulation", "regulator-guidance", "enforcement", "government-policy", "consultation"]);
const DEPLOYMENT_KINDS = new Set(["deployment", "incident"]);

export const FS_GROUPS = [
  { id: "regulators", title: "Official & policy" },
  { id: "deployments", title: "Institution deployments & case studies" },
  { id: "news", title: "News & commentary" },
];

/** Which tracker group an FS story belongs to (by its lead item). */
export function fsGroupOf(item) {
  const kind = item.classification?.item_kind;
  if (item.authority === "official" || REGULATOR_KINDS.has(kind)) return "regulators";
  if (item.authority === "industry" || item.authority === "vendor" || DEPLOYMENT_KINDS.has(kind)) return "deployments";
  return "news";
}

/**
 * Publishable stories (lead + grouped coverage), newest first, whose items
 * match `pred`. Each matching item resolves to its edition story's lead, and
 * leads are deduplicated, so coverage stays grouped ("Also covered by").
 */
function storiesWhere(pred, { items, alsoOf, leadOf, itemsById }) {
  const leads = new Map();
  for (const i of items) {
    if (!isPublishable(i) || !pred(i)) continue;
    const lead = itemsById.get(leadOf.get(i.id)) || i;
    leads.set(lead.id, lead);
  }
  return [...leads.values()]
    .map((lead) => ({ lead, also: (alsoOf.get(lead.id) || []).map((id) => itemsById.get(id)).filter(Boolean) }))
    .sort((a, b) => String(b.lead.publishedAt || b.lead.fetchedAt).localeCompare(String(a.lead.publishedAt || a.lead.fetchedAt)));
}

const sectorMap = (sources) => new Map((sources || []).filter((s) => s.sector).map((s) => [s.id, s.sector]));

/**
 * Publishable FS stories, newest first. A story is shown if ANY of its items
 * is FS: each FS item resolves to its edition story's lead (which may itself
 * lack an FS marker, e.g. a grounded news report analysed before prompt v3
 * leading a headline-only APRA item), and leads are deduplicated. Coverage
 * stays grouped under the lead ("Also covered by").
 */
export function financialServicesStories(data) {
  const sectorOf = sectorMap(data.sources);
  return storiesWhere((i) => isFinancialServices(i, sectorOf), data)
    // Regulation comes first (#48): official regulatory stories (APRA, ASIC
    // guidance) live in their regulatory section, not here.
    .filter((s) => !regulatorySectionFor(s.lead))
    .map((s) => ({ ...s, group: fsGroupOf(s.lead) }));
}

// ── Sections (#46) ───────────────────────────────────────────────────────
// The edition's sections (pipeline/lib/rank.js), each with its own page.
// Financial Services keeps its tracker page at /financial-services/.
export { SECTIONS };

export const SECTION_DESCRIPTION = {
  "policy-legislation": "Australian Government AI policy, legislation, parliamentary inquiries and consultations.",
  "regulator-guidance": "Guidance, expectations and enforcement from Australian regulators on the use of AI.",
  "public-sector": "How Australian governments and agencies adopt, govern and assure AI.",
  "standards-frameworks": "AI standards, management systems, assurance frameworks and safety evaluations.",
  "frontier-labs": "Safety, policy and governance publications from frontier AI developers.",
  international: "AI law, policy and regulation outside Australia.",
  "financial-services": "AI in Australian banking, superannuation, insurance and payments.",
  "news-commentary": "Reporting and analysis from news outlets, and vendor case studies.",
};

export const sectionHref = (id) => (id === "financial-services" ? "/financial-services/" : `/sections/${id}/`);

/**
 * The section an item belongs to: the edition's placement rule (regulation
 * first, #48), with the site's fuller FS check (it also reads the source's
 * sector from sources.yaml).
 */
export const sectionOf = (item, sectorOf = new Map()) =>
  regulatorySectionFor(item) ?? (isFinancialServices(item, sectorOf) ? "financial-services" : sectionFor(item));

/**
 * Publishable stories in a section, newest first. A story is placed by its
 * lead item (as editions place it), so Top Signals and this week's
 * not-yet-published items appear too.
 */
export function sectionStories(sectionId, data) {
  const sectorOf = sectorMap(data.sources);
  const isLead = (i) => !data.leadOf.has(i.id);
  return storiesWhere((i) => isLead(i) && sectionOf(i, sectorOf) === sectionId, data);
}

const dayFmt = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
export const fmtDay = (ymd) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));
