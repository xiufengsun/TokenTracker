"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const readMigrationBySuffix = (suffix) => {
  const file = fs.readdirSync(path.join(ROOT, "migrations"))
    .find((name) => name.endsWith(`_${suffix}.sql`));
  assert.ok(file, `missing migration ending in _${suffix}.sql`);
  return read(`migrations/${file}`);
};

const ACCOUNT_FUNCTIONS = [
  "tokentracker-account-summary.ts",
  "tokentracker-account-daily.ts",
  "tokentracker-account-hourly.ts",
  "tokentracker-account-monthly.ts",
  "tokentracker-account-heatmap.ts",
  "tokentracker-account-model-breakdown.ts",
];

const USER_JWT_FUNCTIONS = [
  ...ACCOUNT_FUNCTIONS,
  "tokentracker-account-devices.ts",
  "tokentracker-device-flow-grant.ts",
  "tokentracker-device-rename.ts",
  "tokentracker-device-token-issue.ts",
  "tokentracker-leaderboard-profile.ts",
  "tokentracker-leaderboard-refresh.ts",
  "tokentracker-profile-likes.ts",
  "tokentracker-public-visibility.ts",
];

test("user-authenticated edge functions verify current RS256 and legacy HS256 tokens", () => {
  for (const file of USER_JWT_FUNCTIONS) {
    const source = read(`dashboard/edge-patches/${file}`);
    assert.match(source, /header\.alg === "RS256"/u, `${file} must accept current RS256 access tokens`);
    assert.match(source, /Deno\.env\.get\("JWT_PUBLIC_KEY"\)/u, `${file} must verify RS256 with the managed public key`);
    assert.match(source, /RSASSA-PKCS1-v1_5/u, `${file} must use the RS256 Web Crypto algorithm`);
    assert.match(source, /header\.alg === "HS256"/u, `${file} must preserve legacy sessions during migration`);
    assert.match(source, /Deno\.env\.get\("JWT_SECRET"\)/u, `${file} must verify legacy HS256 signatures`);
  }
});

// account-summary and account-heatmap read through a per-endpoint compact RPC
// that folds the rollup into Postgres instead of shipping per-row detail to the
// edge (migrations/*_fold-account-summary-and-heatmap-aggregation.sql). Those
// RPCs delegate to account_usage_grouped_cached themselves, so the shared-cache
// guarantee still holds — it is asserted against the migration below.
const COMPACT_ACCOUNT_RPCS = new Map([
  ["tokentracker-account-summary.ts", ["account_summary_compact", "fold-account-summary-and-heatmap-aggregation"]],
  ["tokentracker-account-heatmap.ts", ["account_heatmap_compact", "fold-account-summary-and-heatmap-aggregation"]],
  ["tokentracker-account-model-breakdown.ts", ["account_model_breakdown_compact", "fold-account-model-breakdown-aggregation"]],
  ["tokentracker-account-daily.ts", ["account_daily_compact", "fold-account-daily-aggregation"]],
]);

