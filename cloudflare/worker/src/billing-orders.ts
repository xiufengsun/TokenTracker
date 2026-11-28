import {
  BillingError,
  type CloudOrder,
} from "../../../dashboard/edge-patches/cloud/contracts";
import {
  validateWaffoProduct,
  createWaffoCheckout,
  waffoProductId,
  type WaffoConfig,
} from "../../../dashboard/edge-patches/cloud/waffo";
import type { BillingEnvironment } from "./billing-membership";

type Order = CloudOrder & {
  request_id: string;
  checkout_attempts: number;
  checkout_started: number;
  checkout_claimed_at: string | null;
};
type Txn = {
  stmt(sql: string, ...args: unknown[]): D1PreparedStatement;
  order(id: string): Promise<Order>;
  writes: D1PreparedStatement[];
};

export async function mutateOwner<T>(
  db: D1Database,
  user: string,
  scope: BillingEnvironment,
  fn: (t: Txn) => Promise<T>,
) {
  const s = db.withSession("first-primary");
  const stmt = (sql: string, ...args: unknown[]) =>
    s.prepare(sql).bind(...args);
  for (let turn = 0; turn < 4; turn++) {
    const revision =
      (await stmt(
        "SELECT revision FROM billing_ledger_revision WHERE user_id=? AND environment=?",
        user,
        scope,
      ).first<number>("revision")) ?? 0;
    const writes: D1PreparedStatement[] = [];
    const result = await fn({
      stmt,
      writes,
      async order(id) {
        const row = await stmt(
          "SELECT * FROM tokentracker_cloud_orders WHERE id=? AND user_id=? AND environment=?",
          id,
          user,
          scope,
        ).first<Order>();
        if (!row) throw new BillingError("order_not_found", 404);
        return row;
      },
    });
    if (!writes.length) return result;
    try {
      await s.batch([
        stmt(
          `INSERT INTO billing_ledger_revision VALUES(?,?,1) ON CONFLICT(user_id,environment) DO UPDATE
        SET revision=CASE WHEN revision=? THEN revision+1 ELSE -1 END`,
          user,
          scope,
          revision,
        ),
        ...writes,
      ]);
      return result;
    } catch (e) {
      if (!String(e).includes("billing_revision_match") || turn === 3) throw e;
    }
  }
  throw new BillingError("billing_operation_failed", 503);
}

export async function checkoutGuard(
  t: Txn,
  user: string,
  scope: BillingEnvironment,
  billingMode: string,
  orderId: string,
) {
  if (
    !(await t
      .stmt(
        `SELECT 1 FROM tokentracker_cloud_policy WHERE environment=? AND hosting_mode='hosted' AND phase='active'
     AND julianday(launch_at)<=julianday('now')`,
        scope,
      )
      .first())
  )
    throw new BillingError("checkout_not_launched", 503);
  const guard = await t
    .stmt(
      `SELECT CASE
    WHEN EXISTS(SELECT 1 FROM tokentracker_cloud_orders WHERE user_id=?1 AND environment=?2
      AND retry_payment_conflict_at IS NOT NULL) THEN 'payment_conflict'
    WHEN EXISTS(SELECT 1 FROM tokentracker_cloud_orders WHERE user_id=?1 AND environment=?2
      AND status IN ('pending','ready') AND cancel_requested_at IS NOT NULL) THEN 'order_cancel_processing'
    WHEN EXISTS(SELECT 1 FROM tokentracker_cloud_gift_grants WHERE user_id=?1 AND environment=?2
      AND revoked_at IS NULL AND julianday(ends_at)>julianday('now')) THEN 'gift_membership_active'
    WHEN EXISTS(SELECT 1 FROM tokentracker_cloud_orders WHERE user_id=?1 AND environment=?2 AND id<>?3
       AND (?4='recurring' OR billing_mode='recurring') AND status IN ('pending','ready') AND checkout_attempts>0) THEN 'pending_checkout_exists'
    WHEN EXISTS(SELECT 1 FROM tokentracker_cloud_subscriptions WHERE user_id=?1 AND environment=?2
       AND status IN ('active','trialing','past_due','paused') AND cancel_at_period_end=0) THEN 'subscription_already_exists'
    WHEN ?4='recurring' AND EXISTS(SELECT 1 FROM tokentracker_cloud_payments WHERE user_id=?1 AND environment=?2
       AND refunded_cents<amount_cents AND julianday(ends_at)>julianday('now')) THEN 'fixed_term_still_active'
    WHEN EXISTS(WITH RECURSIVE predecessors(id) AS(SELECT ?3 UNION SELECT o.id FROM tokentracker_cloud_orders o
       JOIN predecessors p ON o.retry_order_id=p.id WHERE o.user_id=?1 AND o.environment=?2)
       SELECT 1 FROM tokentracker_cloud_payments WHERE order_id IN (SELECT id FROM predecessors)) THEN 'checkout_already_paid'
    END AS code`,
      user,
      scope,
      orderId,
      billingMode,
    )
    .first<string>("code");
  if (guard) throw new BillingError(guard, 409);
}

