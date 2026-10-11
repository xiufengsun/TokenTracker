-- Instance owners explicitly choose self-hosted access. Existing hosted instances retain their paid policy.
ALTER TABLE public.tokentracker_cloud_policy ADD COLUMN hosting_mode text NOT NULL DEFAULT 'hosted'
  CHECK (hosting_mode IN ('hosted','self_hosted'));

CREATE OR REPLACE FUNCTION public.cloud_membership(
  p_user_id uuid, p_environment text
) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp AS $fn$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_policy public.tokentracker_cloud_policy%ROWTYPE;
  v_trial timestamptz;
  v_transition timestamptz;
  v_end timestamptz;
  v_history_end timestamptz;
  v_paid boolean := false;
  v_status text;
  v_period record;
BEGIN
  SELECT * INTO STRICT v_policy FROM public.tokentracker_cloud_policy
    WHERE environment = p_environment;
  IF v_policy.hosting_mode = 'self_hosted' THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
      RAISE EXCEPTION 'self-hosted account does not exist';
    END IF;
    RETURN jsonb_build_object('environment',p_environment,'phase','active','status','self_hosted',
      'hosting_mode','self_hosted','expires_at',NULL,'trial_ends_at',NULL,'trial_available',false,
      'transition_ends_at',NULL,'read_only_until',NULL,'can_read_cloud',true,'can_upload_cloud',true,
      'machine_limit',NULL,'sync_interval_seconds',0,'hourly_history_days',NULL,'daily_history_months',NULL);
  END IF;
  SELECT trial_ends_at INTO v_trial FROM public.tokentracker_cloud_accounts
    WHERE user_id = p_user_id AND environment = p_environment;
  IF v_policy.launch_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tokentracker_devices
    WHERE user_id = p_user_id AND created_at < v_policy.launch_at
  ) THEN
    v_transition := v_policy.launch_at + interval '30 days';
  END IF;
  SELECT max(CASE WHEN refunded_cents = amount_cents THEN least(ends_at, revoked_at)
    ELSE ends_at END) INTO v_history_end FROM public.tokentracker_cloud_payments
    WHERE user_id = p_user_id AND environment = p_environment AND starts_at <= v_now;
  v_history_end := greatest(v_history_end, v_trial, v_transition);
  v_end := greatest(v_now, v_trial, v_transition);
  -- Merge contiguous paid intervals. A refunded middle term cannot bridge a gap.
  FOR v_period IN SELECT starts_at, ends_at FROM public.tokentracker_cloud_payments
    WHERE user_id = p_user_id AND environment = p_environment
      AND refunded_cents < amount_cents AND ends_at > v_now
    ORDER BY starts_at, ends_at
  LOOP
    IF v_period.starts_at <= v_end THEN
      v_end := greatest(v_end, v_period.ends_at);
      IF v_period.starts_at <= v_now THEN v_paid := true; END IF;
    END IF;
  END LOOP;
  v_status := CASE
    WHEN v_policy.phase = 'preview' THEN 'legacy_free'
    WHEN v_paid THEN 'active'
    WHEN v_trial > v_now THEN 'trial'
    WHEN v_transition > v_now THEN 'transition'
    WHEN v_history_end IS NOT NULL THEN 'expired'
    ELSE 'free' END;
  RETURN jsonb_build_object(
    'environment', p_environment, 'phase', v_policy.phase, 'status', v_status,
    'expires_at', CASE WHEN v_end > v_now THEN v_end ELSE NULL END,
    'trial_ends_at', v_trial, 'trial_available', v_trial IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.tokentracker_cloud_payments
      WHERE user_id = p_user_id AND environment = p_environment),
    'transition_ends_at', v_transition,
    'read_only_until', v_history_end + interval '30 days',
    'can_read_cloud', v_status IN ('legacy_free', 'active', 'trial', 'transition')
      OR (v_status = 'expired' AND v_history_end + interval '30 days' > v_now),
    'can_upload_cloud', v_status IN ('legacy_free', 'active', 'trial', 'transition'),
    'machine_limit', CASE WHEN v_status = 'legacy_free' THEN NULL
      WHEN v_status IN ('active', 'trial', 'transition') THEN 5 ELSE 1 END,
    'sync_interval_seconds', CASE WHEN v_status IN ('legacy_free', 'active', 'trial', 'transition')
      THEN 900 ELSE 86400 END,
    'hourly_history_days', 90, 'daily_history_months', 24
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_account_access(p_user_id uuid,p_environment text,p_kind text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $fn$
DECLARE v_state jsonb; v_from date;
BEGIN
  v_state:=public.cloud_membership(p_user_id,p_environment);
  IF NOT (v_state->>'can_read_cloud')::boolean THEN
    RETURN jsonb_build_object('ok',false,'status',402,'code',CASE WHEN v_state->>'status'='expired'
      THEN 'cloud_read_only_expired' ELSE 'cloud_membership_required' END,
      'membership',v_state,'recovery_url','https://www.tokentracker.cc/cloud');
  END IF;
  IF v_state->>'phase'='active' AND v_state->>'status'<>'self_hosted' THEN
    v_from:=CASE WHEN p_kind='hourly' THEN (now() AT TIME ZONE 'UTC')::date - 89
      ELSE ((now() AT TIME ZONE 'UTC')::date - interval '24 months')::date END;
  END IF;
  RETURN jsonb_build_object('ok',true,'membership',v_state,'available_from',v_from);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_start_trial(p_user_id uuid, p_environment text)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_policy WHERE environment = p_environment AND hosting_mode = 'self_hosted') THEN
    RAISE EXCEPTION 'self-hosted access is free and does not require a trial';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_environment, 0));
  IF NOT EXISTS (SELECT 1 FROM public.tokentracker_cloud_policy
    WHERE environment = p_environment AND phase = 'active' AND launch_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'trial has not launched';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_payments
    WHERE user_id = p_user_id AND environment = p_environment) THEN
    RAISE EXCEPTION 'trial is only available before the first purchase';
  END IF;
  INSERT INTO public.tokentracker_cloud_accounts (user_id, environment, trial_started_at, trial_ends_at)
    VALUES (p_user_id, p_environment, clock_timestamp(), clock_timestamp() + interval '7 days')
    ON CONFLICT (user_id, environment) DO UPDATE
      SET trial_started_at = excluded.trial_started_at, trial_ends_at = excluded.trial_ends_at
      WHERE tokentracker_cloud_accounts.trial_started_at IS NULL;
  RETURN public.cloud_membership(p_user_id, p_environment);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_create_order(
  p_user_id uuid, p_environment text, p_provider text, p_sku text, p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE
  v_catalog public.tokentracker_cloud_catalog%ROWTYPE;
  v_order public.tokentracker_cloud_orders%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_policy WHERE environment = p_environment AND hosting_mode = 'self_hosted') THEN
    RAISE EXCEPTION 'self-hosted access is free and does not require a paid order';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_environment, 0));
  SELECT * INTO v_order FROM public.tokentracker_cloud_orders
    WHERE user_id = p_user_id AND environment = p_environment AND request_id = p_request_id;
  IF FOUND THEN
    IF v_order.provider <> p_provider OR v_order.sku <> p_sku THEN
      RAISE EXCEPTION 'idempotency request belongs to a different purchase';
    END IF;
    RETURN to_jsonb(v_order);
  END IF;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_orders
    WHERE user_id = p_user_id AND environment = p_environment AND retry_payment_conflict_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a payment conflict must be resolved before another purchase';
  END IF;
  SELECT * INTO STRICT v_catalog FROM public.tokentracker_cloud_catalog WHERE sku = p_sku;
  IF NOT v_catalog.active THEN RAISE EXCEPTION 'the requested product is no longer available'; END IF;
  IF (p_provider = 'paddle' AND (v_catalog.currency <> 'USD' OR v_catalog.billing_mode <> 'recurring')) OR
     (p_provider IN ('wechat', 'alipay') AND (v_catalog.currency <> 'CNY' OR v_catalog.billing_mode <> 'fixed')) THEN
    RAISE EXCEPTION 'payment provider does not support this currency';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_subscriptions
    WHERE user_id = p_user_id AND environment = p_environment
      AND status IN ('active', 'trialing', 'past_due', 'paused') AND NOT cancel_at_period_end) THEN
    RAISE EXCEPTION 'manage the existing subscription before purchasing another plan';
  END IF;
  IF v_catalog.billing_mode = 'recurring' AND EXISTS (SELECT 1 FROM public.tokentracker_cloud_payments
    WHERE user_id = p_user_id AND environment = p_environment
      AND refunded_cents < amount_cents AND ends_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'the current fixed membership term must end before starting a subscription';
  END IF;
  INSERT INTO public.tokentracker_cloud_orders
    (user_id, environment, request_id, provider, sku, currency, amount_cents, term_months, billing_mode)
    VALUES (p_user_id, p_environment, p_request_id, p_provider, p_sku,
      v_catalog.currency, v_catalog.amount_cents, v_catalog.term_months, v_catalog.billing_mode)
    RETURNING * INTO v_order;
  RETURN to_jsonb(v_order);
END;
$fn$;



REVOKE ALL ON FUNCTION public.cloud_membership(uuid,text),public.cloud_account_access(uuid,text,text),
  public.cloud_start_trial(uuid,text),public.cloud_create_order(uuid,text,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_membership(uuid,text),public.cloud_account_access(uuid,text,text),
  public.cloud_start_trial(uuid,text),public.cloud_create_order(uuid,text,text,text,uuid) TO project_admin;