test("cloud account reads use the shared cached RPC instead of a device lookup plus aggregation", () => {
  for (const file of ACCOUNT_FUNCTIONS) {
    const source = read(`dashboard/edge-patches/${file}`);
    const compact = COMPACT_ACCOUNT_RPCS.get(file);
    if (compact) {
      assert.match(source, new RegExp(`rpc\\("${compact[0]}"`, "u"),
        `${file} must read through its compact RPC`);
    } else {
      assert.match(source, /rpc\("account_usage_grouped_cached"/u,
        `${file} must use the cross-isolate cached RPC`);
    }
    assert.doesNotMatch(
      source,
      /\.from\("tokentracker_devices"\)/u,
      `${file} must not spend a second PostgREST connection resolving devices`,
    );
    // Same coalescing / TTL / stale-fallback contract either way; the compact
    // readers name the symbols COMPACT_* instead of GROUPED_ROWS_*.
    assert.match(source, /const (?:groupedRows|compact)InFlight = new Map/u,
      `${file} must coalesce identical concurrent RPC reads`);
    assert.match(source, /(?:GROUPED_ROWS|COMPACT)_TTL_MS = 30_000/u,
      `${file} must shield the backend from old-client polling storms`);
    assert.match(source, /(?:GROUPED_ROWS|COMPACT)_STALE_IF_ERROR_MS = 5 \* 60_000/u,
      `${file} must retain a bounded stale fallback for transient 5xx responses`);
  }
});

test("compact account RPCs delegate to the shared cached RPC and stay project_admin-only", () => {
  const seen = new Map();
  for (const [rpc, suffix] of COMPACT_ACCOUNT_RPCS.values()) {
    const migration = readMigrationBySuffix(suffix);
    seen.set(suffix, migration);
    assert.match(migration, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${rpc}\\(`, "u"),
      `${rpc} must be defined in migration *_${suffix}.sql`);
    // Postgres grants EXECUTE to PUBLIC by default; without this an anon caller
    // could pass any p_user_id and read another account's usage.
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`, "u"),
      `${rpc} must revoke the default PUBLIC execute grant`);
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\) TO project_admin;`, "u"),
      `${rpc} must be executable by project_admin`);
  }
  // Every compact RPC must read through the shared 30s cache, never re-scan.
  const allRpcs = [...COMPACT_ACCOUNT_RPCS.values()].map(([rpc]) => rpc);
  for (const [suffix, migration] of seen) {
    const definedHere = allRpcs.filter((rpc) =>
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.${rpc}\\(`, "u").test(migration)).length;
    assert.equal(
      (migration.match(/public\.account_usage_grouped_cached\(/gu) || []).length,
      definedHere,
      `each compact RPC in *_${suffix}.sql must delegate to account_usage_grouped_cached exactly once`,
    );
    assert.doesNotMatch(migration, /FROM public\.tokentracker_hourly/u,
      `compact RPCs in *_${suffix}.sql must not bypass the shared cache with their own scan`);
  }
});

