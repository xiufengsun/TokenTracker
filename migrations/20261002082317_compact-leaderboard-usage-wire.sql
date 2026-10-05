-- Keep the existing aggregation and TypeScript pricing. Only the internal
-- database-to-edge representation changes: repeated keys and dimension names
-- become positional rows and dictionaries. The legacy RPCs remain available.

CREATE OR REPLACE FUNCTION public.leaderboard_usage_pack(p_rows jsonb)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET work_mem TO '48MB'
SET hash_mem_multiplier TO '2'
AS $func$
  WITH raw AS MATERIALIZED (
    SELECT e, ord,
      COALESCE(e->'user_id', 'null'::jsonb) AS u,
      COALESCE(e->'source', 'null'::jsonb) AS s,
      COALESCE(e->'model', 'null'::jsonb) AS m,
      COALESCE(e->'pricing_tier', 'null'::jsonb) AS p
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS entries(e, ord)
  ), users AS MATERIALIZED (
    SELECT u, (row_number() OVER (ORDER BY u) - 1)::integer AS i
    FROM (SELECT DISTINCT u FROM raw) d
  ), sources AS MATERIALIZED (
    SELECT s, (row_number() OVER (ORDER BY s) - 1)::integer AS i
    FROM (SELECT DISTINCT s FROM raw) d
  ), models AS MATERIALIZED (
    SELECT m, (row_number() OVER (ORDER BY m) - 1)::integer AS i
    FROM (SELECT DISTINCT m FROM raw) d
  ), tiers AS MATERIALIZED (
    SELECT p, (row_number() OVER (ORDER BY p) - 1)::integer AS i
    FROM (SELECT DISTINCT p FROM raw) d
  )
  SELECT jsonb_build_object(
    'format', 'leaderboard-usage-v1',
    'user_ids', COALESCE((SELECT jsonb_agg(u ORDER BY i) FROM users), '[]'::jsonb),
    'sources', COALESCE((SELECT jsonb_agg(s ORDER BY i) FROM sources), '[]'::jsonb),
    'model_names', COALESCE((SELECT jsonb_agg(m ORDER BY i) FROM models), '[]'::jsonb),
    'pricing_tiers', COALESCE((SELECT jsonb_agg(p ORDER BY i) FROM tiers), '[]'::jsonb),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_array(
        u.i, s.i, m.i, p.i,
        r.e->'total_tokens', r.e->'input_tokens', r.e->'output_tokens',
        r.e->'cached_input_tokens', r.e->'cache_creation_input_tokens',
        r.e->'reasoning_output_tokens', r.e->'total_cost_usd'
      ) ORDER BY r.ord)
      FROM raw r
      JOIN users u ON u.u = r.u
      JOIN sources s ON s.s = r.s
      JOIN models m ON m.m = r.m
      JOIN tiers p ON p.p = r.p
    ), '[]'::jsonb)
  )
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_usage_compact(
  p_from timestamptz,
  p_to timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '25s'
AS $func$
  SELECT public.leaderboard_usage_pack(public.leaderboard_usage_grouped(p_from, p_to))
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_usage_compact_total_shard(
  p_to timestamptz,
  p_user_from uuid,
  p_user_to uuid
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '8s'
AS $func$
  SELECT public.leaderboard_usage_pack(
    public.leaderboard_usage_grouped_total_shard(p_to, p_user_from, p_user_to)
  )
$func$;

REVOKE ALL ON FUNCTION public.leaderboard_usage_pack(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leaderboard_usage_compact(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leaderboard_usage_compact_total_shard(timestamptz, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_usage_pack(jsonb) TO project_admin;
GRANT EXECUTE ON FUNCTION public.leaderboard_usage_compact(timestamptz, timestamptz)
  TO project_admin;
GRANT EXECUTE ON FUNCTION public.leaderboard_usage_compact_total_shard(timestamptz, uuid, uuid)
  TO project_admin;
