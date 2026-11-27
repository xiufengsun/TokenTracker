"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { migration } = require("./helpers/cloud-usage-archive-fixture");
const { eventCostCoverage } = require("../src/lib/cost-provenance");
const { fixture, row, COST_MIGRATION } = require("./helpers/cloud-cost-fixture");

test("cloud v1 stores explicit zero, clears provenance on legacy whole-row correction, and is idempotent", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.call("usage_cost_capabilities_v1"), { cost_coverage_versions: [1] });
    assert.equal((await f.ingest([row(0)])).cost_coverage_version, 1);
    assert.equal((await f.db.query("SELECT cost_coverage FROM tokentracker_hourly")).rows[0].cost_coverage.reported_events, 1);
    const legacy = row(0, 200); delete legacy.cost_coverage;
    assert.equal((await f.ingest([legacy], "cloud_ingest_usage")).ok, true);
    assert.equal((await f.db.query("SELECT cost_coverage FROM tokentracker_hourly")).rows[0].cost_coverage, null);
    await f.db.exec(migration(COST_MIGRATION));
    assert.equal((await f.ingest([row(null)])).cost_coverage_version, 1);
    assert.equal((await f.db.query("SELECT cost_coverage FROM tokentracker_hourly")).rows[0].cost_coverage.missing_events, 1);
  } finally { await f.db.close(); }
});

test("cloud coverage rejects malformed/private, cross-source and inconsistent subsets atomically", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.ingest([row(0.25)])).ok, true);
    for (const mutate of [
      r => { r.cost_coverage.prompt = "private prompt /home/private"; },
      r => { r.cost_coverage.origins = ["/home/private/token"]; },
      r => { r.cost_coverage.reported_usd = 9; },
      r => { r.cost_coverage.unreported_tokens.input_tokens = 101; },
      r => { r.cost_coverage.version = 2; },
      r => { r.source = "claude"; },
      r => { r.cost_coverage.reported_events = 0.5; },
    ]) {
      const bad = row(0.5); mutate(bad);
      await assert.rejects(f.ingest([bad]), /usage_cost_coverage_v1/);
      assert.equal(Number((await f.db.query("SELECT total_cost_usd FROM tokentracker_hourly")).rows[0].total_cost_usd), 0.25);
    }
    await f.db.exec("SET ROLE anon");
    await assert.rejects(f.call("usage_cost_capabilities_v1"), /permission denied/);
    await f.db.exec("RESET ROLE");
  } finally { await f.db.close(); }
});

test("cost evidence survives real archive commit and restore without changing raw amounts", async () => {
  const f = await fixture();
  try {
    await f.ingest([row(0)]);
    const generation = await f.call("cloud_prepare_usage_archive", [f.user, f.device, "2026-01-02"]);
    assert.equal((await f.call("cloud_commit_usage_archive", [generation])).deleted_hot_rows, 1);
    const cold = await f.db.query("SELECT cost_coverage FROM cloud_usage_hourly($1,$2,NULL,NULL)", [f.user, f.device]);
    assert.equal(cold.rows[0].cost_coverage.reported_events, 1);
    const restored = await f.call("cloud_restore_usage_archive", [randomUUID(), f.user, f.device, "2026-01-02"]);
    assert.equal(restored.restored, true);
    assert.equal((await f.db.query("SELECT cost_coverage FROM tokentracker_hourly")).rows[0].cost_coverage.reported_usd, 0);
  } finally { await f.db.close(); }
});

const costRows = (f, { user = f.user, device = null, trunc = "all", fromUser = null, toUser = null } = {}) =>
  f.call("usage_cost_provenance_v1", [user, device, "2026-01-02T00:00:00Z", "2026-01-04T00:00:00Z", trunc, "Asia/Singapore", 480, fromUser, toUser]);