test("shared account cache is bounded, locked per key, and access controlled", () => {
  const source = read("migrations/20260718071507_add-shared-account-usage-cache.sql");
  assert.match(source, /CREATE UNLOGGED TABLE public\.tokentracker_account_usage_cache/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.account_usage_grouped_cached/u);
  assert.match(source, /interval '30 seconds'/u);
  assert.match(source, /pg_advisory_xact_lock\(hashtextextended\(v_cache_key, 0\)\)/u);
  assert.match(source, /public\.account_usage_grouped_v2\(/u);
  assert.match(source, /LIMIT 256/u);
  assert.match(source, /ENABLE ROW LEVEL SECURITY/u);
  assert.match(source, /REVOKE ALL ON public\.tokentracker_account_usage_cache FROM PUBLIC, anon, authenticated/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.account_usage_grouped_cached/u);
});

test("shared account cache cleanup cannot deadlock concurrent cold fills", () => {
  const source = readMigrationBySuffix("harden-backend-concurrency");
  assert.match(
    source,
    /ORDER BY stale\.fetched_at, stale\.cache_key[\s\S]{0,80}FOR UPDATE SKIP LOCKED[\s\S]{0,80}LIMIT 256/u,
    "cleanup must lock stale rows in one deterministic, non-blocking order",
  );
  assert.match(
    source,
    /DELETE FROM public\.tokentracker_account_usage_cache AS c[\s\S]{0,160}USING stale/u,
    "cleanup must delete only the rows claimed by the skip-locked batch",
  );
});

test("DeepSeek V4 time pricing survives account and leaderboard aggregation", () => {
  const source = readMigrationBySuffix("deepseek-v4-time-pricing");
  assert.match(source, /tokentracker_hourly_deepseek_v4_hour_idx/u);
  assert.match(source, /RENAME TO account_usage_grouped_legacy_v1/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.account_usage_grouped_v2/u);
  assert.match(source, /v2-deepseek-time-pricing/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.leaderboard_deepseek_v4_grouped/u);
  assert.match(source, /THEN 'peak' ELSE 'off_peak'/u);
  assert.match(source, /lower\(r\.model\) NOT LIKE '%deepseek-v4-flash%'/u);
  assert.match(source, /public\.leaderboard_deepseek_v4_grouped\(p_from, p_to\)/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.account_usage_deepseek_v4_grouped/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.leaderboard_deepseek_v4_grouped/u);
});

test("single-scan account candidate preserves dedup and pricing without rereading hourly", () => {
  const source = readMigrationBySuffix("add-single-scan-account-usage-candidate");

  assert.match(source, /base AS MATERIALIZED/u);
  assert.equal(
    (source.match(/FROM public\.tokentracker_hourly h/gu) ?? []).length,
    1,
    "the large hourly table must be read once per aggregation",
  );
  assert.match(source, /COALESCE\(dm\.machine_cluster_id, h\.device_id::text\)/u);
  assert.match(source, /h\.source = 'cursor'/u);
  assert.match(source, /FROM public\.tokentracker_account_session_states s/u);
  assert.match(source, /THEN 'peak' ELSE 'off_peak'/u);
  assert.doesNotMatch(source, /account_usage_grouped_legacy_v1\(/u);
  assert.doesNotMatch(source, /account_usage_deepseek_v4_grouped\(/u);
  assert.match(
    source,
    /REVOKE ALL ON FUNCTION public\.account_usage_grouped_single_scan_candidate[\s\S]*FROM PUBLIC, anon, authenticated/u,
  );
});

test("single-scan account aggregation is promoted without invalidating the shared cache", () => {
  const migration = readMigrationBySuffix("promote-single-scan-account-usage");
  const opsSource = read("scripts/ops/account-usage-grouped-rpc.sql");

  assert.match(
    migration,
    /account_usage_grouped_single_scan_candidate[\s\S]*RENAME TO account_usage_grouped/u,
  );
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.account_usage_grouped_v2/u);
  assert.match(migration, /DROP FUNCTION public\.account_usage_grouped_pre_single_scan/u);
  assert.doesNotMatch(
    migration,
    /CREATE OR REPLACE FUNCTION public\.account_usage_grouped_cached/u,
    "the stable cached wrapper and exact-result cache key must remain warm",
  );
  assert.match(opsSource, /base AS MATERIALIZED/u);
  assert.equal(
    (opsSource.match(/FROM tokentracker_hourly h/gu) ?? []).length,
    1,
    "the standalone deployment source must match the promoted single scan",
  );
  assert.doesNotMatch(opsSource, /account_usage_grouped_legacy_v1\(/u);
  assert.doesNotMatch(opsSource, /account_usage_deepseek_v4_grouped\(/u);
});

test("leaderboard refresh fetches all user metadata with one RPC", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  assert.match(source, /rpc\("leaderboard_user_metadata"/u);
  assert.doesNotMatch(source, /const settingsResults = await Promise\.all/u);
  assert.doesNotMatch(source, /const profilesResults = await Promise\.all/u);
  assert.doesNotMatch(source, /const fallbackResults = await Promise\.all/u);
});

test("total leaderboard advances the cluster-aware rollup before reading it", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  const advance = source.indexOf('rpc(\n        "leaderboard_rollup_daily_advance_v2"');
  const aggregate = source.indexOf('"leaderboard_usage_grouped_total_shard"', advance);

  assert.ok(advance > 0, "total refresh must advance the v2 closed-day rollup");
  assert.ok(aggregate > advance, "total shards must read only after the rollup advance succeeds");
  assert.match(source.slice(advance, aggregate), /if \(advanceErr\)[\s\S]*stage: "rollup_advance"/u);
});

test("total leaderboard reads a trigger-maintained all-time aggregate plus the live tail", () => {
  const source = readMigrationBySuffix("cache-leaderboard-total-rollup");

  assert.match(
    source,
    /CREATE TABLE IF NOT EXISTS public\.tokentracker_leaderboard_rollup_total_v2/u,
    "the compact all-time aggregate must be durable",
  );
  assert.match(
    source,
    /LOCK TABLE public\.tokentracker_leaderboard_rollup_daily_v2\s+IN SHARE ROW EXCLUSIVE MODE/u,
    "backfill and trigger installation must not race closed-day writers",
  );
  assert.match(
    source,
    /FROM public\.tokentracker_leaderboard_rollup_daily_v2\s+GROUP BY user_id, source, model, pricing_tier/u,
    "the initial aggregate must preserve every pricing dimension",
  );
  for (const transition of [
    "REFERENCING NEW TABLE AS new_rows",
    "REFERENCING OLD TABLE AS old_rows",
    "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows",
  ]) {
    assert.match(source, new RegExp(transition), `${transition} must keep the aggregate current`);
  }

  const totalBranch = source.indexOf("p_from = TIMESTAMPTZ '1970-01-01 00:00:00+00'");
  const boundedBranch = source.indexOf("ELSE", totalBranch);
  assert.ok(totalBranch > 0, "only the exact all-time sentinel may use the total aggregate");
  assert.match(
    source.slice(totalBranch, boundedBranch),
    /FROM public\.tokentracker_leaderboard_rollup_total_v2/u,
    "the all-time branch must avoid regrouping the full daily history",
  );
  assert.match(
    source.slice(totalBranch, boundedBranch),
    /FROM public\.leaderboard_hourly_dedup_v2\(v_cut, p_to\)/u,
    "the all-time branch must retain the current live tail",
  );
  assert.match(
    source.slice(boundedBranch),
    /FROM public\.tokentracker_leaderboard_rollup_daily_v2/u,
    "bounded periods must retain their day-filtered rollup semantics",
  );
  assert.match(source, /ENABLE ROW LEVEL SECURITY/u);
  assert.match(
    source,
    /REVOKE ALL ON public\.tokentracker_leaderboard_rollup_total_v2\s+FROM PUBLIC, anon, authenticated/u,
  );
});

test("total leaderboard shards the model-granular response without changing pricing semantics", () => {
  const migration = readMigrationBySuffix("shard-leaderboard-total-read");
  const edgeSource = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.leaderboard_usage_grouped_total_shard/u);
  assert.match(migration, /FROM public\.tokentracker_leaderboard_rollup_total_v2/u);
  assert.match(migration, /FROM public\.leaderboard_hourly_dedup_v2\(v_cut, p_to\)/u);
  assert.match(migration, /r\.user_id >= p_user_from/u);
  assert.match(migration, /r\.user_id < p_user_to/u);
  assert.match(migration, /GROUP BY u\.user_id, u\.source, u\.model, u\.pricing_tier/u);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.leaderboard_usage_grouped_total_shard\([\s\S]*FROM PUBLIC, anon, authenticated/u,
  );

  assert.match(edgeSource, /const TOTAL_USER_SHARDS = \[/u);
  assert.equal(
    (edgeSource.match(/\{ from: "[0-9a-f-]+", to: (?:"[0-9a-f-]+"|null) \}/gu) ?? []).length,
    8,
    "total refresh must keep every model-granular response below the RPC timeout",
  );
  assert.match(edgeSource, /shardIndex \+= 2/u);
  assert.match(edgeSource, /TOTAL_USER_SHARDS\.slice\(shardIndex, shardIndex \+ 2\)\.map/u);
  assert.match(edgeSource, /"leaderboard_usage_grouped_total_shard"/u);
  assert.match(edgeSource, /totalRows\.push\(\.\.\.result\.data\)/u);
  assert.match(
    edgeSource,
    /for \(const row of grouped\)[\s\S]*agg\.estimated_cost_usd \+= computeRowCost\(row\)/u,
    "sharded rows must still use the canonical edge pricing function",
  );
});

test("signed-in users cannot trigger expensive month, total, or all-period leaderboard refreshes", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  const clientSource = read("dashboard/src/lib/cloud-sync.ts");
  assert.match(
    source,
    /type RefreshAuthorization = "privileged" \| "signed-in" \| "public";/u,
  );
  assert.match(
    source,
    /if \(authorization === "signed-in" && body\.period !== "week"\)\s*return json\(\{ error: "signed-in users may only refresh week" \}, 403\);/u,
  );
  assert.match(clientSource, /body: JSON\.stringify\(\{ period: "week", source \}\)/u);
});

test("the unauthenticated public reads cannot reach any refresh write path", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");

  // "public" is granted without any credential, so it must be reachable only by
  // a GET carrying one of the read-only query flags -- never by the POST that
  // rebuilds snapshots. Both flags are gated on the same `req.method === "GET"`.
  assert.match(
    source,
    /const wantsAnomalySummary =\s*req\.method === "GET" && requestParams\.get\("anomalies"\) === "1";/u,
    "the anomaly summary must be gated on GET + ?anomalies=1",
  );
  assert.match(
    source,
    /const wantsQuarantineAudit =\s*req\.method === "GET" && requestParams\.get\("quarantine_audit"\) === "1";/u,
    "the quarantine audit must be gated on GET + ?quarantine_audit=1",
  );
  assert.match(
    source,
    /const wantsPublicRead = wantsAnomalySummary \|\| wantsQuarantineAudit;/u,
    "the public role must be the union of exactly those two read-only flags",
  );
  assert.match(
    source,
    /const authorization = wantsPublicRead \? "public" : await authorizeRefresh\(req\);/u,
    "any non-read request must still go through authorizeRefresh",
  );

  // The public reads must return before the period-refresh work begins.
  const publicReturn = source.indexOf('if (authorization === "public") {');
  const periodLoop = source.indexOf("for (const period of periods)");
  assert.ok(publicReturn > 0, "public role must short-circuit to a read-only handler");
  assert.ok(
    periodLoop > publicReturn,
    "the public short-circuit must precede the refresh loop",
  );

  // Neither payload may leak identities into the public GitHub issue the
  // watchdog files from them. Assert on the declared RESPONSE shapes rather
  // than the whole function body: the audit legitimately *passes* the block
  // list down to the RPC as an argument, so a body-wide substring match would
  // either miss that distinction or forbid a safe input.
  for (const fn of ["anomalyQueueSummaryData", "quarantineAuditData"]) {
    const fnStart = source.indexOf(`async function ${fn}(`);
    assert.ok(fnStart > 0, `${fn} must exist`);
    const returnTypeStart = source.indexOf("): Promise<{", fnStart);
    const returnTypeEnd = source.indexOf("}>", returnTypeStart);
    assert.ok(
      returnTypeStart > 0 && returnTypeEnd > returnTypeStart,
      `${fn} must declare an inline response shape`,
    );
    const returnShape = source.slice(returnTypeStart, returnTypeEnd);
    assert.doesNotMatch(
      returnShape,
      /user_id|machine|display_name|avatar|github/iu,
      `${fn} must return counts only, never identities`,
    );
  }
});

test("leaderboard refresh reconciles stale rows after the replacement snapshot is durable", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  const upsertStart = source.indexOf("// Upsert in batches of 200");
  const staleDelete = source.indexOf('.lt("generated_at", generatedAt)');
  const completion = source.indexOf("results[period] = { upserted: upsertRows.length }");

  assert.ok(upsertStart > 0, "snapshot upsert must exist");
  assert.ok(
    staleDelete > upsertStart,
    "stale snapshot cleanup must run only after every replacement row is upserted",
  );
  assert.ok(
    completion > staleDelete,
    "the period must not report success before stale snapshot cleanup finishes",
  );
  assert.match(
    source.slice(upsertStart, completion),
    /\.from\("tokentracker_leaderboard_snapshots"\)\s*\.delete\(\)\s*\.eq\("period", period\)\s*\.eq\("from_day", from_day\)\s*\.eq\("to_day", to_day\)\s*\.lt\("generated_at", generatedAt\)/u,
    "refresh must delete rows left behind by excluded or otherwise removed users in the same snapshot window",
  );
});

