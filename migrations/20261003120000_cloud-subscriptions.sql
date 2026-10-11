-- Payment state is written only by verified, server-side provider handlers.
-- Applying this migration does not activate production charging or limits.
CREATE TABLE public.tokentracker_cloud_catalog (
  sku text PRIMARY KEY,
  currency text NOT NULL CHECK (currency IN ('CNY', 'USD')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  term_months integer NOT NULL CHECK (term_months IN (1, 12))
);
INSERT INTO public.tokentracker_cloud_catalog VALUES
  ('cloud_cny_monthly', 'CNY', 2900, 1),
  ('cloud_cny_yearly', 'CNY', 24900, 12),
  ('cloud_usd_monthly', 'USD', 599, 1),
  ('cloud_usd_yearly', 'USD', 4900, 12);

CREATE TABLE public.tokentracker_cloud_policy (
  environment text PRIMARY KEY CHECK (environment IN ('sandbox', 'live')),
  phase text NOT NULL DEFAULT 'preview' CHECK (phase IN ('preview', 'active')),
  launch_at timestamptz,
  CHECK (phase = 'preview' OR launch_at IS NOT NULL)
);
INSERT INTO public.tokentracker_cloud_policy (environment) VALUES ('sandbox'), ('live');

CREATE TABLE public.tokentracker_cloud_accounts (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL REFERENCES public.tokentracker_cloud_policy(environment),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  PRIMARY KEY (user_id, environment),
  CHECK ((trial_started_at IS NULL AND trial_ends_at IS NULL) OR
    (trial_started_at IS NOT NULL AND trial_ends_at > trial_started_at))
);

CREATE TABLE public.tokentracker_cloud_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  environment text NOT NULL REFERENCES public.tokentracker_cloud_policy(environment),
  request_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('paddle', 'wechat', 'alipay')),
  sku text NOT NULL REFERENCES public.tokentracker_cloud_catalog(sku),
  currency text NOT NULL CHECK (currency IN ('CNY', 'USD')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  term_months integer NOT NULL CHECK (term_months IN (1, 12)),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'paid', 'closed')),
  provider_order_id text,
  provider_price_id text,
  checkout_url text,
  checkout_attempts integer NOT NULL DEFAULT 0 CHECK (checkout_attempts >= 0),
  checkout_claimed_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 minutes',
  UNIQUE (user_id, environment, request_id),
  UNIQUE (provider, environment, provider_order_id),
  CHECK ((provider = 'paddle' AND currency = 'USD') OR
    (provider IN ('wechat', 'alipay') AND currency = 'CNY'))
);
CREATE INDEX tokentracker_cloud_orders_user_created_idx
  ON public.tokentracker_cloud_orders (user_id, environment, created_at DESC);

CREATE TABLE public.tokentracker_cloud_subscriptions (
  provider text NOT NULL CHECK (provider = 'paddle'),
  environment text NOT NULL REFERENCES public.tokentracker_cloud_policy(environment),
  provider_subscription_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES public.tokentracker_cloud_orders(id),
  status text NOT NULL CHECK (status IN ('active', 'canceled', 'past_due', 'paused', 'trialing')),
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  last_event_at timestamptz NOT NULL,
  next_billed_at timestamptz,
  PRIMARY KEY (provider, environment, provider_subscription_id)
);
CREATE INDEX tokentracker_cloud_subscriptions_user_idx
  ON public.tokentracker_cloud_subscriptions (user_id, environment);

CREATE TABLE public.tokentracker_cloud_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.tokentracker_cloud_orders(id),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('paddle', 'wechat', 'alipay')),
  environment text NOT NULL REFERENCES public.tokentracker_cloud_policy(environment),
  transaction_id text NOT NULL,
  subscription_id text,
  currency text NOT NULL CHECK (currency IN ('CNY', 'USD')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  refunded_cents integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  paid_at timestamptz NOT NULL,
  UNIQUE (provider, environment, transaction_id),
  CHECK (refunded_cents BETWEEN 0 AND amount_cents),
  CHECK (ends_at > starts_at)
);
CREATE INDEX tokentracker_cloud_payments_user_period_idx
  ON public.tokentracker_cloud_payments (user_id, environment, ends_at);

