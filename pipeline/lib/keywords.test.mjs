import { test } from "node:test";
import assert from "node:assert/strict";
import { isAiRelated, passesMustMatch } from "./keywords.js";

test("matches AI governance phrasing", () => {
  for (const t of [
    "OAIC guidance on privacy and developing generative AI models",
    "APRA letter on artificial intelligence risk",
    "Transparency for automated decision-making under the Privacy Act",
    "Proposals for mandatory guardrails",
    "ASIC review of A.I. use by licensees",
    "Senate inquiry into LLMs",
  ]) assert.equal(isAiRelated(t), true, t);
});

test("ignores unrelated releases and lowercase 'ai' inside words", () => {
  for (const t of [
    "ACCC takes action against misleading airfares",
    "Interest rate decision maintained",
    "Thailand trade mission",
    "",
    null,
  ]) assert.equal(isAiRelated(t), false, String(t));
});

test("matches AI-assisted engineering and migration posts that name tools (#31)", () => {
  for (const t of [
    "How we used agentic workflows to migrate 20 years of COBOL",
    "Rewriting legacy code with Amazon Bedrock",
    "Data migration at scale with Vertex AI",
    "AI-assisted code translation from PL/SQL to Java",
    "Our engineers adopted GitHub Copilot across 3,000 repositories",
  ]) assert.equal(isAiRelated(t), true, t);
  assert.equal(isAiRelated("Move the cursor to the next field"), false);
});

test("passesMustMatch: optional, any-of, case-insensitive (#31)", () => {
  assert.equal(passesMustMatch(undefined, "anything"), true);
  assert.equal(passesMustMatch([], "anything"), true);
  const fs = ["\\b(NAB|ANZ|Westpac|Commonwealth Bank|CommBank|Macquarie)\\b", "\\bAustralia"];
  assert.equal(passesMustMatch(fs, "How NAB rebuilt its data platform on AWS"), true);
  assert.equal(passesMustMatch(fs, "Customer story: a bank in australia"), true);
  assert.equal(passesMustMatch(fs, "How a US retailer uses generative AI"), false);
  assert.equal(passesMustMatch(fs, ""), false);
  assert.equal(passesMustMatch("ANZ", "anz bluenotes"), true); // a single string works too
});
