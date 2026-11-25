// Gemini call loop with quota-aware model fallback — ported from yt2txt
// (backend/summarise/gemini.js + people-pure.js). Takes `ai` as an argument
// so the loop itself is testable without the SDK or network.

// Preferred Flash-family models, best first. The live chain is discovered at
// run time (resolveModelChain) so retired models drop out on their own — the
// first live run hit a 404 on the retired gemini-2.5-flash-lite.
export const PREFERRED_MODELS = [
  "models/gemini-2.5-flash",
  "models/gemini-flash-latest",
  "models/gemini-flash-lite-latest",
];
export const MODEL_CHAIN = PREFERRED_MODELS;

/**
 * Pure: raw models.list() entries → ordered chain of usable Flash text models.
 * Preferred models first (when listed), then other Flash models, newest name first.
 * Free-tier quotas are per model, so a longer chain means more daily capacity.
 */
export function orderModels(rawModels, preferred = PREFERRED_MODELS) {
  const usable = (rawModels || [])
    .filter((m) => m && typeof m.name === "string" && (m.supportedActions || []).includes("generateContent"))
    .map((m) => m.name)
    .filter((n) => {
      const l = n.toLowerCase();
      return l.includes("gemini") && l.includes("flash") && !["tts", "image", "audio", "live", "embedding", "thinking"].some((b) => l.includes(b));
    });
  const set = new Set(usable);
  const head = preferred.filter((p) => set.has(p));
  const rest = usable.filter((n) => !head.includes(n)).sort((a, b) => b.localeCompare(a));
  return [...head, ...rest].slice(0, 6);
}

/** Discover the chain via models.list(); falls back to PREFERRED_MODELS on any failure. */
export async function resolveModelChain(ai) {
  try {
    const raw = [];
    for await (const m of await ai.models.list({})) {
      raw.push(m);
      if (raw.length >= 500) break;
    }
    const chain = orderModels(raw);
    return chain.length ? chain : PREFERRED_MODELS;
  } catch {
    return PREFERRED_MODELS;
  }
}

/**
 * Per-run model health. Pure apart from the injected clock.
 *   404 / "not found" / "no longer available" → dead for the run
 *   429 (quota)                               → exhausted for the run
 *   503 / overloaded                          → cooling down for `cooldownMs`
 */
export class ModelHealth {
  constructor({ cooldownMs = 120_000, now = () => Date.now() } = {}) {
    this.dead = new Set();
    this.exhausted = new Set();
    this.cooling = new Map();
    this.cooldownMs = cooldownMs;
    this.now = now;
  }
  record(errors = []) {
    for (const e of errors) {
      const msg = String(e.message || "").toLowerCase();
      if (e.status === 404 || msg.includes("not found") || msg.includes("no longer available")) this.dead.add(e.model);
      else if (e.status === 429 || msg.includes("quota") || msg.includes("resource_exhausted")) this.exhausted.add(e.model);
      else if (e.status === 503 || e.status === 500 || msg.includes("high demand") || msg.includes("overloaded")) this.cooling.set(e.model, this.now() + this.cooldownMs);
    }
  }
  available(chain) {
    const t = this.now();
    return chain.filter((m) => !this.dead.has(m) && !this.exhausted.has(m) && !((this.cooling.get(m) ?? 0) > t));
  }
  /** ms until the next cooling model is usable again, or null if none can recover this run. */
  nextRecoveryMs(chain) {
    const t = this.now();
    const waits = chain
      .filter((m) => !this.dead.has(m) && !this.exhausted.has(m) && this.cooling.has(m))
      .map((m) => Math.max(0, this.cooling.get(m) - t));
    return waits.length ? Math.min(...waits) : null;
  }
}

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
  attempts = 1, // on overload/quota, moving to the next model beats waiting
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
