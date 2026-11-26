import { test } from "node:test";
import assert from "node:assert/strict";
import { score, sectionFor, isFinancialServices, AUTHORITY_WEIGHT, buildEdition, selectWindow, isoWeekId, weeklyCutoffs, editionItemIds, SECTION_CAP } from "./rank.js";

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
    // official sig-2 AU item (score 3.0) outranks the sig-4 non-AU news item (2.4) on composite score
    mk("low", { classification: { significance: 2, au_relevance: 3, theme: "regulator-guidance" } }),
    // significance 4: beyond the minimum, extras need >= 4 (#13)
    mk("news3", { authority: "news", classification: { significance: 4, au_relevance: 0, theme: "news-commentary" } }),
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

test("buildEdition groups coverage of one story into a single entry with `also`", () => {
  const story = (id, sourceId, publishedAt, headline) =>
    mk(id, {
      sourceId,
      authority: "news",
      publishedAt,
      title: headline,
      headline,
      summary: "The joint select committee tabled 46 recommendations on frontier AI audits.",
      classification: { significance: 4, au_relevance: 3, theme: "policy-legislation" },
    });
  const items = [
    story("a", "mandarin", "2026-11-24T19:00:00Z", "Parliamentary committee recommends independent audits"),
    story("b", "innovationaus", "2026-11-24T11:00:00Z", "Joint committee recommends regulatory scrutiny"),
    mk("o1"),
    mk("o2"),
    mk("o3"),
  ];
  const ed = buildEdition(items, { id: "w", from: "2026-11-20T04:17:00Z", to: "2026-11-27T04:17:00Z" });
  const entry = ed.topSignals.find((t) => t.id === "b");
  assert.deepEqual(entry.also, ["a"]);
  assert.ok(!editionItemIds(ed).filter((id) => id === "a").slice(1).length, "grouped item placed once");
  assert.ok(editionItemIds(ed).includes("a"));
  assert.equal(ed.counts.stories, 4);
  assert.ok(!ed.topSignals.some((t) => t.id === "a"));
  assert.ok(!ed.topSignals.find((t) => t.id === "o1").also, "no `also` key on ungrouped entries");
});

test("#13: products/business/predictions never reach Top Signals; extras need significance >= 4", () => {
  const W = { id: "w", from: "2026-11-20T04:17:00Z", to: "2026-11-27T04:17:00Z" };
  const k = (id, kind, sig, o = {}) => mk(id, { classification: { significance: sig, au_relevance: 3, theme: "regulator-guidance", item_kind: kind }, ...o });
  const items = [
    k("reg5", "regulation", 5),
    k("std4", "standard", 4, { authority: "standards" }),
    k("prod5", "product", 5, { authority: "lab", jurisdiction: "INTL" }), // high score but a product launch
    k("guid3", "regulator-guidance", 3), // ranks 4th with sig 3: beyond the minimum, excluded
    k("pred4", "prediction", 4, { authority: "news" }),
    k("lab3", "safety-framework", 3, { authority: "lab", jurisdiction: "INTL" }), // sig 3 beyond the minimum: excluded
    k("pol4", "government-policy", 4, { authority: "research" }),
  ];
  const top = buildEdition(items, W).topSignals.map((t) => t.id);
  assert.ok(!top.includes("prod5") && !top.includes("pred4"));
  assert.ok(!top.includes("lab3"));
  assert.deepEqual(new Set(top), new Set(["reg5", "std4", "pol4"]));
});

test("#13: kind weight lowers products in score; legacy items (no item_kind) unaffected", () => {
  const base = { classification: { significance: 4, au_relevance: 3, theme: "regulator-guidance" } };
  const legacy = score(mk("a", base), NOW);
  const product = score(mk("b", { classification: { ...base.classification, item_kind: "product" } }), NOW);
  const regulation = score(mk("c", { classification: { ...base.classification, item_kind: "regulation" } }), NOW);
  assert.equal(regulation, legacy);
  assert.ok(product < legacy * 0.7);
});