test("leaderboard anti-cheat workflow verifies database-native scans, reconciles exclusions, and never leaks identities", () => {
  const workflow = read(".github/workflows/leaderboard-anticheat.yml");
  assert.match(
    workflow,
    /cron: "53 \* \* \* \*"/u,
    "a daily poll can miss a flag created after that day's run for nearly 24 hours",
  );
  assert.doesNotMatch(
    workflow,
    /issues:\s*write|gh issue (?:create|edit|close|list)/u,
    "automatic soft exclusion must not depend on or create a public GitHub issue",
  );
  assert.match(workflow, /secrets\.LEADERBOARD_REFRESH_SECRET/u);
  assert.doesNotMatch(
    workflow,
    /"scan_anomalies":true/u,
    "the HTTP workflow must not synchronously rerun a detector that can exceed the backend proxy timeout",
  );
  assert.match(workflow, /last_scan_completed_at/u);
  assert.match(workflow, /scan_age_seconds/u);
  assert.doesNotMatch(workflow, /force_refresh\\":true/u,
    "anti-cheat response must not rebuild every leaderboard snapshot");
  assert.match(workflow, /anti_cheat_reconcile_at/u,
    "the responder must use the atomic exclusion reconciliation path");
  assert.doesNotMatch(workflow, /for period in week month total/u,
    "the responder must not fan one queue change out into three heavy refreshes");
  const postBranch = workflow.slice(workflow.indexOf('if [[ "$method" == "GET" ]]'));
  assert.doesNotMatch(postBranch.slice(postBranch.indexOf("else")), /--retry-all-errors/u,
    "write requests must not overlap after a lost gateway response");
  assert.match(workflow, /\?anomalies=1/u, "the workflow must independently read back queue state");
  assert.doesNotMatch(workflow, /user_id/u, "workflow logs must never expose flagged identities");
  assert.match(
    workflow,
    /GITHUB_STEP_SUMMARY/u,
    "the health check should retain private run-level observability",
  );
});

