-- Channel card checks confirm an authorization, not a paid membership term.
CREATE TABLE public.tokentracker_cloud_waffo_authorizations (
  environment text NOT NULL,
  transaction_id text NOT NULL CHECK (transaction_id ~ '^PAY_[A-Za-z0-9]+$' AND length(transaction_id) <= 200),
  order_id uuid NOT NULL,
  waffo_order_id text NOT NULL,
  normalized_event jsonb NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (environment,transaction_id),
  FOREIGN KEY (order_id,environment,waffo_order_id)
    REFERENCES public.tokentracker_cloud_waffo_attempts(order_id,environment,waffo_order_id)
);
ALTER TABLE public.tokentracker_cloud_waffo_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_cloud_waffo_authorizations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tokentracker_cloud_waffo_authorizations TO project_admin;

CREATE FUNCTION public.cloud_record_waffo_authorization(p_environment text,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
  v_order public.tokentracker_cloud_orders%ROWTYPE;
  v_stored public.tokentracker_cloud_waffo_authorizations%ROWTYPE;
  v_occurred timestamptz := (p_event->>'occurred_at')::timestamptz;
BEGIN
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id = (p_event->>'order_id')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order.user_id::text || ':' || p_environment,0));
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id = v_order.id FOR UPDATE;
  IF v_order.provider <> 'waffo' OR v_order.environment IS DISTINCT FROM p_environment OR
    v_order.billing_mode <> 'recurring' OR p_event->>'kind' IS DISTINCT FROM 'authorization' OR
    p_event->>'currency' IS DISTINCT FROM v_order.currency OR
    p_event->>'provider_price_id' IS DISTINCT FROM v_order.provider_price_id OR
    p_event->>'subscription_id' IS DISTINCT FROM p_event->>'waffo_order_id' OR
    p_event->>'action_id' IS DISTINCT FROM p_event->>'transaction_id' OR
    coalesce(p_event->>'transaction_id','') !~ '^PAY_[A-Za-z0-9]+$' OR
    jsonb_typeof(p_event->'amount_cents') IS DISTINCT FROM 'number' OR p_event->>'amount_cents' <> '0' OR
    jsonb_typeof(p_event->'period_number') IS DISTINCT FROM 'number' OR p_event->>'period_number' <> '0' OR
    jsonb_typeof(p_event->'base_amount_cents') IS DISTINCT FROM 'number' OR
    (p_event->>'base_amount_cents')::integer IS DISTINCT FROM v_order.amount_cents OR
    p_event ? 'starts_at' OR p_event ? 'ends_at' OR v_occurred IS NULL OR NOT isfinite(v_occurred) OR
    NOT EXISTS (SELECT 1 FROM public.tokentracker_cloud_waffo_attempts WHERE order_id = v_order.id
      AND environment = p_environment AND waffo_order_id = p_event->>'waffo_order_id'
      AND provider_price_id = v_order.provider_price_id AND billing_mode = 'recurring') THEN
    RAISE EXCEPTION 'invalid Waffo zero-amount authorization';
  END IF;
  INSERT INTO public.tokentracker_cloud_waffo_authorizations(environment,transaction_id,order_id,waffo_order_id,normalized_event)
    VALUES (p_environment,p_event->>'transaction_id',v_order.id,p_event->>'waffo_order_id',p_event)
    ON CONFLICT (environment,transaction_id) DO NOTHING;
  SELECT * INTO STRICT v_stored FROM public.tokentracker_cloud_waffo_authorizations
    WHERE environment = p_environment AND transaction_id = p_event->>'transaction_id';
  IF v_stored.normalized_event IS DISTINCT FROM p_event THEN
    RAISE EXCEPTION 'Waffo authorization is already bound to different evidence';
  END IF;
  RETURN jsonb_build_object('verified',true);
END;
$fn$;
REVOKE ALL ON FUNCTION public.cloud_record_waffo_authorization(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_record_waffo_authorization(text,jsonb) TO project_admin;
