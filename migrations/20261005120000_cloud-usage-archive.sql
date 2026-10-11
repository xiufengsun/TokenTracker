-- Local delivery draft. No retention job is installed by this migration.
-- Preserve full hourly truth in one private JSONB pack per user/device/UTC day.
-- Hot corrections win by server revision before existing machine/account dedup.
-- TRAE session truth and all public daily/lifetime rollups are retained.


DO $preflight$
DECLARE v_table text;
BEGIN
  IF to_regclass('public.tokentracker_hourly') IS NULL
     OR to_regclass('public.tokentracker_account_session_states') IS NULL
     OR to_regclass('public.tokentracker_account_usage_cache') IS NULL
     OR to_regclass('public.tokentracker_leaderboard_rollup_daily_v2') IS NULL
     OR to_regprocedure('public.account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)') IS NULL
     OR to_regprocedure('public.leaderboard_hourly_dedup_v2(timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('public.leaderboard_rollup_daily_replace_v2(timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('public.leaderboard_rollup_daily_advance_v2()') IS NULL
     OR to_regprocedure('public.refresh_tokentracker_device_identity(uuid,uuid,text,text)') IS NULL
     OR to_regprocedure('public.leaderboard_pricing_tier(text,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'Cloud archive requires the verified account/session/rollup schema';
  END IF;
  -- Never install an older copy of canonical pricing over the live function.
  IF position('2026-08-22T16:00:00Z' IN pg_get_functiondef(
    'public.leaderboard_pricing_tier(text,timestamptz)'::regprocedure)) = 0
    OR public.leaderboard_pricing_tier('deepseek-v4-pro','2026-08-23T02:00:00Z')<>'off_peak'
    OR public.leaderboard_pricing_tier('deepseek-v4-pro','2026-08-16T02:00:00Z')<>'peak' THEN
    RAISE EXCEPTION 'Verify canonical DeepSeek Beijing weekend pricing before archive activation';
  END IF;
  IF EXISTS(SELECT 1 FROM (VALUES
    ('user_id','uuid'),('device_id','uuid'),('source','text'),('model','text'),('hour_start','timestamptz'),
    ('input_tokens','bigint'),('cached_input_tokens','bigint'),('cache_creation_input_tokens','bigint'),
    ('output_tokens','bigint'),('reasoning_output_tokens','bigint'),('total_tokens','bigint'),
    ('billable_total_tokens','bigint'),('conversations','integer'),('created_at','timestamptz'),
    ('updated_at','timestamptz'),('total_cost_usd','numeric')) required(name,type_name)
    LEFT JOIN pg_attribute a ON a.attrelid='public.tokentracker_hourly'::regclass
      AND a.attname=required.name AND NOT a.attisdropped
    WHERE a.atttypid IS DISTINCT FROM to_regtype(required.type_name)::oid) THEN
    RAISE EXCEPTION 'Hourly truth schema differs from the verified archive record';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['tokentracker_leaderboard_snapshots','agentmeter_leaderboard_snapshots',
    'tokentracker_leaderboard_rollup_daily','agentmeter_hourly'] LOOP
    IF to_regclass('public.'||v_table) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE c.oid=to_regclass('public.'||v_table) AND c.relkind IN ('r','p')
        AND a.attname='user_id' AND a.atttypid='uuid'::regtype AND NOT a.attisdropped) THEN
      RAISE EXCEPTION 'Verified user scope is missing from derived usage table %',v_table;
    END IF;
  END LOOP;
END
$preflight$;

CREATE SEQUENCE public.tokentracker_usage_revision_seq AS bigint;
-- Historical rows need no rewrite/backfill: revision zero precedes every new write.
ALTER TABLE public.tokentracker_hourly
  ADD COLUMN archive_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.tokentracker_account_session_states
  ADD COLUMN archive_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE public.tokentracker_usage_dirty_days (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day date NOT NULL, revision bigint NOT NULL,
  PRIMARY KEY(user_id,day)
);
CREATE TABLE public.tokentracker_usage_archive_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  day date NOT NULL,
  base_generation uuid,
  device_revoked_at timestamptz,
  payload jsonb,
  hot_snapshot jsonb NOT NULL DEFAULT '[]',
  checksum text NOT NULL,
  row_count integer NOT NULL CHECK(row_count > 0 AND row_count <= 10000),
  min_revision bigint NOT NULL, max_revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','committed','superseded')),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz
);
CREATE TABLE public.tokentracker_usage_archive_manifest (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  day date NOT NULL,
  generation_id uuid NOT NULL UNIQUE REFERENCES public.tokentracker_usage_archive_generations(id),
  PRIMARY KEY(user_id,device_id,day)
);
CREATE TABLE public.tokentracker_usage_maintenance_operations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('archive','restore','cleanup','erase-user')),
  scope jsonb NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','done','cancelled')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz
);
CREATE INDEX tokentracker_usage_archive_day_idx
  ON public.tokentracker_usage_archive_manifest(day,user_id);
ALTER TABLE public.tokentracker_usage_archive_generations ALTER COLUMN payload SET STORAGE EXTENDED;
ALTER TABLE public.tokentracker_usage_dirty_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_usage_archive_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_usage_archive_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_usage_maintenance_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_usage_revision_seq,
  public.tokentracker_usage_dirty_days,public.tokentracker_usage_archive_generations,
  public.tokentracker_usage_archive_manifest,public.tokentracker_usage_maintenance_operations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.tokentracker_usage_revision_seq,
  public.tokentracker_usage_dirty_days,public.tokentracker_usage_archive_generations,
  public.tokentracker_usage_archive_manifest,public.tokentracker_usage_maintenance_operations TO project_admin;
CREATE INDEX tokentracker_account_usage_cache_user_idx
  ON public.tokentracker_account_usage_cache(split_part(cache_key,chr(31),2));

CREATE FUNCTION public.cloud_usage_maintenance_lock(p_user_id uuid)
RETURNS void LANGUAGE sql VOLATILE SET search_path TO public,pg_temp AS $f$
  SELECT pg_advisory_xact_lock(hashtextextended('usage-maintenance:'||p_user_id::text,0))
$f$;

