// Build the Sydney Lambda "collect" event: active sources + ids already stored.
// Usage: node build-collect-event.mjs [--since-days 8] [--only a,b] > event.json

import { loadSources, activeSources } from "./lib/sources.js";
import { listItemIds } from "./lib/store.js";

const args = process.argv.slice(2);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const sinceDays = Number(val("--since-days") || 8);
const only = val("--only")?.split(",").filter(Boolean);

let sources = activeSources(await loadSources());
if (only?.length) sources = sources.filter((s) => only.includes(s.id));
const knownIds = await listItemIds();

process.stdout.write(JSON.stringify({ action: "collect", sinceDays, sources, knownIds }));
console.error(`collect event: ${sources.length} sources, ${knownIds.length} known items, window ${sinceDays}d`);