test("anti-cheat health reports database-native scan freshness before protected snapshot refresh", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  const migration = read("migrations/20260812115221_observe-database-anticheat-scans.sql");
  const authorizationGuard = source.indexOf('authorization !== "privileged"');
  const periodLoop = source.indexOf("for (const period of periods)");

  assert.match(source, /tokentracker_anticheat_run_state/u);
  assert.match(source, /last_scan_completed_at/u);
  assert.match(migration, /AFTER INSERT ON public\.tokentracker_leaderboard_anomaly_flags/u);
  assert.match(migration, /FOR EACH STATEMENT/u,
    "even a clean zero-row detector INSERT must advance the scan heartbeat");
  assert.ok(authorizationGuard > 0 && authorizationGuard < periodLoop,
    "forced refresh flags must be privileged before snapshots are rebuilt");
  assert.match(source, /p_min_interval_s: forceRefresh \? 0 : 30/u,
    "an authenticated response run must not lose to an unrelated refresh throttle");
  assert.match(source, /timeout: 25_000/u,
    "the bounded detector must have enough client timeout headroom to finish under load");
  assert.match(source, /return json\(\{ ok: true, results, \.\.\.\(anomalyScan \? \{ scan: anomalyScan \} : \{\}\) \}\)/u);
});

test("database-native anti-cheat detector has a bounded hourly scan budget", () => {
  const migration = readMigrationBySuffix("bound-anticheat-detector-window");
  const runtime = read("docs/ops/leaderboard-anomaly-detector-runtime.sql");

  assert.match(migration, /SET value = 1\s+WHERE key = 'lookback_days'/u,
    "an hourly detector must not rescan two weeks of raw event and ingestion history");
  assert.match(migration, /missing anti-cheat lookback_days configuration/u,
    "deployment must fail instead of silently leaving the unbounded configuration in place");
  assert.match(runtime, /ALTER FUNCTION public\.detect_leaderboard_anomalies\(\)\s+SET work_mem TO '16MB'/u,
    "one detector query must not retain the old 64MB per-operation memory budget");
  assert.match(runtime, /SET statement_timeout TO '45s'/u,
    "a runaway detector must fail closed before it destabilizes the database server");
});

