'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { setup: setupArchive } = require('./helpers/cloud-usage-archive-fixture');

const read = (name) => fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8');
const clusterSql = read('20260804043427_align-leaderboard-machine-clusters.sql');
const sessionSql = read('20260817120000_account-session-states.sql');
const totalSql = read('20260904064000_cache-leaderboard-total-rollup.sql');
const migration = read('20261104165655_skip-empty-leaderboard-repair-spans.sql');
const USER = '00000000-0000-0000-0000-000000000001';
const DEVICE = '00000000-0000-0000-0000-000000000002';
const OTHER_USER = '00000000-0000-0000-0000-000000000003';

function functionSql(sql, name) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0);
  return sql.slice(start, sql.indexOf('$func$;', start) + '$func$;'.length);
}

// Execute the actual scheduler, dedup, daily replacement and total-rollup
// triggers. Only the base tables are fixtures; no JS mirror of the algorithm.
test('sparse historical leaderboard repair executes in PostgreSQL', { skip: process.platform === 'win32' }, async (t) => {
  const db = new PGlite();
  const query = async (sql, params) => (await db.query(sql, params)).rows;
  const exec = (sql) => db.exec(sql);
  const advance = () => exec('SELECT public.leaderboard_rollup_daily_advance_v2()');
  const midnight = "date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
  const counters = ['total_tokens', 'input_tokens', 'output_tokens', 'cached_input_tokens',
    'cache_creation_input_tokens', 'reasoning_output_tokens'].map(c => `${c} bigint NOT NULL DEFAULT 0`).join(',');
  const seedHourly = (date, tokens, source = 'codex') => query(`
    INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,total_tokens)
    VALUES($1,$2,$3,'model-a',$4,$5)`, [USER, DEVICE, source, date, tokens]);
  const seedRollup = (date, tokens, source = 'codex', user = USER) => query(`
    INSERT INTO tokentracker_leaderboard_rollup_daily_v2(user_id,source,model,day,total_tokens)
    VALUES($1,$2,'model-a',$3,$4)`, [user, source, date, tokens]);
  const seedSession = (date, tokens, user = USER) => query(`
    INSERT INTO tokentracker_account_session_states(user_id,source,model,bucket_start,total_tokens)
    VALUES($1,'trae-cn','model-a',$2,$3)`, [user, date, tokens]);
  const totals = () => query(`SELECT source, SUM(total_tokens)::text AS tokens
    FROM tokentracker_leaderboard_rollup_total_v2 GROUP BY source ORDER BY source`);
  const reset = async (cursor = '1970-01-08') => {
    await exec(`TRUNCATE tokentracker_hourly, tokentracker_account_session_states,
      tokentracker_leaderboard_rollup_daily_v2, tokentracker_leaderboard_rollup_total_v2,
      tokentracker_leaderboard_rollup_meta_v2;
      UPDATE tokentracker_devices SET revoked_at = NULL;`);
    await query(`INSERT INTO tokentracker_leaderboard_rollup_meta_v2(id,through,repair_from)
      VALUES(1,${midnight},$1)`, [cursor]);
  };
  try {
    await exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin;
      SET TIME ZONE 'Asia/Singapore';
      CREATE TABLE tokentracker_devices(id uuid PRIMARY KEY, revoked_at timestamptz);
      INSERT INTO tokentracker_devices VALUES('${DEVICE}',NULL);
      CREATE TABLE tokentracker_device_machine(device_id uuid, machine_cluster_id text);
      CREATE TABLE tokentracker_hourly(user_id uuid,device_id uuid,source text,model text,
        hour_start timestamptz,updated_at timestamptz DEFAULT now(),${counters});
      CREATE TABLE tokentracker_account_session_states(user_id uuid,source text,model text,
        bucket_start timestamptz,${counters});`);
    await exec(clusterSql.slice(0, clusterSql.indexOf('CREATE OR REPLACE FUNCTION')));
    await exec(functionSql(sessionSql, 'leaderboard_hourly_dedup_v2'));
    await exec(functionSql(clusterSql, 'leaderboard_rollup_daily_replace_v2'));
    await exec(`ALTER TABLE tokentracker_leaderboard_rollup_daily_v2
      ADD COLUMN pricing_tier text NOT NULL DEFAULT 'standard'`);
    await db.transaction(tx => tx.exec(totalSql.slice(0, totalSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.leaderboard_usage_grouped('))));

    await t.test('reproduces the old scheduler walking empty 1970 weeks with a fresh watermark', async () => {
      await exec(functionSql(sessionSql, 'leaderboard_rollup_daily_advance_v2'));
      await reset('1970-01-29');
      await seedHourly('1970-01-01T00:00:00Z', 60, 'omp');
      await seedHourly('2026-10-01T00:00:00Z', 200);
      await seedRollup('2026-10-01', 100);
      await advance();
      assert.equal((await query('SELECT repair_from::text AS day FROM tokentracker_leaderboard_rollup_meta_v2'))[0].day, '1970-02-05');
      assert.deepEqual(await totals(), [{ source: 'codex', tokens: '100' }]);
      await exec(migration);
      await advance();
      assert.deepEqual(await totals(), [{ source: 'codex', tokens: '200' }]);
      // Wrap without dropping the legitimate old bucket; repeated repairs are idempotent.
      await advance();
      await advance();
      assert.deepEqual(await totals(), [{ source: 'codex', tokens: '200' }, { source: 'omp', tokens: '60' }]);
    });

    await t.test('rebuilds rollup-only days after a deletion, including a date older than raw history', async () => {
      await reset();
      await seedRollup('1969-12-01', 500);
      await seedHourly('2026-10-01T00:00:00Z', 200);
      await advance();
      await advance(); // wraps to the rollup-only date, not MIN(hourly)
      assert.deepEqual(await totals(), [{ source: 'codex', tokens: '200' }]);
    });

    await t.test('removes history from revoked devices and reflects downward/model corrections', async () => {
      await reset();
      await seedHourly('2026-10-01T00:00:00Z', 60);
      await seedRollup('2026-10-01', 100);
      await advance();
      assert.deepEqual(await totals(), [{ source: 'codex', tokens: '60' }]);
      await exec("UPDATE tokentracker_hourly SET model = 'model-b'");
      await advance();
      assert.deepEqual(await query('SELECT model,total_tokens::text AS tokens FROM tokentracker_leaderboard_rollup_total_v2'),
        [{ model: 'model-b', tokens: '60' }]);
      await exec('UPDATE tokentracker_devices SET revoked_at = now()');
      await advance();
      assert.deepEqual(await totals(), []);
    });

    await t.test('repairs both sides of a session bucket move across a large empty span', async () => {
      await reset();
      await seedRollup('2000-01-01', 80, 'trae-cn');
      await seedSession('2026-10-01T00:00:00Z', 80);
      await advance(); // first-seed priority repairs the new location
      await advance(); // wrap discovers the obsolete rollup, without raw usage
      assert.deepEqual(await totals(), [{ source: 'trae-cn', tokens: '80' }]);
      assert.equal((await query('SELECT day::text FROM tokentracker_leaderboard_rollup_daily_v2'))[0].day, '2026-10-01');
    });

    await t.test('keeps first-seed priority per user while accounting for session-only history', async () => {
      await reset('1970-01-01');
      await seedHourly('1970-01-01T00:00:00Z', 60, 'omp');
      await seedSession('2026-10-01T00:00:00Z', 80);
      await seedSession('2026-10-01T00:00:00Z', 120, OTHER_USER);
      await seedRollup('2026-10-01', 120, 'trae-cn', OTHER_USER);
      await advance();
      assert.deepEqual(await totals(), [{ source: 'trae-cn', tokens: '200' }]);
    });

    await t.test('bootstraps session-only data and bounds dense work to seven closed UTC days', async () => {
      await reset();
      await exec('DELETE FROM tokentracker_leaderboard_rollup_meta_v2');
      for (let day = 1; day <= 8; day++) await seedSession(`2026-10-${String(day).padStart(2, '0')}T23:30:00Z`, 10);
      await advance();
      assert.deepEqual(await totals(), [{ source: 'trae-cn', tokens: '70' }]);
      assert.equal((await query("SELECT (through AT TIME ZONE 'UTC')::date::text AS day FROM tokentracker_leaderboard_rollup_meta_v2"))[0].day, '2026-10-08');
      await advance();
      assert.deepEqual(await totals(), [{ source: 'trae-cn', tokens: '80' }]);
      await advance(); // no occupied day remains: catch up across the empty tail
      assert.equal((await query(`SELECT through = ${midnight} AS caught_up FROM tokentracker_leaderboard_rollup_meta_v2`))[0].caught_up, true);
    });

    await t.test('catch-up skips decades of empty dates without changing the live-day boundary', async () => {
      await reset();
      await seedHourly('1970-01-01T00:00:00Z', 60, 'omp');
      await seedHourly('2026-10-01T00:00:00Z', 200);
      await exec("UPDATE tokentracker_leaderboard_rollup_meta_v2 SET through='1970-01-08T00:00:00Z'");
      await advance();
      assert.deepEqual(await totals(), [{ source: 'codex', tokens: '200' }]);
      assert.equal((await query("SELECT (through AT TIME ZONE 'UTC')::date::text AS day FROM tokentracker_leaderboard_rollup_meta_v2"))[0].day, '2026-10-08');
    });

    await t.test('empty database and open/future buckets never materialize a closed-day total', async () => {
      await reset();
      await exec('DELETE FROM tokentracker_leaderboard_rollup_meta_v2');
      await advance();
      await query(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,total_tokens)
        VALUES($1,$2,'codex','model-a',${midnight},100),($1,$2,'codex','model-a',now()+interval '2 days',200)`, [USER, DEVICE]);
      await advance();
      assert.deepEqual(await totals(), []);
      assert.equal((await query(`SELECT through = ${midnight} AS caught_up FROM tokentracker_leaderboard_rollup_meta_v2`))[0].caught_up, true);
    });

    await t.test('the helper is not callable by public API roles', async () => {
      const rows = await query(`SELECT role, has_function_privilege(role,
        'public.leaderboard_rollup_next_day_v2(timestamptz,timestamptz)', 'EXECUTE') AS allowed
        FROM unnest(ARRAY['anon','authenticated','project_admin']) role`);
      assert.deepEqual(rows, [{ role: 'anon', allowed: false }, { role: 'authenticated', allowed: false },
        { role: 'project_admin', allowed: true }]);
    });
  } finally {
    await db.close();
  }
});

