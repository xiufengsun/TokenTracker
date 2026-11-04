-- Achievement / badge system storage + compute (feature: profile achievements).
--
-- Design:
--   1. tokentracker_badge_catalog — the ONE place badge thresholds live.
--      Edges/read RPCs return thresholds in payloads; neither the edge
--      functions nor the dashboard embed threshold literals
--      (test/user-badges-thresholds-single-source.test.js enforces this).
--   2. tokentracker_user_badges — one row per (user, badge). tier 0..4 is
--      MONOTONIC (never downgrades — deduped history can retroactively shrink
--      on device revocation, but earned badges stay earned). tier-0 rows are
--      kept so the owner's progress toward unearned badges is served without
--      extra compute. Per-tier first-achieved timestamps are 4 columns; they
--      are set once and never overwritten.
--   3. user_badges_refresh() — pure-SQL compute + threshold evaluation +
--      monotonic upsert, called by the privileged badges-refresh edge.
--      Facts come from tokentracker_leaderboard_rollup_daily_v2 UNION ALL a
--      live-deduped v2 tail — the exact base/tail cut leaderboard_usage_grouped
--      uses, so badge numbers agree with leaderboard numbers.
--   4. user_badges_compact(uuid[]) / user_badges_full(uuid, boolean) — read
--      RPCs for the leaderboard list and profile edges. RPC (POST body)
--      instead of PostgREST .in() avoids the gateway URL-size limits.
--
-- podium (best-ever leaderboard rank): snapshots are pruned to the newest 3
-- windows, so best-ever rank cannot be derived later — each refresh samples
-- the CURRENT total-period rank and the monotonic upsert (LEAST) keeps the
-- best. Schedule this refresh shortly after the leaderboard refresh ticks so
-- every published rank is observed at least once.
--
-- Blocklist (LEADERBOARD_BLOCKED_USER_IDS) stays an edge-layer secret: the
-- compute may write rows for blocked users, but read edges filter them and
-- RLS (zero policies) keeps the table unreadable directly.
--
-- Idempotent. Rollback:
--   SELECT cron.unschedule('tokentracker-user-badges-refresh');
--   DROP FUNCTION user_badges_full(uuid, boolean);
--   DROP FUNCTION user_badges_compact(uuid[]);
--   DROP FUNCTION user_badges_refresh();
--   DROP FUNCTION user_badges_assign_serials_trigger();
--   DROP FUNCTION user_badges_assign_serials();
--   DROP TABLE tokentracker_user_badges, tokentracker_badge_catalog;

-- ── 1. Catalog: thresholds single source of truth ────────────────────────────

CREATE TABLE IF NOT EXISTS public.tokentracker_badge_catalog (
  badge_id        text PRIMARY KEY,
  sort_order      int  NOT NULL,
  -- podium: rank 3 beats rank 100 — thresholds compare downward.
  lower_is_better boolean NOT NULL DEFAULT false,
  bronze  numeric NOT NULL,
  silver  numeric NOT NULL,
  gold    numeric NOT NULL,
  diamond numeric NOT NULL
);

