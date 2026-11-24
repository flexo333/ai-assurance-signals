// Pure text/URL helpers shared by the collector (Lambda) and the processor
// (Actions). Only node: builtins — no npm deps. Tested by text-pure.test.mjs.

import { createHash } from "node:crypto";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };

export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** HTML fragment → plain text (for feed descriptions; articles use Readability). */
export function stripHtml(html) {
  return decodeEntities(
    String(html ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const TRACKING = /^(utm_|mc_|fbclid$|gclid$|ref$|ref_src$|cmpid$|itm_)/i;

/** Canonical form for dedupe/ids: https, no fragment, no tracking params, no trailing slash. */
export function canonicalUrl(raw) {
  const u = new URL(String(raw).trim());
  u.hash = "";
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  let s = u.toString();
  if (u.pathname !== "/" && s.endsWith("/") && !u.search) s = s.slice(0, -1);
  return s;
}

/** Stable 16-hex item id from the canonical URL. */
export function itemId(url) {
  return createHash("sha256").update(canonicalUrl(url)).digest("hex").slice(0, 16);
}

export function sha256(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex");
}

export function truncate(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "") + " …";
}
