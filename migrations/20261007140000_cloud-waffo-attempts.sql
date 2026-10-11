-- Waffo may replace its ORD after checkout Back while retaining our application order UUID.
-- Register every independently verified attempt; only a real payment chooses the canonical ORD.
CREATE TABLE public.tokentracker_cloud_waffo_attempts (
  order_id uuid NOT NULL REFERENCES public.tokentracker_cloud_orders(id),
  environment text NOT NULL REFERENCES public.tokentracker_cloud_policy(environment),
  waffo_order_id text NOT NULL CHECK (waffo_order_id ~ '^ORD_[A-Za-z0-9]+$' AND length(waffo_order_id) <= 200),
  provider_price_id text NOT NULL CHECK (provider_price_id <> '' AND length(provider_price_id) <= 200),
  billing_mode text NOT NULL CHECK (billing_mode IN ('fixed','recurring')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (environment,waffo_order_id),
  UNIQUE (order_id,environment,waffo_order_id)
);
CREATE INDEX tokentracker_cloud_waffo_attempts_order_idx ON public.tokentracker_cloud_waffo_attempts(order_id);
ALTER TABLE public.tokentracker_cloud_waffo_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_cloud_waffo_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tokentracker_cloud_waffo_attempts TO project_admin;
INSERT INTO public.tokentracker_cloud_waffo_attempts (order_id,environment,waffo_order_id,provider_price_id,billing_mode)
  SELECT id,environment,waffo_order_id,provider_price_id,billing_mode FROM public.tokentracker_cloud_orders
    WHERE provider = 'waffo' AND waffo_order_id IS NOT NULL AND provider_price_id IS NOT NULL
  UNION
  SELECT p.order_id,p.environment,p.waffo_order_id,o.provider_price_id,o.billing_mode
    FROM public.tokentracker_cloud_waffo_periods p JOIN public.tokentracker_cloud_orders o ON o.id = p.order_id
  UNION
  SELECT s.order_id,s.environment,s.provider_subscription_id,o.provider_price_id,o.billing_mode
    FROM public.tokentracker_cloud_subscriptions s JOIN public.tokentracker_cloud_orders o ON o.id = s.order_id
    WHERE s.provider = 'waffo'
  UNION
  SELECT e.order_id,e.environment,e.normalized_event->>'waffo_order_id',o.provider_price_id,o.billing_mode
    FROM public.tokentracker_cloud_events e JOIN public.tokentracker_cloud_orders o ON o.id = e.order_id
    WHERE e.provider = 'waffo' AND e.normalized_event->>'waffo_order_id' IS NOT NULL
  ON CONFLICT (environment,waffo_order_id) DO NOTHING;
ALTER TABLE public.tokentracker_cloud_payments ADD COLUMN waffo_order_id text;
UPDATE public.tokentracker_cloud_payments p SET waffo_order_id = coalesce(
  (SELECT e.normalized_event->>'waffo_order_id' FROM public.tokentracker_cloud_events e
    WHERE e.provider = 'waffo' AND e.environment = p.environment AND e.order_id = p.order_id
      AND e.kind = 'payment' AND e.action_id = p.transaction_id AND e.status = 'applied'
    ORDER BY e.received_at LIMIT 1),
  p.subscription_id,(SELECT o.waffo_order_id FROM public.tokentracker_cloud_orders o WHERE o.id = p.order_id))
  WHERE p.provider = 'waffo';
ALTER TABLE public.tokentracker_cloud_payments
  ADD CONSTRAINT tokentracker_cloud_payments_waffo_attempt_check CHECK (provider <> 'waffo' OR waffo_order_id IS NOT NULL),
  ADD CONSTRAINT tokentracker_cloud_payments_waffo_attempt_fkey FOREIGN KEY (order_id,environment,waffo_order_id)
    REFERENCES public.tokentracker_cloud_waffo_attempts(order_id,environment,waffo_order_id);
ALTER TABLE public.tokentracker_cloud_waffo_periods
  DROP CONSTRAINT tokentracker_cloud_waffo_periods_pkey,
  ADD PRIMARY KEY (order_id,waffo_order_id,period_number),
  ADD CONSTRAINT tokentracker_cloud_waffo_periods_attempt_fkey FOREIGN KEY (order_id,environment,waffo_order_id)
    REFERENCES public.tokentracker_cloud_waffo_attempts(order_id,environment,waffo_order_id);
UPDATE public.tokentracker_cloud_orders o SET waffo_order_id = (
  SELECT p.waffo_order_id FROM public.tokentracker_cloud_payments p WHERE p.order_id = o.id AND p.provider = 'waffo'
    ORDER BY CASE WHEN p.transaction_id = o.provider_order_id THEN 0 ELSE 1 END,p.paid_at,p.id LIMIT 1
) WHERE o.provider = 'waffo';


CREATE OR REPLACE FUNCTION public.cloud_register_waffo_attempt(
  p_order_id uuid,p_environment text,p_waffo_order_id text,p_provider_price_id text,p_billing_mode text
) RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE; v_attempt public.tokentracker_cloud_waffo_attempts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id = p_order_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order.user_id::text || ':' || p_environment,0));
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.provider <> 'waffo' OR v_order.environment IS DISTINCT FROM p_environment OR
    p_waffo_order_id IS NULL OR p_waffo_order_id !~ '^ORD_[A-Za-z0-9]+$' OR length(p_waffo_order_id) > 200 OR
    v_order.provider_price_id IS NULL OR v_order.provider_price_id IS DISTINCT FROM p_provider_price_id OR
    v_order.billing_mode IS DISTINCT FROM p_billing_mode THEN
    RAISE EXCEPTION 'Waffo attempt does not match the bound order, product, or billing mode';
  END IF;
  SELECT * INTO v_attempt FROM public.tokentracker_cloud_waffo_attempts
    WHERE environment = p_environment AND waffo_order_id = p_waffo_order_id FOR UPDATE;
  IF FOUND AND (v_attempt.order_id <> p_order_id OR v_attempt.provider_price_id <> p_provider_price_id OR
    v_attempt.billing_mode <> p_billing_mode) THEN
    RAISE EXCEPTION 'Waffo attempt belongs to a different order, product, or billing mode';
  END IF;
  INSERT INTO public.tokentracker_cloud_waffo_attempts(order_id,environment,waffo_order_id,provider_price_id,billing_mode)
    VALUES (p_order_id,p_environment,p_waffo_order_id,p_provider_price_id,p_billing_mode)
    ON CONFLICT (environment,waffo_order_id) DO UPDATE SET last_seen_at = clock_timestamp()
      WHERE tokentracker_cloud_waffo_attempts.order_id = excluded.order_id
        AND tokentracker_cloud_waffo_attempts.provider_price_id = excluded.provider_price_id
        AND tokentracker_cloud_waffo_attempts.billing_mode = excluded.billing_mode
    RETURNING * INTO STRICT v_attempt;
  RETURN to_jsonb(v_attempt);
