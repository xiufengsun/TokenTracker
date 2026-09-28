-- Same fold as 20260918041500, applied to account-model-breakdown.
--
-- That endpoint groups by (source, model) and hardcodes `days: 0` — it never
-- had a day dimension in its output — yet it pulled one row per
-- (local day, source, model, pricing_tier) from account_usage_grouped_cached
-- and collapsed the days in Deno. At ~96.5k calls/day that detail was the
-- second-largest remaining source of edge-to-PostgREST egress after summary and
-- heatmap were folded.
--
-- pricing_tier stays in the grouping key because DeepSeek V4 peak/off_peak rows
-- for the same (source, model) price differently; the edge re-splits them and
-- sums the two costs into one model entry, exactly as it did per day.
--
-- Cost is still computed on the edge, where the price table lives. Since
-- getRowPricing depends only on (source, model, pricing_tier) and the cost
-- expression is linear in each token column, pricing the day-folded rows equals
-- pricing each day and summing.

CREATE OR REPLACE FUNCTION public.account_model_breakdown_compact(
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
      COALESCE((e->>'reasoning_output_tokens')::bigint, 0) AS reasoning_output_tokens
    FROM raw, jsonb_array_elements(raw.j) e
  ), dims AS (
    SELECT source, model, pricing_tier,
      SUM(total_tokens) AS tt,
      SUM(input_tokens) AS i,
      SUM(output_tokens) AS o,
      SUM(cached_input_tokens) AS cr,
      SUM(cache_creation_input_tokens) AS cw,
      SUM(reasoning_output_tokens) AS rs
    FROM g
    WHERE bucket >= p_range_from AND bucket <= p_range_to
    GROUP BY source, model, pricing_tier
  )
  SELECT COALESCE(
    (SELECT jsonb_agg(jsonb_build_array(source, model, pricing_tier, tt, i, o, cr, cw, rs)
                      ORDER BY source, model, pricing_tier) FROM dims),
    '[]'::jsonb)
$fn$;

-- Postgres grants EXECUTE to PUBLIC by default; without this an anon caller
-- could pass an arbitrary p_user_id and read another account's usage.
REVOKE ALL ON FUNCTION public.account_model_breakdown_compact(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_model_breakdown_compact(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) TO project_admin;
