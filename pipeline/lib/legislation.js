// Federal Register of Legislation (OPC OData v4 REST API) — pure, dependency-free.
// Tested by legislation.test.mjs.
//
// www.legislation.gov.au is an Angular SPA whose HTML routes contain only the
// application shell, backed by the Office of Parliamentary Counsel's public
// OData v4 API at https://api.prod.legislation.gov.au/v1/ and static EPUB XHTML
// documents at https://www.legislation.gov.au/<id>/asmade/latest/<kind>/original/epub/OEBPS/document_1/document_1.html.

export const DEFAULT_LEGISLATION_API = "https://api.prod.legislation.gov.au/v1";
export const DEFAULT_LEGISLATION_WEB = "https://www.legislation.gov.au";
export const DEFAULT_COLLECTIONS = ["Act", "LegislativeInstrument"];

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Convert an ISO timestamp to OPC's Edm.DateTime literal (`yyyy-mm-ddThh:mm:ss`
 * without trailing `Z`, which FrlEnableQuery rejects with HTTP 400).
 */
export function toODataDateTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 19);
}

/**
 * Build the OData `/Titles` query URL for recently registered titles.
 */
export function buildLegislationQueryUrl({ apiBase = DEFAULT_LEGISLATION_API, since, top = 100 } = {}) {
  const base = String(apiBase || DEFAULT_LEGISLATION_API).replace(/\/+$/, "");
  const params = [];
  const edmSince = toODataDateTime(since);
  if (edmSince) params.push(`$filter=${encodeURIComponent(`asMadeRegisteredAt ge ${edmSince}`)}`);
  params.push(`$orderby=${encodeURIComponent("asMadeRegisteredAt desc")}`);
  params.push(`$top=${Math.max(1, Math.min(200, Number(top) || 100))}`);
  params.push("$select=id,name,makingDate,asMadeRegisteredAt,collection,subCollection,isPrincipal,optionalSeriesNumber");
  return `${base}/Titles?${params.join("&")}`;
}

/**
 * Parse an OData timestamp (`2026-11-25T15:50:25.5796156` or ISO) as UTC ISO string.
 */
export function parseODataDate(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const normalised = /(?:Z|[+-]\d\d:\d\d)$/i.test(s)
    ? s
    : s.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3})\d*)?$/, (_, head, ms) => `${head}.${(ms || "0").padEnd(3, "0")}Z`);
  const t = Date.parse(normalised);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function formatDayMonthYear(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Candidate static XHTML document URLs on www.legislation.gov.au for a title.
 * Legislative Instruments publish Explanatory Statements (`es`) that explain
 * policy intent, authority and human-rights impacts in plain English, plus primary
 * text (`text`). Acts publish primary `text` under `asmade`.
 */
export function legislationDocUrls(id, collection, webBase = DEFAULT_LEGISLATION_WEB) {
  const origin = new URL(webBase).origin;
  const kinds = collection === "LegislativeInstrument" ? ["es", "text"] : ["text"];
  return kinds.map((k) => `${origin}/${id}/asmade/latest/${k}/original/epub/OEBPS/document_1/document_1.html`);
}

/**
 * Parse OData `/Titles` JSON response into candidate legislation entries.
 * Returns `null` when the payload is not valid OData JSON.
 */
export function parseLegislationTitles(
  jsonText,
  {
    webBase = DEFAULT_LEGISLATION_WEB,
    collections = DEFAULT_COLLECTIONS,
    include,
    exclude,
    since,
    known = new Set(),
    idOf = (u) => u,
    limit = 25,
  } = {},
) {
  let data;
  try {
    data = JSON.parse(String(jsonText ?? ""));
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.value)) return null;

  const origin = new URL(webBase).origin;
  const allowedCollections = new Set(collections);
  const inc = include ? new RegExp(include, "i") : null;
  const exc = exclude ? new RegExp(exclude, "i") : null;
  const out = [];
  const seenIds = new Set();

  for (const row of data.value) {
    if (!row || typeof row !== "object") continue;
    const regId = String(row.id || "").trim();
    const title = String(row.name || "").replace(/\s+/g, " ").trim();
    const collection = String(row.collection || "").trim();
    if (!regId || !SAFE_ID_RE.test(regId) || !title || seenIds.has(regId)) continue;
    seenIds.add(regId);
    if (allowedCollections.size && !allowedCollections.has(collection)) continue;

    const url = `${origin}/${regId}`;
    const hay = `${url}\n${title}`;
    if (inc && !inc.test(hay)) continue;
    if (exc && exc.test(hay)) continue;

    const date = parseODataDate(row.asMadeRegisteredAt) || parseODataDate(row.makingDate);
    if (!date) continue;
    if (since && date < since) continue;
    if (known.has(idOf(url))) continue;

    out.push({
      registerId: regId,
      title,
      url,
      link: url,
      date,
      makingDate: parseODataDate(row.makingDate),
      collection,
      subCollection: row.subCollection ? String(row.subCollection).trim() : null,
      seriesNumber: row.optionalSeriesNumber ? String(row.optionalSeriesNumber).trim() : null,
      docUrls: legislationDocUrls(regId, collection, origin),
    });
  }

  out.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return out.slice(0, limit);
}

/**
 * Format grounded header metadata prepended to the extracted Explanatory
 * Statement or primary legislation text.
 */
export function formatLegislationText(entry, bodyText = "") {
  const kindLabel = entry.collection === "LegislativeInstrument" ? "Legislative Instrument" : entry.collection || "Legislation";
  const lines = [
    entry.title,
    `Federal Register of Legislation — ${kindLabel} (${entry.registerId})`,
  ];
  const regDay = formatDayMonthYear(entry.date);
  if (regDay) lines.push(`Registered ${regDay}`);
  const madeDay = formatDayMonthYear(entry.makingDate);
  if (madeDay) lines.push(`Made ${madeDay}`);
  if (entry.subCollection) lines.push(`Type: ${entry.subCollection}`);
  if (bodyText) lines.push("", String(bodyText).trim());
  return lines.join("\n").trim();
}