-- 2026-07-14 recalibration (launch data, 710 users): the original big_day /
-- momentum / polyglot thresholds put 17% / 55% / 21% of users at DIAMOND —
-- no scarcity at the top. New values target roughly bronze ~2 in 3 users,
-- silver ~1 in 3, gold ~1 in 8, diamond ~1 in 30 (percentiles measured on
-- live metric_value distributions). wordsmith / weekend_warrior added on the
-- same data: cumulative output_tokens (real generated work — cache replay
-- can't inflate it) and weekend active days (UTC-day grain).
INSERT INTO public.tokentracker_badge_catalog
  (badge_id, sort_order, lower_is_better, bronze, silver, gold, diamond)
VALUES
  ('token_titan',     1,  false, 100000000, 1000000000, 10000000000, 100000000000),
  ('big_day',         2,  false, 10000000, 100000000, 500000000, 3000000000),
  ('wordsmith',       3,  false, 5000000, 25000000, 100000000, 300000000),
  ('marathoner',      4,  false, 7, 30, 100, 365),
  ('streak',          5,  false, 3, 7, 30, 100),
  ('weekend_warrior', 6,  false, 5, 20, 50, 100),
  ('momentum',        7,  false, 2, 6, 15, 40),
  ('polyglot',        8,  false, 5, 15, 30, 60),
  ('trendsetter',     9,  false, 2, 5, 10, 20),
  ('multitool',       10, false, 2, 4, 6, 10),
  ('podium',          11, true,  100, 30, 10, 3),
  ('veteran',         12, false, 30, 90, 180, 365)
ON CONFLICT (badge_id) DO UPDATE SET
  sort_order      = EXCLUDED.sort_order,
  lower_is_better = EXCLUDED.lower_is_better,
  bronze  = EXCLUDED.bronze,
  silver  = EXCLUDED.silver,
  gold    = EXCLUDED.gold,
  diamond = EXCLUDED.diamond;

-- ── 2. Earned badges + progress ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tokentracker_user_badges (
  user_id      uuid NOT NULL,
  badge_id     text NOT NULL REFERENCES public.tokentracker_badge_catalog(badge_id),
  tier         smallint NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 4),
  -- Current metric value (podium: best-ever rank via LEAST on upsert).
  metric_value numeric NOT NULL DEFAULT 0,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- First time each tier was observed by a refresh; set once, never cleared.
  bronze_at  timestamptz,
  silver_at  timestamptz,
  gold_at    timestamptz,
  diamond_at timestamptz,
  -- Stable global acquisition order, independently minted per badge + tier.
  bronze_no  bigint,
  silver_no  bigint,
  gold_no    bigint,
  diamond_no bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, badge_id)
);

-- CREATE TABLE IF NOT EXISTS does not evolve an existing installation.
ALTER TABLE public.tokentracker_user_badges
  ADD COLUMN IF NOT EXISTS bronze_no  bigint,
  ADD COLUMN IF NOT EXISTS silver_no  bigint,
  ADD COLUMN IF NOT EXISTS gold_no    bigint,
  ADD COLUMN IF NOT EXISTS diamond_no bigint;

-- Same security model as the rollup tables: RLS on, ZERO policies, deny-all
-- grants. Only project_admin (edges via service role) and cron/superuser
-- reach these tables.
ALTER TABLE public.tokentracker_badge_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_user_badges  ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.tokentracker_badge_catalog TO project_admin;
GRANT ALL ON public.tokentracker_user_badges  TO project_admin;
REVOKE ALL ON public.tokentracker_badge_catalog FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.tokentracker_user_badges  FROM anon, authenticated, PUBLIC;

-- ── 2a. Stable acquisition numbers ──────────────────────────────────────────

