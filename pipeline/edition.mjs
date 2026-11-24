// Build editions: data/editions/<YYYY-Www>.json.
//
// Current edition: window (previous edition's cutoff, now]. Items are bucketed
// by publish date, with a 7-day grace for late arrivals (see selectWindow).
// Re-running in the same ISO week rebuilds that week with the same start.
//
// --backfill: first (re)build "backfilled" editions for every past weekly
// cutoff since ARCHIVE_START, by publish date, without an intro. Existing
// backfilled editions are rebuilt (the archive fills in as the collector's
// backfill drains); regular editions are never touched. Weeks with nothing
// to show are skipped.
//
// Usage: node edition.mjs [--now ISO] [--from ISO] [--no-intro] [--backfill]
// GEMINI_API_KEY enables the current edition's intro (dropped if it fails the
// citation/number check).

import { readdir, readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { loadItems, DATA_DIR } from "./lib/store.js";
import { buildEdition, selectWindow, isoWeekId, weeklyCutoffs } from "./lib/rank.js";
import { INTRO_PROMPT, buildIntroInput, checkIntro } from "./lib/intro.js";
import { generateWithFallback } from "./lib/gemini.js";
import { ARCHIVE_START } from "./lib/config.js";

const EDITIONS_DIR = join(DATA_DIR, "editions");
const args = process.argv.slice(2);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const now = val("--now") ? new Date(val("--now")) : new Date();
const currentId = isoWeekId(now);
const report = [];

async function readEditions() {
  try {
    const files = (await readdir(EDITIONS_DIR)).filter((f) => f.endsWith(".json")).sort();
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(EDITIONS_DIR, f), "utf8"))));
  } catch {
    return [];
  }
}

const idsIn = (e) => [...e.topSignals, ...e.sections.flatMap((s) => [...s.items, ...(s.more || [])])].map((r) => r.id);

async function save(edition) {
  await mkdir(EDITIONS_DIR, { recursive: true });
  await writeFile(join(EDITIONS_DIR, `${edition.id}.json`), JSON.stringify(edition, null, 2) + "\n");
}

const all = await loadItems();
const byId = new Map(all.map((i) => [i.id, i]));
let editions = await readEditions();

// ── Backfill past weeks ────────────────────────────────────────────────────
if (args.includes("--backfill")) {
  const regular = editions.filter((e) => !e.backfilled);
  const regularIds = new Set(regular.map((e) => e.id));
  const placedInRegular = new Set(regular.flatMap(idsIn));
  let built = 0;
  for (const to of weeklyCutoffs(ARCHIVE_START, now.toISOString())) {
    const id = isoWeekId(new Date(to));
    if (id === currentId || regularIds.has(id)) continue;
    const from = new Date(Date.parse(to) - 7 * 864e5).toISOString();
    const candidates = selectWindow(all, { from, to, mode: "backfill", exclude: placedInRegular });
    if (!candidates.length) continue;
    const e = buildEdition(candidates, { id, from, to, now: Date.parse(to) });
    e.publishedAt = to;
    e.backfilled = true;
    await save(e);
    built++;
  }
  report.push(`Backfilled editions (re)built: ${built}`);
  editions = await readEditions();
}

// ── Current edition ────────────────────────────────────────────────────────
const sameWeek = editions.find((e) => e.id === currentId);
const prior = editions.filter((e) => e.id < currentId).at(-1);
const from = val("--from") || (sameWeek && !sameWeek.backfilled ? sameWeek.window.from : null) || prior?.window.to || new Date(now - 7 * 864e5).toISOString();
const to = now.toISOString();
const exclude = new Set(editions.filter((e) => e.id !== currentId).flatMap(idsIn));
const candidates = selectWindow(all, { from, to, exclude });
const edition = buildEdition(candidates, { id: currentId, from, to, now: now.getTime() });
edition.publishedAt = to;

let introNote = "skipped";
if (!args.includes("--no-intro") && process.env.GEMINI_API_KEY && edition.topSignals.length >= 2) {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const topItems = edition.topSignals.map((t) => byId.get(t.id));
  const res = await generateWithFallback(ai, { contents: `${INTRO_PROMPT}\n\n${buildIntroInput(topItems)}`, config: { temperature: 0.3 } });
  if (res.ok) {
    const check = checkIntro(res.value, topItems);
    if (check.ok) {
      edition.intro = { sentences: check.sentences, model: res.model };
      introNote = `ok (${res.model})`;
    } else introNote = `rejected: ${check.reason}`;
  } else introNote = `model failed: ${res.error?.message || res.error}`;
}
await save(edition);

const md = [
  `### Edition ${currentId}`,
  "",
  ...report,
  `Window ${from.slice(0, 16)}Z → ${to.slice(0, 16)}Z · ${edition.counts.candidates} candidates (${edition.counts.summarised} summarised, ${edition.counts.headlineOnly} headline-only)`,
  `Top Signals: ${edition.topSignals.length} · sections: ${edition.sections.map((s) => `${s.title} (${s.items.length}${s.overflow ? `+${s.overflow}` : ""})`).join(", ") || "none"}`,
  `Intro: ${introNote}`,
].join("\n");
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
