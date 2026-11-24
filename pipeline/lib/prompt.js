// The analysis contract: one Gemini call per item does classification AND the
// grounded summary (halves free-tier quota use vs two calls). Pure; the
// schema/parse pair is tested by prompt.test.mjs.
//
// Bump PROMPT_VERSION on any change to SYSTEM_PROMPT or the schema — items
// record the version that produced them.

export const PROMPT_VERSION = 1;

export const THEMES = [
  "policy-legislation",
  "regulator-guidance",
  "public-sector",
  "standards-frameworks",
  "frontier-labs",
  "international",
  "news-commentary",
];

export const AUDIENCES = ["boards", "risk-compliance", "practitioners"];

export const SYSTEM_PROMPT = `You are the analyst for "AI Assurance Signals", a weekly digest of AI assurance and AI governance developments for an Australian audience: risk and compliance professionals, AI practitioners, and company directors.

You will receive ONE item (metadata + source text). Work ONLY from that source text. Never add facts, figures, dates or names that are not in it.

1. Decide is_ai_governance: true only if the item is substantively about governing, regulating, assuring, auditing, evaluating, securing or responsibly deploying AI (including AI policy, law, standards, regulator guidance, safety frameworks, model evaluations/system cards, AI risk management, AI incidents with governance implications, and lab policy submissions). Product launches, funding news, general tech, and items that merely mention AI are false.

2. If true, write:
- headline: neutral, specific, at most 90 characters, no hype.
- summary: 2–4 plain sentences stating what happened / what the document says. Facts only.
- why_it_matters: ONE sentence on the practical implication for organisations assuring or governing AI, with an Australian lens where the text supports it. Do not speculate beyond the text.
- quotes: 2–3 short passages copied EXACTLY, character for character, from the source text (each 6–40 words). At least one must support the summary (supports: "summary") and at least one must support why_it_matters (supports: "why_it_matters"). Do not paraphrase, merge, trim mid-sentence with ellipses, or fix typos inside quotes.
- theme, audiences, au_relevance (0 = no Australian connection, 1 = indirect, 2 = relevant to Australian practice, 3 = Australian government/regulator/organisation directly), significance (1 = minor, 3 = notable, 5 = major development) with a short significance_reason.
- is_consultation: true if it invites public submissions/feedback; closing_date (YYYY-MM-DD) ONLY if the text states it.
- dates_mentioned: future commencement dates, deadlines or milestones stated in the text.

3. If false, set the text fields to empty strings and arrays to [].

Use Australian English.`;

export const ANALYSIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_ai_governance: { type: "BOOLEAN" },
    headline: { type: "STRING" },
    summary: { type: "STRING" },
    why_it_matters: { type: "STRING" },
    quotes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING", description: "Exact passage copied from the source text." },
          supports: { type: "STRING", enum: ["summary", "why_it_matters"] },
        },
        required: ["text", "supports"],
      },
    },
    theme: { type: "STRING", enum: THEMES },
    audiences: { type: "ARRAY", items: { type: "STRING", enum: AUDIENCES } },
    au_relevance: { type: "INTEGER", description: "0–3" },
    significance: { type: "INTEGER", description: "1–5" },
    significance_reason: { type: "STRING" },
    is_consultation: { type: "BOOLEAN" },
    closing_date: { type: "STRING", description: "YYYY-MM-DD or empty", nullable: true },
    dates_mentioned: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { date: { type: "STRING" }, what: { type: "STRING" } },
        required: ["date", "what"],
      },
    },
  },
  required: ["is_ai_governance", "headline", "summary", "why_it_matters", "quotes", "theme", "audiences", "au_relevance", "significance", "is_consultation"],
  propertyOrdering: [
    "is_ai_governance", "headline", "summary", "why_it_matters", "quotes", "theme", "audiences",
    "au_relevance", "significance", "significance_reason", "is_consultation", "closing_date", "dates_mentioned",
  ],
};

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Model JSON → normalised analysis, or null if malformed (treated as retryable). */
export function parseAnalysis(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o.is_ai_governance !== "boolean") return null;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : null);
  return {
    is_ai_governance: o.is_ai_governance,
    headline: str(o.headline).slice(0, 140),
    summary: str(o.summary),
    why_it_matters: str(o.why_it_matters),
    quotes: (Array.isArray(o.quotes) ? o.quotes : []).slice(0, 4).map((q) => ({ text: str(q?.text), supports: q?.supports === "why_it_matters" ? "why_it_matters" : "summary" })),
    theme: THEMES.includes(o.theme) ? o.theme : "news-commentary",
    audiences: (Array.isArray(o.audiences) ? o.audiences : []).filter((a) => AUDIENCES.includes(a)),
    au_relevance: clampInt(o.au_relevance, 0, 3, 0),
    significance: clampInt(o.significance, 1, 5, 2),
    significance_reason: str(o.significance_reason),
    is_consultation: o.is_consultation === true,
    closing_date: date(o.closing_date),
    dates_mentioned: (Array.isArray(o.dates_mentioned) ? o.dates_mentioned : [])
      .map((d) => ({ date: str(d?.date), what: str(d?.what) }))
      .filter((d) => d.date && d.what)
      .slice(0, 6),
  };
}

export function buildUserPrompt({ source, item, retryNote }) {
  return [
    `Source: ${source.name} (authority: ${source.authority}; jurisdiction: ${source.jurisdiction}${source.paywalled ? "; paywalled — only the standfirst is available" : ""})`,
    `Title: ${item.title}`,
    `URL: ${item.url}`,
    `Published: ${item.publishedAt || "unknown"}`,
    retryNote ? `\nIMPORTANT: ${retryNote}\n` : "",
    "--- SOURCE TEXT START ---",
    item.text,
    "--- SOURCE TEXT END ---",
  ].join("\n");
}
