# Decisions

Newest first. Each entry: context → decision → consequences.

## 2026-11-25: Financial Services scope: industry and vendor badges, prompt v3, FS section and tracker (#31)
In a prudentially regulated sector, a bank's production AI deployment or AI-assisted code and data migration is an operational-risk and assurance signal, even when it isn't framed as governance. Under prompt v2 such posts were classified `irrelevant`, and news coverage of them went to News & Commentary. **Decision:**
- Two new authorities: `industry` (banks, insurers, super funds and FS peak bodies writing about their own work; weight 0.75, cluster rank between research and news) and `vendor` (cloud and enterprise vendors' customer stories; weight 0.5, ranked last). A bank's own grounded post leads press coverage of it. Vendor stories never lead a story or reach Top Signals.
- Prompt v3: the gate (still the `is_ai_governance` field, so stored items and code keep working; it now means "in scope") also accepts substantive FS AI signals, and explicitly rejects generic pilots, sponsorships, earnings mentions and vendor marketing. It adds the `deployment` kind (rated 1–5 on operational significance and not a non-signal kind, so significance ≥ 4 can reach Top Signals), the `financial-services` theme and an `is_financial_services` flag, so an APRA guidance item keeps `item_kind: regulator-guidance` but still routes to FS.
- `sectionFor()` routes FS items (flag, theme, or a source marked `sector: financial-services`) to a new **Financial Services** section before the news fallback. `edition.mjs` copies a source's `sector` onto older items at build time, so APRA and ASIC items route to FS without re-analysis.
- Optional per-source `must_match` regex list checked before any fetch or Gemini call, so global vendor feeds spend quota (#21) only on items about Australian FS.
- `/financial-services/` tracker: FS stories newest first, grouped as regulator moves, institution deployments and case studies, and news. Story groups from editions are kept.

## 2026-11-25: Sitemap adapter with body-text AI check; ASIC and APRA first (#12)
APRA's RSS feed carries only statistics releases, and ASIC has no feed. Both publish complete sitemaps. Official releases often mention AI only in the body: APRA's System Risk Outlook has 57 mentions and none in its title or URL. **Decision:** `method: sitemap` sources take the newest unknown URLs matching include/exclude patterns, fetch each page, and date it from the page itself (`displayDate`/`dcterms` metadata, a "Published" label, or first visible date, with sitemap `lastmod` only as a fallback, because CMSs bump `lastmod` on edits). The AI keyword check runs on the body text. Rejected pages are stored in `data/seen/sitemap.json` (200-day TTL) so the backfill moves on rather than re-fetching them. Extraction gains a main-text fallback for layouts Readability misses (APRA's Drupal paragraphs).

## 2026-11-25: Tighter Top Signals: item kind and a significance gate (#13)
In the Week 48 preview, a product launch (Shirudo) and a lab metrics post reached Top Signals at significance 3. Vendor "predictions" pieces were also scoring 3. **Decision:** the analysis prompt (v2) classifies `item_kind` and caps products, business news and predictions at significance 2 unless they change obligations. Ranking never puts those kinds in Top Signals and down-weights them in sections (×0.5–0.6, commentary ×0.85). Top Signals beyond the minimum of 3 need significance ≥4. **Consequence:** quieter weeks show 3 Top Signals instead of padding to 5. Items analysed before v2 have no `item_kind` and are only affected by the significance gate.

## 2026-11-25: Group duplicate coverage of one story with heuristics (#11)
Week 48 showed the joint select committee report twice in Top Signals, and four outlets covered it in all. **Decision (owner chose option 1):** cluster at edition time with pure heuristics in `pipeline/lib/cluster.js`, no API calls. Two items are the same story if they come from different sources, were published within 3 days, share at least one distinctive title/headline word (corpus-wide topic words such as "governance" and generic headline verbs don't count), and their content words (title + headline + summary) have Jaccard ≥ 0.09; stories are connected components. Summary Jaccard alone didn't separate true pairs (0.077–0.150) from unrelated ones (up to 0.103), because Gemini summaries share generic vocabulary; the title gate removes that noise, leaving the nearest unrelated pair at 0.080. The lead is the grounded item first (so the card carries a verified summary), then highest authority, significance and earliest; a story scores as its lead +5% per extra source (max +15%), and caps count stories. Editions record the group as `also: [ids]` on the lead's entry. **Consequences:** on Weeks 44–48 this groups the committee report (4 items) and the Services Australia breach (2) with no false merges; the threshold leaves little margin, so revisit (move to embeddings, option 2) if paraphrased headlines are missed or unrelated items merge as the corpus grows.

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
