# Questions for review

These came up while building overnight. **All 16 were resolved on 2026-11-24: the owner accepted every default**, and they are recorded in `docs/DECISIONS.md`. New questions go in a new section below, each with the default chosen.

## Sources

1. **Blocked government agencies, via news only.** DISR/NAIC, DTA, AGD, eSafety, OAIC, AHRC, APH and others are marked `status: blocked` in `sources.yaml` (22 sources in total, each with a reason). *Decided:* they appear on the /sources page as "not directly monitored", and their news reaches the digest through InnovationAus, iTnews, The Mandarin, Capital Brief, IAPP and The Conversation. Email updates (SES inbound) stay in the backlog, to revisit if official coverage feels thin.
2. **ACCC** is reachable from your home IP but not from AWS. *Decided:* treat it as blocked. A home-lab fetcher for one source didn't seem worth it.
3. **Sources with no feed (27)** need sitemap or HTML-list adapters. *Decided:* Phase 2 ingests feed sources only, and sitemap/HTML adapters are in the backlog, ordered by value: ASIC, Federal Register of Legislation, Standards Australia, Anthropic, UK AISI, OECD.AI, IAPP, Treasury, NSW Digital, CSIRO, AICD. Priority order confirmed.
4. **Broad news feeds** (iTWire has ~350 items/month, the ABC is mostly non-AI) rely on the keyword pre-filter plus the model's `is_ai_governance` judgement. *Decided:* keep them. Review the ABC after two weeks of collection and drop it if it adds little.

## Pipeline

5. **Gemini model chain:** `gemini-2.5-flash` → `gemini-flash-latest` → `gemini-flash-lite-latest` → `gemini-2.5-flash-lite`, paced at about 9 requests/min and capped at 60 calls a day. *Decided* as listed. The cap can be raised later if the free tier allows.
6. **Grounding strictness:** quotes must match the source verbatim (case-sensitive; only whitespace, quote style and dash style are normalised), each 4+ words and 20+ characters, with at least one supporting the summary and one supporting "why it matters". Failing twice means a headline-only card. *Decided:* strict. Revisit if more than ~25% of items end up headline-only.
7. **Source text isn't stored in git** (copyright), only its SHA-256. *Decided:* keep it that way. Grounding is checked at ingest time and recorded.
8. **Backfill from 1 July (automatic).** The collector's window always reaches back to 1 July, and each day it fetches articles only for the newest ~60 unprocessed items. So the current week is always handled first, and the backfill drains over the first few days with no manual step. Each Friday, `publish.yml` (re)builds "backfilled" archive editions for past weeks, by publish date, labelled as such on the site. Feeds usually hold only 10–25 recent items, so July–October will be thin. *Decided:* accept that rather than scraping site archives.

## Edition & site

9. **Top Signals:** 3–5 per edition, at most 2 from news, never headline-only, significance ≥3 except to make up the minimum of 3. *Decided* as listed. Official items do not automatically outrank more significant news.
10. **"This week" intro:** generated only from the Top Signals' verified summaries. Every sentence must cite them, and every number must match a cited item, or the intro is dropped. *Decided:* on.
11. **Edition window:** from the previous edition's cutoff to Friday 04:17 UTC (15:17 AEDT / 14:17 AEST), bucketed by **publish date**. Items collected late get a 7-day grace; anything older goes to the archive and search only. *Decided* as listed.
12. **Daily redeploy:** the site redeploys after each daily collect, so search, consultations and key dates stay current, while the edition only changes on Fridays. *Decided:* on.
13. **Key dates:** 7 curated entries, each checked against its source on 2026-11-24 (Privacy Act ADM transparency on 10 Dec 2026, DTA AI policy v2.0, CPS 230, EU AI Act dates after the Digital Omnibus). The EU dates cite a law-firm summary because the Official Journal wasn't reachable. *Decided:* include them. Secondary sources are acceptable where the primary one can't be reached. The DTA policy's internal deadlines (use-case register, training) are **not** included because I couldn't verify them.
14. **Item pages** (`/items/<id>/`) exist for search and permalinks. *Decided:* public and indexable by search engines.

## Observed in the first live dry runs

15. `gemini-flash-latest` returned 503 "high demand", so `gemini-2.5-flash` now leads the chain, and a model that returns 503/429 is skipped for the rest of the run.
16. **UK DSIT (fixed):** the configured gov.uk search feed works but returns stale items, while the organisation feed found on the homepage is current. The collector now picks the freshest working feed rather than the first one. No action needed.