END;
$fn$;
REVOKE ALL ON FUNCTION public.cloud_register_waffo_attempt(uuid,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_register_waffo_attempt(uuid,text,text,text,text) TO project_admin;


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
    NOT EXISTS (SELECT 1 FROM public.tokentracker_cloud_waffo_attempts
      WHERE order_id = p_order_id AND environment = p_environment AND waffo_order_id = p_waffo_order_id
        AND provider_price_id = p_provider_price_id AND billing_mode = 'recurring') THEN
    RAISE EXCEPTION 'Waffo billing period does not match the bound order or product';
  END IF;
  IF p_period_number IS NULL OR p_period_number <= 0 OR p_starts_at IS NULL OR p_ends_at IS NULL OR
    NOT isfinite(p_starts_at) OR NOT isfinite(p_ends_at) OR p_ends_at <= p_starts_at OR
    p_ends_at > p_starts_at + make_interval(months => v_order.term_months) + interval '1 day' OR
    p_ends_at < p_starts_at + make_interval(months => v_order.term_months) - interval '1 day' THEN
    RAISE EXCEPTION 'invalid Waffo subscription billing period';
  END IF;
  SELECT * INTO v_period FROM public.tokentracker_cloud_waffo_periods
    WHERE order_id = p_order_id AND waffo_order_id = p_waffo_order_id AND period_number = p_period_number FOR UPDATE;
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
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_orders
    WHERE user_id = p_user_id AND environment = v_order.environment AND retry_payment_conflict_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a payment conflict must be resolved before another purchase';
  END IF;
  IF EXISTS (
    WITH RECURSIVE predecessors AS (
      SELECT id FROM public.tokentracker_cloud_orders
        WHERE retry_order_id = v_order.id AND user_id = p_user_id AND environment = v_order.environment
      UNION
      SELECT o.id FROM public.tokentracker_cloud_orders o JOIN predecessors p ON o.retry_order_id = p.id
        WHERE o.user_id = p_user_id AND o.environment = v_order.environment
    )
    SELECT 1 FROM public.tokentracker_cloud_payments WHERE order_id IN (SELECT id FROM predecessors)
  ) THEN
    RAISE EXCEPTION 'a previous retry order has a successful payment';
  END IF;
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
      NOT EXISTS (SELECT 1 FROM public.tokentracker_cloud_waffo_attempts
        WHERE order_id = v_order.id AND environment = p_environment AND waffo_order_id = v_waffo_order_id
          AND provider_price_id = v_order.provider_price_id AND billing_mode = v_order.billing_mode) THEN
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
  END IF;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_events
    WHERE provider = p_provider AND environment = p_environment AND event_id = v_event_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.tokentracker_cloud_events
      WHERE provider = p_provider AND environment = p_environment AND event_id = v_event_id
        AND normalized_event = p_event AND order_id = v_order.id) THEN
      RAISE EXCEPTION 'event identifier was already used for different payment data';
    END IF;
    RETURN jsonb_build_object('applied', false, 'duplicate', true,
      'retry_payment_conflict', (SELECT retry_payment_conflict_at IS NOT NULL
        FROM public.tokentracker_cloud_orders WHERE id = v_order.id));
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
      IF p_provider = 'paddle' AND v_order.provider_order_id IS NOT NULL AND v_order.provider_order_id <> v_action_id
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
      IF p_provider <> 'waffo' AND v_order.provider_order_id IS NOT NULL AND v_order.provider_order_id <> v_action_id THEN
        RAISE EXCEPTION 'payment transaction does not match the order';
      END IF;
      SELECT greatest(clock_timestamp(), max(ends_at)) INTO v_start
        FROM public.tokentracker_cloud_payments WHERE user_id = v_order.user_id
          AND environment = p_environment AND refunded_cents < amount_cents;
      v_end := v_start + make_interval(months => v_order.term_months);
    END IF;
    INSERT INTO public.tokentracker_cloud_payments
      (order_id, user_id, provider, environment, transaction_id, subscription_id,
        currency, amount_cents, starts_at, ends_at, paid_at, waffo_order_id)
      VALUES (v_order.id, v_order.user_id, p_provider, p_environment, v_action_id, v_subscription_id,
        v_order.currency, v_amount, v_start, v_end, v_occurred, CASE WHEN p_provider = 'waffo' THEN v_waffo_order_id END);
    UPDATE public.tokentracker_cloud_orders SET status = 'paid',
      provider_order_id = coalesce(provider_order_id, v_action_id),
      waffo_order_id = CASE WHEN p_provider = 'waffo' THEN coalesce(waffo_order_id,v_waffo_order_id) ELSE waffo_order_id END
      WHERE id = v_order.id;
  ELSIF v_kind = 'refund' THEN
    SELECT * INTO STRICT v_payment FROM public.tokentracker_cloud_payments
      WHERE provider = p_provider AND environment = p_environment
        AND transaction_id = p_event->>'transaction_id' FOR UPDATE;
    IF v_payment.order_id <> v_order.id OR v_payment.user_id <> v_order.user_id OR
      p_event->>'currency' IS DISTINCT FROM v_payment.currency OR
      (p_provider = 'waffo' AND v_payment.waffo_order_id IS DISTINCT FROM v_waffo_order_id) THEN
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
    'retry_payment_conflict', (SELECT retry_payment_conflict_at IS NOT NULL
      FROM public.tokentracker_cloud_orders WHERE id = v_order.id),
    'membership', public.cloud_membership(v_order.user_id, p_environment));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_detect_waffo_retry_payment_conflict()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE v_chain uuid[]; v_descendants uuid[];
