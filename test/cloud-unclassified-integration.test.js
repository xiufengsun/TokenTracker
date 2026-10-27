"use strict";
const test = require("node:test");
const { before, after } = test;
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup, migration, functionSql } = require("./helpers/cloud-usage-archive-fixture");
let db, canonicalPricing, legacyUser, legacyDevice, functionContracts;
const contracts = pg => pg.query(`SELECT oid, proname, proowner, proacl::text, prosecdef, provolatile, proconfig
  FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
  ('account_usage_grouped', 'tokentracker_upsert_account_session_states', 'cloud_ingest_usage',
   'leaderboard_rollup_total_v2_after_insert', 'leaderboard_rollup_total_v2_after_update',
   'leaderboard_rollup_total_v2_after_delete') ORDER BY proname`).then(result => result.rows);
const rpc = async (name, args = []) => (await db.query(
  `SELECT ${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) AS result`, args)).rows[0].result;
const row = (unknown = 100, output = 20) => ({ hour_start: "2026-01-02T02:00:00Z", source: "vscode-copilot", model: "gpt-5.4",
  input_tokens: 0, output_tokens: output, unclassified_input_tokens: unknown, cached_input_tokens: 0,
  cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: unknown + output,
  billable_total_tokens: unknown + output, conversations: 1, total_cost_usd: null });
async function user() { const id = randomUUID(); await db.query("INSERT INTO auth.users VALUES($1)", [id]); return id; }
async function issue(id) {
  const token = randomUUID(), machine = randomUUID();
  const result = await rpc("cloud_issue_device_token", [id, "live", machine, "web", machine, [machine], randomUUID(), token, false, null]);
  assert.equal(result.ok, true);
  return { ...result, token };
}
const ingest = (device, rows, states = []) => rpc("cloud_ingest_usage", [device.token, "live", JSON.stringify(rows), JSON.stringify(states), null]);
const grouped = (id, devices) => rpc("account_usage_grouped", [id, devices, "2026-01-01Z", "2026-01-04Z", "day", "UTC", 0]);
const wire = (name, id, dev = null) => rpc(`account_${name}_wire`, [id, dev, "2026-01-01Z", "2026-01-04Z", "UTC", 0, "2026-01-01", "2026-01-03"]);
async function archive(id, dev) {
  const generation = await rpc("cloud_prepare_usage_archive", [id, dev, "2026-01-02"]);
  assert.ok(generation);
  await rpc("cloud_commit_usage_archive", [generation]);
}
async function setupCurrentMain() {
  const db = await setup();
  await db.exec("ALTER TABLE tokentracker_leaderboard_snapshots ADD COLUMN estimated_cost_usd numeric NOT NULL DEFAULT 0");
  await db.exec(migration("20261003120000_cloud-subscriptions.sql"));
  await db.exec(migration("20261004120000_cloud-machine-access.sql"));
  await db.exec(migration("20261005120000_cloud-usage-archive.sql"));
  await db.exec(functionSql(migration("20260904064000_cache-leaderboard-total-rollup.sql"), "leaderboard_usage_grouped"));
  await db.exec(migration("20260904064500_shard-leaderboard-total-read.sql"));
  await db.exec("INSERT INTO tokentracker_leaderboard_rollup_meta_v2 VALUES(1,'2026-01-03Z','2026-01-01',now())");
  for (const name of ["20260918041500_fold-account-summary-and-heatmap-aggregation.sql",
    "20260918043000_fold-account-model-breakdown-aggregation.sql", "20260918050000_fold-account-daily-aggregation.sql",
    "20261002082317_compact-leaderboard-usage-wire.sql", "20261002090000_compact-account-model-wire.sql",
    "20261003093000_compact-account-summary-model-wire.sql", "20261012120000_cloud-machine-alias-cascade.sql"]) {
    await db.exec(migration(name));
  }
  await db.exec("ALTER TABLE tokentracker_leaderboard_snapshots ADD COLUMN generated_at timestamptz NOT NULL DEFAULT now(); ALTER TABLE agentmeter_leaderboard_snapshots ADD COLUMN generated_at timestamptz NOT NULL DEFAULT now()");
  await db.exec(migration("20261015120000_cloud-device-usage-reset.sql"));
  return db;
}
before(async () => {
  db = await setupCurrentMain();
  functionContracts = await contracts(db);
  canonicalPricing = (await db.query("SELECT pg_get_functiondef('leaderboard_pricing_tier(text,timestamptz)'::regprocedure) AS d")).rows[0].d;
  // A real pre-v3 pack has no unknown column; upgrading must not rewrite it.
  legacyUser = await user(); legacyDevice = await issue(legacyUser);
  const old = { ...row(0, 20), input_tokens: 100, total_tokens: 120, billable_total_tokens: 120, total_cost_usd: 0.5 };
  delete old.unclassified_input_tokens;
  assert.equal((await ingest(legacyDevice, [old])).ok, true);
  await archive(legacyUser, legacyDevice.device_id);
  await db.exec("BEGIN");
  try { await db.exec(migration("20261019120000_unclassified-input-tokens.sql")); await db.exec("COMMIT"); }
  catch (error) { await db.exec("ROLLBACK"); throw error; }
});
after(async () => { await db?.close(); });

