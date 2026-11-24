// Build the Sydney Lambda "collect" event: active sources + ids already stored.
// Usage: node build-collect-event.mjs [--since-days N] [--max-items 60] [--only a,b] > event.json
//
// Default window reaches back to ARCHIVE_START. Feeds only hold their recent
// items, so this costs little, and it means the archive backfills itself:
// anything not yet processed is retried (newest first) on later runs.

import { loadSources, activeSources } from "./lib/sources.js";
import { listItemIds } from "./lib/store.js";
import { ARCHIVE_START } from "./lib/config.js";

const args = process.argv.slice(2);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const sinceDays = Number(val("--since-days") || Math.ceil((Date.now() - Date.parse(`${ARCHIVE_START}T00:00:00Z`)) / 864e5));
const maxItems = Number(val("--max-items") || 60);
const only = val("--only")?.split(",").filter(Boolean);

let sources = activeSources(await loadSources());
if (only?.length) sources = sources.filter((s) => only.includes(s.id));
const knownIds = await listItemIds();

process.stdout.write(JSON.stringify({ action: "collect", sinceDays, maxItems, sources, knownIds }));
console.error(`collect event: ${sources.length} sources, ${knownIds.length} known items, window ${sinceDays}d, max ${maxItems} items`);
