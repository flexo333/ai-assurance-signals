// Per-item analysis: one Gemini call (classify + summarise), the grounding
// gate, and one corrective retry. Returns the record to store (or null when
// the model call failed and the item should be retried on a later run).
// `ai` is injected so this is testable with a fake client.

import { verifyQuotes } from "./ground.js";
import { generateWithFallback, sleep } from "./gemini.js";
import { SYSTEM_PROMPT, ANALYSIS_SCHEMA, PROMPT_VERSION, parseAnalysis, buildUserPrompt } from "./prompt.js";

const CONFIG = {
  systemInstruction: SYSTEM_PROMPT,
  responseMimeType: "application/json",
  responseSchema: ANALYSIS_SCHEMA,
  temperature: 0.2,
};

const classificationOf = (a) => ({
  theme: a.theme,
  audiences: a.audiences,
  au_relevance: a.au_relevance,
  significance: a.significance,
  significance_reason: a.significance_reason,
  is_consultation: a.is_consultation,
  closing_date: a.closing_date,
});

/**
 * @returns { record, calls, quotaExhausted, error }
 *   record.status: "summarised" | "headline-only" | "irrelevant"; record null on model failure.
 */
export async function analyseItem(ai, { source, item, allowRetry = true, delayMs = 0, chain } = {}) {
  const base = {
    id: item.id,
    sourceId: item.sourceId,
    sourceName: source.name,
    authority: source.authority,
    jurisdiction: source.jurisdiction,
    paywalled: !!source.paywalled,
    url: item.url,
    title: item.title,
    publishedAt: item.publishedAt,
    fetchedAt: item.fetchedAt,
  };
  if (!item.text || item.text.trim().length < 40) {
    return { calls: 0, record: { ...base, status: "headline-only", reason: "no-source-text", provenance: { textSource: item.textSource, extractMethod: item.extractMethod } } };
  }

  const call = (retryNote) =>
    generateWithFallback(ai, { ...(chain ? { chain } : {}), contents: buildUserPrompt({ source, item, retryNote }), config: CONFIG, parse: parseAnalysis });

  let calls = 1;
  let res = await call();
  if (!res.ok) return { calls, record: null, quotaExhausted: !!res.quotaExhausted, error: res.error };
  let a = res.value;
  const provenance = {
    model: res.model,
    promptVersion: PROMPT_VERSION,
    sourceSha256: item.textSha256,
    textChars: item.text.length,
    textSource: item.textSource,
    extractMethod: item.extractMethod,
    analysedAt: new Date().toISOString(),
    attempts: 1,
  };
  if (!a.is_ai_governance) return { calls, record: { ...base, status: "irrelevant", provenance } };

  let grounding = verifyQuotes(a.quotes, item.text);
  if (!grounding.grounded && allowRetry) {
    const failed = grounding.checked.filter((c) => !c.found).map((c) => `"${c.text.slice(0, 80)}" (${c.reason})`);
    if (delayMs) await sleep(delayMs);
    calls++;
    provenance.attempts = 2;
    const retry = await call(
      `A previous attempt was rejected because its quotes were not exact copies of the source text: ${failed.join("; ") || "(missing a quote for summary or for why_it_matters)"}. Copy quotes character for character from the source text, with at least one supporting the summary and one supporting why_it_matters.`,
    );
    if (retry.ok && retry.value.is_ai_governance) {
      a = retry.value;
      provenance.model = retry.model;
      grounding = verifyQuotes(a.quotes, item.text);
    }
  }

  if (grounding.grounded) {
    return {
      calls,
      record: {
        ...base,
        status: "summarised",
        headline: a.headline,
        summary: a.summary,
        why_it_matters: a.why_it_matters,
        quotes: grounding.checked.map(({ text, supports }) => ({ text, supports })),
        dates_mentioned: a.dates_mentioned,
        classification: classificationOf(a),
        provenance,
      },
    };
  }
  // Ungrounded generated text (and any dates it claimed) is discarded — never stored or published.
  return {
    calls,
    record: {
      ...base,
      status: "headline-only",
      reason: "grounding-failed",
      classification: { ...classificationOf(a), closing_date: null },
      grounding: grounding.checked.map(({ found, reason, supports }) => ({ found, reason, supports })),
      provenance,
    },
  };
}
