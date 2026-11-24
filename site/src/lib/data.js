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
  cache = { items, itemsById, editions, sources };
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