CREATE FUNCTION public.cloud_usage_written() RETURNS trigger LANGUAGE plpgsql
SET search_path TO public,pg_temp AS $f$
DECLARE v_day date; v_old_day date;
BEGIN
  NEW.archive_revision := nextval('public.tokentracker_usage_revision_seq');
  v_day := ((to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='tokentracker_hourly'
    THEN 'hour_start' ELSE 'bucket_start' END)::timestamptz AT TIME ZONE 'UTC')::date;
  IF TG_OP='UPDATE' THEN
    v_old_day := ((to_jsonb(OLD)->>CASE WHEN TG_TABLE_NAME='tokentracker_hourly'
      THEN 'hour_start' ELSE 'bucket_start' END)::timestamptz AT TIME ZONE 'UTC')::date;
  END IF;
  INSERT INTO public.tokentracker_usage_dirty_days(user_id,day,revision)
  SELECT NEW.user_id,day,NEW.archive_revision
  FROM (SELECT v_day AS day UNION SELECT v_old_day WHERE v_old_day IS NOT NULL) d
  ON CONFLICT(user_id,day) DO UPDATE SET revision=GREATEST(
    tokentracker_usage_dirty_days.revision,EXCLUDED.revision);
  RETURN NEW;
END $f$;
CREATE TRIGGER cloud_hourly_revision BEFORE INSERT OR UPDATE ON public.tokentracker_hourly
  FOR EACH ROW EXECUTE FUNCTION public.cloud_usage_written();
CREATE TRIGGER cloud_session_revision BEFORE INSERT OR UPDATE ON public.tokentracker_account_session_states
  FOR EACH ROW EXECUTE FUNCTION public.cloud_usage_written();

CREATE FUNCTION public.cloud_usage_cache_written() RETURNS trigger LANGUAGE plpgsql
SET search_path TO public,pg_temp AS $f$
BEGIN
  -- One statement per changed user set, rather than one cache scan per bucket.
  IF TG_OP='UPDATE' THEN
    DELETE FROM public.tokentracker_account_usage_cache
    WHERE split_part(cache_key,chr(31),2) IN(
      SELECT user_id::text FROM new_rows UNION SELECT user_id::text FROM old_rows);
  ELSE
    DELETE FROM public.tokentracker_account_usage_cache
    WHERE split_part(cache_key,chr(31),2) IN(SELECT DISTINCT user_id::text FROM new_rows);
  END IF;
  RETURN NULL;
END $f$;
CREATE TRIGGER cloud_hourly_cache_insert AFTER INSERT ON public.tokentracker_hourly
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.cloud_usage_cache_written();
CREATE TRIGGER cloud_hourly_cache_update AFTER UPDATE ON public.tokentracker_hourly
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.cloud_usage_cache_written();
CREATE TRIGGER cloud_session_cache_insert AFTER INSERT ON public.tokentracker_account_session_states
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.cloud_usage_cache_written();
CREATE TRIGGER cloud_session_cache_update AFTER UPDATE ON public.tokentracker_account_session_states
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.cloud_usage_cache_written();

CREATE FUNCTION public.cloud_usage_hourly(
  p_user_id uuid,p_device_id uuid,p_from timestamptz,p_to timestamptz
) RETURNS SETOF public.tokentracker_hourly LANGUAGE sql STABLE
SET search_path TO public,pg_temp AS $f$
  WITH candidates AS (
    SELECT h.* FROM public.tokentracker_hourly h
    WHERE (p_user_id IS NULL OR h.user_id=p_user_id)
      AND (p_device_id IS NULL OR h.device_id=p_device_id)
      AND (p_from IS NULL OR h.hour_start>=p_from)
      AND (p_to IS NULL OR h.hour_start<p_to)
    UNION ALL
    SELECT h.* FROM public.tokentracker_usage_archive_manifest m
    JOIN public.tokentracker_usage_archive_generations g ON g.id=m.generation_id AND g.status='committed'
    CROSS JOIN LATERAL jsonb_populate_recordset(NULL::public.tokentracker_hourly,g.payload) h
    WHERE (p_user_id IS NULL OR m.user_id=p_user_id)
      AND (p_device_id IS NULL OR m.device_id=p_device_id)
      AND (p_from IS NULL OR m.day>=(p_from AT TIME ZONE 'UTC')::date)
      AND (p_to IS NULL OR m.day<=((p_to-interval '1 microsecond') AT TIME ZONE 'UTC')::date)
      AND (p_from IS NULL OR h.hour_start>=p_from)
      AND (p_to IS NULL OR h.hour_start<p_to)
  )
  SELECT DISTINCT ON(user_id,device_id,hour_start,source,model) candidates.*
  FROM candidates ORDER BY user_id,device_id,hour_start,source,model,archive_revision DESC
$f$;

CREATE FUNCTION public.cloud_prepare_usage_archive(p_user_id uuid,p_device_id uuid,p_day date)
RETURNS uuid LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_id uuid; v_base uuid; v_payload jsonb; v_hot jsonb; v_revoked timestamptz;
  v_count integer; v_min bigint; v_max bigint;
