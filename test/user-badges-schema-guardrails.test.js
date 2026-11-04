// Text-level invariants for scripts/ops/user-badges.sql — the badge storage
// and compute migration. These are load-bearing semantics; if any assertion
// fails, the edit likely broke monotonic tiers, first-achieved timestamps,
// momentum adjacency, or the deny-all security posture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const SQL_PATH = path.join(__dirname, "..", "scripts", "ops", "user-badges.sql");
const MIGRATION_PATH = path.join(
  __dirname,
  "..",
  "migrations",
  "20260714081616_add-achievement-issue-numbers.sql",
);
const sql = fs.readFileSync(SQL_PATH, "utf8");
const issueNumberMigration = fs.readFileSync(MIGRATION_PATH, "utf8");

const BADGE_IDS = [
  "token_titan",
  "big_day",
  "wordsmith",
  "marathoner",
  "streak",
  "weekend_warrior",
  "momentum",
  "polyglot",
  "trendsetter",
  "multitool",
  "podium",
  "veteran",
];

test("both tables enable RLS with deny-all grants", () => {
  for (const table of ["tokentracker_badge_catalog", "tokentracker_user_badges"]) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`REVOKE ALL ON public\\.${table}\\s+FROM anon, authenticated, PUBLIC`));
    assert.match(sql, new RegExp(`GRANT ALL ON public\\.${table}\\s+TO project_admin`));
  }
  // No permissive policies may sneak in — zero-policy RLS is the security model.
  assert.doesNotMatch(sql, /CREATE POLICY/i);
});

test("read RPCs are revoked from public and granted to project_admin only", () => {
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.user_badges_compact\(uuid\[\]\) FROM anon, authenticated, PUBLIC/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.user_badges_full\(uuid, boolean\) FROM anon, authenticated, PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.user_badges_compact\(uuid\[\]\) TO project_admin/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.user_badges_full\(uuid, boolean\) TO project_admin/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.user_badges_refresh\(\) FROM anon, authenticated, PUBLIC/);
});

test("tier upsert is monotonic and timestamps are set-once", () => {
  // Tier only ratchets up.
  assert.match(sql, /tier = GREATEST\(ub\.tier, EXCLUDED\.tier\)/);
  // First-achieved timestamps never overwritten.
  for (const col of ["bronze_at", "silver_at", "gold_at", "diamond_at"]) {
    assert.match(sql, new RegExp(`${col}\\s*=\\s*COALESCE\\(ub\\.${col},\\s*EXCLUDED\\.${col}\\)`));
  }
  // podium (lower_is_better) keeps the best-ever value via LEAST.
  assert.match(sql, /LEAST\(ub\.metric_value, EXCLUDED\.metric_value\)/);
});

