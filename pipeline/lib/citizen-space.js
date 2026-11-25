// Pure, dependency-free helpers for Delib Citizen Space v2.4 public JSON APIs
// (/api/2.4/json_search_results). Used for official Australian consultation
// hubs (AGD, ACCC, TGA, Health) whose parent corporate sites block bots.
// Tested by citizen-space.test.mjs under `node --test`.

import { stripHtml } from "./text-pure.js";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Parse Citizen Space's "YYYY/MM/DD" (or ISO "YYYY-MM-DD") date string.
 * Returns { isoDay, isoDate, display } where `display` matches Citizen Space's
 * rendered sidebar date format ("11 Dec 2026"), or null if invalid.
 */
export function parseCsDate(raw) {
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(String(raw || "").trim());
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  const year = Number(yyyy);
  const monthIdx = Number(mm) - 1;
  const day = Number(dd);
  const dt = new Date(Date.UTC(year, monthIdx, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== monthIdx || dt.getUTCDate() !== day) {
    return null;
  }
  const isoDay = `${yyyy}-${mm}-${dd}`;
  return {
    isoDay,
    isoDate: `${isoDay}T00:00:00.000Z`,
    display: `${day} ${SHORT_MONTHS[monthIdx]} ${yyyy}`,
  };
}

/**
 * Normalise a Citizen Space consultation URL, stripping the internal Plone
 * `/consult_view` view suffix so links point to the canonical consultation page.
 */
export function cleanCsUrl(rawUrl, baseUrl) {
  if (!rawUrl) return null;
  try {
    const u = baseUrl ? new URL(String(rawUrl).trim(), baseUrl) : new URL(String(rawUrl).trim());
    u.pathname = u.pathname.replace(/\/consult_view\/?$/i, "/");
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Build source text from a Citizen Space API record. Prepends the exact date
 * labels Citizen Space renders in `.cs-consultation-primary-dates-container`
 * ("Closes 11 Dec 2026" / "Closed 18 Sep 2026", "Opened 11 Nov 2026") so
 * `ground.js` (`verifyDate`) can verify closing dates verbatim and match what
 * readers see on the consultation page.
 */
export function formatCitizenSpaceText(entry) {
  const status = String(entry?.status || "").toLowerCase();
  const opened = parseCsDate(entry?.startdate);
  const closes = parseCsDate(entry?.enddate);
  const dateLines = [];
  if (closes) {
    const closeVerb = status === "closed" ? "Closed" : "Closes";
    dateLines.push(`${closeVerb} ${closes.display}`);
  }
  if (opened) {
    const openVerb = status === "forthcoming" ? "Opens" : "Opened";
    dateLines.push(`${openVerb} ${opened.display}`);
  }
  const body = stripHtml(String(entry?.overview || "")).trim();
  return [dateLines.join("\n"), body].filter(Boolean).join("\n\n");
}

// Citizen Space `basic_form` entries are administrative intake forms rather than
// public policy consultations.
const IGNORED_ACTIVITY_TYPES = new Set(["basic_form"]);

/**
 * Parse `/api/2.4/json_search_results` JSON body (or an array of JSON bodies,
 * e.g. merging `?st=open` with `?fields=minimal`) into normalised items,
 * newest `startdate` first. Returns null when no valid JSON array is supplied.
 */
export function parseCitizenSpaceItems(bodyOrBodies, { baseUrl, include, exclude } = {}) {
  const bodies = Array.isArray(bodyOrBodies) ? bodyOrBodies : [bodyOrBodies];
  const rawRecords = [];
  let anyValid = false;
  for (const b of bodies) {
    if (typeof b !== "string" || !b.trim()) continue;
    try {
      const parsed = JSON.parse(b);
      if (Array.isArray(parsed)) {
        anyValid = true;
        rawRecords.push(...parsed);
      }
    } catch {
      /* ignore malformed/truncated response if another succeeded */
    }
  }
  if (!anyValid) return null;

  const inc = include ? new RegExp(include) : null;
  const exc = exclude ? new RegExp(exclude, "i") : null;
  const byLink = new Map();

  for (const r of rawRecords) {
    if (!r || typeof r !== "object") continue;
    const status = String(r.status || "").toLowerCase();
    if (status === "forthcoming") continue;
    const activityType = String(r.activity_type || "").toLowerCase();
    if (IGNORED_ACTIVITY_TYPES.has(activityType)) continue;
    const title = stripHtml(String(r.title || "")).replace(/\s+/g, " ").trim();
    const link = cleanCsUrl(r.url, baseUrl);
    if (!title || !link) continue;
    if (inc && !inc.test(link) && !inc.test(title)) continue;
    if (exc && (exc.test(link) || exc.test(title))) continue;

    const opened = parseCsDate(r.startdate);
    const closes = parseCsDate(r.enddate);
    const overview = stripHtml(String(r.overview || "")).trim();
    const item = {
      title,
      link,
      date: opened?.isoDate || null,
      closingDate: closes?.isoDay || null,
      status: status || null,
      activityType: activityType || null,
      summary: overview ? overview.slice(0, 4000) : null,
      text: formatCitizenSpaceText(r),
    };

    // Prefer entries with richer text or open status when merging open + archive responses.
    const prev = byLink.get(link);
    if (!prev || (item.text.length > prev.text.length) || (item.status === "open" && prev.status !== "open")) {
      byLink.set(link, item);
    }
  }

  return [...byLink.values()].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}
