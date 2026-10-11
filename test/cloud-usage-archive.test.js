const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setup, migration } = require('./helpers/cloud-usage-archive-fixture');
const archiveSql = migration('20261005120000_cloud-usage-archive.sql');
let db;
let pricingDefinition;
before(async () => {
  db = await setup();
  pricingDefinition = (await db.query("SELECT pg_get_functiondef('leaderboard_pricing_tier(text,timestamptz)'::regprocedure) AS definition")).rows[0].definition;
  await db.exec(archiveSql);
});
after(async () => { await db?.close(); });
async function user() {
  const id = randomUUID(); await db.query('INSERT INTO auth.users VALUES($1)', [id]); return id;
}
async function device(id, cluster = null, machine = randomUUID(), name = randomUUID()) {
  const dev = randomUUID();
  await db.query('INSERT INTO tokentracker_devices(id,user_id,device_name,default_device_name,platform,machine_id) VALUES($1,$2,$3,$3,$4,$5)', [dev, id, name, 'web', machine]);
  if (cluster) await db.query('INSERT INTO tokentracker_device_machine VALUES($1,$2)', [dev, cluster]);
  return dev;
}
async function write(id, dev, total = 100, hour = '2026-01-02T02:00:00Z', source = 'codex', model = 'gpt-6') {
  await db.query(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,
    cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
    billable_total_tokens,conversations,total_cost_usd) VALUES($1,$2,$3,$4,$5,$6,0,0,0,0,$6,$6,1,0.01234)
    ON CONFLICT(user_id,device_id,source,model,hour_start) DO UPDATE SET input_tokens=EXCLUDED.input_tokens,
    total_tokens=EXCLUDED.total_tokens,billable_total_tokens=EXCLUDED.billable_total_tokens`, [id, dev, source, model, hour, total]);
}
async function rpc(name, args = []) {
  const call = `${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`;
  const sql = name === 'leaderboard_hourly_dedup_v2'
    ? `SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY user_id,source,model,hour_start),'[]') AS result FROM ${call} h`
    : `SELECT ${call} AS result`;
  return (await db.query(sql, args)).rows[0].result;
}
const prepare = (id, dev, day = '2026-01-02') => rpc('cloud_prepare_usage_archive', [id, dev, day]);
const commit = gen => rpc('cloud_commit_usage_archive', [gen]);
async function archive(id, dev, day = '2026-01-02') { const gen = await prepare(id, dev, day); return gen && commit(gen); }
const grouped = (id, devs, trunc = 'day', tz = 'UTC', offset = null) => rpc('account_usage_grouped', [id, devs, '2025-01-01Z', '2027-01-01Z', trunc, tz, offset]);
async function rows(id, dev = null) { return (await db.query('SELECT to_jsonb(h) AS row FROM cloud_usage_hourly($1,$2,NULL,NULL) h ORDER BY hour_start,source,model', [id, dev])).rows.map(r => r.row); }
async function total(id) { return (await db.query('SELECT COALESCE(sum(total_tokens),0)::integer AS n FROM tokentracker_leaderboard_rollup_total_v2 WHERE user_id=$1', [id])).rows[0].n; }

test('archive wiring retains canonical pricing and denies direct client access', async () => {
  const fn = (await db.query("SELECT pg_get_functiondef('leaderboard_pricing_tier(text,timestamptz)'::regprocedure) AS definition")).rows[0].definition;
  assert.equal(fn, pricingDefinition);
  const perms = (await db.query(`SELECT has_function_privilege('authenticated','cloud_usage_hourly(uuid,uuid,timestamptz,timestamptz)','EXECUTE') AS read,
    has_function_privilege('anon','cloud_commit_usage_archive(uuid)','EXECUTE') AS commit,
    has_table_privilege('authenticated','tokentracker_usage_archive_generations','SELECT') AS packs,
    has_function_privilege('authenticated','cloud_erase_user_usage(uuid,uuid,uuid)','EXECUTE') AS erase,
    has_function_privilege('anon','cloud_restore_usage_archive(uuid,uuid,uuid,date)','EXECUTE') AS restore,
    has_table_privilege('authenticated','tokentracker_usage_maintenance_operations','SELECT') AS operations`)).rows[0];
  assert.deepEqual(perms, { read: false, commit: false, packs: false, erase: false, restore: false, operations: false });
  const id = await user(), dev = await device(id);
  await write(id, dev, 10, '2026-08-23T02:00:00Z', 'claude', 'deepseek-v4-pro');
  assert.equal((await grouped(id, [dev]))[0].pricing_tier, 'off_peak');
  assert.equal(await rpc('leaderboard_pricing_tier', ['deepseek-v4-pro', '2026-08-16T02:00:00Z']), 'peak');
});

test('server revisions replace decreasing and zero values and invalidate private cache', async () => {
  const id = await user(), dev = await device(id);
  await write(id, dev);
  const first = (await rows(id))[0];
  await db.query("INSERT INTO tokentracker_account_usage_cache VALUES($1,now(),'[]')", ['v1' + String.fromCharCode(31) + id + String.fromCharCode(31) + 'range']);
  await db.query('UPDATE tokentracker_hourly SET total_tokens=0,input_tokens=0,archive_revision=999999999 WHERE user_id=$1', [id]);
  const next = (await rows(id))[0];
  assert.equal(next.total_tokens, 0);
  assert.ok(next.archive_revision > first.archive_revision && next.archive_revision < 999999999);
  assert.equal(next.updated_at, first.updated_at);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_account_usage_cache')).rows[0].n, 0);
});

test('prepare, correction, commit preserves overlay and a repeat compaction retains every field', async () => {
  const id = await user(), dev = await device(id);
  await write(id, dev, 100); await write(id, dev, 50, '2026-01-02T02:30:00Z');
  const gen = await prepare(id, dev);
  await write(id, dev, 0);
  await write(id, dev, 33, '2026-01-02T03:00:00Z');
  const corrected = await rows(id);
  const result = await commit(gen);
  assert.equal(result.deleted_hot_rows, 1);
  assert.deepEqual(await rows(id), corrected);
  assert.equal((await commit(gen)).already_committed, true);
  await archive(id, dev);
  assert.deepEqual(await rows(id), corrected);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_hourly WHERE user_id=$1', [id])).rows[0].n, 0);
  assert.equal((await db.query('SELECT payload FROM tokentracker_usage_archive_generations WHERE id=$1', [gen])).rows[0].payload, null);
  const superseded = await commit(gen);
  assert.equal(superseded.status, 'superseded');
  assert.equal(superseded.is_current, false);
  assert.equal(superseded.already_committed, false);
  assert.equal(corrected[0].billable_total_tokens, 0);
  assert.equal(corrected[0].total_cost_usd, 0.01234);
});

test('failed checksum or stale generation cannot delete hot truth or switch the manifest', async () => {
  const id = await user(), dev = await device(id); await write(id, dev);
  const corrupted = await prepare(id, dev);
  await db.query("UPDATE tokentracker_usage_archive_generations SET checksum='wrong' WHERE id=$1", [corrupted]);
  await assert.rejects(commit(corrupted), /checksum/);
  assert.equal((await rows(id))[0].total_tokens, 100);
  const a = await prepare(id, dev), b = await prepare(id, dev);
  await commit(a); await write(id, dev, 20);
  await assert.rejects(commit(b), /stale/);
  assert.equal((await rows(id))[0].total_tokens, 20);
  assert.equal((await db.query('SELECT generation_id FROM tokentracker_usage_archive_manifest WHERE user_id=$1', [id])).rows[0].generation_id, a);
});

test('row count, revision ranges and deletion coverage are verified before activation', async () => {
  const id = await user(), dev = await device(id); await write(id, dev);
  const count = await prepare(id, dev);
  await db.query('UPDATE tokentracker_usage_archive_generations SET row_count=2 WHERE id=$1', [count]);
  await assert.rejects(commit(count), /row count/);
  const range = await prepare(id, dev);
  await db.query('UPDATE tokentracker_usage_archive_generations SET max_revision=max_revision+1 WHERE id=$1', [range]);
  await assert.rejects(commit(range), /revision range/);
  const deletion = await prepare(id, dev);
  await db.query(`UPDATE tokentracker_usage_archive_generations SET hot_snapshot=
    jsonb_set(hot_snapshot,'{0,archive_revision}','999999999') WHERE id=$1`, [deletion]);
  await assert.rejects(commit(deletion), /deletion snapshot/);
  assert.equal((await rows(id))[0].total_tokens, 100);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_usage_archive_manifest WHERE user_id=$1', [id])).rows[0].n, 0);
});

test('complete truth keeps device, cluster, Cursor, TRAE and timezone parity after compaction', async () => {
  const id = await user(), cluster = randomUUID();
  const devs = [await device(id, cluster), await device(id, cluster), await device(id)];
  for (const hour of ['2026-03-08T06:30:00Z', '2026-03-08T07:00:00Z', '2026-04-05T14:30:00Z']) {
    for (let i = 0; i < devs.length; i++) {
      await write(id, devs[i], 100 + i, hour);
      await write(id, devs[i], 77, hour, 'cursor');
      await write(id, devs[i], 9999, hour, 'trae-cn');
    }
  }
  await rpc('tokentracker_upsert_account_session_states', [id, JSON.stringify([{ source: 'trae-cn', session_id: 'session', model: 'trae-model', bucket_start: '2026-03-08T07:00:00Z', input_tokens: 19, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 19, snapshot_verified_at: '2026-09-01T00:00:00Z' }])]);
  const scenarios = [];
  for (const selection of [devs, [devs[0]], [devs[2]]]) {
    for (const trunc of ['hour', 'day', 'month']) {
      for (const tz of ['UTC', 'America/New_York', 'Asia/Shanghai', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'invalid-zone']) {
        scenarios.push({ selection, trunc, tz, expected: await grouped(id, selection, trunc, tz, -345) });
      }
    }
  }
  const leaderboard = await rpc('leaderboard_hourly_dedup_v2', ['2026-01-01Z', '2026-05-01Z']);
  for (const dev of devs) for (const day of ['2026-03-08', '2026-04-05']) await archive(id, dev, day);
  for (const s of scenarios) assert.deepEqual(await grouped(id, s.selection, s.trunc, s.tz, -345), s.expected);
  assert.deepEqual(await rpc('leaderboard_hourly_dedup_v2', ['2026-01-01Z', '2026-05-01Z']), leaderboard);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_account_session_states WHERE user_id=$1', [id])).rows[0].n, 1);
});

test('public lifetime triggers and dirty-day repairs use cold truth for downward corrections', async () => {
  const id = await user(), dev = await device(id); await write(id, dev, 100);
  await rpc('leaderboard_rollup_daily_replace_v2', ['2026-01-02Z', '2026-01-03Z']);
  assert.equal(await total(id), 100);
  await archive(id, dev);
  assert.equal(await total(id), 100);
  await rpc('leaderboard_rollup_daily_replace_v2', ['2026-01-02Z', '2026-01-03Z']);
  assert.equal(await total(id), 100);
  await write(id, dev, 0);
  for (let i = 0; i < 10; i++) await rpc('cloud_repair_usage_days', [7]);
  assert.equal(await total(id), 0);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_leaderboard_rollup_daily_v2 WHERE user_id=$1', [id])).rows[0].n, 1);
});

test('session model and day moves dirty both placements without duplicating lifetime totals', async () => {
  const id = await user();
  const state = (tokens, model, bucket, stamp) => [{ source: 'trae-cn', session_id: 'same-session', model, bucket_start: bucket, input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: tokens, snapshot_verified_at: stamp }];
  await rpc('tokentracker_upsert_account_session_states', [id, JSON.stringify(state(100, 'old-model', '2026-01-02Z', '2026-09-01Z'))]);
  await rpc('leaderboard_rollup_daily_replace_v2', ['2026-01-02Z', '2026-01-04Z']);
  await rpc('tokentracker_upsert_account_session_states', [id, JSON.stringify(state(20, 'new-model', '2026-01-03Z', '2026-09-02Z'))]);
  assert.deepEqual((await db.query('SELECT day::text AS "day" FROM tokentracker_usage_dirty_days WHERE user_id=$1 ORDER BY day', [id])).rows.map(r => r.day), ['2026-01-02', '2026-01-03']);
  for (let i = 0; i < 10; i++) await rpc('cloud_repair_usage_days', [7]);
  assert.equal(await total(id), 20);
  const models = (await db.query('SELECT model FROM tokentracker_leaderboard_rollup_daily_v2 WHERE user_id=$1', [id])).rows.map(r => r.model);
  assert.deepEqual(models, ['new-model']);
});

test('legacy identity convergence transfers cold ownership before revocation and permits later zero correction', async () => {
  const id = await user(), name = randomUUID();
  const legacy = await device(id, null, null, name), canonical = await device(id, null, randomUUID(), 'current');
  await write(id, legacy, 100); await archive(id, legacy); await write(id, canonical, 60);
  const pending = await prepare(id, legacy);
  assert.equal(await rpc('refresh_tokentracker_device_identity', [id, canonical, name, 'web']), true);
  const truth = await rows(id);
  assert.equal(truth.length, 1); assert.equal(truth[0].device_id, canonical); assert.equal(truth[0].total_tokens, 100);
  assert.equal((await grouped(id, [canonical]))[0].total_tokens, 100);
  await assert.rejects(commit(pending), /device changed/);
  await write(id, canonical, 0); assert.equal((await rows(id))[0].total_tokens, 0);
  await archive(id, canonical); assert.equal((await rows(id))[0].total_tokens, 0);
});

test('retention activation is explicit and a day in the ninety-day hot window is rejected', async () => {
  const id = await user(), dev = await device(id);
  await write(id, dev, 17, new Date().toISOString());
  await assert.rejects(prepare(id, dev, new Date().toISOString().slice(0, 10)), /ninety-day/);
  assert.equal((await rows(id))[0].total_tokens, 17);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_usage_archive_manifest WHERE user_id=$1', [id])).rows[0].n, 0);
});

test('pack storage measurement reports actual PostgreSQL datum bytes and row counts', async t => {
  const id = await user(), dev = await device(id);
  await db.query(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,
    cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
    billable_total_tokens,conversations,total_cost_usd)
    SELECT $1,$2,'codex','gpt-6-measurement',timestamptz '2026-01-01Z'+n*interval '30 minutes',
      100+n,0,0,0,0,100+n,100+n,1,0.01234 FROM generate_series(0,479) n`, [id, dev]);
  const hot = (await db.query('SELECT count(*)::integer rows,sum(pg_column_size(h))::integer bytes FROM tokentracker_hourly h WHERE user_id=$1', [id])).rows[0];
  for (let day = 1; day <= 10; day++) await archive(id, dev, '2026-01-' + String(day).padStart(2, '0'));
  const cold = (await db.query(`SELECT count(*)::integer packs,sum(pg_column_size(g.payload))::integer payload_bytes,
    sum(pg_column_size(g))+pg_column_size(ARRAY[]::integer[]) AS generation_bytes
    FROM tokentracker_usage_archive_manifest m JOIN tokentracker_usage_archive_generations g ON g.id=m.generation_id
    WHERE m.user_id=$1`, [id])).rows[0];
  assert.equal(hot.rows, 480); assert.equal(cold.packs, 10);
  assert.equal((await rows(id)).length, 480);
  // This fixture demonstrates its own storage shape, not a production bill reduction.
  t.diagnostic(JSON.stringify({ fixture: '480 half-hour rows / 10 UTC days', hot, cold }));
});

