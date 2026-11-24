// "This week" paragraph: generated only from the Top Signals' grounded
// summaries, then mechanically checked. Pure; tested by intro.test.mjs.
//
// Check: every sentence ends with one or more [n] citations to valid Top
// Signals, and every number in a sentence appears in a cited item's
// headline/summary/why_it_matters. Fail → the edition ships without an intro.

export const INTRO_PROMPT = `Write the opening paragraph for this week's edition of "AI Assurance Signals" (Australian AI assurance and governance digest).

Rules:
- 3 to 5 sentences, plain Australian English, neutral tone, no hype.
- Use ONLY the facts in the numbered items below. Do not add context, numbers, names or dates that are not in them.
- End EVERY sentence with the number(s) of the item(s) it draws on, in square brackets, e.g. "... guidance [1]." or "... [2][3]."
- Lead with what matters most for organisations governing AI in Australia.

Return only the paragraph.`;

export function buildIntroInput(items) {
  return items
    .map((it, k) => `[${k + 1}] ${it.headline}\nSource: ${it.sourceName} (${it.authority})\nSummary: ${it.summary}\nWhy it matters: ${it.why_it_matters}`)
    .join("\n\n");
}

const splitSentences = (text) =>
  String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    // A sentence ends at . ! or ? (before or after its [n] citations) followed
    // by whitespace or end of text — so "version 1.1" doesn't split.
    .match(/.+?(?:(?:\s*\[\d+\])+\s*[.!?]|[.!?](?:\s*\[\d+\])*)(?=\s|$)/g) || [];

// Numeric tokens, with trailing sentence punctuation removed ("1.1." → "1.1").
const numbers = (text) => (String(text).match(/\d[\d,.]*\d|\d/g) || []).map((n) => n.replace(/[.,]+$/, ""));

export function checkIntro(text, items) {
  const sentences = splitSentences(text).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 2 || sentences.length > 7) return { ok: false, reason: `sentence-count:${sentences.length}` };
  const parsed = [];
  for (const s of sentences) {
    const cites = [...s.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    if (!cites.length) return { ok: false, reason: "uncited-sentence", sentence: s };
    if (cites.some((n) => n < 1 || n > items.length)) return { ok: false, reason: "bad-citation", sentence: s };
    const body = s.replace(/\[\d+\]/g, "");
    const pool = cites.map((n) => `${items[n - 1].headline} ${items[n - 1].summary} ${items[n - 1].why_it_matters}`).join(" ");
    // Compare whole numeric tokens: "60" must not pass because "600" is cited.
    const supported = new Set(numbers(pool));
    for (const num of numbers(body)) {
      if (!supported.has(num)) return { ok: false, reason: `unsupported-number:${num}`, sentence: s };
    }
    parsed.push({ text: body.replace(/\s+([.!?])/g, "$1").trim(), cites: [...new Set(cites)].map((n) => items[n - 1].id) });
  }
  return { ok: true, sentences: parsed };
}
