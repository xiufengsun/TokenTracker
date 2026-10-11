-- Stable synchronization slots. Display names and OS-derived machine ids are
-- aliases, not hardware attestation. Preview preserves pre-launch access.
CREATE TABLE public.tokentracker_cloud_machines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL REFERENCES public.tokentracker_cloud_policy(environment),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','merged')),
  merged_into uuid REFERENCES public.tokentracker_cloud_machines(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz,
  last_upload_at timestamptz,
  upload_window_until timestamptz,
  upload_token_id uuid,
  upload_id text,
  upload_batch_count integer NOT NULL DEFAULT 0 CHECK (upload_batch_count >= 0),
  UNIQUE (user_id, environment, id),
  CHECK ((status = 'merged') = (merged_into IS NOT NULL))
);
CREATE TABLE public.tokentracker_cloud_machine_aliases (
  user_id uuid NOT NULL,
  environment text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('device','machine','cluster')),
  alias text NOT NULL,
  machine_id uuid NOT NULL,
  PRIMARY KEY (user_id, environment, kind, alias),
  FOREIGN KEY (user_id, environment, machine_id)
    REFERENCES public.tokentracker_cloud_machines(user_id, environment, id)
);
CREATE INDEX tokentracker_cloud_machine_aliases_slot_idx
  ON public.tokentracker_cloud_machine_aliases (user_id, environment, machine_id);
ALTER TABLE public.tokentracker_cloud_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_cloud_machine_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_cloud_machines, public.tokentracker_cloud_machine_aliases
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tokentracker_cloud_machines, public.tokentracker_cloud_machine_aliases TO project_admin;

-- Existing tokens belong to the live project. Sandbox issuance cannot grant
-- live access; identity is read from the token table, never from request JSON.
ALTER TABLE public.tokentracker_device_tokens ADD COLUMN cloud_environment text
  NOT NULL DEFAULT 'live';
-- Enforce new writes now; validate existing tokens in a separate transaction
-- so the initial schema change does not scan the large live token table.
ALTER TABLE public.tokentracker_device_tokens
  ADD CONSTRAINT tokentracker_device_tokens_cloud_environment_fkey
  FOREIGN KEY (cloud_environment) REFERENCES public.tokentracker_cloud_policy(environment) NOT VALID;

CREATE FUNCTION public.cloud_merge_machine_slots(p_user_id uuid, p_environment text, p_ids uuid[])
RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_id uuid; v_paused boolean;
BEGIN
  SELECT id INTO v_id FROM public.tokentracker_cloud_machines
    WHERE user_id=p_user_id AND environment=p_environment AND id=ANY(p_ids)
    ORDER BY created_at,id LIMIT 1;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  SELECT bool_or(status='paused') INTO v_paused FROM public.tokentracker_cloud_machines
    WHERE user_id=p_user_id AND environment=p_environment AND id=ANY(p_ids);
  UPDATE public.tokentracker_cloud_machines SET
    status=CASE WHEN v_paused THEN 'paused' ELSE 'active' END,
    last_seen_at=(SELECT max(last_seen_at) FROM public.tokentracker_cloud_machines WHERE id=ANY(p_ids)),
    last_upload_at=(SELECT max(last_upload_at) FROM public.tokentracker_cloud_machines WHERE id=ANY(p_ids)),
    upload_window_until=NULL, upload_token_id=NULL, upload_id=NULL
    WHERE id=v_id AND (SELECT count(DISTINCT value) FROM unnest(p_ids) value)>1;
  UPDATE public.tokentracker_cloud_machine_aliases SET machine_id=v_id
    WHERE user_id=p_user_id AND environment=p_environment AND machine_id=ANY(p_ids);
  UPDATE public.tokentracker_cloud_machines SET status='merged', merged_into=v_id,
    upload_window_until=NULL, upload_token_id=NULL, upload_id=NULL
    WHERE user_id=p_user_id AND environment=p_environment AND id<>v_id
      AND (id=ANY(p_ids) OR merged_into=ANY(p_ids));
  RETURN v_id;
END;
$fn$;

