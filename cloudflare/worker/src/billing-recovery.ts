import {
  BillingError,
  type CloudOrder,
} from "../../../dashboard/edge-patches/cloud/contracts";
import {
  closeUnpaidWaffoAttempts,
  confirmedCancelledWaffoAttempts,
  queryWaffoBindings,
  type WaffoConfig,
} from "../../../dashboard/edge-patches/cloud/waffo";
import { reconcileWaffoLedger } from "../../../dashboard/edge-patches/cloud/waffo-reconciliation";
import { mutateOwner, checkoutGuard as checkPurchase } from "./billing-orders";
import { waffoLedger } from "./billing-ledger";

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const unresolvedStates = "('pending','ready')";

export async function cancelPending(
  db: D1Database,
  user: string,
  config: WaffoConfig,
  id: string,
) {
  const scope = config.environment;
  const owned = () => mutateOwner(db, user, scope, (t) => t.order(id));
  await mutateOwner(db, user, scope, async (t) => {
    const order = await t.order(id);
    if (order.provider !== "waffo" || order.retry_order_id)
      throw new BillingError("order_cancel_unavailable", 409);
    if (!["pending", "ready"].includes(order.status)) return;
    t.writes.push(
      t.stmt(
        `UPDATE tokentracker_cloud_orders SET cancel_requested_at=coalesce(cancel_requested_at,${nowSql})
      WHERE id=?`,
        id,
      ),
      t.stmt(
        `UPDATE tokentracker_cloud_orders SET status='closed' WHERE id=?1 AND checkout_attempts=0
      AND checkout_started=0 AND checkout_tracking_uncertain=0 AND checkout_url IS NULL AND provider_checkout_id IS NULL
      AND provider_order_id IS NULL AND waffo_order_id IS NULL AND NOT EXISTS(SELECT 1 FROM tokentracker_cloud_checkout_operations WHERE order_id=?1)
      AND NOT EXISTS(SELECT 1 FROM tokentracker_cloud_waffo_attempts WHERE order_id=?1)
      AND NOT EXISTS(SELECT 1 FROM tokentracker_cloud_payments WHERE order_id=?1)
      AND NOT EXISTS(SELECT 1 FROM tokentracker_cloud_subscriptions WHERE order_id=?1)`,
        id,
      ),
    );
  });
  let current = await owned(),
    verificationPending = false;
  if (
    current.cancel_requested_at &&
    ["pending", "ready"].includes(current.status)
  ) {
    try {
      await reconcileWaffoLedger(waffoLedger(db, current), current, config);
      current = await owned();
      if (["pending", "ready"].includes(current.status)) {
        const attempts = await confirmedCancelledWaffoAttempts(current, config);
        if (attempts !== null)
          await mutateOwner(db, user, scope, async (t) => {
            t.writes.push(
              t.stmt(
                `UPDATE tokentracker_cloud_orders SET status='closed' WHERE id=?1 AND status IN ${unresolvedStates}
            AND cancel_requested_at IS NOT NULL AND provider='waffo' AND checkout_tracking_uncertain=0
            AND retry_order_id IS NULL AND retry_payment_conflict_at IS NULL AND provider_order_id IS NULL AND waffo_order_id IS NULL
            AND provider_checkout_id=?2 AND provider_checkout_expires_at=?3 AND julianday(provider_checkout_expires_at,'+1 minute')<=julianday('now')
            AND NOT EXISTS(SELECT 1 FROM tokentracker_cloud_checkout_operations WHERE order_id=?1 AND (finished_at IS NULL OR uncertain=1))
            AND NOT EXISTS(SELECT 1 FROM tokentracker_cloud_payments WHERE order_id=?1)
            AND NOT EXISTS(SELECT 1 FROM tokentracker_cloud_subscriptions WHERE order_id=?1 AND status IN ('pending','active','trialing','past_due','paused','canceling'))
            AND NOT EXISTS(SELECT waffo_order_id FROM tokentracker_cloud_waffo_attempts WHERE order_id=?1 EXCEPT SELECT value FROM json_each(?4))
            AND NOT EXISTS(SELECT value FROM json_each(?4) EXCEPT SELECT waffo_order_id FROM tokentracker_cloud_waffo_attempts WHERE order_id=?1)`,
                id,
                current.provider_checkout_id,
                current.provider_checkout_expires_at,
                JSON.stringify(attempts),
              ),
            );
          });
      }
    } catch {
      verificationPending = true;
    }
    current = await owned();
  }
  const processing =
    !!current.cancel_requested_at &&
    ["pending", "ready"].includes(current.status);
  return {
    status: processing ? 202 : 200,
    data: {
      order: {
        id,
        status: current.status,
        cancel_requested_at: current.cancel_requested_at,
      },
      cancellation: processing
        ? "processing"
        : current.status === "closed"
          ? "cancelled"
          : "not_cancelled",
      verification_pending: verificationPending,
    },
  };
}

