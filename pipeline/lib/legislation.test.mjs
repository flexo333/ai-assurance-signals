import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toODataDateTime,
  buildLegislationQueryUrl,
  parseODataDate,
  legislationDocUrls,
  parseLegislationTitles,
  formatLegislationText,
} from "./legislation.js";

const SAMPLE_ODATA = JSON.stringify({
  "@odata.context": "http://api.prod.legislation.gov.au/v1/$metadata#Titles",
  value: [
    {
      id: "C2026G00737",
      name: "Notice of Decision on Application for Temporary Exemption (2026)",
      makingDate: null,
      collection: "Gazette",
      subCollection: null,
      asMadeRegisteredAt: "2026-11-25T16:58:53.3390249",
    },
    {
      id: "F2026L01561",
      name: "Privacy (Automated Decision-Making Transparency) Rules 2026",
      makingDate: "2026-11-24T00:00:00",
      collection: "LegislativeInstrument",
      subCollection: "Rules",
      isPrincipal: true,
      asMadeRegisteredAt: "2026-11-25T15:50:25.5796156",
      optionalSeriesNumber: null,
    },
    {
      id: "C2026A00050",
      name: "Online Safety Amendment (Digital Duty of Care) Act 2026",
      makingDate: "2026-11-20T00:00:00",
      collection: "Act",
      subCollection: null,
      isPrincipal: false,
      asMadeRegisteredAt: "2026-11-21T09:30:00",
    },
    {
      id: "F2025L00010",
      name: "Old Instrument 2025",
      makingDate: "2025-01-10T00:00:00",
      collection: "LegislativeInstrument",
      asMadeRegisteredAt: "2025-01-12T04:00:00",
    },
    {
      id: "C2026A00099",
      name: "Undated Placeholder Act 2026",
      makingDate: null,
      collection: "Act",
      asMadeRegisteredAt: null,
    },
  ],
});

test("toODataDateTime strips Z and milliseconds for FrlEnableQuery", () => {
  assert.equal(toODataDateTime("2026-11-17T20:30:45.123Z"), "2026-11-17T20:30:45");
  assert.equal(toODataDateTime("not-a-date"), null);
  assert.equal(toODataDateTime(null), null);
});

test("buildLegislationQueryUrl constructs filtered OData query", () => {
  const u = buildLegislationQueryUrl({ since: "2026-11-01T00:00:00.000Z", top: 50 });
  assert.match(u, /^https:\/\/api\.prod\.legislation\.gov\.au\/v1\/Titles\?/);
  assert.match(u, /\$filter=asMadeRegisteredAt%20ge%202026-11-01T00%3A00%3A00/);
  assert.match(u, /\$top=50/);
});

test("parseODataDate handles 7-digit fractional seconds without Z", () => {
  assert.equal(parseODataDate("2026-11-25T15:50:25.5796156"), "2026-11-25T15:50:25.579Z");
  assert.equal(parseODataDate("2026-11-24T00:00:00"), "2026-11-24T00:00:00.000Z");
  assert.equal(parseODataDate(null), null);
});

test("parseLegislationTitles keeps Acts and LegislativeInstruments in window, skipping Gazettes and known IDs", () => {
  const items = parseLegislationTitles(SAMPLE_ODATA, {
    since: "2026-07-01T00:00:00.000Z",
    known: new Set(),
    idOf: (u) => `id:${u}`,
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].registerId, "F2026L01561");
  assert.equal(items[0].url, "https://www.legislation.gov.au/F2026L01561");
  assert.deepEqual(items[0].docUrls, [
    "https://www.legislation.gov.au/F2026L01561/asmade/latest/es/original/epub/OEBPS/document_1/document_1.html",
    "https://www.legislation.gov.au/F2026L01561/asmade/latest/text/original/epub/OEBPS/document_1/document_1.html",
  ]);
  assert.equal(items[1].registerId, "C2026A00050");
  assert.deepEqual(items[1].docUrls, [
    "https://www.legislation.gov.au/C2026A00050/asmade/latest/text/original/epub/OEBPS/document_1/document_1.html",
  ]);

  const filteredKnown = parseLegislationTitles(SAMPLE_ODATA, {
    since: "2026-07-01T00:00:00.000Z",
    known: new Set(["id:https://www.legislation.gov.au/F2026L01561"]),
    idOf: (u) => `id:${u}`,
  });
  assert.deepEqual(filteredKnown.map((i) => i.registerId), ["C2026A00050"]);
});

test("parseLegislationTitles returns null on invalid JSON or non-OData object", () => {
  assert.equal(parseLegislationTitles("<html>shell</html>"), null);
  assert.equal(parseLegislationTitles("{}"), null);
});

test("formatLegislationText includes grounded metadata and body text", () => {
  const [item] = parseLegislationTitles(SAMPLE_ODATA, { since: "2026-07-01T00:00:00.000Z" });
  const text = formatLegislationText(item, "EXPLANATORY STATEMENT\nThis instrument prescribes transparency rules.");
  assert.match(text, /Federal Register of Legislation — Legislative Instrument \(F2026L01561\)/);
  assert.match(text, /Registered 25 Nov 2026/);
  assert.match(text, /Made 24 Nov 2026/);
  assert.match(text, /EXPLANATORY STATEMENT/);
});

test("legislationDocUrls returns es+text for LegislativeInstrument and text for Act", () => {
  assert.equal(legislationDocUrls("F2026L00001", "LegislativeInstrument").length, 2);
  assert.equal(legislationDocUrls("C2026A00001", "Act").length, 1);
});
