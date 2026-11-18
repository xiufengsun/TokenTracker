-- Intent is not a terminal order state: pending/ready continue to block gifts.
ALTER TABLE public.tokentracker_cloud_orders
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN checkout_started boolean NOT NULL DEFAULT false,
  ADD COLUMN checkout_tracking_uncertain boolean NOT NULL DEFAULT false;
-- Pre-deployment requests have no durable operation receipts. Never infer their completion.
UPDATE public.tokentracker_cloud_orders SET checkout_started=true,checkout_tracking_uncertain=true
  WHERE checkout_attempts > 0 AND status IN ('pending','ready');
CREATE TABLE public.tokentracker_cloud_checkout_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.tokentracker_cloud_orders(id),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  uncertain boolean NOT NULL DEFAULT false
);
CREATE INDEX cloud_checkout_operations_order ON public.tokentracker_cloud_checkout_operations(order_id);
ALTER TABLE public.tokentracker_cloud_checkout_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_cloud_checkout_operations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.tokentracker_cloud_checkout_operations TO project_admin;

-- Official InsForge migration guards reject session-configuration statements.
-- Keep a transaction-local privileged marker table keyed by txid_current() instead.
CREATE TABLE public.tokentracker_cloud_tx_markers (
  txid bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('tracked_checkout_claim','order_cancel_finalizing')),
  order_id uuid NOT NULL,
  PRIMARY KEY (txid, kind)
);
ALTER TABLE public.tokentracker_cloud_tx_markers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_cloud_tx_markers FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.tokentracker_cloud_tx_markers TO project_admin;
CREATE FUNCTION public.cloud_tx_mark(p_kind text,p_order_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN
  INSERT INTO public.tokentracker_cloud_tx_markers(txid,kind,order_id)
    VALUES(txid_current(),p_kind,p_order_id)
    ON CONFLICT (txid,kind) DO UPDATE SET order_id=EXCLUDED.order_id;
END;
$fn$;
CREATE FUNCTION public.cloud_tx_has(p_kind text,p_order_id uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN
  RETURN EXISTS(SELECT 1 FROM public.tokentracker_cloud_tx_markers
    WHERE txid=txid_current() AND kind=p_kind AND order_id=p_order_id);
END;
$fn$;
CREATE FUNCTION public.cloud_tx_clear(p_kind text,p_order_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN
  DELETE FROM public.tokentracker_cloud_tx_markers
    WHERE txid=txid_current() AND kind=p_kind AND order_id=p_order_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.cloud_tx_mark(text,uuid),public.cloud_tx_has(text,uuid),public.cloud_tx_clear(text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_tx_mark(text,uuid),public.cloud_tx_has(text,uuid),public.cloud_tx_clear(text,uuid)
  TO project_admin;

-- Existing handlers also recover already-claimed pending checkouts. Preserve the
-- old RPC contract, but account for every legacy call that could issue a request.
CREATE OR REPLACE FUNCTION public.cloud_claim_checkout(p_user_id uuid,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $fn$
DECLARE v_order public.tokentracker_cloud_orders%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id=p_order_id AND user_id=p_user_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||v_order.environment,0));
  SELECT * INTO STRICT v_order FROM public.tokentracker_cloud_orders WHERE id=p_order_id AND user_id=p_user_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.tokentracker_cloud_orders WHERE user_id=p_user_id
    AND environment=v_order.environment AND cancel_requested_at IS NOT NULL AND status IN ('pending','ready')) THEN
    RAISE EXCEPTION 'order cancellation is pending';
  END IF;
  IF v_order.provider='waffo' AND v_order.status='pending' AND v_order.checkout_url IS NULL
    AND NOT public.cloud_tx_has('tracked_checkout_claim',v_order.id) THEN
    UPDATE public.tokentracker_cloud_orders SET checkout_started=true,checkout_tracking_uncertain=true
      WHERE id=v_order.id RETURNING * INTO v_order;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_gift_grants WHERE user_id=p_user_id AND environment=v_order.environment
      AND revoked_at IS NULL AND ends_at>clock_timestamp()) AND v_order.status<>'paid' THEN
    RAISE EXCEPTION 'gift_membership_active';
  END IF;
  RETURN public.cloud_claim_checkout_before_gifts(p_user_id,p_order_id);
END;
$fn$;

CREATE FUNCTION public.cloud_guard_cancelled_checkout() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $fn$
BEGIN
  -- Receipt attachment and paid webhooks must retain their existing lock order.
  IF TG_OP='UPDATE' AND NOT (NEW.checkout_attempts > OLD.checkout_attempts OR
    NEW.retry_order_id IS DISTINCT FROM OLD.retry_order_id OR
    (OLD.cancel_requested_at IS NOT NULL AND OLD.status IN ('pending','ready') AND NEW.status='closed')) THEN
    RETURN NEW;
  END IF;
  -- Legacy handlers can still claim during a rolling function deployment. Only
  -- the atomic tracked wrapper proves that its claim will have an operation receipt.
  IF TG_OP='UPDATE' AND NEW.provider='waffo' AND NEW.checkout_attempts > OLD.checkout_attempts
    AND NOT public.cloud_tx_has('tracked_checkout_claim',NEW.id) THEN
    NEW.checkout_started=true;
    NEW.checkout_tracking_uncertain=true;
  END IF;
  -- Same account lock as checkout claims, gifts, payment application and cancellation.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text || ':' || NEW.environment,0));
  IF TG_OP='UPDATE' AND OLD.cancel_requested_at IS NOT NULL AND (
    NEW.retry_order_id IS DISTINCT FROM OLD.retry_order_id OR
    (OLD.status IN ('pending','ready') AND NEW.status='closed' AND
      NOT public.cloud_tx_has('order_cancel_finalizing',OLD.id))) THEN
    RAISE EXCEPTION 'order cancellation is pending';
  END IF;
  IF TG_OP='INSERT' OR NEW.checkout_attempts > OLD.checkout_attempts OR
    NEW.retry_order_id IS DISTINCT FROM OLD.retry_order_id THEN
    IF EXISTS (SELECT 1 FROM public.tokentracker_cloud_orders WHERE user_id=NEW.user_id
      AND environment=NEW.environment AND cancel_requested_at IS NOT NULL AND status IN ('pending','ready')) THEN
      RAISE EXCEPTION 'order cancellation is pending';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER cloud_guard_cancelled_checkout BEFORE INSERT OR UPDATE OF checkout_attempts,retry_order_id,status
  ON public.tokentracker_cloud_orders FOR EACH ROW EXECUTE FUNCTION public.cloud_guard_cancelled_checkout();

