# Decisions

Newest first. Each entry: context → decision → consequences.

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
