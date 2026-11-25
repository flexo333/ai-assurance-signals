import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toODataDateTime,
  buildLegislationQueryUrl,
  parseODataDate,
  legislationDocUrls,
  parseLegislationTitles,
  parseODataPage,
  isLegislationAppShell,
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

test("toODataDateTime converts to Canberra local time, without Z or milliseconds", () => {
  // 20:30:45 UTC on 17 Nov = 07:30:45 AEDT on 18 Nov (UTC+11).
  assert.equal(toODataDateTime("2026-11-17T20:30:45.123Z"), "2026-11-18T07:30:45");
  // Winter (AEST, UTC+10).
  assert.equal(toODataDateTime("2026-07-01T00:00:00.000Z"), "2026-07-01T10:00:00");
  assert.equal(toODataDateTime("not-a-date"), null);
  assert.equal(toODataDateTime(null), null);
});

test("buildLegislationQueryUrl filters by window and collection server-side, with paging", () => {
  const u = buildLegislationQueryUrl({ since: "2026-10-31T13:00:00.000Z", top: 50 });
  assert.match(u, /^https:\/\/api\.prod\.legislation\.gov\.au\/v1\/Titles\?/);
  const filter = decodeURIComponent(u.match(/\$filter=([^&]+)/)[1]);
  assert.equal(filter, "asMadeRegisteredAt ge 2026-11-01T00:00:00 and (collection eq 'Act' or collection eq 'LegislativeInstrument')");
  assert.match(u, /\$top=50/);
  assert.doesNotMatch(u, /\$skip/);
  assert.match(buildLegislationQueryUrl({ since: "2026-11-01T00:00:00Z", skip: 100 }), /\$skip=100/);
  // Unsafe collection names never reach the filter.
  assert.doesNotMatch(buildLegislationQueryUrl({ collections: ["Act' or 1 eq 1 or 'x"] }), /\$filter=/);
});

test("parseODataDate reads offset-less timestamps as Canberra time; makingDate as a calendar day", () => {
  assert.equal(parseODataDate("2026-11-25T15:50:25.5796156"), "2026-11-25T04:50:25.579Z");
  assert.equal(parseODataDate("2026-07-01T09:00:00"), "2026-06-30T23:00:00.000Z");
  assert.equal(parseODataDate("2026-11-24T00:00:00", { timeZone: "UTC" }), "2026-11-24T00:00:00.000Z");
  assert.equal(parseODataDate("2026-11-25T04:50:25Z"), "2026-11-25T04:50:25.000Z");
  assert.equal(parseODataDate(null), null);
  assert.equal(parseODataDate("garbage"), null);
});

test("parseODataPage returns rows and nextLink, or null", () => {
  assert.deepEqual(parseODataPage(JSON.stringify({ value: [{ id: "x" }], "@odata.nextLink": "https://api/v1/Titles?$skip=100" })), {
    rows: [{ id: "x" }],
    nextLink: "https://api/v1/Titles?$skip=100",
  });
  assert.equal(parseODataPage(JSON.stringify({ value: [] })).nextLink, null);
  assert.equal(parseODataPage("<html>shell</html>"), null);
});

test("isLegislationAppShell detects the Angular shell, not EPUB XHTML", () => {
  assert.equal(isLegislationAppShell('<html><head><base href="/"></head><body><app-root></app-root></body></html>'), true);
  assert.equal(isLegislationAppShell('<html ng-version="17.3.0"><body></body></html>'), true);
  assert.equal(isLegislationAppShell('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p class="Title">EXPLANATORY STATEMENT</p></body></html>'), false);
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

test("parseLegislationTitles accepts pre-parsed rows and dates registration in Canberra time", () => {
  const rows = JSON.parse(SAMPLE_ODATA).value;
  const [item] = parseLegislationTitles(rows, { since: "2026-07-01T00:00:00.000Z" });
  assert.equal(item.registerId, "F2026L01561");
  assert.equal(item.date, "2026-11-25T04:50:25.579Z");
  assert.equal(item.makingDate, "2026-11-24T00:00:00.000Z");
});

test("legislationDocUrls returns es+text for LegislativeInstrument and text for Act", () => {
  assert.equal(legislationDocUrls("F2026L00001", "LegislativeInstrument").length, 2);
  assert.equal(legislationDocUrls("C2026A00001", "Act").length, 1);
});
