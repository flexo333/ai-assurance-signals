// Gemini call loop with quota-aware model fallback — ported from yt2txt
// (backend/summarise/gemini.js + people-pure.js). Takes `ai` as an argument
// so the loop itself is testable without the SDK or network.

// Free-tier friendly Flash family, best first. A model that 404s or is
// retired is non-retryable and the loop simply advances to the next.
export const MODEL_CHAIN = [
  "models/gemini-flash-latest",
  "models/gemini-2.5-flash",
  "models/gemini-flash-lite-latest",
  "models/gemini-2.5-flash-lite",
];

export function isRetryableModelError(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429 || status === 503 || status === 500) return true;
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("resource_exhausted") ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("unavailable") ||
    msg.includes("overloaded") ||
    msg.includes("high demand") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("empty response")
  );
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`generateContent timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/**
 * Walk the chain; returns { ok: true, model, value, attempts } or
 * { ok: false, error, quotaExhausted, budgetExhausted, attempts }.
 * `attempts` counts every real generateContent request (fallbacks and retries
 * included); `budget` caps them. quotaExhausted = every model failed with a
 * retryable (quota/overload) error — the caller should stop for this run.
 */
export async function generateWithFallback(ai, {
  chain = MODEL_CHAIN,
  contents,
  config,
  attempts = 2,
  backoffMs = (attempt) => 4000 * 2 ** attempt,
  timeoutMs = 90_000,
  parse = (text) => text,
  budget = Infinity,
} = {}) {
  let lastErr;
  let allRetryable = true;
  let used = 0;
  const errors = [];
  for (const model of chain) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (used >= budget) return { ok: false, error: lastErr || new Error("request budget exhausted"), quotaExhausted: false, budgetExhausted: true, attempts: used, errors };
      used++;
      try {
        const res = await withTimeout(ai.models.generateContent({ model, contents, ...(config ? { config } : {}) }), timeoutMs);
        const text = res?.text;
        if (!text) throw new Error("empty response");
        const value = parse(text);
        if (value == null) throw new Error("empty response (unparseable payload)");
        return { ok: true, model, value, attempts: used, errors };
      } catch (err) {
        lastErr = err;
        errors.push({ model, status: err?.status ?? null, message: String(err?.message || err).slice(0, 200) });
        if (!isRetryableModelError(err)) {
          allRetryable = false;
          break;
        }
        if (attempt < attempts - 1) await sleep(backoffMs(attempt));
      }
    }
  }
  return { ok: false, error: lastErr, quotaExhausted: allRetryable, attempts: used, errors };
}
