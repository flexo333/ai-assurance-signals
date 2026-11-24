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
];

/** True if the text plausibly concerns AI. */
export function isAiRelated(text) {
  if (!text) return false;
  return PATTERNS.some((re) => re.test(text));
}