CREATE FUNCTION public.cloud_begin_checkout_operation(p_user_id uuid,p_environment text,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE o public.tokentracker_cloud_orders%ROWTYPE; operation_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_environment,0));
  SELECT * INTO STRICT o FROM public.tokentracker_cloud_orders
    WHERE id=p_order_id AND user_id=p_user_id AND environment=p_environment FOR UPDATE;
  IF o.cancel_requested_at IS NOT NULL OR o.status NOT IN ('pending','ready') OR o.expires_at<=clock_timestamp()
    OR EXISTS(SELECT 1 FROM public.tokentracker_cloud_orders WHERE user_id=p_user_id AND environment=p_environment
      AND cancel_requested_at IS NOT NULL AND status IN ('pending','ready')) THEN
    RETURN jsonb_build_object('allowed',false);
  END IF;
  INSERT INTO public.tokentracker_cloud_checkout_operations(order_id) VALUES(o.id) RETURNING id INTO operation_id;
  UPDATE public.tokentracker_cloud_orders SET checkout_started=true WHERE id=o.id;
  RETURN jsonb_build_object('allowed',true,'operation_id',operation_id);
END;
$fn$;
-- Claim and receipt creation are one transaction; old handlers keep their old RPC
-- but their claims are conservatively marked uncertain by the trigger above.
CREATE FUNCTION public.cloud_claim_checkout_tracked(p_user_id uuid,p_environment text,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE o public.tokentracker_cloud_orders%ROWTYPE; claimed jsonb; operation jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_environment,0));
  SELECT * INTO STRICT o FROM public.tokentracker_cloud_orders
    WHERE id=p_order_id AND user_id=p_user_id AND environment=p_environment FOR UPDATE;
  IF o.provider<>'waffo' THEN RAISE EXCEPTION 'tracked checkout requires Waffo'; END IF;
  IF EXISTS(SELECT 1 FROM public.tokentracker_cloud_orders WHERE user_id=p_user_id
    AND environment=p_environment AND cancel_requested_at IS NOT NULL AND status IN ('pending','ready')) THEN
    RETURN jsonb_build_object('claimed',false,'order',to_jsonb(o),'cancel_pending',true);
  END IF;
  PERFORM public.cloud_tx_mark('tracked_checkout_claim',o.id);
  claimed := public.cloud_claim_checkout(p_user_id,p_order_id);
  PERFORM public.cloud_tx_clear('tracked_checkout_claim',o.id);
  SELECT * INTO STRICT o FROM public.tokentracker_cloud_orders WHERE id=p_order_id;
  IF o.checkout_url IS NULL AND o.status='pending' AND o.expires_at>clock_timestamp()
    AND ((claimed->>'claimed')::boolean OR o.provider_price_id IS NOT NULL) THEN
    operation := public.cloud_begin_checkout_operation(p_user_id,p_environment,p_order_id);
    IF NOT (operation->>'allowed')::boolean THEN RAISE EXCEPTION 'order cancellation is pending'; END IF;
    claimed := claimed || jsonb_build_object('operation_id',operation->'operation_id');
  END IF;
  RETURN claimed;
