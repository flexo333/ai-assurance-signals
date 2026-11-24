# AI Assurance Signals — Build Plan (v0.2)

**Site:** `aisignals.willbright.link` · **Cadence:** weekly, Friday afternoon (AEST/AEDT) · **Mode:** fully automated, public
**One-liner:** A weekly, source-grounded digest of AI assurance and governance developments, with Australia first, for risk and compliance professionals, AI practitioners, and executives and boards.

---

## 1. Requirements (from interview)

| Topic | Decision |
|---|---|
| Audience | Risk & compliance professionals, practitioners/builders, execs & boards |
| Format | Weekly edition (not a live feed) + archive |
| Editorial | Neutral summary + "Why it matters" line + significance score per item |
| Purpose | Personal/team tool, but hosted **fully public** |
| Delivery | Web page only (no email/Teams in v1) |
| Review | **Fully automated**, no human approval step |
| Sources | Federal gov & regulators · State gov & standards bodies · Australian news · Key international · Frontier labs |
| Relevance | Any AI-governance item qualifies; Australian items rank higher |
| Lab items | Safety/scaling policies, system/model cards, policy & government submissions, evals/alignment research |
| Structure | 3–5 **Top Signals**, then themed sections |
| Guardrails | Source allow-list only · quote-grounded summaries · authority badges · AI-generated disclaimer |
| LLM | Gemini free tier via `@google/genai`, reusing the yt2txt patterns |
| Hosting | AWS (S3 + CloudFront + ACM + Route53) via Pulumi, built by GitHub Actions |
| v1 extras | Searchable archive · Open consultations tracker · Key dates & obligations timeline |
| Section cap | 8 items per section (the rest stay in archive/search) |
| Backfill | Archive starts 2026-07-01 (~21 editions) |
| Design | Minimal & typographic, one navy accent, dark mode, print-friendly |
| Infra | Reuse the `flexo333-ingress` stack (zone + OIDC roles); all resources named `flexo333-*` |

---

## 2. Architecture

```
            ┌──────────────── GitHub Actions (public repo, free minutes) ─────────────────┐
 daily      │ collect.yml:  fetch sources ─▶ normalise/dedupe ─▶ extract text ─▶          │
 (spreads   │               classify (Flash-Lite) ─▶ summarise+ground (Flash) ─▶          │
 Gemini     │               commit data/items/*.json                                      │
 quota)     │                                                                             │
 Friday     │ publish.yml:  select week's items ─▶ rank ─▶ Top Signals write-up ─▶        │
 ~3pm AEDT  │               commit data/editions/YYYY-Www.json ─▶ astro build ─▶          │
            │               pagefind index ─▶ s3 sync ─▶ CloudFront invalidation          │
            └─────────────────────────────────────────────────────────────────────────────┘
                                   │ OIDC role (same pattern as yt2txt)
                                   ▼
                  S3 + CloudFront + ACM + Route53 (aisignals.willbright.link)
```

**Why this shape**
- **No runtime backend.** A weekly digest doesn't need Lambdas or DynamoDB, so the live site is static files on CloudFront.
- **Git is the database and the audit trail.** Each item and edition is a JSON file. You can trace any published claim back to the exact commit, the source text hash and the model that produced it.
- **Collect daily, publish weekly.** This stays well inside Gemini free-tier per-minute and per-day limits, and a bad day at a source doesn't sink the edition.
- **Reuse from yt2txt:** the Pulumi static-site component, the GitHub OIDC deploy role, `models.js` (dynamic Flash model list) and the quota-aware fallback chain from `gemini.js`. Also the `responseSchema` structured-output approach and the convention of pure, dependency-free modules tested with `node --test`.

**Cron:** `17 4 * * 5` UTC is 3:17pm AEDT and 2:17pm AEST. The off-minute avoids GitHub's top-of-hour congestion. The edition window runs from the previous publish cutoff to this one.

**Known Actions caveat:** GitHub disables scheduled workflows after 60 days with no repo activity. The daily data commits keep the repo active, so this isn't a problem here.

---

## 3. Repository layout