test("#31: industry and vendor authority weights sit around news", () => {
  assert.ok(AUTHORITY_WEIGHT.research > AUTHORITY_WEIGHT.industry);
  assert.ok(AUTHORITY_WEIGHT.industry > AUTHORITY_WEIGHT.news);
  assert.ok(AUTHORITY_WEIGHT.news > AUTHORITY_WEIGHT.vendor);
  const s = (authority) => score(mk("x", { authority }), NOW);
  assert.ok(s("industry") > s("news") && s("news") > s("vendor"));
});

test("#48: regulation comes first, before Financial Services", () => {
  const reg = (item_kind, theme, o = {}) => mk("r", { sector: "financial-services", classification: { item_kind, theme, is_financial_services: true }, ...o });
  assert.equal(sectionFor(reg("regulator-guidance", "financial-services")), "regulator-guidance");
  assert.equal(sectionFor(reg("enforcement", "financial-services")), "regulator-guidance");
  assert.equal(sectionFor(reg("regulation", "financial-services")), "regulator-guidance");
  assert.equal(sectionFor(reg("legislation", "financial-services")), "policy-legislation");
  assert.equal(sectionFor(reg("consultation", "regulator-guidance")), "regulator-guidance"); // regulatory theme wins
  assert.equal(sectionFor(reg("regulator-guidance", "financial-services", { jurisdiction: "UK" })), "international");
  // Only official items: a bank's or a news outlet's take on regulation stays FS.
  assert.equal(sectionFor(reg("regulator-guidance", "financial-services", { authority: "industry" })), "financial-services");
  assert.equal(sectionFor(reg("regulator-guidance", "financial-services", { authority: "news" })), "financial-services");
});

test("#31: Financial Services routing for every authority, before the news fallback", () => {
  const fsFlag = { classification: { significance: 3, theme: "regulator-guidance", item_kind: "regulator-guidance", is_financial_services: true } };
  // Regulation first (#48): an FS regulator's guidance goes to Regulator Guidance.
  assert.equal(sectionFor(mk("apra", fsFlag)), "regulator-guidance");
  assert.equal(sectionFor(mk("apra-speech", { classification: { item_kind: "commentary", is_financial_services: true } })), "financial-services");
  assert.equal(sectionFor(mk("itnews", { authority: "news", ...fsFlag })), "financial-services");
  assert.equal(sectionFor(mk("aws", { authority: "vendor", ...fsFlag })), "financial-services");
  assert.equal(sectionFor(mk("nab", { authority: "industry", classification: { theme: "financial-services" } })), "financial-services");
  assert.equal(sectionFor(mk("rba", { sector: "financial-services", classification: { theme: "policy-legislation" } })), "financial-services");
  // Not FS: vendor → News & Commentary; industry without FS → by theme.
  assert.equal(sectionFor(mk("ms", { authority: "vendor", classification: { theme: "news-commentary" } })), "news-commentary");
  assert.equal(sectionFor(mk("x", { authority: "industry", classification: { theme: "standards-frameworks" } })), "standards-frameworks");
  assert.equal(isFinancialServices(mk("y")), false);
});

test("#31: significant deployments can reach Top Signals; vendor stories never do", () => {
  const W = { id: "w", from: "2026-11-20T04:17:00Z", to: "2026-11-27T04:17:00Z" };
  const c = (kind, sig, o = {}) => ({ classification: { significance: sig, au_relevance: 3, theme: "financial-services", is_financial_services: true, item_kind: kind }, ...o });
  const items = [
    mk("reg5", c("regulation", 5)),
    mk("std4", c("standard", 4, { authority: "standards" })),
    mk("reg4", c("regulator-guidance", 4)),
    mk("nab", c("deployment", 4, { authority: "industry" })),
    mk("narrow", c("deployment", 2, { authority: "industry" })),
    mk("aws", c("deployment", 5, { authority: "vendor" })),
  ];
  const ed = buildEdition(items, W);
  const top = ed.topSignals.map((t) => t.id);
  assert.ok(top.includes("nab"));
  assert.ok(!top.includes("narrow") && !top.includes("aws"));
  const fs = ed.sections.find((s) => s.id === "financial-services");
  assert.deepEqual(new Set(fs.items.map((r) => r.id)), new Set(["narrow", "aws"]));
});
