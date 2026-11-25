// Build the Sydney Lambda "collect" event: active sources + ids already stored.
// Usage: node build-collect-event.mjs [--since-days N] [--max-items 60] [--only a,b] [--recheck N] > event.json
//
// Seeds (#31): unknown URLs from data/seed-urls.yaml (validated against the
// allow-list), plus up to --recheck N stored "irrelevant" items analysed under
// an older PROMPT_VERSION, re-fetched and re-analysed under the current one.
//
// Default window reaches back to ARCHIVE_START. Feeds only hold their recent
// items, so this costs little, and it means the archive backfills itself:
// anything not yet processed is retried (newest first) on later runs.

import { loadSources, activeSources } from "./lib/sources.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { listItemIds, loadItems, loadSeen, DATA_DIR } from "./lib/store.js";
import { planSeeds, pickRechecks } from "./lib/seeds.js";
import { PROMPT_VERSION } from "./lib/prompt.js";
import { ARCHIVE_START } from "./lib/config.js";

const args = process.argv.slice(2);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const sinceDays = Number(val("--since-days") || Math.ceil((Date.now() - Date.parse(`${ARCHIVE_START}T00:00:00Z`)) / 864e5));
const maxItems = Number(val("--max-items") || 60);
const only = val("--only")?.split(",").filter(Boolean);
const recheck = Number(val("--recheck") || 0);

const allSources = await loadSources();
let sources = activeSources(allSources);
if (only?.length) sources = sources.filter((s) => only.includes(s.id));
// Known = stored items plus sitemap pages already checked and rejected.
const storedIds = await listItemIds();
const knownIds = [...new Set([...storedIds, ...Object.keys(await loadSeen())])];

let seedEntries = [];
try {
  seedEntries = parse(await readFile(join(DATA_DIR, "seed-urls.yaml"), "utf8"))?.seeds || [];
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const inScope = (sd) => !only?.length || only.includes(sd.sourceId);
// Seeds skip only STORED items: a page an adapter rejected earlier (data/seen)
// is exactly what a curated seed exists to bring in.
const { seeds, rejected } = planSeeds(seedEntries, allSources, new Set(storedIds));
for (const r of rejected) console.error(`seed rejected: ${r.url} (${r.reason})`);
const rechecks = recheck ? pickRechecks(await loadItems(), sources, { limit: recheck, promptVersion: PROMPT_VERSION }) : [];
const allSeeds = [...seeds, ...rechecks].filter(inScope);

process.stdout.write(JSON.stringify({ action: "collect", sinceDays, maxItems, sources, knownIds, seeds: allSeeds }));
console.error(`collect event: ${sources.length} sources, ${knownIds.length} known items, window ${sinceDays}d, max ${maxItems} items, ${seeds.length} seed URLs, ${rechecks.length} re-checks`);
