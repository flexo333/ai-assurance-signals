# Questions for review

These came up while building overnight. Each has the **default I went with**, so nothing is blocked; change any of them and I'll adjust. Newest at the bottom of each phase.

## Sources

1. **Blocked government agencies, via news only.** DISR/NAIC, DTA, AGD, eSafety, OAIC, AHRC, APH and others are marked `status: blocked` in `sources.yaml` (22 sources in total, each with a reason). *Default:* they appear on the /sources page as "not directly monitored", and their news reaches the digest through InnovationAus, iTnews, The Mandarin, Capital Brief, IAPP and The Conversation. Revisit email updates (SES inbound) later if official coverage feels thin?
2. **ACCC** is reachable from your home IP but not from AWS. *Default:* treat it as blocked. A home-lab fetcher for one source didn't seem worth it.
3. **Sources with no feed (27)** need sitemap or HTML-list adapters. *Default:* Phase 2 ingests feed sources only, and sitemap/HTML adapters are in the backlog, ordered by value: ASIC, Federal Register of Legislation, Standards Australia, Anthropic, UK AISI, OECD.AI, IAPP, Treasury, NSW Digital, CSIRO, AICD. Is that the right priority order?
4. **Broad news feeds** (iTWire has ~350 items/month, the ABC is mostly non-AI) rely on the keyword pre-filter plus the model's `is_ai_governance` judgement. *Default:* keep them. Drop the ABC if it adds little after two weeks?

## Pipeline

5. **Gemini model chain:** `gemini-2.5-flash` → `gemini-flash-latest` → `gemini-flash-lite-latest` → `gemini-2.5-flash-lite`, paced at about 9 requests/min and capped at 60 calls a day. *Default* as listed. Raise the cap if the free tier allows it?
6. **Grounding strictness:** quotes must match the source verbatim (case-sensitive; only whitespace, quote style and dash style are normalised), each 4+ words and 20+ characters, with at least one supporting the summary and one supporting "why it matters". Failing twice means a headline-only card. *Default:* strict. Too strict if more than ~25% of items end up headline-only?
7. **Source text isn't stored in git** (copyright), only its SHA-256. *Default:* keep it that way. Grounding is checked at ingest time and recorded.
8. **Backfill from 1 July (automatic).** The collector's window always reaches back to 1 July, and each day it fetches articles only for the newest ~60 unprocessed items. So the current week is always handled first, and the backfill drains over the first few days with no manual step. Each Friday, `publish.yml` (re)builds "backfilled" archive editions for past weeks, by publish date, labelled as such on the site. Feeds usually hold only 10–25 recent items, so July–October will be thin. *Default:* accept that rather than scraping site archives.

## Edition & site

9. **Top Signals:** 3–5 per edition, at most 2 from news, never headline-only, significance ≥3 except to make up the minimum of 3. *Default* as listed. Should official items always outrank news even when the news item is more significant?
10. **"This week" intro:** generated only from the Top Signals' verified summaries. Every sentence must cite them, and every number must match a cited item, or the intro is dropped. *Default:* on. Prefer no generated prose at all?
11. **Edition window:** from the previous edition's cutoff to Friday 04:17 UTC (15:17 AEDT / 14:17 AEST), bucketed by **publish date**. Items collected late get a 7-day grace; anything older goes to the archive and search only. *Default* as listed.
12. **Daily redeploy:** the site redeploys after each daily collect, so search, consultations and key dates stay current, while the edition only changes on Fridays. *Default:* on.
13. **Key dates:** 7 curated entries, each checked against its source on 2026-11-24 (Privacy Act ADM transparency on 10 Dec 2026, DTA AI policy v2.0, CPS 230, EU AI Act dates after the Digital Omnibus). The EU dates cite a law-firm summary because the Official Journal wasn't reachable. *Default:* include them. Prefer primary sources only? The DTA policy's internal deadlines (use-case register, training) are **not** included because I couldn't verify them.
14. **Item pages** (`/items/<id>/`) exist for search and permalinks. *Default:* public and indexable by search engines. Make them `noindex`?

## Observed in the first live dry runs

15. `gemini-flash-latest` returned 503 "high demand", so `gemini-2.5-flash` now leads the chain, and a model that returns 503/429 is skipped for the rest of the run.
16. **UK DSIT (fixed):** the configured gov.uk search feed works but returns stale items, while the organisation feed found on the homepage is current. The collector now picks the freshest working feed rather than the first one. No action needed.

## Go-live status (2026-11-24 21:15 UTC)

17. **The first scheduled Collect hasn't run yet.** It was due at 19:41 UTC (06:41 AEDT 25 Nov). GitHub often delays or drops a newly added workflow's first scheduled run, and I can't start workflows from my session (dispatch returns 403). **Action:** in GitHub → Actions → *Collect* → *Run workflow*, leave the inputs blank and run it once. That starts the backfill, and the schedule normally takes over from there. If it doesn't run by tomorrow's slot either, the schedule may need a nudge: any push to `main` that touches `.github/workflows/collect.yml` re-registers it.