BEGIN
  PERFORM public.cloud_usage_maintenance_lock(p_user_id);
  IF p_day IS NULL OR p_day>=((clock_timestamp()-interval '90 days') AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'Only complete UTC days older than the ninety-day hot window may be archived';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(':','usage-archive',p_user_id,p_device_id,p_day),0));
  SELECT revoked_at INTO v_revoked FROM public.tokentracker_devices WHERE id=p_device_id AND user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Archive device does not belong to this user'; END IF;
  SELECT generation_id INTO v_base FROM public.tokentracker_usage_archive_manifest
  WHERE user_id=p_user_id AND device_id=p_device_id AND day=p_day;
  -- Payload and deletion revisions must share one statement snapshot. Reading
  -- them in two statements could accidentally delete a newer intervening write.
  SELECT jsonb_agg(to_jsonb(h) ORDER BY hour_start,source,model),count(*)::integer,
    min(archive_revision),max(archive_revision),
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('hour_start',raw.hour_start,'source',raw.source,'model',raw.model,
      'archive_revision',raw.archive_revision)), '[]') FROM public.tokentracker_hourly raw
      WHERE raw.user_id=p_user_id AND raw.device_id=p_device_id
        AND raw.hour_start>=p_day::timestamp AT TIME ZONE 'UTC'
        AND raw.hour_start<(p_day+1)::timestamp AT TIME ZONE 'UTC')
    INTO v_payload,v_count,v_min,v_max,v_hot
  FROM public.cloud_usage_hourly(p_user_id,p_device_id,p_day::timestamp AT TIME ZONE 'UTC',
    (p_day+1)::timestamp AT TIME ZONE 'UTC') h;
  IF v_count=0 THEN RETURN NULL; END IF;
  IF v_count>10000 OR pg_column_size(v_payload)>8388608 THEN RAISE EXCEPTION 'Archive day exceeds the bounded pack budget'; END IF;
  INSERT INTO public.tokentracker_usage_archive_generations(user_id,device_id,day,base_generation,
    device_revoked_at,payload,hot_snapshot,checksum,row_count,min_revision,max_revision)
  VALUES(p_user_id,p_device_id,p_day,v_base,v_revoked,v_payload,v_hot,md5(v_payload::text),v_count,v_min,v_max)
  RETURNING id INTO v_id;
  RETURN v_id;
END $f$;

CREATE FUNCTION public.cloud_commit_usage_archive(p_generation uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE g public.tokentracker_usage_archive_generations%ROWTYPE;
  v_current uuid; v_count integer; v_min bigint; v_max bigint; v_bad integer; v_deleted integer;
  v_revoked timestamptz;
BEGIN
  SELECT * INTO g FROM public.tokentracker_usage_archive_generations WHERE id=p_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Archive generation not found'; END IF;
  PERFORM public.cloud_usage_maintenance_lock(g.user_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(':','usage-archive',g.user_id,g.device_id,g.day),0));
  SELECT * INTO g FROM public.tokentracker_usage_archive_generations WHERE id=p_generation FOR UPDATE;
  SELECT generation_id INTO v_current FROM public.tokentracker_usage_archive_manifest
  WHERE user_id=g.user_id AND device_id=g.device_id AND day=g.day;
  IF g.status<>'prepared' THEN RETURN jsonb_build_object('generation',g.id,'status',g.status,
    'already_committed',g.status='committed' AND g.id IS NOT DISTINCT FROM v_current,
    'is_current',g.id IS NOT DISTINCT FROM v_current,'current_generation',v_current,'deleted_hot_rows',0); END IF;
  SELECT revoked_at INTO v_revoked FROM public.tokentracker_devices WHERE id=g.device_id AND user_id=g.user_id;
  IF NOT FOUND OR v_revoked IS DISTINCT FROM g.device_revoked_at THEN RAISE EXCEPTION 'Archive device changed after preparation'; END IF;
  IF v_current IS DISTINCT FROM g.base_generation THEN RAISE EXCEPTION 'Archive generation is stale; prepare again'; END IF;
  IF g.payload IS NULL OR md5(g.payload::text)<>g.checksum THEN RAISE EXCEPTION 'Archive checksum mismatch'; END IF;
  SELECT count(*)::integer,min(archive_revision),max(archive_revision),
    count(*) FILTER(WHERE user_id IS DISTINCT FROM g.user_id OR device_id IS DISTINCT FROM g.device_id
      OR (hour_start AT TIME ZONE 'UTC')::date IS DISTINCT FROM g.day OR archive_revision IS NULL)::integer
  INTO v_count,v_min,v_max,v_bad
  FROM jsonb_populate_recordset(NULL::public.tokentracker_hourly,g.payload);
  IF v_count<>g.row_count OR v_min IS DISTINCT FROM g.min_revision OR v_max IS DISTINCT FROM g.max_revision
    OR v_bad<>0 OR v_count<>(SELECT count(DISTINCT (hour_start,source,model))
      FROM jsonb_populate_recordset(NULL::public.tokentracker_hourly,g.payload)) THEN
    RAISE EXCEPTION 'Archive row count, scope, or revision range mismatch';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_to_recordset(g.hot_snapshot) s(
    hour_start timestamptz,source text,model text,archive_revision bigint)
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::public.tokentracker_hourly,g.payload) h
      WHERE h.hour_start=s.hour_start AND h.source=s.source AND h.model=s.model
        AND h.archive_revision>=s.archive_revision)) THEN
    RAISE EXCEPTION 'Archive deletion snapshot is not covered by verified payload';
  END IF;
  UPDATE public.tokentracker_usage_archive_generations SET status='committed',committed_at=clock_timestamp() WHERE id=g.id;
  INSERT INTO public.tokentracker_usage_archive_manifest(user_id,device_id,day,generation_id)
  VALUES(g.user_id,g.device_id,g.day,g.id)
  ON CONFLICT(user_id,device_id,day) DO UPDATE SET generation_id=EXCLUDED.generation_id;
  -- A concurrent correction has a different revision and must remain as hot overlay.
  DELETE FROM public.tokentracker_hourly h USING jsonb_to_recordset(g.hot_snapshot) s(
    hour_start timestamptz,source text,model text,archive_revision bigint)
  WHERE h.user_id=g.user_id AND h.device_id=g.device_id AND h.hour_start=s.hour_start
    AND h.source=s.source AND h.model=s.model AND h.archive_revision=s.archive_revision;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  UPDATE public.tokentracker_usage_archive_generations SET hot_snapshot='[]' WHERE id=g.id;
  UPDATE public.tokentracker_usage_archive_generations SET status='superseded',payload=NULL,hot_snapshot='[]'
  WHERE id=g.base_generation;
  RETURN jsonb_build_object('generation',g.id,'row_count',g.row_count,'deleted_hot_rows',v_deleted);
END $f$;

-- Called inside the existing legacy-device convergence, after its hot merge
-- and before legacy deletion/revocation. Preserve its whole-row MAX choice
-- across the two device identities, then give the merged cold row a revision.
-- Subsequent canonical-device corrections can therefore lower it to zero.
CREATE FUNCTION public.cloud_merge_usage_archive(p_user_id uuid,p_legacy uuid,p_canonical uuid)
RETURNS void LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_day date; v_ids uuid[]; v_new uuid; v_payload jsonb; v_count integer;
  v_min bigint; v_max bigint;
