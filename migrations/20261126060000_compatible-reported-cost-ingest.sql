DO $patch$
DECLARE
  def text;
  exact_cost text := 'abs((v->>''reported_usd'')::numeric-p_cost)>0.00000001';
  rounded_cost text := '(' || exact_cost || ' AND round((v->>''reported_usd'')::numeric,4)<>p_cost)';
  current_cost text;
  keep_cost text := $predicate$
    h.source='cursor' AND lower(h.model) LIKE 'grok-bot-%'
    AND ROW(h.input_tokens,h.cached_input_tokens,h.cache_creation_input_tokens,h.output_tokens,
            h.reasoning_output_tokens,h.total_tokens,h.conversations)
      IS NOT DISTINCT FROM
        ROW(excluded.input_tokens,excluded.cached_input_tokens,excluded.cache_creation_input_tokens,excluded.output_tokens,
            excluded.reasoning_output_tokens,excluded.total_tokens,excluded.conversations)
    AND coalesce((h.cost_coverage->>'reported_events')::bigint,0)>0
    AND (coalesce((excluded.cost_coverage->>'reported_events')::bigint,0)
             <(h.cost_coverage->>'reported_events')::bigint
      OR ((h.cost_coverage->'origins') ? 'cursor_total_cents'
          AND NOT coalesce((excluded.cost_coverage->'origins') ? 'cursor_total_cents',false)
          AND (excluded.cost_coverage->>'reported_events')::bigint=(h.cost_coverage->>'reported_events')::bigint))
  $predicate$;
BEGIN
  -- The legacy amount column is numeric(12,4). Keep the full amount in the
  -- validated coverage field and also accept its rounded column value.
  def := pg_get_functiondef('tokentracker_private.valid_cost_coverage(jsonb,text,text,numeric,bigint,bigint,bigint,bigint,bigint)'::regprocedure);
  IF strpos(def,rounded_cost)=0 THEN
    IF strpos(def,exact_cost)=0 THEN RAISE EXCEPTION 'Unexpected cost validator definition'; END IF;
    EXECUTE replace(def,exact_cost,rounded_cost);
  END IF;

  -- Preserve a better amount only when the prior and incoming records describe
  -- the same usage. The amount and coverage always move together.
  def := pg_get_functiondef('public.cloud_ingest_usage(text,text,jsonb,jsonb,text)'::regprocedure);
  current_cost := substring(def FROM 'total_cost_usd=[^;]*?,[[:space:]]*conversations=excluded.conversations');
  IF current_cost IS NULL OR strpos(current_cost,'cost_coverage=')=0 THEN
    RAISE EXCEPTION 'Unexpected cloud ingest cost definition';
  END IF;
  EXECUTE replace(def,current_cost,
    'total_cost_usd=CASE WHEN ' || keep_cost || ' THEN h.total_cost_usd ELSE excluded.total_cost_usd END,' ||
    'cost_coverage=CASE WHEN ' || keep_cost || ' THEN h.cost_coverage ELSE excluded.cost_coverage END,' ||
    'conversations=excluded.conversations');

  -- Cost evidence must use the same winning usage snapshot as the token wires.
  def := pg_get_functiondef('public.usage_cost_provenance_v1(uuid,uuid,timestamptz,timestamptz,text,text,integer,uuid,uuid,text,text)'::regprocedure);
  -- Restrict replacement to the dense_rank expression, which is on one line.
  def := regexp_replace(def,
    '(dense_rank\(\) OVER \(PARTITION BY user_id,cluster,hour_start,source,model) ORDER BY [^\n]+\) AS rank',
    '\1 ORDER BY total_tokens DESC,updated_at DESC) AS rank');
  IF strpos(def,'dense_rank() OVER (PARTITION BY user_id,cluster,hour_start,source,model ORDER BY total_tokens DESC,updated_at DESC) AS rank')=0 THEN
    RAISE EXCEPTION 'Unexpected cost provenance ranking';
  END IF;
  EXECUTE def;
END
$patch$;