test("anti-cheat responder atomically reconciles snapshots only when the moderation queue changed", () => {
  const workflow = read(".github/workflows/leaderboard-anticheat.yml");
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  const migration = readMigrationBySuffix("reconcile-anticheat-snapshot-exclusions");

  assert.match(workflow, /last_queue_changed_at/u);
  assert.match(workflow, /last_response_completed_at/u);
  assert.match(workflow, /needs_response/u,
    "unchanged queues must not repeat snapshot reconciliation every hour");
  assert.match(workflow, /anti_cheat_reconcile_at/u);
  assert.match(workflow, /reconcile request failed; checking durable database state/u,
    "a lost HTTP response must fall through to durable state read-back");
  assert.match(source, /reconcile_anticheat_snapshot_exclusions/u);
  assert.match(source, /reconciled_snapshot_rows/u);
  assert.match(migration, /FOR UPDATE/u,
    "queue reconciliation must serialize against detector queue changes");
  assert.match(migration, /f\.status IN \('auto_excluded', 'banned'\)/u);
  assert.match(migration, /SET last_response_completed_at = p_queue_changed_at/u,
    "snapshot deletion and queue acknowledgement must commit atomically");
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.reconcile_anticheat_snapshot_exclusions/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.reconcile_anticheat_snapshot_exclusions/u);
});

