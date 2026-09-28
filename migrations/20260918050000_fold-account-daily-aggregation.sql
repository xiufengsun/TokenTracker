-- Same fold as 20260918041500, applied to account-daily.
--
-- daily is the one endpoint that genuinely needs a per-model dimension: it emits
-- a per-day total_cost_usd, and pricing depends on (source, model,
-- pricing_tier). So the cost dimension cannot collapse the way summary's and
-- model-breakdown's could. What it CAN drop is the JSON object keys: the old
-- payload repeated all eleven column names on every one of ~500 rows, which is
-- most of its bytes. Positional arrays plus a day-level rollup take a 30-day
-- window for a heavy account from ~146 KB to ~60 KB (-59%).
--
-- Two sections come back:
--   days:      [day, total, input, output, cache_read, cache_write, reasoning,
--               conversations, {model: tokens}] — one row per active local day,
--               carrying everything the response needs except cost.
--   cost_dims: [day, source, model, pricing_tier, input, output, cache_read,
--               cache_write, reasoning] — still per day, because each day prints
--               its own cost, but with the day's rows pre-summed per
--               (source, model, tier) and the key names gone.
--
-- Folding before pricing is exact here as elsewhere (computeRowCost is linear in
-- every token column). Checked on 368 (account, day) pairs from 12 real heavy
-- accounts: zero differences, including in the raw JSON number — daily emits
-- total_cost_usd unrounded, so any float drift would have been visible.

CREATE OR REPLACE FUNCTION public.account_daily_compact(
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
      COALESCE(NULLIF(e->>'model', ''), 'unknown') AS model_key,
      COALESCE((e->>'total_tokens')::bigint, 0) AS total_tokens,
      COALESCE((e->>'input_tokens')::bigint, 0) AS input_tokens,
      COALESCE((e->>'output_tokens')::bigint, 0) AS output_tokens,
      COALESCE((e->>'cached_input_tokens')::bigint, 0) AS cached_input_tokens,
      COALESCE((e->>'cache_creation_input_tokens')::bigint, 0) AS cache_creation_input_tokens,
      COALESCE((e->>'reasoning_output_tokens')::bigint, 0) AS reasoning_output_tokens,
      COALESCE((e->>'conversations')::bigint, 0) AS conversations
    FROM raw, jsonb_array_elements(raw.j) e
    WHERE e->>'bucket' >= p_range_from AND e->>'bucket' <= p_range_to
  ), per_day_model AS (
    SELECT bucket, model_key, SUM(total_tokens) AS mt
    FROM g GROUP BY bucket, model_key
  ), models AS (
    SELECT bucket, jsonb_object_agg(model_key, mt) AS mm
    FROM per_day_model GROUP BY bucket
  ), days AS (
    SELECT bucket,
      SUM(total_tokens) AS tt, SUM(input_tokens) AS i, SUM(output_tokens) AS o,
      SUM(cached_input_tokens) AS cr, SUM(cache_creation_input_tokens) AS cw,
      SUM(reasoning_output_tokens) AS rs, SUM(conversations) AS cv
    FROM g GROUP BY bucket
  ), cost AS (
    SELECT bucket, source, model, pricing_tier,
      SUM(input_tokens) AS i, SUM(output_tokens) AS o,
      SUM(cached_input_tokens) AS cr, SUM(cache_creation_input_tokens) AS cw,
      SUM(reasoning_output_tokens) AS rs
    FROM g GROUP BY bucket, source, model, pricing_tier
  )
  SELECT jsonb_build_object(
    'days', COALESCE(
      (SELECT jsonb_agg(jsonb_build_array(d.bucket, d.tt, d.i, d.o, d.cr, d.cw, d.rs, d.cv, m.mm)
                        ORDER BY d.bucket)
       FROM days d JOIN models m ON m.bucket = d.bucket),
      '[]'::jsonb),
    'cost_dims', COALESCE(
      (SELECT jsonb_agg(jsonb_build_array(bucket, source, model, pricing_tier, i, o, cr, cw, rs)
                        ORDER BY bucket, source, model, pricing_tier) FROM cost),
      '[]'::jsonb)
  )
$fn$;

-- Postgres grants EXECUTE to PUBLIC by default; without this an anon caller
-- could pass an arbitrary p_user_id and read another account's usage.
REVOKE ALL ON FUNCTION public.account_daily_compact(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_daily_compact(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) TO project_admin;
