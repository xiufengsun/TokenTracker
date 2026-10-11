import { BillingError, object, type CloudOrder, uuid } from "./cloud/contracts.ts";
import { billingClient, billingEnvironment, failure, json, waffoConfig } from "./cloud/runtime.ts";
import { verifyWaffoWebhook } from "./cloud/waffo.ts";
import { reconcileWaffoOrder } from "./cloud/waffo-processing.ts";

const events = new Set([
  "order.completed", "subscription.activated", "subscription.payment_succeeded",
  "subscription.renewed", "subscription.recovered", "subscription.canceling",
  "subscription.uncanceled", "subscription.canceled", "subscription.past_due",
  "refund.succeeded", "refund.failed", "subscription.plan_changed",
]);

export default async function (req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") throw new BillingError("method_not_allowed", 405);
    if (Number(req.headers.get("Content-Length")) > 262_144) throw new BillingError("request_too_large", 413);
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 262_144) throw new BillingError("request_too_large", 413);
    const config = waffoConfig();
    const event = verifyWaffoWebhook(raw, req.headers.get("x-waffo-signature"), config);
    if (!events.has(event.eventType)) return json({ received: true, ignored: true });
    const data = object(event.data);
    // The store may also contain independent products with no TokenTracker order.
    if (!data.orderMerchantExternalId) return json({ received: true, ignored: true });
    const id = uuid(data.orderMerchantExternalId);
    const client = billingClient();
    const result = await client.database.from("tokentracker_cloud_orders").select("*")
      .eq("id", id).eq("provider", "waffo").eq("environment", billingEnvironment()).maybeSingle();
    if (result.error) throw new BillingError("billing_operation_failed", 503);
    if (!result.data) throw new BillingError("order_not_found", 404);
    await reconcileWaffoOrder(client, object(result.data) as unknown as CloudOrder, config,
      event as unknown as Record<string, unknown>);
    // Acknowledge only after durable SQL writes. Failures remain retryable at Waffo.
    return json({ received: true });
  } catch (error) { return failure(error); }
}