test("leaderboard bans block token issuance and usage ingestion", () => {
  const tokenIssue = read("dashboard/edge-patches/tokentracker-device-token-issue.ts");
  const devicePoll = read("dashboard/edge-patches/tokentracker-device-flow-poll.ts");
  const ingest = read("dashboard/edge-patches/tokentracker-ingest.ts");

  for (const [file, source] of [
    ["tokentracker-device-token-issue.ts", tokenIssue],
    ["tokentracker-device-flow-poll.ts", devicePoll],
    ["tokentracker-ingest.ts", ingest],
  ]) {
    assert.match(source, /Deno\.env\.get\("LEADERBOARD_BLOCKED_USER_IDS"\)/u,
      `${file} must read the production account blocklist`);
    assert.match(source, /return json\(\{ error: "Account blocked" \}, 403\)/u,
      `${file} must reject blocked accounts`);
  }

  assert.ok(
    tokenIssue.indexOf("if (isLeaderboardBlockedUser(userId))")
      < tokenIssue.indexOf("// Device identity resolution"),
    "normal token issuance must reject the account before mutating a device",
  );
  assert.ok(
    devicePoll.indexOf("if (isLeaderboardBlockedUser(row.user_id))")
      < devicePoll.indexOf("issueDeviceToken(client, row.user_id"),
    "device-flow polling must reject the account before issuing a token",
  );
  assert.ok(
    ingest.indexOf("if (isLeaderboardBlockedUser(userId))")
      < ingest.indexOf('.from("tokentracker_hourly")'),
    "ingest must reject the account before writing usage",
  );

  // A heuristic anomaly flag must NOT gate the write path. The detector is
  // automatic, and tokentracker-leaderboard-refresh already drops flagged
  // accounts from the public snapshot -- so blocking ingest as well bought no
  // extra protection and made a false positive unrecoverable: the account
  // could not upload the corrected numbers that would clear the flag, and
  // stayed cut off until someone read an issue (#639). Only an explicit,
  // human-curated ban stops uploads.
  for (const [file, source] of [
    ["tokentracker-device-token-issue.ts", tokenIssue],
    ["tokentracker-device-flow-poll.ts", devicePoll],
    ["tokentracker-ingest.ts", ingest],
  ]) {
    assert.doesNotMatch(source, /\.eq\("status", "auto_excluded"\)/u,
      `${file} must not turn an automatic anomaly flag into an upload ban`);
  }
  const refresh = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  assert.match(refresh, /\.eq\("status", "auto_excluded"\)/u,
    "the refresh job is what keeps flagged accounts out of the public snapshot",
  );
});

