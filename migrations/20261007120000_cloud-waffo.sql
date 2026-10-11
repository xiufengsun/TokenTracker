-- Waffo checkout sessions, orders, and payments have separate identities.
-- The legacy financial tables and provider transaction semantics remain intact.
ALTER TABLE public.tokentracker_cloud_catalog
  ADD COLUMN billing_mode text NOT NULL DEFAULT 'fixed' CHECK (billing_mode IN ('fixed','recurring')),
  ADD COLUMN active boolean NOT NULL DEFAULT true;
UPDATE public.tokentracker_cloud_catalog SET active = false WHERE currency = 'CNY';
UPDATE public.tokentracker_cloud_catalog SET billing_mode = 'recurring',
  amount_cents = CASE WHEN term_months = 12 THEN 3999 ELSE 499 END WHERE currency = 'USD';
INSERT INTO public.tokentracker_cloud_catalog (sku,currency,amount_cents,term_months,billing_mode) VALUES
  ('cloud_usd_monthly_fixed','USD',499,1,'fixed'),
  ('cloud_usd_yearly_fixed','USD',3999,12,'fixed');
ALTER TABLE public.tokentracker_cloud_orders
  DROP CONSTRAINT tokentracker_cloud_orders_provider_check,
  DROP CONSTRAINT tokentracker_cloud_orders_check,
  ADD CONSTRAINT tokentracker_cloud_orders_provider_check
    CHECK (provider IN ('paddle','wechat','alipay','waffo')),
  ADD CONSTRAINT tokentracker_cloud_orders_provider_currency_check
    CHECK (provider = 'waffo' OR (provider = 'paddle' AND currency = 'USD') OR
      (provider IN ('wechat','alipay') AND currency = 'CNY')),
  ADD COLUMN provider_checkout_id text,
  ADD COLUMN waffo_order_id text,
  ADD COLUMN billing_mode text NOT NULL DEFAULT 'fixed' CHECK (billing_mode IN ('fixed','recurring')),
  ADD CONSTRAINT tokentracker_cloud_orders_waffo_identity_check
    CHECK ((provider = 'waffo' OR (provider_checkout_id IS NULL AND waffo_order_id IS NULL)) AND
      (provider_checkout_id IS NULL OR (provider_checkout_id ~ '^cs_[A-Za-z0-9-]+$' AND length(provider_checkout_id) <= 200)) AND
      (waffo_order_id IS NULL OR (waffo_order_id ~ '^ORD_[A-Za-z0-9]+$' AND length(waffo_order_id) <= 200)));
UPDATE public.tokentracker_cloud_orders SET billing_mode = 'recurring' WHERE provider = 'paddle';
ALTER TABLE public.tokentracker_cloud_orders ADD CONSTRAINT tokentracker_cloud_orders_provider_mode_check
  CHECK (provider = 'waffo' OR (provider = 'paddle' AND billing_mode = 'recurring') OR
    (provider IN ('wechat','alipay') AND billing_mode = 'fixed'));
CREATE UNIQUE INDEX tokentracker_cloud_orders_waffo_checkout_idx
  ON public.tokentracker_cloud_orders (environment, provider_checkout_id) WHERE provider = 'waffo';
CREATE UNIQUE INDEX tokentracker_cloud_orders_waffo_order_idx
  ON public.tokentracker_cloud_orders (environment, waffo_order_id) WHERE provider = 'waffo';
ALTER TABLE public.tokentracker_cloud_payments
  DROP CONSTRAINT tokentracker_cloud_payments_provider_check,
  ADD CONSTRAINT tokentracker_cloud_payments_provider_check CHECK (provider IN ('paddle','wechat','alipay','waffo'));
ALTER TABLE public.tokentracker_cloud_events
  DROP CONSTRAINT tokentracker_cloud_events_provider_check,
  ADD CONSTRAINT tokentracker_cloud_events_provider_check CHECK (provider IN ('paddle','wechat','alipay','waffo'));
