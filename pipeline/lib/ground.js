// Grounding gate: every quote the model offers must appear verbatim in the
// source text. "Verbatim" tolerates only typographic noise — whitespace,
// curly vs straight quotes, dash variants, ellipsis form and Unicode
// compatibility forms. Case and wording must match.
//
// This is the core guardrail of a fully automated digest (see CLAUDE.md):
// an item whose summary isn't grounded is published headline-only.
// Pure and dependency-free; tested by ground.test.mjs.

export const MIN_QUOTE_CHARS = 20;
export const MIN_QUOTE_WORDS = 4;
export const MAX_QUOTE_CHARS = 400;

export function normaliseForMatch(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param quotes      [{ text, supports }] from the model
 * @param sourceText  the exact text the model was given
 * @returns { grounded, checked: [{ text, supports, found, reason? }] }
 *   grounded = at least one valid quote, every quote found, and both the
 *   summary and why_it_matters are supported by at least one found quote.
 */
export function verifyQuotes(quotes, sourceText) {
  const hay = normaliseForMatch(sourceText);
  const checked = (Array.isArray(quotes) ? quotes : []).map((q) => {
    const text = String(q?.text ?? "").trim();
    const supports = q?.supports === "why_it_matters" ? "why_it_matters" : "summary";
    const norm = normaliseForMatch(text).replace(/^["']|["']$/g, "");
    if (norm.length < MIN_QUOTE_CHARS || norm.split(" ").length < MIN_QUOTE_WORDS) {
      return { text, supports, found: false, reason: "too-short" };
    }
    if (norm.length > MAX_QUOTE_CHARS) return { text, supports, found: false, reason: "too-long" };
    return hay.includes(norm) ? { text, supports, found: true } : { text, supports, found: false, reason: "not-in-source" };
  });
  const covers = (field) => checked.some((c) => c.found && c.supports === field);
  const grounded =
    checked.length > 0 && checked.every((c) => c.found) && covers("summary") && covers("why_it_matters");
  return { grounded, checked };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * A date is grounded when its evidence quote appears verbatim in the source
 * AND the quote actually states that date: the year, the day number, and
 * the month (name, 3-letter abbreviation, or numeric d/m form).
 * Dates feed the consultations tracker and key-dates timeline, so an
 * unsupported date is dropped even when the summary itself is grounded.
 */
export function verifyDate(isoDate, quote, sourceText) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!m) return false;
  const q = normaliseForMatch(quote);
  if (q.split(" ").length < 3 || !normaliseForMatch(sourceText).includes(q)) return false;
  const [, y, mm, dd] = m;
  const day = String(Number(dd));
  const month = MONTHS[Number(mm) - 1];
  const lower = q.toLowerCase();
  if (!lower.includes(y)) return false;
  const numericForm = new RegExp(`(^|\\D)0?${day}[/.-]0?${Number(mm)}[/.-]${y}`).test(lower);
  // Month must be adjacent to the day ("31 January", "6 Feb", "January 31st"),
  // so the verb "may" can't stand in for May.
  const mon = `(?:${month}|${month.slice(0, 3)}\\.?)`;
  const d = `0?${day}(?:st|nd|rd|th)?`;
  const named = new RegExp(`(^|\\D)${d}\\s+(?:of\\s+)?${mon}(\\W|$)|\\b${mon}\\s+${d}(\\D|$)`).test(lower);
  return numericForm || named;
}
