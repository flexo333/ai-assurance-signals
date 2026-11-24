// Processor — runs in Actions after the Sydney Lambda's "collect".
// For each collected item: one Gemini call (classify + summarise), then the
// grounding gate. Writes data/items/YYYY/MM/<id>.json.
//
//   status "summarised"    grounded summary, publishable
//   status "headline-only" relevant, but the summary failed grounding twice —
//                          only title/link/badge are ever shown
//   status "irrelevant"    not AI governance (stored so it isn't re-fetched)
//
// Items not processed this run (quota/limit) are NOT written; they stay
// unknown and are collected again tomorrow while still in the window.
//
// Usage: node process.mjs collected.json [--max 60] [--delay-ms 6500] [--dry-run]
// Needs GEMINI_API_KEY.

import { readFile, appendFile } from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import { loadSources } from "./lib/sources.js";
import { saveItem } from "./lib/store.js";
import { sleep, MODEL_CHAIN } from "./lib/gemini.js";
import { analyseItem } from "./lib/analyse-item.js";

const args = process.argv.slice(2);
const val = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const flagValues = new Set(["--max", "--delay-ms"].map((f) => val(f)).filter(Boolean));
const inputPath = args.find((a) => !a.startsWith("--") && !flagValues.has(a));
const MAX = Number(val("--max", 60));
const DELAY_MS = Number(val("--delay-ms", 6500)); // ~9 RPM: under the Flash free-tier limit
const DRY = args.includes("--dry-run");

if (!inputPath) throw new Error("usage: node process.mjs collected.json");
if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

const collected = JSON.parse(await readFile(inputPath, "utf8"));
const sources = new Map((await loadSources()).map((s) => [s.id, s]));
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const stats = { collected: collected.items.length, summarised: 0, headlineOnly: 0, irrelevant: 0, skipped: 0, failed: 0, calls: 0 };
let quotaHit = false;
const modelErrorCounts = new Map();
// Models that returned 503/429 this run are skipped for the rest of it.
const unhealthy = new Set();
const chainNow = () => {
  const healthy = MODEL_CHAIN.filter((m) => !unhealthy.has(m));
  return healthy.length ? healthy : MODEL_CHAIN;
};

for (const item of collected.items) {
  if (stats.calls >= MAX || quotaHit) {
    stats.skipped++;
    continue;
  }
  const source = sources.get(item.sourceId);
  if (!source) {
    stats.failed++;
    continue;
  }
  if (stats.calls > 0) await sleep(DELAY_MS);
  const res = await analyseItem(ai, { source, item, delayMs: DELAY_MS, budget: MAX - stats.calls, chain: chainNow() });
  stats.calls += res.calls;
  for (const e of res.modelErrors || []) {
    if (e.status === 503 || e.status === 429) unhealthy.add(e.model);
    const key = `${e.model} ${e.status ?? ""} ${e.message.slice(0, 80)}`;
    modelErrorCounts.set(key, (modelErrorCounts.get(key) || 0) + 1);
  }
  if (!res.record) {
    if (res.quotaExhausted) quotaHit = true;
    if (stats.calls >= MAX) {
      stats.skipped++; // budget reached mid-item: retried next run
      continue;
    }
    stats.failed++;
    console.error(`✗ ${item.sourceId} ${item.title}: ${res.error?.message || res.error}`);
    continue;
  }
  const r = res.record;
  if (r.status === "summarised") stats.summarised++;
  else if (r.status === "headline-only") stats.headlineOnly++;
  else stats.irrelevant++;
  if (!DRY) await saveItem(r);
  else if (r.status !== "irrelevant") {
    // Dry runs print what would be stored, for review in the job log.
    const { id, sourceId, status, headline, title, summary, why_it_matters, quotes, classification, dates_mentioned, reason, grounding, provenance } = r;
    console.log(JSON.stringify({ id, sourceId, status, headline: headline || title, summary, why_it_matters, quotes, classification, dates_mentioned, reason, grounding, model: provenance?.model, attempts: provenance?.attempts }, null, 2));
  }
  if (r.status !== "irrelevant") console.log(`${r.status === "summarised" ? "✓" : "◐"} [${r.classification?.significance ?? "-"}] ${r.sourceId}: ${r.headline || r.title}`);
}

const summary = [
  `### Collect + process${DRY ? " (dry run)" : ""}`,
  "",
  `Fetched from **${collected.location}** · window since ${collected.since?.slice(0, 10)} · deferred by size cap: ${collected.deferred ?? 0}`,
  "",
  "| collected | summarised (grounded) | headline-only | irrelevant | not processed (cap/quota) | failed | Gemini calls |",
  "|---|---|---|---|---|---|---|",
  `| ${stats.collected} | ${stats.summarised} | ${stats.headlineOnly} | ${stats.irrelevant} | ${stats.skipped} | ${stats.failed} | ${stats.calls} |`,
  "",
  quotaHit ? "⚠️ Gemini quota exhausted on every model — remaining items will be retried next run." : "",
  modelErrorCounts.size ? ["**Model errors (count · model status message):**", "", ...[...modelErrorCounts].map(([k, n]) => `- ${n} × ${k}`), ""].join("\n") : "",
  "<details><summary>Per-source collection log</summary>",
  "",
  "| source | status | feed items | in window | keyword-dropped | collected | skipped known/old/bad-url | first item (date · link) |",
  "|---|---|---|---|---|---|---|---|",
  ...(collected.sources || []).map((s) => `| ${s.id} | ${s.status} | ${s.feedItems} | ${s.inWindow} | ${s.keywordDropped} | ${s.collected} | ${s.skipped ? `${s.skipped.known}/${s.skipped.old}/${s.skipped.badUrl}` : ""} | ${s.sample ? `${s.sample.date ?? "undated"} · ${String(s.sample.link).slice(0, 70)}` : ""} |`),
  "",
  "</details>",
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
