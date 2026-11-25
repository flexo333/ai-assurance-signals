import { test } from "node:test";
import assert from "node:assert/strict";
import { tokens, titleTokens, jaccard, sameStory, compareLead, clusterItems, coverageBoost, stem } from "./cluster.js";

const mk = (id, o = {}) => ({
  id,
  sourceId: `src-${id}`,
  status: "summarised",
  authority: "news",
  publishedAt: "2026-11-24T00:00:00Z",
  title: "",
  headline: "",
  summary: "",
  classification: { significance: 3 },
  ...o,
});

// Abridged from Week 48: the joint select committee report, covered by two outlets.
const mandarin = mk("mandarin", {
  title: "AI frontier labs in Australia should get independent evaluation, auditing",
  headline: "Parliamentary committee recommends independent audits for Australian AI frontier labs",
  summary:
    "A new report by parliament's joint select committee on AI proposes that frontier labs based in Australia should face mandatory incident reporting and independent audits. The 46 recommendations also include making locally based AI infrastructure subject to nationally consistent requirements.",
  publishedAt: "2026-11-24T19:04:35Z",
  classification: { significance: 4 },
});
const innovationaus = mk("innovationaus", {
  title: "‘If we wait we lose out’: Committee lays out plan to seize AI boom",
  headline: "Joint committee recommends regulatory scrutiny and mandatory model sharing for AI firms",
  summary:
    "A joint committee tabled a report with 46 recommendations following a three-month probe into artificial intelligence. Frontier artificial intelligence firms operating in Australia face a wave of regulatory scrutiny and mandatory sharing of new models with safety and security agencies.",
  publishedAt: "2026-11-24T11:04:27Z",
  classification: { significance: 4 },
});
// Unrelated, same week, overlapping only on generic vocabulary.
const sandbox = mk("openai", {
  authority: "lab",
  title: "Codex sandbox security",
  headline: "OpenAI details sandbox security architecture for Codex agentic harness",
  summary: "OpenAI describes specific controls designed to mitigate prompt injection and allow agentic features to run securely.",
});
const gemini = mk("deepmind", {
  authority: "lab",
  title: "Gemini 4 Neon",
  headline: "Google DeepMind releases Gemini 4 Neon with enhanced safety and security features",
  summary: "The model card describes specific features designed to mitigate prompt injection in agentic use.",
});

test("tokens: lowercased, stemmed, stopwords and short tokens dropped, distinctive numbers kept", () => {
  const t = tokens(mk("x", { title: "The 46 Recommendations: AI audits in 3 states", status: "headline-only" }));
  assert.deepEqual([...t].sort(), ["46", "audit", "recommendation", "state"]);
  assert.equal(stem("policies"), "policy");
  assert.equal(stem("access"), "access");
});

test("tokens: headline-only items contribute their title only", () => {
  const t = tokens(mk("x", { status: "headline-only", title: "Committee report", headline: "ignored", summary: "ignored too" }));
  assert.ok(!t.has("ignored"));
});

test("titleTokens drop topic words and headline verbs", () => {
  assert.deepEqual([...titleTokens(mk("x", { title: "Regulator releases AI governance guidance on privacy", headline: "" }))], ["privacy"]);
});

test("jaccard", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
  assert.equal(jaccard(new Set(), new Set(["a"])), 0);
});

test("sameStory: two outlets on the committee report", () => {
  assert.ok(sameStory(mandarin, innovationaus));
});

test("sameStory: generic overlap without a shared distinctive headline word is not a story", () => {
  assert.ok(!sameStory(sandbox, gemini));
});

test("sameStory: same source, or more than 3 days apart, never merge", () => {
  assert.ok(!sameStory(mandarin, { ...innovationaus, sourceId: mandarin.sourceId }));
  assert.ok(!sameStory(mandarin, { ...innovationaus, publishedAt: "2026-11-29T00:00:00Z" }));
});

test("compareLead: grounded, then authority, then significance, then earliest", () => {
  const order = (...xs) => xs.sort(compareLead).map((x) => x.id);
  assert.deepEqual(order(mk("news"), mk("off", { authority: "official" })), ["off", "news"]);
  assert.deepEqual(order(mk("off", { authority: "official", status: "headline-only" }), mk("news")), ["news", "off"]);
  assert.deepEqual(order(mk("s3"), mk("s4", { classification: { significance: 4 } })), ["s4", "s3"]);
  assert.deepEqual(order(mandarin, innovationaus), ["innovationaus", "mandarin"]); // equal significance: earliest
});

test("clusterItems groups the story, keeps others apart, lead first", () => {
  const stories = clusterItems([sandbox, mandarin, gemini, innovationaus]);
  assert.equal(stories.length, 3);
  const committee = stories.find((s) => s.also.length);
  assert.equal(committee.lead.id, "innovationaus");
  assert.deepEqual(committee.also.map((i) => i.id), ["mandarin"]);
});

test("clusterItems: single link joins a third outlet that matches one member", () => {
  const conversation = mk("conversation", {
    title: "Joint Select Committee on Artificial Intelligence releases report",
    headline: "Joint Select Committee on Artificial Intelligence releases report",
    summary: "The joint select committee made 46 recommendations, including that locally based AI infrastructure be subject to nationally consistent requirements.",
    publishedAt: "2026-11-25T00:00:00Z",
  });
  const [story, ...rest] = clusterItems([conversation, mandarin, innovationaus]);
  assert.equal(rest.length, 0);
  assert.equal(story.also.length, 2);
});

test("coverageBoost: +5% per extra source, capped at +15%, same-source duplicates don't count", () => {
  assert.equal(coverageBoost({ lead: mandarin, also: [] }), 1);
  assert.equal(coverageBoost({ lead: mandarin, also: [innovationaus] }), 1.05);
  assert.equal(coverageBoost({ lead: mandarin, also: [innovationaus, { ...innovationaus, id: "dup" }] }), 1.05);
  assert.equal(coverageBoost({ lead: mandarin, also: [1, 2, 3, 4, 5].map((k) => mk(`s${k}`)) }), 1.15);
});