-- Assign every missing number in one deterministic batch. The advisory lock
-- serializes concurrent refresh transactions; the stored bigint is the source
-- of truth and never changes after it is minted. Ties from the same refresh
-- tick are resolved by user_id so historical backfills are reproducible.
CREATE OR REPLACE FUNCTION public.user_badges_assign_serials()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $func$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tokentracker-badge-issue-numbers', 0)
  );

  WITH maxima AS (
    SELECT badge_id, COALESCE(MAX(bronze_no), 0) AS max_no
    FROM public.tokentracker_user_badges GROUP BY badge_id
  ), numbered AS (
    SELECT b.user_id, b.badge_id,
           m.max_no + ROW_NUMBER() OVER (
             PARTITION BY b.badge_id ORDER BY b.bronze_at, b.user_id
           ) AS issue_no
    FROM public.tokentracker_user_badges b
    JOIN maxima m USING (badge_id)
    WHERE b.bronze_at IS NOT NULL AND b.bronze_no IS NULL
  )
  UPDATE public.tokentracker_user_badges b
  SET bronze_no = n.issue_no
  FROM numbered n
  WHERE b.user_id = n.user_id AND b.badge_id = n.badge_id;

  WITH maxima AS (
    SELECT badge_id, COALESCE(MAX(silver_no), 0) AS max_no
    FROM public.tokentracker_user_badges GROUP BY badge_id
  ), numbered AS (
    SELECT b.user_id, b.badge_id,
           m.max_no + ROW_NUMBER() OVER (
             PARTITION BY b.badge_id ORDER BY b.silver_at, b.user_id
           ) AS issue_no
    FROM public.tokentracker_user_badges b
    JOIN maxima m USING (badge_id)
    WHERE b.silver_at IS NOT NULL AND b.silver_no IS NULL
  )
  UPDATE public.tokentracker_user_badges b
  SET silver_no = n.issue_no
  FROM numbered n
  WHERE b.user_id = n.user_id AND b.badge_id = n.badge_id;

  WITH maxima AS (
    SELECT badge_id, COALESCE(MAX(gold_no), 0) AS max_no
    FROM public.tokentracker_user_badges GROUP BY badge_id
  ), numbered AS (
    SELECT b.user_id, b.badge_id,
           m.max_no + ROW_NUMBER() OVER (
             PARTITION BY b.badge_id ORDER BY b.gold_at, b.user_id
           ) AS issue_no
    FROM public.tokentracker_user_badges b
    JOIN maxima m USING (badge_id)
    WHERE b.gold_at IS NOT NULL AND b.gold_no IS NULL
  )
  UPDATE public.tokentracker_user_badges b
  SET gold_no = n.issue_no
  FROM numbered n
  WHERE b.user_id = n.user_id AND b.badge_id = n.badge_id;

  WITH maxima AS (
    SELECT badge_id, COALESCE(MAX(diamond_no), 0) AS max_no
    FROM public.tokentracker_user_badges GROUP BY badge_id
  ), numbered AS (
    SELECT b.user_id, b.badge_id,
           m.max_no + ROW_NUMBER() OVER (
             PARTITION BY b.badge_id ORDER BY b.diamond_at, b.user_id
           ) AS issue_no
    FROM public.tokentracker_user_badges b
    JOIN maxima m USING (badge_id)
    WHERE b.diamond_at IS NOT NULL AND b.diamond_no IS NULL
  )
  UPDATE public.tokentracker_user_badges b
  SET diamond_no = n.issue_no
  FROM numbered n
  WHERE b.user_id = n.user_id AND b.badge_id = n.badge_id;
END
$func$;

-- Deterministically number rows that pre-date this feature before uniqueness
-- is enforced. On a fresh install this is a no-op.
SELECT public.user_badges_assign_serials();

CREATE UNIQUE INDEX IF NOT EXISTS tokentracker_user_badges_bronze_no_uq
  ON public.tokentracker_user_badges (badge_id, bronze_no)
  WHERE bronze_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tokentracker_user_badges_silver_no_uq
  ON public.tokentracker_user_badges (badge_id, silver_no)
  WHERE silver_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tokentracker_user_badges_gold_no_uq
  ON public.tokentracker_user_badges (badge_id, gold_no)
  WHERE gold_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tokentracker_user_badges_diamond_no_uq
  ON public.tokentracker_user_badges (badge_id, diamond_no)
  WHERE diamond_no IS NOT NULL;

-- Statement-level trigger means every writer (not only the scheduled refresh)
-- preserves the invariant. Serial updates recurse into the same trigger, so
-- the depth guard is load-bearing.
CREATE OR REPLACE FUNCTION public.user_badges_assign_serials_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $func$
BEGIN
  -- BEFORE STATEMENT: acquire the lock before any row locks, preventing two
  -- writers from deadlocking while the AFTER trigger numbers each other's rows.
  IF TG_WHEN = 'BEFORE' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('tokentracker-badge-issue-numbers', 0)
    );
    RETURN NULL;
  END IF;
  IF pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  PERFORM public.user_badges_assign_serials();
  RETURN NULL;
END
$func$;

DROP TRIGGER IF EXISTS tokentracker_user_badges_lock_serials
  ON public.tokentracker_user_badges;
CREATE TRIGGER tokentracker_user_badges_lock_serials
BEFORE INSERT OR UPDATE ON public.tokentracker_user_badges
FOR EACH STATEMENT EXECUTE FUNCTION public.user_badges_assign_serials_trigger();

DROP TRIGGER IF EXISTS tokentracker_user_badges_assign_serials
  ON public.tokentracker_user_badges;