END;
$fn$;
REVOKE ALL ON FUNCTION public.cloud_claim_checkout_tracked(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_claim_checkout_tracked(uuid,text,uuid) TO project_admin;

CREATE FUNCTION public.cloud_finish_checkout_operation(p_user_id uuid,p_environment text,p_order_id uuid,p_operation_id uuid,p_uncertain boolean)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_environment,0));
  PERFORM 1 FROM public.tokentracker_cloud_orders WHERE id=p_order_id AND user_id=p_user_id
    AND environment=p_environment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order not found'; END IF;
  UPDATE public.tokentracker_cloud_checkout_operations SET finished_at=clock_timestamp(),uncertain=p_uncertain
    WHERE id=p_operation_id AND order_id=p_order_id AND finished_at IS NULL;
  RETURN jsonb_build_object('ok',true);
END;
$fn$;

CREATE FUNCTION public.cloud_request_order_cancel(p_user_id uuid,p_environment text,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE o public.tokentracker_cloud_orders%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_environment,0));
  SELECT * INTO STRICT o FROM public.tokentracker_cloud_orders
    WHERE id=p_order_id AND user_id=p_user_id AND environment=p_environment FOR UPDATE;
  IF o.provider<>'waffo' OR o.retry_order_id IS NOT NULL THEN
    RETURN jsonb_build_object('error','order_cancel_unavailable');
  END IF;
  IF o.status IN ('pending','ready') THEN
    UPDATE public.tokentracker_cloud_orders SET cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp())
      WHERE id=o.id RETURNING * INTO o;
    IF o.checkout_attempts=0 AND NOT o.checkout_started AND NOT o.checkout_tracking_uncertain AND o.checkout_url IS NULL
      AND o.provider_checkout_id IS NULL AND o.provider_order_id IS NULL AND o.waffo_order_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.tokentracker_cloud_checkout_operations WHERE order_id=o.id)
      AND NOT EXISTS(SELECT 1 FROM public.tokentracker_cloud_waffo_attempts WHERE order_id=o.id)
      AND NOT EXISTS(SELECT 1 FROM public.tokentracker_cloud_payments WHERE order_id=o.id)
      AND NOT EXISTS(SELECT 1 FROM public.tokentracker_cloud_subscriptions WHERE order_id=o.id) THEN
      PERFORM public.cloud_tx_mark('order_cancel_finalizing',o.id);
      UPDATE public.tokentracker_cloud_orders SET status='closed' WHERE id=o.id RETURNING * INTO o;
      PERFORM public.cloud_tx_clear('order_cancel_finalizing',o.id);
    END IF;
  END IF;
  RETURN to_jsonb(o);
