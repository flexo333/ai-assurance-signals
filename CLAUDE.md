# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**AI Assurance Signals** (`aisignals.willbright.link`) is a weekly, fully automated, source-grounded digest of AI assurance and governance developments, with Australia first. Readers are risk & compliance professionals, AI practitioners, and execs/boards. The full plan is in `docs/PLAN.md`; decisions go in `docs/DECISIONS.md`; deferred work in `docs/BACKLOG.md`.

The site is static with no runtime backend. GitHub Actions collects and summarises items daily and publishes an edition each Friday afternoon (AEST/AEDT). Git is the data store (`data/`, from Phase 2).

Sibling project with shared patterns: `flexo333/yt2txt` (Gemini free tier via `@google/genai`, structured output, quota-aware model fallback, pure modules tested with `node --test`).

## Layout

- `site/`: Astro (static, `build.format: directory`, `trailingSlash: always`). `src/layouts/Base.astro` holds the masthead, the AI-generated disclaimer banner (keep it on every page) and the footer. `src/styles/global.css` holds the design tokens (minimal, typographic, system font stacks, one navy accent, dark mode via `prefers-color-scheme`, print styles).
- `sources.yaml`: the allow-list, the only places content can come from.
- `data/`: `items/YYYY/MM/<id>.json` (bot-committed daily), `editions/<YYYY-Www>.json` (bot-committed Fridays by `publish.yml` → `pipeline/edition.mjs`; coverage of one story is grouped by `lib/cluster.js` into the lead entry's `also: [ids]`), and `key-dates.yaml` (curated by hand; every entry needs a verified source).
- `site/` pages: `/` (latest edition), `/editions/`, `/editions/<id>/`, `/items/<id>/` (the only pages Pagefind indexes), `/search/`, `/consultations/` (open = grounded closing date ≥ build date), `/key-dates/` (curated + grounded dates from official items), `/sources/`, `/methodology/`, `/about/`. `npm run build` runs `astro build && pagefind --site dist`.
- Schedules: `collect.yml` daily at 06:41 AEDT (collect → commit → redeploy); `publish.yml` Fridays at 15:17 AEDT (edition → commit → redeploy). Both call `deploy.yml` via `workflow_call`, because bot commits don't trigger push workflows.
- `pipeline/`: Node 22 ESM. The data flow is: `collect.yml` (daily) → `build-collect-event.mjs` → the Sydney Lambda (`lambda/handler.mjs`, `action: "collect"` → `collect.mjs`: resolve feed, keyword pre-filter, Readability extract; sources with `method: sitemap` (ASIC, APRA) go through the sitemap adapter instead, which fetches each page, dates it from the page itself and runs the keyword check on the **body**. Rejected pages are recorded in `data/seen/sitemap.json` so they aren't re-fetched) → `process.mjs` (Gemini via `lib/analyse-item.js` → `lib/ground.js` gate) → `data/items/YYYY/MM/<id>.json` committed by the bot. Item `status` is `summarised` (grounded, publishable), `headline-only` (relevant, ungrounded; show title/link/badge only) or `irrelevant`. Bump `PROMPT_VERSION` in `lib/prompt.js` on any prompt or schema change.
- `pipeline/` general: `lib/*.js` are pure, dependency-free modules with `*.test.mjs` tests (run `cd pipeline && node --test` with no path arguments). `source-check.mjs` probes every source (robots, feeds, sitemaps) and runs in `.github/workflows/source-check.yml`, both on the runner and via the Sydney Lambda (`lambda/source-check-handler.mjs`). `source-check.mjs` is also imported by the Lambda, so it must have no import-time side effects.
- `infra/pulumi/`: Python Pulumi, static site only, via `flexo333/pulumi-static-site` (v0.4.0, pinned by commit: `price_class="PriceClass_All"` (the only class with Australian edges), `error_page_path="/404.html"`) with `spa_mode=False` (a CloudFront Function rewrites `/path/` to `/path/index.html`).
- `.github/workflows/deploy.yml`: the `infra` job (preview on PR, `up` with `upsert` on main) then the `site` job (build; on main also sync to S3 and invalidate CloudFront).

## Infra gotchas

- **The shared ingress stack** `flexo333/flexo333-ingress/prod` (source: `flexo333/my-blog`, `infra/pulumi-ingress/`) owns the `willbright.link` Route53 zone and the GitHub OIDC roles. `infra_role_arn` trusts any branch; `deploy_role_arn` trusts `main` only. Both trust the legacy and the immutable (`owner@id/repo@id`) OIDC `sub` formats.
- **Every AWS resource name must start with `flexo333-`.** The ingress roles' IAM policies are scoped to that prefix. `__main__.py` enforces it for the bucket.
- **GitHub-hosted runners are IP-blocked by many `.gov.au` sites** (govCMS/Akamai resets; 403 from OAIC and AHRC). Changing the User-Agent doesn't help, and we don't spoof it. Fetches of Australian government sources go through `flexo333-aisignals-fetch`, a Lambda in ap-southeast-2 packaged from `pipeline/`. `deploy.yml` runs `npm ci` in `pipeline/` before Pulumi so the package includes `node_modules`.
- The Pulumi stack is `flexo333/prod` in project `flexo333-ai-assurance-signals`, in region `us-east-1` (needed for the CloudFront ACM cert).
- Repo secrets: `PULUMI_ACCESS_TOKEN`, `GEMINI_API_KEY`.

## Tracking

Work items, open questions and follow-ups are **GitHub issues** (labels: `enhancement`, `sources`, `editorial`, `infra`, `follow-up`, `question`). Raise a question as an issue labelled `question` and state the default you chose, so work never blocks. `docs/QUESTIONS.md` and `docs/BACKLOG.md` are historical indexes; decisions still go in `docs/DECISIONS.md`.

## Dev sandbox network

Cloud dev sessions for this repo use the **AI Assurance Signals** environment, which allows `asic.gov.au` and `apra.gov.au`. Add a host there before testing another source locally. Node's `fetch` needs `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` to go through the proxy. `pipeline/probe-source.mjs` shows a site's sitemaps, listing links and feeds, to help configure adapters.

## Commands

All local commands run through Docker via `make`, so you don't need Node or Python installed: `make dev`, `make build`, `make infra-preview`, `make infra-up`, `make infra-outputs`. In a cloud session you can also run `cd site && npm ci && npm run build` directly.

## Content rules (apply from Phase 2)

- Ingest only from the allow-list in `sources.yaml`. Never from open web search.
- Every LLM summary must carry verbatim quotes that `ground.js` verifies against the source text. If grounding fails, show a headline-only card. Never publish an ungrounded summary.
- Every item carries an authority badge: official, standards, lab, research or news.
- The site is anonymous: no author attribution.
- Respect robots.txt. Paywalled outlets get headline and standfirst only.