CREATE TRIGGER tokentracker_user_badges_assign_serials
AFTER INSERT OR UPDATE ON public.tokentracker_user_badges
FOR EACH STATEMENT EXECUTE FUNCTION public.user_badges_assign_serials_trigger();

REVOKE EXECUTE ON FUNCTION public.user_badges_assign_serials() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.user_badges_assign_serials_trigger() FROM anon, authenticated, PUBLIC;

-- ── 3. Refresh: facts → tiers → monotonic upsert ─────────────────────────────

CREATE OR REPLACE FUNCTION public.user_badges_refresh()
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

REVOKE EXECUTE ON FUNCTION public.user_badges_refresh() FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_badges_refresh() TO project_admin;

-- ── 4. Read RPCs (called by edges through the service role) ──────────────────

-- Compact map for the leaderboard list: top-3 earned badges per user
-- (priority: tier DESC, then catalog order) + total earned count.
-- Shape: { "<user_id>": { "badges": [{"id","tier"}...], "badge_count": n } }
CREATE OR REPLACE FUNCTION public.user_badges_compact(p_user_ids uuid[])
RETURNS jsonb
LANGUAGE sql STABLE
SET statement_timeout TO '5s'
AS $func$
  SELECT COALESCE(jsonb_object_agg(g.user_id, g.per_user), '{}'::jsonb)
  FROM (
    SELECT b.user_id,
           jsonb_build_object(
             'badges',
             COALESCE(jsonb_agg(jsonb_build_object('id', b.badge_id, 'tier', b.tier)
                                ORDER BY b.tier DESC, b.sort_order ASC)
                      FILTER (WHERE b.rn <= 3), '[]'::jsonb),
             'badge_count', COUNT(*)
           ) AS per_user
    FROM (
      SELECT ub.user_id, ub.badge_id, ub.tier, c.sort_order,
             ROW_NUMBER() OVER (PARTITION BY ub.user_id
                                ORDER BY ub.tier DESC, c.sort_order ASC) AS rn
      FROM tokentracker_user_badges ub
      JOIN tokentracker_badge_catalog c USING (badge_id)
      WHERE ub.user_id = ANY(p_user_ids) AND ub.tier >= 1
    ) b
    GROUP BY b.user_id
  ) g;
$func$;

-- Full list for the profile edge. p_include_unearned = true ONLY when the
-- verified caller IS the profile user (owner progress). Thresholds ride the
-- payload so the frontend never embeds them.
CREATE OR REPLACE FUNCTION public.user_badges_full(p_user_id uuid, p_include_unearned boolean)
RETURNS jsonb
LANGUAGE sql STABLE
SET statement_timeout TO '5s'
AS $func$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.badge_id,
    'tier', b.tier,
    'metric_value', b.metric_value,
    'thresholds', jsonb_build_array(c.bronze, c.silver, c.gold, c.diamond),
    'lower_is_better', c.lower_is_better,
    'next_threshold', CASE b.tier
      WHEN 4 THEN NULL
      WHEN 3 THEN c.diamond
      WHEN 2 THEN c.gold
      WHEN 1 THEN c.silver
      ELSE c.bronze END,
    'achieved', jsonb_build_object(
      'bronze', b.bronze_at, 'silver', b.silver_at,
      'gold', b.gold_at, 'diamond', b.diamond_at),
    'serials', jsonb_build_object(
      'bronze', b.bronze_no, 'silver', b.silver_no,
      'gold', b.gold_no, 'diamond', b.diamond_no),
    'meta', b.meta,
    'updated_at', b.updated_at
  ) ORDER BY b.tier DESC, c.sort_order ASC), '[]'::jsonb)
  FROM tokentracker_user_badges b
  JOIN tokentracker_badge_catalog c USING (badge_id)
  WHERE b.user_id = p_user_id
    AND (p_include_unearned OR b.tier >= 1);
$func$;

-- Functions get EXECUTE for PUBLIC by default — revoke it, then grant the
-- read RPCs back to project_admin only (the edges call them via the service
-- role). The refresh stays cron/superuser-only.
REVOKE EXECUTE ON FUNCTION public.user_badges_compact(uuid[]) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.user_badges_full(uuid, boolean) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_badges_compact(uuid[]) TO project_admin;
GRANT EXECUTE ON FUNCTION public.user_badges_full(uuid, boolean) TO project_admin;

