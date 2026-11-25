// Article HTML → main text, via Mozilla Readability over a linkedom DOM.
// Falls back to the page's <meta name="description"> when Readability finds
// nothing usable (common on JS-heavy pages).

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { stripHtml } from "./text-pure.js";

const MIN_ARTICLE_CHARS = 400;

export function extractMainText(html, url) {
  try {
    const { document } = parseHTML(html);
    try {
      // Readability resolves relative links against the document URL.
      const base = document.createElement("base");
      base.setAttribute("href", url);
      document.head?.appendChild(base);
    } catch {
      /* best effort */
    }
    const meta =
      document.querySelector('meta[name="description"]')?.getAttribute("content") ||
      document.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
      "";
    // Readability mutates the DOM, so take the fallback text first (from a fresh parse).
    const fallback = mainTextFallback(html);
    const article = new Readability(document, { charThreshold: 200 }).parse();
    const text = article?.textContent ? stripHtml(article.content || "") || article.textContent : "";
    const clean = text.replace(/\n{3,}/g, "\n\n").trim();
    if (clean.length >= MIN_ARTICLE_CHARS) {
      return { text: clean, title: article.title || null, method: "readability" };
    }
    // Readability misses some CMS layouts (e.g. APRA's Drupal paragraph fields).
    if (fallback.length >= MIN_ARTICLE_CHARS) {
      return { text: fallback, title: article?.title || null, method: "main-text" };
    }
    return { text: meta.trim(), title: article?.title || null, method: meta ? "meta-description" : "none" };
  } catch (err) {
    return { text: "", title: null, method: "error", error: String(err) };
  }
}

/**
 * Standfirst only — for paywalled sources. Returns the page's meta/og
 * description and nothing from the body (headline + standfirst policy).
 */
export function extractStandfirst(html) {
  try {
    const { document } = parseHTML(html);
    const meta =
      document.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
      document.querySelector('meta[name="description"]')?.getAttribute("content") ||
      document.querySelector('meta[name="twitter:description"]')?.getAttribute("content") ||
      "";
    return stripHtml(meta).trim();
  } catch {
    return "";
  }
}

/**
 * Publication date from page metadata (ISO string) or null. Checks, in order:
 * article:published_time, dcterms.issued / DC.date.issued / dcterms.date /
 * DC.date, JSON-LD datePublished, microdata datePublished, then the first <time datetime>.
 */
export function extractPublished(html) {
  try {
    const { document } = parseHTML(html);
    const meta = (sel) => document.querySelector(sel)?.getAttribute("content");
    const candidates = [
      meta('meta[property="article:published_time"]'),
      meta('meta[name="publication-date"]'), // AICD AEM
      meta('meta[name="displayDate"]'), // ASIC: "25 November 2026"
      meta('meta[name="display-date"]'), // AICD AEM
      meta('meta[name="dcterms.issued"]'),
      meta('meta[name="dcterms.date.created"]'), // ASIC: page created = release date
      meta('meta[name="DC.date.issued"]'),
      meta('meta[name="dcterms.date"]'),
      meta('meta[name="DC.date"]'),
      meta('meta[name="date"]'),
    ];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const m = String(s.textContent || "").match(/"datePublished"\s*:\s*"([^"]+)"/);
      if (m) candidates.push(m[1]);
    }
    // Microdata (e.g. iTnews: <span itemprop="datePublished" content="…">).
    const micro = document.querySelector('[itemprop="datePublished"]');
    candidates.push(micro?.getAttribute("content") || micro?.getAttribute("datetime"));
    candidates.push(document.querySelector("time[datetime]")?.getAttribute("datetime"));
    for (const c of candidates) {
      const iso = parseDateString(c);
      if (iso) return iso;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** "25 November 2026" (as UTC midnight) or any Date.parse-able string → ISO, else null. */
export function parseDateString(c) {
  if (!c) return null;
  const m = String(c).trim().match(/^(\d{1,2}) ([A-Za-z]+),? (\d{4})$/);
  const t = m ? Date.parse(`${m[1]} ${m[2]} ${m[3]} 00:00:00 UTC`) : Date.parse(c);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Page title: og:title, then <title> (site suffix after " | " or " - " trimmed). */
export function extractTitle(html) {
  try {
    const { document } = parseHTML(html);
    const og = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    // Zero-width characters (e.g. ANZ's titles) stripped.
    const t = (og || document.querySelector("title")?.textContent || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
    return t.replace(/\s+[|\u2013\u2014-]\s+[^|\u2013\u2014-]{2,60}$/, "").trim() || null;
  } catch {
    return null;
  }
}

const CHROME = "script, style, noscript, template, svg, header, nav, footer, aside, form, iframe, " +
  '[role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"], ' +
  '[class*="menu"], [class*="breadcrumb"], [class*="skip-link"], [class*="cookie"], [class*="share"], [class*="related"]';

/** Main-content text with page chrome removed: main / article / [role=main] / body. */
export function mainTextFallback(html) {
  try {
    const { document } = parseHTML(html);
    for (const el of [...document.querySelectorAll(CHROME)]) el.remove();
    const root = document.querySelector("main") || document.querySelector('[role="main"]') || document.querySelector("article") || document.body;
    if (!root) return "";
    // Block elements → line breaks, so paragraphs don't run together.
    for (const el of root.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, tr, div, section, br")) el.after(document.createTextNode("\n"));
    return String(root.textContent || "")
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return "";
  }
}

const MONTHS_RE = "January|February|March|April|May|June|July|August|September|Sept|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

/** First "D Month YYYY" in the opening of the given text (visible page date), as ISO date. */
export function firstVisibleDate(text, within = 1500) {
  const m = String(text || "").slice(0, within).match(new RegExp(`\\b(\\d{1,2}) (${MONTHS_RE}),? (20\\d{2})\\b`));
  if (!m) return null;
  const normMonth = m[2] === "Sept" ? "Sep" : m[2];
  const t = Date.parse(`${m[1]} ${normMonth} ${m[3]} 00:00:00 UTC`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Date shown next to a "Published" / "Release date" / "Date published" /
 * "Issued" / "Date" label in the page (e.g. APRA's "Published | 12 November 2026"
 * pill). Works on raw HTML: tags are flattened to spaces first.
 */
export function labelledDate(html) {
  const text = String(html || "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const re = new RegExp(`\\b(?:Published|Release date|Date published|Date issued|Issued|Released|Date)\\s*:?\\s*(\\d{1,2}) (${MONTHS_RE}),? (20\\d{2})\\b`, "i");
  const m = text.match(re);
  if (!m) return null;
  const normMonth = /^sept$/i.test(m[2]) ? "Sep" : m[2];
  const t = Date.parse(`${m[1]} ${normMonth} ${m[3]} 00:00:00 UTC`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Best publication date: metadata, then a labelled date, then the first visible date in main text. */
export function pagePublished(html, mainText) {
  return extractPublished(html) || labelledDate(html) || firstVisibleDate(mainText || mainTextFallback(html));
}
