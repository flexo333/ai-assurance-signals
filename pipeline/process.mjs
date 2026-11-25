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
import { saveItem, saveSeen, loadItems } from "./lib/store.js";
import { PROMPT_VERSION } from "./lib/prompt.js";
import { sleep, resolveModelChain, ModelHealth, Pacer } from "./lib/gemini.js";
import { analyseItem } from "./lib/analyse-item.js";

const args = process.argv.slice(2);
const val = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const flagValues = new Set(["--max", "--delay-ms"].map((f) => val(f)).filter(Boolean));
const inputPath = args.find((a) => !a.startsWith("--") && !flagValues.has(a));
const MAX = Number(val("--max", 120));
const DELAY_MS = Number(val("--delay-ms", 0)); // extra spacing; per-model RPM pacing is automatic (Pacer)
const DRY = args.includes("--dry-run");

if (!inputPath) throw new Error("usage: node process.mjs collected.json");
if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

const collected = JSON.parse(await readFile(inputPath, "utf8"));
const sources = new Map((await loadSources()).map((s) => [s.id, s]));
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const stats = { collected: collected.items.length, summarised: 0, headlineOnly: 0, irrelevant: 0, unvetted: 0, skipped: 0, failed: 0, calls: 0 };
let quotaHit = false;
const modelErrorCounts = new Map();
// Live chain discovered from the API; per-run health drops retired (404) and
// quota-exhausted (429) models and cools down overloaded (503) ones.
const chain = await resolveModelChain(ai);
const health = new ModelHealth();
const pacer = new Pacer();
console.log(`Model chain: ${chain.join(", ")}`);

// Available models now, waiting out a 503 cooldown if that's all that's left.
// Returns [] when nothing can recover this run (all dead/exhausted).
async function modelsNow() {
  let avail = health.available(chain);
  if (avail.length) return avail;
  const wait = health.nextRecoveryMs(chain);
  if (wait == null) return [];
  await sleep(Math.min(wait, 180_000));
  return health.available(chain);
}

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
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    const avail = await modelsNow();
    if (!avail.length) {
      quotaHit = true;
      break;
    }
    if (stats.calls > 0 && DELAY_MS) await sleep(DELAY_MS);
    res = await analyseItem(ai, { source, item, delayMs: DELAY_MS, budget: MAX - stats.calls, chain: avail, beforeCall: (m) => pacer.wait(m) });
    stats.calls += res.calls;
    health.record(res.modelErrors);
    for (const e of res.modelErrors || []) {
      const key = `${e.model} ${e.status ?? ""} ${e.message.slice(0, 80)}`;
      modelErrorCounts.set(key, (modelErrorCounts.get(key) || 0) + 1);
    }
    // Retry once only when the failure was the models' (quota/overload/retired), not the item's.
    if (res.record || !res.modelErrors?.length || stats.calls >= MAX) break;
  }
  if (!res?.record) {
    if (quotaHit || stats.calls >= MAX) {
      stats.skipped++; // retried next run (item stays unknown)
      continue;
    }
    stats.failed++;
    console.error(`✗ ${item.sourceId} ${item.title}: ${res?.error?.message || res?.error}`);
    continue;
  }
  const r = res.record;
  if (r.status === "summarised") stats.summarised++;
  else if (r.status === "headline-only") stats.headlineOnly++;
  else if (r.status === "unvetted") stats.unvetted++;
  else stats.irrelevant++;
  if (!DRY) await saveItem(r);
  else if (r.status !== "irrelevant") {
    // Dry runs print what would be stored, for review in the job log.
    const { id, sourceId, status, headline, title, summary, why_it_matters, quotes, classification, dates_mentioned, reason, grounding, provenance } = r;
    console.log(JSON.stringify({ id, sourceId, status, headline: headline || title, summary, why_it_matters, quotes, classification, dates_mentioned, reason, grounding, model: provenance?.model, attempts: provenance?.attempts }, null, 2));
  }
  if (r.status !== "irrelevant") console.log(`${r.status === "summarised" ? "✓" : "◐"} [${r.classification?.significance ?? "-"}] ${r.sourceId}: ${r.headline || r.title}`);
}

// Re-checks (#31) whose page couldn't be fetched: mark them so the paced
// re-check moves on. The stored record is otherwise unchanged.
const recheckFailed = new Set(collected.seeds?.recheckFailed || []);
if (!DRY && recheckFailed.size) {
  for (const i of await loadItems()) if (recheckFailed.has(i.id)) await saveItem({ ...i, recheck: { promptVersion: PROMPT_VERSION, failedAt: new Date().toISOString() } });
}

let seenTotal = null;
if (!DRY && collected.dropped?.length) seenTotal = await saveSeen(collected.dropped);

const summary = [
  `### Collect + process${DRY ? " (dry run)" : ""}`,
  "",
  `Fetched from **${collected.location}** · window since ${collected.since?.slice(0, 10)} · deferred by size cap: ${collected.deferred ?? 0}`,
  "",
  "| collected | summarised (grounded) | headline-only | irrelevant | unvetted (no text) | not processed (cap/quota) | failed | Gemini calls |",
  "|---|---|---|---|---|---|---|---|",
  `| ${stats.collected} | ${stats.summarised} | ${stats.headlineOnly} | ${stats.irrelevant} | ${stats.unvetted} | ${stats.skipped} | ${stats.failed} | ${stats.calls} |`,
  "",
  quotaHit ? "⚠️ No usable Gemini model left this run (quota exhausted / retired) — remaining items will be retried next run." : "",
  `Model chain: ${chain.join(", ")}`,
  collected.seeds?.requested ? `Seed URLs / re-checks: ${collected.seeds.fetched} of ${collected.seeds.requested} fetched${recheckFailed.size ? ` · ${recheckFailed.size} re-check pages unavailable (marked)` : ""}` : "",
  collected.dropped?.length ? `Sitemap pages checked and set aside (not AI / out of window): ${collected.dropped.length}${seenTotal != null ? ` · seen list now ${seenTotal}` : ""}` : "",
  modelErrorCounts.size ? ["**Model errors (count · model status message):**", "", ...[...modelErrorCounts].map(([k, n]) => `- ${n} × ${k}`), ""].join("\n") : "",
  "<details><summary>Per-source collection log</summary>",
  "",
  "| source | status | feed items | in window | keyword-dropped | collected | skipped known/old/bad-url | first item (date · link) |",
  "|---|---|---|---|---|---|---|---|",
  ...(collected.sources || []).map((s) => `| ${s.id} | ${s.status} | ${s.feedItems} | ${s.inWindow} | ${s.keywordDropped} | ${s.collected} | ${s.skipped ? `${s.skipped.known}/${s.skipped.old}/${s.skipped.badUrl}${s.skipped.undated ? ` (+${s.skipped.undated} undated)` : ""}` : ""} | ${s.sample ? `${s.sample.date ?? "undated"} · ${String(s.sample.link).slice(0, 70)}` : ""} |`),
  "",
  "</details>",
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
