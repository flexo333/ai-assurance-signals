# Decisions

Newest first. Each entry: context → decision → consequences.

## 2026-11-24: Owner accepted all 16 overnight defaults (QUESTIONS.md)
The overnight build raised 16 questions, each with a default already in place. **Decision (owner):** accept every default as built. Specifically:
- **Sources:** blocked agencies are covered via news, with SES email updates left in the backlog. ACCC is treated as blocked. Phase 2 ingests feed sources only. The sitemap/HTML adapter order is ASIC, Federal Register of Legislation, Standards Australia, Anthropic, UK AISI, OECD.AI, IAPP, Treasury, NSW Digital, CSIRO, AICD. Broad feeds (iTWire, ABC) stay.
- **Pipeline:** the Gemini chain is `gemini-2.5-flash` → `gemini-flash-latest` → `gemini-flash-lite-latest` → `gemini-2.5-flash-lite`, at ~9 req/min and 60 calls a day. Grounding stays strict. Source text stays out of git. The thin July–October backfill is accepted, with no archive scraping.
- **Edition and site:** Top Signals rules unchanged, and official items don't automatically outrank more significant news. The "This week" intro is on. The edition window and 7-day grace are unchanged. The site redeploys daily. The 7 key dates stay, including EU dates cited from a law-firm summary. Item pages are public and indexable.

**Follow-ups:** review the ABC feed after two weeks of collection; revisit grounding strictness if more than ~25% of items end up headline-only; raise the daily cap if the free tier allows.

## 2026-11-24: Self-draining backfill; editions bucketed by publish date
With no stored items, the first run would fetch ~675 articles while Gemini handles about 60 a day, and every old item would land in the first edition. **Decision:** the collector lists candidates cheaply and fetches articles for only the newest `maxItems` (the day's budget). The window always reaches back to `ARCHIVE_START`, which is cheap because feeds are short. Editions are bucketed by publish date, with a 7-day late-arrival grace. `edition.mjs --backfill` (re)builds `backfilled: true` editions for past weeks. **Consequence:** the archive back to 1 July fills itself over the first days and is labelled as backfilled; regular editions are never rewritten.

## 2026-11-24: Collect in Sydney, analyse in Actions; one Gemini call per item
**Fetching:** all of it runs in the Sydney Lambda (`action: "collect"`). It reaches everything the GitHub runner does, plus InnovationAus. Feeds are resolved at run time (configured feed, then candidates, then homepage autodiscovery), so no feed URLs need hand-maintaining. **Analysis:** stays in Actions, where `GEMINI_API_KEY` lives. One structured-output call does classification and the summary together, which halves free-tier usage. **Grounding:** if it fails, one corrective retry, then headline-only, with the ungrounded text and dates discarded. **Storage:** items are JSON under `data/items/YYYY/MM/`. Source text is never committed (copyright); only its sha256 is.

## 2026-11-24: Government agencies behind bot protection are covered via news
A home-IP test showed govCMS/Akamai sites and OAIC reject automated clients even from a residential Australian IP. Only a headless browser would get through, which would circumvent controls the agencies chose. **Decision (owner):** mark them `status: blocked` with reasons, and rely on news coverage. ACCC is blocked from cloud IPs only, but is treated as blocked too.

## 2026-11-24: Test fetching from AWS Sydney; GitHub runners are IP-blocked by .gov.au
The first source check from Actions reached 16 of 67 sources. A diagnostic showed the blocking is by IP, not User-Agent. govCMS/Akamai sites (DISR, DTA, AGD, eSafety and others) reset the connection within about 40 ms for every UA. OAIC, AHRC and InnovationAus return 403 for every UA. APH only admits a browser UA. **Decision:** don't spoof the UA. Deploy `flexo333-aisignals-fetch`, a Lambda in ap-southeast-2 that runs the same `pipeline/` code, and compare its source check with the Actions one. It has no Function URL; only the CI infra role can invoke it. **If Sydney works:** only the collector's fetch step moves there. **If not:** fall back to a collector on the home lab (residential AU IP).

## 2026-11-24: Anonymous site; IAPP and Capital Brief in the allow-list
**Decision:** no author attribution anywhere on the site. IAPP (news, INTL) and Capital Brief (news, AU, paywalled, so headline-only) are confirmed in `sources.yaml`.

## 2026-11-24: Source verification runs in Actions, not locally
The cloud dev sandbox can't reach most `.gov.au` hosts. **Decision:** `pipeline/source-check.mjs` runs in GitHub Actions on PRs, weekly and on demand, and publishes its report as the job summary plus a JSON artifact. Its parsing logic lives in pure modules (`pipeline/lib/*`) with `node --test` tests.

## 2026-11-24: Reuse the shared ingress stack for DNS and CI roles
The `flexo333-ingress` stack already provides the `willbright.link` zone and GitHub OIDC infra/deploy roles, which trust every `flexo333/*` repo, including the immutable `sub` format that repos created after 2026-07-15 get. **Decision:** reference it with a `StackReference` and the roles, with no changes to the ingress stack. **Consequence:** every AWS resource must be named `flexo333-*`.

## 2026-11-24: One deploy workflow, infra job then site job
Separate infra and site workflows race on the first merge, because the site sync runs before the bucket exists. **Decision:** a single `deploy.yml` where `site` needs `infra`, and Pulumi `upsert: true` creates the stack on its first run. **Consequence:** every site deploy also runs a no-op `pulumi up` (~30–60 s).

## 2026-11-24: Static Astro site, GitHub Actions pipeline, git as the data store
A weekly digest needs no runtime backend. **Decision:** daily collection and a Friday publish run in Actions, items and editions are committed as JSON, and Astro builds a static site served from S3 and CloudFront. **Consequence:** no Lambdas or DynamoDB. Git history is the audit trail for every published claim. A public repo means Actions minutes are free.

## 2026-11-24: Product decisions from the interview
- Weekly edition, published Friday ~3pm AEDT (cron `17 4 * * 5` UTC). Fully automated with no human review, offset by guardrails: allow-list only, verbatim-quote grounding, authority badges, AI-generated disclaimer.
- Fully public. Any AI-governance item qualifies, and Australian items rank higher.
- Top Signals (3–5), then themed sections, **capped at 8 items per section**. The rest stay in the archive and search.
- **Backfill from 2026-07-01** (~21 editions), spread over several days to stay within the Gemini free tier.
- **Minimal, typographic design**: system serif headlines, neutral palette, one navy accent, dark mode, print-friendly.
- Gemini free tier for the LLM, reusing the yt2txt model and fallback code.
