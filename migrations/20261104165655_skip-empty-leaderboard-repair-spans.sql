-- #827: the repair cursor starts at MIN(hour_start). Epoch-dated uploads
-- made it walk 56 years of empty dates, seven days per invocation, even with
-- the independent ten-minute schedule from #472. Seek the next occupied day
-- without discarding old usage or changing any aggregation/deduplication rule.
-- Existing hourly(hour_start) and rollup_daily_v2(day) indexes cover two of
-- the probes; session states need a global bucket index for the third.
-- When archiving is enabled, its manifest(day,user_id) index covers cold days.
CREATE INDEX IF NOT EXISTS tokentracker_session_states_repair_bucket_idx
  ON public.tokentracker_account_session_states (bucket_start)
  WHERE source = 'trae-cn';

CREATE OR REPLACE FUNCTION public.leaderboard_rollup_next_day_v2(
  p_from timestamptz,
  p_to timestamptz
) RETURNS date
LANGUAGE plpgsql STABLE
SET search_path TO public, pg_temp
AS $func$
DECLARE
  v_next_day date;
  v_archive_day date;
BEGIN
  SELECT MIN(candidate.day) INTO v_next_day
  FROM (
    SELECT (MIN(h.hour_start) AT TIME ZONE 'UTC')::date AS day
    FROM public.tokentracker_hourly h
    WHERE h.hour_start >= p_from AND h.hour_start < p_to

    UNION ALL

    SELECT (MIN(s.bucket_start) AT TIME ZONE 'UTC')::date
    FROM public.tokentracker_account_session_states s
    WHERE s.source = 'trae-cn'
      AND s.bucket_start >= p_from AND s.bucket_start < p_to

    UNION ALL

    SELECT MIN(r.day)
    FROM public.tokentracker_leaderboard_rollup_daily_v2 r
    WHERE r.day >= (p_from AT TIME ZONE 'UTC')::date
      AND r.day < (p_to AT TIME ZONE 'UTC')::date
  ) candidate;

  -- Archiving can be enabled before or after this repair migration. Defer
  -- planning this query until the manifest exists; never scan cold payloads.
  IF to_regclass('public.tokentracker_usage_archive_manifest') IS NOT NULL THEN
    SELECT MIN(m.day) INTO v_archive_day
    FROM public.tokentracker_usage_archive_manifest m
    WHERE m.day >= (p_from AT TIME ZONE 'UTC')::date
      AND m.day < (p_to AT TIME ZONE 'UTC')::date;
    v_next_day := LEAST(v_next_day, v_archive_day);
  END IF;
  RETURN v_next_day;
END
$func$;

