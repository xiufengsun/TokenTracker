-- Gifts are a separate entitlement ledger, never synthetic payments or subscriptions.
CREATE TABLE public.tokentracker_cloud_gift_batches (
  id uuid PRIMARY KEY,
  environment text NOT NULL REFERENCES public.tokentracker_cloud_policy(environment),
  duration_days integer NOT NULL CHECK (duration_days IN (30,90,365)),
  redeem_before timestamptz NOT NULL CHECK (isfinite(redeem_before)),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz,
  UNIQUE (id,environment)
);
CREATE TABLE public.tokentracker_cloud_gift_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  environment text NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  suffix text NOT NULL CHECK (suffix ~ '^[0-9A-F]{8}$'),
  FOREIGN KEY (batch_id,environment) REFERENCES public.tokentracker_cloud_gift_batches(id,environment),
  UNIQUE (environment,code_hash), UNIQUE (id,environment)
);
CREATE INDEX tokentracker_cloud_gift_codes_batch_idx ON public.tokentracker_cloud_gift_codes(batch_id,environment);
CREATE TABLE public.tokentracker_cloud_gift_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  environment text NOT NULL,
  request_id uuid NOT NULL,
  duration_days integer NOT NULL CHECK (duration_days IN (30,90,365)),
  redeemed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (code_id,environment) REFERENCES public.tokentracker_cloud_gift_codes(id,environment),
  UNIQUE (user_id,environment,request_id),
  CHECK (isfinite(starts_at) AND isfinite(ends_at) AND ends_at > starts_at),
  CHECK (revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at >= redeemed_at)),
  CHECK (ends_at = starts_at + duration_days * interval '24 hours')
);
CREATE INDEX tokentracker_cloud_gift_grants_user_idx ON public.tokentracker_cloud_gift_grants(user_id,environment,ends_at);
CREATE TABLE public.tokentracker_cloud_gift_attempts (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL REFERENCES public.tokentracker_cloud_policy(environment),
  window_started_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL CHECK (failed_attempts BETWEEN 0 AND 10),
  PRIMARY KEY (user_id,environment)
);
ALTER TABLE public.tokentracker_cloud_gift_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_cloud_gift_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_cloud_gift_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_cloud_gift_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_cloud_gift_batches,public.tokentracker_cloud_gift_codes,
  public.tokentracker_cloud_gift_grants,public.tokentracker_cloud_gift_attempts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.tokentracker_cloud_gift_batches,public.tokentracker_cloud_gift_codes,
  public.tokentracker_cloud_gift_grants,public.tokentracker_cloud_gift_attempts TO project_admin;