```
ai-assurance-signals/
├── sources.yaml              # the allow-list: the only places content can come from
├── data/
│   ├── items/2026/11/<hash>.json     # one per ingested item (summary, quotes, scores, provenance)
│   ├── editions/2026-W48.json        # selected item ids, order, Top Signals text
│   ├── consultations.json            # derived: open/closed AI consultations
│   ├── key-dates.yaml                # curated obligations timeline (seeded, see §8)
│   └── source-health.json            # last success/failure per source
├── pipeline/                 # Node 20, ESM
│   ├── fetchers/{rss,sitemap,html-list,legislation}.js
│   ├── extract.js            # readability-style main-text extraction
│   ├── classify.js           # relevance + theme + authority (Flash-Lite)
│   ├── summarise.js          # summary + why-it-matters + quotes (Flash)
│   ├── ground.js             # PURE: verifies quotes appear in source text
│   ├── rank.js               # PURE: significance × authority × AU boost × recency
│   ├── edition.js            # builds weekly edition + Top Signals write-up
│   ├── gemini.js / models.js # ported from yt2txt
│   └── *.test.mjs
├── site/                     # Astro (static), Pagefind for search
├── infra/pulumi/             # Python, forked from yt2txt (static site only)
├── .github/workflows/{collect,publish,deploy-infra,source-check}.yml
├── CLAUDE.md  docs/DECISIONS.md  docs/BACKLOG.md
```

---

## 4. Ingestion

Each source in `sources.yaml` declares:

```yaml
- id: oaic
  name: Office of the Australian Information Commissioner
  authority: official          # official | standards | lab | research | news
  jurisdiction: AU-federal     # AU-federal | AU-NSW | ... | INTL | EU | UK | US
  method: rss                  # rss | atom | sitemap | html-list | legislation
  url: https://www.oaic.gov.au/...
  filter: ai_keywords          # none | ai_keywords — a cheap pre-filter before the LLM
  default_theme: regulator-guidance
```

- **Fetch methods, in order of preference:** RSS/Atom, then sitemap diffing (new URLs since the last run), then HTML list pages with a CSS selector. Many `.gov.au` sites have no feed, so sitemap and HTML-list support are first-class.
- **Pre-filter:** a keyword gate (AI, artificial intelligence, automated decision, algorithm, machine learning, generative, LLM, guardrail, …) on title and summary for broad sources like ABC, the ACCC or ASIC. That way Gemini quota isn't spent on unrelated press releases. AI-specific sources (labs, NAIC, AI Safety Institute) skip the gate.
- **Dedupe:** canonical URL, then title similarity. When a regulator release and news coverage describe the same event, they cluster: the official item leads and the news items attach as "Coverage".
- **Paywalls (AFR, The Australian):** headline and standfirst only, no paywall circumvention. Summarise only the text that's freely available, and label the item "Paywalled".
- **Politeness:** respect robots.txt, use an honest User-Agent (`AIAssuranceSignalsBot/1.0 (+https://aisignals.willbright.link/about)`), cap concurrency at one request per host, and use conditional GETs (ETag/Last-Modified).

---

## 5. LLM pipeline & guardrails (the core of "fully automated")

**Step 1. Classify** (Flash-Lite, structured output):
`{ is_ai_governance: bool, theme, audiences[], au_relevance: 0–3, is_consultation: bool, closing_date?: ISO, significance: 1–5, significance_reason }`

**Step 2. Summarise** (Flash, structured output, with the source text as the only context):
```json
{
  "headline": "...",               // ≤ 90 chars, neutral
  "summary": "...",                // 2–4 sentences, facts only
  "why_it_matters": "...",         // 1 sentence, framed for AU assurance practice
  "quotes": [{"text": "...", "supports": "summary|why_it_matters"}],  // 1–3 verbatim
  "dates_mentioned": [{"date": "...", "what": "..."}]
}
```

**Step 3. Ground** (pure code, no LLM). Every quote must appear verbatim in the extracted source text after whitespace and quote-mark normalisation.
- If any quote fails, retry once with stricter instructions. If it fails again, fall back to the **headline-only** card (title, source, link, badge), which needs no generated summary.
- Store `source_sha256`, `model`, `prompt_version`, `grounded: true/false` on every item.