CREATE TABLE public.tokentracker_cloud_events (
  provider text NOT NULL CHECK (provider IN ('paddle', 'wechat', 'alipay')),
  environment text NOT NULL REFERENCES public.tokentracker_cloud_policy(environment),
  event_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payment', 'refund', 'subscription')),
  action_id text NOT NULL,
  order_id uuid NOT NULL REFERENCES public.tokentracker_cloud_orders(id),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  normalized_event jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'duplicate', 'outdated')),
  PRIMARY KEY (provider, environment, event_id)
);
CREATE UNIQUE INDEX tokentracker_cloud_events_applied_action_idx
  ON public.tokentracker_cloud_events (provider, environment, kind, action_id)
  WHERE status = 'applied' AND kind IN ('payment', 'refund');

ALTER TABLE public.tokentracker_cloud_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_cloud_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_cloud_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_cloud_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_cloud_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_cloud_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_cloud_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.tokentracker_cloud_catalog, public.tokentracker_cloud_policy,
  public.tokentracker_cloud_accounts, public.tokentracker_cloud_orders,
  public.tokentracker_cloud_subscriptions, public.tokentracker_cloud_payments,
  public.tokentracker_cloud_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tokentracker_cloud_catalog, public.tokentracker_cloud_policy,
  public.tokentracker_cloud_accounts, public.tokentracker_cloud_orders,
  public.tokentracker_cloud_subscriptions, public.tokentracker_cloud_payments,
  public.tokentracker_cloud_events TO project_admin;
-- The billing API serves the catalog. Direct client reads would disclose
-- unpublished pricing while the hosted sandbox is being accepted.
GRANT SELECT ON public.tokentracker_cloud_accounts, public.tokentracker_cloud_orders,
  public.tokentracker_cloud_subscriptions, public.tokentracker_cloud_payments TO authenticated;
CREATE POLICY cloud_accounts_owner_read ON public.tokentracker_cloud_accounts
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY cloud_orders_owner_read ON public.tokentracker_cloud_orders
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY cloud_subscriptions_owner_read ON public.tokentracker_cloud_subscriptions
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY cloud_payments_owner_read ON public.tokentracker_cloud_payments
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

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
    WHERE user_id = p_user_id AND environment = p_environment;
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

