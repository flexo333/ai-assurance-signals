import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsDate, cleanCsUrl, formatCitizenSpaceText, parseCitizenSpaceItems, parseCsBody } from "./citizen-space.js";
import { verifyDate } from "./ground.js";

test("parseCsDate parses Citizen Space YYYY/MM/DD and rejects invalid calendar dates", () => {
  assert.deepEqual(parseCsDate("2026/12/07"), {
    isoDay: "2026-12-07",
    isoDate: "2026-12-07T00:00:00.000Z",
    display: "7 Dec 2026",
  });
  assert.deepEqual(parseCsDate("2026-08-31"), {
    isoDay: "2026-08-31",
    isoDate: "2026-08-31T00:00:00.000Z",
    display: "31 Aug 2026",
  });
  assert.equal(parseCsDate("2026/02/30"), null);
  assert.equal(parseCsDate(""), null);
});

test("cleanCsUrl strips /consult_view and query/hash noise", () => {
  assert.equal(
    cleanCsUrl("https://consultations.ag.gov.au/rights-and-protections/privacy-reform/consult_view?foo=1#top"),
    "https://consultations.ag.gov.au/rights-and-protections/privacy-reform/",
  );
  assert.equal(
    cleanCsUrl("/tga/consultation-dmht-exclusion/consult_view/", "https://consultations.tga.gov.au"),
    "https://consultations.tga.gov.au/tga/consultation-dmht-exclusion/",
  );
});

test("formatCitizenSpaceText matches Citizen Space sidebar dates and satisfies ground.js verifyDate", () => {
  const openText = formatCitizenSpaceText({
    status: "open",
    startdate: "2026/10/26",
    enddate: "2026/12/07",
    overview: "<p>Options for regulating digital mental health tools using artificial intelligence.</p>",
  });
  assert.match(openText, /^Closes 7 Dec 2026\nOpened 26 Oct 2026\n\nOptions for regulating/);
  assert.equal(verifyDate("2026-12-07", "Closes 7 Dec 2026", openText), true);
  assert.equal(verifyDate("2026-10-26", "Opened 26 Oct 2026", openText), true);

  const closedText = formatCitizenSpaceText({
    status: "closed",
    startdate: "2026/08/31",
    enddate: "2026/09/18",
    overview: "<p>Privacy Act reform exposure draft.</p>",
  });
  assert.match(closedText, /^Closed 18 Sep 2026\nOpened 31 Aug 2026/);
  assert.equal(verifyDate("2026-09-18", "Closed 18 Sep 2026", closedText), true);
});

