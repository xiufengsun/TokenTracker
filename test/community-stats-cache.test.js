const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("community stats endpoint reads a precomputed snapshot instead of scanning all usage", () => {
  const source = read("dashboard/edge-patches/tokentracker-community-models.ts");

  assert.match(source, /from\("tokentracker_community_stats"\)/);
  assert.doesNotMatch(source, /leaderboard_usage_grouped/);
  assert.match(source, /max-age=300/);
  assert.match(source, /stale-while-revalidate=86400/);
  for (const field of [
    "provider_breakdown",
    "daily_growth",
    "token_mix",
    "user_distribution",
    "platform_distribution",
    "active_developers_30d",
    "tokens_30d",
  ]) {
    assert.match(source, new RegExp(field));
  }
});

test("community stats refresh aggregates the daily rollup plus a live tail", () => {
  const migration = read("migrations/20260716113500_add-community-stats-refresh.sql");
  const schedule = read("scripts/ops/community-stats-refresh-cron.sql");

  assert.match(migration, /tokentracker_leaderboard_rollup_daily/);
  assert.match(migration, /leaderboard_hourly_dedup\(v_through, v_to\)/);
  assert.doesNotMatch(migration, /BLOCKED_LEADERBOARD_USER_IDS/);
  assert.match(schedule, /tokentracker-community-stats-refresh/);
  assert.match(schedule, /17 \* \* \* \*/);
});

test("community stats refresh reads the v2 rollup and drops anti-cheat excluded accounts", () => {
  const migration = read("migrations/20260923093000_community-stats-v2-rollup-exclusions.sql");

  assert.match(migration, /FROM public\.tokentracker_leaderboard_rollup_meta_v2 m/);
  assert.match(migration, /FROM public\.tokentracker_leaderboard_rollup_daily_v2 r\s+WHERE r\.day < \(v_cut AT TIME ZONE 'UTC'\)::date/);
  assert.match(migration, /leaderboard_hourly_dedup_v2\(v_cut, v_to\)/);
  // The v1 rollup froze at 2026-08-14; reading it forces weeks of live dedup.
  assert.doesNotMatch(migration, /tokentracker_leaderboard_rollup_daily r\b/);
  assert.doesNotMatch(migration, /leaderboard_hourly_dedup\(/);
  assert.match(migration, /f\.status IN \('auto_excluded', 'banned'\)/);
  assert.match(migration, /NOT EXISTS \(\s*SELECT 1 FROM excluded_users e WHERE e\.user_id = p\.user_id\s*\)/);
});

test("community stats cache table is server-only and singleton keyed", () => {
  const migration = read("migrations/20260716110044_add-community-stats-cache.sql");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.tokentracker_community_stats/i);
  assert.match(migration, /id\s+text\s+PRIMARY KEY/i);
  assert.match(migration, /CHECK\s*\(id = 'total'\)/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /REVOKE ALL ON TABLE public\.tokentracker_community_stats FROM anon, authenticated, PUBLIC/i);
});

test("community insights refresh exposes useful aggregates without adding location tracking", () => {
  const migration = read("migrations/20260718075000_expand-community-insights.sql");

  assert.match(migration, /provider_breakdown jsonb/i);
  assert.match(migration, /daily_growth jsonb/i);
  assert.match(migration, /token_mix jsonb/i);
  assert.match(migration, /user_distribution jsonb/i);
  assert.match(migration, /platform_distribution jsonb/i);
  assert.match(migration, /tokentracker_leaderboard_rollup_daily/);
  assert.match(migration, /leaderboard_hourly_dedup\(v_through, v_to\)/);
  assert.match(migration, /DISTINCT ON \(td\.machine_hash\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.refresh_tokentracker_community_stats\(\)/i);
  assert.doesNotMatch(migration, /\bcountry\b|ip_address|geo_/i);
});

test("community insights frontend reuses the dashboard trend chart and caps rankings at ten", () => {
  const source = read("dashboard/src/components/leaderboard/CommunityStatsModal.jsx");

  // The overview chart is the shared TrendMonitor (tooltip included), not a
  // bespoke SVG chart local to this modal.
  assert.match(source, /from "\.\.\/\.\.\/ui\/dashboard\/components\/TrendMonitor"/);
  assert.doesNotMatch(source, /tokens_7d_avg/);
  assert.match(source, /const TOP_ROWS_LIMIT = 10/);
  assert.match(source, /\.slice\(0, TOP_ROWS_LIMIT\)/);
  assert.match(source, /community-metrics-tab-underline/);
  assert.match(source, /"data-provider-rank": index \+ 1/);
  assert.doesNotMatch(source, /md:grid-cols-2[\s\S]{0,1200}providers\.map/);
});

test("community growth compares complete UTC weeks instead of a partial current day", () => {
  const migration = read("migrations/20260718082000_use-completed-days-for-community-growth.sql");

  assert.match(migration, /BETWEEN v_today - 7 AND v_today - 1/);
  assert.match(migration, /BETWEEN v_today - 14 AND v_today - 8/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF daily_growth/);
  assert.match(migration, /normalize_tokentracker_community_growth/);
});