BEGIN
  PERFORM public.cloud_usage_maintenance_lock(p_user_id);
  IF p_legacy=p_canonical OR (SELECT count(*) FROM public.tokentracker_devices
    WHERE user_id=p_user_id AND id IN(p_legacy,p_canonical))<>2 THEN
    RAISE EXCEPTION 'Cold device merge requires two devices owned by the same user';
  END IF;
  FOR v_day IN SELECT DISTINCT day FROM public.tokentracker_usage_archive_manifest
    WHERE user_id=p_user_id AND device_id IN(p_legacy,p_canonical) ORDER BY day LOOP
    -- Identical lock order for two simultaneous device merges.
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(':','usage-archive',p_user_id,id,v_day),0))
      FROM unnest(ARRAY[p_legacy,p_canonical]) id ORDER BY id;
    SELECT array_agg(generation_id) INTO v_ids FROM public.tokentracker_usage_archive_manifest
      WHERE user_id=p_user_id AND device_id IN(p_legacy,p_canonical) AND day=v_day;
    SELECT jsonb_agg(row_data ORDER BY hour_start,source,model),count(*)::integer,
      min(revision),max(revision) INTO v_payload,v_count,v_min,v_max
    FROM (
      SELECT to_jsonb(chosen)||jsonb_build_object('device_id',p_canonical,
        'archive_revision',nextval('public.tokentracker_usage_revision_seq')) AS row_data,
        hour_start,source,model
      FROM (
        SELECT DISTINCT ON(hour_start,source,model) h.*
        FROM public.cloud_usage_hourly(p_user_id,NULL,v_day::timestamp AT TIME ZONE 'UTC',
          (v_day+1)::timestamp AT TIME ZONE 'UTC') h
        WHERE device_id IN(p_legacy,p_canonical)
        ORDER BY hour_start,source,model,total_tokens DESC,updated_at DESC,device_id=p_canonical DESC
      ) chosen
    ) payload CROSS JOIN LATERAL (SELECT (row_data->>'archive_revision')::bigint AS revision) rev;
    IF v_count>10000 OR pg_column_size(v_payload)>8388608 THEN RAISE EXCEPTION 'Merged cold day exceeds pack budget'; END IF;
    INSERT INTO public.tokentracker_usage_archive_generations(user_id,device_id,day,payload,
      checksum,row_count,min_revision,max_revision,status,committed_at)
    VALUES(p_user_id,p_canonical,v_day,v_payload,md5(v_payload::text),v_count,v_min,v_max,'committed',clock_timestamp())
      RETURNING id INTO v_new;
    DELETE FROM public.tokentracker_usage_archive_manifest
      WHERE user_id=p_user_id AND device_id IN(p_legacy,p_canonical) AND day=v_day;
    INSERT INTO public.tokentracker_usage_archive_manifest VALUES(p_user_id,p_canonical,v_day,v_new);
    UPDATE public.tokentracker_usage_archive_generations SET status='superseded',payload=NULL,hot_snapshot='[]'
      WHERE id=ANY(v_ids);
    INSERT INTO public.tokentracker_usage_dirty_days VALUES(p_user_id,v_day,v_max)
      ON CONFLICT(user_id,day) DO UPDATE SET revision=GREATEST(tokentracker_usage_dirty_days.revision,EXCLUDED.revision);
  END LOOP;
  DELETE FROM public.tokentracker_account_usage_cache WHERE split_part(cache_key,chr(31),2)=p_user_id::text;
END $f$;

CREATE FUNCTION public.cloud_repair_usage_days(p_limit integer DEFAULT 7)
RETURNS integer LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_day date; v_snapshot jsonb; v_count integer:=0;
BEGIN
  IF p_limit<1 OR p_limit>7 THEN RAISE EXCEPTION 'Dirty repair is bounded to seven days'; END IF;
  FOR v_day IN SELECT DISTINCT day FROM public.tokentracker_usage_dirty_days
    WHERE day<(clock_timestamp() AT TIME ZONE 'UTC')::date ORDER BY day LIMIT p_limit LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('usage-repair:'||v_day::text,0));
    SELECT jsonb_agg(to_jsonb(d)) INTO v_snapshot FROM public.tokentracker_usage_dirty_days d WHERE day=v_day;
    PERFORM public.leaderboard_rollup_daily_replace_v2(v_day::timestamp AT TIME ZONE 'UTC',
      (v_day+1)::timestamp AT TIME ZONE 'UTC');
    DELETE FROM public.tokentracker_usage_dirty_days d USING jsonb_to_recordset(v_snapshot) s(
      user_id uuid,day date,revision bigint)
    WHERE d.user_id=s.user_id AND d.day=s.day AND d.revision=s.revision;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $f$;