CREATE FUNCTION public.cloud_bind_device_slot(p_user_id uuid, p_environment text, p_device_id uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_device public.tokentracker_devices%ROWTYPE; v_cluster text; v_ids uuid[]; v_id uuid;
BEGIN
  SELECT * INTO STRICT v_device FROM public.tokentracker_devices WHERE id=p_device_id AND user_id=p_user_id;
  SELECT machine_cluster_id INTO v_cluster FROM public.tokentracker_device_machine WHERE device_id=p_device_id;
  SELECT array_agg(DISTINCT machine_id) INTO v_ids FROM public.tokentracker_cloud_machine_aliases
    WHERE user_id=p_user_id AND environment=p_environment AND
      ((kind='device' AND alias=p_device_id::text) OR
       (kind='machine' AND alias=v_device.machine_id) OR (kind='cluster' AND alias=v_cluster));
  v_id := public.cloud_merge_machine_slots(p_user_id,p_environment,v_ids);
  IF v_id IS NULL THEN
    INSERT INTO public.tokentracker_cloud_machines(user_id,environment,status)
      VALUES(p_user_id,p_environment,CASE WHEN v_device.revoked_at IS NULL THEN 'active' ELSE 'paused' END)
      RETURNING id INTO v_id;
  END IF;
  INSERT INTO public.tokentracker_cloud_machine_aliases(user_id,environment,kind,alias,machine_id)
    SELECT p_user_id,p_environment,k,a,v_id FROM (VALUES
      ('device',p_device_id::text),('machine',v_device.machine_id),('cluster',v_cluster)) AS aliases(k,a)
    WHERE a IS NOT NULL
    ON CONFLICT (user_id,environment,kind,alias) DO UPDATE SET machine_id=excluded.machine_id;
  RETURN v_id;
END;
$fn$;

CREATE FUNCTION public.cloud_reconcile_machines(p_user_id uuid, p_environment text)
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_device record;
BEGIN
  -- Use the billing lock first, so a refund/renewal and admission have one
  -- order. A user-wide lock then serializes live/sandbox device-row adoption.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_environment,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':cloud-device',0));
  FOR v_device IN SELECT id FROM public.tokentracker_devices WHERE user_id=p_user_id
    AND (revoked_at IS NULL OR EXISTS (SELECT 1 FROM public.tokentracker_cloud_machine_aliases
      WHERE user_id=p_user_id AND environment=p_environment AND kind='device' AND alias=id::text))
    ORDER BY created_at,id
  LOOP
    PERFORM public.cloud_bind_device_slot(p_user_id,p_environment,v_device.id);
  END LOOP;
END;
$fn$;