CREATE FUNCTION public.cloud_guard_gift_grant() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog,public,pg_temp AS $fn$
BEGIN
  IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR
    (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'gift grant history is immutable';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER cloud_gift_grant_immutable BEFORE UPDATE ON public.tokentracker_cloud_gift_grants
  FOR EACH ROW EXECUTE FUNCTION public.cloud_guard_gift_grant();

CREATE FUNCTION public.cloud_gift_view(p_grant public.tokentracker_cloud_gift_grants)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path = pg_catalog,public,pg_temp AS $fn$
  SELECT jsonb_build_object('id',p_grant.id,'duration_days',p_grant.duration_days,
    'redeemed_at',p_grant.redeemed_at,'starts_at',p_grant.starts_at,'ends_at',p_grant.ends_at,
    'revoked_at',p_grant.revoked_at,'state',CASE WHEN p_grant.revoked_at IS NOT NULL THEN 'revoked'
      WHEN p_grant.starts_at > clock_timestamp() THEN 'pending'
      WHEN p_grant.ends_at <= clock_timestamp() THEN 'expired' ELSE 'active' END);
$fn$;

CREATE FUNCTION public.cloud_create_gift_batch(p_environment text,p_batch_id uuid,p_duration_days integer,
  p_redeem_before timestamptz,p_label text,p_codes jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $fn$
DECLARE v_batch public.tokentracker_cloud_gift_batches%ROWTYPE; v_count integer;
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('live','sandbox') OR p_batch_id IS NULL OR
    p_duration_days IS NULL OR p_duration_days NOT IN (30,90,365) OR p_redeem_before IS NULL OR
    NOT isfinite(p_redeem_before) OR p_label IS NULL OR length(p_label) NOT BETWEEN 1 AND 120 OR
    jsonb_typeof(p_codes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid gift batch'; END IF;
  v_count := jsonb_array_length(p_codes);
  IF v_count NOT BETWEEN 1 AND 1000 OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_codes) c WHERE
    jsonb_typeof(c) <> 'object' OR c->>'code_hash' IS NULL OR c->>'code_hash' !~ '^[0-9a-f]{64}$' OR
    c->>'suffix' IS NULL OR c->>'suffix' !~ '^[0-9A-F]{8}$' OR
    (c-'code_hash'-'suffix') <> '{}'::jsonb) OR
    (SELECT count(DISTINCT c->>'code_hash') FROM jsonb_array_elements(p_codes) c) <> v_count THEN
    RAISE EXCEPTION 'invalid gift batch codes';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('gift-batch:'||p_batch_id::text,0));
  SELECT * INTO v_batch FROM public.tokentracker_cloud_gift_batches WHERE id=p_batch_id;
  IF FOUND THEN
    IF v_batch.environment IS DISTINCT FROM p_environment OR v_batch.duration_days IS DISTINCT FROM p_duration_days OR
      v_batch.redeem_before IS DISTINCT FROM p_redeem_before OR v_batch.label IS DISTINCT FROM p_label OR
      (SELECT jsonb_agg(jsonb_build_object('code_hash',code_hash,'suffix',suffix) ORDER BY code_hash)
        FROM public.tokentracker_cloud_gift_codes WHERE batch_id=p_batch_id) IS DISTINCT FROM
      (SELECT jsonb_agg(c ORDER BY c->>'code_hash') FROM jsonb_array_elements(p_codes) c) THEN
      RAISE EXCEPTION 'gift batch request conflicts with original batch';
    END IF;
    RETURN jsonb_build_object('id',v_batch.id,'environment',v_batch.environment,'count',v_count,'reused',true);
  END IF;
  IF p_redeem_before <= clock_timestamp() THEN RAISE EXCEPTION 'gift redemption deadline must be in the future'; END IF;
  INSERT INTO public.tokentracker_cloud_gift_batches(id,environment,duration_days,redeem_before,label)
    VALUES(p_batch_id,p_environment,p_duration_days,p_redeem_before,p_label);
  INSERT INTO public.tokentracker_cloud_gift_codes(batch_id,environment,code_hash,suffix)
    SELECT p_batch_id,p_environment,c->>'code_hash',c->>'suffix' FROM jsonb_array_elements(p_codes) c;
  RETURN jsonb_build_object('id',p_batch_id,'environment',p_environment,'count',v_count,'reused',false);
END;
$fn$;

CREATE FUNCTION public.cloud_list_gift_batches(p_environment text,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog,public,pg_temp AS $fn$
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('live','sandbox') OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid gift list';
  END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(b)) FROM (SELECT b.*,
      (SELECT count(*) FROM public.tokentracker_cloud_gift_codes c WHERE c.batch_id=b.id) AS code_count,
      (SELECT count(*) FROM public.tokentracker_cloud_gift_codes c JOIN public.tokentracker_cloud_gift_grants g
        ON g.code_id=c.id WHERE c.batch_id=b.id) AS redeemed_count
    FROM public.tokentracker_cloud_gift_batches b WHERE environment=p_environment
    ORDER BY created_at DESC,id LIMIT p_limit) b),'[]'::jsonb);
END;
$fn$;

CREATE FUNCTION public.cloud_list_gift_codes(p_environment text,p_batch_id uuid,p_limit integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog,public,pg_temp AS $fn$
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('live','sandbox') OR p_batch_id IS NULL OR
    p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'invalid gift list'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM (SELECT c.id,c.suffix,c.batch_id,g.id AS grant_id,
    g.user_id,g.redeemed_at,g.starts_at,g.ends_at,g.revoked_at FROM public.tokentracker_cloud_gift_codes c
    LEFT JOIN public.tokentracker_cloud_gift_grants g ON g.code_id=c.id
    WHERE c.environment=p_environment AND c.batch_id=p_batch_id ORDER BY c.id LIMIT p_limit) c),'[]'::jsonb);
END;
$fn$;

