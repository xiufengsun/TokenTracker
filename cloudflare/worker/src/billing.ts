import {
  BillingError,
  object,
  text,
  uuid,
  type CloudOrder,
} from "../../../dashboard/edge-patches/cloud/contracts";
import {
  cancelWaffoSubscription,
  verifyWaffoWebhook,
  type WaffoConfig,
} from "../../../dashboard/edge-patches/cloud/waffo";
import { reconcileWaffoLedger } from "../../../dashboard/edge-patches/cloud/waffo-reconciliation";
import { dispatchBillingDevices } from "./devices";
import { getAccountId } from "./auth";
import { waffoLedger } from "./billing-ledger";
import { claimGift } from "./billing-gifts";
import { cancelPending, restartOrder } from "./billing-recovery";
import { checkout, mutateOwner } from "./billing-orders";
import { readMembership } from "./billing-membership";

type BillingBindings = Env &
  Partial<
    Record<
      | "TOKENTRACKER_BILLING_ENVIRONMENT"
      | "WAFFO_PRIVATE_KEY"
      | "WAFFO_MERCHANT_ID"
      | "WAFFO_STORE_ID"
      | "WAFFO_LIVE_PRIVATE_KEY_SHA256"
      | "WAFFO_CLOUD_MONTHLY_PRODUCT_ID"
      | "WAFFO_CLOUD_YEARLY_PRODUCT_ID"
      | "WAFFO_CLOUD_MONTHLY_PASS_PRODUCT_ID"
      | "WAFFO_CLOUD_YEARLY_PASS_PRODUCT_ID"
      | "TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED",
      string
    >
  >;

function waffoConfig(env: BillingBindings): WaffoConfig {
  const environment = env.TOKENTRACKER_BILLING_ENVIRONMENT;
  if (environment !== "sandbox" && environment !== "live")
    throw new BillingError("billing_configuration_invalid", 503);
  return {
    environment,
    merchantId: env.WAFFO_MERCHANT_ID || "",
    storeId: env.WAFFO_STORE_ID || "",
    privateKey: env.WAFFO_PRIVATE_KEY || "",
    livePrivateKeySha256: env.WAFFO_LIVE_PRIVATE_KEY_SHA256,
    checkoutPage: "https://www.tokentracker.cc/billing/checkout",
    productIds: {
      cloud_usd_monthly: env.WAFFO_CLOUD_MONTHLY_PRODUCT_ID || "",
      cloud_usd_yearly: env.WAFFO_CLOUD_YEARLY_PRODUCT_ID || "",
      cloud_usd_monthly_fixed: env.WAFFO_CLOUD_MONTHLY_PASS_PRODUCT_ID || "",
      cloud_usd_yearly_fixed: env.WAFFO_CLOUD_YEARLY_PASS_PRODUCT_ID || "",
    },
  };
}
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Cache-Control": "no-store",
};
const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers });
const events = new Set([
  "order.completed",
  "subscription.activated",
  "subscription.payment_succeeded",
  "subscription.renewed",
  "subscription.recovered",
  "subscription.canceling",
  "subscription.uncanceled",
  "subscription.canceled",
  "subscription.past_due",
  "refund.succeeded",
  "refund.failed",
  "subscription.plan_changed",
]);

async function readBody(req: Request, limit: number) {
  if (Number(req.headers.get("Content-Length") || 0) > limit)
    throw new BillingError("request_too_large", 413);
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > limit)
    throw new BillingError("request_too_large", 413);
  return raw;
}
export async function receiveWaffoWebhook(
  req: Request,
  db: D1Database,
  config: WaffoConfig,
  providerFetch: typeof fetch = fetch,
) {
  if (req.method !== "POST") throw new BillingError("method_not_allowed", 405);
  if (!config.storeId) throw new BillingError("waffo_not_configured", 503);
  const notification = verifyWaffoWebhook(
    await readBody(req, 262144),
    req.headers.get("x-waffo-signature"),
    config,
  );
  if (!events.has(notification.eventType))
    return reply({ received: true, ignored: true });
  const data = object(notification.data);
  if (!data.orderMerchantExternalId)
    return reply({ received: true, ignored: true });
  const row = await db
    .prepare(
      "SELECT * FROM tokentracker_cloud_orders WHERE id=? AND provider='waffo' AND environment=?",
    )
    .bind(uuid(data.orderMerchantExternalId), config.environment)
    .first<CloudOrder>();
  if (!row) throw new BillingError("order_not_found", 404);
  await reconcileWaffoLedger(
    waffoLedger(db, row),
    row,
    config,
    notification as unknown as Record<string, unknown>,
    providerFetch,
  );
  return reply({ received: true });
}

