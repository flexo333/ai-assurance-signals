import { test } from "node:test";
import assert from "node:assert/strict";
import { isAiRelated } from "./keywords.js";

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