test("guarded migration rejects missing, changed or duplicate anchors and rolls back the whole upgrade", async () => {
  const pg = await setupCurrentMain();
  try {
    const signature = "account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)";
    const original = (await pg.query("SELECT pg_get_functiondef($1::regprocedure) AS d", [signature])).rows[0].d;
    const anchor = "      h.cached_input_tokens::bigint AS cached_input_tokens,";
    const definitions = () => pg.query("SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid").then(result => result.rows);
    const baseline = await definitions();
    for (const changed of [null, original.replace(anchor, anchor.replace(" AS ", "  AS ")),
      original.replace(anchor, anchor + " -- " + anchor)]) {
      await pg.exec("BEGIN");
      try {
        await pg.exec(changed || `DROP FUNCTION public.${signature}`);
        await assert.rejects(pg.exec(migration("20261019120000_unclassified-input-tokens.sql")),
          /Accounting v3 (SQL shape drift|requires current main function)/);
      } finally { await pg.exec("ROLLBACK"); }
      assert.deepEqual(await definitions(), baseline, "earlier function bodies must also roll back");
      assert.equal((await pg.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='tokentracker_hourly' AND column_name='unclassified_input_tokens'")).rows[0].n, 0);
      assert.equal((await pg.query("SELECT to_regprocedure('public.tokentracker_accounting_capabilities()') AS f")).rows[0].f, null);
    }
  } finally { await pg.close(); }
});

test("device convergence retains unknown input in both hot rows and cold archives", async () => {
  for (const cold of [false, true]) {
    const id = await user(), canonical = await issue(id), legacy = randomUUID();
    await db.query("INSERT INTO tokentracker_devices(id,user_id,device_name,platform) VALUES($1,$2,'legacy','web')", [legacy, id]);
    await ingest(canonical, [row()]);
    await db.query(`INSERT INTO tokentracker_hourly SELECT (jsonb_populate_record(NULL::tokentracker_hourly,
      to_jsonb(h) || jsonb_build_object('device_id',$2::text,'unclassified_input_tokens',160,
      'total_tokens',180,'billable_total_tokens',180))).* FROM tokentracker_hourly h WHERE user_id=$1`, [id, legacy]);
    if (cold) await archive(id, legacy);
    assert.equal(await rpc("refresh_tokentracker_device_identity", [id, canonical.device_id, "legacy", "web"]), true);
    const usage = await grouped(id, [canonical.device_id]);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].unclassified_input_tokens, 160);
    assert.equal(usage[0].total_tokens, 180);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM tokentracker_hourly WHERE device_id=$1", [legacy])).rows[0].n, 0);
    assert.ok((await db.query("SELECT revoked_at FROM tokentracker_devices WHERE id=$1", [legacy])).rows[0].revoked_at);
  }
});

test("current-main transaction and every compact wire retain disjoint input across cold/hot corrections and restore", async () => {
  const id = await user(), device = await issue(id);
  assert.equal((await ingest(device, [row()])).ok, true);
  assert.equal((await grouped(id, [device.device_id]))[0].unclassified_input_tokens, 100);
  const before = await Promise.all(["summary", "daily", "model_breakdown"].map(name => wire(name, id)));
  const summaryTotals = before[0].range_totals;
  assert.equal(Array.isArray(summaryTotals) ? summaryTotals[8] : summaryTotals.unclassified_input_tokens, 100);
  assert.equal(before[1].days[0][9], 100);
  assert.equal((Array.isArray(before[2]) ? before[2] : before[2].dims)[0][9], 100);
  await archive(id, device.device_id);
  assert.deepEqual(await Promise.all(["summary", "daily", "model_breakdown"].map(name => wire(name, id))), before);
  // A newer decreasing observation supersedes the pack instead of being added.
  assert.equal((await ingest(device, [row(60, 10)])).ok, true);
  assert.equal((await grouped(id, [device.device_id]))[0].unclassified_input_tokens, 60);
  assert.equal((await grouped(id, [device.device_id]))[0].total_tokens, 70);
  await archive(id, device.device_id);
  const restored = await rpc("cloud_restore_usage_archive", [randomUUID(), id, device.device_id, "2026-01-02"]);
  assert.equal(restored.restored, true);
  assert.equal(Number((await db.query("SELECT unclassified_input_tokens FROM tokentracker_hourly WHERE user_id=$1", [id])).rows[0].unclassified_input_tokens), 60);
  assert.equal((await grouped(id, [device.device_id]))[0].total_tokens, 70);
});

