import { BillingError, type CloudOrder } from "./contracts.ts";
import { billingClient, rpc } from "./runtime.ts";
import type { WaffoConfig, WaffoPeriod } from "./waffo.ts";
import { reconcileWaffoLedger } from "./waffo-reconciliation.ts";

export function reconcileWaffoOrder(
  client: ReturnType<typeof billingClient>, order: CloudOrder, config: WaffoConfig,
  notification?: Record<string, unknown>,
) {
  return reconcileWaffoLedger({
    call: (name, args) => rpc(client, name, args),
    async periods(bound, offset) {
      const result = await client.database.from("tokentracker_cloud_waffo_periods")
        .select("waffo_order_id,period_number,starts_at,ends_at")
        .eq("order_id", bound.id).eq("environment", bound.environment)
        .order("waffo_order_id").order("period_number").range(offset, offset + 99);
      if (result.error) throw new BillingError("billing_operation_failed", 503);
      return (result.data || []) as WaffoPeriod[];
    },
  }, order, config, notification);
}