END;
$fn$;

CREATE FUNCTION public.cloud_finalize_order_cancel(p_user_id uuid,p_environment text,p_order_id uuid,
  p_checkout_id text,p_checkout_expires_at timestamptz,p_attempt_ids text[])
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE o public.tokentracker_cloud_orders%ROWTYPE; known text[]; given text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_environment,0));
  SELECT * INTO STRICT o FROM public.tokentracker_cloud_orders
    WHERE id=p_order_id AND user_id=p_user_id AND environment=p_environment FOR UPDATE;
  IF o.status NOT IN ('pending','ready') THEN RETURN to_jsonb(o); END IF;
  IF o.cancel_requested_at IS NULL OR o.provider<>'waffo' OR o.checkout_tracking_uncertain
    OR o.retry_order_id IS NOT NULL OR o.retry_payment_conflict_at IS NOT NULL
    OR o.provider_order_id IS NOT NULL OR o.waffo_order_id IS NOT NULL
    OR o.provider_checkout_id IS NULL OR o.provider_checkout_expires_at IS NULL
    OR p_checkout_id IS DISTINCT FROM o.provider_checkout_id
    OR p_checkout_expires_at IS DISTINCT FROM o.provider_checkout_expires_at
    OR o.provider_checkout_expires_at + interval '1 minute' > clock_timestamp()
    OR p_attempt_ids IS NULL
    OR EXISTS(SELECT 1 FROM public.tokentracker_cloud_checkout_operations WHERE order_id=o.id AND (finished_at IS NULL OR uncertain))
    OR EXISTS(SELECT 1 FROM public.tokentracker_cloud_payments WHERE order_id=o.id)
    OR EXISTS(SELECT 1 FROM public.tokentracker_cloud_subscriptions WHERE order_id=o.id AND status IN ('pending','active','trialing','past_due','paused','canceling')) THEN
    RETURN to_jsonb(o);
  END IF;
  SELECT array_agg(waffo_order_id ORDER BY waffo_order_id) INTO known FROM public.tokentracker_cloud_waffo_attempts WHERE order_id=o.id;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO given FROM unnest(p_attempt_ids) x;
  IF known IS DISTINCT FROM given THEN RETURN to_jsonb(o); END IF;
  PERFORM public.cloud_tx_mark('order_cancel_finalizing',o.id);
  UPDATE public.tokentracker_cloud_orders SET status='closed' WHERE id=o.id RETURNING * INTO o;
  PERFORM public.cloud_tx_clear('order_cancel_finalizing',o.id);
  RETURN to_jsonb(o);
END;
$fn$;
REVOKE ALL ON FUNCTION public.cloud_begin_checkout_operation(uuid,text,uuid),
 public.cloud_finish_checkout_operation(uuid,text,uuid,uuid,boolean),public.cloud_request_order_cancel(uuid,text,uuid),
 public.cloud_finalize_order_cancel(uuid,text,uuid,text,timestamptz,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_begin_checkout_operation(uuid,text,uuid),
 public.cloud_finish_checkout_operation(uuid,text,uuid,uuid,boolean),public.cloud_request_order_cancel(uuid,text,uuid),
 public.cloud_finalize_order_cancel(uuid,text,uuid,text,timestamptz,text[]) TO project_admin;

CREATE OR REPLACE FUNCTION public.cloud_close_unpaid_order(p_user_id uuid,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE o public.tokentracker_cloud_orders%ROWTYPE;
BEGIN
  SELECT * INTO STRICT o FROM public.tokentracker_cloud_orders WHERE id=p_order_id AND user_id=p_user_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || o.environment,0));
  SELECT * INTO STRICT o FROM public.tokentracker_cloud_orders WHERE id=p_order_id AND user_id=p_user_id FOR UPDATE;
  IF o.cancel_requested_at IS NULL AND o.status IN ('pending','ready') THEN
    UPDATE public.tokentracker_cloud_orders SET status='closed' WHERE id=o.id RETURNING * INTO o;
  END IF;
  RETURN to_jsonb(o);
END;
$fn$;
