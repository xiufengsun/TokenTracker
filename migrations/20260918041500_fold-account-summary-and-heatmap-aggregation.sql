-- Stop shipping per-row detail to the edge just to be summed and thrown away.
--
-- account-summary and account-heatmap both called account_usage_grouped_cached()
-- and received one row per (local day, source, model, pricing_tier) with eight
-- token columns each, then folded that down in Deno. Neither endpoint ever
-- emitted those rows: summary emits totals, a day count and two rolling
-- windows; heatmap emits one cell per day. For a heavy account a 52-week
-- heatmap moved ~400 KB across the wire to render ~45 KB, and a 30-day summary
-- moved ~99 KB to render a few hundred bytes.
--
-- That transfer dominated the project's egress bill: access logs showed
-- account_usage_grouped_cached alone at 74% of all egress bytes, and
-- edge-to-PostgREST traffic at 83% of the total, on the way to ~1.1 TB against a
-- 250 GB allowance.
--
-- Both functions below delegate to account_usage_grouped_cached() unchanged, so
-- they inherit its 30-second shared cache, its advisory-lock cold fill and its
-- cross-device dedup semantics byte for byte. The only thing that moves is where
-- the rollup happens. Range filtering (p_range_from / p_range_to, inclusive
-- local-day strings) moves in here too, matching the string comparison the edge
-- functions used to do in JS.
--
-- Cost is deliberately NOT computed here. The model price table lives in the
-- five edge functions (see test/edge-pricing-parity.test.js) and must not gain a
-- sixth copy in SQL. account_summary_compact returns cost_dims: the token
-- columns summed per (source, model, pricing_tier), which is every dimension
-- pricing depends on. computeRowCost is linear in each token column, so pricing
-- the day-folded dims equals pricing each day and summing. Verified against the
-- per-day path on 12 real heavy accounts: worst relative difference 8.5e-16
-- (double epsilon), zero differences at the emitted toFixed(6).

CREATE OR REPLACE FUNCTION public.account_summary_compact(
  p_user_id uuid,
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_tz text,
  p_offset_min integer,
  p_range_from text,
  p_range_to text
) RETURNS jsonb
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '8s'
AS $fn$
  WITH raw AS (
    SELECT public.account_usage_grouped_cached(
      p_user_id, p_device_id, p_from, p_to, 'day', p_tz, p_offset_min
    ) AS j
  ), g AS (
    SELECT
      e->>'bucket' AS bucket,
      e->>'source' AS source,
      e->>'model' AS model,
      e->>'pricing_tier' AS pricing_tier,
      COALESCE((e->>'total_tokens')::bigint, 0) AS total_tokens,
      COALESCE((e->>'input_tokens')::bigint, 0) AS input_tokens,
      COALESCE((e->>'output_tokens')::bigint, 0) AS output_tokens,
      COALESCE((e->>'cached_input_tokens')::bigint, 0) AS cached_input_tokens,
      COALESCE((e->>'cache_creation_input_tokens')::bigint, 0) AS cache_creation_input_tokens,
      COALESCE((e->>'reasoning_output_tokens')::bigint, 0) AS reasoning_output_tokens,
      COALESCE((e->>'conversations')::bigint, 0) AS conversations
    FROM raw, jsonb_array_elements(raw.j) e
  ), in_range AS (
    SELECT * FROM g WHERE bucket >= p_range_from AND bucket <= p_range_to
  ), dims AS (
    SELECT source, model, pricing_tier,
      SUM(input_tokens) AS i,
      SUM(output_tokens) AS o,
      SUM(cached_input_tokens) AS cr,
      SUM(cache_creation_input_tokens) AS cw,
      SUM(reasoning_output_tokens) AS rs
    FROM in_range
    GROUP BY source, model, pricing_tier
  ), days AS (
    SELECT bucket, SUM(total_tokens) AS t, SUM(conversations) AS c
    FROM g GROUP BY bucket
  )
  SELECT jsonb_build_object(
    'cost_dims', COALESCE(
      (SELECT jsonb_agg(jsonb_build_array(source, model, pricing_tier, i, o, cr, cw, rs)
                        ORDER BY source, model, pricing_tier) FROM dims),
      '[]'::jsonb),
    'day_rollup', COALESCE(
      (SELECT jsonb_agg(jsonb_build_array(bucket, t, c) ORDER BY bucket) FROM days),
      '[]'::jsonb),
    'range_totals', (SELECT jsonb_build_object(
        'total_tokens', COALESCE(SUM(total_tokens), 0),
        'input_tokens', COALESCE(SUM(input_tokens), 0),
        'output_tokens', COALESCE(SUM(output_tokens), 0),
        'cached_input_tokens', COALESCE(SUM(cached_input_tokens), 0),
        'cache_creation_input_tokens', COALESCE(SUM(cache_creation_input_tokens), 0),
        'reasoning_output_tokens', COALESCE(SUM(reasoning_output_tokens), 0),
        'conversation_count', COALESCE(SUM(conversations), 0),
        'active_days', COUNT(DISTINCT bucket)
      ) FROM in_range)
  )
$fn$;

-- One [day, total_tokens, {model: tokens}] triple per active local day. The
-- NULL/empty model folds to 'unknown' here, exactly as the edge's
-- String(row.model || "unknown") used to.
CREATE OR REPLACE FUNCTION public.account_heatmap_compact(
  p_user_id uuid,
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_tz text,
  p_offset_min integer,
  p_range_from text,
  p_range_to text
) RETURNS jsonb
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '8s'
AS $fn$
  WITH raw AS (
    SELECT public.account_usage_grouped_cached(
      p_user_id, p_device_id, p_from, p_to, 'day', p_tz, p_offset_min
    ) AS j
  ), g AS (
    SELECT
      e->>'bucket' AS bucket,
      COALESCE(NULLIF(e->>'model', ''), 'unknown') AS model,
      COALESCE((e->>'total_tokens')::bigint, 0) AS tt
    FROM raw, jsonb_array_elements(raw.j) e
    WHERE e->>'bucket' >= p_range_from AND e->>'bucket' <= p_range_to
  ), per_model AS (
    SELECT bucket, model, SUM(tt) AS mt
    FROM g GROUP BY bucket, model
  ), per_day AS (
    SELECT bucket, SUM(mt) AS t, jsonb_object_agg(model, mt) AS models
    FROM per_model GROUP BY bucket
  )
  SELECT COALESCE(
    (SELECT jsonb_agg(jsonb_build_array(bucket, t, models) ORDER BY bucket) FROM per_day),
    '[]'::jsonb)
$fn$;

-- Postgres grants EXECUTE to PUBLIC by default, which would let any anon caller
-- pass an arbitrary p_user_id and read another account's usage. Match the
-- account_usage_grouped_cached ACL exactly: project_admin only, which is the
-- role the edge functions connect as.
REVOKE ALL ON FUNCTION public.account_summary_compact(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_heatmap_compact(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_summary_compact(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) TO project_admin;
GRANT EXECUTE ON FUNCTION public.account_heatmap_compact(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) TO project_admin;
