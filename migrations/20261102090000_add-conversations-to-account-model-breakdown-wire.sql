-- Issue #990: the account model breakdown dropped request counts.
--
-- account_model_breakdown_compact() was folded from the per-day rows one
-- measure short of its siblings: it groups by (source, model, pricing_tier)
-- but never carried `conversations`, so the edge had to hardcode
-- conversations: 0. Every request-only row (0 tokens, N requests — e.g.
-- credit-billed Qoder transcripts) then vanished from tokentracker.cc model
-- breakdowns, while the local CLI kept surfacing them (#948). The summary
-- compact (20260918041500) folds SUM(conversations) the same way, and the
-- ingest upsert already replaces whole rows including conversations.
--
-- The wire wrapper packs the conversations value as token index 9. Its
-- trailing-zero trim keeps a row 9 tokens long whenever conversations is
-- zero, so an edge deployment that predates this migration decodes new
-- payloads unchanged — and the edge decoder defaults out-of-range tokens
-- to 0 in the opposite deployment order.

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
      COALESCE((e->>'reasoning_output_tokens')::bigint, 0) AS reasoning_output_tokens,
      COALESCE((e->>'conversations')::bigint, 0) AS conversations
    FROM raw, jsonb_array_elements(raw.j) e
  ), dims AS (
    SELECT source, model, pricing_tier,
      SUM(total_tokens) AS tt,
      SUM(input_tokens) AS i,
      SUM(output_tokens) AS o,
      SUM(cached_input_tokens) AS cr,
      SUM(cache_creation_input_tokens) AS cw,
      SUM(reasoning_output_tokens) AS rs,
      SUM(conversations) AS cv
    FROM g
    WHERE bucket >= p_range_from AND bucket <= p_range_to
    GROUP BY source, model, pricing_tier
  )
  SELECT COALESCE(
    (SELECT jsonb_agg(jsonb_build_array(source, model, pricing_tier, tt, i, o, cr, cw, rs, cv)
                      ORDER BY source, model, pricing_tier) FROM dims),
    '[]'::jsonb)
$fn$;

-- Postgres grants EXECUTE to PUBLIC by default; without this an anon caller
-- could pass an arbitrary p_user_id and read another account's usage.
REVOKE ALL ON FUNCTION public.account_model_breakdown_compact(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_model_breakdown_compact(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) TO project_admin;

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
    SELECT ord, jsonb_build_array(s.idx, m.idx, t.idx, row->3, row->4, row->5, row->6, row->7, row->8, row->9) AS row
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

REVOKE EXECUTE ON FUNCTION public.account_model_breakdown_wire(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_model_breakdown_wire(uuid, uuid, timestamptz, timestamptz, text, integer, text, text) TO project_admin;
