# GPT-6.2 pricing and pricing-only rollout

Official evidence retrieved 2026-11-18 (Asia/Shanghai):

- Announcement: https://openai.com/index/introducing-gpt-6-2-astra-sol/
- Astra: https://developers.openai.com/api/docs/models/gpt-6.2-astra.md
- Sol: https://developers.openai.com/api/docs/models/gpt-6.2-sol.md
- Full tiers: https://developers.openai.com/api/docs/pricing

The general-purpose API IDs covered are `gpt-6.2-astra` and `gpt-6.2-sol`.
The official pricing page additionally confirms specialist `gpt-6.2-astra-law`
under Legal model configurations; its Standard short/long rates equal Astra.
No Fast/Ultrafast specialist price is published, so it does not inherit those
multipliers. No dated snapshots,
GPT-6.2 Terra/Luna/Pro/Codex SKUs or floating aliases are confirmed here.
Provider prefixes and reasoning-effort decorations are lookup aliases, not claims
of additional released API models. Unknown variants remain unpriced unless an
explicit future exact data entry supplies a rate.

USD per million tokens, Standard short-context API-equivalent estimates:

| Model | Input | Cached input | Output | Cache write 30m | Cache write 12h |
| --- | ---: | ---: | ---: | ---: | ---: |
| gpt-6.2-astra | 8 | 0.40 | 40 | 10 | 20 |
| gpt-6.2-sol | 2 | 0.10 | 10 | 2.50 | 5 |
| gpt-6.2-astra-law | 8 | 0.40 | 40 | 10 | 20 |

Above 272,000 **request input** tokens (cache included), input/cache rates double
and output is 1.5x for the full request. Fast is 2x; Ultrafast is 3x through
2027-02-28 Pacific and 6x starting 2027-03-01 Pacific (08:00 UTC). Local observed
speed/context subsets compose these multipliers, never infer long requests from
a large aggregate, and never charge Codex reasoning twice. The dated promotion
uses the usage bucket's `hour_start` or `timestamp`. Session totals sum complete
dated per-model buckets across the cutoff; older records without complete buckets
use the recorded session start/end as an estimate. Truly undated estimates cannot
reconstruct historical tiers and use current time.

Batch is 50% of Standard. Current rows cannot distinguish Batch or 12h cache
retention; cache-write estimates use the documented 30m rate. Cloud aggregates
lack request context/speed subsets and remain **Standard short-context estimates**,
not a reconstruction of provider invoices or ChatGPT subscription charges.

## Canonical files and distribution

- Local/offline overrides: `src/lib/pricing/curated-overrides.json`.
- Local matcher/calculation: `matcher.js` / `index.js` in that directory.
- Canonical cloud block: `dashboard/edge-patches/tokentracker-leaderboard-refresh.ts`,
  from `const MODEL_PRICING` through `getModelPricing`; mirrored verbatim in
  account-daily, account-summary, account-model-breakdown, leaderboard-profile.
- `test/edge-pricing-parity.test.js` checks byte parity;
  `test/gpt-6-2-pricing.test.js` checks rates, aliases, cost and boundaries.
- There is **no central TokenTracker pricing JSON endpoint** in this pipeline.
  Cloud pricing is embedded in five separately deployed functions. Updating a
  repository file alone does not update the backend or released clients.
- Released clients can already obtain the base rates from LiteLLM's public feed:
  `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`.
  Fresh upstream data verified 2026-11-18 includes the two bare IDs at the above
  Standard rates. The disk cache has a 24h TTL; fetch occurs on load/startup and
  a process loads once, not a guaranteed 24h running-process hot refresh. Offline
  uses stale cache/bundled seed. Existing clients do not gain the new curated
  promotion/context handling merely because the upstream feed updates.

## Backend-only update checklist (no client release)

1. Verify official model IDs and all relevant rates; record retrieval time, URLs,
   and source hashes. Never substitute reseller or subscription prices.
2. Change only supported pricing data/matching; update all five source blocks and
   regression tests. Run all pricing suites, guards/build and actual independent
   Astra/high review; wait for exact-HEAD CI and CodeQL before merge/deploy.
3. Use the supported authenticated InsForge CLI. Verify the linked project is
   `tokentracker` (`dafcdf16-cd58-4d8d-b6d5-9f03f7edcf91`, us-east). Never read or
   copy stored credentials into scripts, logs, documentation or source control.
4. `insforge functions code <slug> --json` reads the currently deployed source.
   Hash and preserve each of the five live sources. Do **not** overwrite live
   functions with an unrelated full-main bundle: historical production/source
   drift exists, particularly leaderboard-profile. Apply only the reviewed new
   rate entries and strict model lookup to the live source, using unique checked
   anchors; prove removing the additions restores the original bytes exactly.
   Independently evaluate old/new pricing blocks: every pre-existing model lookup
   must remain unchanged; new models must match the official table. Review these
   exact deploy artifacts as well as the repository diff.
5. Re-read and compare each live hash immediately before deploy; concurrent changes
   are a stop/rebase condition. Deploy only the five price-patched artifacts with
   `insforge functions deploy <slug> --file <reviewed-file> -y`. Do not deploy
   billing, webhooks, gifts or other functions. No migrations, charges, refresh/
   repricing jobs or billing record changes are needed or authorized by this flow.
6. Read each source back using the same supported CLI; require active status,
   updated deployment metadata and exact SHA256 equality to reviewed artifacts.
   Evaluate those actual read-back price blocks against the official cases. Never
   invoke leaderboard-refresh or modify real usage/billing records as a smoke test.
7. Record exact PR/merge SHA, CI/review evidence, per-function before/after hashes,
   deployed timestamps and scope limitations. A partial deploy is partial, not
   success; resume only the missing verified functions without overwriting drift.

Do not bump/tag/publish npm or desktop clients as part of pricing-only rollout.
Do not bulk rewrite historical costs. Structural model/tier semantics not covered
by the existing engine require a separate reviewed decision, not guessed rates.