test("legacy cold packs restore with zero unknown input and unchanged exact cost", async () => {
  assert.equal((await grouped(legacyUser, [legacyDevice.device_id]))[0].unclassified_input_tokens, 0);
  await rpc("cloud_restore_usage_archive", [randomUUID(), legacyUser, legacyDevice.device_id, "2026-01-02"]);
  const stored = (await db.query("SELECT unclassified_input_tokens,total_cost_usd FROM tokentracker_hourly WHERE user_id=$1", [legacyUser])).rows[0];
  assert.equal(Number(stored.unclassified_input_tokens), 0);
  assert.equal(Number(stored.total_cost_usd), 0.5);
});

test("cross-machine dedup, session LWW and lifetime correction triggers retain the unknown column", async () => {
  const id = await user(), device = await issue(id), mirror = await issue(id);
  await db.query("INSERT INTO tokentracker_device_machine VALUES($1,'same'),($2,'same')", [device.device_id, mirror.device_id]);
  await ingest(device, [row()]); await ingest(mirror, [row()]);
  assert.equal((await grouped(id, [device.device_id, mirror.device_id]))[0].total_tokens, 120);
  const state = { ...row(50, 20), source: "trae-cn", session_id: "s", bucket_start: row().hour_start, snapshot_verified_at: "2026-10-19T01:00:00Z" };
  await ingest(device, [], [state]);
  await ingest(device, [], [{ ...state, unclassified_input_tokens: 0, total_tokens: 20, snapshot_verified_at: "2026-10-18T01:00:00Z" }]);
  assert.equal((await grouped(id, [device.device_id, mirror.device_id])).reduce((n, r) => n + r.unclassified_input_tokens, 0), 150);
  await rpc("leaderboard_rollup_daily_replace_v2", ["2026-01-02Z", "2026-01-03Z"]);
  const lifetime = async () => Number((await db.query("SELECT sum(unclassified_input_tokens) AS n FROM tokentracker_leaderboard_rollup_total_v2 WHERE user_id=$1", [id])).rows[0].n);
  assert.equal(await lifetime(), 150);
  await rpc("cloud_rebuild_device_usage_derived", [id, ["2026-01-02"]]);
  assert.equal(await lifetime(), 150, "current-main derived repair must not clear the unknown split");
  await db.query("UPDATE tokentracker_leaderboard_rollup_daily_v2 SET unclassified_input_tokens=30 WHERE user_id=$1", [id]);
  assert.equal(await lifetime(), 60);
  const packed = await rpc("leaderboard_usage_compact_total_shard", ["2026-01-03Z", id, null]);
  assert.ok(packed.unclassified_inputs.some(value => Number(value) > 0));
  assert.ok(packed.rows.every(r => r.length === 11), "old wire decoders retain their eleven slots");
  await db.query("DELETE FROM tokentracker_leaderboard_rollup_daily_v2 WHERE user_id=$1", [id]);
  assert.equal(await lifetime(), 0);
});

test("upgrade retains canonical weekend pricing, access locks and project-admin-only read ACLs", async () => {
  assert.deepEqual(await contracts(db), functionContracts, "in-place edits retain function OIDs, ACLs and execution settings");
  assert.equal((await db.query("SELECT pg_get_functiondef('leaderboard_pricing_tier(text,timestamptz)'::regprocedure) AS d")).rows[0].d, canonicalPricing);
  assert.equal(await rpc("leaderboard_pricing_tier", ["deepseek-v4-pro", "2026-08-23T02:00:00Z"]), "off_peak");
  for (const signature of ["tokentracker_accounting_capabilities()", "leaderboard_hourly_dedup_v2_unclassified(timestamptz,timestamptz)",
    "cloud_restore_usage_archive(uuid,uuid,uuid,date)", "account_daily_wire(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)",
    "refresh_tokentracker_device_identity(uuid,uuid,text,text)", "account_usage_grouped_cached(uuid,uuid,timestamptz,timestamptz,text,text,integer)"]) {
    for (const role of ["anon", "authenticated"]) assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, signature])).rows[0].allowed, false);
  }
  const definition = (await db.query("SELECT pg_get_functiondef('cloud_ingest_usage(text,text,jsonb,jsonb,text)'::regprocedure) AS d")).rows[0].d;
  assert.match(definition, /cloud_usage_maintenance_lock/);
  assert.match(definition, /cloud_reconcile_machines/);
  assert.match(definition, /cloud_sync_throttled/);
  const cached = (await db.query("SELECT pg_get_functiondef('account_usage_grouped_cached(uuid,uuid,timestamptz,timestamptz,text,text,integer)'::regprocedure) AS d")).rows[0].d;
  assert.match(cached, /pg_advisory_xact_lock_shared/);
  assert.match(cached, /cloud-device/);
  assert.equal((await rpc("tokentracker_accounting_capabilities")).accounting_version, 3);
});