CREATE FUNCTION public.cloud_list_machines(p_user_id uuid, p_environment text, p_current_machine_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_membership jsonb; v_current uuid; v_machines jsonb; v_count integer;
BEGIN
  PERFORM public.cloud_reconcile_machines(p_user_id,p_environment);
  v_membership:=public.cloud_membership(p_user_id,p_environment);
  SELECT machine_id INTO v_current FROM public.tokentracker_cloud_machine_aliases
    WHERE user_id=p_user_id AND environment=p_environment AND kind='machine' AND alias=p_current_machine_id;
  SELECT count(*) FILTER (WHERE m.status='active'), coalesce(jsonb_agg(jsonb_build_object(
    'machine_id',m.id,'name',coalesce(d.device_name,'Token Tracker'),'platform',d.platform,
    'last_seen_at',m.last_seen_at,'is_current',coalesce(m.id=v_current OR m.id::text=p_current_machine_id,false),
    'status',m.status) ORDER BY m.created_at,m.id),'[]'::jsonb)
  INTO v_count,v_machines FROM public.tokentracker_cloud_machines m
  LEFT JOIN LATERAL (SELECT device_name,platform FROM public.tokentracker_devices d
    JOIN public.tokentracker_cloud_machine_aliases a ON a.kind='device' AND a.alias=d.id::text
      AND a.user_id=m.user_id AND a.environment=m.environment AND a.machine_id=m.id
    ORDER BY d.name_customized DESC,d.revoked_at NULLS FIRST,d.created_at,d.id LIMIT 1) d ON true
  WHERE m.user_id=p_user_id AND m.environment=p_environment AND m.status<>'merged';
  RETURN jsonb_build_object('machines',v_machines,'machine_count',v_count,
    'machine_limit',v_membership->'machine_limit','membership',v_membership,
    'over_machine_limit',(v_membership->>'machine_limit')::integer<v_count);
END;
$fn$;

CREATE FUNCTION public.cloud_set_machine_status(p_user_id uuid,p_environment text,p_machine_id uuid,p_status text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_machine public.tokentracker_cloud_machines%ROWTYPE; v_state jsonb; v_limit integer; v_count integer;
BEGIN
  PERFORM public.cloud_reconcile_machines(p_user_id,p_environment);
  SELECT * INTO v_machine FROM public.tokentracker_cloud_machines
    WHERE id=p_machine_id AND user_id=p_user_id AND environment=p_environment;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','cloud_machine_not_found','status',404); END IF;
  IF v_machine.status='merged' THEN
    SELECT * INTO v_machine FROM public.tokentracker_cloud_machines WHERE id=v_machine.merged_into;
  END IF;
  IF p_status='active' AND v_machine.status<>'active' THEN
    v_state:=public.cloud_membership(p_user_id,p_environment);
    v_limit:=(v_state->>'machine_limit')::integer;
    SELECT count(*) INTO v_count FROM public.tokentracker_cloud_machines
      WHERE user_id=p_user_id AND environment=p_environment AND status='active';
    IF v_limit IS NOT NULL AND v_count>=v_limit THEN
      RETURN jsonb_build_object('ok',false,'code','cloud_machine_limit','status',409,
        'membership',v_state,'recovery_url','https://www.tokentracker.cc/cloud');
    END IF;
  END IF;
  UPDATE public.tokentracker_cloud_machines SET status=p_status,upload_window_until=NULL,
    upload_token_id=NULL,upload_id=NULL WHERE id=v_machine.id;
  IF p_status='paused' THEN
    UPDATE public.tokentracker_device_tokens SET revoked_at=clock_timestamp()
      WHERE user_id=p_user_id AND cloud_environment=p_environment AND revoked_at IS NULL
      AND device_id::text IN (SELECT alias FROM public.tokentracker_cloud_machine_aliases
        WHERE user_id=p_user_id AND environment=p_environment AND kind='device' AND machine_id=v_machine.id);
  END IF;
  RETURN public.cloud_list_machines(p_user_id,p_environment,NULL) || jsonb_build_object('ok',true);
END;
$fn$;
CREATE FUNCTION public.cloud_remove_machine(p_user_id uuid,p_environment text,p_machine_id uuid)
RETURNS jsonb LANGUAGE sql SET search_path = public, pg_temp AS $fn$
  SELECT public.cloud_set_machine_status(p_user_id,p_environment,p_machine_id,'paused');
$fn$;
CREATE FUNCTION public.cloud_resume_machine(p_user_id uuid,p_environment text,p_machine_id uuid)
RETURNS jsonb LANGUAGE sql SET search_path = public, pg_temp AS $fn$
  SELECT public.cloud_set_machine_status(p_user_id,p_environment,p_machine_id,'active');
$fn$;

CREATE FUNCTION public.cloud_issue_device_token(
  p_user_id uuid,p_environment text,p_device_name text,p_platform text,p_machine_id text,
  p_legacy_names text[],p_token_id uuid,p_token_hash text,p_rotate boolean DEFAULT false,p_device_code text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_device public.tokentracker_devices%ROWTYPE; v_legacy uuid; v_slot uuid; v_other uuid;
  v_state jsonb; v_limit integer; v_count integer; v_name text; v_code record; v_known_slot uuid;
BEGIN
  PERFORM public.cloud_reconcile_machines(p_user_id,p_environment);
  IF p_device_code IS NOT NULL THEN
    SELECT * INTO v_code FROM public.tokentracker_device_codes WHERE device_code=p_device_code FOR UPDATE;
    IF NOT FOUND OR v_code.user_id IS DISTINCT FROM p_user_id OR v_code.status<>'approved'
      OR v_code.expires_at<=clock_timestamp() THEN
      RETURN jsonb_build_object('ok',false,'code','cloud_device_code_expired','status',410);
    END IF;
  END IF;
  v_state:=public.cloud_membership(p_user_id,p_environment);
  v_limit:=(v_state->>'machine_limit')::integer;
  SELECT machine_id INTO v_known_slot FROM public.tokentracker_cloud_machine_aliases
    WHERE user_id=p_user_id AND environment=p_environment AND kind='machine' AND alias=p_machine_id;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_machines WHERE id=v_known_slot AND status='paused') THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_machine_paused','status',403,
      'membership',v_state,'machine_id',v_known_slot,'recovery_url','https://www.tokentracker.cc/cloud');
  END IF;
  IF p_machine_id IS NOT NULL THEN
    SELECT * INTO v_device FROM public.tokentracker_devices WHERE user_id=p_user_id
      AND machine_id=p_machine_id AND revoked_at IS NULL ORDER BY created_at,id LIMIT 1;
  END IF;
  IF v_device.id IS NULL THEN
    SELECT * INTO v_device FROM public.tokentracker_devices WHERE user_id=p_user_id
      AND platform IS NOT DISTINCT FROM p_platform AND revoked_at IS NULL
      AND (p_machine_id IS NULL OR machine_id IS NULL)
      AND (device_name=ANY(p_legacy_names) OR default_device_name=ANY(p_legacy_names))
      ORDER BY (device_name=p_device_name) DESC,created_at,id LIMIT 1;
  ELSE
    -- The old identity refresh may absorb a legacy row and move its tokens.
    -- Merge its existing slot before that row is revoked by the original RPC.
    SELECT id INTO v_legacy FROM public.tokentracker_devices WHERE user_id=p_user_id
      AND id<>v_device.id AND revoked_at IS NULL AND machine_id IS NULL
      AND platform IS NOT DISTINCT FROM p_platform
      AND (device_name=p_device_name OR default_device_name=p_device_name)
      ORDER BY created_at,id LIMIT 1;
    IF v_legacy IS NOT NULL THEN
      v_slot:=public.cloud_bind_device_slot(p_user_id,p_environment,v_device.id);
      v_other:=public.cloud_bind_device_slot(p_user_id,p_environment,v_legacy);
      PERFORM public.cloud_merge_machine_slots(p_user_id,p_environment,ARRAY[v_slot,v_other]);
    END IF;
    PERFORM public.refresh_tokentracker_device_identity(p_user_id,v_device.id,p_device_name,p_platform);
  END IF;
  IF v_device.id IS NULL THEN
    SELECT count(*) INTO v_count FROM public.tokentracker_cloud_machines
      WHERE user_id=p_user_id AND environment=p_environment AND status='active';
    IF v_known_slot IS NULL AND v_limit IS NOT NULL AND v_count>=v_limit THEN
      RETURN jsonb_build_object('ok',false,'code','cloud_machine_limit','status',409,
        'membership',v_state,'machine_count',v_count,'recovery_url','https://www.tokentracker.cc/cloud');
    END IF;
    v_name:=p_device_name;
    IF EXISTS (SELECT 1 FROM public.tokentracker_devices WHERE user_id=p_user_id AND platform=p_platform
      AND device_name=v_name AND revoked_at IS NULL) THEN
      v_name:=left(p_device_name,116) || ' #' || left(coalesce(p_machine_id,p_token_id::text),8);
    END IF;
    INSERT INTO public.tokentracker_devices(id,user_id,device_name,platform,machine_id)
      VALUES(gen_random_uuid(),p_user_id,v_name,p_platform,p_machine_id)
      ON CONFLICT DO NOTHING RETURNING * INTO v_device;
    IF v_device.id IS NULL AND p_machine_id IS NOT NULL THEN
      -- Legacy rename/create paths do not take the account lock. Only an
      -- exact machine identity may win that race; a matching name cannot.
      SELECT * INTO v_device FROM public.tokentracker_devices WHERE user_id=p_user_id
        AND machine_id=p_machine_id AND revoked_at IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE;
    END IF;
    IF v_device.id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'code','cloud_device_identity_conflict','status',409,
        'membership',v_state,'recovery_url','https://www.tokentracker.cc/cloud');
    END IF;
  ELSE
    v_slot:=public.cloud_bind_device_slot(p_user_id,p_environment,v_device.id);
    IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_machines WHERE id=v_slot AND status='paused') THEN
      RETURN jsonb_build_object('ok',false,'code','cloud_machine_paused','status',403,
        'membership',v_state,'machine_id',v_slot,'recovery_url','https://www.tokentracker.cc/cloud');
    END IF;
    IF p_machine_id IS NOT NULL AND v_device.machine_id IS NULL THEN
      BEGIN
        UPDATE public.tokentracker_devices SET machine_id=p_machine_id,
          device_name=CASE WHEN name_customized THEN device_name ELSE p_device_name END WHERE id=v_device.id;
      EXCEPTION WHEN unique_violation THEN
        BEGIN
          UPDATE public.tokentracker_devices SET machine_id=p_machine_id WHERE id=v_device.id;
        EXCEPTION WHEN unique_violation THEN
          RETURN jsonb_build_object('ok',false,'code','cloud_device_identity_conflict','status',409,
            'membership',v_state,'recovery_url','https://www.tokentracker.cc/cloud');
        END;
      END;
    END IF;
  END IF;
  v_slot:=public.cloud_bind_device_slot(p_user_id,p_environment,v_device.id);
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_machines WHERE id=v_slot AND status='paused') THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_machine_paused','status',403,
      'membership',v_state,'machine_id',v_slot,'recovery_url','https://www.tokentracker.cc/cloud');
  END IF;
  SELECT count(*) INTO v_count FROM public.tokentracker_cloud_machines
    WHERE user_id=p_user_id AND environment=p_environment AND status='active';
  IF v_limit IS NOT NULL AND v_count>v_limit AND NOT coalesce((v_state->>'transition_ends_at')::timestamptz>clock_timestamp(),false) THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_machine_limit','status',409,
      'membership',v_state,'machine_count',v_count,'recovery_url','https://www.tokentracker.cc/cloud');
  END IF;
  IF p_rotate THEN
    UPDATE public.tokentracker_device_tokens SET revoked_at=clock_timestamp()
      WHERE device_id=v_device.id AND cloud_environment=p_environment AND revoked_at IS NULL;
  END IF;
  INSERT INTO public.tokentracker_device_tokens(id,user_id,device_id,token_hash,cloud_environment)
    VALUES(p_token_id,p_user_id,v_device.id,p_token_hash,p_environment);
  RETURN jsonb_build_object('ok',true,'device_id',v_device.id,'machine_id',v_slot,
    'created_at',clock_timestamp(),'membership',v_state);