CREATE FUNCTION public.cloud_usage_begin_operation(p_operation uuid,p_user_id uuid,p_kind text,p_scope jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE op public.tokentracker_usage_maintenance_operations%ROWTYPE;
BEGIN
  IF p_operation IS NULL OR p_user_id IS NULL OR p_scope IS NULL THEN RAISE EXCEPTION 'A scoped maintenance operation is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('usage-operation:'||p_operation::text,0));
  PERFORM public.cloud_usage_maintenance_lock(p_user_id);
  INSERT INTO public.tokentracker_usage_maintenance_operations(id,user_id,kind,scope)
    VALUES(p_operation,p_user_id,p_kind,p_scope) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO STRICT op FROM public.tokentracker_usage_maintenance_operations WHERE id=p_operation;
  IF op.status='cancelled' THEN RAISE EXCEPTION 'Maintenance operation was cancelled by usage erasure'; END IF;
  IF op.user_id<>p_user_id OR op.kind<>p_kind OR op.scope<>p_scope THEN RAISE EXCEPTION 'Maintenance operation scope cannot change'; END IF;
  RETURN jsonb_build_object('status',op.status,'result',op.result);
END $f$;

CREATE FUNCTION public.cloud_prepare_usage_archive_operation(p_operation uuid,p_user_id uuid,p_device_id uuid,p_day date)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE op jsonb; v_gen uuid; v_result jsonb;
BEGIN
  op:=public.cloud_usage_begin_operation(p_operation,p_user_id,'archive',jsonb_build_object('device_id',p_device_id,'day',p_day));
  IF op->'result'<>'null'::jsonb THEN RETURN op->'result'; END IF;
  v_gen:=public.cloud_prepare_usage_archive(p_user_id,p_device_id,p_day);
  v_result:=jsonb_build_object('generation',v_gen,'empty',v_gen IS NULL);
  UPDATE public.tokentracker_usage_maintenance_operations SET result=v_result,
    status=CASE WHEN v_gen IS NULL THEN 'done' ELSE 'prepared' END WHERE id=p_operation;
  RETURN v_result;
END $f$;

CREATE FUNCTION public.cloud_commit_usage_archive_operation(p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE op public.tokentracker_usage_maintenance_operations%ROWTYPE; v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('usage-operation:'||p_operation::text,0));
  SELECT * INTO op FROM public.tokentracker_usage_maintenance_operations WHERE id=p_operation;
  IF NOT FOUND OR op.kind<>'archive' OR op.status='cancelled' THEN RAISE EXCEPTION 'Archive operation not available'; END IF;
  PERFORM public.cloud_usage_maintenance_lock(op.user_id);
  SELECT * INTO op FROM public.tokentracker_usage_maintenance_operations WHERE id=p_operation;
  IF op.status='cancelled' THEN RAISE EXCEPTION 'Archive operation cancelled by usage erasure'; END IF;
  IF op.status='done' THEN RETURN op.result||jsonb_build_object('replayed',true); END IF;
  v_result:=public.cloud_commit_usage_archive((op.result->>'generation')::uuid);
  UPDATE public.tokentracker_usage_maintenance_operations SET status='done',result=v_result,completed_at=clock_timestamp() WHERE id=p_operation;
  RETURN v_result;
END $f$;

CREATE FUNCTION public.cloud_restore_usage_archive(p_operation uuid,p_user_id uuid,p_device_id uuid,p_day date)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE op jsonb; g public.tokentracker_usage_archive_generations%ROWTYPE;
  v_updated integer; v_inserted integer; v_result jsonb;
BEGIN
  op:=public.cloud_usage_begin_operation(p_operation,p_user_id,'restore',jsonb_build_object('device_id',p_device_id,'day',p_day));
  IF op->>'status'='done' THEN RETURN op->'result'||jsonb_build_object('replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(':','usage-archive',p_user_id,p_device_id,p_day),0));
  SELECT g1.* INTO g FROM public.tokentracker_usage_archive_manifest m
    JOIN public.tokentracker_usage_archive_generations g1 ON g1.id=m.generation_id
    WHERE m.user_id=p_user_id AND m.device_id=p_device_id AND m.day=p_day;
  IF NOT FOUND THEN v_result:=jsonb_build_object('restored',false,'reason','no_archive');
  ELSE
    IF g.status<>'committed' OR g.payload IS NULL OR md5(g.payload::text)<>g.checksum
      OR g.user_id<>p_user_id OR g.device_id<>p_device_id OR g.day<>p_day
      OR jsonb_array_length(g.payload)<>g.row_count
      OR EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::public.tokentracker_hourly,g.payload) c
        WHERE c.user_id IS DISTINCT FROM p_user_id OR c.device_id IS DISTINCT FROM p_device_id
          OR (c.hour_start AT TIME ZONE 'UTC')::date IS DISTINCT FROM p_day) THEN
      RAISE EXCEPTION 'Restore archive verification failed';
    END IF;
    -- Compare against the original cold revision, not a trigger-generated
    -- EXCLUDED revision. PostgreSQL rechecks this WHERE after waiting for an
    -- existing row; a later hot correction must never be overwritten.
    UPDATE public.tokentracker_hourly h SET input_tokens=c.input_tokens,cached_input_tokens=c.cached_input_tokens,
      cache_creation_input_tokens=c.cache_creation_input_tokens,output_tokens=c.output_tokens,
      reasoning_output_tokens=c.reasoning_output_tokens,total_tokens=c.total_tokens,
      billable_total_tokens=c.billable_total_tokens,conversations=c.conversations,
      created_at=c.created_at,updated_at=c.updated_at,total_cost_usd=c.total_cost_usd
    FROM jsonb_populate_recordset(NULL::public.tokentracker_hourly,g.payload) c
    WHERE h.user_id=p_user_id AND h.device_id=p_device_id AND h.hour_start=c.hour_start
      AND h.source=c.source AND h.model=c.model AND h.archive_revision<c.archive_revision;
    GET DIAGNOSTICS v_updated=ROW_COUNT;
    INSERT INTO public.tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,
      cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
      billable_total_tokens,conversations,created_at,updated_at,total_cost_usd)
    SELECT c.user_id,c.device_id,c.source,c.model,c.hour_start,c.input_tokens,c.cached_input_tokens,
      c.cache_creation_input_tokens,c.output_tokens,c.reasoning_output_tokens,c.total_tokens,
      c.billable_total_tokens,c.conversations,c.created_at,c.updated_at,c.total_cost_usd
    FROM jsonb_populate_recordset(NULL::public.tokentracker_hourly,g.payload) c
    WHERE NOT EXISTS(SELECT 1 FROM public.tokentracker_hourly h WHERE h.user_id=c.user_id AND h.device_id=c.device_id
      AND h.hour_start=c.hour_start AND h.source=c.source AND h.model=c.model)
    ON CONFLICT(user_id,device_id,source,model,hour_start) DO NOTHING;
    GET DIAGNOSTICS v_inserted=ROW_COUNT;
    IF EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::public.tokentracker_hourly,g.payload) c
      WHERE NOT EXISTS(SELECT 1 FROM public.tokentracker_hourly h WHERE h.user_id=c.user_id AND h.device_id=c.device_id
        AND h.hour_start=c.hour_start AND h.source=c.source AND h.model=c.model AND h.archive_revision>=c.archive_revision)) THEN
      RAISE EXCEPTION 'Restore coverage is incomplete';
    END IF;
    DELETE FROM public.tokentracker_usage_archive_manifest WHERE user_id=p_user_id AND device_id=p_device_id AND day=p_day;
    UPDATE public.tokentracker_usage_archive_generations SET status='superseded',payload=NULL,hot_snapshot='[]' WHERE id=g.id;
    v_result:=jsonb_build_object('restored',true,'generation',g.id,'inserted_hot_rows',v_inserted,'updated_hot_rows',v_updated);
  END IF;
  UPDATE public.tokentracker_usage_maintenance_operations SET status='done',result=v_result,completed_at=clock_timestamp() WHERE id=p_operation;
  RETURN v_result;