ALTER TABLE public.tokentracker_cloud_subscriptions
  DROP CONSTRAINT tokentracker_cloud_subscriptions_provider_check,
  ADD CONSTRAINT tokentracker_cloud_subscriptions_provider_check CHECK (provider IN ('paddle','waffo'));

CREATE TABLE public.tokentracker_cloud_waffo_periods (
  order_id uuid NOT NULL REFERENCES public.tokentracker_cloud_orders(id),
  environment text NOT NULL REFERENCES public.tokentracker_cloud_policy(environment),
  waffo_order_id text NOT NULL,
  period_number integer NOT NULL CHECK (period_number > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  PRIMARY KEY (order_id, period_number),
  UNIQUE (environment, waffo_order_id, period_number)
);
ALTER TABLE public.tokentracker_cloud_waffo_periods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_cloud_waffo_periods FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tokentracker_cloud_waffo_periods TO project_admin;

CREATE OR REPLACE FUNCTION public.cloud_record_waffo_period(
  p_order_id uuid, p_environment text, p_waffo_order_id text, p_provider_price_id text,
  p_period_number integer, p_starts_at timestamptz, p_ends_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE; v_period public.tokentracker_cloud_waffo_periods%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id = p_order_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order.user_id::text || ':' || p_environment, 0));
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.provider <> 'waffo' OR v_order.environment <> p_environment OR v_order.billing_mode <> 'recurring' OR
    p_waffo_order_id IS NULL OR p_waffo_order_id !~ '^ORD_[A-Za-z0-9]+$' OR length(p_waffo_order_id) > 200 OR
    v_order.provider_price_id IS NULL OR p_provider_price_id IS DISTINCT FROM v_order.provider_price_id OR
    (v_order.waffo_order_id IS NOT NULL AND v_order.waffo_order_id <> p_waffo_order_id) THEN
    RAISE EXCEPTION 'Waffo billing period does not match the bound order or product';
  END IF;
  IF p_period_number IS NULL OR p_period_number <= 0 OR p_starts_at IS NULL OR p_ends_at IS NULL OR
    NOT isfinite(p_starts_at) OR NOT isfinite(p_ends_at) OR p_ends_at <= p_starts_at OR
    p_ends_at > p_starts_at + make_interval(months => v_order.term_months) + interval '1 day' OR
    p_ends_at < p_starts_at + make_interval(months => v_order.term_months) - interval '1 day' THEN
    RAISE EXCEPTION 'invalid Waffo subscription billing period';
  END IF;
  UPDATE public.tokentracker_cloud_orders SET waffo_order_id = coalesce(waffo_order_id, p_waffo_order_id)
    WHERE id = p_order_id;
  SELECT * INTO v_period FROM public.tokentracker_cloud_waffo_periods
    WHERE order_id = p_order_id AND period_number = p_period_number FOR UPDATE;
  IF FOUND THEN
    IF v_period.environment <> p_environment OR v_period.waffo_order_id <> p_waffo_order_id OR
      v_period.starts_at <> p_starts_at OR v_period.ends_at <> p_ends_at THEN
      RAISE EXCEPTION 'Waffo billing period is already bound to different dates';
    END IF;
  ELSE
    INSERT INTO public.tokentracker_cloud_waffo_periods
      (order_id, environment, waffo_order_id, period_number, starts_at, ends_at)
      VALUES (p_order_id, p_environment, p_waffo_order_id, p_period_number, p_starts_at, p_ends_at)
      RETURNING * INTO v_period;
  END IF;
  -- A verified lifecycle period is evidence for future payments, never paid access.
  RETURN to_jsonb(v_period);
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

