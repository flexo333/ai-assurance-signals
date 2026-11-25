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

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_COLLECTION_RE = /^[A-Za-z]+$/;

// The register's timestamps carry no offset and are Canberra local time
// (registrations land in business hours, e.g. `2026-11-25T15:50:25` = 3:50 pm
// AEDT), so they are converted from Australia/Sydney, DST included.
export const LEGISLATION_TZ = "Australia/Sydney";

const tzParts = (t, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
};

/** Offset (ms) of `timeZone` from UTC at instant t. */
const tzOffset = (t, timeZone) => {
  const p = tzParts(t, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
};

/** Wall-clock fields in `timeZone` → UTC epoch ms. */
function zonedToUtc(y, mo, d, h, mi, s, ms, timeZone) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let t = wall - tzOffset(wall, timeZone);
  t = wall - tzOffset(t, timeZone); // second pass settles DST transitions
  return t;
}

/**
 * Convert an ISO timestamp to OPC's Edm.DateTime literal (`yyyy-mm-ddThh:mm:ss`
 * without trailing `Z`, which FrlEnableQuery rejects with HTTP 400), expressed
 * in the register's local time so it compares like-for-like with
 * `asMadeRegisteredAt`.
 */
export function toODataDateTime(iso, timeZone = LEGISLATION_TZ) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const p = tzParts(t, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/**
 * Build the OData `/Titles` query URL for recently registered titles in the
 * given collections (filtered server-side, so Gazettes and notifiable
 * instruments don't use up the page). `skip` pages through the results.
 */
export function buildLegislationQueryUrl({ apiBase = DEFAULT_LEGISLATION_API, since, top = 100, skip = 0, collections = DEFAULT_COLLECTIONS } = {}) {
  const base = String(apiBase || DEFAULT_LEGISLATION_API).replace(/\/+$/, "");
  const params = [];
  const clauses = [];
  const edmSince = toODataDateTime(since);
  if (edmSince) clauses.push(`asMadeRegisteredAt ge ${edmSince}`);
  const cols = [].concat(collections || []).filter((c) => SAFE_COLLECTION_RE.test(String(c)));
  // `in (...)`, not an `or` group: the register's OData parser rejects
  // `date ge … and (collection eq 'A' or collection eq 'B')` with HTTP 400
  // ("Could not find a property named 'A'").
  if (cols.length) clauses.push(`collection in (${cols.map((c) => `'${c}'`).join(",")})`);
  if (clauses.length) params.push(`$filter=${encodeURIComponent(clauses.join(" and "))}`);
  params.push(`$orderby=${encodeURIComponent("asMadeRegisteredAt desc")}`);
  params.push(`$top=${Math.max(1, Math.min(200, Number(top) || 100))}`);
  if (Number(skip) > 0) params.push(`$skip=${Math.floor(Number(skip))}`);
  params.push("$select=id,name,makingDate,asMadeRegisteredAt,collection,subCollection,isPrincipal,optionalSeriesNumber");
  return `${base}/Titles?${params.join("&")}`;
}

/**
 * Parse one OData response page: `{ rows, nextLink }`, or null when the payload
 * is not OData JSON.
 */
export function parseODataPage(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText ?? ""));
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.value)) return null;
  const next = data["@odata.nextLink"];
  return { rows: data.value, nextLink: typeof next === "string" && next ? next : null };
}

/**
 * Parse an OData timestamp as a UTC ISO string. Values with an explicit offset
 * or `Z` are taken as given; offset-less values are wall-clock time in
 * `timeZone` (the register's local time). Pass `timeZone: "UTC"` for
 * date-only fields such as `makingDate` (`2026-11-24T00:00:00`), so the
 * calendar day is kept.
 */
export function parseODataDate(raw, { timeZone = LEGISLATION_TZ } = {}) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (/(?:Z|[+-]\d\d:\d\d)$/i.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", sec = "0", ms = "0"] = m;
  const args = [+y, +mo, +d, +h, +mi, +sec, Number(ms.padEnd(3, "0"))];
  const t = timeZone === "UTC" ? Date.UTC(args[0], args[1] - 1, ...args.slice(2)) : zonedToUtc(...args, timeZone);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
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
 * Turn OData `/Titles` rows (or one JSON response's text) into candidate
 * legislation entries. Returns `null` when given text that is not OData JSON.
 */
export function parseLegislationTitles(
  jsonOrRows,
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
  const rows = Array.isArray(jsonOrRows) ? jsonOrRows : parseODataPage(jsonOrRows)?.rows;
  if (!rows) return null;

  const origin = new URL(webBase).origin;
  const allowedCollections = new Set(collections);
  const inc = include ? new RegExp(include, "i") : null;
  const exc = exclude ? new RegExp(exclude, "i") : null;
  const out = [];
  const seenIds = new Set();

  for (const row of rows) {
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

    const makingDate = parseODataDate(row.makingDate, { timeZone: "UTC" });
    const date = parseODataDate(row.asMadeRegisteredAt) || makingDate;
    if (!date) continue;
    if (since && date < since) continue;
    if (known.has(idOf(url))) continue;

    out.push({
      registerId: regId,
      title,
      url,
      link: url,
      date,
      makingDate,
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
 * True when a www.legislation.gov.au response is the Angular application
 * shell (served for routes with no static document) rather than EPUB XHTML.
 */
export function isLegislationAppShell(html) {
  return /<app-root[\s>]|\bng-version=/i.test(String(html || ""));
}
