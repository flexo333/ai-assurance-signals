import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseItem } from "./analyse-item.js";

const TEXT = "APRA has written to all regulated entities setting out its expectations for the use of artificial intelligence. Boards remain accountable for AI risk and must ensure appropriate oversight of models used in decision-making.";
const source = { name: "APRA", authority: "official", jurisdiction: "AU-federal" };
const item = { id: "abc", sourceId: "apra", url: "https://apra.gov.au/x", title: "AI letter", publishedAt: "2026-11-20T00:00:00Z", text: TEXT, textSha256: "h", textSource: "article" };

const reply = (o) => ({ text: JSON.stringify({ is_ai_governance: true, headline: "APRA sets AI expectations", summary: "S", why_it_matters: "W", theme: "regulator-guidance", audiences: ["boards"], au_relevance: 3, significance: 4, is_consultation: false, closing_date: "2027-01-31", dates_mentioned: [], ...o }) });
const fakeAi = (replies) => {
  let i = 0;
  return { calls: () => i, models: { generateContent: async () => replies[Math.min(i++, replies.length - 1)] } };
};
const GOOD = [
  { text: "setting out its expectations for the use of artificial intelligence", supports: "summary" },
  { text: "Boards remain accountable for AI risk and must ensure appropriate oversight", supports: "why_it_matters" },
];
const BAD = [{ text: "APRA has banned the use of AI by banks entirely", supports: "summary" }];

test("grounded first time → summarised with quotes and provenance", async () => {
  const ai = fakeAi([reply({ quotes: GOOD })]);
  const r = await analyseItem(ai, { source, item, chain: ["m"] });
  assert.equal(r.record.status, "summarised");
  assert.equal(r.calls, 1);
  assert.equal(r.record.quotes.length, 2);
  assert.equal(r.record.provenance.model, "m");
  assert.equal(r.record.classification.significance, 4);
});

test("ungrounded, then grounded on retry → summarised after 2 calls", async () => {
  const ai = fakeAi([reply({ quotes: BAD }), reply({ quotes: GOOD })]);
  const r = await analyseItem(ai, { source, item, chain: ["m"] });
  assert.equal(r.record.status, "summarised");
  assert.equal(r.calls, 2);
  assert.equal(r.record.provenance.attempts, 2);
});

test("ungrounded twice → headline-only with NO generated text or dates kept", async () => {
  const ai = fakeAi([reply({ quotes: BAD, summary: "Fabricated claim" })]);
  const r = await analyseItem(ai, { source, item, chain: ["m"] });
  assert.equal(r.record.status, "headline-only");
  assert.equal(r.record.reason, "grounding-failed");
  const json = JSON.stringify(r.record);
  assert.ok(!json.includes("Fabricated claim"));
  assert.ok(!json.includes("banned"));
  assert.equal(r.record.classification.closing_date, null);
  assert.equal(r.record.summary, undefined);
});

test("irrelevant and empty-text items", async () => {
  const irrelevant = await analyseItem(fakeAi([{ text: JSON.stringify({ is_ai_governance: false, headline: "", summary: "", why_it_matters: "", quotes: [], theme: "news-commentary", audiences: [], au_relevance: 0, significance: 1, is_consultation: false }) }]), { source, item, chain: ["m"] });
  assert.equal(irrelevant.record.status, "irrelevant");
  const empty = await analyseItem(fakeAi([]), { source, item: { ...item, text: "" }, chain: ["m"] });
  assert.equal(empty.record.status, "headline-only");
  assert.equal(empty.calls, 0);
});

test("model failure → no record (retried next run), quota flag propagated", async () => {
  const ai = { models: { generateContent: async () => { throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 }); } } };
  const r = await analyseItem(ai, { source, item, chain: ["m"] });
  assert.equal(r.record, null);
  assert.equal(r.quotaExhausted, true);
});
