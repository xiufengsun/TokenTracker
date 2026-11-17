import { BillingError, type CloudOrder } from './contracts.ts';
import { billingClient, rpc } from './runtime.ts';
import { confirmExpiredUnusedWaffoCheckout, type WaffoConfig } from './waffo.ts';

export async function closeExpiredUnusedGiftOrders(
  client: ReturnType<typeof billingClient>, userId: string, environment: string, config: WaffoConfig,
) {
  const result = await client.database.from('tokentracker_cloud_orders').select('*')
    .eq('user_id', userId).eq('environment', environment).in('status', ['pending', 'ready'])
    .order('created_at', { ascending: true }).limit(10);
  if (result.error) throw new BillingError('billing_operation_failed', 503);
  let closed = false;
  for (const value of result.data || []) {
    const order = value as CloudOrder;
    // Cancellation has stricter receipt/operation finality; never bypass it via gift cleanup.
    if (order.cancel_requested_at) continue;
    if (order.user_id !== userId || order.environment !== environment || order.provider !== 'waffo') continue;
    if (!await confirmExpiredUnusedWaffoCheckout(order, config)) continue;
    const latest = await rpc(client, 'cloud_close_unpaid_order', { p_user_id: userId, p_order_id: order.id });
    if (latest.status === 'closed') closed = true;
  }
  return closed;
}
