import { test } from "node:test";
import assert from "node:assert/strict";
import { score, sectionFor, buildEdition, selectWindow, isoWeekId, SECTION_CAP } from "./rank.js";

const NOW = Date.parse("2026-11-27T04:17:00Z");
const mk = (id, o = {}) => ({
  id,
  status: "summarised",
  authority: "official",
  jurisdiction: "AU-federal",
  publishedAt: "2026-11-26T00:00:00Z",
  fetchedAt: "2026-11-26T01:00:00Z",
  classification: { significance: 3, au_relevance: 3, theme: "regulator-guidance" },
  ...o,
});

test("score orders by significance, authority, AU relevance and grounding", () => {
  const off = score(mk("a"), NOW);
  assert.ok(off > score(mk("b", { authority: "news" }), NOW));
  assert.ok(off > score(mk("c", { classification: { significance: 3, au_relevance: 0 } }), NOW));
  assert.ok(off > score(mk("d", { status: "headline-only" }), NOW));
  assert.ok(score(mk("e", { classification: { significance: 5, au_relevance: 3 } }), NOW) > off);
});

test("sectionFor routes news, labs and non-AU official items", () => {
  assert.equal(sectionFor(mk("a", { authority: "news" })), "news-commentary");
  assert.equal(sectionFor(mk("a", { authority: "lab", jurisdiction: "INTL" })), "frontier-labs");
  assert.equal(sectionFor(mk("a", { jurisdiction: "UK" })), "international");
  assert.equal(sectionFor(mk("a", { authority: "standards", jurisdiction: "US", classification: { theme: "standards-frameworks" } })), "standards-frameworks");
  assert.equal(sectionFor(mk("a", { classification: { theme: "news-commentary" } })), "policy-legislation");
});

test("selectWindow keeps publishable items collected in (from, to]", () => {
  const items = [mk("in"), mk("old", { fetchedAt: "2026-11-10T00:00:00Z" }), mk("irr", { status: "irrelevant" })];
  assert.deepEqual(selectWindow(items, { from: "2026-11-20T04:17:00Z", to: "2026-11-27T04:17:00Z" }).map((i) => i.id), ["in"]);
});

test("buildEdition: top signals capped, ≤2 news, sections capped and exclusive", () => {
  const items = [
    ...Array.from({ length: 4 }, (_, k) => mk(`n${k}`, { authority: "news", classification: { significance: 5, au_relevance: 3, theme: "news-commentary" } })),
    mk("o1", { classification: { significance: 4, au_relevance: 3, theme: "regulator-guidance" } }),
    mk("h1", { status: "headline-only", classification: { significance: 5, au_relevance: 3, theme: "regulator-guidance" } }),
    ...Array.from({ length: 12 }, (_, k) => mk(`r${k}`, { classification: { significance: 2, au_relevance: 1, theme: "regulator-guidance" } })),
  ];
  const ed = buildEdition(items, { id: "2026-W48", from: "2026-11-20T04:17:00Z", to: "2026-11-27T04:17:00Z" });
  const topIds = ed.topSignals.map((t) => t.id);
  assert.ok(topIds.length >= 3 && topIds.length <= 5);
  assert.ok(topIds.filter((id) => id.startsWith("n")).length <= 2);
  assert.ok(!topIds.includes("h1"), "headline-only never a top signal");
  const reg = ed.sections.find((s) => s.id === "regulator-guidance");
  assert.equal(reg.items.length, SECTION_CAP);
  assert.ok(reg.overflow > 0);
  const all = [...topIds, ...ed.sections.flatMap((s) => s.items.map((i) => i.id))];
  assert.equal(new Set(all).size, all.length, "no item appears twice");
});

test("isoWeekId uses Sydney local date", () => {
  assert.equal(isoWeekId(new Date("2026-11-27T04:17:00Z")), "2026-W48");
  assert.equal(isoWeekId(new Date("2026-12-31T14:00:00Z")), "2026-W53"); // Fri 1 Jan 2027 01:00 AEDT
});
