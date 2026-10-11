import { cancelWaffoSubscription, closeUnpaidWaffoAttempts, queryWaffoBindings, createWaffoCheckout, validateWaffoProduct, waffoProductId } from "./cloud/waffo.ts";
import { reconcileWaffoOrder } from "./cloud/waffo-processing.ts";
import { giftAccount, redeemGift } from "./cloud/gifts.ts";
import {
  BillingError,
  type CloudOrder,
  object,
  text,
  uuid,
} from "./cloud/contracts.ts";
import {
  cancelPaddleSubscription,
  createPaddlePortal,
  normalizePaddleEvent,
  queryPaddleOrder,
} from "./cloud/paddle.ts";
import { queryWechatOrder } from "./cloud/wechat.ts";
import {
  alipayConfig,
  billingClient,
  billingEnvironment,
  body,
  configuredProviders,
  failure,
  json,
  paddleConfig,
  preflight,
  rpc,
  signedInUser,
  wechatConfig,
  waffoConfig,
  waffoCheckoutVerified,
} from "./cloud/runtime.ts";

export default async function billing(req: Request): Promise<Response> {
  const options = preflight(req);
  if (options) return options;
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      throw new BillingError("method_not_allowed", 405);
    }
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "account";
    const client = billingClient();
    const environment = billingEnvironment();
    if (action === "catalog" && req.method === "GET") {
      const [catalog, policy] = await Promise.all([
        client.database.from("tokentracker_cloud_catalog").select(
          "sku,currency,amount_cents,term_months,billing_mode",
        ).eq("active", true),
        client.database.from("tokentracker_cloud_policy").select(
          "phase,launch_at,hosting_mode",
        ).eq("environment", environment).single(),
      ]);
      if (catalog.error || policy.error) {
        throw new BillingError("billing_operation_failed", 503);
      }
      const selfHosted = object(policy.data).hosting_mode === "self_hosted";
      const providers = selfHosted ? { waffo: false, paddle: false, wechat: false, alipay: false } : configuredProviders();
      return json({
        environment,
        policy: policy.data,
        prices: selfHosted ? [] : catalog.data,
        providers,
        checkout_verified: waffoCheckoutVerified(object(policy.data), providers.waffo),
        paddle_client_token: providers.paddle
          ? Deno.env.get("PADDLE_CLIENT_TOKEN")
          : null,
        limits: {
          machines: selfHosted ? null : 99,
          sync_minutes: selfHosted ? 0 : 15,
          hourly_history_days: selfHosted ? null : 90,
          daily_history_months: selfHosted ? null : 24,
          trial_days: selfHosted ? 0 : 7,
        },
      });
    }
    const userId = await signedInUser(req);
    async function checkoutPolicy() {
      const result = await client.database.from("tokentracker_cloud_policy").select("phase,launch_at,hosting_mode")
        .eq("environment", environment).single();
      const policy = result.error ? {} : object(result.data);
      if (policy.hosting_mode === "self_hosted") throw new BillingError("self_hosted_free", 409);
      const launch = Date.parse(String(policy.launch_at));
      if (result.error || policy.phase !== "active" || !Number.isFinite(launch) || launch > Date.now()) {
        throw new BillingError("checkout_not_launched", 503);
      }
    }
    async function ownedOrder(id: string): Promise<CloudOrder> {
      const result = await client.database.from("tokentracker_cloud_orders")
        .select("*")
        .eq("id", id).eq("user_id", userId).eq("environment", environment)
        .maybeSingle();
      if (result.error) throw new BillingError("billing_operation_failed", 503);
      if (!result.data) throw new BillingError("order_not_found", 404);
      return object(result.data) as unknown as CloudOrder;
    }
    if (action === "account" && req.method === "GET") {
      const [membership, payments, subscriptions, orders, conflicts, gifts] = await Promise.all([
        rpc(client, "cloud_membership", {
          p_user_id: userId,
          p_environment: environment,
        }),
        client.database.from("tokentracker_cloud_payments")
          .select(
            "id,provider,currency,amount_cents,refunded_cents,starts_at,ends_at,paid_at",
          )
          .eq("user_id", userId).eq("environment", environment).order(
            "paid_at",
            { ascending: false },
          ).limit(20),
        client.database.from("tokentracker_cloud_subscriptions")
          .select("provider,provider_subscription_id,status,cancel_at_period_end,next_billed_at")
          .eq("user_id", userId).eq("environment", environment),
        client.database.from("tokentracker_cloud_orders")
          .select(
            "id,provider,sku,currency,amount_cents,billing_mode,status,created_at,expires_at,checkout_url,retry_payment_conflict_at",
          )
          .eq("user_id", userId).eq("environment", environment).in("status", [
            "pending",
            "ready",
          ])
          .order("created_at", { ascending: false }).limit(10),
        client.database.from("tokentracker_cloud_orders")
          .select("id,provider,sku,currency,amount_cents,billing_mode,status,retry_payment_conflict_at")
          .eq("user_id", userId).eq("environment", environment)
          .not("retry_payment_conflict_at", "is", null)
          .order("created_at", { ascending: false }).limit(20),
        giftAccount(client, userId, environment),
      ]);
      if (payments.error || subscriptions.error || orders.error || conflicts.error) {
        throw new BillingError("billing_operation_failed", 503);
      }
      return json({
        environment,
        membership,
        payments: payments.data,
        subscriptions: subscriptions.data,
        pending_orders: orders.data,
        conflict_orders: conflicts.data,
        ...gifts,
      });
    }
    if (action === "redeem-gift" && req.method === "POST") {
      const input = await body(req);
      const result = await redeemGift(client, userId, environment, input.code, uuid(input.request_id));
      const response = json(result.data, result.status);
      if (result.status === 429) response.headers.set("Retry-After", String(object(result.data).retry_after || 900));
      return response;
    }
    if (action === "trial" && req.method === "POST") {
      return json({
        membership: await rpc(client, "cloud_start_trial", {
          p_user_id: userId,
          p_environment: environment,
        }),
      });
    }
    if (action === "devices" && req.method === "GET") {
      return json(
        await rpc(client, "cloud_list_machines", {
          p_user_id: userId,
          p_environment: environment,
          p_current_machine_id: url.searchParams.get("current_machine_id"),
        }),
      );
    }
    if (
      (action === "remove-device" || action === "resume-device") &&
      req.method === "POST"
    ) {
      const input = await body(req);
      const result = await rpc(
        client,
        action === "remove-device"
          ? "cloud_remove_machine"
          : "cloud_resume_machine",
        {
          p_user_id: userId,
          p_environment: environment,
          p_machine_id: uuid(input.machine_id),
        },
      );
      if (result.ok === false) {
        return json({
          error: result.code,
          membership: result.membership,
          recovery_url: result.recovery_url,
        }, Number(result.status) || 409);
      }
      return json(result);
    }
    if (action === "order" && req.method === "GET") {
      const id = uuid(url.searchParams.get("id"));
      const result = await client.database.from("tokentracker_cloud_orders")
        .select(
          "id,provider,sku,currency,amount_cents,billing_mode,status,checkout_url,expires_at,provider_order_id,retry_payment_conflict_at",
        )
        .eq("id", id).eq("user_id", userId).eq("environment", environment)
        .maybeSingle();
      if (result.error) throw new BillingError("billing_operation_failed", 503);
      if (!result.data) throw new BillingError("order_not_found", 404);
      const { provider_order_id, ...order } = object(result.data);
      let paymentState = "unpaid";
      if (provider_order_id) {
        const payment = await client.database.from(
          "tokentracker_cloud_payments",
        ).select("amount_cents,refunded_cents")
          .eq("order_id", id).eq("user_id", userId).eq(
            "environment",
            environment,
          ).eq("transaction_id", provider_order_id).maybeSingle();
        if (payment.error) {
          throw new BillingError("billing_operation_failed", 503);
        }
        if (payment.data) {
          const amount = object(payment.data);
          paymentState = amount.refunded_cents === amount.amount_cents
            ? "refunded"
            : Number(amount.refunded_cents) > 0
            ? "partially_refunded"
            : "paid";
        }
      }
      return json({
        order: { ...order, payment_state: paymentState },
        membership: await rpc(client, "cloud_membership", {
          p_user_id: userId,
          p_environment: environment,
        }),
      });
    }
    if (action === "restart-checkout" && req.method === "POST") {
      await checkoutPolicy();
      const input = await body(req);
      const requestId = uuid(input.request_id);
      const old = await ownedOrder(uuid(input.id));
      if (old.provider !== "waffo" || !configuredProviders().waffo) {
        throw new BillingError("payment_provider_not_configured", 503);
      }
      let next: CloudOrder;
      if (old.retry_order_id) {
        next = await ownedOrder(old.retry_order_id);
      } else {
        if (old.status === "paid" || old.provider_order_id) throw new BillingError("checkout_already_paid", 409);
        const attempts = await queryWaffoBindings(old, waffoConfig());
        for (const attempt of attempts) await rpc(client, "cloud_register_waffo_attempt", {
          p_order_id: old.id, p_environment: environment,
          p_waffo_order_id: attempt.waffo_order_id, p_provider_price_id: attempt.provider_price_id,
          p_billing_mode: old.billing_mode,
        });
        const providerOrderIds = await closeUnpaidWaffoAttempts(old, waffoConfig());
        await reconcileWaffoOrder(client, old, waffoConfig());
        const restarted = await rpc(client, "cloud_restart_waffo_attempts", {
          p_user_id: userId, p_environment: environment, p_order_id: old.id,
          p_request_id: requestId, p_waffo_order_ids: providerOrderIds,
        });
        next = object(restarted.order) as unknown as CloudOrder;
      }
      if (!['pending', 'ready'].includes(next.status)) {
        return json({ order: { id: next.id, status: next.status } });
      }
      const target = new URL(req.url);
      target.searchParams.set("action", "checkout");
      return await billing(new Request(target, { method: "POST", headers: req.headers,
        body: JSON.stringify({ provider: "waffo", sku: next.sku, request_id: object(next).request_id }) }));
    }
    if ((action === "portal" || action === "cancel") && req.method === "POST") {
      const input = await body(req);
      if (action === "portal" && !input.subscription_id) {
        const history = await client.database.from("tokentracker_cloud_payments").select("id")
          .eq("user_id", userId).eq("environment", environment).eq("provider", "waffo").limit(1);
        if (history.error) throw new BillingError("billing_operation_failed", 503);
        if (!history.data?.length) throw new BillingError("order_not_found", 404);
        return json({ url: "https://pancake.waffo.ai/consumer/portal/login" });
      }
      const subscriptionId = text(input.subscription_id);
      const sub = await client.database.from("tokentracker_cloud_subscriptions")
        .select("order_id")
        .eq("environment", environment).eq(
          "user_id",
          userId,
        )
        .eq("provider_subscription_id", subscriptionId).maybeSingle();
      if (sub.error) throw new BillingError("billing_operation_failed", 503);
      if (!sub.data) throw new BillingError("subscription_not_found", 404);
      const order = await ownedOrder(uuid(object(sub.data).order_id));
      if (order.provider === "waffo") {
        if (action === "portal") return json({ url: "https://pancake.waffo.ai/consumer/portal/login" });
        await cancelWaffoSubscription(order, subscriptionId, waffoConfig());
        await reconcileWaffoOrder(client, order, waffoConfig());
        return json({ membership: await rpc(client, "cloud_membership", {
          p_user_id: userId, p_environment: environment,
        }) });
      }
      const config = paddleConfig();
      if (action === "portal") {
        return json({
          url: await createPaddlePortal(order, subscriptionId, config),
        });
      }
      const data = await cancelPaddleSubscription(
        order,
        subscriptionId,
        config,
      );
      const stamp = text(data.updated_at);
      const event = await normalizePaddleEvent(
        {
          event_type: "subscription.updated",
          event_id: `query:${subscriptionId}:${stamp}`,
          occurred_at: stamp,
          data,
        },
        config,
        { order: async () => order, transactionOrder: async () => order },
      );
      if (!event) {
        throw new BillingError("subscription_cancellation_pending", 503);
      }
      await rpc(client, "cloud_apply_event", {
        p_provider: "paddle",
        p_environment: environment,
        p_event: event,
      });
      return json({
        membership: await rpc(client, "cloud_membership", {
          p_user_id: userId,
          p_environment: environment,
        }),
      });
    }
    if (action === "reconcile" && req.method === "POST") {
      const input = await body(req);
      const order = await ownedOrder(uuid(input.id));
      if (!configuredProviders()[order.provider]) {
        throw new BillingError("payment_provider_not_configured", 503);
      }
      const claim = await rpc(client, "cloud_claim_reconciliation", {
        p_user_id: userId,
        p_order_id: order.id,
      });
      if (!claim.claimed) {
        const result = json({
          error: "reconciliation_rate_limited",
          retry_after: claim.retry_after,
        }, 429);
        result.headers.set("Retry-After", String(claim.retry_after));
        return result;
      }
      if (order.provider === "waffo") {
        const confirmed = await reconcileWaffoOrder(client, order, waffoConfig());
        return json({ confirmed, membership: await rpc(client, "cloud_membership", {
          p_user_id: userId, p_environment: environment,
        }) });
      }
      let event;
      if (order.provider === "paddle") {
        const config = paddleConfig();
        const data = await queryPaddleOrder(order, config);
        if (data.status === "canceled") {
          await rpc(client, "cloud_close_unpaid_order", {
            p_user_id: userId,
            p_order_id: order.id,
          });
        }
        event = data.status === "completed"
          ? await normalizePaddleEvent(
            {
              event_type: "transaction.completed",
              event_id: `query:${text(data.id)}:payment`,
              occurred_at: data.updated_at,
              data,
            },
            config,
            { order: async () => order, transactionOrder: async () => order },
          )
          : null;
      } else if (order.provider === "wechat") {
        event = await queryWechatOrder(order, wechatConfig());
      } else {
        const { queryAlipayOrder, normalizeAlipayQuery } = await import(
          "./cloud/alipay.ts"
        );
        const config = alipayConfig();
        event = normalizeAlipayQuery(
          await queryAlipayOrder(order, config),
          order,
          config,
        );
      }
      if (event) {
        await rpc(client, "cloud_apply_event", {
          p_provider: order.provider,
          p_environment: environment,
          p_event: event,
        });
      }
      return json({
        confirmed: Boolean(event),
        membership: await rpc(client, "cloud_membership", {
          p_user_id: userId,
          p_environment: environment,
        }),
      });
    }
    if (action === "checkout" && req.method === "POST") {
      const input = await body(req);
      const provider = text(input.provider);
      // Unconfigured providers are never presented as functioning payment options.
      if (
        provider !== "waffo" || !configuredProviders().waffo
      ) throw new BillingError("payment_provider_not_configured", 503);
      await checkoutPolicy();
      const order = await rpc(client, "cloud_create_order", {
        p_user_id: userId,
        p_environment: environment,
        p_provider: provider,
        p_sku: text(input.sku),
        p_request_id: uuid(input.request_id),
      }) as unknown as CloudOrder;
      if (order.expires_at && Date.parse(order.expires_at) <= Date.now()) {
        throw new BillingError("checkout_expired", 409);
      }
      if (!order.checkout_url && !order.provider_price_id) {
        const config = waffoConfig();
        await validateWaffoProduct(order, config);
        await rpc(client, "cloud_attach_waffo_checkout", {
          p_user_id: userId, p_order_id: order.id, p_provider_checkout_id: null,
          p_provider_price_id: waffoProductId(order, config), p_checkout_url: null,
        });
      }
      const claim = await rpc(client, "cloud_claim_checkout", {
        p_user_id: userId,
        p_order_id: order.id,
      });
      const current = object(claim.order) as unknown as CloudOrder;
      if (!['pending', 'ready'].includes(current.status) ||
          Date.parse(current.expires_at) <= Date.now()) {
        throw new BillingError("checkout_expired", 409);
      }
      if (current.checkout_url) {
        return json({
          order: {
            id: current.id,
            checkout_url: current.checkout_url,
            status: current.status,
          },
        });
      }
      if (!claim.claimed && (current.status !== "pending" ||
          !current.provider_price_id)) {
        return json({
          order: { id: current.id, status: current.status },
          pending: true,
        }, 202);
      }
      let checkout: Awaited<ReturnType<typeof createWaffoCheckout>>;
      try {
        checkout = await createWaffoCheckout(current, waffoConfig());
      } catch {
        // Persisted order identity lets the owner recover an ambiguous response.
        return json({
          order: { id: current.id, status: current.status },
          pending: true,
          error: "checkout_confirmation_pending",
        }, 202);
      }
      const attached = await rpc(client, "cloud_attach_waffo_checkout", {
          p_user_id: userId, p_order_id: current.id,
          p_provider_checkout_id: checkout.sessionId || null,
          p_provider_price_id: checkout.priceId || null, p_checkout_url: checkout.checkoutUrl,
        });
      return json({
        order: {
          id: attached.id,
          checkout_url: attached.checkout_url,
          status: attached.status,
        },
      });
    }
    throw new BillingError("action_not_found", 404);
  } catch (error) {
    return failure(error);
  }
}