test("tier acquisition numbers are stable, unique, and assigned safely", () => {
  for (const source of [sql, issueNumberMigration]) {
    for (const tier of ["bronze", "silver", "gold", "diamond"]) {
      assert.match(source, new RegExp(`ADD COLUMN IF NOT EXISTS ${tier}_no\\s+bigint`));
      assert.match(
        source,
        new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS tokentracker_user_badges_${tier}_no_uq`),
      );
      assert.match(source, new RegExp(`ORDER BY b\\.${tier}_at, b\\.user_id`));
      assert.match(source, new RegExp(`'${tier}', b\\.${tier}_no`));
    }
    assert.match(source, /pg_advisory_xact_lock/);
    assert.match(source, /pg_trigger_depth\(\) > 1/);
    assert.match(source, /BEFORE INSERT OR UPDATE ON public\.tokentracker_user_badges/);
    assert.match(source, /AFTER INSERT OR UPDATE ON public\.tokentracker_user_badges/);
    assert.match(
      source,
      /REVOKE EXECUTE ON FUNCTION public\.user_badges_assign_serials\(\) FROM anon, authenticated, PUBLIC/,
    );
    assert.match(
      source,
      /REVOKE EXECUTE ON FUNCTION public\.user_badges_assign_serials_trigger\(\) FROM anon, authenticated, PUBLIC/,
    );
  }
});

test("momentum compares ADJACENT ISO weeks with a prior-week floor", () => {
  // LAG alone returns the previous ACTIVE week (possibly months earlier);
  // the wk - 7 equality is what makes the ratio week-over-week.
  assert.match(sql, /prev_wk = wk - 7/);
  assert.match(sql, /prev_wtok >= 10000000/);
});

test("refresh claims the shared lock and reads the rollup + live tail", () => {
  assert.match(sql, /leaderboard_refresh_try_claim\('badges', 300\)/);
  assert.match(sql, /tokentracker_leaderboard_rollup_meta_v2/);
  assert.match(sql, /tokentracker_leaderboard_rollup_daily_v2/);
  assert.match(sql, /leaderboard_hourly_dedup_v2\(v_through, now\(\)\)/);
  assert.match(sql, /WHERE r\.day < \(v_through AT TIME ZONE 'UTC'\)::date/);
  assert.match(sql, /RAISE EXCEPTION 'leaderboard v2 rollup is not initialized'/);
  assert.doesNotMatch(sql, /FROM (?:public\.)?tokentracker_leaderboard_rollup_(?:meta|daily)\s/);
  assert.doesNotMatch(sql, /FROM (?:public\.)?leaderboard_hourly_dedup\(/);
});

test("maintained-rollup migration matches the canonical refresh and stays privileged", () => {
  const migration = fs.readFileSync(path.join(__dirname,
    "../migrations/20261012120001_refresh-badges-from-maintained-rollup.sql"), "utf8");
  const refresh = /CREATE OR REPLACE FUNCTION public\.user_badges_refresh\(\)[\s\S]*?\$func\$;/;
  assert.equal(migration.match(refresh)?.[0], sql.match(refresh)?.[0]);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION public\.user_badges_refresh\(\) FROM anon, authenticated, PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.user_badges_refresh\(\) TO project_admin/);
  assert.match(migration, /SET work_mem TO '48MB'/);
  assert.match(migration, /SET max_parallel_workers_per_gather TO '0'/);
});

test("catalog seeds exactly the twelve cloud badges with 4-tier thresholds", () => {
  for (const id of BADGE_IDS) {
    assert.match(sql, new RegExp(`\\('${id}',`), `missing catalog seed for ${id}`);
  }
  // Spot-check threshold literals (single source of truth lives HERE).
  assert.match(sql, /100000000, 1000000000, 10000000000, 100000000000/); // token_titan
  assert.match(sql, /'podium',\s*11,\s*true,\s*100, 30, 10, 3/); // podium lower_is_better
  assert.match(sql, /'streak',\s*5,\s*false,\s*3, 7, 30, 100/);
  // 2026-07-14 recalibration values (see the seed comment in the SQL).
  assert.match(sql, /'momentum',\s*7,\s*false,\s*2, 6, 15, 40/);
  assert.match(sql, /'polyglot',\s*8,\s*false,\s*5, 15, 30, 60/);
  assert.match(sql, /'big_day',\s*2,\s*false,\s*10000000, 100000000, 500000000, 3000000000/);
  assert.match(sql, /'wordsmith',\s*3,\s*false,\s*5000000, 25000000, 100000000, 300000000/);
  assert.match(sql, /'weekend_warrior',\s*6,\s*false,\s*5, 20, 50, 100/);
  assert.match(sql, /'trendsetter',\s*9,\s*false,\s*2, 5, 10, 20/);
});

test("trendsetter guards against self-debuting models and dataset burn-in", () => {
  // Private/BYO model strings self-debut with their only user — the >=5
  // distinct-user floor keeps them from auto-qualifying.
  assert.match(sql, /COUNT\(DISTINCT user_id\) >= 5/);
  // At data start every model "debuts" at once — 30-day burn-in excludes them.
  assert.match(sql, /MIN\(day\) >= \(SELECT MIN\(day\) \+ 30 FROM usm\)/);
  // Early adoption window: first touch within 7 days of the global debut.
  assert.match(sql, /uf\.first_day <= d\.debut \+ 7/);
});

test("wordsmith/weekend_warrior facts come from output tokens and UTC weekend days", () => {
  // wordsmith must aggregate output_tokens (cache replay can't inflate it).
  assert.match(sql, /\('wordsmith',\s*f\.output_tokens::numeric/);
  // weekend days counted on the UTC day bucket via ISO day-of-week.
  assert.match(sql, /EXTRACT\(isodow FROM day\) IN \(6, 7\)/);
  assert.match(sql, /\('weekend_warrior',\s*f\.weekend_days::numeric/);
});