**Step 4. Rank:** `score = significance × authority_weight × (1 + 0.5·au_relevance/3) × recency`, with authority weights official 1.0 · standards 0.95 · lab 0.85 · research 0.8 · news 0.6. Top Signals are the top 3–5, with at most 2 from news. Each item shows the score behind its position.

**Step 5. Top Signals write-up** (Flash, best available model). This is a short "This week in one paragraph" built **only from the grounded summaries of the selected items**, and each sentence links to its item. It can't introduce facts the item summaries don't contain.

**Reader-facing guardrails**
- A site-wide banner and a note on every item: *"Summaries are AI-generated from the linked source and may contain errors. Always rely on the original."*
- Authority badge on every card: **Official** · **Standards** · **Frontier Lab** · **Research/Peak body** · **News**.
- Every item links to the original. A "Grounding" toggle shows the verbatim quotes.
- A `/methodology` page explains sources, scoring and limitations, and links to the public repo.

**Gemini free-tier notes**
- Daily collection of roughly 20–60 candidates means ~10–30 LLM calls a day after the pre-filter, which is comfortably within free limits. The yt2txt fallback chain covers 429s.
- Free-tier prompts may be used by Google to improve its products. That's acceptable here because every input is already public.
- If free-tier terms change, the model layer is one module, and Bedrock Claude in `ap-southeast-2` is the drop-in alternative.

---

## 6. Edition structure (themes)

1. **Top Signals** (3–5, cross-theme, with the one-paragraph write-up)
2. **Australian Policy & Legislation**: DISR, AGD, Treasury, Parliament, the Federal Register of Legislation
3. **Regulator Guidance & Enforcement**: OAIC, APRA, ASIC, ACCC, eSafety, AHRC, TGA
4. **Public Sector AI**: DTA, APSC, state frameworks (NSW AI Assurance Framework and others)
5. **Standards & Frameworks**: Standards Australia, ISO/IEC JTC 1/SC 42, NIST, NAIC, the AI Safety Institute
6. **Frontier Labs**: safety policies, system cards, policy submissions, evals/alignment research
7. **International**: EU AI Act, UK, US, OECD, G7/Hiroshima, Council of Europe
8. **News & Commentary**: Australian outlets plus a small number of international ones

Empty sections are hidden. Each card shows the headline, badge, source, date, summary, why it matters, a grounding toggle and a link. Each edition also has a stable permalink (`/editions/2026-W48/`).

---

## 7. Site (Astro, static)

| Page | Content |
|---|---|
| `/` | Latest edition |
| `/editions/` | Archive list by week |
| `/editions/YYYY-Www/` | Edition permalink |
| `/search/` | Pagefind full-text search with filters: theme, authority, jurisdiction, date |
| `/consultations/` | Open consultations sorted by closing date, plus recently closed |
| `/key-dates/` | Obligations and milestones timeline |
| `/sources/` | The full allow-list, with source health (last fetched, items found) |
| `/methodology/` and `/about/` | How it works, limitations, the disclaimer |

Design: clean, typographic and print-friendly, so an exec can print or PDF an edition. Dark mode, fast, no client JavaScript apart from search.

---

## 8. Extras

**Open consultations tracker.** Built from items classified with `is_consultation`, plus dedicated sources: consult.industry.gov.au, AGD, Treasury, OAIC, APH committee inquiries and state "Have your say" sites. Gemini extracts the closing date, which must be grounded with a verbatim quote containing the date. An item shows as open until its closing date passes, and if no closing date is found it's labelled "date unknown".

**Key dates & obligations.** `data/key-dates.yaml` is seeded once and then grown automatically from `dates_mentioned` on Official-authority items only, each linked to its source item. Seed candidates, **all to be verified against primary sources in Phase 1** before publishing:
- Privacy Act: transparency obligations for automated decision-making (from the *Privacy and Other Legislation Amendment Act 2024*) commence 10 Dec 2026
- DTA *Policy for the responsible use of AI in government* (v2.0) requirements and their deadlines
- CPS 230 Operational Risk Management (APRA), in effect since 1 Jul 2025, with remaining transition dates
- EU AI Act: GPAI obligations (Aug 2025); high-risk obligations (Aug 2026, subject to any Digital Omnibus delay, so check current status)
- Australian AI Safety Institute milestones; National AI Plan actions
- ISO/IEC 42001 and AS ISO/IEC 42001 adoption dates