END;
$fn$;

CREATE FUNCTION public.cloud_grant_device_code(p_user_id uuid,p_environment text,p_user_code text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_code public.tokentracker_device_codes%ROWTYPE; v_state jsonb; v_slot uuid;
BEGIN
  PERFORM public.cloud_reconcile_machines(p_user_id,p_environment);
  SELECT * INTO v_code FROM public.tokentracker_device_codes WHERE user_code=p_user_code FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','cloud_device_code_unknown','status',404); END IF;
  IF v_code.expires_at<=clock_timestamp() THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_device_code_expired','status',410);
  END IF;
  IF v_code.status='approved' AND v_code.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_device_code_claimed','status',409);
  END IF;
  SELECT machine_id INTO v_slot FROM public.tokentracker_cloud_machine_aliases
    WHERE user_id=p_user_id AND environment=p_environment AND kind='machine' AND alias=v_code.machine_id;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_machines WHERE id=v_slot AND status='paused') THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_machine_paused','status',403,
      'machine_id',v_slot,'recovery_url','https://www.tokentracker.cc/cloud');
  END IF;
  -- Final identity resolution and quota admission happen at token issuance.
  v_state:=public.cloud_membership(p_user_id,p_environment);
  UPDATE public.tokentracker_device_codes SET status='approved',user_id=p_user_id,
    approved_at=coalesce(approved_at,clock_timestamp()) WHERE device_code=v_code.device_code;
  RETURN jsonb_build_object('ok',true,'status',CASE WHEN v_code.status='approved' THEN 'already_approved'
    ELSE 'approved' END,'client_info',v_code.client_info,'membership',v_state);
