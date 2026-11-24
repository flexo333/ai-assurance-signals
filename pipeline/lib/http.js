// Shared polite HTTP client: honest User-Agent, timeout, per-origin
// robots.txt cache (RFC 9309 semantics via robotsFromResponse).

import { robotsFromResponse } from "./feed-pure.js";

export const USER_AGENT = "AIAssuranceSignalsBot/1.0 (+https://aisignals.willbright.link/about/)";
const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 5_000_000;

export async function get(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body = await res.text();
    if (body.length > MAX_BODY_BYTES) body = body.slice(0, MAX_BODY_BYTES);
    return { ok: res.ok, status: res.status, url: res.url, body, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, url, body: "", error: err.cause?.code || err.name || String(err), ms: Date.now() - started };
  }
}

const robotsCache = new Map();

export function clearRobotsCache() {
  robotsCache.clear();
}

export async function robotsFor(url) {
  const origin = new URL(url).origin;
  if (!robotsCache.has(origin)) {
    robotsCache.set(
      origin,
      get(`${origin}/robots.txt`).then((r) => ({ status: r.status, parsed: robotsFromResponse(r.status, r.body) })),
    );
  }
  return robotsCache.get(origin);
}
