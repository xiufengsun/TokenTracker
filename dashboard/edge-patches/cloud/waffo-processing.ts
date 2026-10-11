import { BillingError, isoDate, object, text, type CloudOrder } from "./contracts.ts";
import { billingClient, rpc } from "./runtime.ts";
import { queryWaffoOrder, queryWaffoBindings, waffoProductId, type WaffoConfig, type WaffoPeriod } from "./waffo.ts";

// Payment and billing-period notifications are independent. Keep verified periods
// before applying charges, so a delayed charge never inherits another period.
export async function reconcileWaffoOrder(
  client: ReturnType<typeof billingClient>, order: CloudOrder, config: WaffoConfig,
  notification?: Record<string, unknown>,
) {
  const bindings = await queryWaffoBindings(order, config);
  const notificationData = notification ? object(notification.data) : null;
  const binding = notificationData ? bindings.find(value => value.waffo_order_id === notificationData.orderId) : null;
  if (notification) {
    const data = object(notification.data);
    if (!bindings.length) throw new BillingError("waffo_notification_pending", 503);
    if (!binding || data.orderMerchantExternalId !== order.id) {
      throw new BillingError("ambiguous_payment_binding", 409);
    }
  }
  for (const attempt of bindings) {
    await rpc(client, "cloud_register_waffo_attempt", {
      p_order_id: order.id, p_environment: order.environment,
      p_waffo_order_id: attempt.waffo_order_id, p_provider_price_id: attempt.provider_price_id,
      p_billing_mode: order.billing_mode,
    });
  }
  async function record(period: WaffoPeriod) {
    await rpc(client, "cloud_record_waffo_period", {
      p_order_id: order.id, p_environment: order.environment,
      p_waffo_order_id: text(period.waffo_order_id),
      p_provider_price_id: text(period.provider_price_id),
      p_period_number: period.period_number,
      p_starts_at: isoDate(period.starts_at), p_ends_at: isoDate(period.ends_at),
    });
  }
  for (const attempt of bindings) if (attempt.current_period) await record(attempt.current_period);
  const periods: WaffoPeriod[] = [];
  for (let offset = 0; ; offset += 100) {
    const result = await client.database.from("tokentracker_cloud_waffo_periods")
      .select("waffo_order_id,period_number,starts_at,ends_at")
      .eq("order_id", order.id).eq("environment", order.environment)
      .order("waffo_order_id").order("period_number").range(offset, offset + 99);
    if (result.error) throw new BillingError("billing_operation_failed", 503);
    const page = (result.data || []) as WaffoPeriod[];
    periods.push(...page);
    if (page.length < 100) break;
  }
  for (const attempt of bindings) {
    if (attempt.current_period && !periods.some(period => period.waffo_order_id === attempt.waffo_order_id &&
        period.period_number === attempt.current_period?.period_number)) {
      periods.push(attempt.current_period);
    }
  }
  if (notification && order.billing_mode === "recurring" &&
      !["subscription.past_due", "subscription.canceled", "subscription.canceling", "subscription.uncanceled"].includes(String(notification.eventType))) {
    const data = object(notification.data);
    if (data.currentPeriodStart && data.currentPeriodEnd && Number.isInteger(data.periodNumber) && Number(data.periodNumber) > 0) {
      const starts = text(data.currentPeriodStart);
      const ends = text(data.currentPeriodEnd);
      const known = periods.find(period => period.period_number === data.periodNumber && period.waffo_order_id === data.orderId);
      const matches = (received: string, verified: string) => /^\d{4}-\d{2}-\d{2}$/.test(received)
        ? received === isoDate(verified).slice(0, 10) : isoDate(received) === isoDate(verified);
      if (known) {
        // Waffo notifications use dates, while GraphQL preserves channel instants.
        if (!matches(starts, known.starts_at) || !matches(ends, known.ends_at)) {
          throw new BillingError("waffo_billing_period_conflict", 409);
        }
      } else {
        if (/^\d{4}-\d{2}-\d{2}$/.test(starts) || /^\d{4}-\d{2}-\d{2}$/.test(ends)) {
          throw new BillingError("waffo_billing_period_pending", 503);
        }
        const period = { waffo_order_id: text(data.orderId), provider_price_id: waffoProductId(order, config),
          period_number: Number(data.periodNumber), starts_at: starts, ends_at: ends };
        await record(period);
        periods.push(period);
      }
    }
  }
  const events = await queryWaffoOrder(order, config, fetch, periods);
  if (notification) {
    const data = object(notification.data);
    const type = String(notification.eventType);
    const expected = type === "refund.succeeded" ? "refund"
      : ["order.completed", "subscription.payment_succeeded"].includes(type) ? "payment" : "subscription";
    if (type !== "refund.failed") {
      const action = expected === "refund" ? data.refundId || notification.eventId
        : expected === "payment" ? data.paymentId || notification.eventId : null;
      if (!events.some(event => (event.kind === expected || (expected === "payment" && event.kind === "authorization")) && event.waffo_order_id === data.orderId &&
          (action === null || event.action_id === action))) {
        throw new BillingError("waffo_notification_pending", 503);
      }
      if (expected === "subscription" && type.startsWith("subscription.")) {
        const current = events.find(event => event.kind === "subscription" && event.waffo_order_id === data.orderId);
        const matchedPeriod = Number.isInteger(data.periodNumber) && Number(data.periodNumber) > 0
          ? current?.period_number === data.periodNumber : true;
        if (type === "subscription.renewed" && (!Number.isInteger(data.periodNumber) ||
            !events.some(event => event.kind === "payment" && event.waffo_order_id === data.orderId && event.period_number === data.periodNumber))) {
          throw new BillingError("waffo_notification_pending", 503);
        }
        const reflects = current && (
          type === "subscription.canceling" ? current.status === "active" && current.cancel_at_period_end === true
          : type === "subscription.canceled" ? current.status === "canceled"
          : type === "subscription.past_due" ? current.status === "past_due"
          : ["subscription.activated", "subscription.recovered", "subscription.renewed"].includes(type)
            ? current.status === "active" && matchedPeriod
          : type === "subscription.uncanceled"
            ? current.status === "active" && current.cancel_at_period_end === false
            : false
        );
        // An older API snapshot must not consume a lifecycle notification.
        // A newer snapshot wins when the customer has since changed the state.
        if (!current || (!reflects && Date.parse(current.occurred_at) < Date.parse(isoDate(notification.timestamp)))) {
          throw new BillingError("waffo_notification_pending", 503);
        }
      }
    }
  }
  for (const event of events) if (event.kind === "authorization") {
    await rpc(client, "cloud_record_waffo_authorization", { p_environment: order.environment, p_event: event });
  }
  const financial = events.filter(event => event.kind !== "authorization");
  for (let offset = 0; offset < financial.length; offset += 100) {
    // Each batch is durable and action-idempotent; acknowledge after every batch.
    await rpc(client, "cloud_apply_waffo_events", {
      p_environment: order.environment, p_events: financial.slice(offset, offset + 100),
    });
  }
  return events.some(event => event.kind === "payment");
}