BEGIN
  IF NEW.provider <> 'waffo' THEN RETURN NEW; END IF;
  WITH RECURSIVE edges AS (
    SELECT id AS origin, retry_order_id AS target FROM public.tokentracker_cloud_orders
      WHERE user_id = NEW.user_id AND environment = NEW.environment AND retry_order_id IS NOT NULL
    UNION ALL
    SELECT retry_order_id AS origin, id AS target FROM public.tokentracker_cloud_orders
      WHERE user_id = NEW.user_id AND environment = NEW.environment AND retry_order_id IS NOT NULL
  ), chain AS (
    SELECT NEW.order_id AS id
    UNION
    SELECT e.target FROM edges e JOIN chain c ON e.origin = c.id
  ) SELECT array_agg(id) INTO v_chain FROM chain;
  WITH RECURSIVE descendants AS (
    SELECT retry_order_id AS id FROM public.tokentracker_cloud_orders
      WHERE id = NEW.order_id AND retry_order_id IS NOT NULL
    UNION
    SELECT o.retry_order_id FROM public.tokentracker_cloud_orders o JOIN descendants d ON o.id = d.id
      WHERE o.user_id = NEW.user_id AND o.environment = NEW.environment AND o.retry_order_id IS NOT NULL
  ) SELECT array_agg(id) INTO v_descendants FROM descendants;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_payments p
      JOIN public.tokentracker_cloud_orders o ON o.id = p.order_id
      WHERE p.order_id = NEW.order_id AND p.id <> NEW.id
        AND (p.waffo_order_id IS DISTINCT FROM NEW.waffo_order_id OR o.billing_mode = 'fixed')) OR
    EXISTS (SELECT 1 FROM public.tokentracker_cloud_orders
      WHERE id = ANY(v_descendants) AND checkout_attempts > 0) OR
    EXISTS (SELECT 1 FROM public.tokentracker_cloud_payments
      WHERE user_id = NEW.user_id AND environment = NEW.environment
        AND order_id = ANY(v_chain) AND order_id <> NEW.order_id) THEN
    -- Keep both real payments; expose the conflict for provider reconciliation and refund review.
    UPDATE public.tokentracker_cloud_orders
      SET retry_payment_conflict_at = coalesce(retry_payment_conflict_at,clock_timestamp()) WHERE id = ANY(v_chain);
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE OR REPLACE FUNCTION public.cloud_restart_waffo_attempts(
  p_user_id uuid, p_environment text, p_order_id uuid, p_request_id uuid, p_waffo_order_ids text[]
) RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE; v_next public.tokentracker_cloud_orders%ROWTYPE; v_next_id uuid; v_given text[]; v_known text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_environment, 0));
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders
    WHERE id = p_order_id AND user_id = p_user_id AND environment = p_environment FOR UPDATE;
  IF v_order.provider <> 'waffo' OR v_order.status NOT IN ('pending','ready','closed') OR
    p_request_id IS NULL OR v_order.provider_price_id IS NULL THEN
    RAISE EXCEPTION 'Waffo restart does not match the unpaid bound order';
  END IF;
  IF p_waffo_order_ids IS NULL OR cardinality(p_waffo_order_ids) NOT BETWEEN 1 AND 1000 OR
    EXISTS (SELECT 1 FROM unnest(p_waffo_order_ids) x WHERE x IS NULL OR x !~ '^ORD_[A-Za-z0-9]+$' OR length(x) > 200) THEN
    RAISE EXCEPTION 'invalid verified Waffo attempt bundle';
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_given FROM unnest(p_waffo_order_ids) x;
  SELECT array_agg(waffo_order_id ORDER BY waffo_order_id) INTO v_known
    FROM public.tokentracker_cloud_waffo_attempts WHERE order_id = p_order_id AND environment = p_environment;
  IF v_given IS DISTINCT FROM v_known OR EXISTS (SELECT 1 FROM public.tokentracker_cloud_waffo_attempts
    WHERE order_id = p_order_id AND environment = p_environment AND
      (provider_price_id <> v_order.provider_price_id OR billing_mode <> v_order.billing_mode)) THEN
    RAISE EXCEPTION 'Waffo restart requires the complete registered attempt bundle';
  END IF;
  IF EXISTS (
    WITH RECURSIVE predecessors AS (
      SELECT id FROM public.tokentracker_cloud_orders WHERE id = p_order_id
      UNION
      SELECT o.id FROM public.tokentracker_cloud_orders o JOIN predecessors p ON o.retry_order_id = p.id
        WHERE o.user_id = p_user_id AND o.environment = p_environment
    )
    SELECT 1 FROM public.tokentracker_cloud_payments WHERE order_id IN (SELECT id FROM predecessors)
  ) THEN
    RAISE EXCEPTION 'a paid Waffo order cannot be restarted';
  END IF;
  IF v_order.retry_order_id IS NOT NULL THEN
    SELECT * INTO STRICT v_next FROM public.tokentracker_cloud_orders
      WHERE id = v_order.retry_order_id AND user_id = p_user_id AND environment = p_environment;
    RETURN jsonb_build_object('order',to_jsonb(v_next),'reused',true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_orders
    WHERE user_id = p_user_id AND environment = p_environment AND request_id = p_request_id) THEN
    RAISE EXCEPTION 'retry request already belongs to another order';
  END IF;
  UPDATE public.tokentracker_cloud_orders SET status = 'closed' WHERE id = p_order_id;
  v_next_id := (public.cloud_create_order(p_user_id,p_environment,'waffo',v_order.sku,p_request_id)->>'id')::uuid;
  SELECT * INTO STRICT v_next FROM public.tokentracker_cloud_orders WHERE id = v_next_id;
  UPDATE public.tokentracker_cloud_orders SET retry_order_id = v_next.id WHERE id = p_order_id;
  RETURN jsonb_build_object('order',to_jsonb(v_next),'reused',false);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cloud_restart_waffo_order(
  p_user_id uuid,p_environment text,p_order_id uuid,p_request_id uuid,p_waffo_order_id text
) RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
BEGIN
  RETURN public.cloud_restart_waffo_attempts(p_user_id,p_environment,p_order_id,p_request_id,ARRAY[p_waffo_order_id]);
END;
$fn$;
REVOKE ALL ON FUNCTION public.cloud_restart_waffo_attempts(uuid,text,uuid,uuid,text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_restart_waffo_attempts(uuid,text,uuid,uuid,text[]) TO project_admin;
