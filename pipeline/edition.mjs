// Build this week's edition: data/editions/<YYYY-Www>.json.
//
// Window: (previous edition's window.to, now]. The first edition, or one run
// with --from, takes an explicit start. Re-running in the same ISO week
// rebuilds that week's edition with the same start.
//
// Usage: node edition.mjs [--now ISO] [--from ISO] [--no-intro]
// GEMINI_API_KEY enables the "This week" intro (skipped if missing or if it
// fails the citation/number check).

import { readdir, readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { loadItems, DATA_DIR } from "./lib/store.js";
import { buildEdition, selectWindow, isoWeekId } from "./lib/rank.js";
import { INTRO_PROMPT, buildIntroInput, checkIntro } from "./lib/intro.js";
import { generateWithFallback } from "./lib/gemini.js";

const EDITIONS_DIR = join(DATA_DIR, "editions");
const args = process.argv.slice(2);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const now = val("--now") ? new Date(val("--now")) : new Date();
const id = isoWeekId(now);

async function previousEditions() {
  try {
    const files = (await readdir(EDITIONS_DIR)).filter((f) => f.endsWith(".json")).sort();
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(EDITIONS_DIR, f), "utf8"))));
  } catch {
    return [];
  }
}

const editions = await previousEditions();
const sameWeek = editions.find((e) => e.id === id);
const prior = editions.filter((e) => e.id < id).at(-1);
const from = val("--from") || sameWeek?.window.from || prior?.window.to || new Date(now - 7 * 864e5).toISOString();
const to = now.toISOString();

const all = await loadItems();
const byId = new Map(all.map((i) => [i.id, i]));
const candidates = selectWindow(all, { from, to });
const edition = buildEdition(candidates, { id, from, to, now: now.getTime() });
edition.publishedAt = to;

let introNote = "skipped";
if (!args.includes("--no-intro") && process.env.GEMINI_API_KEY && edition.topSignals.length >= 2) {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const topItems = edition.topSignals.map((t) => byId.get(t.id));
  const res = await generateWithFallback(ai, {
    contents: `${INTRO_PROMPT}\n\n${buildIntroInput(topItems)}`,
    config: { temperature: 0.3 },
  });
  if (res.ok) {
    const check = checkIntro(res.value, topItems);
    if (check.ok) {
      edition.intro = { sentences: check.sentences, model: res.model };
      introNote = `ok (${res.model})`;
    } else {
      introNote = `rejected: ${check.reason}`;
    }
  } else {
    introNote = `model failed: ${res.error?.message || res.error}`;
  }
}

await mkdir(EDITIONS_DIR, { recursive: true });
const path = join(EDITIONS_DIR, `${id}.json`);
await writeFile(path, JSON.stringify(edition, null, 2) + "\n");

const md = [
  `### Edition ${id}`,
  "",
  `Window ${from.slice(0, 16)}Z → ${to.slice(0, 16)}Z · ${edition.counts.candidates} candidates (${edition.counts.summarised} summarised, ${edition.counts.headlineOnly} headline-only)`,
  `Top Signals: ${edition.topSignals.length} · sections: ${edition.sections.map((s) => `${s.title} (${s.items.length}${s.overflow ? `+${s.overflow}` : ""})`).join(", ") || "none"}`,
  `Intro: ${introNote}`,
].join("\n");
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
