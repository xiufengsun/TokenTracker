ALTER TABLE public.tokentracker_cloud_orders ADD COLUMN provider_checkout_expires_at timestamptz;

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
  IF v_order.status NOT IN ('pending','ready') THEN
    IF (v_order.checkout_url IS NULL AND p_checkout_url IS NOT NULL) OR
      (v_order.provider_checkout_id IS NULL AND p_provider_checkout_id IS NOT NULL) THEN
      RAISE EXCEPTION 'cannot attach a checkout to a terminal order';
    END IF;
    RETURN to_jsonb(v_order);
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

CREATE OR REPLACE FUNCTION public.cloud_attach_waffo_checkout(
  p_user_id uuid, p_order_id uuid, p_provider_checkout_id text,
  p_provider_price_id text, p_checkout_url text, p_provider_checkout_expires_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE;
BEGIN
  IF p_provider_checkout_expires_at IS NULL OR p_provider_checkout_id IS NULL OR p_checkout_url IS NULL THEN
    RAISE EXCEPTION 'invalid Waffo checkout receipt';
  END IF;
  PERFORM public.cloud_attach_waffo_checkout(p_user_id,p_order_id,p_provider_checkout_id,p_provider_price_id,p_checkout_url);
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id=p_order_id AND user_id=p_user_id FOR UPDATE;
  IF v_order.status NOT IN ('pending','ready') THEN RETURN to_jsonb(v_order); END IF;
  IF v_order.provider_checkout_expires_at IS NOT NULL AND v_order.provider_checkout_expires_at <> p_provider_checkout_expires_at THEN
    RAISE EXCEPTION 'checkout is already bound to a different Waffo expiry';
  END IF;
  UPDATE public.tokentracker_cloud_orders
    SET provider_checkout_expires_at=p_provider_checkout_expires_at,expires_at=p_provider_checkout_expires_at
    WHERE id=p_order_id RETURNING * INTO v_order;
  RETURN to_jsonb(v_order);
END;
$fn$;
REVOKE ALL ON FUNCTION public.cloud_attach_waffo_checkout(uuid,uuid,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_attach_waffo_checkout(uuid,uuid,text,text,text,timestamptz) TO project_admin;

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
    p_request_id IS NULL OR (v_order.provider_price_id IS NULL AND NOT (
      cardinality(p_waffo_order_ids) = 0 AND v_order.checkout_attempts = 0 AND
      v_order.provider_checkout_id IS NULL AND v_order.checkout_url IS NULL)) THEN
    RAISE EXCEPTION 'Waffo restart does not match the unpaid bound order';
  END IF;
  IF p_waffo_order_ids IS NULL OR cardinality(p_waffo_order_ids) NOT BETWEEN 0 AND 1000 OR
    EXISTS (SELECT 1 FROM unnest(p_waffo_order_ids) x WHERE x IS NULL OR x !~ '^ORD_[A-Za-z0-9]+$' OR length(x) > 200) THEN
    RAISE EXCEPTION 'invalid verified Waffo attempt bundle';
  END IF;
  IF cardinality(p_waffo_order_ids) = 0 AND (
    v_order.provider_order_id IS NOT NULL OR v_order.waffo_order_id IS NOT NULL OR
    v_order.expires_at > clock_timestamp() OR
    (v_order.provider_checkout_id IS NULL) <> (v_order.checkout_url IS NULL) OR
    (NOT (v_order.checkout_attempts = 0 AND v_order.provider_checkout_id IS NULL AND v_order.checkout_url IS NULL) AND
      (v_order.checkout_claimed_at IS NULL OR
        coalesce(v_order.provider_checkout_expires_at,v_order.expires_at + interval '30 minutes') + interval '1 minute' > clock_timestamp()))) THEN
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