test('SQL shape drift aborts the whole migration before any archive schema is retained', async () => {
  const isolated = await setup();
  try {
    await isolated.exec("CREATE OR REPLACE FUNCTION public.account_usage_grouped(p_user_id uuid,p_device_ids uuid[],p_from timestamptz,p_to timestamptz,p_trunc text,p_tz text,p_offset_min integer) RETURNS jsonb LANGUAGE sql AS $$ SELECT '[]'::jsonb $$");
    await assert.rejects(isolated.transaction(tx => tx.exec(archiveSql)), /Account usage SQL shape drift/);
    assert.equal((await isolated.query("SELECT to_regclass('tokentracker_usage_archive_manifest')::text AS name")).rows[0].name, null);
    assert.equal((await isolated.query("SELECT count(*)::integer n FROM information_schema.columns WHERE table_name='tokentracker_hourly' AND column_name='archive_revision'")).rows[0].n, 0);
  } finally { await isolated.close(); }
});

test('billing, machine admission, real ingest RPC and archive run together in the same database', async () => {
  const isolated = await setup();
  const call = async (name, args) => (await isolated.query(`SELECT ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS result`, args)).rows[0].result;
  try {
    await isolated.exec(migration('20261003120000_cloud-subscriptions.sql'));
    await isolated.exec(migration('20261004120000_cloud-machine-access.sql'));
    await isolated.exec(archiveSql);
    await isolated.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now() WHERE environment='sandbox'");
    const id = randomUUID(); await isolated.query('INSERT INTO auth.users VALUES($1)', [id]);
    await call('cloud_start_trial', [id, 'sandbox']);
    const token = randomUUID();
    const issued = await call('cloud_issue_device_token', [id, 'sandbox', 'Integration device', 'web', randomUUID(), ['Integration device'], randomUUID(), token, false, null]);
    assert.equal(issued.ok, true);
    const row = n => [{ hour_start: '2026-01-02T02:00:00Z', source: 'codex', model: 'gpt-6', input_tokens: n,
      output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
      total_tokens: n, billable_total_tokens: n, total_cost_usd: 0, conversations: 1 }];
    const upload = randomUUID();
    assert.equal((await call('cloud_ingest_usage', [token, 'sandbox', JSON.stringify(row(100)), '[]', upload])).ok, true);
    const dev = (await isolated.query('SELECT device_id FROM tokentracker_device_tokens WHERE token_hash=$1', [token])).rows[0].device_id;
    const gen = await call('cloud_prepare_usage_archive', [id, dev, '2026-01-02']);
    assert.equal((await call('cloud_commit_usage_archive', [gen])).deleted_hot_rows, 1);
    assert.equal((await call('cloud_ingest_usage', [token, 'sandbox', JSON.stringify(row(0)), '[]', upload])).ok, true);
    assert.equal((await isolated.query('SELECT total_tokens::integer n FROM cloud_usage_hourly($1,$2,NULL,NULL)', [id, dev])).rows[0].n, 0);
  } finally { await isolated.close(); }
});

