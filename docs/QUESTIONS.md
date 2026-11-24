# Questions for review

These came up while building overnight. Each has the **default I went with**, so nothing is blocked; change any of them and I'll adjust. Newest at the bottom of each phase.

## Sources

1. **Blocked government agencies, via news only.** DISR/NAIC, DTA, AGD, eSafety, OAIC, AHRC, APH and others are marked `status: blocked` in `sources.yaml` (22 sources in total, each with a reason). *Default:* they appear on the /sources page as "not directly monitored", and their news reaches the digest through InnovationAus, iTnews, The Mandarin, Capital Brief, IAPP and The Conversation. Revisit email updates (SES inbound) later if official coverage feels thin?
2. **ACCC** is reachable from your home IP but not from AWS. *Default:* treat it as blocked. A home-lab fetcher for one source didn't seem worth it.
3. **Sources with no feed (27)** need sitemap or HTML-list adapters. *Default:* Phase 2 ingests feed sources only, and sitemap/HTML adapters are in the backlog, ordered by value: ASIC, Federal Register of Legislation, Standards Australia, Anthropic, UK AISI, OECD.AI, IAPP, Treasury, NSW Digital, CSIRO, AICD. Is that the right priority order?
4. **Broad news feeds** (iTWire has ~350 items/month, the ABC is mostly non-AI) rely on the keyword pre-filter plus the model's `is_ai_governance` judgement. *Default:* keep them. Drop the ABC if it adds little after two weeks?

## Pipeline

5. **Gemini model chain:** `gemini-flash-latest` → `gemini-2.5-flash` → `gemini-flash-lite-latest` → `gemini-2.5-flash-lite`, paced at about 9 requests/min and capped at 60 calls a day. *Default* as listed. Raise the cap if the free tier allows it?
6. **Grounding strictness:** quotes must match the source verbatim (case-sensitive; only whitespace, quote style and dash style are normalised), each 4+ words and 20+ characters, with at least one supporting the summary and one supporting "why it matters". Failing twice means a headline-only card. *Default:* strict. Too strict if more than ~25% of items end up headline-only?
7. **Source text isn't stored in git** (copyright), only its SHA-256. *Default:* keep it that way. Grounding is checked at ingest time and recorded.
8. **Backfill from 1 July.** Feeds usually hold only 10–25 recent items, so the back archive will be thin except for high-volume feeds. *Default:* run one backfill with a 150-day window and accept whatever history exists, rather than scraping archives.
