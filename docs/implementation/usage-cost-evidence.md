# Usage cost evidence and coverage

## Reference and boundaries

Reference: [T3 Code](https://github.com/pingdotgg/t3code/tree/85aaef42d45681d3c02220a458464f1663a45bef), especially `packages/provider-grok/src/server/usage.ts`, `packages/provider-cursor/src/server/accountUsage.ts`, and `apps/server/src/usage/usagePricing.ts`. T3 consumes reported amounts; it does not supply an authoritative tariff for Cursor's opaque `grok-bot-*` products. No third-party empirical price mapping is introduced here.

This PR changes **local derived usage** and existing local UI disclosures. It does not deploy functions, change subscription billing, rewrite original logs, recompute production history, release a client, or claim to reconcile leaderboard totals.

## Amount contract (local coverage v1)

- Grok Build: `costUsdTicks` (and existing alternate spellings) / 10,000,000,000, otherwise explicit USD fields. Partial/incomplete reported amounts are not treated as complete. Input includes cache reads/writes; normalization subtracts them once. Reasoning is already part of provider output and becomes a disjoint local column.
- Cursor Grok Bot: the **existing CSV `Cost` field** is retained as a source-recorded export/paid amount, including explicit zero. Empty/invalid values remain missing. A supplied `tokenUsage.totalCents` is interpreted in cents, not ticks; this is supported by normalization, but **the existing CSV fetch does not magically acquire per-event cents**. No new private API or credential access is added. Source-recorded cost is not necessarily out-of-pocket billing or API-equivalent list price.
- `cost_coverage.version=1` stores the recorded sum, recorded/missing/allocated event counts, a fixed allowlist of field origins, and disjoint uncovered token columns. It never stores prompts, paths, gateway hosts, credentials, or raw source objects.
- Only uncovered tokens are estimated; unknown models remain unpriced, not free. Explicit recorded zero is not a missing-cost sentinel. Free Grok Build SKUs remain zero. Existing non-Bot Cursor API-equivalent estimates and Cline free/pass rules are unchanged.
- Grok Build model entries with missing costs may receive only the remaining trustworthy top-level turn amount, proportionally by token share. They are marked `grok_allocated`; allocation is not an official model rate. A parent total below the known child sum is not allocated. Queue and session scanners share this extraction. Free children do not dilute the paid-child allocation denominator. Parent partial/incomplete flags remain visible, and an unreadable v5-to-v6 migration input defers rebuilding without advancing the cursor or retracting prior usage.
- Local device-history transfers export `tokentracker.local-usage.v2` only when coverage is present, retain the allowlisted evidence through import, and still accept legacy v1 snapshots. Old clients reject v2 rather than silently reprice recorded zero/mixed amounts. Account-level Cursor exports remain excluded by the existing cross-device dedup policy.
- Grok cursor v6 and session sidecar v32 rebuild local derived snapshots on the next normal scan, without changing raw event files. No scan is executed against a user's home by opening this PR.

### Explicit cloud compatibility limit / rollout gate

The current cloud schema and grouped account/leaderboard RPCs cannot represent cost coverage, explicit reported zero, or uncovered token subsets. This PR **does not pretend otherwise**: upload preparation strips local `cost_coverage`; existing numeric fields and ingest schema stay compatible. Cloud pricing retains existing semantics and does not receive guessed Bot rates. Do not advertise local/cloud cost parity or deploy only the five price functions to enable this feature.

Before a future cloud rollout, a separately validated transactional migration must preserve versioned coverage through device ingestion, cross-device deduplication, daily/model grouping and compact RPC wire formats, and then update the five embedded pricing functions from their actual production baselines. Aggregating recorded dollars without covered/uncovered token subsets would recreate the mixed-coverage undercount. That migration and production validation are **not implemented in this PR**. Thus the local feature is implemented, but cloud cost-provenance parity remains an explicit unfinished requirement, not a healthy state.

## Four product improvements

1. **Coverage and scope:** local session response includes allowlisted scan inventory counts/states, actual check timestamp when available, latest observed event, requested range, pricing health, and local/cloud/leaderboard scope descriptions. Full completeness watermark, malformed-record coverage, cloud cutoff and leaderboard cutoff remain null/unknown. Discovered directories are not proof of zero usage; observed is not complete. No path or exception text is exposed by the new diagnostic shape. The existing disclosure explicitly says it does not fix backend aggregation.
2. **Unknown price refresh:** initialized pricing processes trigger a nonblocking single-flight catalog refresh on a miss, with a global 60-second cooldown. Failures retain current in-memory rates; invalid/empty catalogs do not replace them. Success increments revision, invalidates negative/model-info caches, and lets existing revision-keyed derived caches recompute estimates from unchanged token data. Curated precedence remains unchanged. No production auto-deployment is triggered.
3. **Alias ambiguity:** exact/source-curated/normalized aliases keep existing priority. Provider-qualified aliases use the actual vendor when known (`grok`→xAI, `codex`→OpenAI, `claude`→Anthropic); router/CLI names do not invent vendor identity. Conflicting candidate rates return unpriced/ambiguous instead of the alphabetically first reseller; identical rates remain usable. All Cursor `grok-bot-*` numeric lookups stay unpriced even if an upstream table guesses a rate.
4. **Calculation disclosure:** existing expanded model details explain recorded, model-estimated, unpriced, mixed and proportionally allocated amounts, including subscription meaning. No main-card symbol or `≥` is added. The session page's optional coverage disclosure stays within the existing visual style.

## Verification

Regression coverage includes explicit zero vs missing/invalid, mixed coverage, Grok top-level allocation, Cursor CSV ingestion→queue→local calculation, paid/export vs public-price semantics, free handling, vendor collision/exact precedence, catalog concurrency/cooldown/revision/failure, privacy allowlisting/unknown cutoffs, legacy upload compatibility, and rendered disclosures. Production data and live functions are not verification fixtures.