export async function checkout(
  db: D1Database,
  user: string,
  config: WaffoConfig,
  sku: string,
  requestId: string,
  providerFetch: typeof fetch = fetch,
) {
  const scope = config.environment;
  const id = await mutateOwner(db, user, scope, async (t) => {
    const existing = await t
      .stmt(
        "SELECT id,sku,provider FROM tokentracker_cloud_orders WHERE user_id=? AND environment=? AND request_id=?",
        user,
        scope,
        requestId,
      )
      .first();
    if (existing) {
      if (existing.sku !== sku || existing.provider !== "waffo")
        throw new BillingError("checkout_request_conflict", 409);
      return String(existing.id);
    }
    const catalog = await t
      .stmt(
        "SELECT * FROM tokentracker_cloud_catalog WHERE sku=? AND currency='USD' AND active=1",
        sku,
      )
      .first();
    if (!catalog) throw new BillingError("checkout_not_launched", 503);
    const id = crypto.randomUUID();
    await checkoutGuard(t, user, scope, String(catalog.billing_mode), id);
    t.writes.push(
      t.stmt(
        `INSERT INTO tokentracker_cloud_orders(id,user_id,environment,request_id,provider,sku,currency,amount_cents,term_months,
      billing_mode,status,created_at,expires_at) VALUES(?,?,?,?,'waffo',?,?,?,?,?,'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes'))`,
        id,
        user,
        scope,
        requestId,
        sku,
        catalog.currency,
        catalog.amount_cents,
        catalog.term_months,
        catalog.billing_mode,
      ),
    );
    return id;
  });
  const current = await mutateOwner(db, user, scope, (t) => t.order(id));
  if (
    current.status === "closed" ||
    Date.parse(current.expires_at) <= Date.now()
  )
    throw new BillingError("checkout_expired", 409);
  if (!current.provider_price_id)
    await validateWaffoProduct(current, config, providerFetch);
  const price = waffoProductId(current, config);
  const claim = await mutateOwner(db, user, scope, async (t) => {
    const order = await t.order(id);
    if (
      !["pending", "ready"].includes(order.status) ||
      Date.parse(order.expires_at) <= Date.now()
    )
      throw new BillingError("checkout_expired", 409);
    if (order.cancel_requested_at)
      throw new BillingError("order_cancel_processing", 409);
    if (order.provider_price_id && price !== order.provider_price_id)
      throw new BillingError("payment_evidence_conflict", 409);
    await checkoutGuard(t, user, scope, String(order.billing_mode), id);
    if (order.checkout_url) return { order, operation: null };
    const operation = crypto.randomUUID();
    t.writes.push(
      t.stmt(
        "INSERT INTO tokentracker_cloud_checkout_operations(id,order_id) VALUES(?,?)",
        operation,
        id,
      ),
      t.stmt(
        `UPDATE tokentracker_cloud_orders SET provider_price_id=?,checkout_started=1,
       checkout_attempts=max(checkout_attempts,1),checkout_claimed_at=coalesce(checkout_claimed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`,
        price,
        id,
      ),
    );
    return { order: { ...order, provider_price_id: price }, operation };
  });
  if (!claim.operation)
    return {
      status: 200,
      data: {
        order: {
          id,
          status: claim.order.status,
          checkout_url: claim.order.checkout_url,
        },
      },
    };
  let uncertain = true;
  try {
    const receipt = await createWaffoCheckout(
      claim.order,
      config,
      providerFetch,
    );
    const attached = await mutateOwner(db, user, scope, async (t) => {
      const o = await t.order(id);
      if (
        !["pending", "ready"].includes(o.status) ||
        o.provider_price_id !== receipt.priceId ||
        (o.provider_checkout_id &&
          o.provider_checkout_id !== receipt.sessionId) ||
        (o.checkout_url && o.checkout_url !== receipt.checkoutUrl) ||
        (o.provider_checkout_expires_at &&
          Date.parse(o.provider_checkout_expires_at) !==
            Date.parse(receipt.expiresAt))
      ) {
        throw new BillingError("payment_evidence_conflict", 409);
      }
      t.writes.push(
        t.stmt(
          `UPDATE tokentracker_cloud_orders SET provider_checkout_id=?,checkout_url=?,provider_checkout_expires_at=?,
        expires_at=?,status='ready' WHERE id=?`,
          receipt.sessionId,
          receipt.checkoutUrl,
          receipt.expiresAt,
          receipt.expiresAt,
          id,
        ),
      );
      return { id, status: "ready", checkout_url: receipt.checkoutUrl };
    });
    uncertain = false;
    return { status: 200, data: { order: attached } };
  } catch {
    return {
      status: 202,
      data: {
        order: { id, status: claim.order.status },
        pending: true,
        error: "checkout_confirmation_pending",
      },
    };
  } finally {
    await mutateOwner(db, user, scope, async (t) => {
      t.writes.push(
        t.stmt(
          `UPDATE tokentracker_cloud_checkout_operations
        SET finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),uncertain=? WHERE order_id=? AND id=? AND finished_at IS NULL`,
          uncertain ? 1 : 0,
          id,
          claim.operation,
        ),
      );
    });
  }
}
