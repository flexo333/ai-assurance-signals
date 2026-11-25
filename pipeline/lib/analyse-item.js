// Per-item analysis: one Gemini call (classify + summarise), the grounding
// gate, and one corrective retry. Returns the record to store (or null when
// the model call failed and the item should be retried on a later run).
// `ai` is injected so this is testable with a fake client.

import { verifyQuotes, verifyDate } from "./ground.js";
import { generateWithFallback, sleep } from "./gemini.js";
import { SYSTEM_PROMPT, ANALYSIS_SCHEMA, PROMPT_VERSION, parseAnalysis, buildUserPrompt } from "./prompt.js";

const CONFIG = {
  systemInstruction: SYSTEM_PROMPT,
  responseMimeType: "application/json",
  responseSchema: ANALYSIS_SCHEMA,
  temperature: 0.2,
};

// Dates feed the consultations tracker and key-dates timeline, so each must be
// stated in a verbatim source quote (verifyDate) — otherwise it is dropped,
// even when the summary itself is grounded.
const groundedDates = (a, text) => ({
  closing_date: a.closing_date && verifyDate(a.closing_date, a.closing_date_quote, text) ? a.closing_date : null,
  closing_date_quote: a.closing_date && verifyDate(a.closing_date, a.closing_date_quote, text) ? a.closing_date_quote : null,
  dates_mentioned: (a.dates_mentioned || []).filter((d) => verifyDate(d.date, d.quote, text)),
});

const classificationOf = (a) => ({
  item_kind: a.item_kind,
  is_financial_services: a.is_financial_services,
  theme: a.theme,
  audiences: a.audiences,
  au_relevance: a.au_relevance,
  significance: a.significance,
  significance_reason: a.significance_reason,
  is_consultation: a.is_consultation,
  closing_date: a.closing_date,
});

/**
 * @param budget  max real Gemini requests this item may use (fallbacks/retries count)
 * @returns { record, calls, quotaExhausted, error }
 *   calls = real generateContent requests made. record.status: "summarised" |
 *   "headline-only" | "irrelevant" | "unvetted" (no source text); record null on model failure.
 */
export async function analyseItem(ai, { source, item, allowRetry = true, delayMs = 0, chain, budget = Infinity, beforeCall } = {}) {
  const base = {
    id: item.id,
    sourceId: item.sourceId,
    sourceName: source.name,
    authority: source.authority,
    jurisdiction: source.jurisdiction,
    ...(source.sector ? { sector: source.sector } : {}),
    paywalled: !!source.paywalled,
    url: item.url,
    title: item.title,
    publishedAt: item.publishedAt,
    fetchedAt: item.fetchedAt,
  };
  // No text means no relevance check is possible: store as "unvetted" (so it
  // isn't re-fetched) but never publish it — not even headline-only.
  if (!item.text || item.text.trim().length < 40) {
    return { calls: 0, record: { ...base, status: "unvetted", reason: "no-source-text", provenance: { textSource: item.textSource, extractMethod: item.extractMethod } } };
  }

  let calls = 0;
  const modelErrors = [];
  const call = async (retryNote) => {
    const r = await generateWithFallback(ai, {
      ...(chain ? { chain } : {}),
      contents: buildUserPrompt({ source, item, retryNote }),
      config: CONFIG,
      parse: parseAnalysis,
      budget: budget - calls,
      beforeCall,
    });
    calls += r.attempts ?? 0;
    modelErrors.push(...(r.errors || []));
    return r;
  };

  let res = await call();
  if (!res.ok) return { calls, modelErrors, record: null, quotaExhausted: !!res.quotaExhausted, error: res.error };
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
    ...(item.seed ? { via: item.seed } : {}),
  };
  if (!a.is_ai_governance) return { calls, modelErrors, record: { ...base, status: "irrelevant", provenance } };

  let grounding = verifyQuotes(a.quotes, item.text);
  if (!grounding.grounded && allowRetry && calls < budget) {
    const failed = grounding.checked.filter((c) => !c.found).map((c) => `"${c.text.slice(0, 80)}" (${c.reason})`);
    if (delayMs) await sleep(delayMs);
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
    const dates = groundedDates(a, item.text);
    return {
      calls,
      modelErrors,
      record: {
        ...base,
        status: "summarised",
        headline: a.headline,
        summary: a.summary,
        why_it_matters: a.why_it_matters,
        quotes: grounding.checked.map(({ text, supports }) => ({ text, supports })),
        dates_mentioned: dates.dates_mentioned,
        classification: { ...classificationOf(a), closing_date: dates.closing_date, closing_date_quote: dates.closing_date_quote },
        provenance,
      },
    };
  }
  // Ungrounded generated text (and any dates it claimed) is discarded — never stored or published.
  return {
    calls,
    modelErrors,
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
