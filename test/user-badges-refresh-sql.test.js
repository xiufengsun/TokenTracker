const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, before, after, beforeEach } = require("node:test");
const { PGlite } = require("@electric-sql/pglite");

let db;
const userId = "00000000-0000-4000-8000-000000000001";
before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin BYPASSRLS;
    CREATE TABLE tokentracker_leaderboard_rollup_meta_v2 (id int PRIMARY KEY, through timestamptz);
    CREATE TABLE tokentracker_leaderboard_rollup_daily_v2
      (user_id uuid, source text, model text, day date, total_tokens bigint, output_tokens bigint);
    CREATE TABLE test_live_tail
      (user_id uuid, source text, model text, hour_start timestamptz, total_tokens bigint, output_tokens bigint);
    CREATE FUNCTION leaderboard_hourly_dedup_v2(p_from timestamptz, p_to timestamptz)
      RETURNS SETOF test_live_tail LANGUAGE sql STABLE AS $$
      SELECT * FROM test_live_tail WHERE hour_start >= p_from AND hour_start < p_to $$;
    CREATE TABLE tokentracker_leaderboard_snapshots (user_id uuid, period text, to_day date, rank int);
    CREATE TABLE tokentracker_leaderboard_refresh_lock (period text PRIMARY KEY, last_attempt_at timestamptz);
    CREATE FUNCTION leaderboard_refresh_try_claim(p_period text, p_min_interval_s int) RETURNS boolean
      LANGUAGE sql AS $$
      INSERT INTO tokentracker_leaderboard_refresh_lock VALUES (p_period, now())
      ON CONFLICT (period) DO UPDATE SET last_attempt_at = now()
        WHERE tokentracker_leaderboard_refresh_lock.last_attempt_at < now() - make_interval(secs => p_min_interval_s)
      RETURNING true $$;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO project_admin;
  `);
  await db.exec(fs.readFileSync(path.join(__dirname, "../scripts/ops/user-badges.sql"), "utf8"));
  // Exercise a real upgrade as well as the canonical bootstrap. No legacy
  // rollup tables exist: any accidental v1 dependency fails at execution.
  await db.exec("CREATE OR REPLACE FUNCTION user_badges_refresh() RETURNS bigint LANGUAGE sql AS $$SELECT -1::bigint$$");
  await db.exec(fs.readFileSync(path.join(__dirname,
    "../migrations/20261012120001_refresh-badges-from-maintained-rollup.sql"), "utf8"));
});
after(async () => db?.close());
beforeEach(async () => {
  await db.exec(`TRUNCATE tokentracker_user_badges, tokentracker_leaderboard_rollup_meta_v2,
    tokentracker_leaderboard_rollup_daily_v2, test_live_tail, tokentracker_leaderboard_refresh_lock;
    INSERT INTO tokentracker_leaderboard_rollup_meta_v2 VALUES (1, date_trunc('day', now()) - interval '1 day');
    INSERT INTO tokentracker_leaderboard_rollup_daily_v2 VALUES
      ('${userId}', 'codex', 'gpt', current_date - 2, 100000000, 5000000),
      ('${userId}', 'codex', 'gpt', current_date - 1, 9000000000, 9000000000);
    INSERT INTO test_live_tail VALUES
      ('${userId}', 'codex', 'gpt', date_trunc('day', now()) - interval '1 day', 20000000, 2000000),
      ('${userId}', 'codex', 'gpt', date_trunc('day', now()) - interval '25 hours', 9000000000, 9000000000),
      ('${userId}', 'codex', 'gpt', now() + interval '1 hour', 9000000000, 9000000000);
  `);
});
async function refresh() {
  return (await db.query("SELECT user_badges_refresh() AS result")).rows[0].result;
}
async function badge(id) {
  return (await db.query("SELECT * FROM tokentracker_user_badges WHERE user_id=$1 AND badge_id=$2", [userId, id])).rows[0];
}

test("refresh as project_admin combines maintained history and live tail exactly once", async () => {
  await db.exec("SET ROLE project_admin");
  try { assert.ok(Number(await refresh()) > 0); } finally { await db.exec("RESET ROLE"); }
  assert.equal(Number((await badge("token_titan")).metric_value), 120000000);
  assert.equal(Number((await badge("wordsmith")).metric_value), 7000000);
  assert.equal(Number((await badge("big_day")).metric_value), 100000000);
  assert.equal(Number((await badge("marathoner")).metric_value), 2);
  assert.equal(Number((await badge("streak")).metric_value), 2);
  assert.equal(Number((await badge("veteran")).metric_value), 2);
  const first = await badge("token_titan");
  assert.equal(first.tier, 1);
  assert.ok(first.bronze_at);
  assert.ok(first.bronze_no);
  assert.equal(Number(await refresh()), 0, "second invoke must honor the existing shared claim");
  assert.deepEqual(await badge("token_titan"), first);
});

test("recompute preserves earned tiers, first timestamps and serials when corrected usage shrinks", async () => {
  await refresh();
  const first = await badge("token_titan");
  await db.exec(`UPDATE tokentracker_leaderboard_rollup_daily_v2 SET total_tokens=total_tokens/10;
    UPDATE test_live_tail SET total_tokens=total_tokens/10;
    UPDATE tokentracker_leaderboard_refresh_lock SET last_attempt_at=now()-interval '301 seconds'`);
  assert.ok(Number(await refresh()) > 0);
  const next = await badge("token_titan");
  assert.equal(Number(next.metric_value), 12000000);
  assert.equal(next.tier, first.tier);
  assert.deepEqual(next.bronze_at, first.bronze_at);
  assert.equal(next.bronze_no, first.bronze_no);
});

test("missing watermark fails and rolls back the claim instead of scanning unbounded raw history", async () => {
  await db.exec("DELETE FROM tokentracker_leaderboard_rollup_meta_v2");
  await assert.rejects(refresh(), /rollup is not initialized/);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM tokentracker_user_badges")).rows[0].n, 0);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM tokentracker_leaderboard_refresh_lock")).rows[0].n, 0);
});

test("anon and authenticated roles cannot execute the migrated refresh", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    try { await assert.rejects(refresh(), /permission denied for function user_badges_refresh/); }
    finally { await db.exec("RESET ROLE"); }
  }
});
