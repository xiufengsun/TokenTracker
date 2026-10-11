# Cloud usage archive

The archive keeps the complete hourly record in private PostgreSQL JSONB packs, grouped by user, device and UTC day. New uploads remain in the hourly table. A server revision selects the latest complete record for each original hourly key before the existing machine, Cursor and TRAE aggregation rules run. A correction can reduce a count to zero.

This implements local storage and aggregation support. It installs no schedule and has not moved or deleted production usage.

2026-10-09 handoff reconciliation: later isolated hosted QA verified cold corrections, bounded logical recovery and controlled samples; see [delivery evidence](cloud-delivery.md). Those checks do not complete production migration, performance, erasure, concurrent maintenance or scheduled activation. Current source and rollout gates are in the [release handoff](cloud-release-readiness.md).

## Data and read paths

- Every hourly field is retained, including all token columns, conversations, billable counts, cost metadata, timestamps and revision. UTC packs preserve half-hour placement, so IANA timezones, DST and fixed offsets can still be applied at read time.
- `tokentracker_account_session_states` remains the canonical TRAE truth. It is not compacted or deleted. Session changes mark both the previous and current UTC day for repair.
- Personal hourly visibility is 90 days and daily/monthly visibility is 24 months under the Cloud access guard. These are visibility limits. Older complete truth remains available to server-side public lifetime repairs.
- Public daily and lifetime rollups remain intact. Moving a day to cold storage never deletes a rollup as a retention action.
- Legacy device convergence merges the two cold histories into the canonical device before revoking the legacy device. It preserves the existing whole-row choice during convergence. Later canonical uploads use the new server revision and can lower that merged value.

`cloud_usage_hourly(user, device, from, to)` filters manifests by user/device/UTC day before expanding their JSONB. It merges hot rows with the selected cold generations by `(user_id, device_id, hour_start, source, model)` and descending server revision. It grants execution only to `project_admin`.

The migration changes these inspected function bodies while retaining their OIDs and ACLs:

| Function | Change |
| --- | --- |
| `account_usage_grouped` | Read unified truth and call the installed `leaderboard_pricing_tier` |
| `leaderboard_hourly_dedup_v2` | Read unified truth in its two hourly branches; keep the session branch |
| `refresh_tokentracker_device_identity` | Transfer cold ownership inside legacy convergence |
| `leaderboard_rollup_daily_advance_v2` | Repair bounded dirty days and keep cold/session/rollup dates in the history floor |
| `cloud_issue_device_token`, `cloud_ingest_usage` | Acquire the user maintenance lock before existing environment/device/row locks |

The existing cached account wrapper, wire/compact account RPCs, public profile and rollup writers resolve these functions. Canonical model pricing is not overwritten. The migration checks the verified DeepSeek weekend boundary and aborts if a required schema or SQL body has drifted. InsForge executes the migration inside its own transaction; the file contains no transaction-control statements.

## Prepare and commit

Both RPCs require the server role. Do not expose them through a client route.

1. Call `cloud_prepare_usage_archive(user, device, day)` for a complete UTC day older than the 90-day hot window. Empty days return `NULL`. A pack is bounded to 10,000 records and 8 MiB.
2. Preparation stores a generation, its previous manifest, row count, checksum, revision range and hot deletion snapshot. Payload and deletion revisions share one SQL statement snapshot. Prepared data is not visible to readers.
3. Call `cloud_commit_usage_archive(generation)`. It locks that user/device/day, rechecks device state and the previous manifest, verifies payload scope/count/checksum/revisions and checks that the deletion snapshot is covered by the payload.
4. Commit switches the manifest and removes only hot rows whose revision still equals the captured snapshot. Any intervening correction remains hot. These writes share the caller's database transaction.
5. The previous generation becomes `superseded` and its payload is cleared. The committed generation's temporary deletion snapshot is also cleared. Retrying the current generation returns `already_committed=true` and `is_current=true`. Retrying a superseded generation reports `status=superseded`, `already_committed=false`, `is_current=false` and the current generation ID; it does not switch the manifest back.

Stale preparations, changed device ownership/state and verification failures leave the existing manifest and hot truth untouched. Prepare again after inspecting the error. A failed transaction must be rolled back by the caller.

`cloud_repair_usage_days(limit)` repairs at most seven closed UTC days per call. It rereads complete hot/cold/session truth and only clears dirty markers whose revision still matches its snapshot. The existing rollup advance calls it before cyclic repair. This adds bounded work to the existing refresh; its production execution budget remains an acceptance check.

Hourly/session changes invalidate account caches once per SQL statement using transition tables and distinct users. A user-key expression index supports the cache delete. An upsert can run both insert and update statement triggers; it does not run one cache delete per bucket.

## Local runner, restore and usage erasure

`scripts/cloud-usage-archive.cjs` defaults to dry-run. Provide `INSFORGE_BASE_URL` and `INSFORGE_SERVICE_ROLE_KEY` in the environment. Every command requires an exact user UUID. It reports the selected UTC range, available/selected targets and row counts. `--from` is inclusive and `--to` exclusive. Archive/restore batches are limited to 100 days and cleanup to 1,000 generation rows.

