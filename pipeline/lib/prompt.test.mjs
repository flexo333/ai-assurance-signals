import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnalysis, buildUserPrompt, ANALYSIS_SCHEMA } from "./prompt.js";
import { generateWithFallback, isRetryableModelError } from "./gemini.js";

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
  for (const f of ["quotes", "summary", "why_it_matters", "is_ai_governance"]) assert.ok(ANALYSIS_SCHEMA.required.includes(f));
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
  assert.deepEqual(ok, { ok: true, model: "b", value: { x: 1 } });

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
