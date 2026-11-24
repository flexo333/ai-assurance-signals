# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**AI Assurance Signals** (`aisignals.willbright.link`) is a weekly, fully automated, source-grounded digest of AI assurance and governance developments, with Australia first. Readers are risk & compliance professionals, AI practitioners, and execs/boards. The full plan is in `docs/PLAN.md`; decisions go in `docs/DECISIONS.md`; deferred work in `docs/BACKLOG.md`.

The site is static with no runtime backend. GitHub Actions collects and summarises items daily and publishes an edition each Friday afternoon (AEST/AEDT). Git is the data store (`data/`, from Phase 2).

Sibling project with shared patterns: `flexo333/yt2txt` (Gemini free tier via `@google/genai`, structured output, quota-aware model fallback, pure modules tested with `node --test`).

## Layout

- `site/`: Astro (static, `build.format: directory`, `trailingSlash: always`). `src/layouts/Base.astro` holds the masthead, the AI-generated disclaimer banner (keep it on every page) and the footer. `src/styles/global.css` holds the design tokens (minimal, typographic, system font stacks, one navy accent, dark mode via `prefers-color-scheme`, print styles).
- `sources.yaml`: the allow-list, the only places content can come from.
- `pipeline/`: Node 22 ESM. `lib/*.js` are pure, dependency-free modules with `*.test.mjs` tests (run `cd pipeline && node --test` with no path arguments). `source-check.mjs` probes every source (robots, feeds, sitemaps) and runs in `.github/workflows/source-check.yml`.
- `infra/pulumi/`: Python Pulumi, static site only, via `flexo333/pulumi-static-site@v0.2.0` with `spa_mode=False` (a CloudFront Function rewrites `/path/` to `/path/index.html`).
- `.github/workflows/deploy.yml`: the `infra` job (preview on PR, `up` with `upsert` on main) then the `site` job (build; on main also sync to S3 and invalidate CloudFront).

## Infra gotchas

- **The shared ingress stack** `flexo333/flexo333-ingress/prod` (source: `flexo333/my-blog`, `infra/pulumi-ingress/`) owns the `willbright.link` Route53 zone and the GitHub OIDC roles. `infra_role_arn` trusts any branch; `deploy_role_arn` trusts `main` only. Both trust the legacy and the immutable (`owner@id/repo@id`) OIDC `sub` formats.
- **Every AWS resource name must start with `flexo333-`.** The ingress roles' IAM policies are scoped to that prefix. `__main__.py` enforces it for the bucket.
- The Pulumi stack is `flexo333/prod` in project `flexo333-ai-assurance-signals`, in region `us-east-1` (needed for the CloudFront ACM cert).
- Repo secret needed: `PULUMI_ACCESS_TOKEN`. From Phase 2 also `GEMINI_API_KEY`.

## Commands

All local commands run through Docker via `make`, so you don't need Node or Python installed: `make dev`, `make build`, `make infra-preview`, `make infra-up`, `make infra-outputs`. In a cloud session you can also run `cd site && npm ci && npm run build` directly.

## Content rules (apply from Phase 2)

- Ingest only from the allow-list in `sources.yaml`. Never from open web search.
- Every LLM summary must carry verbatim quotes that `ground.js` verifies against the source text. If grounding fails, show a headline-only card. Never publish an ungrounded summary.
- Every item carries an authority badge: official, standards, lab, research or news.
- The site is anonymous: no author attribution.
- Respect robots.txt. Paywalled outlets get headline and standfirst only.
