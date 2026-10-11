import {
  BillingError,
  type CloudOrder,
  object,
  uuid,
} from "./cloud/contracts.ts";
import {
  normalizePaddleEvent,
  paddleCheckoutBinding,
  verifyPaddleSignature,
} from "./cloud/paddle.ts";
import {
  billingClient,
  failure,
  json,
  paddleConfig,
  preflight,
  rpc,
} from "./cloud/runtime.ts";

export default async function (req: Request): Promise<Response> {
  const options = preflight(req);
  if (options) return options;
  try {
    if (req.method !== "POST") {
      throw new BillingError("method_not_allowed", 405);
    }
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 1_048_576) {
      throw new BillingError("request_too_large", 413);
    }
    const config = paddleConfig();
    await verifyPaddleSignature(
      raw,
      req.headers.get("Paddle-Signature"),
      config.webhookSecret,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new BillingError("invalid_provider_payload");
    }
    const client = billingClient();
    async function order(id: string): Promise<CloudOrder> {
      const result = await client.database.from("tokentracker_cloud_orders")
        .select("*")
        .eq("id", id).eq("provider", "paddle").eq(
          "environment",
          config.environment,
        ).maybeSingle();
      // Returning 503 keeps legitimate events retryable when checkout persistence is late.
      if (result.error || !result.data) {
        throw new BillingError("payment_order_not_available", 503);
      }
      return object(result.data) as unknown as CloudOrder;
    }
    const event = object(payload);
    if (
      ["transaction.created", "transaction.ready", "transaction.updated"]
        .includes(String(event.event_type))
    ) {
      const data = object(event.data);
      const custom = data.custom_data == null ? null : object(data.custom_data);
      if (!custom?.tokentracker_order_id) {
        return json({ received: true, ignored: true });
      }
      const existing = await order(uuid(custom.tokentracker_order_id));
      const binding = paddleCheckoutBinding(data, existing, config);
      if (binding) {
        await rpc(client, "cloud_attach_checkout", {
          p_user_id: existing.user_id,
          p_order_id: existing.id,
          p_provider_order_id: binding.transactionId,
          p_provider_price_id: binding.priceId,
          p_checkout_url: binding.checkoutUrl,
        });
      }
      return json({ received: true, bound: Boolean(binding) });
    }
    const normalized = await normalizePaddleEvent(payload, config, {
      order,
      transactionOrder: async (id) => {
        const payment = await client.database.from(
          "tokentracker_cloud_payments",
        ).select("order_id")
          .eq("provider", "paddle").eq("environment", config.environment).eq(
            "transaction_id",
            id,
          ).maybeSingle();
        if (payment.error || !payment.data) {
          throw new BillingError("payment_order_not_available", 503);
        }
        return await order(String(object(payment.data).order_id));
      },
    });
    if (!normalized) return json({ received: true, ignored: true });
    const result = await rpc(client, "cloud_apply_event", {
      p_provider: "paddle",
      p_environment: config.environment,
      p_event: normalized,
    });
    return json({
      received: true,
      applied: result.applied,
      status: result.status,
    });
  } catch (error) {
    return failure(error);
  }
}
