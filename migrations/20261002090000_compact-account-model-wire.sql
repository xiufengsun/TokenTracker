-- Dictionary encoding changes only the database-to-edge payload. Existing
-- compact RPCs retain their aggregation, cache, timezone and dedup semantics.
-- Token values stay JSONB values, so numeric strings and large integers do not
-- pass through a floating-point conversion. Each row keeps its original order.
-- The edge expands these payloads before its existing pricing/output logic.

CREATE OR REPLACE FUNCTION public.account_heatmap_wire(
  p_user_id uuid,
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_tz text,
  p_offset_min integer,
  p_range_from text,
  p_range_to text
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '8s'
AS $fn$

  WITH raw AS MATERIALIZED (SELECT public.account_heatmap_compact(p_user_id, p_device_id, p_from, p_to, p_tz, p_offset_min, p_range_from, p_range_to) AS j),
  days AS (
    SELECT value AS row, ordinality AS day_ord
    FROM raw, jsonb_array_elements(raw.j) WITH ORDINALITY
  ), names AS (
    SELECT DISTINCT to_jsonb(key) AS name
    FROM days, jsonb_each(COALESCE(NULLIF(row->2, 'null'::jsonb), '{}'::jsonb))
  ), dictionary AS (
    SELECT name, row_number() OVER (ORDER BY name) - 1 AS idx FROM names
  ), packed_days AS (
    SELECT day_ord, jsonb_build_array(row->0, row->1,
      CASE WHEN row->2 = 'null'::jsonb THEN 'null'::jsonb ELSE COALESCE((
        SELECT jsonb_agg(v ORDER BY model_ord, part)
        FROM jsonb_each(row->2) WITH ORDINALITY AS m(name, tokens, model_ord)
        JOIN dictionary d ON d.name = to_jsonb(m.name)
        CROSS JOIN LATERAL (VALUES (0, to_jsonb(d.idx)), (1, m.tokens)) AS pairs(part, v)
      ), '[]'::jsonb) END
    ) AS row FROM days
  )
  SELECT jsonb_build_object(
    'model_names', COALESCE((SELECT jsonb_agg(name ORDER BY idx) FROM dictionary), '[]'::jsonb),
    'days', COALESCE((SELECT jsonb_agg(row ORDER BY day_ord) FROM packed_days), '[]'::jsonb)
  )
$fn$;

CREATE OR REPLACE FUNCTION public.account_daily_wire(
  p_user_id uuid,
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_tz text,
  p_offset_min integer,
  p_range_from text,
  p_range_to text
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '8s'
AS $fn$

  WITH raw AS MATERIALIZED (SELECT public.account_daily_compact(p_user_id, p_device_id, p_from, p_to, p_tz, p_offset_min, p_range_from, p_range_to) AS j),
  days AS (
    SELECT value AS row, ordinality AS day_ord
    FROM raw, jsonb_array_elements(raw.j->'days') WITH ORDINALITY
  ), cost AS (
    SELECT value AS row, ordinality AS cost_ord
    FROM raw, jsonb_array_elements(raw.j->'cost_dims') WITH ORDINALITY
  ), model_names AS (
    SELECT to_jsonb(key) AS name
    FROM days, jsonb_each(COALESCE(NULLIF(row->8, 'null'::jsonb), '{}'::jsonb))
    UNION SELECT row->2 FROM cost
  ), models AS (
    SELECT name, row_number() OVER (ORDER BY name) - 1 AS idx FROM model_names
  ), sources AS (
    SELECT name, row_number() OVER (ORDER BY name) - 1 AS idx
    FROM (SELECT DISTINCT row->1 AS name FROM cost) names
  ), tiers AS (
    SELECT name, row_number() OVER (ORDER BY name) - 1 AS idx
    FROM (SELECT DISTINCT row->3 AS name FROM cost) names
  ), packed_days AS (
    SELECT day_ord, jsonb_build_array(
      row->0, row->1, row->2, row->3, row->4, row->5, row->6, row->7,
      CASE WHEN row->8 = 'null'::jsonb THEN 'null'::jsonb ELSE COALESCE((
        SELECT jsonb_agg(v ORDER BY model_ord, part)
        FROM jsonb_each(row->8) WITH ORDINALITY AS m(name, tokens, model_ord)
        JOIN models d ON d.name = to_jsonb(m.name)
        CROSS JOIN LATERAL (VALUES (0, to_jsonb(d.idx)), (1, m.tokens)) AS pairs(part, v)
      ), '[]'::jsonb) END
    ) AS row FROM days
  ), packed_cost AS (
    SELECT cost_ord, jsonb_build_array(
      row->0, s.idx, m.idx, t.idx, row->4, row->5, row->6, row->7, row->8
    ) AS row FROM cost
    JOIN sources s ON s.name = row->1
    JOIN models m ON m.name = row->2
    JOIN tiers t ON t.name = row->3
  )
  SELECT jsonb_build_object(
    'model_names', COALESCE((SELECT jsonb_agg(name ORDER BY idx) FROM models), '[]'::jsonb),
    'source_names', COALESCE((SELECT jsonb_agg(name ORDER BY idx) FROM sources), '[]'::jsonb),
    'pricing_tiers', COALESCE((SELECT jsonb_agg(name ORDER BY idx) FROM tiers), '[]'::jsonb),
    'days', COALESCE((SELECT jsonb_agg(row ORDER BY day_ord) FROM packed_days), '[]'::jsonb),
    'cost_dims', COALESCE((SELECT jsonb_agg(row ORDER BY cost_ord) FROM packed_cost), '[]'::jsonb)
  )
$fn$;

-- Match the existing account RPCs: only the edge's project_admin role can read
-- another user's account data. Do not change any existing RPC permissions.
REVOKE EXECUTE ON FUNCTION public.account_heatmap_wire(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_heatmap_wire(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) TO project_admin;
REVOKE EXECUTE ON FUNCTION public.account_daily_wire(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_daily_wire(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) TO project_admin;