Use `--action archive|restore|cleanup|erase-user`; archive is the default. `--apply` performs writes, and `--checkpoint PATH` stores the reviewed scope and operation UUIDs with mode `0600` before any mutation. `--apply --resume` resumes that same scope. A lost prepare or commit response reuses the server operation instead of creating another generation or deleting later data. Existing checkpoint paths require resume or a fresh path. Credentials are never stored in checkpoints or output, and HTTP redirects are rejected.

Apply is restricted to loopback backends in this delivery. Hosted endpoints support dry-run. There is no flag to bypass the hosted apply restriction. Production activation still requires owner review and the hosted checks below.

- Restore updates an existing hot row only when its revision is older than the original cold revision. Missing rows are inserted with `ON CONFLICT DO NOTHING`. It verifies coverage before retiring the manifest, so a newer hot correction survives. All steps and the operation result commit together. Restoring does not delete public rollups.
- Cleanup removes only the exact user's unreferenced `superseded` generation metadata whose payload is already `NULL` and commit is older than 30 days. Active packs and prepared payloads remain. Operation replay performs no second cleanup batch.
- Usage erasure additionally requires `--confirm-user` to exactly match `--user`. `cloud_erase_user_usage` atomically removes that user's hot/cold/session usage, usage caches and public usage aggregates, revokes old tokens, and pauses existing synchronization slots. It also clears that user's rows from the inspected `tokentracker_leaderboard_snapshots`, `agentmeter_leaderboard_snapshots`, legacy daily rollup and `agentmeter_hourly` compatibility tables when present. Preview reports these additional counts. Other users' public aggregates and snapshots remain unchanged. Auth identity, profiles/settings, subscription/payment/order/event records and membership are retained. This is usage erasure, not account or financial-record deletion.
- Erasure cancels earlier usage-maintenance operations for that user, clearing their stored scopes/results. The erasure operation retains its private completion audit for retry safety. Replaying that operation does not erase data explicitly uploaded later through a new synchronization session.

Archive/restore/erasure and token issuance/ingest/legacy convergence acquire the same user advisory lock before their existing lower-level locks. This defines the intended order; the PGlite tests do not prove real multi-connection lock behavior.

## Local evidence

Run `node --test test/cloud-usage-archive*.test.js`. Tests execute the migration and the existing aggregation/rollup/identity code in PGlite PostgreSQL. They cover staged corrections, zero counts, stale/corrupt generations, all retained fields, legacy convergence, lifetime triggers, session moves, client ACLs and SQL drift rollback. Restore and erasure failures are injected after earlier writes to verify transaction rollback. Erasure tests compare retained financial rows and another user's lifetime totals before and after. The same-database integration also applies billing and machine migrations and exercises the actual ingest RPC before and after compaction.

Runner tests execute the actual CLI subprocess against a loopback HTTP adapter backed by the real SQL RPCs under the `project_admin` role. They verify dry-run, bounded apply, prepare/commit response loss and checkpoint resume, restore, cleanup, exact erasure confirmation, credential-safe checkpoints and redirect rejection. This verifies the isolated CLI/HTTP/database chain; it is not hosted staging evidence.

The timezone matrix compares 54 device/truncation/timezone combinations, including New York DST, Lord Howe, Kathmandu and an invalid-zone offset fallback. Mutation checks make tests fail when latest-revision selection is reversed or revision-safe deletion is removed.

In the local 480-row/10-day fixture, hourly PostgreSQL datum bytes measured 88,320 bytes. Ten compressed payloads measured about 15.9 KB; generation rows including metadata measured about 17.8 KB. These measurements exclude manifests, indexes, dead heap pages, backups and service billing. Deleting hot rows normally makes heap space reusable; it does not immediately shrink the database file. This sample does not establish a production savings percentage.

A separate 20,000-key cache fixture uses PostgreSQL `EXPLAIN` to check the user expression index. A 500-row insert runs one cache invalidation statement and preserves other users' cache entries.

## Activation checks still pending

- Re-read exact hosted schema/functions, take a recoverable backup and apply to an isolated hosted staging project. Run account/profile/public parity with real data and representative cold ranges before moving any production day.
- Measure the hosted account and public repair queries with `EXPLAIN (ANALYZE, BUFFERS)`, including 24-month fills, simultaneous writes, cache upserts and daily repair. PGlite verifies semantics but does not prove hosted latency, TOAST compression settings or edge timeouts.
- Validate the runner's hosted deployment workflow and approved activation mechanism. Add a bounded abandoned-preparation policy only after confirming its operations cannot resume. Current committed payloads must be retained.
- Test the provider's migration transaction and deploy sequence. Readers must be switched before any hot removal. Keep all archive RPCs unavailable to client JWT roles.
- Verify account deletion and moderation workflows use the scoped usage-erasure operation and preserve required financial records. Define provider backup retention and recovery handling for previously erased usage; active-table erasure does not rewrite provider backups or the retired SQL rollup backup. Usage erasure does not delete `auth.users`; deleting or revoking a device does not erase account usage.
- Validate restore and maintenance lock order with real concurrent hosted connections, including uploads, legacy merges, cache fills and operation retries. Restore the latest unified whole rows before reverting read functions or dropping packs. Never drop the only complete copy of a day.

Until these checks pass, do not enable a retention schedule or claim production cost reduction. Merchant registration and payment verification do not satisfy archive activation checks.