test("parseCitizenSpaceItems filters basic_form, applies exclude, dedupes merged feeds and sorts newest first", () => {
  const openJson = JSON.stringify([
    {
      status: "open",
      startdate: "2026/10/26",
      enddate: "2026/12/07",
      title: "Consultation: Reviewing the exclusion for certain digital mental health tools",
      url: "https://consultations.tga.gov.au/tga/consultation-dmht-exclusion/consult_view",
      overview: "<p>Includes tools using artificial intelligence (AI).</p>",
      activity_type: "basic_survey",
    },
    {
      status: "open",
      startdate: "2026/11/01",
      enddate: "2027/06/30",
      title: "Section 41HD Application Form",
      url: "https://consultations.tga.gov.au/tga/s41hd/consult_view",
      overview: "<p>Administrative form.</p>",
      activity_type: "basic_form",
    },
    {
      status: "open",
      startdate: "2026/11/02",
      enddate: "2029/07/31",
      title: "Notification form: Clinical decision support software exemption",
      url: "https://consultations.tga.gov.au/tga/cdss-form/consult_view",
      overview: "<p>Sponsor notification.</p>",
      activity_type: "basic_survey",
    },
    {
      status: "forthcoming",
      startdate: "2026/12/01",
      enddate: "2027/01/15",
      title: "Upcoming AI consultation placeholder",
      url: "https://consultations.ag.gov.au/ai/upcoming/consult_view",
      overview: "<p>Placeholder before opening day.</p>",
      activity_type: "consultation",
    },
  ]);
  const archiveJson = JSON.stringify([
    {
      status: "closed",
      startdate: "2026/08/31",
      enddate: "2026/09/18",
      title: "Privacy Reform – Consultation on Exposure Draft legislation",
      url: "https://consultations.ag.gov.au/rights-and-protections/privacy-reform/consult_view",
      overview: "<p>Tackles emerging risks from artificial intelligence.</p>",
      activity_type: "consultation",
    },
    // Duplicate of open item with shorter text — merged output keeps richer open entry
    {
      status: "open",
      startdate: "2026/10/26",
      enddate: "2026/12/07",
      title: "Consultation: Reviewing the exclusion for certain digital mental health tools",
      url: "https://consultations.tga.gov.au/tga/consultation-dmht-exclusion/",
      overview: "",
      activity_type: "basic_survey",
    },
  ]);

  const items = parseCitizenSpaceItems([openJson, archiveJson, "truncated{"], {
    exclude: "^(Form|Notification form):",
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].link, "https://consultations.tga.gov.au/tga/consultation-dmht-exclusion/");
  assert.equal(items[0].closingDate, "2026-12-07");
  assert.match(items[0].text, /artificial intelligence/);
  assert.equal(items[1].link, "https://consultations.ag.gov.au/rights-and-protections/privacy-reform/");
  assert.equal(items[1].status, "closed");

  assert.equal(parseCitizenSpaceItems("<!doctype html>"), null);
});

test("parseCitizenSpaceItems: the open response wins over a longer or stale archive copy (#36 review)", () => {
  const link = "https://consultations.ag.gov.au/ai/adm-framework/consult_view";
  const open = JSON.stringify([
    { status: "open", startdate: "2026/11/10", enddate: "2026/12/20", title: "ADM framework", url: link, overview: "<p>Short AI text.</p>" },
  ]);
  const archive = JSON.stringify([
    // Stale copy: longer overview, status already flipped/missing.
    { status: "closed", startdate: "2026/11/10", enddate: "2026/12/20", title: "ADM framework", url: link, overview: "<p>A much longer overview of the automated decision-making framework and artificial intelligence.</p>" },
    { startdate: "2026/09/01", title: "Archive-only consultation", url: "https://consultations.ag.gov.au/ai/old/consult_view" },
  ]);
  // Archive listed second; order of records must not matter either way.
  for (const bodies of [[open, archive], [open, JSON.stringify(JSON.parse(archive).reverse())]]) {
    const items = parseCitizenSpaceItems(bodies);
    const adm = items.find((i) => i.title === "ADM framework");
    assert.equal(adm.status, "open");
    assert.equal(adm.fromArchive, false);
    assert.match(adm.text, /^Closes 20 Dec 2026/);
    assert.equal(items.find((i) => i.title === "Archive-only consultation").fromArchive, true);
    assert.equal("rank" in adm, false);
  }
});

test("parseCitizenSpaceItems keeps undated records as date: null (the collector skips them)", () => {
  const items = parseCitizenSpaceItems([null, JSON.stringify([{ title: "No dates", url: "https://x.example/a/b" }])]);
  assert.equal(items.length, 1);
  assert.equal(items[0].date, null);
  assert.equal(items[0].fromArchive, true);
});

test("parseCsBody returns the record array, or null for non-JSON / truncated / non-array bodies", () => {
  assert.deepEqual(parseCsBody("[]"), []);
  assert.deepEqual(parseCsBody('[{"a":1}]'), [{ a: 1 }]);
  assert.equal(parseCsBody("<!doctype html><title>Access denied</title>"), null);
  assert.equal(parseCsBody('[{"a":1'), null);
  assert.equal(parseCsBody('{"a":1}'), null);
  assert.equal(parseCsBody(""), null);
  assert.equal(parseCsBody(undefined), null);
});