for (const archiveFirst of [true, false]) {
  test(`sparse repair composes with archive migration (${archiveFirst ? 'archive first' : 'archive last'})`,
    { skip: process.platform === 'win32' }, async (t) => {
      const db = await setupArchive();
      const query = async (sql, params) => (await db.query(sql, params)).rows;
      const advance = () => db.exec('SELECT public.leaderboard_rollup_daily_advance_v2()');
      const total = async () => (await query(`SELECT COALESCE(sum(total_tokens),0)::text AS tokens
        FROM tokentracker_leaderboard_rollup_total_v2 WHERE user_id=$1`, [USER]))[0].tokens;
      const archive = () => db.exec(`SELECT public.cloud_commit_usage_archive(
        public.cloud_prepare_usage_archive('${USER}','${DEVICE}','2026-01-02'))`);
      try {
        const archiveSql = read('20261005120000_cloud-usage-archive.sql');
        for (const sql of archiveFirst ? [archiveSql, migration] : [migration, archiveSql]) {
          await db.transaction(tx => tx.exec(sql));
          if (!archiveFirst && sql === migration) {
            // Exercise the optional hooks before archive objects exist, then
            // verify this same connection discovers them after installation.
            await advance();
            await db.exec('DELETE FROM tokentracker_leaderboard_rollup_meta_v2');
          }
        }
        await db.exec(`SET TIME ZONE 'Asia/Singapore';
          INSERT INTO auth.users VALUES('${USER}');
          INSERT INTO tokentracker_devices(id,user_id) VALUES('${DEVICE}','${USER}');
          INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,
            input_tokens,cached_input_tokens,cache_creation_input_tokens,output_tokens,
            reasoning_output_tokens,total_tokens,conversations)
          VALUES('${USER}','${DEVICE}','codex','model-a','2026-01-02T23:30:00Z',100,0,0,0,0,100,1);`);
        await archive();

        await t.test('cold-only bootstrap finds manifests even without a dirty-day hint', async () => {
          await db.exec('TRUNCATE tokentracker_usage_dirty_days');
          assert.equal((await query('SELECT count(*)::integer AS n FROM tokentracker_hourly'))[0].n, 0);
          assert.equal(await total(), '0');
          assert.equal((await query(`SELECT public.leaderboard_rollup_next_day_v2(
            '1970-01-01Z','2026-01-03Z')::text AS day`))[0].day, '2026-01-02');
          assert.equal((await query(`SELECT public.leaderboard_rollup_next_day_v2(
            '1970-01-01Z','2026-01-02Z')::text AS day`))[0].day, null);
          await advance();
          assert.equal(await total(), '100');
          for (let i = 0; i < 3; i++) await advance();
          assert.equal(await total(), '100');
        });

        await t.test('cyclic repair recovers a missing cold-only rollup across empty decades', async () => {
          await db.exec(`DELETE FROM tokentracker_leaderboard_rollup_daily_v2;
            UPDATE tokentracker_leaderboard_rollup_meta_v2
            SET through=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
                repair_from='1970-01-08';`);
          assert.equal(await total(), '0');
          await advance();
          assert.equal(await total(), '100');
        });

        await t.test('advance drains archive dirty days before the catch-up early return', async () => {
          // Rehydrate, correct downward, then compact again: only cold truth remains.
          await db.exec(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,
            input_tokens,cached_input_tokens,cache_creation_input_tokens,output_tokens,
            reasoning_output_tokens,total_tokens,conversations)
            VALUES('${USER}','${DEVICE}','codex','model-a','2026-01-02T23:30:00Z',40,0,0,0,0,40,1);`);
          await archive();
          assert.equal(await total(), '100');
          assert.equal((await query('SELECT count(*)::integer AS n FROM tokentracker_usage_dirty_days'))[0].n, 1);
          // Catch-up has no occupied dates left, so only the dirty-day hook can repair January.
          await db.exec(`UPDATE tokentracker_leaderboard_rollup_meta_v2
            SET through='2026-02-01Z',repair_from='2026-02-01';`);
          await advance();
          assert.equal(await total(), '40');
          assert.equal((await query('SELECT count(*)::integer AS n FROM tokentracker_usage_dirty_days'))[0].n, 0);
          await advance();
          assert.equal(await total(), '40');
        });
      } finally {
        await db.close();
      }
    });
}

test('archive installation rejects sparse schedulers missing either archive hook',
  { skip: process.platform === 'win32' }, async () => {
    const db = await setupArchive();
    try {
      await db.exec(migration);
      const definition = (await db.query(`SELECT pg_get_functiondef(
        'public.leaderboard_rollup_daily_advance_v2()'::regprocedure) AS sql`)).rows[0].sql;
      const invalidShapes = [
        [definition.replace('    PERFORM public.cloud_repair_usage_days(7);', '    NULL;'),
          /Rollup advance SQL shape drift/],
        [`CREATE OR REPLACE FUNCTION public.leaderboard_rollup_next_day_v2(
          p_from timestamptz,p_to timestamptz) RETURNS date LANGUAGE sql STABLE
          AS $$ SELECT NULL::date $$`, /Rollup occupied-day SQL shape drift/],
      ];
      for (const [sql, error] of invalidShapes) {
        await assert.rejects(db.transaction(async tx => {
          await tx.exec(sql);
          await tx.exec(read('20261005120000_cloud-usage-archive.sql'));
        }), error);
        assert.equal((await db.query(`SELECT to_regclass(
          'public.tokentracker_usage_archive_manifest')::text AS name`)).rows[0].name, null);
      }
    } finally {
      await db.close();
    }
  });