END $f$;

CREATE FUNCTION public.cloud_cleanup_usage_archive(p_operation uuid,p_user_id uuid,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE op jsonb; v_deleted integer; v_result jsonb;
BEGIN
  IF p_limit<1 OR p_limit>1000 THEN RAISE EXCEPTION 'Cleanup must be bounded to 1..1000 generations'; END IF;
  op:=public.cloud_usage_begin_operation(p_operation,p_user_id,'cleanup',jsonb_build_object('limit',p_limit));
  IF op->>'status'='done' THEN RETURN op->'result'||jsonb_build_object('replayed',true); END IF;
  WITH expired AS(SELECT g.id FROM public.tokentracker_usage_archive_generations g
    WHERE g.user_id=p_user_id AND g.status='superseded' AND g.payload IS NULL
      AND g.committed_at<clock_timestamp()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM public.tokentracker_usage_archive_manifest m WHERE m.generation_id=g.id)
    ORDER BY g.committed_at,g.id FOR UPDATE SKIP LOCKED LIMIT p_limit)
  DELETE FROM public.tokentracker_usage_archive_generations g USING expired e WHERE g.id=e.id;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  v_result:=jsonb_build_object('deleted_generations',v_deleted);
  UPDATE public.tokentracker_usage_maintenance_operations SET status='done',result=v_result,completed_at=clock_timestamp() WHERE id=p_operation;
  RETURN v_result;
END $f$;

CREATE FUNCTION public.cloud_erase_user_usage(p_operation uuid,p_user_id uuid,p_confirmation uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE op jsonb; v_hot integer; v_sessions integer; v_cold integer; v_days integer; v_result jsonb;
  v_table text; v_deleted integer; v_derived jsonb:='{}';
BEGIN
  IF p_confirmation IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'Usage erasure confirmation must match the exact user'; END IF;
  op:=public.cloud_usage_begin_operation(p_operation,p_user_id,'erase-user',jsonb_build_object('confirmed_user',p_confirmation));
  IF op->>'status'='done' THEN RETURN op->'result'||jsonb_build_object('replayed',true); END IF;
  -- The shared user maintenance lock precedes all env/device/hourly locks.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||environment,0))
    FROM (VALUES('live'),('sandbox')) env(environment) ORDER BY environment;
  UPDATE public.tokentracker_device_tokens SET revoked_at=clock_timestamp() WHERE user_id=p_user_id AND revoked_at IS NULL;
  UPDATE public.tokentracker_devices SET revoked_at=clock_timestamp() WHERE user_id=p_user_id AND revoked_at IS NULL;
  IF to_regclass('public.tokentracker_cloud_machines') IS NOT NULL THEN
    EXECUTE 'UPDATE public.tokentracker_cloud_machines SET status=''paused'',upload_window_until=NULL,upload_token_id=NULL,upload_id=NULL WHERE user_id=$1 AND status=''active''' USING p_user_id;
  END IF;
  DELETE FROM public.tokentracker_device_codes WHERE user_id=p_user_id;
  DELETE FROM public.tokentracker_hourly WHERE user_id=p_user_id; GET DIAGNOSTICS v_hot=ROW_COUNT;
  DELETE FROM public.tokentracker_account_session_states WHERE user_id=p_user_id; GET DIAGNOSTICS v_sessions=ROW_COUNT;
  DELETE FROM public.tokentracker_usage_archive_manifest WHERE user_id=p_user_id; GET DIAGNOSTICS v_cold=ROW_COUNT;
  DELETE FROM public.tokentracker_usage_archive_generations WHERE user_id=p_user_id;
  DELETE FROM public.tokentracker_usage_dirty_days WHERE user_id=p_user_id;
  DELETE FROM public.tokentracker_account_usage_cache WHERE split_part(cache_key,chr(31),2)=p_user_id::text;
  -- Existing delete triggers update this user's lifetime total. Other users
  -- remain untouched; the retained financial tables and auth identity are not deleted.
  DELETE FROM public.tokentracker_leaderboard_rollup_daily_v2 WHERE user_id=p_user_id; GET DIAGNOSTICS v_days=ROW_COUNT;
  DELETE FROM public.tokentracker_leaderboard_rollup_total_v2 WHERE user_id=p_user_id;
  -- Explicit compatibility/materialized tables inspected in the hosted schema.
  -- No schema-wide sweep; never remove a whole leaderboard snapshot.
  FOREACH v_table IN ARRAY ARRAY['tokentracker_leaderboard_snapshots','agentmeter_leaderboard_snapshots',
    'tokentracker_leaderboard_rollup_daily','agentmeter_hourly'] LOOP
    IF to_regclass('public.'||v_table) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE user_id=$1',v_table) USING p_user_id;
      GET DIAGNOSTICS v_deleted=ROW_COUNT;
      v_derived:=v_derived||jsonb_build_object(v_table,v_deleted);
    END IF;
  END LOOP;
  UPDATE public.tokentracker_usage_maintenance_operations SET status='cancelled',scope='{}',result=NULL
    WHERE user_id=p_user_id AND id<>p_operation;
  v_result:=jsonb_build_object('erased_user',p_user_id,'deleted_hot_rows',v_hot,'deleted_sessions',v_sessions,
    'deleted_cold_days',v_cold,'deleted_public_daily_rows',v_days,'deleted_derived_rows',v_derived,
    'financial_records_preserved',true,'auth_preserved',true);
  UPDATE public.tokentracker_usage_maintenance_operations SET status='done',result=v_result,completed_at=clock_timestamp() WHERE id=p_operation;
  RETURN v_result;
