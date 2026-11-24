import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIntro } from "./intro.js";

const items = [
  { id: "a", headline: "APRA sets AI expectations", summary: "APRA wrote to 600 entities.", why_it_matters: "Boards accountable." },
  { id: "b", headline: "NIST updates AI RMF", summary: "Version 1.1 released.", why_it_matters: "Aligns controls." },
];

test("accepts cited sentences with supported numbers", () => {
  const r = checkIntro("APRA wrote to 600 entities about AI [1]. NIST released version 1.1 of its framework [2]. Both raise the bar for oversight [1][2].", items);
  assert.equal(r.ok, true);
  assert.deepEqual(r.sentences[2].cites, ["a", "b"]);
  assert.equal(r.sentences[0].text, "APRA wrote to 600 entities about AI.");
});

test("rejects uncited sentences, bad citations and invented numbers", () => {
  assert.equal(checkIntro("APRA acted [1]. Regulators everywhere are moving.", items).reason, "uncited-sentence");
  assert.equal(checkIntro("APRA acted [1]. NIST too [3].", items).reason, "bad-citation");
  assert.match(checkIntro("APRA wrote to 900 entities [1]. NIST acted [2].", items).reason, /unsupported-number:900/);
  // substrings of supported numbers are not supported
  assert.match(checkIntro("APRA wrote to 60 entities [1]. NIST acted [2].", items).reason, /unsupported-number:60/);
  assert.match(checkIntro("APRA acted [1]. NIST released version 1 [2].", items).reason, /unsupported-number:1$/);
});
