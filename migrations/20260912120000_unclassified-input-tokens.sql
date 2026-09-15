-- Optional disjoint input with unknown cache split. Existing rows remain complete.
-- Apply before deploying the edge patches. No historical unknown split is inferred.
BEGIN;
ALTER TABLE public.tokentracker_hourly
  ADD COLUMN unclassified_input_tokens bigint NOT NULL DEFAULT 0 CHECK (unclassified_input_tokens >= 0),
  ALTER COLUMN total_cost_usd DROP NOT NULL;
ALTER TABLE public.tokentracker_account_session_states
  ADD COLUMN unclassified_input_tokens bigint NOT NULL DEFAULT 0 CHECK (unclassified_input_tokens >= 0);
-- Replace every legacy total invariant once. A database may contain both the
-- original unnamed constraint and a previous named attempt after a failed
-- rollout; adding the replacement inside the loop would then try to create
-- the same constraint more than once.
DO $migration$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid = 'public.tokentracker_account_session_states'::regclass
      AND contype = 'c'
  LOOP
    IF c.conname = 'account_session_total_with_unclassified'
       OR c.definition LIKE '%total_tokens = %' THEN
      EXECUTE format('ALTER TABLE public.tokentracker_account_session_states DROP CONSTRAINT %I', c.conname);
    END IF;
  END LOOP;
  EXECUTE 'ALTER TABLE public.tokentracker_account_session_states ADD CONSTRAINT account_session_total_with_unclassified CHECK (total_tokens = input_tokens + unclassified_input_tokens + cached_input_tokens + cache_creation_input_tokens + output_tokens)';
END
$migration$;
ALTER TABLE public.tokentracker_leaderboard_rollup_daily_v2
  ADD COLUMN unclassified_input_tokens bigint NOT NULL DEFAULT 0 CHECK (unclassified_input_tokens >= 0);
ALTER TABLE public.tokentracker_leaderboard_rollup_total_v2
  ADD COLUMN unclassified_input_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE public.tokentracker_leaderboard_snapshots
  ADD COLUMN unclassified_input_tokens bigint NOT NULL DEFAULT 0 CHECK (unclassified_input_tokens >= 0),
  ADD COLUMN total_cost_usd numeric,
  ADD COLUMN known_cost_usd numeric,
  ADD COLUMN cost_status text NOT NULL DEFAULT 'complete' CHECK (cost_status IN ('complete', 'partial')),
  ALTER COLUMN estimated_cost_usd DROP NOT NULL;
UPDATE public.tokentracker_leaderboard_snapshots
  SET total_cost_usd = estimated_cost_usd, known_cost_usd = estimated_cost_usd;