CREATE OR REPLACE FUNCTION public.cloud_claim_checkout(p_user_id uuid, p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders
    WHERE id = p_order_id AND user_id = p_user_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order.user_id::text || ':' || v_order.environment,0));
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders
    WHERE id = p_order_id AND user_id = p_user_id FOR UPDATE;
  IF v_order.checkout_url IS NOT NULL OR v_order.checkout_attempts > 0 OR
    v_order.status <> 'pending' OR v_order.expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('claimed', false, 'order', to_jsonb(v_order));
  END IF;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_orders
    WHERE user_id = p_user_id AND environment = v_order.environment AND id <> v_order.id
      AND (v_order.billing_mode = 'recurring' OR billing_mode = 'recurring')
      AND status IN ('pending','ready') AND checkout_attempts > 0) THEN
    RAISE EXCEPTION 'an existing checkout must be confirmed before another subscription';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_subscriptions
    WHERE user_id = p_user_id AND environment = v_order.environment
      AND status IN ('active','trialing','past_due','paused') AND NOT cancel_at_period_end) THEN
    RAISE EXCEPTION 'manage the existing subscription before purchasing another plan';
  END IF;
  IF v_order.billing_mode = 'recurring' THEN
    IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_payments
      WHERE user_id = p_user_id AND environment = v_order.environment
        AND refunded_cents < amount_cents AND ends_at > clock_timestamp()) THEN
      RAISE EXCEPTION 'the current fixed membership term must end before starting a subscription';
    END IF;
  END IF;
  UPDATE public.tokentracker_cloud_orders
    SET checkout_attempts = checkout_attempts + 1, checkout_claimed_at = clock_timestamp()
    WHERE id = p_order_id RETURNING * INTO v_order;
  -- Ambiguous provider failures are reconciled, never retried as a new charge.
  RETURN jsonb_build_object('claimed', true, 'order', to_jsonb(v_order));
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
  IF v_order.provider = 'waffo' THEN RAISE EXCEPTION 'use the Waffo checkout binding'; END IF;
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

CREATE OR REPLACE FUNCTION public.cloud_attach_waffo_checkout(
  p_user_id uuid, p_order_id uuid, p_provider_checkout_id text,
  p_provider_price_id text, p_checkout_url text
) RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders
    WHERE id = p_order_id AND user_id = p_user_id FOR UPDATE;
  IF v_order.provider <> 'waffo' OR p_provider_price_id IS NULL OR
    p_provider_price_id = '' OR length(p_provider_price_id) > 200 OR
    (p_provider_checkout_id IS NOT NULL AND
      (p_provider_checkout_id !~ '^cs_[A-Za-z0-9-]+$' OR length(p_provider_checkout_id) > 200)) OR
    (p_checkout_url IS NOT NULL AND (p_provider_checkout_id IS NULL OR p_checkout_url !~ '^https://')) THEN
    RAISE EXCEPTION 'invalid Waffo checkout binding';
  END IF;
  IF (v_order.provider_checkout_id IS NOT NULL AND p_provider_checkout_id IS NOT NULL AND
      v_order.provider_checkout_id <> p_provider_checkout_id) OR
    (v_order.provider_price_id IS NOT NULL AND v_order.provider_price_id <> p_provider_price_id) OR
    (v_order.checkout_url IS NOT NULL AND p_checkout_url IS NOT NULL AND v_order.checkout_url <> p_checkout_url) THEN
    RAISE EXCEPTION 'checkout is already bound to a different Waffo session or product';
  END IF;
  -- Bind the validated product before the network call; its response may be lost.
  UPDATE public.tokentracker_cloud_orders
    SET provider_checkout_id = coalesce(provider_checkout_id, p_provider_checkout_id),
      provider_price_id = coalesce(provider_price_id, p_provider_price_id),
      checkout_url = coalesce(checkout_url, p_checkout_url),
      status = CASE WHEN status = 'pending' AND p_checkout_url IS NOT NULL THEN 'ready' ELSE status END
    WHERE id = p_order_id RETURNING * INTO v_order;
  RETURN to_jsonb(v_order);
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
  v_waffo_order_id text := nullif(p_event->>'waffo_order_id', '');
  v_recurring boolean;