END $f$;

CREATE FUNCTION public.cloud_usage_maintenance_plan(p_action text,p_user_id uuid,p_device_id uuid DEFAULT NULL,
  p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_limit integer DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO public,pg_temp AS $f$
DECLARE v_targets jsonb; v_available bigint; v_cut date:=((now()-interval '90 days') AT TIME ZONE 'UTC')::date;
  v_table text; v_rows bigint; v_derived jsonb:='{}';
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'An exact user scope is required'; END IF;
  IF p_limit<1 OR p_limit>(CASE WHEN p_action='cleanup' THEN 1000 ELSE 100 END)
    OR (p_from IS NOT NULL AND p_to IS NOT NULL AND p_from>=p_to) THEN RAISE EXCEPTION 'Invalid bounded maintenance range'; END IF;
  IF p_action='archive' THEN
    WITH eligible AS MATERIALIZED(SELECT h.user_id,h.device_id,(h.hour_start AT TIME ZONE 'UTC')::date AS day,count(*) AS hot_rows
      FROM public.tokentracker_hourly h WHERE h.user_id=p_user_id AND (p_device_id IS NULL OR h.device_id=p_device_id)
        AND h.hour_start<v_cut::timestamp AT TIME ZONE 'UTC'
        AND (p_from IS NULL OR h.hour_start>=p_from::timestamp AT TIME ZONE 'UTC')
        AND (p_to IS NULL OR h.hour_start<p_to::timestamp AT TIME ZONE 'UTC')
      GROUP BY h.user_id,h.device_id,(h.hour_start AT TIME ZONE 'UTC')::date),
    selected AS(SELECT * FROM eligible ORDER BY day,device_id LIMIT p_limit)
    SELECT (SELECT count(*) FROM eligible),COALESCE(jsonb_agg(to_jsonb(selected) ORDER BY day,device_id),'[]') INTO v_available,v_targets FROM selected;
  ELSIF p_action='restore' THEN
    WITH eligible AS MATERIALIZED(SELECT m.user_id,m.device_id,m.day,m.generation_id,g.row_count AS cold_rows
      FROM public.tokentracker_usage_archive_manifest m JOIN public.tokentracker_usage_archive_generations g ON g.id=m.generation_id
      WHERE m.user_id=p_user_id AND (p_device_id IS NULL OR m.device_id=p_device_id)
        AND (p_from IS NULL OR m.day>=p_from) AND (p_to IS NULL OR m.day<p_to)),
    selected AS(SELECT * FROM eligible ORDER BY day,device_id LIMIT p_limit)
    SELECT (SELECT count(*) FROM eligible),COALESCE(jsonb_agg(to_jsonb(selected) ORDER BY day,device_id),'[]') INTO v_available,v_targets FROM selected;
  ELSIF p_action='cleanup' THEN
    WITH eligible AS MATERIALIZED(SELECT g.id AS generation_id FROM public.tokentracker_usage_archive_generations g
      WHERE g.user_id=p_user_id AND g.status='superseded' AND g.payload IS NULL
        AND g.committed_at<now()-interval '30 days'
        AND NOT EXISTS(SELECT 1 FROM public.tokentracker_usage_archive_manifest m WHERE m.generation_id=g.id)),
    selected AS(SELECT * FROM eligible ORDER BY generation_id LIMIT p_limit)
    SELECT (SELECT count(*) FROM eligible),COALESCE(jsonb_agg(to_jsonb(selected)),'[]') INTO v_available,v_targets FROM selected;
  ELSIF p_action='erase-user' THEN
    FOREACH v_table IN ARRAY ARRAY['tokentracker_leaderboard_snapshots','agentmeter_leaderboard_snapshots',
      'tokentracker_leaderboard_rollup_daily','agentmeter_hourly'] LOOP
      IF to_regclass('public.'||v_table) IS NOT NULL THEN
        EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id=$1',v_table) INTO v_rows USING p_user_id;
        v_derived:=v_derived||jsonb_build_object(v_table,v_rows);
      END IF;
    END LOOP;
    v_available:=1; v_targets:=jsonb_build_array(jsonb_build_object('user_id',p_user_id,
      'hot_rows',(SELECT count(*) FROM public.tokentracker_hourly WHERE user_id=p_user_id),
      'session_rows',(SELECT count(*) FROM public.tokentracker_account_session_states WHERE user_id=p_user_id),
      'cold_days',(SELECT count(*) FROM public.tokentracker_usage_archive_manifest WHERE user_id=p_user_id),
      'generation_rows',(SELECT count(*) FROM public.tokentracker_usage_archive_generations WHERE user_id=p_user_id),
      'public_daily_rows',(SELECT count(*) FROM public.tokentracker_leaderboard_rollup_daily_v2 WHERE user_id=p_user_id),
      'derived_rows',v_derived));
  ELSE RAISE EXCEPTION 'Unknown maintenance action'; END IF;
  RETURN jsonb_build_object('action',p_action,'user_id',p_user_id,'device_id',p_device_id,'from',p_from,
    'to_exclusive',p_to,'hot_cutoff_exclusive',v_cut,'limit',p_limit,'available_targets',v_available,
    'selected_targets',jsonb_array_length(v_targets),'targets',v_targets);
END $f$;

-- Modify only the inspected RPCs named below, retaining their OIDs and ACLs.
-- Abort on shape drift; do not sweep/replace arbitrary function bodies.
DO $wire$
DECLARE v_def text; v_old text; v_pricing text;
BEGIN
  SELECT pg_get_functiondef('public.account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)'::regprocedure) INTO v_def;
  v_old:='FROM public.tokentracker_hourly h';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'Account usage SQL shape drift'; END IF;
  v_def:=replace(v_def,v_old,'FROM public.cloud_usage_hourly(p_user_id,NULL,p_from,p_to) h');
  v_pricing:=substring(v_def FROM E'CASE\n        WHEN lower\\(model\\) LIKE [\\s\\S]+?END AS pricing_tier,');
  IF v_pricing IS NULL OR position('deepseek-v4-pro' IN v_pricing)=0 THEN RAISE EXCEPTION 'Account pricing SQL shape drift'; END IF;
  v_def:=replace(v_def,v_pricing,'public.leaderboard_pricing_tier(model,hour_start) AS pricing_tier,');
  EXECUTE v_def;

  SELECT pg_get_functiondef('public.leaderboard_hourly_dedup_v2(timestamptz,timestamptz)'::regprocedure) INTO v_def;
  v_old:='FROM tokentracker_hourly h';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>2 THEN RAISE EXCEPTION 'Leaderboard hourly SQL shape drift'; END IF;
  EXECUTE replace(v_def,v_old,'FROM public.cloud_usage_hourly(NULL,NULL,p_from,p_to) h');

  SELECT pg_get_functiondef('public.refresh_tokentracker_device_identity(uuid,uuid,text,text)'::regprocedure) INTO v_def;
  v_old:=E'BEGIN\n  SELECT d.device_name';
  IF position(v_old IN v_def)=0 THEN RAISE EXCEPTION 'Legacy identity lock SQL shape drift'; END IF;
  v_def:=replace(v_def,v_old,E'BEGIN\n  PERFORM public.cloud_usage_maintenance_lock(p_user_id);\n  SELECT d.device_name');
  v_old:=E'    DELETE FROM public.tokentracker_hourly\n    WHERE user_id = p_user_id';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'Legacy identity SQL shape drift'; END IF;
  EXECUTE replace(v_def,v_old,E'    PERFORM public.cloud_merge_usage_archive(p_user_id,v_legacy_id,p_device_id);\n\n'||v_old);

  SELECT pg_get_functiondef('public.leaderboard_rollup_daily_advance_v2()'::regprocedure) INTO v_def;
  v_old:=E'  SELECT\n    (date_trunc(''day'', MIN(h.hour_start) AT TIME ZONE ''UTC'') AT TIME ZONE ''UTC'')::date\n  INTO v_min_day\n  FROM public.tokentracker_hourly h;';
  IF position(v_old IN v_def)=0 THEN RAISE EXCEPTION 'Rollup advance SQL shape drift'; END IF;
  v_def:=replace(v_def,v_old,E'  PERFORM public.cloud_repair_usage_days(7);\n  SELECT min(day) INTO v_min_day FROM (\n    SELECT (min(hour_start) AT TIME ZONE ''UTC'')::date AS day FROM public.tokentracker_hourly\n    UNION ALL SELECT min(day) FROM public.tokentracker_usage_archive_manifest\n    UNION ALL SELECT (min(bucket_start) AT TIME ZONE ''UTC'')::date FROM public.tokentracker_account_session_states\n    UNION ALL SELECT min(day) FROM public.tokentracker_leaderboard_rollup_daily_v2\n  ) history;');
  EXECUTE v_def;

  IF to_regprocedure('public.cloud_issue_device_token(uuid,text,text,text,text,text[],uuid,text,boolean,text)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.cloud_issue_device_token(uuid,text,text,text,text,text[],uuid,text,boolean,text)'::regprocedure) INTO v_def;
    v_old:=E'BEGIN\n  PERFORM public.cloud_reconcile_machines(p_user_id,p_environment);';
    IF position(v_old IN v_def)=0 THEN RAISE EXCEPTION 'Cloud issuer maintenance lock SQL shape drift'; END IF;
    EXECUTE replace(v_def,v_old,E'BEGIN\n  PERFORM public.cloud_usage_maintenance_lock(p_user_id);\n  PERFORM public.cloud_reconcile_machines(p_user_id,p_environment);');
  END IF;
  IF to_regprocedure('public.cloud_ingest_usage(text,text,jsonb,jsonb,text)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.cloud_ingest_usage(text,text,jsonb,jsonb,text)'::regprocedure) INTO v_def;
    v_old:='  PERFORM public.cloud_reconcile_machines(v_token.user_id,p_environment);';
    IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'Cloud ingest maintenance lock SQL shape drift'; END IF;
    EXECUTE replace(v_def,v_old,E'  PERFORM public.cloud_usage_maintenance_lock(v_token.user_id);\n'||v_old);
  END IF;
END $wire$;

REVOKE ALL ON FUNCTION public.cloud_usage_written(),public.cloud_usage_cache_written(),public.cloud_usage_hourly(uuid,uuid,timestamptz,timestamptz),
  public.cloud_prepare_usage_archive(uuid,uuid,date),public.cloud_commit_usage_archive(uuid),
  public.cloud_merge_usage_archive(uuid,uuid,uuid),public.cloud_repair_usage_days(integer),
  public.cloud_usage_maintenance_lock(uuid),public.cloud_usage_begin_operation(uuid,uuid,text,jsonb),
  public.cloud_prepare_usage_archive_operation(uuid,uuid,uuid,date),public.cloud_commit_usage_archive_operation(uuid),
  public.cloud_restore_usage_archive(uuid,uuid,uuid,date),public.cloud_cleanup_usage_archive(uuid,uuid,integer),
  public.cloud_erase_user_usage(uuid,uuid,uuid),public.cloud_usage_maintenance_plan(text,uuid,uuid,date,date,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_usage_written(),public.cloud_usage_cache_written(),public.cloud_usage_hourly(uuid,uuid,timestamptz,timestamptz),
  public.cloud_prepare_usage_archive(uuid,uuid,date),public.cloud_commit_usage_archive(uuid),
  public.cloud_merge_usage_archive(uuid,uuid,uuid),public.cloud_repair_usage_days(integer),
  public.cloud_usage_maintenance_lock(uuid),public.cloud_usage_begin_operation(uuid,uuid,text,jsonb),
  public.cloud_prepare_usage_archive_operation(uuid,uuid,uuid,date),public.cloud_commit_usage_archive_operation(uuid),
  public.cloud_restore_usage_archive(uuid,uuid,uuid,date),public.cloud_cleanup_usage_archive(uuid,uuid,integer),
  public.cloud_erase_user_usage(uuid,uuid,uuid),public.cloud_usage_maintenance_plan(text,uuid,uuid,date,date,integer) TO project_admin;
-- Clear old cached tier results after the canonical pricing call is wired.
TRUNCATE public.tokentracker_account_usage_cache;
