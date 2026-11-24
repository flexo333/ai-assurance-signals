import { test } from "node:test";
import assert from "node:assert/strict";
import { score, sectionFor, buildEdition, selectWindow, isoWeekId, weeklyCutoffs, SECTION_CAP } from "./rank.js";

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

test("selectWindow: current mode by publish date with a 7-day late-arrival grace", () => {
  const W = { from: "2026-11-20T04:17:00Z", to: "2026-11-27T04:17:00Z" };
  const items = [
    mk("in"), // published + collected in window
    mk("late", { publishedAt: "2026-11-16T00:00:00Z", fetchedAt: "2026-11-24T00:00:00Z" }), // within grace
    mk("backfilled", { publishedAt: "2026-08-01T00:00:00Z", fetchedAt: "2026-11-24T00:00:00Z" }), // too old: archive only
    mk("future", { fetchedAt: "2026-11-28T00:00:00Z" }), // collected after cutoff
    mk("irr", { status: "irrelevant" }),
    mk("dup"),
  ];
  assert.deepEqual(selectWindow(items, { ...W, exclude: new Set(["dup"]) }).map((i) => i.id), ["in", "late"]);
});

test("selectWindow: backfill mode by publish date only", () => {
  const items = [mk("aug", { publishedAt: "2026-08-03T00:00:00Z", fetchedAt: "2026-11-24T00:00:00Z" }), mk("nov")];
  assert.deepEqual(selectWindow(items, { from: "2026-07-31T04:17:00Z", to: "2026-08-07T04:17:00Z", mode: "backfill" }).map((i) => i.id), ["aug"]);
});

test("weeklyCutoffs: Fridays 04:17Z from the archive start, before now", () => {
  const c = weeklyCutoffs("2026-07-01", "2026-07-25T00:00:00Z");
  assert.deepEqual(c, ["2026-07-03T04:17:00.000Z", "2026-07-10T04:17:00.000Z", "2026-07-17T04:17:00.000Z", "2026-07-24T04:17:00.000Z"]);
  assert.equal(weeklyCutoffs("2026-11-27T04:17:00.000Z", "2026-11-27T04:17:00.000Z").length, 0);
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

test("a low-significance item doesn't stop later qualifying items reaching Top Signals", () => {
  const items = [
    mk("a", { classification: { significance: 5, au_relevance: 3, theme: "regulator-guidance" } }),
    mk("b", { classification: { significance: 5, au_relevance: 3, theme: "regulator-guidance" } }),
    mk("c", { classification: { significance: 4, au_relevance: 3, theme: "regulator-guidance" } }),
    // official sig-2 AU item outranks the sig-3 news item on composite score
    mk("low", { classification: { significance: 2, au_relevance: 3, theme: "regulator-guidance" } }),
    mk("news3", { authority: "news", classification: { significance: 3, au_relevance: 3, theme: "news-commentary" } }),
  ];
  const ed = buildEdition(items, { id: "w", from: "2026-11-20T04:17:00Z", to: "2026-11-27T04:17:00Z" });
  const top = ed.topSignals.map((t) => t.id);
  assert.ok(top.includes("news3"));
  assert.ok(!top.includes("low"));
});

test("overflow items are kept in 'more', not dropped", () => {
  const items = Array.from({ length: 11 }, (_, k) => mk(`r${k}`, { classification: { significance: 2, au_relevance: 1, theme: "regulator-guidance" } }));
  const sec = buildEdition(items, { id: "w", from: "2026-11-20T04:17:00Z", to: "2026-11-27T04:17:00Z" }).sections.find((s) => s.id === "regulator-guidance");
  assert.equal(sec.items.length + sec.more.length + 3, 11); // 3 went to Top Signals (minimum)
  assert.equal(sec.overflow, sec.more.length);
});

test("isoWeekId uses Sydney local date", () => {
  assert.equal(isoWeekId(new Date("2026-11-27T04:17:00Z")), "2026-W48");
  assert.equal(isoWeekId(new Date("2026-12-31T14:00:00Z")), "2026-W53"); // Fri 1 Jan 2027 01:00 AEDT
});
