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
    const article = new Readability(document, { charThreshold: 200 }).parse();
    const text = article?.textContent ? stripHtml(article.content || "") || article.textContent : "";
    const clean = text.replace(/\n{3,}/g, "\n\n").trim();
    if (clean.length >= MIN_ARTICLE_CHARS) {
      return { text: clean, title: article.title || null, method: "readability" };
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