CREATE FUNCTION public.cloud_disable_gift_batch(p_environment text,p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $fn$
DECLARE v_batch public.tokentracker_cloud_gift_batches%ROWTYPE;
BEGIN
  UPDATE public.tokentracker_cloud_gift_batches SET disabled_at=coalesce(disabled_at,clock_timestamp())
    WHERE id=p_batch_id AND environment=p_environment RETURNING * INTO STRICT v_batch;
  RETURN jsonb_build_object('id',v_batch.id,'environment',v_batch.environment,'disabled_at',v_batch.disabled_at);
END;
$fn$;

CREATE FUNCTION public.cloud_revoke_gift(p_environment text,p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $fn$
DECLARE v_grant public.tokentracker_cloud_gift_grants%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_grant FROM public.tokentracker_cloud_gift_grants WHERE id=p_grant_id AND environment=p_environment;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_grant.user_id::text||':'||p_environment,0));
  UPDATE public.tokentracker_cloud_gift_grants SET revoked_at=coalesce(revoked_at,clock_timestamp())
    WHERE id=p_grant_id AND environment=p_environment RETURNING * INTO STRICT v_grant;
  RETURN public.cloud_gift_view(v_grant);
END;
$fn$;

ALTER FUNCTION public.cloud_membership(uuid,text) RENAME TO cloud_membership_before_gifts;
CREATE FUNCTION public.cloud_membership(p_user_id uuid,p_environment text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog,public,pg_temp AS $fn$
DECLARE
  v_state jsonb := public.cloud_membership_before_gifts(p_user_id,p_environment);
  v_now timestamptz := clock_timestamp(); v_end timestamptz := v_now;
  v_gift_end timestamptz; v_history_end timestamptz; v_status text;
  v_paid boolean := false; v_gift boolean := false; v_has_gift boolean; v_period record;
BEGIN
  v_state := v_state || jsonb_build_object('access_source','none','has_gift',false,'gift_expires_at',NULL);
  IF v_state->>'hosting_mode'='self_hosted' THEN RETURN v_state; END IF;
  SELECT max(ends_at),count(*)>0 INTO v_gift_end,v_has_gift FROM public.tokentracker_cloud_gift_grants
    WHERE user_id=p_user_id AND environment=p_environment AND revoked_at IS NULL AND ends_at>v_now;
  FOR v_period IN SELECT starts_at,ends_at,'payment' AS source FROM public.tokentracker_cloud_payments
    WHERE user_id=p_user_id AND environment=p_environment AND refunded_cents<amount_cents
      AND revoked_at IS NULL AND ends_at>v_now
    UNION ALL SELECT starts_at,ends_at,'gift' AS source FROM public.tokentracker_cloud_gift_grants
    WHERE user_id=p_user_id AND environment=p_environment AND revoked_at IS NULL AND ends_at>v_now
    ORDER BY starts_at,ends_at
  LOOP
    IF v_period.starts_at <= v_end THEN
      v_end := greatest(v_end,v_period.ends_at);
      IF v_period.starts_at<=v_now THEN
        IF v_period.source='payment' THEN v_paid:=true; ELSE v_gift:=true; END IF;
      END IF;
    END IF;
  END LOOP;
  SELECT max(least(ends_at,coalesce(revoked_at,ends_at))) INTO v_history_end
    FROM public.tokentracker_cloud_gift_grants WHERE user_id=p_user_id AND environment=p_environment
      AND starts_at<=v_now AND (revoked_at IS NULL OR revoked_at>starts_at);
  v_history_end := greatest(v_history_end + interval '30 days',(v_state->>'read_only_until')::timestamptz);
  v_status := v_state->>'status';
  IF v_state->>'phase'='active' THEN
    IF v_paid OR v_gift THEN v_status:='active';
    ELSIF v_status='free' AND v_history_end IS NOT NULL THEN v_status:='expired'; END IF;
  END IF;
  RETURN v_state || jsonb_build_object('status',v_status,'access_source',CASE
    WHEN v_state->>'phase'<>'active' THEN 'none' WHEN v_paid AND v_gift THEN 'mixed'
    WHEN v_paid THEN 'payment' WHEN v_gift THEN 'gift' ELSE 'none' END,
    'has_gift',v_has_gift,'gift_expires_at',v_gift_end,'expires_at',CASE WHEN v_status='active' THEN v_end
      ELSE (v_state->>'expires_at')::timestamptz END,
    'trial_available',(v_state->>'trial_available')::boolean AND NOT EXISTS (
      SELECT 1 FROM public.tokentracker_cloud_gift_grants WHERE user_id=p_user_id AND environment=p_environment),
    'read_only_until',v_history_end,'can_read_cloud',v_status IN ('legacy_free','active','trial','transition') OR
      (v_status='expired' AND coalesce(v_history_end>v_now,false)),
    'can_upload_cloud',v_status IN ('legacy_free','active','trial','transition'),
    'machine_limit',CASE WHEN v_status='legacy_free' THEN NULL WHEN v_status IN ('active','trial','transition') THEN 5 ELSE 1 END,
    'sync_interval_seconds',CASE WHEN v_status IN ('legacy_free','active','trial','transition') THEN 900 ELSE 86400 END);
END;
$fn$;

CREATE FUNCTION public.cloud_gift_account(p_user_id uuid,p_environment text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog,public,pg_temp AS $fn$
DECLARE v_available boolean; v_restriction text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id=p_user_id) THEN RAISE EXCEPTION 'gift account does not exist'; END IF;
  SELECT hosting_mode='hosted' AND phase='active' AND launch_at<=statement_timestamp()
    INTO STRICT v_available FROM public.tokentracker_cloud_policy WHERE environment=p_environment;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_subscriptions WHERE user_id=p_user_id AND environment=p_environment
      AND status IN ('pending','active','trialing','past_due','paused') AND NOT cancel_at_period_end) THEN
    v_restriction:='gift_requires_renewal_cancel';
  ELSIF EXISTS (SELECT 1 FROM public.tokentracker_cloud_orders WHERE user_id=p_user_id AND environment=p_environment
      AND status IN ('pending','ready')) THEN v_restriction:='gift_checkout_pending'; END IF;
  RETURN jsonb_build_object('gift_redemption_available',v_available,'redemption_restriction',v_restriction,'gifts',
    coalesce((SELECT jsonb_agg(public.cloud_gift_view(g)) FROM (SELECT * FROM public.tokentracker_cloud_gift_grants
      WHERE user_id=p_user_id AND environment=p_environment ORDER BY redeemed_at DESC,id DESC LIMIT 20) g),'[]'::jsonb));
