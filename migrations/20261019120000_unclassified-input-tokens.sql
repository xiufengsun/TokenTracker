-- Optional disjoint input with unknown cache split. Existing rows remain complete.
-- Requires current main Cloud/archive migrations. Deploy before accounting-v3 edges and clients.
-- No historical unknown split is inferred; archive rows without the column mean zero.
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

-- Preserve project-admin-only entrypoints while patching installed bodies below.
REVOKE ALL ON FUNCTION public.refresh_tokentracker_device_identity(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_tokentracker_device_identity(
  uuid, uuid, text, text
) TO project_admin;

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
      COALESCE(h.unclassified_input_tokens,0)::bigint         AS unclassified_input_tokens,      h.cached_input_tokens::bigint         AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint     AS reasoning_output_tokens
    FROM public.cloud_usage_hourly(NULL,NULL,p_from,p_to) h
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
      COALESCE(h.unclassified_input_tokens,0)::bigint         AS unclassified_input_tokens,      h.cached_input_tokens::bigint         AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint     AS reasoning_output_tokens
    FROM public.cloud_usage_hourly(NULL,NULL,p_from,p_to) h
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
      COALESCE(h.unclassified_input_tokens,0)::bigint AS unclassified_input_tokens,      h.cached_input_tokens::bigint AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint AS reasoning_output_tokens
    FROM public.cloud_usage_hourly(NULL,NULL,p_from,p_to) h
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
      COALESCE(h.unclassified_input_tokens,0)::bigint AS unclassified_input_tokens,      h.cached_input_tokens::bigint AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint AS reasoning_output_tokens
    FROM public.cloud_usage_hourly(NULL,NULL,p_from,p_to) h
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

-- The guarded edits below version the shared cache key so older isolates
-- cannot refill a pre-v3 payload and conceal unknown input.
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
      FROM public.cloud_usage_hourly(NULL,NULL,p_from,p_to) h
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
      FROM public.cloud_usage_hourly(NULL,NULL,p_from,p_to) h
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
      public.leaderboard_pricing_tier(model, hour_start) AS pricing_tier,
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

-- Cached JSON from the previous schema must not conceal partial input.
DELETE FROM public.tokentracker_account_usage_cache;

-- Extend current-main compact/wire contracts in place. Append slots only:
-- deployed v2 readers keep their original indexes. Preserve function OIDs,
-- ACLs, membership gates, archive revision checks and upload-window locks.
-- Every replacement is scoped to an inspected function and aborts on drift.
DO $integration$
DECLARE
  patch record;
  signature text;
  definition text;
  occurrences integer;
BEGIN
  -- Compile once per function, only after every projection/UNION branch has
  -- its new column. Keep OIDs, ACLs, canonical pricing and current-main locks.
  FOR patch IN SELECT * FROM (VALUES
    (1, 'leaderboard_rollup_total_v2_after_update()',
      '    cached_input_tokens = total.cached_input_tokens - removed.cached_input_tokens,',
      E'    unclassified_input_tokens = total.unclassified_input_tokens - removed.unclassified_input_tokens,\n    cached_input_tokens = total.cached_input_tokens - removed.cached_input_tokens,', 1),
    (2, 'leaderboard_rollup_total_v2_after_update()',
      '      SUM(cached_input_tokens)::bigint AS cached_input_tokens,',
      E'      SUM(unclassified_input_tokens)::bigint AS unclassified_input_tokens,\n      SUM(cached_input_tokens)::bigint AS cached_input_tokens,', 1),
    (3, 'leaderboard_rollup_total_v2_after_update()',
      '    cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens',
      E'    unclassified_input_tokens,\n    cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens', 1),
    (4, 'leaderboard_rollup_total_v2_after_update()',
      '    SUM(cached_input_tokens)::bigint,',
      E'    SUM(unclassified_input_tokens)::bigint,\n    SUM(cached_input_tokens)::bigint,', 1),
    (5, 'leaderboard_rollup_total_v2_after_update()',
      '    cached_input_tokens = total.cached_input_tokens + EXCLUDED.cached_input_tokens,',
      E'    unclassified_input_tokens = total.unclassified_input_tokens + EXCLUDED.unclassified_input_tokens,\n    cached_input_tokens = total.cached_input_tokens + EXCLUDED.cached_input_tokens,', 1),
    (6, 'leaderboard_rollup_total_v2_after_update()',
      '    AND cache_creation_input_tokens = 0',
      E'    AND unclassified_input_tokens = 0\n    AND cache_creation_input_tokens = 0', 1),
    (7, 'tokentracker_upsert_account_session_states(uuid,jsonb)',
      '     input_tokens, output_tokens, cached_input_tokens,',
      '     input_tokens, output_tokens, unclassified_input_tokens, cached_input_tokens,', 1),
    (8, 'tokentracker_upsert_account_session_states(uuid,jsonb)',
      '    x.input_tokens, x.output_tokens, x.cached_input_tokens,',
      '    x.input_tokens, x.output_tokens, COALESCE(x.unclassified_input_tokens, 0), x.cached_input_tokens,', 1),
    (9, 'tokentracker_upsert_account_session_states(uuid,jsonb)',
      '    input_tokens bigint, output_tokens bigint, cached_input_tokens bigint,',
      '    input_tokens bigint, output_tokens bigint, unclassified_input_tokens bigint, cached_input_tokens bigint,', 1),
    (10, 'tokentracker_upsert_account_session_states(uuid,jsonb)',
      '    cached_input_tokens = EXCLUDED.cached_input_tokens,',
      E'    unclassified_input_tokens = EXCLUDED.unclassified_input_tokens,\n    cached_input_tokens = EXCLUDED.cached_input_tokens,', 1),
    (11, 'account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)',
      '      h.cached_input_tokens::bigint AS cached_input_tokens,',
      E'      COALESCE(h.unclassified_input_tokens,0)::bigint AS unclassified_input_tokens,\n      h.cached_input_tokens::bigint AS cached_input_tokens,', 1),
    (12, 'account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)',
      '      mac.cached_input_tokens, mac.cache_creation_input_tokens,',
      E'      mac.unclassified_input_tokens,\n      mac.cached_input_tokens, mac.cache_creation_input_tokens,', 1),
    (13, 'account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)',
      '        h.cached_input_tokens, h.cache_creation_input_tokens,',
      E'        h.unclassified_input_tokens,\n        h.cached_input_tokens, h.cache_creation_input_tokens,', 2),
    (14, 'account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)',
      '      d.cached_input_tokens, d.cache_creation_input_tokens,',
      E'      d.unclassified_input_tokens,\n      d.cached_input_tokens, d.cache_creation_input_tokens,', 1),
    (15, 'account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)',
      '      SUM(s.output_tokens)::bigint, SUM(s.cached_input_tokens)::bigint,',
      '      SUM(s.output_tokens)::bigint, SUM(s.unclassified_input_tokens)::bigint, SUM(s.cached_input_tokens)::bigint,', 1),
    (16, 'account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)',
      '      total_tokens, input_tokens, output_tokens, cached_input_tokens,',
      '      total_tokens, input_tokens, output_tokens, unclassified_input_tokens, cached_input_tokens,', 1),
    (17, 'account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)',
      '      SUM(cached_input_tokens)::bigint AS cached_input_tokens,',
      E'      SUM(unclassified_input_tokens)::bigint AS unclassified_input_tokens,\n      SUM(cached_input_tokens)::bigint AS cached_input_tokens,', 1),
    (18, 'leaderboard_rollup_total_v2_after_insert()',
      '    cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens',
      E'    unclassified_input_tokens,\n    cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens', 1),
    (19, 'leaderboard_rollup_total_v2_after_insert()',
      '    SUM(cached_input_tokens)::bigint,',
      E'    SUM(unclassified_input_tokens)::bigint,\n    SUM(cached_input_tokens)::bigint,', 1),
    (20, 'leaderboard_rollup_total_v2_after_insert()',
      '    cached_input_tokens = total.cached_input_tokens + EXCLUDED.cached_input_tokens,',
      E'    unclassified_input_tokens = total.unclassified_input_tokens + EXCLUDED.unclassified_input_tokens,\n    cached_input_tokens = total.cached_input_tokens + EXCLUDED.cached_input_tokens,', 1),
    (21, 'leaderboard_rollup_total_v2_after_delete()',
      '    cached_input_tokens = total.cached_input_tokens - removed.cached_input_tokens,',
      E'    unclassified_input_tokens = total.unclassified_input_tokens - removed.unclassified_input_tokens,\n    cached_input_tokens = total.cached_input_tokens - removed.cached_input_tokens,', 1),
    (22, 'leaderboard_rollup_total_v2_after_delete()',
      '      SUM(cached_input_tokens)::bigint AS cached_input_tokens,',
      E'      SUM(unclassified_input_tokens)::bigint AS unclassified_input_tokens,\n      SUM(cached_input_tokens)::bigint AS cached_input_tokens,', 1),
    (23, 'leaderboard_rollup_total_v2_after_delete()',
      '    AND cache_creation_input_tokens = 0',
      E'    AND unclassified_input_tokens = 0\n    AND cache_creation_input_tokens = 0', 1),
    (24, 'refresh_tokentracker_device_identity(uuid,uuid,text,text)',
      '      cached_input_tokens,',
      E'      unclassified_input_tokens,\n      cached_input_tokens,', 1),
    (25, 'refresh_tokentracker_device_identity(uuid,uuid,text,text)',
      '      ranked.cached_input_tokens,',
      E'      ranked.unclassified_input_tokens,\n      ranked.cached_input_tokens,', 1),
    (26, 'refresh_tokentracker_device_identity(uuid,uuid,text,text)',
      '      cached_input_tokens = EXCLUDED.cached_input_tokens,',
      E'      unclassified_input_tokens = EXCLUDED.unclassified_input_tokens,\n      cached_input_tokens = EXCLUDED.cached_input_tokens,', 1),
    (27, 'leaderboard_usage_grouped(timestamptz,timestamptz)',
      '          SUM(u.cached_input_tokens)::bigint AS cached_input_tokens,',
      E'          SUM(u.unclassified_input_tokens)::bigint AS unclassified_input_tokens,\n          SUM(u.cached_input_tokens)::bigint AS cached_input_tokens,', 2),
    (28, 'leaderboard_usage_grouped(timestamptz,timestamptz)',
      '            r.cached_input_tokens, r.cache_creation_input_tokens,',
      E'            r.unclassified_input_tokens,\n            r.cached_input_tokens, r.cache_creation_input_tokens,', 2),
    (29, 'leaderboard_usage_grouped(timestamptz,timestamptz)',
      '            t.cached_input_tokens, t.cache_creation_input_tokens,',
      E'            t.unclassified_input_tokens,\n            t.cached_input_tokens, t.cache_creation_input_tokens,', 2),
    (30, 'leaderboard_usage_grouped(timestamptz,timestamptz)',
      '          FROM public.leaderboard_hourly_dedup_v2(v_cut, p_to) t',
      '          FROM public.leaderboard_hourly_dedup_v2_unclassified(v_cut, p_to) t', 2),
    (31, 'leaderboard_usage_grouped(timestamptz,timestamptz)',
      '        SUM(d.cached_input_tokens)::bigint AS cached_input_tokens,',
      E'        SUM(d.unclassified_input_tokens)::bigint AS unclassified_input_tokens,\n        SUM(d.cached_input_tokens)::bigint AS cached_input_tokens,', 1),
    (32, 'leaderboard_usage_grouped(timestamptz,timestamptz)',
      '      FROM public.leaderboard_hourly_dedup_v2(p_from, p_to) d',
      '      FROM public.leaderboard_hourly_dedup_v2_unclassified(p_from, p_to) d', 1),
    (33, 'leaderboard_usage_grouped_total_shard(timestamptz,uuid,uuid)',
      '      SUM(u.cached_input_tokens)::bigint AS cached_input_tokens,',
      E'      SUM(u.unclassified_input_tokens)::bigint AS unclassified_input_tokens,\n      SUM(u.cached_input_tokens)::bigint AS cached_input_tokens,', 1),
    (34, 'leaderboard_usage_grouped_total_shard(timestamptz,uuid,uuid)',
      '        r.cached_input_tokens, r.cache_creation_input_tokens,',
      E'        r.unclassified_input_tokens,\n        r.cached_input_tokens, r.cache_creation_input_tokens,', 1),
    (35, 'leaderboard_usage_grouped_total_shard(timestamptz,uuid,uuid)',
      '        t.cached_input_tokens, t.cache_creation_input_tokens,',
      E'        t.unclassified_input_tokens,\n        t.cached_input_tokens, t.cache_creation_input_tokens,', 1),
    (36, 'leaderboard_usage_grouped_total_shard(timestamptz,uuid,uuid)',
      '      FROM public.leaderboard_hourly_dedup_v2(v_cut, p_to) t',
      '      FROM public.leaderboard_hourly_dedup_v2_unclassified(v_cut, p_to) t', 1),
    (37, 'account_usage_grouped_cached(uuid,uuid,timestamptz,timestamptz,text,text,integer)',
      '    chr(31), ''v2-deepseek-time-pricing'', p_user_id::text,',
      '    chr(31), ''v3-unclassified-input'', p_user_id::text,', 1),
    (38, 'cloud_rebuild_device_usage_derived(uuid,date[])',
      'input_tokens,output_tokens,cached_input_tokens,',
      'input_tokens,output_tokens,unclassified_input_tokens,cached_input_tokens,', 1),
    (39, 'cloud_rebuild_device_usage_derived(uuid,date[])',
      'sum(d.output_tokens),sum(d.cached_input_tokens),',
      'sum(d.output_tokens),sum(d.unclassified_input_tokens),sum(d.cached_input_tokens),', 1),
    (40, 'cloud_rebuild_device_usage_derived(uuid,date[])',
      'public.leaderboard_hourly_dedup_v2(v_from,v_to)',
      'public.leaderboard_hourly_dedup_v2_unclassified(v_from,v_to)', 1),
    (41, 'cloud_rebuild_device_usage_derived(uuid,date[])',
      'output_tokens=excluded.output_tokens,',
      'output_tokens=excluded.output_tokens,unclassified_input_tokens=excluded.unclassified_input_tokens,', 1),
    (42, 'leaderboard_usage_pack(jsonb)',
      '''rows'', COALESCE((',
      '''unclassified_inputs'', COALESCE((SELECT jsonb_agg(COALESCE(e->''unclassified_input_tokens'', ''0''::jsonb) ORDER BY ord) FROM raw), ''[]''::jsonb), ''rows'', COALESCE((', 1),
    (43, 'account_summary_compact(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'COALESCE((e->>''input_tokens'')::bigint, 0) AS input_tokens,',
      'COALESCE((e->>''unclassified_input_tokens'')::bigint, 0) AS unclassified_input_tokens, COALESCE((e->>''input_tokens'')::bigint, 0) AS input_tokens,', 1),
    (44, 'account_summary_compact(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      '''active_days'', COUNT(DISTINCT bucket)',
      '''active_days'', COUNT(DISTINCT bucket), ''unclassified_input_tokens'', COALESCE(SUM(unclassified_input_tokens), 0)', 1),
    (45, 'account_daily_compact(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'COALESCE((e->>''input_tokens'')::bigint, 0) AS input_tokens,',
      'COALESCE((e->>''unclassified_input_tokens'')::bigint, 0) AS unclassified_input_tokens, COALESCE((e->>''input_tokens'')::bigint, 0) AS input_tokens,', 1),
    (46, 'account_daily_compact(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'SUM(reasoning_output_tokens) AS rs, SUM(conversations) AS cv',
      'SUM(reasoning_output_tokens) AS rs, SUM(conversations) AS cv, SUM(unclassified_input_tokens) AS u', 1),
    (47, 'account_daily_compact(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'd.rs, d.cv, m.mm)', 'd.rs, d.cv, m.mm, d.u)', 1),
    (48, 'account_model_breakdown_compact(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'COALESCE((e->>''input_tokens'')::bigint, 0) AS input_tokens,',
      'COALESCE((e->>''unclassified_input_tokens'')::bigint, 0) AS unclassified_input_tokens, COALESCE((e->>''input_tokens'')::bigint, 0) AS input_tokens,', 1),
    (49, 'account_model_breakdown_compact(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'SUM(reasoning_output_tokens) AS rs', 'SUM(reasoning_output_tokens) AS rs, SUM(unclassified_input_tokens) AS u', 1),
    (50, 'account_model_breakdown_compact(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'tt, i, o, cr, cw, rs)', 'tt, i, o, cr, cw, rs, u)', 1),
    (51, 'account_summary_wire(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'raw.j->''range_totals''->''active_days'')',
      'raw.j->''range_totals''->''active_days'', raw.j->''range_totals''->''unclassified_input_tokens'')', 1),
    (52, 'account_daily_wire(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      E'), ''[]''::jsonb) END\n    ) AS row FROM days',
      E'), ''[]''::jsonb) END, row->9\n    ) AS row FROM days', 1),
    (53, 'account_model_breakdown_wire(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'row->6, row->7, row->8) AS row', 'row->6, row->7, row->8, row->9) AS row', 1),
    (54, 'cloud_ingest_usage(text,text,jsonb,jsonb,text)',
      'source,model,input_tokens,', 'source,model,input_tokens,unclassified_input_tokens,', 1),
    (55, 'cloud_ingest_usage(text,text,jsonb,jsonb,text)',
      'x.source,x.model,x.input_tokens,', 'x.source,x.model,x.input_tokens,COALESCE(x.unclassified_input_tokens,0),', 1),
    (56, 'cloud_ingest_usage(text,text,jsonb,jsonb,text)',
      'model text,input_tokens bigint,cached_input_tokens bigint,',
      'model text,input_tokens bigint,unclassified_input_tokens bigint,cached_input_tokens bigint,', 1),
    (57, 'cloud_ingest_usage(text,text,jsonb,jsonb,text)',
      'input_tokens=excluded.input_tokens,cached_input_tokens=excluded.cached_input_tokens,',
      'input_tokens=excluded.input_tokens,unclassified_input_tokens=excluded.unclassified_input_tokens,cached_input_tokens=excluded.cached_input_tokens,', 1),
    (58, 'cloud_restore_usage_archive(uuid,uuid,uuid,date)',
      'SET input_tokens=c.input_tokens,cached_input_tokens=c.cached_input_tokens,',
      'SET input_tokens=c.input_tokens,unclassified_input_tokens=COALESCE(c.unclassified_input_tokens,0),cached_input_tokens=c.cached_input_tokens,', 1),
    (59, 'cloud_restore_usage_archive(uuid,uuid,uuid,date)',
      'source,model,hour_start,input_tokens,', 'source,model,hour_start,input_tokens,unclassified_input_tokens,', 1),
    (60, 'cloud_restore_usage_archive(uuid,uuid,uuid,date)',
      'c.model,c.hour_start,c.input_tokens,c.cached_input_tokens,',
      'c.model,c.hour_start,c.input_tokens,COALESCE(c.unclassified_input_tokens,0),c.cached_input_tokens,', 1)
  ) AS patches(step, signature, old_text, new_text, expected_matches)
  ORDER BY step
  LOOP
    IF signature IS DISTINCT FROM patch.signature THEN
      IF signature IS NOT NULL THEN EXECUTE definition; END IF;
      signature := patch.signature;
      IF to_regprocedure('public.' || signature) IS NULL THEN
        RAISE EXCEPTION 'Accounting v3 requires current main function %', signature;
      END IF;
      SELECT pg_get_functiondef(to_regprocedure('public.' || signature)) INTO definition;
    END IF;
    occurrences := (length(definition) - length(replace(definition, patch.old_text, ''))) / length(patch.old_text);
    IF occurrences <> patch.expected_matches THEN
      RAISE EXCEPTION 'Accounting v3 SQL shape drift in % (matches: %, expected: %)',
        signature, occurrences, patch.expected_matches;
    END IF;
    definition := replace(definition, patch.old_text, patch.new_text);
  END LOOP;
  IF signature IS NOT NULL THEN EXECUTE definition; END IF;
END
$integration$;

-- Advertise v3 only once all transactional ingest, compact and cold restore
-- paths above are installed. The edge fails closed against older databases.
CREATE OR REPLACE FUNCTION public.tokentracker_accounting_capabilities()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path TO public, pg_temp
AS $capabilities$
  SELECT jsonb_build_object('accounting_version', 3, 'unclassified_input_tokens', true)
$capabilities$;
REVOKE ALL ON FUNCTION public.tokentracker_accounting_capabilities() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokentracker_accounting_capabilities() TO project_admin;
