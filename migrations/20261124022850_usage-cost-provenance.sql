-- Additive InsForge/PostgreSQL contract. No history rewrite or rollup rebuild.
BEGIN;
CREATE SCHEMA IF NOT EXISTS tokentracker_private;
REVOKE ALL ON SCHEMA tokentracker_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA tokentracker_private TO project_admin;

CREATE OR REPLACE FUNCTION tokentracker_private.valid_cost_coverage(
  v jsonb, p_source text, p_model text, p_cost numeric,
  p_input bigint, p_cached bigint, p_cache_write bigint, p_output bigint, p_reasoning bigint
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $fn$
DECLARE k text; n numeric; tokens jsonb;
BEGIN
  IF v IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(v) <> 'object' OR v->'version' IS DISTINCT FROM '1'::jsonb
    OR p_source IS NULL OR p_model IS NULL OR NOT (p_source='grok' OR (p_source='cursor' AND lower(p_model) LIKE 'grok-bot-%'))
    OR (SELECT count(*) FROM jsonb_object_keys(v)) <> 7
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(v) x(k) WHERE x.k NOT IN
      ('version','reported_usd','reported_events','missing_events','allocated_events','origins','unreported_tokens'))
    OR jsonb_typeof(v->'origins') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v->'unreported_tokens') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['reported_usd','reported_events','missing_events','allocated_events'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    n := (v->>k)::numeric;
    IF n<0 OR n>9007199254740991 OR (k<>'reported_usd' AND n<>trunc(n)) THEN RETURN false; END IF;
  END LOOP;
  IF (v->>'allocated_events')::numeric > (v->>'reported_events')::numeric
    OR ((v->>'reported_events')::numeric=0 AND (v->>'reported_usd')::numeric<>0)
    OR p_cost IS NULL OR p_cost<0 OR abs((v->>'reported_usd')::numeric-p_cost)>0.00000001
    OR ((v->>'allocated_events')::numeric>0 AND NOT (v->'origins' ? 'grok_allocated'))
    OR jsonb_array_length(v->'origins')>5
    OR ((v->>'reported_events')::numeric>0 AND jsonb_array_length(v->'origins')=0)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(v->'origins') x(e) WHERE jsonb_typeof(e)<>'string'
      OR e#>>'{}' NOT IN ('grok_ticks','grok_usd','grok_allocated','cursor_csv_cost','cursor_total_cents')
      OR (p_source='cursor' AND e#>>'{}' NOT IN ('cursor_csv_cost','cursor_total_cents'))
      OR (p_source='grok' AND e#>>'{}' NOT IN ('grok_ticks','grok_usd','grok_allocated')))
    OR (SELECT count(DISTINCT e) FROM jsonb_array_elements(v->'origins') x(e))<>jsonb_array_length(v->'origins')
    THEN RETURN false; END IF;
  tokens := jsonb_build_object('input_tokens',coalesce(p_input,0),'cached_input_tokens',coalesce(p_cached,0),
    'cache_creation_input_tokens',coalesce(p_cache_write,0),'output_tokens',coalesce(p_output,0),
    'reasoning_output_tokens',coalesce(p_reasoning,0));
  IF (SELECT count(*) FROM jsonb_object_keys(v->'unreported_tokens'))<>5 THEN RETURN false; END IF;
  FOR k IN SELECT jsonb_object_keys(tokens) LOOP
    IF jsonb_typeof(v->'unreported_tokens'->k) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    n := (v->'unreported_tokens'->>k)::numeric;
    IF n<0 OR n<>trunc(n) OR n>(tokens->>k)::numeric OR n>9007199254740991
      OR ((v->>'missing_events')::numeric=0 AND n<>0)
      OR ((v->>'reported_events')::numeric=0 AND n<>(tokens->>k)::numeric) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION tokentracker_private.valid_cost_coverage(jsonb,text,text,numeric,bigint,bigint,bigint,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION tokentracker_private.valid_cost_coverage(jsonb,text,text,numeric,bigint,bigint,bigint,bigint,bigint) TO project_admin;

ALTER TABLE public.tokentracker_hourly ADD COLUMN IF NOT EXISTS cost_coverage jsonb;
DO $block$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.tokentracker_hourly'::regclass AND conname='usage_cost_coverage_v1') THEN
    ALTER TABLE public.tokentracker_hourly ADD CONSTRAINT usage_cost_coverage_v1 CHECK (
      tokentracker_private.valid_cost_coverage(cost_coverage,source,model,total_cost_usd,
        input_tokens,cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens)
    ) NOT VALID;
  END IF;
END $block$;

-- Patch only these installed statement fragments, keeping unrelated production
-- fixes, function OIDs and ACLs. Unexpected baselines fail transactionally.
DO $patch$
DECLARE def text; old text; replacement text; patches text[][]; pair text[];
BEGIN
  def := pg_get_functiondef('public.cloud_ingest_usage(text,text,jsonb,jsonb,text)'::regprocedure);
    patches := ARRAY[
      ARRAY['billable_total_tokens,total_cost_usd,conversations,updated_at)','billable_total_tokens,total_cost_usd,cost_coverage,conversations,updated_at)'],
      ARRAY['x.billable_total_tokens,x.total_cost_usd,x.conversations,v_now','x.billable_total_tokens,x.total_cost_usd,x.cost_coverage,x.conversations,v_now'],
      ARRAY['billable_total_tokens bigint,total_cost_usd numeric,conversations integer)','billable_total_tokens bigint,total_cost_usd numeric,cost_coverage jsonb,conversations integer)'],
      ARRAY['billable_total_tokens=excluded.billable_total_tokens,total_cost_usd=excluded.total_cost_usd,','billable_total_tokens=excluded.billable_total_tokens,total_cost_usd=excluded.total_cost_usd,cost_coverage=excluded.cost_coverage,']
    ];
    FOREACH pair SLICE 1 IN ARRAY patches LOOP
      old:=pair[1]; replacement:=pair[2];
      IF strpos(def,replacement)>0 THEN
        IF (length(def)-length(replace(def,replacement,'')))/length(replacement)<>1 THEN RAISE EXCEPTION 'Ambiguous cloud ingest cost baseline'; END IF;
      ELSE
        IF (length(def)-length(replace(def,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'Unexpected cloud ingest baseline; cost migration not applied'; END IF;
        def:=replace(def,old,replacement);
      END IF;
    END LOOP;
    EXECUTE def;
  IF to_regprocedure('public.cloud_restore_usage_archive(uuid,uuid,uuid,date)') IS NOT NULL THEN
  def := pg_get_functiondef('public.cloud_restore_usage_archive(uuid,uuid,uuid,date)'::regprocedure);
    patches := ARRAY[
      ARRAY['created_at=c.created_at,updated_at=c.updated_at,total_cost_usd=c.total_cost_usd','created_at=c.created_at,updated_at=c.updated_at,total_cost_usd=c.total_cost_usd,cost_coverage=c.cost_coverage'],
      ARRAY['billable_total_tokens,conversations,created_at,updated_at,total_cost_usd)','billable_total_tokens,conversations,created_at,updated_at,total_cost_usd,cost_coverage)'],
      ARRAY['c.billable_total_tokens,c.conversations,c.created_at,c.updated_at,c.total_cost_usd','c.billable_total_tokens,c.conversations,c.created_at,c.updated_at,c.total_cost_usd,c.cost_coverage']
    ];
    FOREACH pair SLICE 1 IN ARRAY patches LOOP
      old:=pair[1]; replacement:=pair[2];
      IF strpos(def,replacement)>0 THEN
        IF (length(def)-length(replace(def,replacement,'')))/length(replacement)<>1 THEN RAISE EXCEPTION 'Ambiguous archive restore cost baseline'; END IF;
      ELSE
        IF (length(def)-length(replace(def,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'Unexpected archive restore baseline; cost migration not applied'; END IF;
        def:=replace(def,old,replacement);
      END IF;
    END LOOP;
    EXECUTE def;
  ELSIF to_regclass('public.tokentracker_usage_archive_manifest') IS NOT NULL
     OR to_regclass('public.tokentracker_usage_archive_generations') IS NOT NULL THEN
    RAISE EXCEPTION 'Incomplete archive baseline; cost migration not applied';
  END IF;
  def := pg_get_functiondef('public.refresh_tokentracker_device_identity(uuid,uuid,text,text)'::regprocedure);
  patches := ARRAY[
    ARRAY[E'      total_cost_usd\n    )',E'      total_cost_usd, cost_coverage\n    )'],
    ARRAY[E'      ranked.total_cost_usd\n    FROM',E'      ranked.total_cost_usd, ranked.cost_coverage\n    FROM'],
    ARRAY['      total_cost_usd = EXCLUDED.total_cost_usd;','      total_cost_usd = EXCLUDED.total_cost_usd, cost_coverage = EXCLUDED.cost_coverage;']
  ];
  FOREACH pair SLICE 1 IN ARRAY patches LOOP
    old:=pair[1]; replacement:=pair[2];
    IF strpos(def,replacement)>0 THEN
      IF (length(def)-length(replace(def,replacement,'')))/length(replacement)<>1 THEN RAISE EXCEPTION 'Ambiguous identity merge cost baseline'; END IF;
    ELSE
      IF (length(def)-length(replace(def,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'Unexpected identity merge baseline; cost migration not applied'; END IF;
      def:=replace(def,old,replacement);
    END IF;
  END LOOP;
  EXECUTE def;
END $patch$;

CREATE OR REPLACE FUNCTION public.usage_cost_capabilities_v1() RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path TO pg_catalog,pg_temp AS $fn$
  SELECT '{"cost_coverage_versions":[1]}'::jsonb
$fn$;
CREATE OR REPLACE FUNCTION public.cloud_ingest_usage_cost_v1(
  p_token_hash text,p_environment text,p_rows jsonb,p_states jsonb,p_upload_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO public,pg_temp AS $fn$
DECLARE result jsonb; normalized jsonb;
BEGIN
  -- Preserve original limits before folding duplicates. Later exact ties are
  -- newer cumulative snapshots, including a corrected reported zero.
  IF p_rows IS NULL OR p_states IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_typeof(p_states)<>'array'
    OR jsonb_array_length(p_rows)>500 OR jsonb_array_length(p_states)>500
    OR octet_length(p_rows::text)+octet_length(p_states::text)>1048576 THEN
    RETURN public.cloud_ingest_usage(p_token_hash,p_environment,p_rows,p_states,p_upload_id);
  END IF;
  SELECT coalesce(jsonb_agg(value),'[]') INTO normalized FROM (
    SELECT DISTINCT ON(value->>'hour_start',value->>'source',value->>'model') value
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY rows(value,ord)
    ORDER BY value->>'hour_start',value->>'source',value->>'model',
      coalesce((value->>'total_tokens')::bigint,0) DESC,coalesce((value->>'conversations')::bigint,0) DESC,ord DESC
  ) canonical;
  result:=public.cloud_ingest_usage(p_token_hash,p_environment,normalized,p_states,p_upload_id);
  RETURN CASE WHEN result->>'ok'='true' THEN result||'{"cost_coverage_version":1}'::jsonb ELSE result END;
END $fn$;
REVOKE ALL ON FUNCTION public.usage_cost_capabilities_v1(),public.cloud_ingest_usage_cost_v1(text,text,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.usage_cost_capabilities_v1(),public.cloud_ingest_usage_cost_v1(text,text,jsonb,jsonb,text) TO project_admin;

-- Production may be hot-only. Do not install/activate archival as a pricing
-- prerequisite. Dynamic SQL keeps absent optional relations out of parse-time
-- dependencies; partial/later unpatched installations fail closed.
CREATE OR REPLACE FUNCTION public.usage_cost_inventory_v1(
  p_user_id uuid,p_from timestamptz,p_to timestamptz,p_user_from uuid,p_user_to uuid
) RETURNS SETOF public.tokentracker_hourly LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO public,pg_temp SET statement_timeout TO '8s' AS $fn$
BEGIN
  RETURN QUERY
SELECT h.* FROM public.tokentracker_hourly h
    WHERE (h.source='grok' OR (h.source='cursor' AND lower(h.model) LIKE 'grok-bot-%'))
      AND (p_user_id IS NULL OR h.user_id=p_user_id)
      AND (p_user_from IS NULL OR h.user_id>=p_user_from) AND (p_user_to IS NULL OR h.user_id<p_user_to)
      AND h.hour_start>=p_from AND h.hour_start<p_to;
  IF to_regclass('public.tokentracker_usage_archive_manifest') IS NULL
    AND to_regclass('public.tokentracker_usage_archive_generations') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('public.tokentracker_usage_archive_manifest') IS NULL
    OR to_regclass('public.tokentracker_usage_archive_generations') IS NULL
    OR to_regprocedure('public.cloud_restore_usage_archive(uuid,uuid,uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'Incomplete archive cost baseline';
  END IF;
  IF strpos(pg_get_functiondef('public.cloud_restore_usage_archive(uuid,uuid,uuid,date)'::regprocedure),'cost_coverage=c.cost_coverage')=0 THEN
    RAISE EXCEPTION 'Archive cost migration must be reapplied';
  END IF;
  RETURN QUERY EXECUTE $cold$
SELECT h.* FROM public.tokentracker_usage_archive_manifest m
    JOIN public.tokentracker_usage_archive_generations g ON g.id=m.generation_id AND g.status='committed'
    CROSS JOIN LATERAL jsonb_populate_recordset(NULL::public.tokentracker_hourly,g.payload) h
    WHERE ($1 IS NULL OR m.user_id=$1)
      AND ($4 IS NULL OR m.user_id>=$4) AND ($5 IS NULL OR m.user_id<$5)
      AND m.day>=($2 AT TIME ZONE 'UTC')::date AND m.day<=(($3-interval '1 microsecond') AT TIME ZONE 'UTC')::date
      AND g.payload @? '$[*] ? (@.source == "grok" || (@.source == "cursor" && @.model like_regex "^grok-bot-" flag "i"))'
      AND (h.source='grok' OR (h.source='cursor' AND lower(h.model) LIKE 'grok-bot-%'))
      AND h.hour_start>=$2 AND h.hour_start<$3
  $cold$ USING p_user_id,p_from,p_to,p_user_from,p_user_to;
END $fn$;
REVOKE ALL ON FUNCTION public.usage_cost_inventory_v1(uuid,timestamptz,timestamptz,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.usage_cost_inventory_v1(uuid,timestamptz,timestamptz,uuid,uuid) TO project_admin;

-- Versioned additive side wire: existing compact/token RPCs and maintained
-- leaderboard rollups remain byte-compatible, with no historical rebuild.
-- Edge checks every returned basis vector against its token wire; races/stale
-- rollups fail closed instead of mixing different canonical inventories.
CREATE OR REPLACE FUNCTION public.usage_cost_provenance_v1(
  p_user_id uuid,p_device_id uuid,p_from timestamptz,p_to timestamptz,
  p_trunc text,p_tz text,p_offset_min integer,
  p_user_from uuid DEFAULT NULL,p_user_to uuid DEFAULT NULL,
  p_range_from text DEFAULT NULL,p_range_to text DEFAULT NULL
) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public,pg_temp SET statement_timeout TO '8s' AS $fn$
  WITH candidates AS (
    SELECT * FROM public.usage_cost_inventory_v1(p_user_id,p_from,p_to,p_user_from,p_user_to)
  ), revisions AS (
    SELECT DISTINCT ON (user_id,device_id,hour_start,source,model) * FROM candidates
    ORDER BY user_id,device_id,hour_start,source,model,coalesce((to_jsonb(candidates)->>'archive_revision')::bigint,0) DESC
  ), eligible AS (
    SELECT h.*,CASE WHEN h.source='cursor' THEN 'account' ELSE coalesce(dm.machine_cluster_id,h.device_id::text) END AS cluster
    FROM revisions h
    LEFT JOIN public.tokentracker_devices d ON d.id=h.device_id AND d.user_id=h.user_id
    LEFT JOIN public.tokentracker_device_machine dm ON dm.device_id=h.device_id
    WHERE h.source='cursor' OR (d.revoked_at IS NULL AND d.id IS NOT NULL AND
      (p_device_id IS NULL OR h.device_id=p_device_id OR NOT EXISTS (
        SELECT 1 FROM public.tokentracker_devices requested
        WHERE requested.id=p_device_id AND requested.user_id=p_user_id AND requested.revoked_at IS NULL)))
  ), ranked AS (
    SELECT *,dense_rank() OVER (PARTITION BY user_id,cluster,hour_start,source,model ORDER BY total_tokens DESC,updated_at DESC) AS rank
    FROM eligible
  ), picked AS (
    SELECT DISTINCT ON (user_id,cluster,hour_start,source,model) * FROM ranked WHERE rank=1
    ORDER BY user_id,cluster,hour_start,source,model,
      (coalesce((cost_coverage->>'reported_events')::bigint,0)>0 OR (cost_coverage IS NULL AND source='grok' AND total_cost_usd>0)) DESC,
      (cost_coverage IS NOT NULL) DESC,device_id
  ), conflicts AS (
    SELECT user_id,cluster,hour_start,source,model,
      count(DISTINCT jsonb_build_object('usd',coalesce(cost_coverage->'reported_usd',to_jsonb(total_cost_usd)),
        'unreported_tokens',coalesce(cost_coverage->'unreported_tokens','{"input_tokens":0,"cached_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}'::jsonb))) FILTER (
          WHERE coalesce((cost_coverage->>'reported_events')::bigint,0)>0
            OR (cost_coverage IS NULL AND source='grok' AND total_cost_usd>0))>1 AS ambiguous
    FROM ranked WHERE rank=1 GROUP BY user_id,cluster,hour_start,source,model
  ), located AS (
    SELECT h.*,c.ambiguous,
      h.cost_coverage IS NULL AND h.source='grok' AND h.total_cost_usd>0 AS legacy_reported,
      CASE WHEN p_trunc='day' THEN cal.local_day ELSE '' END AS bucket,
      public.leaderboard_pricing_tier(h.model,h.hour_start) AS pricing_tier
    FROM picked h JOIN conflicts c USING(user_id,cluster,hour_start,source,model)
    CROSS JOIN LATERAL (SELECT to_char(CASE
      WHEN p_tz IS NOT NULL AND EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_tz) THEN h.hour_start AT TIME ZONE p_tz
      ELSE (h.hour_start AT TIME ZONE 'UTC')+make_interval(mins=>coalesce(p_offset_min,0)) END,'YYYY-MM-DD') AS local_day) cal
    WHERE (p_range_from IS NULL OR cal.local_day>=p_range_from) AND (p_range_to IS NULL OR cal.local_day<=p_range_to)
  ), grouped AS (
    SELECT user_id,bucket,source,model,pricing_tier,
      jsonb_build_object('input_tokens',SUM(input_tokens),'cached_input_tokens',SUM(cached_input_tokens),'cache_creation_input_tokens',SUM(cache_creation_input_tokens),'output_tokens',SUM(output_tokens),'reasoning_output_tokens',SUM(reasoning_output_tokens)) AS basis,
      jsonb_build_object('input_tokens',SUM(CASE WHEN cost_coverage IS NOT NULL THEN input_tokens-coalesce((cost_coverage->'unreported_tokens'->>'input_tokens')::bigint,0) WHEN legacy_reported THEN input_tokens ELSE 0 END),'cached_input_tokens',SUM(CASE WHEN cost_coverage IS NOT NULL THEN cached_input_tokens-coalesce((cost_coverage->'unreported_tokens'->>'cached_input_tokens')::bigint,0) WHEN legacy_reported THEN cached_input_tokens ELSE 0 END),'cache_creation_input_tokens',SUM(CASE WHEN cost_coverage IS NOT NULL THEN cache_creation_input_tokens-coalesce((cost_coverage->'unreported_tokens'->>'cache_creation_input_tokens')::bigint,0) WHEN legacy_reported THEN cache_creation_input_tokens ELSE 0 END),'output_tokens',SUM(CASE WHEN cost_coverage IS NOT NULL THEN output_tokens-coalesce((cost_coverage->'unreported_tokens'->>'output_tokens')::bigint,0) WHEN legacy_reported THEN output_tokens ELSE 0 END),'reasoning_output_tokens',SUM(CASE WHEN cost_coverage IS NOT NULL THEN reasoning_output_tokens-coalesce((cost_coverage->'unreported_tokens'->>'reasoning_output_tokens')::bigint,0) WHEN legacy_reported THEN reasoning_output_tokens ELSE 0 END)) AS covered_tokens,
      SUM(CASE WHEN cost_coverage IS NOT NULL THEN (cost_coverage->>'reported_usd')::numeric WHEN legacy_reported THEN total_cost_usd ELSE 0 END) AS reported_usd,
      bool_or(coalesce((cost_coverage->>'reported_events')::bigint,0)>0 OR legacy_reported) AS has_reported,
      bool_or(CASE WHEN cost_coverage IS NULL THEN NOT legacy_reported ELSE (cost_coverage->>'missing_events')::bigint>0 END) AS has_missing,
      bool_or(coalesce((cost_coverage->>'allocated_events')::bigint,0)>0) AS has_allocated,
      bool_or(ambiguous) AS ambiguous,
      to_jsonb(array_remove(ARRAY[
        CASE WHEN bool_or(cost_coverage->'origins' ? 'grok_ticks') THEN 'grok_ticks' END,
        CASE WHEN bool_or(cost_coverage->'origins' ? 'grok_usd') THEN 'grok_usd' END,
        CASE WHEN bool_or(cost_coverage->'origins' ? 'grok_allocated') THEN 'grok_allocated' END,
        CASE WHEN bool_or(cost_coverage->'origins' ? 'cursor_csv_cost') THEN 'cursor_csv_cost' END,
        CASE WHEN bool_or(cost_coverage->'origins' ? 'cursor_total_cents') THEN 'cursor_total_cents' END,
        CASE WHEN bool_or(legacy_reported) THEN 'legacy_grok_total_cost_usd' END
      ],NULL)) AS origins
    FROM located GROUP BY user_id,bucket,source,model,pricing_tier
  )
  SELECT jsonb_build_object('version',1,'rows',coalesce(jsonb_agg(to_jsonb(grouped.*) ORDER BY user_id,bucket,source,model,pricing_tier),'[]'::jsonb)) FROM grouped
$fn$;
REVOKE ALL ON FUNCTION public.usage_cost_provenance_v1(uuid,uuid,timestamptz,timestamptz,text,text,integer,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.usage_cost_provenance_v1(uuid,uuid,timestamptz,timestamptz,text,text,integer,uuid,uuid,text,text) TO project_admin;

COMMIT;