test('five hundred buckets invalidate cache at statement scope and the user expression uses an index', async t => {
  const id = await user(), dev = await device(id);
  await db.query(`INSERT INTO tokentracker_account_usage_cache(cache_key,fetched_at,result)
    SELECT concat_ws(chr(31),'v1',CASE WHEN n%1000=0 THEN $1 ELSE gen_random_uuid()::text END,n::text),
      now(),'[]'::jsonb FROM generate_series(1,20000) n`, [id]);
  await db.exec(`ANALYZE tokentracker_account_usage_cache;
    CREATE TEMP TABLE archive_cache_invalidation_calls(n integer);
    CREATE FUNCTION archive_test_cache_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO archive_cache_invalidation_calls VALUES(1); RETURN NULL; END $$;
    CREATE TRIGGER archive_test_cache_delete AFTER DELETE ON tokentracker_account_usage_cache
      FOR EACH STATEMENT EXECUTE FUNCTION archive_test_cache_delete();`);
  try {
    const plan = (await db.query('EXPLAIN(FORMAT JSON,COSTS FALSE) DELETE FROM tokentracker_account_usage_cache WHERE split_part(cache_key,chr(31),2)=$1', [id])).rows[0]['QUERY PLAN'];
    assert.match(JSON.stringify(plan), /tokentracker_account_usage_cache_user_idx/);
    await db.query(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,
      cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
      billable_total_tokens,conversations,total_cost_usd)
      SELECT $1,$2,'codex','batch-model',timestamptz '2026-01-01Z'+n*interval '30 minutes',
        100,0,0,0,0,100,100,1,0 FROM generate_series(0,499) n`, [id, dev]);
    assert.equal((await db.query('SELECT count(*)::integer n FROM archive_cache_invalidation_calls')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_account_usage_cache WHERE split_part(cache_key,chr(31),2)=$1', [id])).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_account_usage_cache')).rows[0].n, 19980);
    t.diagnostic('20,000 cache keys: ' + JSON.stringify(plan));
  } finally {
    await db.exec('DROP TRIGGER archive_test_cache_delete ON tokentracker_account_usage_cache; DROP FUNCTION archive_test_cache_delete(); DROP TABLE archive_cache_invalidation_calls;');
  }
});

test('archive operation replay reuses its preparation and cannot change scope', async () => {
  const id = await user(), dev = await device(id); await write(id, dev);
  const operation = randomUUID();
  const a = await rpc('cloud_prepare_usage_archive_operation', [operation, id, dev, '2026-01-02']);
  const b = await rpc('cloud_prepare_usage_archive_operation', [operation, id, dev, '2026-01-02']);
  assert.equal(a.generation, b.generation);
  await assert.rejects(rpc('cloud_prepare_usage_archive_operation', [operation, id, dev, '2026-01-03']), /scope cannot change/);
  await rpc('cloud_commit_usage_archive_operation', [operation]);
  await write(id, dev, 0);
  assert.equal((await rpc('cloud_commit_usage_archive_operation', [operation])).replayed, true);
  assert.equal((await rows(id))[0].total_tokens, 0);
});

test('restore keeps newer hot zero overlays and then closes the cold manifest without changing lifetime', async () => {
  const id = await user(), dev = await device(id);
  await write(id, dev, 100); await write(id, dev, 40, '2026-01-02T02:30:00Z');
  await archive(id, dev); await write(id, dev, 0);
  await rpc('leaderboard_rollup_daily_replace_v2', ['2026-01-02Z', '2026-01-03Z']);
  const truth = await rows(id), lifetime = await total(id), operation = randomUUID();
  const omitRevision = values => values.map(({ archive_revision, ...row }) => row);
  const restored = await rpc('cloud_restore_usage_archive', [operation, id, dev, '2026-01-02']);
  assert.equal(restored.inserted_hot_rows, 1); assert.equal(restored.updated_hot_rows, 0);
  assert.deepEqual(omitRevision(await rows(id)), omitRevision(truth));
  assert.equal(await total(id), lifetime);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_usage_archive_manifest WHERE user_id=$1', [id])).rows[0].n, 0);
  await archive(id, dev);
  assert.equal((await rpc('cloud_restore_usage_archive', [operation, id, dev, '2026-01-02'])).replayed, true);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_usage_archive_manifest WHERE user_id=$1', [id])).rows[0].n, 1);
});

test('a restore failure after hot insertion rolls back rows, manifest and operation together', async () => {
  const id = await user(), dev = await device(id); await write(id, dev); await archive(id, dev);
  const operation = randomUUID(), truth = await rows(id);
  await db.exec(`CREATE FUNCTION archive_test_restore_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'isolated restore failure'; END $$;
    CREATE TRIGGER archive_test_restore_failure BEFORE DELETE ON tokentracker_usage_archive_manifest
      FOR EACH ROW EXECUTE FUNCTION archive_test_restore_failure();`);
  try { await assert.rejects(rpc('cloud_restore_usage_archive', [operation, id, dev, '2026-01-02']), /isolated restore failure/); }
  finally { await db.exec('DROP TRIGGER archive_test_restore_failure ON tokentracker_usage_archive_manifest; DROP FUNCTION archive_test_restore_failure();'); }
  assert.deepEqual(await rows(id), truth);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_hourly WHERE user_id=$1', [id])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_usage_archive_manifest WHERE user_id=$1', [id])).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_usage_maintenance_operations WHERE id=$1', [operation])).rows[0].n, 0);
});

test('restore replaces a lower legacy hot row with its complete canonical cold winner', async () => {
  const id = await user(), name = randomUUID();
  const legacy = await device(id, null, null, name), canonical = await device(id, null, randomUUID(), 'Canonical restore');
  await write(id, legacy, 100); await archive(id, legacy); await write(id, canonical, 60);
  await rpc('refresh_tokentracker_device_identity', [id, canonical, name, 'web']);
  const before = (await rows(id))[0];
  assert.equal(before.total_tokens, 100);
  assert.equal((await db.query('SELECT total_tokens::integer n FROM tokentracker_hourly WHERE user_id=$1', [id])).rows[0].n, 60);
  const restored = await rpc('cloud_restore_usage_archive', [randomUUID(), id, canonical, '2026-01-02']);
  assert.equal(restored.updated_hot_rows, 1);
  const after = (await rows(id))[0];
  assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([k]) => k !== 'archive_revision')),
    Object.fromEntries(Object.entries(before).filter(([k]) => k !== 'archive_revision')));
  await write(id, canonical, 0); assert.equal((await rows(id))[0].total_tokens, 0);
});

test('bounded cleanup deletes only old superseded empty metadata and leaves another user intact', async () => {
  const id = await user(), dev = await device(id), other = await user(), otherDev = await device(other);
  for (let i = 0; i < 3; i++) { await write(id, dev, 100 + i); await archive(id, dev); }
  await write(other, otherDev); await archive(other, otherDev); await write(other, otherDev, 101); await archive(other, otherDev);
  await db.exec("UPDATE tokentracker_usage_archive_generations SET committed_at=now()-interval '31 days' WHERE status='superseded'");
  const otherBefore = (await db.query('SELECT count(*)::integer n FROM tokentracker_usage_archive_generations WHERE user_id=$1', [other])).rows[0].n;
  const op = randomUUID();
  assert.equal((await rpc('cloud_cleanup_usage_archive', [op, id, 1])).deleted_generations, 1);
  assert.equal((await rpc('cloud_cleanup_usage_archive', [op, id, 1])).replayed, true);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_usage_archive_generations WHERE user_id=$1', [id])).rows[0].n, 2);
  assert.equal((await db.query('SELECT count(*)::integer n FROM tokentracker_usage_archive_generations WHERE user_id=$1', [other])).rows[0].n, otherBefore);
  assert.equal((await rows(id))[0].total_tokens, 102);
  await assert.rejects(rpc('cloud_cleanup_usage_archive', [randomUUID(), id, 1001]), /bounded/);
});

test('user usage erasure is atomic, scoped and idempotent while auth and financial records survive', async () => {
  const isolated = await setup();
  const call = async (name, args) => (await isolated.query(`SELECT ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS result`, args)).rows[0].result;
  try {
    await isolated.exec(migration('20261003120000_cloud-subscriptions.sql'));
    await isolated.exec(migration('20261004120000_cloud-machine-access.sql'));
    await isolated.exec(archiveSql);
    await isolated.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now() WHERE environment='sandbox'");
    const id = randomUUID(), other = randomUUID();
    await isolated.query('INSERT INTO auth.users VALUES($1),($2)', [id, other]);
    const tokens = [];
    for (const owner of [id, other]) {
      await call('cloud_start_trial', [owner, 'sandbox']);
      const token = randomUUID(), issued = await call('cloud_issue_device_token', [owner, 'sandbox', 'Erase fixture', 'web', randomUUID(), ['Erase fixture'], randomUUID(), token, false, null]);
      assert.equal(issued.ok, true); tokens.push(token);
      const dev = (await isolated.query('SELECT device_id FROM tokentracker_device_tokens WHERE token_hash=$1', [token])).rows[0].device_id;
      await isolated.query(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,
        cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,billable_total_tokens,
        conversations,total_cost_usd) VALUES($1,$2,'codex','gpt-6','2026-01-02Z',100,0,0,0,0,100,100,1,0)`, [owner, dev]);
      const gen = await call('cloud_prepare_usage_archive', [owner, dev, '2026-01-02']); await call('cloud_commit_usage_archive', [gen]);
      await isolated.query("INSERT INTO tokentracker_leaderboard_snapshots VALUES($1,'total','1970-01-01','2026-01-03',1,100,'Snapshot fixture')", [owner]);
      await isolated.query("INSERT INTO agentmeter_leaderboard_snapshots SELECT * FROM tokentracker_leaderboard_snapshots WHERE user_id=$1", [owner]);
      await isolated.query("INSERT INTO tokentracker_leaderboard_rollup_daily VALUES($1,'codex','gpt-6','2026-01-02',100,100,0,0,0,0)", [owner]);
      await isolated.query(`INSERT INTO agentmeter_hourly(user_id,device_id,source,model,hour_start,input_tokens,
        cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,billable_total_tokens,
        conversations,total_cost_usd) VALUES($1,$2,'codex','gpt-6','2026-01-02Z',100,0,0,0,0,100,100,1,0)`, [owner, dev]);
      const order = await call('cloud_create_order', [owner, 'sandbox', 'alipay', 'cloud_cny_monthly', randomUUID()]);
      await call('cloud_apply_event', ['alipay', 'sandbox', JSON.stringify({ event_id: randomUUID(), kind: 'payment', action_id: randomUUID(), order_id: order.id,
        occurred_at: new Date().toISOString(), currency: 'CNY', base_amount_cents: 2900, amount_cents: 2900 })]);
    }
    await call('leaderboard_rollup_daily_replace_v2', ['2026-01-02Z', '2026-01-03Z']);
    const moneyBefore = (await isolated.query('SELECT to_jsonb(p) row FROM tokentracker_cloud_payments p ORDER BY id')).rows;
    const ordersBefore = (await isolated.query('SELECT to_jsonb(p) row FROM tokentracker_cloud_orders p ORDER BY id')).rows;
    const eventBefore = (await isolated.query('SELECT to_jsonb(p) row FROM tokentracker_cloud_events p ORDER BY event_id')).rows;
    const otherSnapshots = (await isolated.query('SELECT to_jsonb(p) row FROM tokentracker_leaderboard_snapshots p WHERE user_id=$1', [other])).rows;
    const erasePlan = await call('cloud_usage_maintenance_plan', ['erase-user', id, null, null, null, 10]);
    assert.deepEqual(erasePlan.targets[0].derived_rows, { tokentracker_leaderboard_snapshots: 1,
      agentmeter_leaderboard_snapshots: 1, tokentracker_leaderboard_rollup_daily: 1, agentmeter_hourly: 1 });
    await assert.rejects(call('cloud_erase_user_usage', [randomUUID(), id, other]), /confirmation/);
    const op = randomUUID();
    await isolated.exec(`CREATE FUNCTION archive_test_erase_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'isolated erase failure'; END $$;
      CREATE TRIGGER archive_test_erase_failure BEFORE DELETE ON tokentracker_leaderboard_rollup_daily_v2
        FOR EACH ROW EXECUTE FUNCTION archive_test_erase_failure();`);
    await assert.rejects(call('cloud_erase_user_usage', [op, id, id]), /isolated erase failure/);
    await isolated.exec('DROP TRIGGER archive_test_erase_failure ON tokentracker_leaderboard_rollup_daily_v2; DROP FUNCTION archive_test_erase_failure();');
    assert.equal((await isolated.query('SELECT count(*)::integer n FROM tokentracker_usage_archive_manifest WHERE user_id=$1', [id])).rows[0].n, 1);
    assert.equal((await isolated.query('SELECT revoked_at FROM tokentracker_device_tokens WHERE token_hash=$1', [tokens[0]])).rows[0].revoked_at, null);
    assert.equal((await call('cloud_erase_user_usage', [op, id, id])).financial_records_preserved, true);
    assert.equal((await call('cloud_erase_user_usage', [op, id, id])).replayed, true);
    assert.equal((await isolated.query('SELECT count(*)::integer n FROM cloud_usage_hourly($1,NULL,NULL,NULL)', [id])).rows[0].n, 0);
    assert.equal((await isolated.query('SELECT sum(total_tokens)::integer n FROM tokentracker_leaderboard_rollup_total_v2 WHERE user_id=$1', [other])).rows[0].n, 100);
    assert.equal((await isolated.query('SELECT count(*)::integer n FROM cloud_usage_hourly($1,NULL,NULL,NULL)', [other])).rows[0].n, 1);
    assert.equal((await isolated.query('SELECT count(*)::integer n FROM auth.users')).rows[0].n, 2);
    for (const table of ['tokentracker_leaderboard_snapshots','agentmeter_leaderboard_snapshots','tokentracker_leaderboard_rollup_daily','agentmeter_hourly']) {
      assert.equal((await isolated.query(`SELECT count(*)::integer n FROM ${table} WHERE user_id=$1`, [id])).rows[0].n, 0);
      assert.equal((await isolated.query(`SELECT count(*)::integer n FROM ${table} WHERE user_id=$1`, [other])).rows[0].n, 1);
    }
    assert.deepEqual((await isolated.query('SELECT to_jsonb(p) row FROM tokentracker_leaderboard_snapshots p WHERE user_id=$1', [other])).rows, otherSnapshots);
    assert.deepEqual((await isolated.query('SELECT to_jsonb(p) row FROM tokentracker_cloud_payments p ORDER BY id')).rows, moneyBefore);
    assert.deepEqual((await isolated.query('SELECT to_jsonb(p) row FROM tokentracker_cloud_orders p ORDER BY id')).rows, ordersBefore);
    assert.deepEqual((await isolated.query('SELECT to_jsonb(p) row FROM tokentracker_cloud_events p ORDER BY event_id')).rows, eventBefore);
    const rejected = await call('cloud_ingest_usage', [tokens[0], 'sandbox', JSON.stringify([{ hour_start: '2026-01-02Z', source: 'codex', model: 'gpt-6', total_tokens: 1 }]), '[]', randomUUID()]);
    assert.equal(rejected.code, 'cloud_device_token_rejected');
    // A later explicit new write must survive an old erasure checkpoint replay.
    const newDev = randomUUID();
    await isolated.query("INSERT INTO tokentracker_devices(id,user_id,device_name,platform,machine_id) VALUES($1,$2,'New explicit device','web',$3)", [newDev, id, randomUUID()]);
    await isolated.query(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,
      cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,billable_total_tokens,
      conversations,total_cost_usd) VALUES($1,$2,'codex','gpt-6','2026-01-03Z',20,0,0,0,0,20,20,1,0)`, [id, newDev]);
    assert.equal((await call('cloud_erase_user_usage', [op, id, id])).replayed, true);
    assert.equal((await isolated.query('SELECT total_tokens::integer n FROM cloud_usage_hourly($1,NULL,NULL,NULL)', [id])).rows[0].n, 20);
  } finally { await isolated.close(); }
});
