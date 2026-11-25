// Story clustering — pure. Groups items that report the same event so an
// edition shows one card per story. Cheap heuristics, no API calls.
// Tested by cluster.test.mjs.
//
// Two items are the same story when all of these hold:
//   - different sources (one outlet's follow-ups stay separate)
//   - published within DATE_WINDOW_DAYS of each other
//   - their titles/headlines share at least one distinctive word (not a
//     corpus-wide topic word such as "governance", nor a headline verb such
//     as "releases")
//   - Jaccard similarity of their content words (title, headline, summary)
//     is at least SIMILARITY_THRESHOLD
// Stories are the connected components of that relation (single link).
//
// Tuned on the first collected weeks (2026-W44..W48): true pairs scored
// 0.094–0.150 and passed the title gate; the highest unrelated pair that
// passed the gate scored 0.080. Summary text alone does not separate them:
// unrelated items share generic summary vocabulary, which the title gate
// filters out. See docs/DECISIONS.md.

export const AUTHORITY_RANK = { official: 0, standards: 1, lab: 2, research: 3, news: 4 };

export const SIMILARITY_THRESHOLD = 0.09;
export const DATE_WINDOW_DAYS = 3;
/** Ranking boost per extra independent source, capped. */
export const SOURCE_BOOST = 0.05;
export const SOURCE_BOOST_MAX = 0.15;

const words = (s) => s.split(/\s+/).filter(Boolean);

// Function words, plus words so common in this corpus that they say nothing
// about which event an item reports.
const STOP = new Set(
  words(`
    a an and are as at be been being but by can could did do does for from had has have he her his how i if in into is it its may might more most
    must no not of on or our out over said says should so than that the their them then there these they this those through to under up
    us was we were what when where which while who why will with would you your about after also amid against all any before between both
    during each few further here just like many much now only other own same some such too very via within without yet one two three
    first last week year years today time make makes made need needs use used using way ways get gets set sets take takes
    ai artificial intelligence australia australian australians government organisation organisations organization organizations
    new latest
  `),
);

// Excluded from the title gate only: topic words every item in this digest
// shares, and verbs headlines use for any event.
const TITLE_GENERIC = new Set(
  words(`
    governance risk framework challenge safety safe security model system data responsible ethic ethical regulation regulatory regulator
    policy law rule guidance trust tool agent agentic
    release update launch introduce announce reveal publish unveil identify address addressing manage managing find examine explore
    detail discuss highlight warn call plan report key study
  `),
);

/** Light stemmer: enough to match "audits"/"audit", "recommendations"/"recommendation". */
export function stem(w) {
  if (/^\d+$/.test(w)) return w;
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

function tokenise(text) {
  const norm = String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ");
  const out = new Set();
  for (const raw of words(norm)) {
    if (STOP.has(raw)) continue;
    // Numbers count only when distinctive (e.g. "46" recommendations); single digits don't.
    if (/^\d+$/.test(raw) ? raw.length < 2 : raw.length < 3) continue;
    const w = stem(raw);
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

/** Content tokens: title, plus headline and summary when grounded. */
export function tokens(item) {
  const parts = [item.title];
  if (item.status === "summarised") parts.push(item.headline, item.summary);
  return tokenise(parts.filter(Boolean).join(" "));
}

/** Distinctive title/headline tokens, for the title gate. */
export function titleTokens(item) {
  const parts = [item.title];
  if (item.status === "summarised") parts.push(item.headline);
  const t = tokenise(parts.filter(Boolean).join(" "));
  for (const w of t) if (TITLE_GENERIC.has(w)) t.delete(w);
  return t;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const dateOf = (i) => Date.parse(i.publishedAt || i.fetchedAt);
const shares = (a, b) => [...a].some((t) => b.has(t));

function features(item) {
  return { item, toks: tokens(item), title: titleTokens(item), date: dateOf(item) };
}

function similar(a, b, { threshold = SIMILARITY_THRESHOLD, windowDays = DATE_WINDOW_DAYS } = {}) {
  if (a.item.sourceId && a.item.sourceId === b.item.sourceId) return false;
  if (Number.isFinite(a.date) && Number.isFinite(b.date) && Math.abs(a.date - b.date) > windowDays * 864e5) return false;
  if (!shares(a.title, b.title)) return false;
  return jaccard(a.toks, b.toks) >= threshold;
}

/** Same story? See the header for the rule. */
export function sameStory(a, b, opts) {
  return similar(features(a), features(b), opts);
}

/**
 * Lead order: grounded over headline-only (the lead card should carry a
 * verified summary), then authority, then significance, then earliest, then id.
 */
export function compareLead(a, b) {
  return (
    (b.status === "summarised") - (a.status === "summarised") ||
    (AUTHORITY_RANK[a.authority] ?? 9) - (AUTHORITY_RANK[b.authority] ?? 9) ||
    (b.classification?.significance ?? 0) - (a.classification?.significance ?? 0) ||
    (dateOf(a) || Infinity) - (dateOf(b) || Infinity) ||
    String(a.id).localeCompare(String(b.id))
  );
}

/**
 * Group items into stories. Returns [{ lead, also: [items] }], one per story,
 * with `also` in lead order; stories are in their lead's order.
 */
export function clusterItems(items, opts = {}) {
  const sorted = [...items].sort(compareLead);
  const f = sorted.map(features);
  const parent = f.map((_, k) => k);
  const find = (k) => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  for (let a = 0; a < f.length; a++) {
    for (let b = a + 1; b < f.length; b++) {
      if (find(a) !== find(b) && similar(f[a], f[b], opts)) parent[Math.max(find(a), find(b))] = Math.min(find(a), find(b));
    }
  }
  const groups = new Map();
  sorted.forEach((item, k) => {
    const root = find(k);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  return [...groups.values()].map(([lead, ...also]) => ({ lead, also }));
}

/** Score multiplier for a story: a small boost per extra independent source. */
export function coverageBoost(story) {
  const sources = new Set([story.lead, ...story.also].map((i) => i.sourceId ?? i.id));
  return 1 + Math.min(SOURCE_BOOST_MAX, SOURCE_BOOST * (sources.size - 1));
}