BEGIN
  IF v_event_id IS NULL OR v_event_id = '' OR length(v_event_id) > 200 OR
    v_action_id IS NULL OR v_action_id = '' OR length(v_action_id) > 200 OR
    v_kind NOT IN ('payment', 'refund', 'subscription') OR v_kind IS NULL OR
    v_occurred IS NULL OR v_occurred > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid normalized payment event';
  END IF;
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders
    WHERE id = (p_event->>'order_id')::uuid;
  -- Also serialize separate orders which extend the same account's paid term.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order.user_id::text || ':' || p_environment, 0));
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders
    WHERE id = (p_event->>'order_id')::uuid FOR UPDATE;
  IF v_order.provider <> p_provider OR v_order.environment <> p_environment THEN
    RAISE EXCEPTION 'payment event does not match the order provider or environment';
  END IF;
  v_recurring := v_order.billing_mode = 'recurring';
  IF p_provider = 'waffo' THEN
    IF v_waffo_order_id IS NULL OR v_waffo_order_id !~ '^ORD_[A-Za-z0-9]+$' OR length(v_waffo_order_id) > 200 OR
      v_order.provider_price_id IS NULL OR p_event->>'provider_price_id' IS DISTINCT FROM v_order.provider_price_id OR
      (v_order.waffo_order_id IS NOT NULL AND v_order.waffo_order_id <> v_waffo_order_id) THEN
      RAISE EXCEPTION 'Waffo event does not match the bound order or product';
    END IF;
    IF (v_recurring AND v_subscription_id IS DISTINCT FROM v_waffo_order_id) OR
      (NOT v_recurring AND (v_subscription_id IS NOT NULL OR v_kind = 'subscription')) THEN
      RAISE EXCEPTION 'Waffo subscription does not match the order billing mode';
    END IF;
    IF (v_kind = 'payment' AND v_action_id !~ '^PAY_[A-Za-z0-9]+$') OR
      (v_kind = 'refund' AND (v_action_id !~ '^(REF|RFD)_[A-Za-z0-9]+$' OR
        coalesce(p_event->>'transaction_id', '') !~ '^PAY_[A-Za-z0-9]+$')) THEN
      RAISE EXCEPTION 'invalid Waffo payment or refund identity';
    END IF;
    UPDATE public.tokentracker_cloud_orders SET waffo_order_id = coalesce(waffo_order_id, v_waffo_order_id)
      WHERE id = v_order.id;
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
      (p_provider NOT IN ('paddle','waffo') AND v_amount <> v_order.amount_cents) THEN
      RAISE EXCEPTION 'invalid paid amount';
    END IF;
    IF v_recurring THEN
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
      IF p_provider = 'waffo' AND NOT EXISTS (
        SELECT 1 FROM public.tokentracker_cloud_waffo_periods
        WHERE order_id = v_order.id AND environment = p_environment AND waffo_order_id = v_waffo_order_id
          AND period_number = (p_event->>'period_number')::integer AND starts_at = v_start AND ends_at = v_end
      ) THEN
        RAISE EXCEPTION 'Waffo payment does not match a verified subscription billing period';
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
    IF NOT v_recurring OR v_subscription_id IS NULL OR
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

CREATE OR REPLACE FUNCTION public.cloud_apply_waffo_events(p_environment text, p_events jsonb)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE; v_event jsonb; v_results jsonb := '[]'::jsonb;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid Waffo payment event batch';
  END IF;
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders
    WHERE id = (p_events->0->>'order_id')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order.user_id::text || ':' || p_environment, 0));
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    IF v_event->>'order_id' IS DISTINCT FROM v_order.id::text THEN
      RAISE EXCEPTION 'Waffo payment batch must belong to one order';
    END IF;
    v_results := v_results || jsonb_build_array(public.cloud_apply_event('waffo', p_environment, v_event));
  END LOOP;
  RETURN jsonb_build_object('results', v_results);
END;
$fn$;

REVOKE ALL ON FUNCTION public.cloud_attach_waffo_checkout(uuid,uuid,text,text,text),
  public.cloud_apply_waffo_events(text,jsonb),
  public.cloud_record_waffo_period(uuid,text,text,text,integer,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_attach_waffo_checkout(uuid,uuid,text,text,text),
  public.cloud_apply_waffo_events(text,jsonb),
  public.cloud_record_waffo_period(uuid,text,text,text,integer,timestamptz,timestamptz) TO project_admin;