END;
$fn$;

CREATE FUNCTION public.cloud_redeem_gift(p_user_id uuid,p_environment text,p_code_hash text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $fn$
DECLARE
  v_code public.tokentracker_cloud_gift_codes%ROWTYPE; v_batch public.tokentracker_cloud_gift_batches%ROWTYPE;
  v_grant public.tokentracker_cloud_gift_grants%ROWTYPE; v_attempt public.tokentracker_cloud_gift_attempts%ROWTYPE;
  v_now timestamptz; v_start timestamptz; v_period record; v_restriction text;
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('live','sandbox') OR p_user_id IS NULL OR p_request_id IS NULL OR
    NOT EXISTS (SELECT 1 FROM auth.users WHERE id=p_user_id) THEN RAISE EXCEPTION 'invalid gift request'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_environment,0));
  v_now:=clock_timestamp();
  SELECT * INTO v_code FROM public.tokentracker_cloud_gift_codes
    WHERE environment=p_environment AND code_hash=p_code_hash FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO v_grant FROM public.tokentracker_cloud_gift_grants WHERE code_id=v_code.id;
    IF FOUND AND v_grant.user_id=p_user_id THEN
      RETURN jsonb_build_object('ok',true,'reused',true,'gift',public.cloud_gift_view(v_grant),
        'membership',public.cloud_membership(p_user_id,p_environment));
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tokentracker_cloud_policy WHERE environment=p_environment
      AND hosting_mode='hosted' AND phase='active' AND launch_at<=v_now) THEN
    RETURN jsonb_build_object('ok',false,'status',409,'code','gift_not_available');
  END IF;
  INSERT INTO public.tokentracker_cloud_gift_attempts VALUES(p_user_id,p_environment,v_now,0)
    ON CONFLICT(user_id,environment) DO UPDATE SET window_started_at=excluded.window_started_at,failed_attempts=0
      WHERE tokentracker_cloud_gift_attempts.window_started_at<=v_now-interval '15 minutes';
  SELECT * INTO STRICT v_attempt FROM public.tokentracker_cloud_gift_attempts
    WHERE user_id=p_user_id AND environment=p_environment FOR UPDATE;
  IF v_attempt.failed_attempts>=10 THEN
    RETURN jsonb_build_object('ok',false,'status',429,'code','gift_redemption_rate_limited',
      'retry_after',greatest(1,ceil(extract(epoch FROM v_attempt.window_started_at+interval '15 minutes'-v_now))));
  END IF;
  IF v_code.id IS NOT NULL THEN
    SELECT * INTO STRICT v_batch FROM public.tokentracker_cloud_gift_batches WHERE id=v_code.batch_id FOR SHARE;
  END IF;
  IF v_code.id IS NULL OR v_grant.id IS NOT NULL OR v_batch.disabled_at IS NOT NULL OR v_batch.redeem_before<=v_now OR
    EXISTS (SELECT 1 FROM public.tokentracker_cloud_gift_grants WHERE user_id=p_user_id AND environment=p_environment AND request_id=p_request_id) THEN
    UPDATE public.tokentracker_cloud_gift_attempts SET failed_attempts=failed_attempts+1
      WHERE user_id=p_user_id AND environment=p_environment;
    RETURN jsonb_build_object('ok',false,'status',400,'code','gift_code_unavailable');
  END IF;
  -- Read after the account lock in this volatile function. A checkout created
  -- while redemption waited must be visible before any code is consumed.
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_subscriptions WHERE user_id=p_user_id AND environment=p_environment
      AND status IN ('pending','active','trialing','past_due','paused') AND NOT cancel_at_period_end) THEN
    v_restriction:='gift_requires_renewal_cancel';
  ELSIF EXISTS (SELECT 1 FROM public.tokentracker_cloud_orders WHERE user_id=p_user_id AND environment=p_environment
      AND status IN ('pending','ready')) THEN v_restriction:='gift_checkout_pending'; END IF;
  IF v_restriction IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'status',409,'code',v_restriction); END IF;
  v_start:=v_now;
  FOR v_period IN SELECT starts_at,ends_at FROM public.tokentracker_cloud_payments WHERE user_id=p_user_id AND environment=p_environment
      AND refunded_cents<amount_cents AND revoked_at IS NULL AND ends_at>v_now
    UNION ALL SELECT starts_at,ends_at FROM public.tokentracker_cloud_gift_grants WHERE user_id=p_user_id AND environment=p_environment
      AND revoked_at IS NULL AND ends_at>v_now ORDER BY starts_at,ends_at
  LOOP
    IF v_period.starts_at<=v_start THEN v_start:=greatest(v_start,v_period.ends_at); END IF;
  END LOOP;
  INSERT INTO public.tokentracker_cloud_gift_grants(code_id,user_id,environment,request_id,duration_days,redeemed_at,starts_at,ends_at)
    VALUES(v_code.id,p_user_id,p_environment,p_request_id,v_batch.duration_days,v_now,v_start,
      v_start+v_batch.duration_days*interval '24 hours') RETURNING * INTO v_grant;
  RETURN jsonb_build_object('ok',true,'reused',false,'gift',public.cloud_gift_view(v_grant),
    'membership',public.cloud_membership(p_user_id,p_environment));