REVOKE ALL ON FUNCTION public.leaderboard_rollup_next_day_v2(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_rollup_next_day_v2(timestamptz, timestamptz)
  TO project_admin;

CREATE OR REPLACE FUNCTION public.leaderboard_rollup_daily_advance_v2()
RETURNS void
LANGUAGE plpgsql
SET search_path TO public, pg_temp
SET work_mem TO '16MB'
SET hash_mem_multiplier TO '2'
SET statement_timeout TO '25s'
AS $func$
DECLARE
  v_from timestamptz;
  v_target timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_until timestamptz;
  v_min_day date;
  v_repair_from date;
  v_seed_gap_day date;
  v_next_day date;
BEGIN
  -- Preserve the archive scheduler's bounded dirty-day repair, including
  -- invocations that return early from catch-up below.
  IF to_regprocedure('public.cloud_repair_usage_days(integer)') IS NOT NULL THEN
    PERFORM public.cloud_repair_usage_days(7);
  END IF;
  v_min_day := public.leaderboard_rollup_next_day_v2('-infinity', v_target);
  v_min_day := COALESCE(v_min_day, (v_target AT TIME ZONE 'UTC')::date);

  SELECT m.through, m.repair_from INTO v_from, v_repair_from
  FROM public.tokentracker_leaderboard_rollup_meta_v2 m
  WHERE m.id = 1
  FOR UPDATE;

  IF v_from IS NULL THEN
    v_from := v_min_day::timestamp AT TIME ZONE 'UTC';
    v_repair_from := v_min_day;
    INSERT INTO public.tokentracker_leaderboard_rollup_meta_v2 (
      id, through, repair_from, rebuilt_at
    ) VALUES (1, v_from, v_repair_from, now());
  END IF;

  IF v_from < v_target THEN
    -- Empty spans contain neither usage to materialize nor stale rows to remove.
    -- Jump across them, then retain the seven-day bound on actual rebuild work.
    v_next_day := public.leaderboard_rollup_next_day_v2(v_from, v_target);
    IF v_next_day IS NULL THEN
      v_until := v_target;
    ELSE
      v_from := v_next_day::timestamp AT TIME ZONE 'UTC';
      v_until := LEAST(v_target, v_from + interval '7 days');
      PERFORM public.leaderboard_rollup_daily_replace_v2(v_from, v_until);
    END IF;
    UPDATE public.tokentracker_leaderboard_rollup_meta_v2
    SET through = v_until,
        rebuilt_at = now()
    WHERE id = 1;
    RETURN;
  END IF;

  -- Once caught up, continuously repair seven historical days per scheduled
  -- invocation. Late history uploads, device revocations, and cluster-map
  -- changes therefore self-heal without another whole-history memory spike.
  IF v_repair_from >= (v_target AT TIME ZONE 'UTC')::date THEN
    v_repair_from := v_min_day;
  END IF;

  -- First-seed / uncovered-day prioritization (trae-cn): jump the repair
  -- window to the earliest CLOSED day that has trae-cn session states but
  -- no trae-cn rollup row yet. Coverage
  -- is PER USER (the rollup PK starts at user_id): another user's same-day
  -- row does NOT cover this user's seed. A day whose rollup row exists for
  -- that user (even with stale values) is NOT a gap - corrections keep the
  -- ordinary cyclic schedule.
  SELECT MIN((s.bucket_start AT TIME ZONE 'UTC')::date) INTO v_seed_gap_day
  FROM public.tokentracker_account_session_states s
  WHERE s.source = 'trae-cn'
    AND (s.bucket_start AT TIME ZONE 'UTC')::date < (v_target AT TIME ZONE 'UTC')::date
    AND NOT EXISTS (
      SELECT 1 FROM public.tokentracker_leaderboard_rollup_daily_v2 r
      WHERE r.user_id = s.user_id
        AND r.source = 'trae-cn'
        AND r.day = (s.bucket_start AT TIME ZONE 'UTC')::date
    );
  IF v_seed_gap_day IS NOT NULL THEN
    v_repair_from := v_seed_gap_day;
  END IF;

  -- A single epoch-dated upload must not force thousands of empty weekly
  -- repairs before recent corrections are reached (#827). Include existing
  -- rollups in the search: a day whose source rows were deleted still needs
  -- rebuilding to subtract its stale contribution from the total rollup.
  v_next_day := public.leaderboard_rollup_next_day_v2(
    v_repair_from::timestamp AT TIME ZONE 'UTC', v_target
  );
  v_repair_from := COALESCE(v_next_day, v_min_day);

  v_until := LEAST(
    v_target,
    (v_repair_from::timestamp AT TIME ZONE 'UTC') + interval '7 days'
  );
  PERFORM public.leaderboard_rollup_daily_replace_v2(
    v_repair_from::timestamp AT TIME ZONE 'UTC',
    v_until
  );
  UPDATE public.tokentracker_leaderboard_rollup_meta_v2
  SET repair_from = CASE
        WHEN v_until >= v_target THEN v_min_day
        ELSE (v_until AT TIME ZONE 'UTC')::date
      END,
      rebuilt_at = now()
  WHERE id = 1;
END
$func$;

REVOKE ALL ON FUNCTION public.leaderboard_rollup_daily_advance_v2()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_rollup_daily_advance_v2()
  TO project_admin;
