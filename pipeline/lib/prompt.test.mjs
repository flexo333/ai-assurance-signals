import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnalysis, buildUserPrompt, ANALYSIS_SCHEMA } from "./prompt.js";
import { generateWithFallback, isRetryableModelError, orderModels, ModelHealth, Pacer, rpmFor } from "./gemini.js";

test("parseAnalysis normalises and clamps", () => {
  const a = parseAnalysis(
    JSON.stringify({
      is_ai_governance: true,
      headline: " OAIC guidance ",
      summary: "S",
      why_it_matters: "W",
      quotes: [{ text: " q ", supports: "why_it_matters" }, { text: "r", supports: "bogus" }],
      theme: "nonsense",
      audiences: ["boards", "aliens"],
      au_relevance: 9,
      significance: "4",
      is_consultation: true,
      closing_date: "31 Jan 2027",
      dates_mentioned: [{ date: "2026-12-10", what: "ADM transparency commences" }, { date: "", what: "x" }],
    }),
  );
  assert.equal(a.headline, "OAIC guidance");
  assert.deepEqual(a.quotes, [{ text: "q", supports: "why_it_matters" }, { text: "r", supports: "summary" }]);
  assert.equal(a.theme, "news-commentary");
  assert.equal(a.item_kind, "other"); // missing/unknown kind → "other"
  assert.deepEqual(a.audiences, ["boards"]);
  assert.equal(a.au_relevance, 3);
  assert.equal(a.significance, 4);
  assert.equal(a.closing_date, null); // not ISO → dropped, never guessed
  assert.equal(a.dates_mentioned.length, 1);
});

test("parseAnalysis rejects malformed payloads", () => {
  assert.equal(parseAnalysis("not json"), null);
  assert.equal(parseAnalysis("{}"), null);
});

test("schema requires grounding fields", () => {
  for (const f of ["quotes", "summary", "why_it_matters", "is_ai_governance", "item_kind"]) assert.ok(ANALYSIS_SCHEMA.required.includes(f));
});

test("buildUserPrompt fences the source text", () => {
  const p = buildUserPrompt({ source: { name: "OAIC", authority: "official", jurisdiction: "AU-federal" }, item: { title: "T", url: "u", text: "BODY" } });
  assert.match(p, /SOURCE TEXT START ---\nBODY\n--- SOURCE TEXT END/);
});

test("generateWithFallback advances on 404, reports quota exhaustion", async () => {
  const calls = [];
  const ai = (behaviour) => ({
    models: {
      generateContent: async ({ model }) => {
        calls.push(model);
        return behaviour(model);
      },
    },
  });
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const quota = Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 });

  const ok = await generateWithFallback(
    ai((m) => {
      if (m === "a") throw notFound;
      return { text: '{"x":1}' };
    }),
    { chain: ["a", "b"], attempts: 1, parse: JSON.parse },
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.model, "b");
  assert.deepEqual(ok.value, { x: 1 });
  assert.equal(ok.attempts, 2);
  assert.deepEqual(ok.errors.map((e) => [e.model, e.status]), [["a", 404]]);

  const exhausted = await generateWithFallback(
    ai(() => {
      throw quota;
    }),
    { chain: ["a", "b"], attempts: 1 },
  );
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.quotaExhausted, true);
  assert.equal(isRetryableModelError(notFound), false);
});

test("orderModels: Flash Lite first (newest), then Flash; zero-quota families excluded", () => {
  const raw = [
    "models/gemini-2.5-flash", "models/gemini-3.8-flash", "models/gemini-3.6-flash", "models/gemini-3-flash",
    "models/gemini-3.5-flash-lite", "models/gemini-3.1-flash-lite", "models/gemini-flash-lite-latest", "models/gemini-flash-latest",
    "models/gemini-omni-1.2-flash", "models/gemini-omni-flash-preview", "models/gemini-3.8-flash-tts",
    "models/gemini-robotics-er-2-flash-preview", "models/gemini-3.1-flash-image", "models/gemini-3.9-flash-preview",
  ].map((name) => ({ name, supportedActions: ["generateContent"] }));
  assert.deepEqual(orderModels(raw), [
    "models/gemini-3.5-flash-lite", "models/gemini-3.1-flash-lite", "models/gemini-flash-lite-latest",
    "models/gemini-3.8-flash", "models/gemini-3.6-flash", "models/gemini-3-flash", "models/gemini-2.5-flash",
    "models/gemini-flash-latest", "models/gemini-3.9-flash-preview",
  ]);
  assert.deepEqual(orderModels([]), []);
});

test("Pacer spaces calls per model at its free-tier RPM", async () => {
  let t = 0;
  const slept = [];
  const p = new Pacer({ now: () => t, sleepFn: async (ms) => { slept.push(ms); t += ms; }, headroom: 1 });
  await p.wait("models/gemini-3.5-flash-lite"); // first call: no wait
  await p.wait("models/gemini-3.5-flash-lite"); // 15 RPM → 4000 ms
  await p.wait("models/gemini-3.8-flash"); // different model: no wait
  t += 1000;
  await p.wait("models/gemini-3.8-flash"); // 5 RPM → 12000 ms, 1000 already elapsed
  assert.deepEqual(slept, [4000, 11000]);
  assert.equal(rpmFor("models/gemini-3.1-flash-lite"), 15);
  assert.equal(rpmFor("models/gemini-2.5-flash"), 5);
});

test("ModelHealth: 404 dead, 429 exhausted, 503 cools down then recovers", () => {
  let t = 0;
  const h = new ModelHealth({ cooldownMs: 1000, now: () => t });
  const chain = ["a", "b", "c", "d"];
  h.record([
    { model: "a", status: 429, message: "You exceeded your current quota" },
    { model: "b", status: 503, message: "high demand" },
    { model: "c", status: 404, message: "This model is no longer available" },
  ]);
  assert.deepEqual(h.available(chain), ["d"]);
  h.record([{ model: "d", status: 429, message: "quota" }]);
  assert.deepEqual(h.available(chain), []);
  assert.equal(h.nextRecoveryMs(chain), 1000);
  t = 1001;
  assert.deepEqual(h.available(chain), ["b"]);
  h.record([{ model: "b", status: 429, message: "quota" }]);
  assert.equal(h.nextRecoveryMs(chain), null); // nothing can recover this run → stop
});