---

## 9. Source register (initial allow-list, *feeds unverified*)

The sandbox network blocked these hosts during planning, so **every URL and feed method gets verified by `source-check.yml` in Phase 1**, which runs in Actions with open internet.

**Federal government & Parliament (Official):** DISR (industry.gov.au, including the National AI Centre) · Australian AI Safety Institute · DTA (dta.gov.au / digital.gov.au) · Attorney-General's Dept · Treasury · Dept of Finance · APSC · Parliament of Australia (committee inquiries, Hansard search on "artificial intelligence") · Federal Register of Legislation · consult.industry.gov.au
**Regulators (Official):** OAIC · APRA · ASIC · ACCC · eSafety Commissioner · Australian Human Rights Commission · TGA (AI as a medical device) · ACMA · Commonwealth Ombudsman (ADM)
**States (Official):** NSW Digital (AI Assurance Framework) · NSW Ombudsman · Vic DGS / OVIC · Qld CGCIO / OIC · WA Office of Digital Government · SA / Tas / ACT / NT digital offices (low volume)
**Standards & research (Standards / Research):** Standards Australia · CSIRO / Data61 (Responsible AI) · AICD · Gradient Institute · Human Technology Institute (UTS) · ADM+S Centre · Tech Policy Design Centre (ANU) · Law Council of Australia
**Frontier labs (Lab):** Anthropic · OpenAI · Google DeepMind · Meta AI · Microsoft (Responsible AI) · Mistral · xAI · Frontier Model Forum
**International (Official / Standards):** EU AI Office / AI Act service desk · UK AI Security Institute and DSIT · NIST (AI RMF, CAISI) · OECD.AI · ISO/IEC SC 42 · Council of Europe · Singapore IMDA/AI Verify · Canada · NZ
**Australian news (News):** InnovationAus · ITnews · The Mandarin · iTWire · Information Age (ACS) · ABC News (Technology) · The Conversation (AU) · AFR (headline-only) · Capital Brief (headline-only)
**International news (News, a short list):** Reuters Tech · MIT Technology Review · IAPP Daily Dashboard · Euractiv (Tech)

---

## 10. Delivery phases

| Phase | Deliverable | Check-in with you |
|---|---|---|
| **0. Repo & infra** | New repo `flexo333/ai-assurance-signals`, Pulumi static site on `aisignals.willbright.link`, OIDC deploy, a "coming soon" page | Domain live |
| **1. Source verification** | `source-check.yml` probes every source and records method, feed URL, robots.txt status and sample items. Key dates verified. | Review the final allow-list |
| **2. Pipeline** | Fetchers, extraction, classify, summarise, ground, rank, with tests on the pure modules. Dry-run on 2 weeks of real data. | Review sample items and grounding rate |
| **3. Site** | Astro edition, archive, item cards, badges, disclaimer, methodology | Look and feel review |
| **4. Extras** | Pagefind search, consultations tracker, key dates, sources/health page | Feature review |
| **5. Go live** | Turn on the daily and Friday crons, failure alerts (Actions email), a source-health regression flag (a source silent for 3 weeks gets flagged), backfill of 4 editions | First live edition |

**Running cost:** roughly $1–2 a month (Route53 hosted zone already exists, S3 and CloudFront pennies). Gemini is on the free tier, and Actions is free for a public repo.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Hallucinated or misattributed summary, published with no review | Verbatim-quote grounding gate, headline-only fallback, disclaimer, provenance stored, public repo |
| Gov sites change layout and HTML fetchers break | Source-health page, weekly regression flag, feed-first preference |
| Free-tier quota or terms change | Daily spreading, model fallback chain, a swappable model module (Bedrock as plan B) |
| Copyright on news content | Short original summaries, quotes of at most ~25 words, always link out, headline-only for paywalled outlets |
| Noise from broad sources | Keyword pre-filter + LLM relevance + significance threshold |
| Scheduled workflow silently stops | Daily commits keep the repo active; a missed-edition check runs Saturday |

---

## 12. Open questions

1. **News outlets:** add or remove any (e.g. Capital Brief, The Australian, Crikey, IAPP)?
2. **About the author:** link to you from `/about`, or keep the site anonymous?
