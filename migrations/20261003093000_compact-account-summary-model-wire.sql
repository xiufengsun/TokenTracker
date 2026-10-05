-- Expand dictionary/positional rows at the edge before existing pricing and
-- output logic. Delegate to legacy aggregation once, preserving device scope,
-- shared cache and timezone semantics. JSONB token values retain their types.
-- Trim only numeric trailing zeros; fall back to legacy payloads when smaller.

CREATE OR REPLACE FUNCTION public.account_summary_wire(
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

  WITH raw AS MATERIALIZED (SELECT public.account_summary_compact(p_user_id, p_device_id, p_from, p_to, p_tz, p_offset_min, p_range_from, p_range_to) AS j),
  dims AS (
    SELECT value AS row, ordinality AS ord
    FROM raw, jsonb_array_elements(raw.j->'cost_dims') WITH ORDINALITY
  ), sources AS (
    SELECT name, row_number() OVER (ORDER BY name) - 1 AS idx
    FROM (SELECT DISTINCT row->0 AS name FROM dims) names
  ), models AS (
    SELECT name, row_number() OVER (ORDER BY name) - 1 AS idx
    FROM (SELECT DISTINCT row->1 AS name FROM dims) names
  ), tiers AS (
    SELECT name, row_number() OVER (ORDER BY name) - 1 AS idx
    FROM (SELECT DISTINCT row->2 AS name FROM dims) names
  ), indexed AS (
    SELECT ord, jsonb_build_array(s.idx, m.idx, t.idx, row->3, row->4, row->5, row->6, row->7) AS row
    FROM dims
    JOIN sources s ON s.name = row->0
    JOIN models m ON m.name = row->1
    JOIN tiers t ON t.name = row->2
  ), packed_dims AS (
    SELECT ord, (
      SELECT jsonb_agg(value ORDER BY token_ord)
      FROM jsonb_array_elements(row) WITH ORDINALITY AS tokens(value, token_ord)
      WHERE token_ord <= GREATEST(3, COALESCE((
        SELECT MAX(last_ord)
        FROM jsonb_array_elements(row) WITH ORDINALITY AS last_value(value, last_ord)
        WHERE last_value.value <> '0'::jsonb
      ), 3))
    ) AS row FROM indexed
  ), days AS (
    SELECT value AS row, ordinality AS ord
    FROM raw, jsonb_array_elements(raw.j->'day_rollup') WITH ORDINALITY
  ), day_start AS (
    SELECT MIN(row->>0) AS day FROM days
  ), packed_days AS (
    SELECT ord, jsonb_build_array((row->>0)::date - day::date, row->1, row->2) AS row
    FROM days CROSS JOIN day_start
  ), candidate AS (
    SELECT jsonb_build_object(
      'source_names', COALESCE((SELECT jsonb_agg(name ORDER BY idx) FROM sources), '[]'::jsonb),
      'model_names', COALESCE((SELECT jsonb_agg(name ORDER BY idx) FROM models), '[]'::jsonb),
      'pricing_tiers', COALESCE((SELECT jsonb_agg(name ORDER BY idx) FROM tiers), '[]'::jsonb),
      'cost_dims', COALESCE((SELECT jsonb_agg(row ORDER BY ord) FROM packed_dims), '[]'::jsonb),
      'day_start', (SELECT day FROM day_start),
      'day_rollup', COALESCE((SELECT jsonb_agg(row ORDER BY ord) FROM packed_days), '[]'::jsonb),
      'range_totals', jsonb_build_array(raw.j->'range_totals'->'total_tokens', raw.j->'range_totals'->'input_tokens', raw.j->'range_totals'->'output_tokens', raw.j->'range_totals'->'cached_input_tokens', raw.j->'range_totals'->'cache_creation_input_tokens', raw.j->'range_totals'->'reasoning_output_tokens', raw.j->'range_totals'->'conversation_count', raw.j->'range_totals'->'active_days')
    ) AS wire FROM raw
  )
  SELECT CASE WHEN octet_length(wire::text) < octet_length(raw.j::text)
    THEN wire ELSE raw.j END
  FROM candidate CROSS JOIN raw
$fn$;

CREATE OR REPLACE FUNCTION public.account_model_breakdown_wire(
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

  WITH raw AS MATERIALIZED (SELECT public.account_model_breakdown_compact(p_user_id, p_device_id, p_from, p_to, p_tz, p_offset_min, p_range_from, p_range_to) AS j),
  dims AS (
    SELECT value AS row, ordinality AS ord
    FROM raw, jsonb_array_elements(raw.j) WITH ORDINALITY
  ), sources AS (
    SELECT name, row_number() OVER (ORDER BY name) - 1 AS idx
    FROM (SELECT DISTINCT row->0 AS name FROM dims) names
  ), models AS (
    SELECT name, row_number() OVER (ORDER BY name) - 1 AS idx
    FROM (SELECT DISTINCT row->1 AS name FROM dims) names
  ), tiers AS (
    SELECT name, row_number() OVER (ORDER BY name) - 1 AS idx
    FROM (SELECT DISTINCT row->2 AS name FROM dims) names
  ), indexed AS (
    SELECT ord, jsonb_build_array(s.idx, m.idx, t.idx, row->3, row->4, row->5, row->6, row->7, row->8) AS row
    FROM dims
    JOIN sources s ON s.name = row->0
    JOIN models m ON m.name = row->1
    JOIN tiers t ON t.name = row->2
  ), packed_dims AS (
    SELECT ord, (
      SELECT jsonb_agg(value ORDER BY token_ord)
      FROM jsonb_array_elements(row) WITH ORDINALITY AS tokens(value, token_ord)
      WHERE token_ord <= GREATEST(3, COALESCE((
        SELECT MAX(last_ord)
        FROM jsonb_array_elements(row) WITH ORDINALITY AS last_value(value, last_ord)
        WHERE last_value.value <> '0'::jsonb
      ), 3))
    ) AS row FROM indexed
  ), candidate AS (
    SELECT jsonb_build_object(
      'source_names', COALESCE((SELECT jsonb_agg(name ORDER BY idx) FROM sources), '[]'::jsonb),
      'model_names', COALESCE((SELECT jsonb_agg(name ORDER BY idx) FROM models), '[]'::jsonb),
      'pricing_tiers', COALESCE((SELECT jsonb_agg(name ORDER BY idx) FROM tiers), '[]'::jsonb),
      'dims', COALESCE((SELECT jsonb_agg(row ORDER BY ord) FROM packed_dims), '[]'::jsonb)
    ) AS wire FROM raw
  )
  SELECT CASE WHEN octet_length(wire::text) < octet_length(raw.j::text)
    THEN wire ELSE raw.j END
  FROM candidate CROSS JOIN raw
$fn$;

REVOKE EXECUTE ON FUNCTION public.account_summary_wire(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_summary_wire(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) TO project_admin;
REVOKE EXECUTE ON FUNCTION public.account_model_breakdown_wire(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_model_breakdown_wire(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) TO project_admin;
