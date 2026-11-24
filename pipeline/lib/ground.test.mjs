import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyQuotes, normaliseForMatch } from "./ground.js";

const SOURCE = `The OAIC has published new guidance on privacy and the use of commercially available AI products.
It says organisations should not enter personal information, and particularly sensitive information,
into publicly available generative AI tools — given the significant and complex privacy risks involved.`;

test("normaliseForMatch folds typographic variants only", () => {
  assert.equal(normaliseForMatch("“Smart”  quotes – and ‘dashes’…"), '"Smart" quotes - and \'dashes\'...');
});

test("grounded when every quote is verbatim and both fields are covered", () => {
  const r = verifyQuotes(
    [
      { text: "published new guidance on privacy and the use of commercially available AI products", supports: "summary" },
      { text: "should not enter personal information, and particularly sensitive information,\ninto publicly available generative AI tools", supports: "why_it_matters" },
    ],
    SOURCE,
  );
  assert.equal(r.grounded, true);
});

test("tolerates curly quotes and dash variants but not rewording", () => {
  const ok = verifyQuotes(
    [
      { text: "into publicly available generative AI tools - given the significant and complex privacy risks", supports: "summary" },
      { text: "“particularly sensitive information”", supports: "why_it_matters" },
    ],
    SOURCE,
  );
  assert.equal(ok.checked[0].found, true);
  assert.equal(ok.checked[1].reason, "too-short"); // 3 words
  assert.equal(ok.grounded, false);

  const reworded = verifyQuotes(
    [{ text: "The OAIC has released new guidance on privacy and commercial AI products", supports: "summary" }],
    SOURCE,
  );
  assert.equal(reworded.checked[0].reason, "not-in-source");
  assert.equal(reworded.grounded, false);
});

test("case must match", () => {
  const r = verifyQuotes([{ text: "THE OAIC HAS PUBLISHED NEW GUIDANCE ON PRIVACY", supports: "summary" }], SOURCE);
  assert.equal(r.checked[0].found, false);
});

test("ungrounded when a field has no supporting quote, or no quotes at all", () => {
  const onlySummary = verifyQuotes(
    [{ text: "published new guidance on privacy and the use of commercially available AI products", supports: "summary" }],
    SOURCE,
  );
  assert.equal(onlySummary.grounded, false);
  assert.equal(verifyQuotes([], SOURCE).grounded, false);
  assert.equal(verifyQuotes(undefined, SOURCE).grounded, false);
});

import { verifyDate } from "./ground.js";

const CONSULT = "Submissions close on 31 January 2027. The new obligations commence on 10/12/2026 for all entities. Feedback is due by Fri 6 Feb 2027.";

test("verifyDate requires a verbatim quote that states the date", () => {
  assert.equal(verifyDate("2027-01-31", "Submissions close on 31 January 2027", CONSULT), true);
  assert.equal(verifyDate("2026-12-10", "obligations commence on 10/12/2026 for all entities", CONSULT), true);
  assert.equal(verifyDate("2027-02-06", "Feedback is due by Fri 6 Feb 2027", CONSULT), true);
  // wrong day, wrong year, quote not in source, no quote, bad ISO
  assert.equal(verifyDate("2027-01-30", "Submissions close on 31 January 2027", CONSULT), false);
  assert.equal(verifyDate("2026-01-31", "Submissions close on 31 January 2027", CONSULT), false);
  assert.equal(verifyDate("2027-01-31", "Submissions close on 31 January 2027 at 5pm", CONSULT), false);
  assert.equal(verifyDate("2027-01-31", "", CONSULT), false);
  assert.equal(verifyDate("31/01/2027", "Submissions close on 31 January 2027", CONSULT), false);
  // the verb "may" is not the month May
  const MAY = "Entities may respond by 5 June 2027 at the latest.";
  assert.equal(verifyDate("2027-05-05", "Entities may respond by 5 June 2027", MAY), false);
  assert.equal(verifyDate("2027-06-05", "Entities may respond by 5 June 2027", MAY), true);
});
