-- The Waffo test simulator can report a successful accelerated paid window.
-- Preserve its exact dates for sandbox accounting. Live purchased periods retain the full-term lower bound.
-- This does not turn collection grace or an authorization into a paid period.
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
    (p_environment <> 'sandbox' AND p_ends_at < p_starts_at + make_interval(months => v_order.term_months) - interval '1 day') THEN
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
        ((p_provider <> 'waffo' OR p_environment <> 'sandbox') AND v_end < v_start + make_interval(months => v_order.term_months) - interval '1 day') THEN
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