-- ── 5. Schedule (run once via CLI after applying the above) ──────────────────
-- Production note (2026-11-04, issues #925 / #987):
--   The historical pg_cron job `tokentracker-user-badges-refresh` stalled at
--   2026-10-17T00:32Z while InsForge HTTP leaderboard schedules kept running.
--   Unrestricted SQL / cron.job access is disabled on the hosted project, so
--   the durable path is now the edge function
--   `tokentracker-user-badges-refresh` (dashboard/edge-patches/...) invoked by
--   an InsForge HTTP schedule on the same cadence:
--     cron: 32 */6 * * *
--     POST https://<app>.us-east.insforge.app/functions/tokentracker-user-badges-refresh
--     headers: Content-Type, apikey, x-refresh-secret=$LEADERBOARD_REFRESH_SECRET
--   Deploy: insforge functions deploy tokentracker-user-badges-refresh \
--             --file dashboard/edge-patches/tokentracker-user-badges-refresh.ts
--   One-shot catch-up after deploy: insforge functions invoke ... (privileged).
--   The edge uses the ordinary project-admin SQL endpoint to avoid the 10s
--   RPC proxy timeout. Apply the maintained-rollup migration before deploying;
--   exact commands and timeout/verification notes: docs/user-badges-refresh.md.
--   Legacy pg_cron snippet kept below for self-host / unrestricted SQL shops.

-- Check existing ticks first: SELECT jobname, schedule FROM cron.job;
-- Align ~15 min after the leaderboard refresh so every published rank is
-- observed at least once (podium sampling).
-- (Leaderboard refresh cron ticks at :17; :32 samples rank right after.)
-- SELECT cron.schedule(
--   'tokentracker-user-badges-refresh',
--   '32 */6 * * *',
--   'SELECT public.user_badges_refresh()'
-- );

-- ── 6. One-time recalibration (executed 2026-07-14; kept for the record) ─────
-- Tiers are monotonic, so raising big_day/momentum/polyglot thresholds alone
-- would grandfather the inflated tiers forever. The system had been live <48h
-- (backfill 2026-07-13), so a one-time recompute from the stored metric_value
-- against the NEW catalog — downgrades allowed, timestamps above the new tier
-- cleared — was the correct fix. Backup taken first:
--
-- CREATE TABLE tokentracker_user_badges_backup_20260714 AS
--   SELECT * FROM tokentracker_user_badges
--   WHERE badge_id IN ('big_day', 'momentum', 'polyglot');
-- ALTER TABLE tokentracker_user_badges_backup_20260714 ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON tokentracker_user_badges_backup_20260714 FROM anon, authenticated, PUBLIC;
--
-- UPDATE tokentracker_user_badges ub
-- SET tier       = x.new_tier,
--     bronze_at  = CASE WHEN x.new_tier >= 1 THEN ub.bronze_at  END,
--     silver_at  = CASE WHEN x.new_tier >= 2 THEN ub.silver_at  END,
--     gold_at    = CASE WHEN x.new_tier >= 3 THEN ub.gold_at    END,
--     diamond_at = CASE WHEN x.new_tier >= 4 THEN ub.diamond_at END,
--     updated_at = now()
-- FROM (
--   SELECT u.user_id, u.badge_id,
--          CASE WHEN u.metric_value >= c.diamond THEN 4
--               WHEN u.metric_value >= c.gold    THEN 3
--               WHEN u.metric_value >= c.silver  THEN 2
--               WHEN u.metric_value >= c.bronze  THEN 1
--               ELSE 0 END AS new_tier
--   FROM tokentracker_user_badges u
--   JOIN tokentracker_badge_catalog c USING (badge_id)
--   WHERE u.badge_id IN ('big_day', 'momentum', 'polyglot')
-- ) x
-- WHERE x.user_id = ub.user_id AND x.badge_id = ub.badge_id
--   AND ub.tier <> x.new_tier;
--
-- Drop the backup table once the new distribution has settled.
