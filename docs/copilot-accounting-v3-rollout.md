# Copilot accounting v3: maintainer rollout

VS Code `customendpoint/*` sessions prove aggregate prompt/completion counts,
not the prompt's fresh/cache split. Store unknown input in the disjoint
`unclassified_input_tokens` column: include it in volume, return
`total_cost_usd: null` / `cost_status: partial`, and retain only the provable
subtotal in `known_cost_usd`. A discovery-only split would not fix visible
usage totals; putting these counts into uncached input would invent billing.

This PR retains full accounting pending the maintainer's scope/contract decision.
It is integrated with upstream `d3946d4a` (including v1.4.8), which lacks this session
reader. Private OpenCode adapters are excluded. No production deployment,
activation, client installation, version bump or release has been performed.
CI green is not product approval; assign deployment and rollback owners first.

## Deployment order

1. Validate against an isolated current-main schema and back up schema/totals.
   Compact/wire, transactional ingest, archive/restore and device-reset migrations
   are prerequisites. Use `20261019120000_unclassified-input-tokens.sql`, not the
   superseded September migration. An experimental database that applied the old
   migration needs explicit schema reconciliation; this is not a second,
   idempotent application.
2. Apply the migration atomically. Installed-function edits check exact anchors
   and expected match counts, abort on drift, and compile once per function after
   all projections are updated. Preserve OIDs, ACLs, canonical pricing,
   membership gates, maintenance/read locks and correction revisions.
3. Keep ingest's server-side `TOKENTRACKER_ACCOUNTING_V3_READY` absent or `0`
   while deploying every changed account, ingest, leaderboard/profile and SVG
   edge. Default OFF: schema readiness alone cannot admit partial rows.
   Complete legacy rows remain accepted; partial/mixed POSTs fail closed (503).
   Request/query parameters cannot enable this setting.
4. Verify an isolated account: mixed known/unknown rows, machine mirrors, device
   convergence, session LWW, cold/hot parity, corrections, restore (including
   pre-v3 packs), lifetime repairs and unauthorized reads. Verify actual numeric
   responses, not just deployment exit codes. Incomplete costs must never appear
   as complete bills.
5. After staging acceptance and all readers are verified, the maintainer sets
   `TOKENTRACKER_ACCOUNTING_V3_READY=1`. Ingest's `?capabilities=1` must report v3.
   Both the setting and database capability RPC are required; absent/unavailable
   RPCs report v2. Recheck complete legacy traffic, then release CLI and all
   bundled desktop clients through the normal upstream workflow.

Hourly and session uploads negotiate capability within the upload deadline and
recheck cancellation before POST. Unsupported rows retain their local queue
offset. The DB capability marker is installed last, inside the transaction.
Leaderboard wire rows keep their eleven existing slots; unknown counts use
optional parallel metadata during migration-to-edge rollout.

## Rollback and queue tradeoff

First disable the ingest switch, then stop new client rollout. Retain additive
schema, queued history and partial-aware readers. Once partial rows exist,
reverting readers to v2 could misrepresent subtotals as complete bills. Do not
drop columns or reset history without a separately verified data-safe plan.

Admission is fail-closed, not per-provider isolation: a partial row can hold
co-batched AND later complete records at the shared queue offset. Local history
remains intact; mixed batches are never partially acknowledged. This tradeoff
needs maintainer acceptance. Independent deferred-provider queues are outside
this PR's scope.

## Verification

Run `npm test`, dashboard tests/typecheck/build and repository validators.
The unconditional PGlite integration tests exercise real current-main functions,
migration rollback on drift, function identity/settings/ACL retention, device
convergence and archive/wire/rollup corrections. Edge tests cover billing and
the default-off gate; parser/local-API and upload tests cover mixed costs,
bounded cursor state, repeat scans, old-cloud rejection and offset retention.
Local passes do not establish native CI success or production readiness.
