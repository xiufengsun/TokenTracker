# Cloud edge pricing coverage (issue #929)

Design note requested in the maintainer triage of #929 (2026-10-30): before coding
against the structural LiteLLM-only pricing gap, record what the gap is, which fix
path was chosen, and how future gaps get detected.

## Background

Local pricing (`src/lib/pricing/`) resolves curated overrides first, then falls
through to the LiteLLM dynamic table (`matcher.js` steps 2/5/5b/6). The five edge
functions that price cloud account views only embed the hand-maintained
`MODEL_PRICING` table — they do not carry LiteLLM. Any model whose rate comes only
from LiteLLM is therefore priced locally but unpriced in the cloud account views
(hero shows `≥`, model rows show an unpriced badge).

`test/edge-pricing-parity.test.js` guarantees the five edge files are byte-identical
to each other and pins specific regression-prone keys; it does **not** assert
general curated↔edge key parity (curated exact keys can legitimately be absent from
the edge table when the edge matcher chain prices them at the same rate — e.g. the
dated Claude SKUs). So a LiteLLM-only model can stay missing from both sides with CI
green. Precedent: the leaderboard-profile kimi-k2.6/mimo incident recorded in the
parity test header.

Production window 2026-01-01 → 2026-10-31 (one account, all sources, 75.87B tokens /
$13,943.83): LiteLLM-only rows totalled 2.369B tokens (3.12%) / $1,383.59.

## Decision

**Option 1 chosen: promote production-hit models into curated + edge with the exact
rates the local engine already bills.** Option 2 (a deliberate edge LiteLLM
snapshot with its own parity tests) stays deferred: the full table is ~4.5MB, the
deployed edge functions have no need for the long tail, and option 1 puts every
promoted key under the existing parity guard for free.

Policy: **promote on production usage, not speculatively.** A model qualifies when
(1) the local model breakdown resolves it via a `litellm:*` source, and (2) it has
non-trivial production volume. Rates are copied from the LiteLLM cache the local
engine has been billing with — never invented.

## 2026-10-31 promotion set

Reconciliation method (reproducible): request
`/functions/tokentracker-usage-model-breakdown?from=…&to=…` locally, keep rows whose
`pricing.source` starts with `litellm`, then evaluate the edge canonical
`MODEL_PRICING`/`getModelPricing` block (the same extraction `edge-pricing-parity`
uses) against each row.

Two distinct situations emerged:

1. **True edge gaps (cloud showed unpriced)** — promoted into both curated and edge:
   - `gpt-6-luna` 0.1/0.5/0.01/0.125 (LiteLLM bare key; OpenAI list)
   - `muse-spark-1.2-contributor` / `muse-spark-1.3-contributor` 0.1/0.2/0.002
     (LiteLLM provider-qualified entries agree: `meta/…` and `opencode_go/…`)
2. **Edge already priced them (edge-only keys), curated did not** — local billing
   depended on the LiteLLM cache matching the hand-verified edge rate. Promoted into
   curated (and, where the bare id had no edge exact key, into edge too) after
   verifying edge rate == LiteLLM rate == what production was billed:
   `gpt-5.5` (5/30/0.5), `gpt-5.4` (2.5/15/0.25), `gpt-5.4-mini` (0.75/4.5/0.075),
   `gpt-5.2` (1.75/14/0.175), `gpt-5.3-codex-spark` (1.75/14/0.175 — not a separate
   LiteLLM key; both engines bill the base gpt-5.3-codex rate),
   `claude-opus-4-5` bare (5/25/0.5/6.25), `claude-opus-4-6` (5/25/0.5/6.25),
   `claude-sonnet-4-6` (3/15/0.3/3.75), `gemini-3-flash-preview` (0.5/3/0.05),
   `mimo-v2.5` (0.4/2/0.08), plus containment-guard `mimo-v2.5-pro` (1/3/0.2).

`mimo-v2.5-pro` needs its own exact entry: once `mimo-v2.5` exists in curated, the
matcher's contained-exact fallback would otherwise bill `mimo-v2.5-pro` at the base
rate (0.4/2) instead of the correct 1/3. Exact hits run before containment, so the
pair must land together.

Dollar neutrality was verified by re-pricing every production row with the new
curated table: identical totals (≤ the endpoint's `toFixed(6)` storage rounding),
15 rows only relabel `litellm:*` → `curated:exact`.

`test/edge-pricing-parity.test.js` gained a dedicated test asserting local↔edge rate
equality for the whole promotion set, and the regression-key list pins the five new
edge entries.

## Flagged for the maintainer (not fixed here)

- **Pre-existing cloud↔local rate divergence**: `gemini-3.8-flash` /
  `gemini-3.7-flash` are billed 0.5/3/0.05 by the edge fuzzy chain but 0.75/3.75/0.075
  by LiteLLM locally (production exposure 2026: ~2.9M tokens / $0.43). Promoting them
  would have required picking a side and changing one side's dollars — left to the
  owner. They stay out of the promotion set and out of the new parity test.
- **Reseller-rate freeze risk**: `step-5-preview` (workbuddy) and `qwen3.7-plus`
  (opencode) are true edge gaps, but the local engine reaches their rate through
  LiteLLM's *lexicographically smallest provider key* (`kyma/…` → 1.35/3.645/0.135,
  `aihubmix/…` → 0.282/1.128/0.0564/0.3525), while `opencode_go/…` lists
  1.0/2.7/0.1 and 0.4/1.6/0.04/0.5 respectively. Writing the lexicographic accident
  into curated as a canonical rate is a product call; deferred pending owner input
  (tracked in #929). Until then these two stay unpriced on the cloud account scope.
- **Deploy lag**: repo-side pricing fixes only reach production when the touched
  edge functions are redeployed (owner-gated rollout per
  `docs/cloud-release-readiness.md`). This includes #890's `gpt-6.1-terra`.

## Review checklist addition

When adding curated pricing (CLAUDE.md "Add pricing for a model" row): check the
production model breakdown for `litellm:*` rows and promote production-hit models in
the same change, so the cloud edge tables and the curated/edge parity guard keep up.

## Follow-ups

- Owner: redeploy the five touched edge functions (also clears the #890 terra lag).
- Owner: decide the reseller-rate question for `step-5-preview` / `qwen3.7-plus`.
- Re-run the reconciliation periodically (or after notable new-model adoption); the
  contained-exact hazard means a promotion is not always a mechanical one-line diff.
