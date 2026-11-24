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
