import rss from "@astrojs/rss";
import { loadAll, editionLabel, editionItemCount } from "../lib/data.js";

const esc = (s = "") =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function GET(context) {
  const { editions, itemsById } = loadAll();

  return rss({
    title: "AI Assurance Signals",
    description:
      "A weekly, source-grounded digest of AI assurance and governance developments — Australia first.",
    site: context.site,
    trailingSlash: true,
    xmlns: { atom: "http://www.w3.org/2005/Atom" },
    customData: `<language>en-au</language><atom:link href="${new URL("/rss.xml", context.site)}" rel="self" type="application/rss+xml" />`,
    items: editions.map((e) => {
      const top = e.topSignals.map((r) => itemsById.get(r.id)).filter(Boolean);
      const introText = e.intro?.sentences?.map((s) => s.text).join(" ") || "";
      const topHeadlines = top
        .map((i) => (i.status === "summarised" ? i.headline : i.title))
        .join(" · ");
      const total = editionItemCount(e);
      const link = `/editions/${e.id}/`;
      const fullUrl = new URL(link, context.site).href;

      const description =
        introText ||
        topHeadlines ||
        `${total} items covering AI assurance and governance developments.`;

      const parts = [
        `<p><em>Summaries are AI-generated from the linked sources and may contain errors. Always rely on the original.</em></p>`,
      ];
      if (introText) {
        parts.push(`<p>${esc(introText)}</p>`);
      }
      if (top.length > 0) {
        const list = top
          .map((i) => {
            const headline = i.status === "summarised" ? i.headline : i.title;
            const summary =
              i.status === "summarised" && i.summary ? ` — ${esc(i.summary)}` : "";
            return `<li><a href="${esc(i.url)}">${esc(headline)}</a> (${esc(i.sourceName)})${summary}</li>`;
          })
          .join("");
        parts.push(`<h2>Top Signals</h2><ul>${list}</ul>`);
      }
      parts.push(
        `<p><a href="${esc(fullUrl)}">Read the full ${esc(editionLabel(e.id))} edition (${total} ${total === 1 ? "item" : "items"}, with verbatim source quotes)</a>.</p>`,
      );

      return {
        title: `${editionLabel(e.id)}${e.backfilled ? " (backfilled)" : ""}`,
        link,
        pubDate: new Date(e.publishedAt),
        description,
        content: parts.join(""),
      };
    }),
  });
}