export async function restartOrder(
  db: D1Database,
  user: string,
  config: WaffoConfig,
  id: string,
  requestId: string,
  providerFetch: typeof fetch = fetch,
) {
  const scope = config.environment;
  let old = await mutateOwner(db, user, scope, (t) => t.order(id));
  if (old.cancel_requested_at)
    throw new BillingError("order_cancel_processing", 409);
  if (!old.retry_order_id) {
    if (old.status === "paid" || old.provider_order_id)
      throw new BillingError("checkout_already_paid", 409);
    const ledger = waffoLedger(db, old);
    for (const binding of await queryWaffoBindings(old, config, providerFetch))
      await ledger.call("cloud_register_waffo_attempt", {
        p_order_id: id,
        p_environment: scope,
        p_waffo_order_id: binding.waffo_order_id,
        p_provider_price_id: binding.provider_price_id,
        p_billing_mode: old.billing_mode,
      });
    const attempts = await closeUnpaidWaffoAttempts(old, config, providerFetch);
    await reconcileWaffoLedger(ledger, old, config, undefined, providerFetch);
    await mutateOwner(db, user, scope, async (t) => {
      const o = await t.order(id);
      if (o.cancel_requested_at)
        throw new BillingError("order_cancel_processing", 409);
      if (o.retry_order_id) return;
      const pending = () =>
        new BillingError("checkout_confirmation_pending", 409);
      if (
        o.provider !== "waffo" ||
        !["ready", "pending", "closed"].includes(o.status) ||
        o.provider_order_id
      )
        throw pending();
      if (attempts.length === 0) {
        const neverStarted =
          !o.checkout_attempts && !o.provider_checkout_id && !o.checkout_url;
        const expiry = o.provider_checkout_expires_at
          ? Date.parse(o.provider_checkout_expires_at)
          : Date.parse(o.expires_at) + 1800000;
        if (
          o.waffo_order_id ||
          Date.parse(o.expires_at) > Date.now() ||
          !!o.provider_checkout_id !== !!o.checkout_url ||
          (!neverStarted &&
            (!o.checkout_claimed_at || expiry + 60000 > Date.now()))
        )
          throw pending();
      }
      const known = await t
        .stmt(
          "SELECT waffo_order_id,provider_price_id,billing_mode FROM tokentracker_cloud_waffo_attempts WHERE order_id=? AND environment=?",
          id,
          scope,
        )
        .all();
      if (
        known.results.length !== attempts.length ||
        known.results.some(
          (v) =>
            v.billing_mode !== o.billing_mode ||
            v.provider_price_id !== o.provider_price_id ||
            !attempts.includes(String(v.waffo_order_id)),
        )
      )
        throw pending();
      if (
        await t
          .stmt(
            `WITH RECURSIVE predecessors(id) AS (SELECT ?1 UNION SELECT x.id FROM tokentracker_cloud_orders x
        JOIN predecessors p ON x.retry_order_id=p.id WHERE x.user_id=?2 AND x.environment=?3)
        SELECT 1 FROM tokentracker_cloud_payments WHERE order_id IN (SELECT id FROM predecessors)`,
            id,
            user,
            scope,
          )
          .first()
      )
        throw new BillingError("checkout_already_paid", 409);
      if (
        await t
          .stmt(
            "SELECT 1 FROM tokentracker_cloud_orders WHERE user_id=? AND environment=? AND request_id=?",
            user,
            scope,
            requestId,
          )
          .first()
      )
        throw new BillingError("checkout_request_conflict", 409);
      // Re-evaluate the same purchase guards inside this account revision before linking the successor.
      await checkRestartGuard(t, user, scope, o);
      const next = crypto.randomUUID();
      t.writes.push(
        t.stmt(
          `INSERT INTO tokentracker_cloud_orders(id,user_id,environment,request_id,provider,sku,currency,amount_cents,term_months,
        billing_mode,status,created_at,expires_at) SELECT ?,?,?,?,'waffo',sku,currency,amount_cents,term_months,billing_mode,'pending',
        ${nowSql},strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes') FROM tokentracker_cloud_catalog WHERE sku=? AND active=1`,
          next,
          user,
          scope,
          requestId,
          o.sku,
        ),
        t.stmt(
          "UPDATE tokentracker_cloud_orders SET status='closed',retry_order_id=? WHERE id=?",
          next,
          id,
        ),
      );
    });
    old = await mutateOwner(db, user, scope, (t) => t.order(id));
  }
  const visited = new Set<string>();
  while (old.retry_order_id) {
    if (visited.has(old.id))
      throw new BillingError("payment_evidence_conflict", 409);
    visited.add(old.id);
    const next = old.retry_order_id;
    old = await mutateOwner(db, user, scope, (t) => t.order(next));
  }
  return old;
}

async function checkRestartGuard(
  t: Parameters<typeof checkPurchase>[0],
  user: string,
  scope: WaffoConfig["environment"],
  o: CloudOrder,
) {
  await checkPurchase(t, user, scope, String(o.billing_mode), o.id);
  if (
    !(await t
      .stmt(
        "SELECT 1 FROM tokentracker_cloud_catalog WHERE active=1 AND sku=?",
        o.sku,
      )
      .first())
  )
    throw new BillingError("checkout_not_launched", 503);
}