export async function dispatchBilling(
  req: Request,
  env: BillingBindings,
): Promise<Response | null> {
  const url = new URL(req.url);
  const slug = url.pathname.replace(/^\/(?:functions\/)?/, "");
  if (slug !== "tokentracker-waffo-webhook" && slug !== "tokentracker-billing")
    return null;
  try {
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    const config = waffoConfig(env),
      scope = config.environment,
      db = env.DB;
    if (slug === "tokentracker-waffo-webhook")
      return await receiveWaffoWebhook(req, db, config);
    if (!["GET", "POST"].includes(req.method))
      throw new BillingError("method_not_allowed", 405);
    const action = url.searchParams.get("action") || "account";
    const configured = Boolean(
      config.merchantId &&
      config.storeId &&
      config.privateKey &&
      Object.values(config.productIds).every(Boolean) &&
      (scope !== "live" ||
        /^[a-f\d]{64}$/i.test(config.livePrivateKeySha256 || "")),
    );
    if (action === "catalog" && req.method === "GET") {
      const [policy, prices] = await db.batch<Record<string, unknown>>([
        db
          .prepare(
            "SELECT phase,launch_at,hosting_mode FROM tokentracker_cloud_policy WHERE environment=?",
          )
          .bind(scope),
        db.prepare(
          "SELECT sku,currency,amount_cents,term_months,billing_mode FROM tokentracker_cloud_catalog WHERE active=1",
        ),
      ]);
      const p = policy.results[0];
      if (!p) throw new BillingError("billing_configuration_invalid", 503);
      return reply({
        environment: scope,
        policy: p,
        prices: prices.results,
        providers: {
          waffo: configured,
          paddle: false,
          wechat: false,
          alipay: false,
        },
        paddle_client_token: null,
        checkout_verified:
          scope === "live" &&
          configured &&
          p.phase === "active" &&
          Date.parse(String(p.launch_at)) <= Date.now() &&
          env.TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED === "true",
        limits: {
          machines: 99,
          sync_minutes: 15,
          hourly_history_days: 90,
          daily_history_months: 24,
          trial_days: 7,
        },
      });
    }
    const user = await getAccountId(req, env);
    if (!user) throw new BillingError("unauthorized", 401);
    const st = (sql: string, ...params: unknown[]) =>
      db.prepare(sql).bind(...params);
    const account = () => readMembership(db, user, scope);
    const owned = (id: string) =>
      mutateOwner(db, user, scope, (t) => t.order(id));
    const boolOrders = (rows: Record<string, unknown>[]) =>
      rows.map((o) => ({
        ...o,
        checkout_tracking_uncertain: !!o.checkout_tracking_uncertain,
      }));
    if (req.method === "GET" && action === "devices")
      return await dispatchBillingDevices(db, user, scope, action, {
        current_machine_id: url.searchParams.get("current_machine_id"),
      });
    if (req.method === "GET" && action === "account") {
      const [payments, subs, pending, conflicts, gifts, restrictions] =
        await db.batch<Record<string, unknown>>([
          st(
            `SELECT id,provider,currency,amount_cents,refunded_cents,starts_at,ends_at,paid_at FROM tokentracker_cloud_payments
          WHERE user_id=? AND environment=? ORDER BY julianday(paid_at) DESC LIMIT 20`,
            user,
            scope,
          ),
          st(
            "SELECT provider,provider_subscription_id,status,cancel_at_period_end,next_billed_at FROM tokentracker_cloud_subscriptions WHERE user_id=? AND environment=?",
            user,
            scope,
          ),
          st(
            `SELECT id,provider,sku,currency,amount_cents,billing_mode,status,created_at,expires_at,checkout_url,
           retry_payment_conflict_at,cancel_requested_at,checkout_tracking_uncertain FROM tokentracker_cloud_orders WHERE user_id=? AND environment=?
           AND status IN ('pending','ready') ORDER BY julianday(created_at) DESC LIMIT 10`,
            user,
            scope,
          ),
          st(
            `SELECT id,provider,sku,currency,amount_cents,billing_mode,status,retry_payment_conflict_at FROM tokentracker_cloud_orders WHERE user_id=?
          AND environment=? AND retry_payment_conflict_at IS NOT NULL ORDER BY julianday(created_at) DESC LIMIT 20`,
            user,
            scope,
          ),
          st(
            `SELECT id,duration_days,redeemed_at,starts_at,ends_at,revoked_at,CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
          WHEN julianday(starts_at)>julianday('now') THEN 'pending' WHEN julianday(ends_at)<=julianday('now') THEN 'expired'
          ELSE 'active' END AS state FROM tokentracker_cloud_gift_grants WHERE user_id=? AND environment=? ORDER BY julianday(redeemed_at) DESC,id DESC LIMIT 20`,
            user,
            scope,
          ),
          st(
            `SELECT phase='active' AND julianday(launch_at)<=julianday('now') AS available,
          CASE WHEN EXISTS(SELECT 1 FROM tokentracker_cloud_subscriptions WHERE user_id=?1 AND environment=?2 AND status IN
            ('pending','active','trialing','past_due','paused') AND cancel_at_period_end=0) THEN 'gift_requires_renewal_cancel'
          WHEN EXISTS(SELECT 1 FROM tokentracker_cloud_orders WHERE user_id=?1 AND environment=?2 AND status IN ('pending','ready')) THEN 'gift_checkout_pending' END AS restriction
          FROM tokentracker_cloud_policy WHERE environment=?2`,
            user,
            scope,
          ),
        ]);
      const machineCount = await st(
        "SELECT count(*) AS n FROM tokentracker_cloud_machines WHERE user_id=? AND environment=? AND status='active'",
        user,
        scope,
      )
        .first<number>("n")
        .catch(() => null);
      return reply({
        environment: scope,
        membership: await account(),
        ...(machineCount === null ? {} : { machine_count: machineCount }),
        payments: payments.results,
        subscriptions: subs.results.map((v) => ({
          ...v,
          cancel_at_period_end: !!v.cancel_at_period_end,
        })),
        pending_orders: boolOrders(pending.results),
        conflict_orders: conflicts.results,
        gifts: gifts.results,
        gift_redemption_available: !!restrictions.results[0]?.available,
        redemption_restriction: restrictions.results[0]?.restriction ?? null,
      });
    }
    if (req.method === "GET" && action === "order") {
      const row = await owned(uuid(url.searchParams.get("id")));
      const payment =
        row.provider_order_id &&
        (await st(
          `SELECT amount_cents,refunded_cents FROM tokentracker_cloud_payments WHERE order_id=?
        AND user_id=? AND environment=? AND transaction_id=?`,
          row.id,
          user,
          scope,
          row.provider_order_id,
        ).first());
      const order = {
        id: row.id,
        provider: row.provider,
        sku: row.sku,
        currency: row.currency,
        amount_cents: row.amount_cents,
        billing_mode: row.billing_mode,
        status: row.status,
        checkout_url: row.checkout_url,
        expires_at: row.expires_at,
        retry_payment_conflict_at: row.retry_payment_conflict_at,
        cancel_requested_at: row.cancel_requested_at,
        checkout_tracking_uncertain: !!row.checkout_tracking_uncertain,
        payment_state: payment
          ? payment.refunded_cents === payment.amount_cents
            ? "refunded"
            : Number(payment.refunded_cents) > 0
              ? "partially_refunded"
              : "paid"
          : "unpaid",
      };
      return reply({ order, membership: await account() });
    }
    if (req.method === "POST" && action === "trial") {
      await mutateOwner(db, user, scope, async (t) => {
        const m = await readMembership(db, user, scope);
        if (
          !(await t
            .stmt(
              "SELECT 1 FROM tokentracker_cloud_policy WHERE environment=? AND phase='active' AND julianday(launch_at)<=julianday('now')",
              scope,
            )
            .first())
        )
          throw new BillingError("trial_not_launched", 409);
        if (
          await t
            .stmt(
              "SELECT 1 FROM tokentracker_cloud_gift_grants WHERE user_id=? AND environment=? UNION ALL SELECT 1 FROM tokentracker_cloud_payments WHERE user_id=? AND environment=? LIMIT 1",
              user,
              scope,
              user,
              scope,
            )
            .first()
        )
          throw new BillingError("trial_unavailable", 409);
        if (!m.trial_ends_at)
          t.writes.push(
            t.stmt(
              `INSERT INTO tokentracker_cloud_accounts VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days'))
          ON CONFLICT(user_id,environment) DO UPDATE SET trial_started_at=excluded.trial_started_at,trial_ends_at=excluded.trial_ends_at WHERE trial_started_at IS NULL`,
              user,
              scope,
            ),
          );
      });
      return reply({ membership: await account() });
    }
    if (req.method === "POST") {
      let body: Record<string, unknown>;
      const raw = await readBody(req, 16384);
      try {
        body = object(JSON.parse(raw));
      } catch {
        throw new BillingError("invalid_request", 400);
      }
      if (action === "remove-device" || action === "resume-device")
        return await dispatchBillingDevices(db, user, scope, action, body);
      if (action === "redeem-gift") {
        const result = await claimGift(
          db,
          user,
          config,
          body.code,
          uuid(body.request_id),
        );
        const response = reply(result.data, result.status);
        if (result.retry)
          response.headers.set("Retry-After", String(result.retry));
        return response;
      }
      if (action === "checkout") {
        if (body.provider !== "waffo" || !configured)
          throw new BillingError("payment_provider_not_configured", 503);
        const result = await checkout(
          db,
          user,
          config,
          text(body.sku),
          uuid(body.request_id),
        );
        return reply(result.data, result.status);
      }
      if (action === "cancel-order") {
        const result = await cancelPending(db, user, config, uuid(body.id));
        return reply(result.data, result.status);
      }
      if (action === "restart-checkout") {
        if (!configured)
          throw new BillingError("payment_provider_not_configured", 503);
        // Check launch and pending cancellations before making any provider request.
        if (
          !(await st(
            "SELECT 1 FROM tokentracker_cloud_policy WHERE environment=? AND phase='active' AND julianday(launch_at)<=julianday('now')",
            scope,
          ).first())
        )
          throw new BillingError("checkout_not_launched", 503);
        if (
          await st(
            "SELECT 1 FROM tokentracker_cloud_orders WHERE user_id=? AND environment=? AND status IN ('pending','ready') AND cancel_requested_at IS NOT NULL",
            user,
            scope,
          ).first()
        )
          throw new BillingError("order_cancel_processing", 409);
        const next = await restartOrder(
          db,
          user,
          config,
          uuid(body.id),
          uuid(body.request_id),
        );
        if (
          !["pending", "ready"].includes(next.status) ||
          Date.parse(next.expires_at) <= Date.now()
        ) {
          url.searchParams.set("action", "order");
          url.searchParams.set("id", next.id);
          return await dispatchBilling(
            new Request(url, { headers: req.headers }),
            env,
          );
        }
        const result = await checkout(
          db,
          user,
          config,
          next.sku,
          next.request_id,
        );
        return reply(result.data, result.status);
      }
      if (action === "reconcile") {
        const order = await owned(uuid(body.id));
        if (order.provider !== "waffo" || !configured)
          throw new BillingError("payment_provider_not_configured", 503);
        const claim = await st(
          `UPDATE tokentracker_cloud_orders SET last_reconciled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND user_id=? AND environment=? AND (last_reconciled_at IS NULL OR julianday(last_reconciled_at)<=julianday('now','-30 seconds')) RETURNING id`,
          order.id,
          user,
          scope,
        ).first();
        if (!claim) {
          const r = reply(
            { error: "reconciliation_rate_limited", retry_after: 30 },
            429,
          );
          r.headers.set("Retry-After", "30");
          return r;
        }
        const confirmed = await reconcileWaffoLedger(
          waffoLedger(db, order),
          order,
          config,
        );
        return reply({ confirmed, membership: await account() });
      }
      if (action === "portal" || action === "cancel") {
        const portal = "https://pancake.waffo.ai/consumer/portal/login";
        if (action === "portal" && !body.subscription_id) {
          if (
            !(await st(
              "SELECT 1 FROM tokentracker_cloud_payments WHERE provider='waffo' AND user_id=? AND environment=? LIMIT 1",
              user,
              scope,
            ).first())
          )
            throw new BillingError("order_not_found", 404);
          return reply({ url: portal });
        }
        const id = text(body.subscription_id);
        const sub = await st(
          "SELECT order_id FROM tokentracker_cloud_subscriptions WHERE provider='waffo' AND user_id=? AND environment=? AND provider_subscription_id=?",
          user,
          scope,
          id,
        ).first<string>("order_id");
        if (!sub) throw new BillingError("subscription_not_found", 404);
        if (action === "portal") return reply({ url: portal });
        if (!configured)
          throw new BillingError("payment_provider_not_configured", 503);
        const order = await owned(sub);
        await cancelWaffoSubscription(order, id, config);
        await reconcileWaffoLedger(waffoLedger(db, order), order, config);
        return reply({ membership: await account() });
      }
    }
    throw new BillingError("action_not_found", 404);
  } catch (error) {
    return error instanceof BillingError
      ? reply({ error: error.code }, error.status)
      : reply({ error: "billing_operation_failed" }, 503);
  }
}
