-- Created 2026-11-04. Version allocated immediately after the deployed head
-- (20261012120000), before unrelated pending device-reset/model-wire migrations.
-- Badge refresh must use the maintained leaderboard v2 rollup and live tail.
-- The legacy watermark stopped on 2026-08-15, making each run rescan months
-- of raw usage. Keep the existing claim, tier rules, serial triggers and grants.
-- Preserve production's 48MB / 2 / no-parallel memory settings.
-- The original user_badges_refresh() is owned by a higher-privilege role on
-- production. A new project_admin-owned entry point avoids altering that
-- function or needing unrestricted SQL. Both entry points use the same claim.

CREATE OR REPLACE FUNCTION public.user_badges_refresh_v2()
RETURNS bigint
LANGUAGE plpgsql
SET work_mem TO '48MB'
SET hash_mem_multiplier TO '2'
SET statement_timeout TO '120s'
SET max_parallel_workers_per_gather TO '0'
AS $func$
DECLARE
  v_through timestamptz;
  v_upserted bigint;
BEGIN
  -- Concurrency/throttle guard — reuse the leaderboard claim primitive with a
  -- dedicated key. Anything other than true means another attempt claimed the
  -- window recently: skip (the refresh is idempotent; next tick catches up).
  IF public.leaderboard_refresh_try_claim('badges', 300) IS DISTINCT FROM true THEN
    RETURN 0;
  END IF;

  SELECT m.through INTO v_through
  FROM public.tokentracker_leaderboard_rollup_meta_v2 m
  WHERE m.id = 1;
  -- The legacy v1 watermark stopped advancing in August 2026. Replaying its
  -- growing raw tail exceeds both the RPC proxy and admin SQL time budgets.
  -- Match the maintained leaderboard pipeline; never silently scan all raw
  -- history if its rollup has not been initialized.
  IF v_through IS NULL THEN
    RAISE EXCEPTION 'leaderboard v2 rollup is not initialized';
  END IF;
  v_through := date_trunc('day', LEAST(v_through, now()) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  WITH
  -- (user, source, model, day): rollup base + live tail. The watermark sits on
  -- a UTC midnight, so no hourly bucket spans the cut — base + tail is exactly
  -- the deduped full history.
  usm AS (
    SELECT x.user_id, x.source, x.model, x.day,
           SUM(x.total_tokens)  AS tokens,
           SUM(x.output_tokens) AS output_tokens
    FROM (
      SELECT r.user_id, r.source, r.model, r.day, r.total_tokens, r.output_tokens
      FROM public.tokentracker_leaderboard_rollup_daily_v2 r
      WHERE r.day < (v_through AT TIME ZONE 'UTC')::date
      UNION ALL
      SELECT t.user_id, t.source, t.model,
             (t.hour_start AT TIME ZONE 'UTC')::date AS day, t.total_tokens, t.output_tokens
      FROM public.leaderboard_hourly_dedup_v2(v_through, now()) t
    ) x
    GROUP BY x.user_id, x.source, x.model, x.day
  ),
  -- Active day := any tokens that UTC day.
  daily AS (
    SELECT user_id, day, SUM(tokens) AS tokens, SUM(output_tokens) AS output_tokens
    FROM usm
    GROUP BY user_id, day
    HAVING SUM(tokens) > 0
  ),
  base AS (
    SELECT user_id,
           SUM(tokens)                    AS total_tokens,
           SUM(output_tokens)             AS output_tokens,
           COUNT(*)                       AS active_days,
           -- Weekend := Saturday/Sunday of the UTC day bucket. Local weekends
           -- shift by a few hours per timezone; at day grain that only blurs
           -- the edges, and no timezone context exists cloud-side.
           COUNT(*) FILTER (WHERE EXTRACT(isodow FROM day) IN (6, 7)) AS weekend_days,
           MIN(day)                       AS first_day,
           (current_date - MIN(day))      AS veteran_days,
           MAX(tokens)                    AS max_day_tokens
    FROM daily
    GROUP BY user_id
  ),
  best_day AS (
    SELECT DISTINCT ON (user_id) user_id, day AS best_day
    FROM daily
    ORDER BY user_id, tokens DESC, day ASC
  ),
  -- Longest streak: gaps-and-islands (day minus row_number is constant within
  -- a consecutive run).
  islands AS (
    SELECT user_id, grp, COUNT(*) AS len, MIN(day) AS run_start, MAX(day) AS run_end
    FROM (
      SELECT user_id, day,
             day - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY day))::int AS grp
      FROM daily
    ) g
    GROUP BY user_id, grp
  ),
  streaks AS (
    SELECT DISTINCT ON (user_id) user_id, len AS longest_streak, run_start, run_end
    FROM islands
    ORDER BY user_id, len DESC, run_end DESC
  ),
  -- Max week-over-week growth over ADJACENT ISO weeks (prev_wk = wk - 7 is
  -- load-bearing: LAG alone returns the previous ACTIVE week, which may be
  -- months earlier). Prior week must clear a 10M floor to count. A partial
  -- current week can only understate the ratio — no false positives.
  weekly AS (
    SELECT user_id, date_trunc('week', day)::date AS wk, SUM(tokens) AS wtok
    FROM daily
    GROUP BY user_id, date_trunc('week', day)::date
  ),
  momentum AS (
    SELECT DISTINCT ON (user_id) user_id,
           (wtok::numeric / prev_wtok::numeric) AS max_wow,
           wk AS wow_week
    FROM (
      SELECT user_id, wk, wtok,
             LAG(wk)   OVER (PARTITION BY user_id ORDER BY wk) AS prev_wk,
             LAG(wtok) OVER (PARTITION BY user_id ORDER BY wk) AS prev_wtok
      FROM weekly
    ) w
    WHERE prev_wk = wk - 7 AND prev_wtok >= 10000000
    ORDER BY user_id, (wtok::numeric / prev_wtok::numeric) DESC
  ),
  variety AS (
    SELECT user_id,
           COUNT(DISTINCT model)  AS models,
           COUNT(DISTINCT source) AS sources
    FROM usm
    WHERE tokens > 0
    GROUP BY user_id
  ),
  -- trendsetter: models this user first touched within 7 days of the model's
  -- GLOBAL debut. Two guards: a >=5 distinct-user floor (private/BYO model
  -- strings would otherwise self-debut and auto-qualify their only user) and
  -- a 30-day dataset burn-in (at data start every model "debuts" at once).
  model_debut AS (
    SELECT model, MIN(day) AS debut
    FROM usm
    GROUP BY model
    HAVING COUNT(DISTINCT user_id) >= 5
       AND MIN(day) >= (SELECT MIN(day) + 30 FROM usm)
  ),
  trend AS (
    SELECT uf.user_id, COUNT(*) AS early_models
    FROM (
      SELECT user_id, model, MIN(day) AS first_day
      FROM usm GROUP BY user_id, model
    ) uf
    JOIN model_debut d USING (model)
    WHERE uf.first_day <= d.debut + 7
    GROUP BY uf.user_id
  ),
  fav AS (
    SELECT DISTINCT ON (user_id) user_id, model AS favorite_model
    FROM (
      SELECT user_id, model, SUM(tokens) AS t
      FROM usm GROUP BY user_id, model
    ) m
    ORDER BY user_id, t DESC
  ),
  -- Current rank from the newest total-period snapshot window (sampled; the
  -- monotonic upsert turns samples into best-ever).
  cur_rank AS (
    SELECT s.user_id, MIN(s.rank) AS rank
    FROM tokentracker_leaderboard_snapshots s
    WHERE s.period = 'total'
      AND s.to_day = (SELECT MAX(to_day) FROM tokentracker_leaderboard_snapshots
                      WHERE period = 'total')
    GROUP BY s.user_id
  ),
  facts AS (
    SELECT b.user_id,
           b.total_tokens, b.output_tokens, b.max_day_tokens, bd.best_day,
           b.active_days, b.weekend_days, b.first_day, b.veteran_days,
           s.longest_streak, s.run_start, s.run_end,
           mo.max_wow, mo.wow_week,
           v.models, v.sources, f.favorite_model,
           t.early_models,
           r.rank AS current_rank
    FROM base b
    LEFT JOIN best_day bd USING (user_id)
    LEFT JOIN streaks  s  USING (user_id)
    LEFT JOIN momentum mo USING (user_id)
    LEFT JOIN variety  v  USING (user_id)
    LEFT JOIN fav      f  USING (user_id)
    LEFT JOIN trend    t  USING (user_id)
    LEFT JOIN cur_rank r  USING (user_id)
  )
  INSERT INTO tokentracker_user_badges AS ub
    (user_id, badge_id, tier, metric_value, meta,
     bronze_at, silver_at, gold_at, diamond_at, updated_at)
  SELECT f.user_id, c.badge_id, ev.tier, m.val, m.meta,
         CASE WHEN ev.tier >= 1 THEN now() END,
         CASE WHEN ev.tier >= 2 THEN now() END,
         CASE WHEN ev.tier >= 3 THEN now() END,
         CASE WHEN ev.tier >= 4 THEN now() END,
         now()
  FROM facts f
  CROSS JOIN LATERAL (VALUES
    ('token_titan',     f.total_tokens::numeric,   '{}'::jsonb),
    ('big_day',         f.max_day_tokens::numeric, jsonb_build_object('date', f.best_day)),
    ('wordsmith',       f.output_tokens::numeric,  '{}'::jsonb),
    ('marathoner',      f.active_days::numeric,    '{}'::jsonb),
    ('streak',          f.longest_streak::numeric, jsonb_build_object('run_start', f.run_start, 'run_end', f.run_end)),
    ('weekend_warrior', f.weekend_days::numeric,   '{}'::jsonb),
    ('momentum',        f.max_wow,                 jsonb_build_object('week', f.wow_week)),
    ('polyglot',        f.models::numeric,         jsonb_build_object('favorite_model', f.favorite_model)),
    ('trendsetter',     f.early_models::numeric,   '{}'::jsonb),
    ('multitool',       f.sources::numeric,        '{}'::jsonb),
    ('podium',          f.current_rank::numeric,   '{}'::jsonb),
    ('veteran',         f.veteran_days::numeric,   jsonb_build_object('first_day', f.first_day))
  ) AS m(badge_id, val, meta)
  JOIN tokentracker_badge_catalog c ON c.badge_id = m.badge_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN m.val IS NULL THEN 0
      WHEN c.lower_is_better THEN CASE
        WHEN m.val <= c.diamond THEN 4
        WHEN m.val <= c.gold    THEN 3
        WHEN m.val <= c.silver  THEN 2
        WHEN m.val <= c.bronze  THEN 1
        ELSE 0 END
      ELSE CASE
        WHEN m.val >= c.diamond THEN 4
        WHEN m.val >= c.gold    THEN 3
        WHEN m.val >= c.silver  THEN 2
        WHEN m.val >= c.bronze  THEN 1
        ELSE 0 END
      END AS tier
  ) ev
  -- momentum/podium have no value until a qualifying week / a rank exists;
  -- skip those rows (the dashboard renders missing rows as locked at zero).
  WHERE m.val IS NOT NULL
  ON CONFLICT (user_id, badge_id) DO UPDATE SET
    -- MONOTONIC: tier only ever ratchets up.
    tier = GREATEST(ub.tier, EXCLUDED.tier),
    -- podium keeps the best-ever (lowest) rank; every other metric is a
    -- whole-history aggregate and simply takes the latest computation.
    metric_value = CASE
      WHEN (SELECT lower_is_better FROM tokentracker_badge_catalog cc
            WHERE cc.badge_id = ub.badge_id)
        THEN LEAST(ub.metric_value, EXCLUDED.metric_value)
      ELSE EXCLUDED.metric_value END,
    meta = ub.meta || EXCLUDED.meta,
    -- First-achieved timestamps: set once, never overwritten.
    bronze_at  = COALESCE(ub.bronze_at,  EXCLUDED.bronze_at),
    silver_at  = COALESCE(ub.silver_at,  EXCLUDED.silver_at),
    gold_at    = COALESCE(ub.gold_at,    EXCLUDED.gold_at),
    diamond_at = COALESCE(ub.diamond_at, EXCLUDED.diamond_at),
    updated_at = now();

  GET DIAGNOSTICS v_upserted = ROW_COUNT;
  RETURN v_upserted;
END
$func$;

REVOKE EXECUTE ON FUNCTION public.user_badges_refresh_v2() FROM anon, authenticated, PUBLIC;

GRANT EXECUTE ON FUNCTION public.user_badges_refresh_v2() TO project_admin;
