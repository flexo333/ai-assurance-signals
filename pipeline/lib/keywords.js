// Cheap AI-relevance pre-filter for broad sources (ai_specific: false).
// Runs before any LLM call so Gemini quota isn't spent on unrelated releases.
// Pure and dependency-free; smoke-tested by keywords.test.mjs.

const PATTERNS = [
  /\bA\.?I\.?\b/, // "AI", "A.I." — case-sensitive to avoid "ai" inside words/names
  /\bartificial intelligence\b/i,
  /\bmachine learning\b/i,
  /\bgenerative\b/i,
  /\bGenAI\b/i,
  /\bLLMs?\b/,
  /\blarge language models?\b/i,
  /\bfoundation models?\b/i,
  /\bfrontier models?\b/i,
  /\bautomated decision[- ]making\b/i,
  /\bautomated decisions?\b/i,
  /\balgorithm(s|ic)?\b/i,
  /\bdeepfakes?\b/i,
  /\bchatbots?\b/i,
  /\bguardrails?\b/i,
  /\bneural networks?\b/i,
  /\bfacial recognition\b/i,
  /\bChatGPT|Claude|Gemini|Copilot|OpenAI|Anthropic|DeepMind\b/,
  // AI-assisted engineering, code and data modernisation (#31): posts that name
  // the tool or technique rather than saying "artificial intelligence".
  /\bagentic\b/i,
  /\bAI[- ]assisted\b/i,
  /\b(Amazon )?Bedrock\b/,
  /\bVertex AI\b/,
  /\bAzure OpenAI\b/,
  /\b(GitHub Copilot|Amazon Q Developer|CodeWhisperer|Cursor (IDE|editor|AI))\b/,
  /\bcoding (assistants?|agents?)\b/i,
  /\bcode (translation|conversion|generation)\b/i,
];

/**
 * Per-source pre-filter (sources.yaml `must_match`, #31): a list of regex
 * strings, any of which must match (case-insensitive) the title + feed
 * summary before the item is fetched or sent to Gemini. Used on global vendor
 * feeds so they only spend quota (#21) on items about Australian FS.
 * No `must_match` → everything passes.
 */
export function passesMustMatch(mustMatch, text) {
  const list = [].concat(mustMatch || []).filter(Boolean);
  if (!list.length) return true;
  if (!text) return false;
  return list.some((re) => new RegExp(re, "i").test(text));
}

/** True if the text plausibly concerns AI. */
export function isAiRelated(text) {
  if (!text) return false;
  return PATTERNS.some((re) => re.test(text));
}