test("canonical cost wire distinguishes zero, missing, mixed, legacy and source fields", async () => {
  const f = await fixture();
  try {
    const zero = row(0), missing = row(null, 400); missing.hour_start = "2026-01-02T02:30:00Z";
    await f.ingest([zero, missing]);
    let wire = await costRows(f);
    assert.equal(wire.version, 1);
    assert.equal(wire.rows.length, 1);
    assert.deepEqual(wire.rows[0].basis, { input_tokens: 500, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
    assert.equal(wire.rows[0].covered_tokens.input_tokens, 100);
    assert.equal(wire.rows[0].reported_usd, 0);
    assert.equal(wire.rows[0].has_reported, true);
    assert.equal(wire.rows[0].has_missing, true);
    assert.equal(wire.rows[0].ambiguous, false);
    const legacy = row(0.25); delete legacy.cost_coverage; legacy.hour_start = "2026-01-02T03:00:00Z";
    await f.ingest([legacy], "cloud_ingest_usage");
    wire = await costRows(f);
    assert.equal(wire.rows[0].reported_usd, 0.25);
    assert.equal(wire.rows[0].covered_tokens.input_tokens, 200);
    assert.ok(wire.rows[0].origins.includes("legacy_grok_total_cost_usd"));
    const bot = row(null, 0); bot.source = "cursor"; bot.model = "grok-bot-cua";
    bot.cost_coverage = eventCostCoverage(bot, null, "cursor_total_cents");
    await f.ingest([bot]);
    const botWire = (await costRows(f)).rows.find(r => r.source === "cursor");
    assert.equal(botWire.has_reported, false);
    assert.equal(botWire.has_missing, true);
    assert.deepEqual(botWire.origins, []);
    assert.equal(JSON.stringify(botWire).includes("private"), false);
  } finally { await f.db.close(); }
});

test("cloud cost canonicalization follows machine clusters, detects conflicting ties, and keeps account sources independent", async () => {
  const f = await fixture();
  try {
    await f.ingest([row(1)]);
    const second = randomUUID();
    await f.db.query("INSERT INTO tokentracker_devices(id,user_id,device_name,platform) VALUES($1,$2,'Second cost fixture','web')", [second, f.user]);
    await f.db.query("INSERT INTO tokentracker_device_machine(device_id,machine_cluster_id) VALUES($1,'same-cost-machine'),($2,'same-cost-machine') ON CONFLICT(device_id) DO UPDATE SET machine_cluster_id=excluded.machine_cluster_id", [f.device, second]);
    await f.db.query(`INSERT INTO tokentracker_hourly(user_id,device_id,hour_start,source,model,input_tokens,cached_input_tokens,cache_creation_input_tokens,
      output_tokens,reasoning_output_tokens,total_tokens,billable_total_tokens,conversations,total_cost_usd,cost_coverage,updated_at)
      SELECT user_id,$1,hour_start,source,model,input_tokens,cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,
      total_tokens,billable_total_tokens,conversations,2,jsonb_set(cost_coverage,'{reported_usd}','2'),updated_at FROM tokentracker_hourly WHERE device_id=$2`, [second, f.device]);
    assert.equal((await costRows(f)).rows[0].ambiguous, true, "conflicting trustworthy amounts at identical canonical rank do not silently win");
    await f.db.query("UPDATE tokentracker_hourly SET total_cost_usd=1,cost_coverage=NULL WHERE device_id=$1", [second]);
    assert.equal((await costRows(f)).rows[0].ambiguous, false, "equivalent legacy positive and fully-covered USD are not a conflict");
    await f.db.query("UPDATE tokentracker_hourly SET total_cost_usd=0,cost_coverage=$1 WHERE device_id=$2", [JSON.stringify(row(null).cost_coverage), f.device]);
    assert.equal((await costRows(f)).rows[0].reported_usd, 1, "trustworthy reported amount wins a tied missing-amount snapshot");
    await f.db.query("UPDATE tokentracker_hourly SET total_cost_usd=1,cost_coverage=$1 WHERE device_id=$2", [JSON.stringify(row(1).cost_coverage), f.device]);
    await f.db.query("UPDATE tokentracker_hourly SET total_cost_usd=2,cost_coverage=$1,updated_at=updated_at+interval '1 second' WHERE device_id=$2", [JSON.stringify(row(2).cost_coverage), second]);
    let wire = await costRows(f);
    assert.equal(wire.rows[0].reported_usd, 2);
    assert.equal(wire.rows[0].basis.input_tokens, 100);
    await f.db.query("UPDATE tokentracker_device_machine SET machine_cluster_id='other-cost-machine' WHERE device_id=$1", [second]);
    wire = await costRows(f);
    assert.equal(wire.rows[0].reported_usd, 3);
    assert.equal(wire.rows[0].basis.input_tokens, 200);
    assert.equal((await costRows(f, { device: f.device })).rows[0].reported_usd, 1);
    const bot = row(0.37); bot.source = "cursor"; bot.model = "grok-bot-default"; bot.cost_coverage = eventCostCoverage(bot, 0.37, "cursor_csv_cost");
    await f.ingest([bot]);
    wire = await costRows(f, { device: second });
    assert.equal(wire.rows.find(r => r.source === "cursor").reported_usd, 0.37, "account-level Cursor ignores the selected machine");
    assert.equal((await costRows(f, { user: randomUUID() })).rows.length, 0);
    const bounded = await costRows(f, { user: null, fromUser: f.user, toUser: f.user });
    assert.equal(bounded.rows.length, 0, "UUID upper shard bound is exclusive");
  } finally { await f.db.close(); }
});

test("device identity merge copies provenance with its selected whole row", async () => {
  const f = await fixture();
  try {
    await f.ingest([row(0.25)]);
    const legacy = randomUUID();
    await f.db.query("UPDATE tokentracker_devices SET device_name='Cost fixture canonical' WHERE id=$1", [f.device]);
    await f.db.query("INSERT INTO tokentracker_devices(id,user_id,device_name,platform,machine_id) VALUES($1,$2,'Cost fixture','web',NULL)", [legacy, f.user]);
    await f.db.query("UPDATE tokentracker_hourly SET device_id=$1 WHERE device_id=$2", [legacy, f.device]);
    assert.equal(await f.call("refresh_tokentracker_device_identity", [f.user, f.device, "Cost fixture", "web"]), true);
    const selected = (await f.db.query("SELECT device_id,total_cost_usd,cost_coverage FROM tokentracker_hourly")).rows[0];
    assert.equal(selected.device_id, f.device);
    assert.equal(Number(selected.total_cost_usd), 0.25);
    assert.equal(selected.cost_coverage.reported_usd, 0.25);
    assert.equal(selected.cost_coverage.reported_events, 1);
  } finally { await f.db.close(); }
});

test("guarded migration preserves unrelated installed fixes and fails closed on shape drift", async () => {
  const f = await fixture({ apply: false });
  try {
    const signature = "public.cloud_ingest_usage(text,text,jsonb,jsonb,text)";
    const before = (await f.db.query("SELECT pg_get_functiondef($1::regprocedure) AS def,$1::regprocedure::oid::text AS oid", [signature])).rows[0];
    await f.db.exec(before.def.replace("-- Each batch", "-- cost_coverage unrelated installed fix\n  -- Each batch"));
    await f.db.exec(migration(COST_MIGRATION));
    const after = (await f.db.query("SELECT pg_get_functiondef($1::regprocedure) AS def,$1::regprocedure::oid::text AS oid", [signature])).rows[0];
    assert.equal(after.oid, before.oid);
    assert.match(after.def, /cost_coverage unrelated installed fix/);
    assert.match(after.def, /cost_coverage=excluded.cost_coverage/);
    assert.equal((await f.db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed, false);
  } finally { await f.db.close(); }
  const drift = await fixture({ apply: false });
  try {
    const before = (await drift.db.query("SELECT pg_get_functiondef('public.cloud_ingest_usage(text,text,jsonb,jsonb,text)'::regprocedure) AS def")).rows[0].def;
    await drift.db.exec(before.replace("billable_total_tokens,total_cost_usd,conversations,updated_at)", "billable_total_tokens, total_cost_usd,conversations,updated_at)"));
    await assert.rejects(drift.db.exec(migration(COST_MIGRATION)), /Unexpected cloud ingest baseline/);
    await drift.db.exec("ROLLBACK");
    assert.equal((await drift.db.query("SELECT count(*)::integer AS n FROM information_schema.columns WHERE table_name='tokentracker_hourly' AND column_name='cost_coverage'")).rows[0].n, 0);
    assert.equal((await drift.db.query("SELECT to_regprocedure('public.usage_cost_capabilities_v1()')::text AS name")).rows[0].name, null);
  } finally { await drift.db.close(); }
});


test("cost contract installs on the production hot-only baseline without enabling archival", async () => {
  const f = await fixture({ archive: false, apply: false });
  try {
    const before = (await f.db.query("SELECT count(*)::integer AS n FROM tokentracker_hourly")).rows[0].n;
    await f.db.exec(migration(COST_MIGRATION));
    assert.equal((await f.db.query("SELECT count(*)::integer AS n FROM tokentracker_hourly")).rows[0].n, before);
    assert.equal((await f.db.query("SELECT to_regclass('public.tokentracker_usage_archive_manifest')::text AS name")).rows[0].name, null);
    await f.ingest([row(0)]);
    assert.equal((await costRows(f)).rows[0].reported_usd, 0);
    assert.equal((await costRows(f)).rows[0].has_reported, true);
    await f.db.exec(migration(COST_MIGRATION));
    assert.equal((await costRows(f)).rows[0].basis.input_tokens, 100);
    await f.db.exec("CREATE TABLE tokentracker_usage_archive_manifest(id integer)");
    await assert.rejects(costRows(f), /Incomplete archive cost baseline/);
    await assert.rejects(f.db.exec(migration(COST_MIGRATION)), /Incomplete archive baseline/);
    await f.db.exec("ROLLBACK");
  } finally { await f.db.close(); }
});

test("legacy and versioned ingest preserve precise amounts only for the same Cursor usage snapshot", async () => {
  const f = await fixture({ archive: false });
  try {
    await f.db.exec("ALTER TABLE tokentracker_hourly ALTER COLUMN total_cost_usd TYPE numeric(12,4)");
    const patch = migration("20261126060000_compatible-reported-cost-ingest.sql");
    await f.db.exec(patch);
    await f.db.exec(patch);
    const bot = { ...row(0.081732), source: "cursor", model: "grok-bot-default" };
    bot.cost_coverage = eventCostCoverage(bot, 0.081732, "cursor_total_cents");
    const read = async () => (await f.db.query("SELECT total_cost_usd,cost_coverage,input_tokens FROM tokentracker_hourly")).rows[0];
    assert.equal((await f.ingest([bot])).cost_coverage_version, 1);
    assert.equal(Number((await read()).total_cost_usd), 0.0817);
    const legacy = { ...bot, total_cost_usd: 0 };
    delete legacy.cost_coverage;
    assert.equal((await f.ingest([legacy], "cloud_ingest_usage")).ok, true);
    assert.equal((await read()).cost_coverage.reported_usd, 0.081732);
    const csv = { ...bot, total_cost_usd: 0, cost_coverage: eventCostCoverage(bot, 0, "cursor_csv_cost") };
    assert.equal((await f.ingest([csv], "cloud_ingest_usage")).ok, true);
    assert.equal((await read()).cost_coverage.reported_usd, 0.081732);
    const changed = { ...legacy, input_tokens: 90, total_tokens: 90, billable_total_tokens: 90 };
    assert.equal((await f.ingest([changed], "cloud_ingest_usage")).ok, true);
    assert.deepEqual(await read(), { total_cost_usd: "0.0000", cost_coverage: null, input_tokens: 90 });
  } finally { await f.db.close(); }
});
