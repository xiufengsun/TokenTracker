/**
 * Account-level cross-device truth regression tests (PR #474 review).
 *
 * TRAE CN's usage API returns CORRECTABLE snapshots, not append-only events:
 * a session's totals can be revised downward, moved to another model, or
 * shifted to another half-hour. Hour-level dedup cannot express those
 * corrections (a fresh device's first data bucket cannot safely displace
 * earlier hours, and a 10:00 -> 10:30 migration strands the old hour), so
 * canonical truth for trae-cn lives at the SESSION level. These tests pin
 * the semantics implemented by src/lib/account-usage-dedup.js (executable
 * spec) and mirrored by:
 *   - migrations/20260817120000_account-session-states.sql
 *     (tokentracker_account_session_states + LWW upsert +
 *     leaderboard_hourly_dedup_v2)
 *   - scripts/ops/account-usage-grouped-rpc.sql (account_usage_grouped)
 *   - dashboard/edge-patches/tokentracker-ingest.ts (batch upload)
 *
 * The merge-blocker scenarios run the REAL pipeline: parser -> queue ->
 * ingest batch -> LWW persistence -> aggregation.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  SESSION_STATE_KIND,
  upsertAccountSessionStates,
  aggregateSessionStates,
  dedupeAccountLevelRows,
  sumTotalTokens,
} = require("../src/lib/account-usage-dedup");
const { parseTraeCnApiIncremental } = require("../src/lib/rollout");

const ROOT = path.join(__dirname, "..");

// Device ids / hours used across the scenarios.
const OLD = "11111111-1111-1111-1111-111111111111";
const FRESH = "22222222-2222-2222-2222-222222222222";
const H10 = "2027-01-10T10:00:00.000Z";
const H1030 = "2027-01-10T10:30:00.000Z";

// ---------------------------------------------------------------------------
// Real-pipeline harness: parser -> queue -> ingest batch -> LWW table.
//
// Each "device" run drives the REAL parseTraeCnApiIncremental against its
// own append-only queue, then drains the queue exactly like the production
// upload path (src/commands/sync.js readQueueBatch collects session-state
// records last-wins per (source, session_id); the ingest edge dedupes the
// same way before the SQL batch upsert), then applies them to the shared
// cloud table through the JS mirror of tokentracker_upsert_account_
// session_states. Aggregation mirrors the RPC's trae-cn branch.
// ---------------------------------------------------------------------------
function tempQueue(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, queuePath: path.join(dir, "queue.jsonl") };
}

const WINDOW_START_MS = 1_799_000_000_000; // well before both devices' data
const WINDOW_END_MS = 1_801_000_000_000;

async function deviceSync(cloudStates, device, { sessions, verifiedAtMs, cursors = {} }) {
  const { dir, queuePath } = tempQueue("tokentracker-session-pipeline-");
  try {
    await parseTraeCnApiIncremental({
      sessions,
      cursors,
      queuePath,
      windowStartMs: WINDOW_START_MS,
      windowEndMs: WINDOW_END_MS,
      snapshotVerifiedAtMs: verifiedAtMs,
    });
    // Drain the queue like the production upload path (last-wins per
    // session, mirroring sync.js readQueueBatch + the edge's stateMap).
    // An empty payload writes NO queue file at all (the parser asserts
    // nothing), so the ingest batch is simply empty.
    const lines = fs.existsSync(queuePath)
      ? fs
          .readFileSync(queuePath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    const stateMap = new Map();
    for (const row of lines) {
      if (row.kind === SESSION_STATE_KIND) {
        stateMap.set(row.source + "|" + row.session_id, row);
      }
    }
    upsertAccountSessionStates(cloudStates, [...stateMap.values()]);
    return lines;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function traeSession(sessionId, usageTimeSec, overrides = {}) {
  return {
    session_id: sessionId,
    model_name: "model-a",
    usage_time: usageTimeSec,
    input_token: 100,
    output_token: 10,
    cache_read_token: 0,
    cache_write_token: 0,
    ...overrides,
  };
}

const T10 = Date.parse("2027-01-10T10:00:00.000Z") / 1000; // -> the 10:00 bucket
const T1030 = Date.parse("2027-01-10T10:30:00.000Z") / 1000; // -> the 10:30 bucket
const VERIFIED_OLD = Date.parse("2027-01-15T00:00:00.000Z");
const VERIFIED_FRESH = Date.parse("2027-01-16T00:00:00.000Z");

function totalsByHour(rows) {
  return new Map(rows.map((r) => [r.hour_start, r.total_tokens]));
}

// ---------------------------------------------------------------------------
// 1. Fresh-device bucket migration (THE P0): old device uploaded S@10:00,
//    the API later corrected S to 10:30, and the fresh device's snapshot only
//    contains S@10:30 (its FIRST data bucket) - no hour-coverage inference
//    can reclaim 10:00, but the session identity can.
// ---------------------------------------------------------------------------
test("R1. fresh-device bucket migration: S@10:00=100 then S@10:30=100 -> only 10:30, total 100", async () => {
  const cloudStates = new Map();
  // Device OLD synced first: session s1 lived at 10:00.
  await deviceSync(cloudStates, OLD, {
    sessions: [traeSession("s1", T10)],
    verifiedAtMs: VERIFIED_OLD,
  });
  // Fresh device, no cursor history: the API now reports s1 at 10:30.
  await deviceSync(cloudStates, FRESH, {
    sessions: [traeSession("s1", T1030)],
    verifiedAtMs: VERIFIED_FRESH,
    cursors: {}, // fresh device: no local TRAE history
  });
  const rows = aggregateSessionStates(cloudStates);
  const byHour = totalsByHour(rows);
  assert.equal(byHour.get(H10), undefined, "the 10:00 tuple is GONE (whole-row replace)");
  assert.equal(byHour.get(H1030), 100 + 10, "only the corrected 10:30 bucket remains");
  assert.equal(sumTotalTokens(rows), 110, "total is 110 tokens (session counted once), never 220");
});

// ---------------------------------------------------------------------------
// 2. Fresh-device model migration.
// ---------------------------------------------------------------------------
test("R2. fresh-device model migration: S/A=100 then S/B=100 -> only B, total 100", async () => {
  const cloudStates = new Map();
  await deviceSync(cloudStates, OLD, {
    sessions: [traeSession("s1", T10)],
    verifiedAtMs: VERIFIED_OLD,
  });
  await deviceSync(cloudStates, FRESH, {
    sessions: [traeSession("s1", T10, { model_name: "model-b" })],
    verifiedAtMs: VERIFIED_FRESH,
    cursors: {},
  });
  const rows = aggregateSessionStates(cloudStates);
  const byModel = new Map(rows.map((r) => [r.model, r.total_tokens]));
  assert.equal(byModel.get("model-a"), undefined, "stale model-a state is replaced, not kept");
  assert.equal(byModel.get("model-b"), 110, "only model-b remains");
  assert.equal(sumTotalTokens(rows), 110, "total 110, never the stitched 220");
});

// ---------------------------------------------------------------------------
// 3. Fresh-device downward correction.
// ---------------------------------------------------------------------------
test("R3. fresh-device downward correction: S=100 then S=60 -> 60, never MAX", async () => {
  const cloudStates = new Map();
  await deviceSync(cloudStates, OLD, {
    sessions: [traeSession("s1", T10)],
    verifiedAtMs: VERIFIED_OLD,
  });
  await deviceSync(cloudStates, FRESH, {
    sessions: [traeSession("s1", T10, { input_token: 50 })],
    verifiedAtMs: VERIFIED_FRESH,
    cursors: {},
  });
  const rows = aggregateSessionStates(cloudStates);
  assert.equal(sumTotalTokens(rows), 60, "the corrected 60 wins, never the MAX 110");
  assert.equal(rows.length, 1, "one canonical session row");
});

// ---------------------------------------------------------------------------
// 4. Missing session: absence is NOT deletion (contract NOT PROVEN).
// ---------------------------------------------------------------------------
test("R4. a session missing from the next non-empty snapshot is RETAINED", async () => {
  const cloudStates = new Map();
  await deviceSync(cloudStates, OLD, {
    sessions: [traeSession("s1", T10)],
    verifiedAtMs: VERIFIED_OLD,
  });
  // A later NON-EMPTY snapshot that simply lacks s1 (it only reports s2).
  await deviceSync(cloudStates, FRESH, {
    sessions: [traeSession("s2", T1030, { input_token: 20, output_token: 2 })],
    verifiedAtMs: VERIFIED_FRESH,
    cursors: {},
  });
  const rows = aggregateSessionStates(cloudStates);
  assert.equal(cloudStates.get("trae-cn|s1").total_tokens, 110, "s1 is untouched by absence");
  assert.equal(sumTotalTokens(rows), 110 + 22, "both sessions count once");
});

// ---------------------------------------------------------------------------
// 5. Empty response: asserts NOTHING (contract NOT PROVEN).
// ---------------------------------------------------------------------------
test("R5. an empty snapshot asserts nothing: existing sessions survive", async () => {
  const cloudStates = new Map();
  await deviceSync(cloudStates, OLD, {
    sessions: [traeSession("s1", T10)],
    verifiedAtMs: VERIFIED_OLD,
  });
  // The parser short-circuits an empty payload before ANY mutation, so the
  // ingest batch is empty and the LWW table is untouched.
  await deviceSync(cloudStates, FRESH, {
    sessions: [],
    verifiedAtMs: VERIFIED_FRESH,
    cursors: {},
  });
  const rows = aggregateSessionStates(cloudStates);
  assert.equal(sumTotalTokens(rows), 110, "empty response never deletes anything");
});

// ---------------------------------------------------------------------------
// 6. Transport retry idempotence: the same observation replayed N times
//    yields ONE canonical state with unchanged numbers.
// ---------------------------------------------------------------------------
test("R6. replaying the same observation is idempotent", async () => {
  const cloudStates = new Map();
  const lines = await deviceSync(cloudStates, OLD, {
    sessions: [traeSession("s1", T10)],
    verifiedAtMs: VERIFIED_OLD,
  });
  const observations = lines.filter((r) => r.kind === SESSION_STATE_KIND);
  assert.equal(observations.length, 1);

  // Transport retries re-deliver the EXACT same batch (same bytes, same
  // snapshot_verified_at - the append-only queue replays it verbatim).
  const second = upsertAccountSessionStates(cloudStates, observations);
  const third = upsertAccountSessionStates(cloudStates, observations);
  assert.equal(second, 0, "first replay applies nothing");
  assert.equal(third, 0, "further replays apply nothing");
  assert.equal(aggregateSessionStates(cloudStates).length, 1, "still one canonical session");
  assert.equal(sumTotalTokens(aggregateSessionStates(cloudStates)), 110, "numbers unchanged");

  // A genuinely NEWER fetch of the same session still lands (LWW >).
  const applied = upsertAccountSessionStates(cloudStates, [
    {
      ...observations[0],
      input_token: 60,
      total_tokens: 70,
      snapshot_verified_at: new Date(VERIFIED_FRESH).toISOString(),
    },
  ]);
  assert.equal(applied, 1);
  assert.equal(sumTotalTokens(aggregateSessionStates(cloudStates)), 70, "a newer stamp replaces");
});

// ---------------------------------------------------------------------------
// LWW unit semantics (mirroring the SQL upsert guard exactly).
// ---------------------------------------------------------------------------
test("LWW: strictly newer stamps replace, equal stamps keep the first-applied row", () => {
  const states = new Map();
  const base = {
    source: "trae-cn",
    session_id: "s1",
    model: "model-a",
    bucket_start: H10,
    input_tokens: 100,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 100,
    snapshot_verified_at: "2027-01-15T00:00:00.000Z",
  };
  assert.equal(upsertAccountSessionStates(states, [base]), 1);
  // EQUAL stamp: first-applied wins (stable under retries).
  assert.equal(
    upsertAccountSessionStates(states, [{ ...base, model: "model-b" }]),
    0,
    "equal stamp never replaces",
  );
  assert.equal(states.get("trae-cn|s1").model, "model-a");
  // OLDER stamp: never displaces.
  assert.equal(
    upsertAccountSessionStates(states, [
      { ...base, model: "model-c", snapshot_verified_at: "2027-01-14T00:00:00.000Z" },
    ]),
    0,
    "older observation is a no-op",
  );
  assert.equal(states.get("trae-cn|s1").model, "model-a");
  // STRICTLY newer stamp: whole-row replace.
  assert.equal(
    upsertAccountSessionStates(states, [
      {
        ...base,
        model: "model-b",
        bucket_start: H1030,
        input_tokens: 60,
        total_tokens: 60,
        snapshot_verified_at: "2027-01-16T00:00:00.000Z",
      },
    ]),
    1,
  );
  const replaced = states.get("trae-cn|s1");
  assert.equal(replaced.model, "model-b");
  assert.equal(replaced.bucket_start, H1030);
  assert.equal(replaced.total_tokens, 60, "downward replacement applied, not MAXed");
});

test("LWW: malformed observations (bad dates / missing identity) assert nothing", () => {
  const states = new Map();
  assert.equal(upsertAccountSessionStates(states, [null, {}, { source: "trae-cn" }]), 0);
  assert.equal(states.size, 0);
  assert.equal(
    upsertAccountSessionStates(states, [
      {
        source: "trae-cn",
        session_id: "s1",
        model: "model-a",
        bucket_start: "not-a-date",
        total_tokens: 10,
        snapshot_verified_at: "2027-01-15T00:00:00.000Z",
      },
    ]),
    0,
  );
  assert.equal(states.size, 0, "an unparseable bucket_start never lands");
});

test("aggregation groups by (bucket, model) and counts sessions, with an optional [from, to) window", () => {
  const states = new Map();
  upsertAccountSessionStates(states, [
    {
      source: "trae-cn",
      session_id: "s1",
      model: "model-a",
      bucket_start: H10,
      input_tokens: 100,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 100,
      snapshot_verified_at: "2027-01-15T00:00:00.000Z",
    },
    {
      source: "trae-cn",
      session_id: "s2",
      model: "model-a",
      bucket_start: H10,
      input_tokens: 5,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 5,
      snapshot_verified_at: "2027-01-15T00:00:00.000Z",
    },
    {
      source: "trae-cn",
      session_id: "s3",
      model: "model-b",
      bucket_start: H1030,
      input_tokens: 7,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 7,
      snapshot_verified_at: "2027-01-15T00:00:00.000Z",
    },
  ]);
  const rows = aggregateSessionStates(states);
  assert.deepEqual(
    rows.map((r) => [r.hour_start, r.model, r.total_tokens, r.conversations]),
    [
      [H10, "model-a", 105, 2],
      [H1030, "model-b", 7, 1],
    ],
  );
  const windowed = aggregateSessionStates(states, { from: H1030 });
  assert.equal(windowed.length, 1, "window filter excludes earlier buckets");
  assert.equal(windowed[0].model, "model-b");
});

// ---------------------------------------------------------------------------
// Legacy dedup: account-level sources WITHOUT a session identity ('cursor').
// ---------------------------------------------------------------------------
test("cursor-style rows (no session identity) keep the legacy whole-row MAX dedup", () => {
  const rows = [
    { device_id: OLD, hour_start: H10, source: "cursor", model: "model-a", total_tokens: 100, updated_at: "2027-01-15T00:00:00.000Z" },
    { device_id: FRESH, hour_start: H10, source: "cursor", model: "model-a", total_tokens: 120, updated_at: "2027-01-15T00:00:00.000Z" },
    { device_id: OLD, hour_start: H10, source: "cursor", model: "model-b", total_tokens: 30, updated_at: "2027-01-15T00:00:00.000Z" },
    { device_id: FRESH, hour_start: H10, source: "cursor", model: "model-b", total_tokens: 30, updated_at: "2027-01-15T00:00:00.000Z" },
  ];
  const deduped = dedupeAccountLevelRows(rows);
  assert.equal(sumTotalTokens(deduped), 150, "per-model MAX pick, identical rows count once");
  assert.equal(deduped.length, 2);
});

test("sumTotalTokens tolerates junk input", () => {
  assert.equal(sumTotalTokens(null), 0);
  assert.equal(sumTotalTokens([null, { total_tokens: "x" }, { total_tokens: 5 }]), 5);
});

// ---------------------------------------------------------------------------
// SQL / deployment parity: the deployed pipeline must implement the SAME
// session-state semantics as the JS spec above.
// ---------------------------------------------------------------------------
function readRepoFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("migration: session-state table identity is (user_id, source, session_id) and the upsert guard is strictly newer", () => {
  const sql = readRepoFile("migrations/20260817120000_account-session-states.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.tokentracker_account_session_states/);
  assert.match(
    sql,
    /PRIMARY KEY \(user_id, source, session_id\)/,
    "device_id is NOT part of the canonical identity",
  );
  assert.match(sql, /CHECK \(\s*total_tokens =\s*input_tokens \+ cached_input_tokens \+ cache_creation_input_tokens \+ output_tokens\s*\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  // The LWW guard.
  assert.match(
    sql,
    /WHERE EXCLUDED\.snapshot_verified_at > t\.snapshot_verified_at/,
    "only STRICTLY newer observations replace (retries are no-ops)",
  );
  // Nothing may ever delete a session row.
  assert.doesNotMatch(sql, /\bDELETE\b/i, "absence is not proven - no deletion path");
  // Leaderboard aggregates trae-cn from the session states.
  assert.match(sql, /leaderboard_hourly_dedup_v2/);
  const traeBranch = sql.split("trae-cn: canonical account truth aggregated from session states")[1];
  assert.ok(traeBranch, "leaderboard has a trae-cn session-state branch");
  assert.match(traeBranch.split("$func$")[0], /FROM tokentracker_account_session_states/);
});

test("account_usage_grouped RPC aggregates trae-cn from session states (no watermark path)", () => {
  const sql = readRepoFile("scripts/ops/account-usage-grouped-rpc.sql");
  assert.match(sql, /tokentracker_account_session_states/, "RPC reads the session-state table");
  assert.match(
    sql,
    /GROUP BY s\.bucket_start, s\.source, s\.model/,
    "aggregation groups by (bucket, source, model) - same as the JS spec",
  );
  assert.doesNotMatch(
    sql,
    /account_sync_watermark|first_covered_hour/,
    "watermarks must be fully out of the correctness path",
  );
  // 'cursor' keeps the legacy whole-row MAX pick (DISTINCT ON + ORDER BY
  // total_tokens DESC), NOT the session-state path.
  const cursorBranch = sql.split("'cursor' (account-level, no session identity)")[1] || "";
  assert.match(cursorBranch.split("UNION ALL")[0], /source = 'cursor'/);
  assert.match(cursorBranch.split("UNION ALL")[0], /total_tokens DESC/);
});

test("ingest edge validates account_session_states and upserts them via the LWW RPC after the hourly rows", () => {
  const ts = readRepoFile("dashboard/edge-patches/tokentracker-ingest.ts");
  assert.match(ts, /body\.account_session_states/, "edge reads the account_session_states payload");
  assert.match(ts, /Invalid account session state/, "malformed states fail closed");
  assert.match(ts, /r\.source \+ "\|" \+ r\.session_id/, "batch dedup is last-wins per session");
  assert.match(ts, /cloud_ingest_usage/, "edge delegates admission and both writes to one transaction");
  const sql = readRepoFile("migrations/20261004120000_cloud-machine-access.sql");
  assert.match(sql, /tokentracker_upsert_account_session_states/, "transaction calls the LWW upsert RPC");
  // Session states land AFTER the hourly upsert in file order.
  assert.ok(
    sql.indexOf("INSERT INTO public.tokentracker_hourly AS h") < sql.indexOf("tokentracker_upsert_account_session_states"),
    "bucket rows land before the canonical states describing them",
  );
});

test("local queue readers never surface session-state control records as usage rows", () => {
  const localApi = readRepoFile("src/lib/local-api.js");
  assert.match(
    localApi,
    /kind === "account_session_state"/,
    "readQueueData must skip account_session_state records",
  );
  const sync = readRepoFile("src/commands/sync.js");
  assert.match(
    sync,
    /kind === "account_session_state"/,
    "the upload path collects account_session_state records separately from bucket rows",
  );
  assert.match(sync, /account_session_states/, "the upload body carries account_session_states");
});