END;
$fn$;

CREATE FUNCTION public.cloud_account_access(p_user_id uuid,p_environment text,p_kind text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $fn$
DECLARE v_state jsonb; v_from date;
BEGIN
  v_state:=public.cloud_membership(p_user_id,p_environment);
  IF NOT (v_state->>'can_read_cloud')::boolean THEN
    RETURN jsonb_build_object('ok',false,'status',402,'code',CASE WHEN v_state->>'status'='expired'
      THEN 'cloud_read_only_expired' ELSE 'cloud_membership_required' END,
      'membership',v_state,'recovery_url','https://www.tokentracker.cc/cloud');
  END IF;
  IF v_state->>'phase'='active' THEN
    v_from:=CASE WHEN p_kind='hourly' THEN (now() AT TIME ZONE 'UTC')::date - 89
      ELSE ((now() AT TIME ZONE 'UTC')::date - interval '24 months')::date END;
  END IF;
  RETURN jsonb_build_object('ok',true,'membership',v_state,'available_from',v_from);
END;
$fn$;

CREATE FUNCTION public.cloud_ingest_usage(p_token_hash text,p_environment text,p_rows jsonb,p_states jsonb,p_upload_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_token public.tokentracker_device_tokens%ROWTYPE; v_device public.tokentracker_devices%ROWTYPE;
  v_slot uuid; v_machine public.tokentracker_cloud_machines%ROWTYPE; v_state jsonb; v_limit integer; v_count integer;
  v_now timestamptz:=clock_timestamp(); v_interval integer; v_max_batches integer; v_next timestamptz; v_continuation boolean; v_inserted integer;
BEGIN
  IF p_rows IS NULL OR p_states IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_typeof(p_states)<>'array'
    OR jsonb_array_length(p_rows)>500 OR jsonb_array_length(p_states)>500
    OR jsonb_array_length(p_rows)+jsonb_array_length(p_states)=0
    OR octet_length(p_rows::text)+octet_length(p_states::text)>1048576 THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_upload_size_exceeded','status',413);
  END IF;
  SELECT * INTO v_token FROM public.tokentracker_device_tokens WHERE token_hash=p_token_hash AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','cloud_device_token_rejected','status',401); END IF;
  IF v_token.cloud_environment IS DISTINCT FROM p_environment THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_environment_mismatch','status',401);
  END IF;
  PERFORM public.cloud_reconcile_machines(v_token.user_id,p_environment);
  v_now:=clock_timestamp();
  -- Removal and issuance use the same lock. Re-read after waiting for it.
  SELECT * INTO v_token FROM public.tokentracker_device_tokens WHERE token_hash=p_token_hash AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','cloud_device_token_rejected','status',401); END IF;
  IF v_token.cloud_environment IS DISTINCT FROM p_environment THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_environment_mismatch','status',401);
  END IF;
  SELECT * INTO STRICT v_device FROM public.tokentracker_devices WHERE id=v_token.device_id AND user_id=v_token.user_id;
  IF v_device.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_device_revoked','status',403);
  END IF;
  v_slot:=public.cloud_bind_device_slot(v_token.user_id,p_environment,v_token.device_id);
  SELECT * INTO STRICT v_machine FROM public.tokentracker_cloud_machines WHERE id=v_slot;
  v_state:=public.cloud_membership(v_token.user_id,p_environment);
  IF v_machine.status<>'active' THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_machine_paused','status',403,
      'membership',v_state,'recovery_url','https://www.tokentracker.cc/cloud');
  END IF;
  v_limit:=(v_state->>'machine_limit')::integer;
  SELECT count(*) INTO v_count FROM public.tokentracker_cloud_machines
    WHERE user_id=v_token.user_id AND environment=p_environment AND status='active';
  -- The promised transition deadline survives an early purchase. Afterwards
  -- users choose their five; new slots still pass the admission limit above.
  IF v_limit IS NOT NULL AND v_count>v_limit AND NOT coalesce((v_state->>'transition_ends_at')::timestamptz>clock_timestamp(),false) THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_machine_limit','status',409,
      'membership',v_state,'machine_count',v_count,'recovery_url','https://www.tokentracker.cc/cloud');
  END IF;
  v_interval:=(v_state->>'sync_interval_seconds')::integer;
  v_next:=CASE WHEN (v_state->>'can_upload_cloud')::boolean
    THEN v_machine.last_upload_at+make_interval(secs=>v_interval)
    ELSE date_trunc('day',v_machine.last_upload_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'+interval '1 day' END;
  v_max_batches:=CASE WHEN (v_state->>'can_upload_cloud')::boolean THEN 100 ELSE 10 END;
  v_continuation:=v_machine.upload_window_until>v_now AND v_machine.upload_batch_count<v_max_batches
    AND v_machine.upload_token_id=v_token.id
    AND v_machine.upload_id IS NOT DISTINCT FROM p_upload_id;
  IF v_state->>'phase'='active' AND v_next>v_now AND NOT coalesce(v_continuation,false) THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_sync_throttled','status',429,
      'next_allowed_at',v_next,'retry_after_seconds',greatest(1,ceil(extract(epoch FROM v_next-v_now))::integer),
      'membership',v_state,'recovery_url','https://www.tokentracker.cc/cloud');
  END IF;
  -- Each batch retains MAX within the batch, then replaces the complete row
  -- across requests. Never use GREATEST against the stored hourly snapshot.
  INSERT INTO public.tokentracker_hourly AS h(user_id,device_id,hour_start,source,model,input_tokens,
    cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
    billable_total_tokens,total_cost_usd,conversations,updated_at)
  SELECT v_token.user_id,v_token.device_id,x.hour_start,x.source,x.model,x.input_tokens,
    x.cached_input_tokens,x.cache_creation_input_tokens,x.output_tokens,x.reasoning_output_tokens,x.total_tokens,
    x.billable_total_tokens,x.total_cost_usd,x.conversations,v_now
  FROM (SELECT DISTINCT ON (hour_start,source,model) * FROM jsonb_to_recordset(p_rows) AS r(
    hour_start timestamptz,source text,model text,input_tokens bigint,cached_input_tokens bigint,
    cache_creation_input_tokens bigint,output_tokens bigint,reasoning_output_tokens bigint,total_tokens bigint,
    billable_total_tokens bigint,total_cost_usd numeric,conversations integer)
    ORDER BY hour_start,source,model,total_tokens DESC) x
  ON CONFLICT(user_id,device_id,hour_start,source,model) DO UPDATE SET
    input_tokens=excluded.input_tokens,cached_input_tokens=excluded.cached_input_tokens,
    cache_creation_input_tokens=excluded.cache_creation_input_tokens,output_tokens=excluded.output_tokens,
    reasoning_output_tokens=excluded.reasoning_output_tokens,total_tokens=excluded.total_tokens,
    billable_total_tokens=excluded.billable_total_tokens,total_cost_usd=excluded.total_cost_usd,
    conversations=excluded.conversations,updated_at=excluded.updated_at;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  IF jsonb_array_length(p_states)>0 THEN
    PERFORM public.tokentracker_upsert_account_session_states(v_token.user_id,p_states);
  END IF;
  IF NOT coalesce(v_continuation,false) THEN
    UPDATE public.tokentracker_cloud_machines SET last_upload_at=v_now,
      upload_window_until=v_now+interval '2 minutes',upload_token_id=v_token.id,upload_id=p_upload_id,
      upload_batch_count=0 WHERE id=v_slot;
    v_next:=CASE WHEN (v_state->>'can_upload_cloud')::boolean THEN v_now+make_interval(secs=>v_interval)
      ELSE date_trunc('day',v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'+interval '1 day' END;
  END IF;
  UPDATE public.tokentracker_cloud_machines SET last_seen_at=v_now,
    upload_batch_count=upload_batch_count+1 WHERE id=v_slot;
  RETURN jsonb_build_object('ok',true,'inserted',v_inserted,'skipped',0,'membership',v_state,
    'upload_scope',CASE WHEN (v_state->>'can_upload_cloud')::boolean THEN 'cloud' ELSE 'community' END,
    'next_allowed_at',CASE WHEN v_state->>'phase'='active' THEN v_next ELSE NULL END,
    'sync_interval_seconds',CASE WHEN v_state->>'phase'='active' THEN v_interval ELSE NULL END);
END;
$fn$;

REVOKE ALL ON FUNCTION public.cloud_merge_machine_slots(uuid,text,uuid[]),
 public.cloud_bind_device_slot(uuid,text,uuid),public.cloud_reconcile_machines(uuid,text),
 public.cloud_list_machines(uuid,text,text),public.cloud_set_machine_status(uuid,text,uuid,text),
 public.cloud_remove_machine(uuid,text,uuid),public.cloud_resume_machine(uuid,text,uuid),
 public.cloud_issue_device_token(uuid,text,text,text,text,text[],uuid,text,boolean,text),
 public.cloud_grant_device_code(uuid,text,text),public.cloud_account_access(uuid,text,text),public.cloud_ingest_usage(text,text,jsonb,jsonb,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_merge_machine_slots(uuid,text,uuid[]),
 public.cloud_bind_device_slot(uuid,text,uuid),public.cloud_reconcile_machines(uuid,text),
 public.cloud_list_machines(uuid,text,text),public.cloud_set_machine_status(uuid,text,uuid,text),
 public.cloud_remove_machine(uuid,text,uuid),public.cloud_resume_machine(uuid,text,uuid),
 public.cloud_issue_device_token(uuid,text,text,text,text,text[],uuid,text,boolean,text),
 public.cloud_grant_device_code(uuid,text,text),public.cloud_account_access(uuid,text,text),public.cloud_ingest_usage(text,text,jsonb,jsonb,text)
 TO project_admin;