CREATE OR REPLACE FUNCTION public.cloud_start_trial(p_user_id uuid, p_environment text)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
BEGIN
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
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_environment, 0));
  SELECT * INTO v_order FROM public.tokentracker_cloud_orders
    WHERE user_id = p_user_id AND environment = p_environment AND request_id = p_request_id;
  IF FOUND THEN
    IF v_order.provider <> p_provider OR v_order.sku <> p_sku THEN
      RAISE EXCEPTION 'idempotency request belongs to a different purchase';
    END IF;
    RETURN to_jsonb(v_order);
  END IF;
  SELECT * INTO STRICT v_catalog FROM public.tokentracker_cloud_catalog WHERE sku = p_sku;
  IF (p_provider = 'paddle' AND v_catalog.currency <> 'USD') OR
     (p_provider IN ('wechat', 'alipay') AND v_catalog.currency <> 'CNY') THEN
    RAISE EXCEPTION 'payment provider does not support this currency';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_subscriptions
    WHERE user_id = p_user_id AND environment = p_environment
      AND status IN ('active', 'trialing', 'past_due', 'paused') AND NOT cancel_at_period_end) THEN
    RAISE EXCEPTION 'manage the existing subscription before purchasing another plan';
  END IF;
  IF p_provider = 'paddle' AND EXISTS (SELECT 1 FROM public.tokentracker_cloud_payments
    WHERE user_id = p_user_id AND environment = p_environment
      AND refunded_cents < amount_cents AND ends_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'the current fixed membership term must end before starting a subscription';
  END IF;
  INSERT INTO public.tokentracker_cloud_orders
    (user_id, environment, request_id, provider, sku, currency, amount_cents, term_months)
    VALUES (p_user_id, p_environment, p_request_id, p_provider, p_sku,
      v_catalog.currency, v_catalog.amount_cents, v_catalog.term_months)
    RETURNING * INTO v_order;
  RETURN to_jsonb(v_order);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_claim_checkout(p_user_id uuid, p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders
    WHERE id = p_order_id AND user_id = p_user_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order.user_id::text || ':' || v_order.environment,0));
  IF v_order.checkout_url IS NOT NULL OR v_order.checkout_attempts > 0 OR
    v_order.status <> 'pending' OR v_order.expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('claimed', false, 'order', to_jsonb(v_order));
  END IF;
  IF v_order.provider='paddle' AND EXISTS (SELECT 1 FROM public.tokentracker_cloud_orders
    WHERE user_id=p_user_id AND environment=v_order.environment AND provider='paddle' AND id<>v_order.id
      AND status IN ('pending','ready') AND checkout_attempts>0) THEN
    RAISE EXCEPTION 'an existing checkout must be confirmed before another subscription';
  END IF;
  UPDATE public.tokentracker_cloud_orders
    SET checkout_attempts = checkout_attempts + 1, checkout_claimed_at = clock_timestamp()
    WHERE id = p_order_id RETURNING * INTO v_order;
  -- Ambiguous provider failures are reconciled, never retried as a new charge.
  RETURN jsonb_build_object('claimed', true, 'order', to_jsonb(v_order));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_close_unpaid_order(p_user_id uuid,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql
SET search_path=public,pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id=p_order_id AND user_id=p_user_id FOR UPDATE;
  IF v_order.status IN ('pending','ready') THEN
    UPDATE public.tokentracker_cloud_orders SET status='closed' WHERE id=p_order_id RETURNING * INTO v_order;
  END IF;
  RETURN to_jsonb(v_order);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_attach_checkout(
  p_user_id uuid, p_order_id uuid, p_provider_order_id text,
  p_provider_price_id text, p_checkout_url text
) RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders
    WHERE id = p_order_id AND user_id = p_user_id FOR UPDATE;
  IF (v_order.provider_order_id IS NOT NULL AND p_provider_order_id IS NOT NULL
    AND v_order.provider_order_id <> p_provider_order_id) OR
    (v_order.provider_price_id IS NOT NULL AND p_provider_price_id IS NOT NULL
    AND v_order.provider_price_id <> p_provider_price_id) THEN
    RAISE EXCEPTION 'checkout is already bound to a different provider transaction or price';
  END IF;
  UPDATE public.tokentracker_cloud_orders
    SET provider_order_id = coalesce(provider_order_id, p_provider_order_id),
      provider_price_id = coalesce(provider_price_id, p_provider_price_id),
      checkout_url = coalesce(p_checkout_url, checkout_url),
      status = CASE WHEN status = 'pending' AND p_checkout_url IS NOT NULL THEN 'ready' ELSE status END
    WHERE id = p_order_id RETURNING * INTO v_order;
  RETURN to_jsonb(v_order);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_claim_reconciliation(p_user_id uuid,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = public,pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE; v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders
    WHERE id=p_order_id AND user_id=p_user_id FOR UPDATE;
  IF v_order.last_reconciled_at IS NOT NULL AND v_order.last_reconciled_at > v_now-interval '30 seconds' THEN
    RETURN jsonb_build_object('claimed',false,'retry_after',
      greatest(1,ceil(extract(epoch FROM v_order.last_reconciled_at+interval '30 seconds'-v_now))::integer));
  END IF;
  UPDATE public.tokentracker_cloud_orders SET last_reconciled_at=v_now WHERE id=p_order_id;
  RETURN jsonb_build_object('claimed',true);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_apply_event(
  p_provider text, p_environment text, p_event jsonb
) RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE
  v_order public.tokentracker_cloud_orders%ROWTYPE;
  v_payment public.tokentracker_cloud_payments%ROWTYPE;
  v_subscription public.tokentracker_cloud_subscriptions%ROWTYPE;
  v_event_id text := p_event->>'event_id';
  v_kind text := p_event->>'kind';
  v_action_id text := p_event->>'action_id';
  v_occurred timestamptz := (p_event->>'occurred_at')::timestamptz;
  v_start timestamptz;
  v_end timestamptz;
  v_subscription_id text := nullif(p_event->>'subscription_id', '');
  v_status text := 'applied';
  v_amount integer;
  v_refund_total integer;
BEGIN
  IF v_event_id IS NULL OR v_event_id = '' OR length(v_event_id) > 200 OR
    v_action_id IS NULL OR v_action_id = '' OR length(v_action_id) > 200 OR
    v_kind NOT IN ('payment', 'refund', 'subscription') OR v_kind IS NULL OR
    v_occurred IS NULL OR v_occurred > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid normalized payment event';
  END IF;
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders
    WHERE id = (p_event->>'order_id')::uuid FOR UPDATE;
  -- Also serialize separate orders which extend the same account's paid term.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order.user_id::text || ':' || p_environment, 0));
  IF v_order.provider <> p_provider OR v_order.environment <> p_environment THEN
    RAISE EXCEPTION 'payment event does not match the order provider or environment';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_events
    WHERE provider = p_provider AND environment = p_environment AND event_id = v_event_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.tokentracker_cloud_events
      WHERE provider = p_provider AND environment = p_environment AND event_id = v_event_id
        AND normalized_event = p_event AND order_id = v_order.id) THEN
      RAISE EXCEPTION 'event identifier was already used for different payment data';
    END IF;
    RETURN jsonb_build_object('applied', false, 'duplicate', true);
  END IF;
  INSERT INTO public.tokentracker_cloud_events
    (provider, environment, event_id, kind, action_id, order_id, occurred_at, normalized_event)
    VALUES (p_provider, p_environment, v_event_id, v_kind, v_action_id, v_order.id, v_occurred, p_event);
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_events
    WHERE provider = p_provider AND environment = p_environment AND kind = v_kind
      AND action_id = v_action_id AND status = 'applied' AND kind IN ('payment', 'refund')) THEN
    IF NOT EXISTS (SELECT 1 FROM public.tokentracker_cloud_events
      WHERE provider = p_provider AND environment = p_environment AND kind = v_kind
        AND action_id = v_action_id AND status = 'applied' AND order_id = v_order.id
        AND normalized_event - ARRAY['event_id','occurred_at'] = p_event - ARRAY['event_id','occurred_at']) THEN
      RAISE EXCEPTION 'payment action was already applied to different payment data';
    END IF;
    v_status := 'duplicate';
  ELSIF v_kind = 'payment' THEN
    IF p_event->>'currency' IS DISTINCT FROM v_order.currency OR
      (p_event->>'base_amount_cents')::integer IS DISTINCT FROM v_order.amount_cents THEN
      RAISE EXCEPTION 'payment amount or currency does not match the order';
    END IF;
    v_amount := (p_event->>'amount_cents')::integer;
    IF v_amount IS NULL OR v_amount < v_order.amount_cents OR
      (p_provider <> 'paddle' AND v_amount <> v_order.amount_cents) THEN
      RAISE EXCEPTION 'invalid paid amount';
    END IF;
    IF p_provider = 'paddle' THEN
      IF v_order.provider_order_id IS NOT NULL AND v_order.provider_order_id <> v_action_id
        AND (v_subscription_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM public.tokentracker_cloud_subscriptions
          WHERE provider = p_provider AND environment = p_environment
            AND provider_subscription_id = v_subscription_id
            AND user_id = v_order.user_id AND order_id = v_order.id
        )) THEN RAISE EXCEPTION 'unrecognized subscription renewal'; END IF;
      v_start := (p_event->>'starts_at')::timestamptz;
      v_end := (p_event->>'ends_at')::timestamptz;
      IF v_subscription_id IS NULL OR v_start IS NULL OR v_end IS NULL OR
        v_end <= v_start OR v_end > v_start + make_interval(months => v_order.term_months) + interval '1 day' OR
        v_end < v_start + make_interval(months => v_order.term_months) - interval '1 day' THEN
        RAISE EXCEPTION 'invalid subscription billing period';
      END IF;
      SELECT * INTO v_subscription FROM public.tokentracker_cloud_subscriptions
        WHERE provider = p_provider AND environment = p_environment
          AND provider_subscription_id = v_subscription_id FOR UPDATE;
      IF FOUND AND (v_subscription.user_id <> v_order.user_id OR v_subscription.order_id <> v_order.id) THEN
        RAISE EXCEPTION 'subscription belongs to a different account or order';
      END IF;
      INSERT INTO public.tokentracker_cloud_subscriptions
        (provider, environment, provider_subscription_id, user_id, order_id, status, last_event_at,next_billed_at)
        VALUES (p_provider, p_environment, v_subscription_id, v_order.user_id, v_order.id, 'active', v_occurred,v_end)
        ON CONFLICT (provider, environment, provider_subscription_id) DO UPDATE SET
          next_billed_at=CASE WHEN tokentracker_cloud_subscriptions.status IN ('active','trialing','past_due')
            AND NOT tokentracker_cloud_subscriptions.cancel_at_period_end
            THEN greatest(tokentracker_cloud_subscriptions.next_billed_at,excluded.next_billed_at)
            ELSE tokentracker_cloud_subscriptions.next_billed_at END;
    ELSE
      IF v_order.provider_order_id IS NOT NULL AND v_order.provider_order_id <> v_action_id THEN
        RAISE EXCEPTION 'payment transaction does not match the order';
      END IF;
      SELECT greatest(clock_timestamp(), max(ends_at)) INTO v_start
        FROM public.tokentracker_cloud_payments WHERE user_id = v_order.user_id
          AND environment = p_environment AND refunded_cents < amount_cents;
      v_end := v_start + make_interval(months => v_order.term_months);
    END IF;
    INSERT INTO public.tokentracker_cloud_payments
      (order_id, user_id, provider, environment, transaction_id, subscription_id,
        currency, amount_cents, starts_at, ends_at, paid_at)
      VALUES (v_order.id, v_order.user_id, p_provider, p_environment, v_action_id, v_subscription_id,
        v_order.currency, v_amount, v_start, v_end, v_occurred);
    UPDATE public.tokentracker_cloud_orders SET status = 'paid',
      provider_order_id = coalesce(provider_order_id, v_action_id) WHERE id = v_order.id;
  ELSIF v_kind = 'refund' THEN
    SELECT * INTO STRICT v_payment FROM public.tokentracker_cloud_payments
      WHERE provider = p_provider AND environment = p_environment
        AND transaction_id = p_event->>'transaction_id' FOR UPDATE;
    IF v_payment.order_id <> v_order.id OR v_payment.user_id <> v_order.user_id OR
      p_event->>'currency' IS DISTINCT FROM v_payment.currency THEN
      RAISE EXCEPTION 'refund does not match the paid order';
    END IF;
    IF p_event ? 'refund_total_cents' THEN
      IF p_provider <> 'alipay' THEN RAISE EXCEPTION 'invalid cumulative refund provider'; END IF;
      v_refund_total := (p_event->>'refund_total_cents')::integer;
      IF v_refund_total IS NULL OR v_refund_total <= 0 OR v_refund_total > v_payment.amount_cents OR
        v_refund_total IS DISTINCT FROM (p_event->>'amount_cents')::integer THEN
        RAISE EXCEPTION 'invalid refund amount';
      END IF;
      IF v_refund_total <= v_payment.refunded_cents THEN v_status := 'outdated'; END IF;
    ELSE
      v_amount := (p_event->>'amount_cents')::integer;
      IF v_amount IS NULL OR v_amount <= 0 OR
        v_payment.refunded_cents + v_amount > v_payment.amount_cents THEN
        RAISE EXCEPTION 'invalid refund amount';
      END IF;
      v_refund_total := v_payment.refunded_cents + v_amount;
    END IF;
    IF v_status = 'applied' THEN
      UPDATE public.tokentracker_cloud_payments SET refunded_cents = v_refund_total,
        revoked_at = CASE WHEN v_refund_total = amount_cents THEN clock_timestamp() ELSE revoked_at END
        WHERE id = v_payment.id;
    END IF;
  ELSE
    IF p_provider <> 'paddle' OR v_subscription_id IS NULL OR
      p_event->>'status' IS NULL OR p_event->>'status' NOT IN
        ('active', 'canceled', 'past_due', 'paused', 'trialing') THEN
      RAISE EXCEPTION 'invalid subscription event';
    END IF;
    SELECT * INTO v_subscription FROM public.tokentracker_cloud_subscriptions
      WHERE provider = p_provider AND environment = p_environment
        AND provider_subscription_id = v_subscription_id FOR UPDATE;
    IF FOUND AND (v_subscription.user_id <> v_order.user_id OR v_subscription.order_id <> v_order.id) THEN
      RAISE EXCEPTION 'subscription belongs to a different account or order';
    END IF;
    IF FOUND AND v_subscription.last_event_at >= v_occurred THEN
      v_status := 'outdated';
    ELSE
      INSERT INTO public.tokentracker_cloud_subscriptions
        (provider, environment, provider_subscription_id, user_id, order_id, status,
          cancel_at_period_end, last_event_at,next_billed_at)
        VALUES (p_provider, p_environment, v_subscription_id, v_order.user_id, v_order.id,
          p_event->>'status', coalesce((p_event->>'cancel_at_period_end')::boolean, false), v_occurred,
          (p_event->>'next_billed_at')::timestamptz)
        ON CONFLICT (provider, environment, provider_subscription_id) DO UPDATE
          SET status = excluded.status, cancel_at_period_end = excluded.cancel_at_period_end,
            last_event_at = excluded.last_event_at,next_billed_at=excluded.next_billed_at;
    END IF;
  END IF;
  UPDATE public.tokentracker_cloud_events SET status = v_status
    WHERE provider = p_provider AND environment = p_environment AND event_id = v_event_id;
  RETURN jsonb_build_object('applied', v_status = 'applied', 'status', v_status,
    'membership', public.cloud_membership(v_order.user_id, p_environment));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_apply_events(p_provider text, p_environment text, p_events jsonb)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE v_event jsonb; v_results jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'invalid payment event batch';
  END IF;
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    v_results := v_results || jsonb_build_array(public.cloud_apply_event(p_provider,p_environment,v_event));
  END LOOP;
  RETURN jsonb_build_object('results',v_results);
END;
$fn$;

REVOKE ALL ON FUNCTION public.cloud_membership(uuid, text),
  public.cloud_start_trial(uuid, text), public.cloud_create_order(uuid, text, text, text, uuid),
  public.cloud_claim_checkout(uuid, uuid), public.cloud_attach_checkout(uuid, uuid, text, text, text),
  public.cloud_claim_reconciliation(uuid,uuid),
  public.cloud_close_unpaid_order(uuid,uuid),
  public.cloud_apply_event(text, text, jsonb), public.cloud_apply_events(text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_membership(uuid, text),
  public.cloud_start_trial(uuid, text), public.cloud_create_order(uuid, text, text, text, uuid),
  public.cloud_claim_checkout(uuid, uuid), public.cloud_attach_checkout(uuid, uuid, text, text, text),
  public.cloud_claim_reconciliation(uuid,uuid),
  public.cloud_close_unpaid_order(uuid,uuid),
  public.cloud_apply_event(text, text, jsonb), public.cloud_apply_events(text,text,jsonb) TO project_admin;
