import { test } from "node:test";
import assert from "node:assert/strict";
import { planSeeds, pickRechecks, sourceHosts } from "./seeds.js";
import { canonicalUrl, itemId } from "./text-pure.js";

const sources = [
  { id: "itnews", authority: "news", homepage: "https://www.itnews.com.au/" },
  { id: "anz", authority: "industry", homepage: "https://www.anz.com.au/newsroom/", hosts: ["bluenotes.anz.com"], sector: "financial-services" },
  { id: "apra", authority: "official", homepage: "https://www.apra.gov.au/", sector: "financial-services" },
  { id: "oaic", authority: "official", homepage: "https://www.oaic.gov.au/", status: "blocked" },
  { id: "nist", authority: "standards", homepage: "https://www.nist.gov/" },
  { id: "nab", authority: "industry", homepage: "https://www.nab.com.au/news", status: "pending" },
];

test("sourceHosts: homepage host plus extra hosts", () => {
  assert.deepEqual([...sourceHosts(sources[1])].sort(), ["anz.com.au", "bluenotes.anz.com"]);
});

test("planSeeds keeps seeds on their source's host, skips known, rejects the rest", () => {
  const known = new Set([itemId(canonicalUrl("https://www.itnews.com.au/news/known-1"))]);
  const { seeds, rejected } = planSeeds(
    [
      { url: "https://www.anz.com.au/bluenotes/2026/November/ai-in-action-at-anz/", source: "anz" },
      { url: "https://bluenotes.anz.com/posts/x", source: "anz", published: "2026-11-17" },
      { url: "https://www.itnews.com.au/news/known-1", source: "itnews" },
      { url: "https://evil.example.com/x", source: "itnews" }, // not the source's host
      { url: "https://www.oaic.gov.au/x", source: "oaic" }, // blocked
      { url: "https://x.example/y", source: "nope" }, // unknown source
      { url: "https://www.nab.com.au/news/x", source: "nab" }, // pending: not fetched until verified
      { url: "https://www.anz.com.au/bluenotes/2026/November/ai-in-action-at-anz/", source: "anz" }, // duplicate
    ],
    sources,
    known,
  );
  assert.deepEqual(seeds.map((s) => s.sourceId), ["anz", "anz"]);
  assert.equal(rejected.length, 4);
  assert.ok(seeds.every((s) => s.id && s.url));
  assert.equal(seeds[1].publishedAt, "2026-11-17T00:00:00.000Z");
  assert.equal(seeds[0].publishedAt, undefined);
});

test("pickRechecks: old-prompt irrelevant news/industry/FS items, newest first, limited", () => {
  const mk = (id, sourceId, promptVersion, o = {}) => ({ id, sourceId, url: `https://x/${id}`, title: id, status: "irrelevant", publishedAt: `2026-11-${id.slice(-2)}T00:00:00Z`, provenance: { promptVersion }, ...o });
  const items = [
    mk("a10", "itnews", 2),
    mk("a12", "itnews", 2),
    mk("a11", "apra", 1), // official, but an FS source
    mk("a13", "nist", 2), // standards, not FS: not re-checked
    mk("a14", "itnews", 3), // already v3
    mk("a15", "itnews", 2, { status: "summarised" }),
    mk("a16", "oaic", 2), // blocked
    mk("a17", "itnews", 2, { recheck: { promptVersion: 3, failedAt: "2026-11-25" } }), // tried, page gone
  ];
  assert.deepEqual(pickRechecks(items, sources, { limit: 0, promptVersion: 3 }), []);
  const r = pickRechecks(items, sources, { limit: 2, promptVersion: 3 });
  assert.deepEqual(r.map((x) => x.id), ["a12", "a11"]);
  assert.ok(r.every((x) => x.recheck && x.publishedAt && x.url));
  assert.equal(pickRechecks(items, sources, { limit: 10, promptVersion: 3 }).length, 3);
  // An undated item keeps an explicit null, so the re-check replaces it in place.
  const undated = pickRechecks([mk("a18", "itnews", 2, { publishedAt: undefined, fetchedAt: "2026-10-30T00:00:00Z" })], sources, { limit: 1, promptVersion: 3 });
  assert.equal(undated[0].publishedAt, null);
  assert.ok("publishedAt" in JSON.parse(JSON.stringify(undated[0])));
});