test("leaderboard reads expose snapshot freshness and disable response caching", () => {
  const edgeSource = read("dashboard/edge-patches/tokentracker-leaderboard.ts");
  const clientSource = read("dashboard/src/lib/api.ts");
  assert.match(edgeSource, /const snapshotGeneratedAt =/u);
  assert.match(edgeSource, /generated_at: snapshotGeneratedAt/u);
  assert.doesNotMatch(edgeSource, /generated_at: new Date\(\)\.toISOString\(\)/u);
  assert.match(edgeSource, /"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"/u);
  assert.match(
    clientSource,
    /fetchInsforgeFunction\("tokentracker-leaderboard", \{\s*cache: "no-store"/u,
  );
});

test("telemetry heartbeat uses one atomic database upsert RPC", () => {
  const source = read("dashboard/edge-patches/tokentracker-telemetry.ts");
  assert.match(source, /rpc\("upsert_tokentracker_telemetry_daily"/u);
  assert.doesNotMatch(source, /const \{ data: existingRows/u);
  assert.doesNotMatch(source, /\.from\(TABLE\)\.insert/u);
});

test("device creation absorbs concurrent unique-key races without database errors", () => {
  for (const file of ["tokentracker-device-token-issue.ts", "tokentracker-device-flow-poll.ts"]) {
    const source = read(`dashboard/edge-patches/${file}`);
    assert.match(
      source,
      /\.upsert\([\s\S]{0,180}machine_id: machineId[\s\S]{0,80}\{ ignoreDuplicates: true \}/u,
      `${file} must use INSERT ON CONFLICT DO NOTHING before selecting the winner`,
    );
    assert.doesNotMatch(source, /\.insert\([\s\S]{0,180}ignoreDuplicates/u);
  }
});

test("desktop auto refresh does not poll cloud account aggregates every 30 seconds", () => {
  const source = read("dashboard/src/pages/DashboardPage.jsx");
  assert.match(source, /if \(!isLocalMode \|\| mockEnabled \|\| accountView\) return undefined;/u);
});

test("backend hardening migration adds hot-path RPCs, index, and execute ACLs", () => {
  const source = read("migrations/20260717013000_harden-backend-hot-paths.sql");
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.account_usage_grouped_v2/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.leaderboard_user_metadata/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.upsert_tokentracker_telemetry_daily/u);
  assert.match(source, /CREATE INDEX IF NOT EXISTS tokentracker_user_badges_badge_id_idx/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.account_usage_grouped_v2/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.leaderboard_user_metadata/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.upsert_tokentracker_telemetry_daily/u);
});

test("unused direct profile-like table grants stay revoked", () => {
  const source = read("migrations/20260717015500_revoke-unused-profile-like-grants.sql");
  assert.match(
    source,
    /REVOKE ALL ON public\.tokentracker_profile_likes FROM anon, authenticated;/u,
  );
});

// Do not reintroduce Content-Encoding in an edge function.
//
// The obvious read of these endpoints is that the big ones should gzip: a
// 52-week heatmap serializes ~65 KB and a leaderboard page ~77 KB of highly
// repetitive JSON, and every caller advertises gzip by default. That branch was
// written twice and shipped once, and it never reached a client.
//
// The InsForge gateway decompresses an encoded edge response and forwards it as
// identity. Measured end to end on 2026-09-20 against the public leaderboard
// endpoint, cache-busted, with and without `Accept-Encoding: gzip`: 77529 bytes
// on the wire both times, `Vary: Accept-Encoding` passed through but
// `Content-Encoding` stripped, `Content-Length` and the ETag both computed over
// the plain body, and the body itself starting `{"en` rather than the gzip
// magic 1f 8b.
//
// So the compression cost is paid twice and saves nothing. Shrink these
// responses by sending fewer bytes (the *_compact RPCs above) or fewer requests
// (the CLI and tray caches). If the gateway ever starts passing an encoding
// through, delete this test along with the change that proves it.
test("edge functions do not compress their own responses", () => {
  const edgeDir = path.join(ROOT, "dashboard/edge-patches");
  for (const file of fs.readdirSync(edgeDir).filter((name) => name.endsWith(".ts"))) {
    const source = read(`dashboard/edge-patches/${file}`);
    assert.doesNotMatch(
      source,
      /new CompressionStream\(/u,
      `${file} must not compress: the gateway decompresses it again (see comment above)`,
    );
    assert.doesNotMatch(
      source,
      /"Content-Encoding"\]?\s*[:=]/u,
      `${file} must not set Content-Encoding: the gateway strips it (see comment above)`,
    );
  }
});