END;
$fn$;

-- All purchase/trial entry points share the same account lock as redemption.
ALTER FUNCTION public.cloud_create_order(uuid,text,text,text,uuid) RENAME TO cloud_create_order_before_gifts;
CREATE FUNCTION public.cloud_create_order(p_user_id uuid,p_environment text,p_provider text,p_sku text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_environment,0));
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_gift_grants WHERE user_id=p_user_id AND environment=p_environment
      AND revoked_at IS NULL AND ends_at>clock_timestamp()) AND NOT EXISTS (
    SELECT 1 FROM public.tokentracker_cloud_orders WHERE user_id=p_user_id AND environment=p_environment
      AND request_id=p_request_id AND provider=p_provider AND sku=p_sku AND status='paid') THEN
    RAISE EXCEPTION 'gift_membership_active';
  END IF;
  RETURN public.cloud_create_order_before_gifts(p_user_id,p_environment,p_provider,p_sku,p_request_id);
END;
$fn$;
ALTER FUNCTION public.cloud_claim_checkout(uuid,uuid) RENAME TO cloud_claim_checkout_before_gifts;
CREATE FUNCTION public.cloud_claim_checkout(p_user_id uuid,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id=p_order_id AND user_id=p_user_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||v_order.environment,0));
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id=p_order_id AND user_id=p_user_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_gift_grants WHERE user_id=p_user_id AND environment=v_order.environment
      AND revoked_at IS NULL AND ends_at>clock_timestamp()) AND v_order.status<>'paid' THEN
    RAISE EXCEPTION 'gift_membership_active';
  END IF;
  RETURN public.cloud_claim_checkout_before_gifts(p_user_id,p_order_id);