-- The concurrency migration copies hourly rows while converging a legacy
-- machine-less device into its canonical device. Re-declare that function
-- after adding the disjoint input column so the convergence cannot silently
-- discard unknown-input usage.
CREATE OR REPLACE FUNCTION public.refresh_tokentracker_device_identity(
  p_user_id uuid,
  p_device_id uuid,
  p_device_name text,
  p_platform text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path TO public, pg_temp
SET statement_timeout TO '15s'
AS $func$
DECLARE
  v_current_name text;
  v_name_customized boolean;
  v_current_default_name text;
  v_legacy_id uuid;
  v_legacy_name text;
  v_legacy_name_customized boolean;
  v_legacy_default_name text;
  v_target_name text;
  v_target_name_customized boolean;
  v_target_default_name text;
BEGIN
  SELECT d.device_name, d.name_customized, d.default_device_name
    INTO v_current_name, v_name_customized, v_current_default_name
  FROM public.tokentracker_devices AS d
  WHERE d.id = p_device_id
    AND d.user_id = p_user_id
    AND d.revoked_at IS NULL
    AND d.machine_id IS NOT NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT
    legacy.id,
    legacy.device_name,
    legacy.name_customized,
    legacy.default_device_name
  INTO
    v_legacy_id,
    v_legacy_name,
    v_legacy_name_customized,
    v_legacy_default_name
  FROM public.tokentracker_devices AS legacy
  WHERE legacy.user_id = p_user_id
    AND legacy.id <> p_device_id
    AND legacy.revoked_at IS NULL
    AND legacy.machine_id IS NULL
    AND legacy.platform IS NOT DISTINCT FROM p_platform
    AND (
      legacy.device_name = p_device_name
      OR legacy.default_device_name = p_device_name
    )
  ORDER BY
    CASE WHEN legacy.device_name = p_device_name THEN 0 ELSE 1 END,
    legacy.created_at,
    legacy.id
  LIMIT 1
  FOR UPDATE;

  IF v_legacy_id IS NOT NULL THEN
    INSERT INTO public.tokentracker_hourly AS canonical (
      user_id,
      device_id,
      source,
      model,
      hour_start,
      input_tokens,
      unclassified_input_tokens,
      cached_input_tokens,
      cache_creation_input_tokens,
      output_tokens,
      reasoning_output_tokens,
      total_tokens,
      billable_total_tokens,
      conversations,
      created_at,
      updated_at,
      total_cost_usd
    )
    SELECT
      ranked.user_id,
      p_device_id,
      ranked.source,
      ranked.model,
      ranked.hour_start,
      ranked.input_tokens,
      ranked.unclassified_input_tokens,
      ranked.cached_input_tokens,
      ranked.cache_creation_input_tokens,
      ranked.output_tokens,
      ranked.reasoning_output_tokens,
      ranked.total_tokens,
      ranked.billable_total_tokens,
      ranked.conversations,
      ranked.created_at,
      ranked.updated_at,
      ranked.total_cost_usd
    FROM (
      SELECT
        h.*,
        ROW_NUMBER() OVER (
          PARTITION BY h.user_id, h.source, h.model, h.hour_start
          ORDER BY h.total_tokens DESC, h.updated_at DESC, h.device_id = p_device_id DESC
        ) AS canonical_rank
      FROM public.tokentracker_hourly AS h
      WHERE h.user_id = p_user_id
        AND h.device_id IN (p_device_id, v_legacy_id)
    ) AS ranked
    WHERE ranked.canonical_rank = 1
    ON CONFLICT (user_id, device_id, source, model, hour_start) DO UPDATE SET
      input_tokens = EXCLUDED.input_tokens,
      unclassified_input_tokens = EXCLUDED.unclassified_input_tokens,
      cached_input_tokens = EXCLUDED.cached_input_tokens,
      cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      reasoning_output_tokens = EXCLUDED.reasoning_output_tokens,
      total_tokens = EXCLUDED.total_tokens,
      billable_total_tokens = EXCLUDED.billable_total_tokens,
      conversations = EXCLUDED.conversations,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      total_cost_usd = EXCLUDED.total_cost_usd;

    DELETE FROM public.tokentracker_hourly
    WHERE user_id = p_user_id
      AND device_id = v_legacy_id;

    UPDATE public.tokentracker_device_tokens
    SET device_id = p_device_id
    WHERE user_id = p_user_id
      AND device_id = v_legacy_id;

    IF to_regclass('public.tokentracker_device_machine') IS NOT NULL THEN
      EXECUTE
        'DELETE FROM public.tokentracker_device_machine WHERE device_id = $1'
      USING v_legacy_id;
    END IF;

    UPDATE public.tokentracker_devices
    SET revoked_at = clock_timestamp()
    WHERE id = v_legacy_id
      AND user_id = p_user_id
      AND revoked_at IS NULL
      AND machine_id IS NULL;
  END IF;

  v_target_name := CASE
    WHEN v_name_customized THEN v_current_name
    WHEN COALESCE(v_legacy_name_customized, false) THEN v_legacy_name
    ELSE p_device_name
  END;
  v_target_name_customized :=
    v_name_customized OR COALESCE(v_legacy_name_customized, false);
  v_target_default_name := CASE
    WHEN v_name_customized THEN v_current_default_name
    WHEN COALESCE(v_legacy_name_customized, false)
      THEN COALESCE(v_legacy_default_name, p_device_name)
    ELSE v_current_default_name
  END;

  BEGIN
    UPDATE public.tokentracker_devices
    SET
      device_name = v_target_name,
      platform = p_platform,
      name_customized = v_target_name_customized,
      default_device_name = v_target_default_name
    WHERE id = p_device_id
      AND user_id = p_user_id
      AND revoked_at IS NULL;
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  RETURN true;
END;
$func$;

REVOKE ALL ON FUNCTION public.refresh_tokentracker_device_identity(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_tokentracker_device_identity(
  uuid, uuid, text, text
) TO project_admin;

CREATE OR REPLACE FUNCTION public.tokentracker_upsert_account_session_states(
  p_user_id uuid,
  p_states jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_applied integer;
BEGIN
  INSERT INTO tokentracker_account_session_states AS t
    (user_id, source, session_id, model, bucket_start,
     input_tokens, output_tokens, unclassified_input_tokens, cached_input_tokens,
     cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
     snapshot_verified_at)
  SELECT
    p_user_id, x.source, x.session_id, x.model, x.bucket_start,
    x.input_tokens, x.output_tokens, COALESCE(x.unclassified_input_tokens, 0), x.cached_input_tokens,
    x.cache_creation_input_tokens, x.reasoning_output_tokens, x.total_tokens,
    x.snapshot_verified_at
  FROM jsonb_to_recordset(p_states) AS x(
    source text, session_id text, model text, bucket_start timestamptz,
    input_tokens bigint, output_tokens bigint, unclassified_input_tokens bigint, cached_input_tokens bigint,
    cache_creation_input_tokens bigint, reasoning_output_tokens bigint,
    total_tokens bigint, snapshot_verified_at timestamptz)
  ON CONFLICT (user_id, source, session_id) DO UPDATE SET
    model = EXCLUDED.model,
    bucket_start = EXCLUDED.bucket_start,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    unclassified_input_tokens = EXCLUDED.unclassified_input_tokens,    cached_input_tokens = EXCLUDED.cached_input_tokens,
    cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
    reasoning_output_tokens = EXCLUDED.reasoning_output_tokens,
    total_tokens = EXCLUDED.total_tokens,
    snapshot_verified_at = EXCLUDED.snapshot_verified_at,
    updated_at = now()
  WHERE EXCLUDED.snapshot_verified_at > t.snapshot_verified_at;

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  RETURN v_applied;
END
$fn$;

CREATE OR REPLACE FUNCTION public.leaderboard_hourly_dedup_v2_unclassified(
  p_from timestamptz,
  p_to timestamptz
) RETURNS TABLE (
  user_id uuid,
  source text,
  model text,
  hour_start timestamptz,
  total_tokens bigint,
  input_tokens bigint,
  output_tokens bigint,
  unclassified_input_tokens bigint,  cached_input_tokens bigint,
  cache_creation_input_tokens bigint,
  reasoning_output_tokens bigint
)
LANGUAGE sql STABLE
AS $func$
  WITH cfg AS (
    SELECT ARRAY['cursor', 'trae-cn']::text[] AS account_sources
  )
  -- Deduplicate device-id drift/replays inside one physical machine cluster,
  -- then add genuinely distinct machines for the same user/hour/model.
  SELECT mac.user_id, mac.source, mac.model, mac.hour_start,
    SUM(mac.total_tokens)::bigint                AS total_tokens,
    SUM(mac.input_tokens)::bigint                AS input_tokens,
    SUM(mac.output_tokens)::bigint               AS output_tokens,
    SUM(mac.unclassified_input_tokens)::bigint         AS unclassified_input_tokens,    SUM(mac.cached_input_tokens)::bigint         AS cached_input_tokens,
    SUM(mac.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
    SUM(mac.reasoning_output_tokens)::bigint     AS reasoning_output_tokens
  FROM (
    SELECT DISTINCT ON (
      h.user_id,
      COALESCE(dm.machine_cluster_id, h.device_id::text),
      h.source,
      h.model,
      h.hour_start
    )
      h.user_id,
      COALESCE(dm.machine_cluster_id, h.device_id::text) AS machine_cluster_id,
      h.source, h.model, h.hour_start,
      h.total_tokens::bigint                AS total_tokens,
      h.input_tokens::bigint                AS input_tokens,
      h.output_tokens::bigint               AS output_tokens,
      h.unclassified_input_tokens::bigint         AS unclassified_input_tokens,      h.cached_input_tokens::bigint         AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint     AS reasoning_output_tokens
    FROM tokentracker_hourly h
    CROSS JOIN cfg
    JOIN tokentracker_devices d
      ON d.id = h.device_id AND d.revoked_at IS NULL
    LEFT JOIN tokentracker_device_machine dm
      ON dm.device_id = h.device_id
    WHERE h.hour_start >= p_from AND h.hour_start < p_to
      AND NOT (h.source = ANY(cfg.account_sources))
    ORDER BY
      h.user_id,
      COALESCE(dm.machine_cluster_id, h.device_id::text),
      h.source,
      h.model,
      h.hour_start,
      h.total_tokens DESC,
      h.updated_at DESC
  ) mac
  GROUP BY mac.user_id, mac.source, mac.model, mac.hour_start

  UNION ALL

  -- 'cursor' (account-level but with NO stable session identity): rows are
  -- identical across devices, so the legacy whole-row MAX pick per
  -- (user, hour, source, model) dedups them.
  SELECT acct.user_id, acct.source, acct.model, acct.hour_start,
    acct.total_tokens, acct.input_tokens, acct.output_tokens,
    acct.unclassified_input_tokens,    acct.cached_input_tokens, acct.cache_creation_input_tokens,
    acct.reasoning_output_tokens
  FROM (
    SELECT DISTINCT ON (h.user_id, h.source, h.model, h.hour_start)
      h.user_id, h.source, h.model, h.hour_start,
      h.total_tokens::bigint                AS total_tokens,
      h.input_tokens::bigint                AS input_tokens,
      h.output_tokens::bigint               AS output_tokens,
      h.unclassified_input_tokens::bigint         AS unclassified_input_tokens,      h.cached_input_tokens::bigint         AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint     AS reasoning_output_tokens
    FROM tokentracker_hourly h
    WHERE h.hour_start >= p_from AND h.hour_start < p_to
      AND h.source = 'cursor'
    ORDER BY h.user_id, h.source, h.model, h.hour_start, h.total_tokens DESC, h.updated_at DESC
  ) acct

  UNION ALL

  -- trae-cn: canonical account truth aggregated from session states. Every
  -- device's observations of the same session collapsed to ONE row by the
  -- LWW upsert; corrections (downward / model / bucket) are already
  -- reflected because each session exists exactly once.
  SELECT s.user_id, s.source, s.model, s.bucket_start AS hour_start,
    SUM(s.total_tokens)::bigint                AS total_tokens,
    SUM(s.input_tokens)::bigint                AS input_tokens,
    SUM(s.output_tokens)::bigint               AS output_tokens,
    SUM(s.unclassified_input_tokens)::bigint         AS unclassified_input_tokens,    SUM(s.cached_input_tokens)::bigint         AS cached_input_tokens,
    SUM(s.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
    SUM(s.reasoning_output_tokens)::bigint     AS reasoning_output_tokens
  FROM tokentracker_account_session_states s
  WHERE s.bucket_start >= p_from AND s.bucket_start < p_to
    AND s.source = 'trae-cn'
  GROUP BY s.user_id, s.source, s.model, s.bucket_start
$func$;

REVOKE ALL ON FUNCTION public.leaderboard_hourly_dedup_v2_unclassified(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_hourly_dedup_v2_unclassified(timestamptz, timestamptz) TO project_admin;

CREATE OR REPLACE FUNCTION public.leaderboard_hourly_dedup_v3_unclassified(
  p_from timestamptz, p_to timestamptz
) RETURNS TABLE (
  user_id uuid, source text, model text, hour_start timestamptz,
  total_tokens bigint, input_tokens bigint, output_tokens bigint,
  unclassified_input_tokens bigint,  cached_input_tokens bigint, cache_creation_input_tokens bigint,
  reasoning_output_tokens bigint
)
LANGUAGE sql STABLE
AS $func$
  WITH cfg AS (
    SELECT ARRAY['cursor', 'trae-cn']::text[] AS account_sources
  )
  SELECT mac.user_id, mac.source, mac.model, mac.hour_start,
    SUM(mac.total_tokens)::bigint, SUM(mac.input_tokens)::bigint,
    SUM(mac.output_tokens)::bigint, SUM(mac.unclassified_input_tokens)::bigint, SUM(mac.cached_input_tokens)::bigint,
    SUM(mac.cache_creation_input_tokens)::bigint,
    SUM(mac.reasoning_output_tokens)::bigint
  FROM (
    SELECT DISTINCT ON (
      h.user_id, COALESCE(dm.machine_cluster_id, h.device_id::text),
      h.source, h.model, h.hour_start
    )
      h.user_id, COALESCE(dm.machine_cluster_id, h.device_id::text) AS machine_cluster_id,
      h.source, h.model, h.hour_start, h.total_tokens::bigint AS total_tokens,
      h.input_tokens::bigint AS input_tokens, h.output_tokens::bigint AS output_tokens,
      h.unclassified_input_tokens::bigint AS unclassified_input_tokens,      h.cached_input_tokens::bigint AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint AS reasoning_output_tokens
    FROM public.tokentracker_hourly h
    CROSS JOIN cfg
    JOIN public.tokentracker_devices d ON d.id = h.device_id AND d.revoked_at IS NULL
    LEFT JOIN public.tokentracker_device_machine dm ON dm.device_id = h.device_id
    WHERE h.hour_start >= p_from AND h.hour_start < p_to
      AND NOT (h.source = ANY(cfg.account_sources))
    ORDER BY h.user_id, COALESCE(dm.machine_cluster_id, h.device_id::text),
      h.source, h.model, h.hour_start, h.total_tokens DESC, h.updated_at DESC
  ) mac
  GROUP BY mac.user_id, mac.source, mac.model, mac.hour_start

  UNION ALL

  SELECT acct.user_id, acct.source, acct.model, acct.hour_start,
    acct.total_tokens, acct.input_tokens, acct.output_tokens,
    acct.unclassified_input_tokens,    acct.cached_input_tokens, acct.cache_creation_input_tokens,
    acct.reasoning_output_tokens
  FROM (
    SELECT DISTINCT ON (h.user_id, h.source, h.model, h.hour_start)
      h.user_id, h.source, h.model, h.hour_start,
      h.total_tokens::bigint AS total_tokens, h.input_tokens::bigint AS input_tokens,
      h.output_tokens::bigint AS output_tokens,
      h.unclassified_input_tokens::bigint AS unclassified_input_tokens,      h.cached_input_tokens::bigint AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint AS reasoning_output_tokens
    FROM public.tokentracker_hourly h
    WHERE h.hour_start >= p_from AND h.hour_start < p_to AND h.source = 'cursor'
    ORDER BY h.user_id, h.source, h.model, h.hour_start, h.total_tokens DESC, h.updated_at DESC
  ) acct

  UNION ALL

  SELECT s.user_id, s.source, s.model, s.bucket_start,
    SUM(s.total_tokens)::bigint, SUM(s.input_tokens)::bigint,
    SUM(s.output_tokens)::bigint, SUM(s.unclassified_input_tokens)::bigint, SUM(s.cached_input_tokens)::bigint,
    SUM(s.cache_creation_input_tokens)::bigint,
    SUM(s.reasoning_output_tokens)::bigint
  FROM public.tokentracker_account_session_states s
  WHERE s.bucket_start >= p_from AND s.bucket_start < p_to AND s.source = 'trae-cn'
  GROUP BY s.user_id, s.source, s.model, s.bucket_start
$func$;

REVOKE ALL ON FUNCTION public.leaderboard_hourly_dedup_v3_unclassified(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_hourly_dedup_v3_unclassified(timestamptz, timestamptz) TO project_admin;

CREATE OR REPLACE FUNCTION public.leaderboard_rollup_daily_replace_v2(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS void
LANGUAGE plpgsql
SET work_mem TO '16MB'
SET hash_mem_multiplier TO '2'
SET statement_timeout TO '25s'
AS $func$
DECLARE
  v_day timestamptz;
BEGIN
  v_day := date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  WHILE v_day < p_to LOOP
    DELETE FROM public.tokentracker_leaderboard_rollup_daily_v2
    WHERE day = (v_day AT TIME ZONE 'UTC')::date;

    INSERT INTO public.tokentracker_leaderboard_rollup_daily_v2 (
      user_id, source, model, day, pricing_tier,
      total_tokens, input_tokens, output_tokens,
      unclassified_input_tokens,      cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens
    )
    SELECT
      d.user_id, d.source, d.model,
      (d.hour_start AT TIME ZONE 'UTC')::date AS day,
      public.leaderboard_pricing_tier(d.model, d.hour_start),
      SUM(d.total_tokens), SUM(d.input_tokens), SUM(d.output_tokens),
      SUM(d.unclassified_input_tokens),      SUM(d.cached_input_tokens), SUM(d.cache_creation_input_tokens), SUM(d.reasoning_output_tokens)
    FROM public.leaderboard_hourly_dedup_v2_unclassified(v_day, v_day + interval '1 day') d
    GROUP BY d.user_id, d.source, d.model, (d.hour_start AT TIME ZONE 'UTC')::date, public.leaderboard_pricing_tier(d.model, d.hour_start);

    v_day := v_day + interval '1 day';
  END LOOP;

END
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_rollup_daily_replace_v3(
  p_from timestamptz, p_to timestamptz
) RETURNS void
LANGUAGE plpgsql
SET work_mem TO '16MB'
SET hash_mem_multiplier TO '2'
SET statement_timeout TO '25s'
AS $func$
DECLARE v_day timestamptz;
BEGIN
  v_day := date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  WHILE v_day < p_to LOOP
    DELETE FROM public.tokentracker_leaderboard_rollup_daily_v2
    WHERE day = (v_day AT TIME ZONE 'UTC')::date;
    INSERT INTO public.tokentracker_leaderboard_rollup_daily_v2 (
      user_id, source, model, day, pricing_tier, total_tokens, input_tokens, output_tokens,
      unclassified_input_tokens,      cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens
    )
    SELECT d.user_id, d.source, d.model,
      (d.hour_start AT TIME ZONE 'UTC')::date,
      public.leaderboard_pricing_tier(d.model, d.hour_start),
      SUM(d.total_tokens), SUM(d.input_tokens), SUM(d.output_tokens),
      SUM(d.unclassified_input_tokens),      SUM(d.cached_input_tokens), SUM(d.cache_creation_input_tokens),
      SUM(d.reasoning_output_tokens)
    FROM public.leaderboard_hourly_dedup_v3_unclassified(v_day, v_day + interval '1 day') d
    GROUP BY d.user_id, d.source, d.model, (d.hour_start AT TIME ZONE 'UTC')::date, public.leaderboard_pricing_tier(d.model, d.hour_start);
    v_day := v_day + interval '1 day';
  END LOOP;
END
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_rollup_total_v2_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $func$
BEGIN
  INSERT INTO public.tokentracker_leaderboard_rollup_total_v2 AS total (
    user_id, source, model, pricing_tier,
    total_tokens, input_tokens, output_tokens,
    unclassified_input_tokens,    cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens
  )
  SELECT
    user_id, source, model, pricing_tier,
    SUM(total_tokens)::bigint,
    SUM(input_tokens)::bigint,
    SUM(output_tokens)::bigint,
    SUM(unclassified_input_tokens)::bigint,    SUM(cached_input_tokens)::bigint,
    SUM(cache_creation_input_tokens)::bigint,
    SUM(reasoning_output_tokens)::bigint
  FROM new_rows
  GROUP BY user_id, source, model, pricing_tier
  ON CONFLICT (user_id, source, model, pricing_tier) DO UPDATE SET
    total_tokens = total.total_tokens + EXCLUDED.total_tokens,
    input_tokens = total.input_tokens + EXCLUDED.input_tokens,
    output_tokens = total.output_tokens + EXCLUDED.output_tokens,
    unclassified_input_tokens = total.unclassified_input_tokens + EXCLUDED.unclassified_input_tokens,    cached_input_tokens = total.cached_input_tokens + EXCLUDED.cached_input_tokens,
    cache_creation_input_tokens = total.cache_creation_input_tokens
      + EXCLUDED.cache_creation_input_tokens,
    reasoning_output_tokens = total.reasoning_output_tokens
      + EXCLUDED.reasoning_output_tokens;
  RETURN NULL;
END
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_rollup_total_v2_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $func$
BEGIN
  UPDATE public.tokentracker_leaderboard_rollup_total_v2 AS total
  SET
    total_tokens = total.total_tokens - removed.total_tokens,
    input_tokens = total.input_tokens - removed.input_tokens,
    output_tokens = total.output_tokens - removed.output_tokens,
    unclassified_input_tokens = total.unclassified_input_tokens - removed.unclassified_input_tokens,    cached_input_tokens = total.cached_input_tokens - removed.cached_input_tokens,
    cache_creation_input_tokens = total.cache_creation_input_tokens
      - removed.cache_creation_input_tokens,
    reasoning_output_tokens = total.reasoning_output_tokens
      - removed.reasoning_output_tokens
  FROM (
    SELECT
      user_id, source, model, pricing_tier,
      SUM(total_tokens)::bigint AS total_tokens,
      SUM(input_tokens)::bigint AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens,
      SUM(unclassified_input_tokens)::bigint AS unclassified_input_tokens,      SUM(cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens)::bigint AS reasoning_output_tokens
    FROM old_rows
    GROUP BY user_id, source, model, pricing_tier
  ) AS removed
  WHERE total.user_id = removed.user_id
    AND total.source = removed.source
    AND total.model = removed.model
    AND total.pricing_tier = removed.pricing_tier;

  DELETE FROM public.tokentracker_leaderboard_rollup_total_v2
  WHERE total_tokens = 0
    AND input_tokens = 0
    AND output_tokens = 0
    AND cached_input_tokens = 0
    AND unclassified_input_tokens = 0
    AND cache_creation_input_tokens = 0
    AND reasoning_output_tokens = 0;
  RETURN NULL;
END
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_rollup_total_v2_after_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $func$
BEGIN
  UPDATE public.tokentracker_leaderboard_rollup_total_v2 AS total
  SET
    total_tokens = total.total_tokens - removed.total_tokens,
    input_tokens = total.input_tokens - removed.input_tokens,
    output_tokens = total.output_tokens - removed.output_tokens,
    unclassified_input_tokens = total.unclassified_input_tokens - removed.unclassified_input_tokens,    cached_input_tokens = total.cached_input_tokens - removed.cached_input_tokens,
    cache_creation_input_tokens = total.cache_creation_input_tokens
      - removed.cache_creation_input_tokens,
    reasoning_output_tokens = total.reasoning_output_tokens
      - removed.reasoning_output_tokens
  FROM (
    SELECT
      user_id, source, model, pricing_tier,
      SUM(total_tokens)::bigint AS total_tokens,
      SUM(input_tokens)::bigint AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens,
      SUM(unclassified_input_tokens)::bigint AS unclassified_input_tokens,      SUM(cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens)::bigint AS reasoning_output_tokens
    FROM old_rows
    GROUP BY user_id, source, model, pricing_tier
  ) AS removed
  WHERE total.user_id = removed.user_id
    AND total.source = removed.source
    AND total.model = removed.model
    AND total.pricing_tier = removed.pricing_tier;

  INSERT INTO public.tokentracker_leaderboard_rollup_total_v2 AS total (
    user_id, source, model, pricing_tier,
    total_tokens, input_tokens, output_tokens,
    unclassified_input_tokens,    cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens
  )
  SELECT
    user_id, source, model, pricing_tier,
    SUM(total_tokens)::bigint,
    SUM(input_tokens)::bigint,
    SUM(output_tokens)::bigint,
    SUM(unclassified_input_tokens)::bigint,    SUM(cached_input_tokens)::bigint,
    SUM(cache_creation_input_tokens)::bigint,
    SUM(reasoning_output_tokens)::bigint
  FROM new_rows
  GROUP BY user_id, source, model, pricing_tier
  ON CONFLICT (user_id, source, model, pricing_tier) DO UPDATE SET
    total_tokens = total.total_tokens + EXCLUDED.total_tokens,
    input_tokens = total.input_tokens + EXCLUDED.input_tokens,
    output_tokens = total.output_tokens + EXCLUDED.output_tokens,
    unclassified_input_tokens = total.unclassified_input_tokens + EXCLUDED.unclassified_input_tokens,    cached_input_tokens = total.cached_input_tokens + EXCLUDED.cached_input_tokens,
    cache_creation_input_tokens = total.cache_creation_input_tokens
      + EXCLUDED.cache_creation_input_tokens,
    reasoning_output_tokens = total.reasoning_output_tokens
      + EXCLUDED.reasoning_output_tokens;

  DELETE FROM public.tokentracker_leaderboard_rollup_total_v2
  WHERE total_tokens = 0
    AND input_tokens = 0
    AND output_tokens = 0
    AND cached_input_tokens = 0
    AND unclassified_input_tokens = 0
    AND cache_creation_input_tokens = 0
    AND reasoning_output_tokens = 0;
  RETURN NULL;
END
$func$;

CREATE OR REPLACE FUNCTION public.account_usage_grouped(
  p_user_id uuid,
  p_device_ids uuid[],
  p_from timestamptz,
  p_to timestamptz,
  p_trunc text,
  p_tz text,
  p_offset_min integer
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '8s'
AS $func$
  WITH tzr AS (
    SELECT CASE
      WHEN p_tz IS NOT NULL AND p_tz <> ''
       AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz)
      THEN p_tz ELSE NULL
    END AS tz
  ), base AS MATERIALIZED (
    SELECT
      h.device_id, h.hour_start, h.source, h.model,
      h.total_tokens::bigint AS total_tokens,
      h.input_tokens::bigint AS input_tokens,
      h.output_tokens::bigint AS output_tokens,
      h.unclassified_input_tokens::bigint AS unclassified_input_tokens,      h.cached_input_tokens::bigint AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint AS reasoning_output_tokens,
      h.conversations::bigint AS conversations,
      h.updated_at
    FROM public.tokentracker_hourly h
    WHERE h.user_id = p_user_id
      AND h.hour_start >= p_from AND h.hour_start < p_to
      AND (
        h.source = 'cursor'
        OR (
          h.source NOT IN ('cursor', 'trae-cn')
          AND h.device_id = ANY(p_device_ids)
        )
      )
  ), hourly AS (
    SELECT mac.hour_start, mac.source, mac.model,
      mac.total_tokens, mac.input_tokens, mac.output_tokens,
      mac.unclassified_input_tokens,      mac.cached_input_tokens, mac.cache_creation_input_tokens,
      mac.reasoning_output_tokens, mac.conversations
    FROM (
      SELECT DISTINCT ON (
        COALESCE(dm.machine_cluster_id, h.device_id::text),
        h.hour_start, h.source, h.model
      )
        h.hour_start, h.source, h.model,
        h.total_tokens, h.input_tokens, h.output_tokens,
        h.unclassified_input_tokens,        h.cached_input_tokens, h.cache_creation_input_tokens,
        h.reasoning_output_tokens, h.conversations
      FROM base h
      LEFT JOIN public.tokentracker_device_machine dm ON dm.device_id = h.device_id
      WHERE h.source NOT IN ('cursor', 'trae-cn')
        AND h.device_id = ANY(p_device_ids)
      ORDER BY COALESCE(dm.machine_cluster_id, h.device_id::text),
        h.hour_start, h.source, h.model, h.total_tokens DESC, h.updated_at DESC
    ) mac

    UNION ALL

    SELECT d.hour_start, d.source, d.model,
      d.total_tokens, d.input_tokens, d.output_tokens,
      d.unclassified_input_tokens,      d.cached_input_tokens, d.cache_creation_input_tokens,
      d.reasoning_output_tokens, d.conversations
    FROM (
      SELECT DISTINCT ON (h.hour_start, h.source, h.model)
        h.hour_start, h.source, h.model,
        h.total_tokens, h.input_tokens, h.output_tokens,
        h.unclassified_input_tokens,        h.cached_input_tokens, h.cache_creation_input_tokens,
        h.reasoning_output_tokens, h.conversations
      FROM base h
      WHERE h.source = 'cursor'
      ORDER BY h.hour_start, h.source, h.model, h.total_tokens DESC, h.updated_at DESC
    ) d

    UNION ALL

    SELECT s.bucket_start, s.source, s.model,
      SUM(s.total_tokens)::bigint, SUM(s.input_tokens)::bigint,
      SUM(s.output_tokens)::bigint, SUM(s.unclassified_input_tokens)::bigint, SUM(s.cached_input_tokens)::bigint,
      SUM(s.cache_creation_input_tokens)::bigint,
      SUM(s.reasoning_output_tokens)::bigint, COUNT(*)::bigint
    FROM public.tokentracker_account_session_states s
    WHERE s.user_id = p_user_id
      AND s.bucket_start >= p_from AND s.bucket_start < p_to
      AND s.source = 'trae-cn'
    GROUP BY s.bucket_start, s.source, s.model
  ), located AS (
    SELECT
      CASE p_trunc
        WHEN 'hour' THEN to_char(date_trunc('hour', local_ts), 'YYYY-MM-DD"T"HH24:00:00')
        WHEN 'day' THEN to_char(date_trunc('day', local_ts), 'YYYY-MM-DD')
        WHEN 'month' THEN to_char(date_trunc('month', local_ts), 'YYYY-MM')
        ELSE ''
      END AS bucket,
      source, model,
      CASE
        WHEN lower(model) LIKE '%deepseek-v4-flash%'
          OR lower(model) LIKE '%deepseek-v4-pro%'
        THEN CASE
          WHEN (
            extract(hour FROM hour_start AT TIME ZONE 'UTC') >= 1
            AND extract(hour FROM hour_start AT TIME ZONE 'UTC') < 4
          ) OR (
            extract(hour FROM hour_start AT TIME ZONE 'UTC') >= 6
            AND extract(hour FROM hour_start AT TIME ZONE 'UTC') < 10
          ) THEN 'peak' ELSE 'off_peak'
        END
        ELSE 'peak'
      END AS pricing_tier,
      total_tokens, input_tokens, output_tokens, unclassified_input_tokens, cached_input_tokens,
      cache_creation_input_tokens, reasoning_output_tokens, conversations
    FROM hourly CROSS JOIN tzr
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN tzr.tz IS NOT NULL THEN hour_start AT TIME ZONE tzr.tz
        WHEN p_offset_min IS NOT NULL
          THEN (hour_start AT TIME ZONE 'UTC') + make_interval(mins => p_offset_min)
        ELSE hour_start AT TIME ZONE 'UTC'
      END AS local_ts
    ) local_time
  ), grouped AS (
    SELECT bucket, source, model, pricing_tier,
      SUM(total_tokens)::bigint AS total_tokens,
      SUM(input_tokens)::bigint AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens,
      SUM(unclassified_input_tokens)::bigint AS unclassified_input_tokens,      SUM(cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens)::bigint AS reasoning_output_tokens,
      SUM(conversations)::bigint AS conversations
    FROM located
    GROUP BY bucket, source, model, pricing_tier
  )
  SELECT COALESCE(
    jsonb_agg(to_jsonb(grouped.*) ORDER BY bucket, source, model, pricing_tier),
    '[]'::jsonb
  ) FROM grouped
$func$;

-- Version the shared cache key so an older edge isolate cannot refill a JSON
-- payload that predates the disjoint unknown-input column and have a newer
-- isolate serve it as if it were complete.
CREATE OR REPLACE FUNCTION public.account_usage_grouped_cached(
  p_user_id uuid,
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_trunc text,
  p_tz text,
  p_offset_min integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE
SET search_path TO public, pg_temp
SET statement_timeout TO '8s'
AS $func$
DECLARE
  v_cache_key text;
  v_result jsonb;
BEGIN
  v_cache_key := concat_ws(
    chr(31), 'v3-unclassified-input', p_user_id::text,
    COALESCE(p_device_id::text, ''),
    to_char(p_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    to_char(p_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    p_trunc, COALESCE(p_tz, ''), COALESCE(p_offset_min::text, '')
  );

  SELECT c.result INTO v_result
  FROM public.tokentracker_account_usage_cache c
  WHERE c.cache_key = v_cache_key
    AND c.fetched_at >= clock_timestamp() - interval '30 seconds';
  IF FOUND THEN RETURN v_result; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_cache_key, 0));
  SELECT c.result INTO v_result
  FROM public.tokentracker_account_usage_cache c
  WHERE c.cache_key = v_cache_key
    AND c.fetched_at >= clock_timestamp() - interval '30 seconds';
  IF FOUND THEN RETURN v_result; END IF;

  v_result := public.account_usage_grouped_v2(
    p_user_id, p_device_id, p_from, p_to, p_trunc, p_tz, p_offset_min
  );

  INSERT INTO public.tokentracker_account_usage_cache AS c (cache_key, fetched_at, result)
  VALUES (v_cache_key, clock_timestamp(), v_result)
  ON CONFLICT (cache_key) DO UPDATE
  SET fetched_at = EXCLUDED.fetched_at, result = EXCLUDED.result;

  IF random() < 0.01 THEN
    WITH stale AS (
      SELECT s.cache_key
      FROM public.tokentracker_account_usage_cache s
      WHERE s.fetched_at < clock_timestamp() - interval '5 minutes'
      ORDER BY s.fetched_at, s.cache_key
      FOR UPDATE SKIP LOCKED
      LIMIT 256
    )
    DELETE FROM public.tokentracker_account_usage_cache c
    USING stale WHERE c.cache_key = stale.cache_key;
  END IF;
  RETURN v_result;
END
$func$;

REVOKE ALL ON FUNCTION public.account_usage_grouped_cached(
  uuid, uuid, timestamptz, timestamptz, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_usage_grouped_cached(
  uuid, uuid, timestamptz, timestamptz, text, text, integer
) TO project_admin;

CREATE OR REPLACE FUNCTION public.leaderboard_deepseek_v4_grouped(
  p_from timestamptz, p_to timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '25s'
AS $func$
  WITH hourly AS (
    SELECT mac.user_id, mac.source, mac.model, mac.hour_start,
      SUM(mac.total_tokens)::bigint AS total_tokens,
      SUM(mac.input_tokens)::bigint AS input_tokens,
      SUM(mac.output_tokens)::bigint AS output_tokens,
      SUM(mac.unclassified_input_tokens)::bigint AS unclassified_input_tokens,      SUM(mac.cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(mac.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(mac.reasoning_output_tokens)::bigint AS reasoning_output_tokens
    FROM (
      SELECT DISTINCT ON (h.user_id, COALESCE(dm.machine_cluster_id, h.device_id::text), h.source, h.model, h.hour_start)
        h.user_id, h.source, h.model, h.hour_start,
        h.total_tokens, h.input_tokens, h.output_tokens, h.unclassified_input_tokens, h.cached_input_tokens,
        h.cache_creation_input_tokens, h.reasoning_output_tokens
      FROM public.tokentracker_hourly h
      JOIN public.tokentracker_devices d ON d.id = h.device_id AND d.revoked_at IS NULL
      LEFT JOIN public.tokentracker_device_machine dm ON dm.device_id = h.device_id
      WHERE h.hour_start >= p_from AND h.hour_start < p_to
        AND h.source NOT IN ('cursor', 'trae-cn')
        AND (lower(h.model) LIKE '%deepseek-v4-flash%' OR lower(h.model) LIKE '%deepseek-v4-pro%')
      ORDER BY h.user_id, COALESCE(dm.machine_cluster_id, h.device_id::text),
        h.source, h.model, h.hour_start, h.total_tokens DESC, h.updated_at DESC
    ) mac
    GROUP BY mac.user_id, mac.source, mac.model, mac.hour_start

    UNION ALL

    SELECT acct.user_id, acct.source, acct.model, acct.hour_start,
      acct.total_tokens, acct.input_tokens, acct.output_tokens,
      acct.unclassified_input_tokens,      acct.cached_input_tokens, acct.cache_creation_input_tokens, acct.reasoning_output_tokens
    FROM (
      SELECT DISTINCT ON (h.user_id, h.source, h.model, h.hour_start)
        h.user_id, h.source, h.model, h.hour_start, h.total_tokens,
        h.input_tokens, h.output_tokens, h.unclassified_input_tokens, h.cached_input_tokens,
        h.cache_creation_input_tokens, h.reasoning_output_tokens
      FROM public.tokentracker_hourly h
      WHERE h.hour_start >= p_from AND h.hour_start < p_to
        AND h.source = 'cursor'
        AND (lower(h.model) LIKE '%deepseek-v4-flash%' OR lower(h.model) LIKE '%deepseek-v4-pro%')
      ORDER BY h.user_id, h.source, h.model, h.hour_start, h.total_tokens DESC, h.updated_at DESC
    ) acct

    UNION ALL

    SELECT s.user_id, s.source, s.model, s.bucket_start,
      SUM(s.total_tokens)::bigint, SUM(s.input_tokens)::bigint, SUM(s.output_tokens)::bigint,
      SUM(s.unclassified_input_tokens)::bigint,      SUM(s.cached_input_tokens)::bigint, SUM(s.cache_creation_input_tokens)::bigint,
      SUM(s.reasoning_output_tokens)::bigint
    FROM public.tokentracker_account_session_states s
    WHERE s.bucket_start >= p_from AND s.bucket_start < p_to
      AND s.source = 'trae-cn'
      AND (lower(s.model) LIKE '%deepseek-v4-flash%' OR lower(s.model) LIKE '%deepseek-v4-pro%')
    GROUP BY s.user_id, s.source, s.model, s.bucket_start
  ), grouped AS (
    SELECT user_id, source, model,
      CASE WHEN (extract(hour FROM hour_start AT TIME ZONE 'UTC') >= 1
                      AND extract(hour FROM hour_start AT TIME ZONE 'UTC') < 4)
                  OR (extract(hour FROM hour_start AT TIME ZONE 'UTC') >= 6
                      AND extract(hour FROM hour_start AT TIME ZONE 'UTC') < 10)
        THEN 'peak' ELSE 'off_peak' END AS pricing_tier,
      SUM(total_tokens)::bigint AS total_tokens, SUM(input_tokens)::bigint AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens,
      SUM(unclassified_input_tokens)::bigint AS unclassified_input_tokens,      SUM(cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens)::bigint AS reasoning_output_tokens
    FROM hourly
    GROUP BY user_id, source, model, pricing_tier
  )
  SELECT COALESCE(
    jsonb_agg(to_jsonb(grouped.*) ORDER BY user_id, source, model, pricing_tier),
    '[]'::jsonb
  ) FROM grouped
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_usage_grouped(
  p_from timestamptz,
  p_to timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path TO public, pg_temp
SET work_mem TO '96MB'
SET hash_mem_multiplier TO '4'
SET statement_timeout TO '25s'
AS $func$
DECLARE
  v_through timestamptz;
  v_cut timestamptz;
  v_base jsonb;
BEGIN
  SELECT m.through INTO v_through
  FROM public.tokentracker_leaderboard_rollup_meta_v2 m
  WHERE m.id = 1;
  v_cut := date_trunc(
    'day',
    LEAST(v_through, p_to) AT TIME ZONE 'UTC'
  ) AT TIME ZONE 'UTC';

  IF v_through IS NOT NULL
     AND p_from = date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
     AND v_cut > p_from THEN
    IF p_from = TIMESTAMPTZ '1970-01-01 00:00:00+00'
       AND p_to >= v_through THEN
      -- The all-time period is the only caller allowed to use the aggregate
      -- without a day predicate. It still merges the open live tail so today
      -- remains current before the next closed-day rollup advance.
      SELECT COALESCE(jsonb_agg(to_jsonb(per_usm.*)), '[]'::jsonb)
      INTO v_base
      FROM (
        SELECT
          u.user_id, u.source, u.model, u.pricing_tier,
          SUM(u.total_tokens)::bigint AS total_tokens,
          SUM(u.input_tokens)::bigint AS input_tokens,
          SUM(u.output_tokens)::bigint AS output_tokens,
          SUM(u.unclassified_input_tokens)::bigint AS unclassified_input_tokens,          SUM(u.cached_input_tokens)::bigint AS cached_input_tokens,
          SUM(u.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
          SUM(u.reasoning_output_tokens)::bigint AS reasoning_output_tokens
        FROM (
          SELECT
            r.user_id, r.source, r.model, r.pricing_tier,
            r.total_tokens, r.input_tokens, r.output_tokens,
            r.unclassified_input_tokens,            r.cached_input_tokens, r.cache_creation_input_tokens,
            r.reasoning_output_tokens
          FROM public.tokentracker_leaderboard_rollup_total_v2 r
          UNION ALL
          SELECT
            t.user_id, t.source, t.model,
            public.leaderboard_pricing_tier(t.model, t.hour_start) AS pricing_tier,
            t.total_tokens, t.input_tokens, t.output_tokens,
            t.unclassified_input_tokens,            t.cached_input_tokens, t.cache_creation_input_tokens,
            t.reasoning_output_tokens
          FROM public.leaderboard_hourly_dedup_v2_unclassified(v_cut, p_to) t
        ) u
        GROUP BY u.user_id, u.source, u.model, u.pricing_tier
      ) per_usm;
    ELSE
      SELECT COALESCE(jsonb_agg(to_jsonb(per_usm.*)), '[]'::jsonb)
      INTO v_base
      FROM (
        SELECT
          u.user_id, u.source, u.model, u.pricing_tier,
          SUM(u.total_tokens)::bigint AS total_tokens,
          SUM(u.input_tokens)::bigint AS input_tokens,
          SUM(u.output_tokens)::bigint AS output_tokens,
          SUM(u.unclassified_input_tokens)::bigint AS unclassified_input_tokens,          SUM(u.cached_input_tokens)::bigint AS cached_input_tokens,
          SUM(u.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
          SUM(u.reasoning_output_tokens)::bigint AS reasoning_output_tokens
        FROM (
          SELECT
            r.user_id, r.source, r.model, r.pricing_tier,
            r.total_tokens, r.input_tokens, r.output_tokens,
            r.unclassified_input_tokens,            r.cached_input_tokens, r.cache_creation_input_tokens,
            r.reasoning_output_tokens
          FROM public.tokentracker_leaderboard_rollup_daily_v2 r
          WHERE r.day >= (p_from AT TIME ZONE 'UTC')::date
            AND r.day < (v_cut AT TIME ZONE 'UTC')::date
          UNION ALL
          SELECT
            t.user_id, t.source, t.model,
            public.leaderboard_pricing_tier(t.model, t.hour_start) AS pricing_tier,
            t.total_tokens, t.input_tokens, t.output_tokens,
            t.unclassified_input_tokens,            t.cached_input_tokens, t.cache_creation_input_tokens,
            t.reasoning_output_tokens
          FROM public.leaderboard_hourly_dedup_v2_unclassified(v_cut, p_to) t
        ) u
        GROUP BY u.user_id, u.source, u.model, u.pricing_tier
      ) per_usm;
    END IF;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(per_usm.*)), '[]'::jsonb)
    INTO v_base
    FROM (
      SELECT
        d.user_id, d.source, d.model,
        public.leaderboard_pricing_tier(d.model, d.hour_start) AS pricing_tier,
        SUM(d.total_tokens)::bigint AS total_tokens,
        SUM(d.input_tokens)::bigint AS input_tokens,
        SUM(d.output_tokens)::bigint AS output_tokens,
        SUM(d.unclassified_input_tokens)::bigint AS unclassified_input_tokens,        SUM(d.cached_input_tokens)::bigint AS cached_input_tokens,
        SUM(d.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
        SUM(d.reasoning_output_tokens)::bigint AS reasoning_output_tokens
      FROM public.leaderboard_hourly_dedup_v2_unclassified(p_from, p_to) d
      GROUP BY
        d.user_id, d.source, d.model,
        public.leaderboard_pricing_tier(d.model, d.hour_start)
    ) per_usm;
  END IF;

  RETURN COALESCE(v_base, '[]'::jsonb);
END
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_usage_grouped_v3(
  p_from timestamptz, p_to timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET work_mem TO '96MB'
SET hash_mem_multiplier TO '4'
SET statement_timeout TO '25s'
AS $func$
DECLARE v_through timestamptz; v_cut timestamptz; v_result jsonb;
BEGIN
  SELECT m.through INTO v_through
  FROM public.tokentracker_leaderboard_rollup_meta_v2 m WHERE m.id = 1;
  v_cut := date_trunc('day', LEAST(v_through, p_to) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF v_through IS NOT NULL
     AND p_from = (date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
     AND v_cut > p_from THEN
    SELECT jsonb_agg(to_jsonb(x.*) ORDER BY x.user_id, x.source, x.model) INTO v_result
    FROM (
      SELECT u.user_id, u.source, u.model, SUM(u.total_tokens)::bigint total_tokens,
        SUM(u.input_tokens)::bigint input_tokens, SUM(u.output_tokens)::bigint output_tokens,
        SUM(u.unclassified_input_tokens)::bigint unclassified_input_tokens,        SUM(u.cached_input_tokens)::bigint cached_input_tokens,
        SUM(u.cache_creation_input_tokens)::bigint cache_creation_input_tokens,
        SUM(u.reasoning_output_tokens)::bigint reasoning_output_tokens
      FROM (
        SELECT r.user_id, r.source, r.model, r.total_tokens, r.input_tokens,
          r.output_tokens, r.unclassified_input_tokens, r.cached_input_tokens, r.cache_creation_input_tokens,
          r.reasoning_output_tokens
        FROM public.tokentracker_leaderboard_rollup_daily_v2 r
        WHERE r.day >= (p_from AT TIME ZONE 'UTC')::date
          AND r.day < (v_cut AT TIME ZONE 'UTC')::date
        UNION ALL
        SELECT t.user_id, t.source, t.model, t.total_tokens, t.input_tokens,
          t.output_tokens, t.unclassified_input_tokens, t.cached_input_tokens, t.cache_creation_input_tokens,
          t.reasoning_output_tokens
        FROM public.leaderboard_hourly_dedup_v3_unclassified(v_cut, p_to) t
      ) u GROUP BY u.user_id, u.source, u.model
    ) x;
  ELSE
    SELECT jsonb_agg(to_jsonb(x.*) ORDER BY x.user_id, x.source, x.model) INTO v_result
    FROM (
      SELECT d.user_id, d.source, d.model, SUM(d.total_tokens)::bigint total_tokens,
        SUM(d.input_tokens)::bigint input_tokens, SUM(d.output_tokens)::bigint output_tokens,
        SUM(d.unclassified_input_tokens)::bigint unclassified_input_tokens,        SUM(d.cached_input_tokens)::bigint cached_input_tokens,
        SUM(d.cache_creation_input_tokens)::bigint cache_creation_input_tokens,
        SUM(d.reasoning_output_tokens)::bigint reasoning_output_tokens
      FROM public.leaderboard_hourly_dedup_v3_unclassified(p_from, p_to) d
      GROUP BY d.user_id, d.source, d.model
    ) x;
  END IF;
  RETURN COALESCE(v_result, '[]'::jsonb);
END
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_usage_grouped_total_shard(
  p_to timestamptz,
  p_user_from uuid,
  p_user_to uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path TO public, pg_temp
SET work_mem TO '48MB'
SET hash_mem_multiplier TO '2'
SET statement_timeout TO '8s'
AS $func$
DECLARE
  v_through timestamptz;
  v_cut timestamptz;
  v_result jsonb;
BEGIN
  SELECT m.through INTO v_through
  FROM public.tokentracker_leaderboard_rollup_meta_v2 m
  WHERE m.id = 1;

  IF v_through IS NULL THEN
    RAISE EXCEPTION 'leaderboard v2 rollup is not initialized';
  END IF;

  v_cut := date_trunc(
    'day',
    LEAST(v_through, p_to) AT TIME ZONE 'UTC'
  ) AT TIME ZONE 'UTC';

  SELECT COALESCE(jsonb_agg(to_jsonb(per_usm.*)), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      u.user_id, u.source, u.model, u.pricing_tier,
      SUM(u.total_tokens)::bigint AS total_tokens,
      SUM(u.input_tokens)::bigint AS input_tokens,
      SUM(u.output_tokens)::bigint AS output_tokens,
      SUM(u.unclassified_input_tokens)::bigint AS unclassified_input_tokens,      SUM(u.cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(u.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(u.reasoning_output_tokens)::bigint AS reasoning_output_tokens
    FROM (
      SELECT
        r.user_id, r.source, r.model, r.pricing_tier,
        r.total_tokens, r.input_tokens, r.output_tokens,
        r.unclassified_input_tokens,        r.cached_input_tokens, r.cache_creation_input_tokens,
        r.reasoning_output_tokens
      FROM public.tokentracker_leaderboard_rollup_total_v2 r
      WHERE (p_user_from IS NULL OR r.user_id >= p_user_from)
        AND (p_user_to IS NULL OR r.user_id < p_user_to)

      UNION ALL

      SELECT
        t.user_id, t.source, t.model,
        public.leaderboard_pricing_tier(t.model, t.hour_start) AS pricing_tier,
        t.total_tokens, t.input_tokens, t.output_tokens,
        t.unclassified_input_tokens,        t.cached_input_tokens, t.cache_creation_input_tokens,
        t.reasoning_output_tokens
      FROM public.leaderboard_hourly_dedup_v2_unclassified(v_cut, p_to) t
      WHERE (p_user_from IS NULL OR t.user_id >= p_user_from)
        AND (p_user_to IS NULL OR t.user_id < p_user_to)
    ) u
    GROUP BY u.user_id, u.source, u.model, u.pricing_tier
  ) per_usm;

  RETURN COALESCE(v_result, '[]'::jsonb);
END
$func$;

-- Cached JSON from the previous schema must not conceal partial input.
DELETE FROM public.tokentracker_account_usage_cache;
COMMIT;
