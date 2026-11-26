// Gemini call loop with quota-aware model fallback — ported from yt2txt
// (backend/summarise/gemini.js + people-pure.js). Takes `ai` as an argument
// so the loop itself is testable without the SDK or network.

// Free-tier reality (AI Studio rate-limit page, Nov 2026):
//   Flash Lite models (3.5, 3.1) ... 15 RPM, 500 RPD each  ← where the capacity is
//   Flash models (3.8, 3.6, 3, 2.5, 4 Hydrogen) ... 5 RPM, 20 RPD each
//   omni / image / TTS / live / robotics ... 0 or unsuitable
// So the chain leads with Flash Lite (newest first), then Flash as a small
// fallback. The grounding gate, not the model tier, is the quality guarantee.
// The first live run lost 20 items to a retired model and a list sorted by name.
export const PREFERRED_MODELS = [
  "models/gemini-3.5-flash-lite",
  "models/gemini-3.1-flash-lite",
  "models/gemini-flash-lite-latest",
  "models/gemini-3.8-flash",
  "models/gemini-2.5-flash",
];
export const MODEL_CHAIN = PREFERRED_MODELS;

// Retired models that models.list() still advertises with generateContent but
// that answer 404 "no longer available" (2.5 Flash Lite, Nov 2026). Dropped
// from the discovered chain so no run wastes a call finding out. Exact ids.
export const RETIRED_MODELS = new Set(["models/gemini-2.5-flash-lite"]);

const EXCLUDE = ["tts", "image", "audio", "live", "embedding", "thinking", "omni", "robotics", "transcribe", "banana", "native", "computer"];

/** Free-tier requests per minute for a model id (used for per-model pacing). */
export function rpmFor(model) {
  return /flash-lite/i.test(model) ? 15 : 5;
}

/**
 * Pure: raw models.list() entries → ordered chain of usable text models.
 * Order: Flash Lite before Flash (500 vs 20 RPD on the free tier), newer
 * version first, versioned ids before "-latest" aliases, previews last.
 */
export function orderModels(rawModels) {
  const usable = (rawModels || [])
    .filter((m) => m && typeof m.name === "string" && (m.supportedActions || []).includes("generateContent"))
    .map((m) => m.name)
    .filter((n) => !RETIRED_MODELS.has(n))
    .filter((n) => {
      const l = n.toLowerCase();
      return l.includes("gemini") && l.includes("flash") && !EXCLUDE.some((b) => l.includes(b));
    });
  const key = (n) => {
    const l = n.toLowerCase();
    const v = parseFloat((l.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
    return {
      tier: l.includes("flash-lite") ? 0 : 1,
      preview: /preview|exp/.test(l) ? 1 : 0,
      alias: l.includes("latest") ? 1 : 0,
      v,
    };
  };
  return [...new Set(usable)]
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka.tier - kb.tier || ka.preview - kb.preview || ka.alias - kb.alias || kb.v - ka.v || a.localeCompare(b);
    })
    .slice(0, 10);
}

/** Spaces calls to each model at or below its free-tier RPM. `sleep` and clock injectable for tests. */
export class Pacer {
  constructor({ now = () => Date.now(), sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)), headroom = 1.15 } = {}) {
    this.last = new Map();
    this.now = now;
    this.sleep = sleepFn;
    this.headroom = headroom;
  }
  intervalMs(model) {
    return Math.ceil((60_000 / rpmFor(model)) * this.headroom);
  }
  async wait(model) {
    const prev = this.last.get(model);
    if (prev != null) {
      const due = prev + this.intervalMs(model) - this.now();
      if (due > 0) await this.sleep(due);
    }
    this.last.set(model, this.now());
  }
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
  beforeCall, // async (model) => void — e.g. Pacer.wait
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
        if (beforeCall) await beforeCall(model);
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