END;
$fn$;
ALTER FUNCTION public.cloud_start_trial(uuid,text) RENAME TO cloud_start_trial_before_gifts;
CREATE FUNCTION public.cloud_start_trial(p_user_id uuid,p_environment text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_environment,0));
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_gift_grants WHERE user_id=p_user_id AND environment=p_environment) THEN
    RAISE EXCEPTION 'trial is only available before the first purchase or gift';
  END IF;
  RETURN public.cloud_start_trial_before_gifts(p_user_id,p_environment);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_pro_badges(p_user_ids uuid[],p_environment text DEFAULT 'live')
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog,public,pg_temp AS $fn$
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('live','sandbox') THEN RAISE EXCEPTION 'Invalid badge environment'; END IF;
  IF coalesce(cardinality(p_user_ids),0)>101 THEN RAISE EXCEPTION 'Too many badge users'; END IF;
  -- Private self-hosted installations do not install the public profile table.
  IF NOT EXISTS (SELECT 1 FROM public.tokentracker_cloud_policy WHERE environment=p_environment
      AND phase='active' AND hosting_mode='hosted' AND launch_at<=statement_timestamp()) THEN RETURN '{}'::jsonb; END IF;
  RETURN coalesce((SELECT jsonb_object_agg(u.user_id::text,true) FROM (SELECT DISTINCT unnest(p_user_ids) AS user_id) u
    WHERE u.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.tokentracker_cloud_policy WHERE environment=p_environment
      AND phase='active' AND hosting_mode='hosted' AND launch_at<=statement_timestamp())
    AND NOT EXISTS (SELECT 1 FROM public.tokentracker_user_settings s WHERE s.user_id=u.user_id AND s.leaderboard_anonymous)
    AND (EXISTS (SELECT 1 FROM public.tokentracker_cloud_payments p WHERE p.user_id=u.user_id AND p.environment=p_environment
      AND p.starts_at<=statement_timestamp() AND p.ends_at>statement_timestamp() AND p.refunded_cents<p.amount_cents AND p.revoked_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.tokentracker_cloud_gift_grants g WHERE g.user_id=u.user_id AND g.environment=p_environment
      AND g.starts_at<=statement_timestamp() AND g.ends_at>statement_timestamp() AND g.revoked_at IS NULL))),'{}'::jsonb);
END;
$fn$;

REVOKE ALL ON FUNCTION public.cloud_guard_gift_grant(),public.cloud_gift_view(public.tokentracker_cloud_gift_grants),
  public.cloud_create_gift_batch(text,uuid,integer,timestamptz,text,jsonb),public.cloud_list_gift_batches(text,integer),
  public.cloud_list_gift_codes(text,uuid,integer),public.cloud_disable_gift_batch(text,uuid),public.cloud_revoke_gift(text,uuid),
  public.cloud_gift_account(uuid,text),public.cloud_redeem_gift(uuid,text,text,uuid),public.cloud_membership(uuid,text),
  public.cloud_membership_before_gifts(uuid,text),public.cloud_create_order(uuid,text,text,text,uuid),
  public.cloud_create_order_before_gifts(uuid,text,text,text,uuid),public.cloud_claim_checkout(uuid,uuid),
  public.cloud_claim_checkout_before_gifts(uuid,uuid),public.cloud_start_trial(uuid,text),
  public.cloud_start_trial_before_gifts(uuid,text),public.cloud_pro_badges(uuid[],text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_guard_gift_grant(),public.cloud_gift_view(public.tokentracker_cloud_gift_grants),
  public.cloud_create_gift_batch(text,uuid,integer,timestamptz,text,jsonb),public.cloud_list_gift_batches(text,integer),
  public.cloud_list_gift_codes(text,uuid,integer),public.cloud_disable_gift_batch(text,uuid),public.cloud_revoke_gift(text,uuid),
  public.cloud_gift_account(uuid,text),public.cloud_redeem_gift(uuid,text,text,uuid),public.cloud_membership(uuid,text),
  public.cloud_membership_before_gifts(uuid,text),public.cloud_create_order(uuid,text,text,text,uuid),
  public.cloud_create_order_before_gifts(uuid,text,text,text,uuid),public.cloud_claim_checkout(uuid,uuid),
  public.cloud_claim_checkout_before_gifts(uuid,uuid),public.cloud_start_trial(uuid,text),
  public.cloud_start_trial_before_gifts(uuid,text),public.cloud_pro_badges(uuid[],text) TO project_admin;
NOTIFY pgrst,'reload schema';
