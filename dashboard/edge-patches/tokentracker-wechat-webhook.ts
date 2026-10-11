import { BillingError, object, type CloudOrder } from "./cloud/contracts.ts";
import { decryptWechatResource, localOrderId, normalizeWechatEvent, verifyWechatMessage } from "./cloud/wechat.ts";
import { billingClient, failure, preflight, rpc, wechatConfig } from "./cloud/runtime.ts";

export default async function(req: Request): Promise<Response> {
  const options = preflight(req); if (options) return options;
  try {
    if (req.method !== "POST") throw new BillingError("method_not_allowed", 405);
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 1_048_576) throw new BillingError("request_too_large", 413);
    const config = wechatConfig();
    await verifyWechatMessage(raw, req.headers, config);
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw new BillingError("invalid_provider_payload"); }
    const decrypted = await decryptWechatResource(payload, config);
    const client = billingClient();
    const result = await client.database.from("tokentracker_cloud_orders").select("*")
      .eq("id",localOrderId(decrypted.out_trade_no)).eq("provider","wechat").eq("environment",config.environment).maybeSingle();
    if (result.error || !result.data) throw new BillingError("payment_order_not_available",503);
    const event = normalizeWechatEvent(payload,decrypted,object(result.data) as unknown as CloudOrder,config);
    if (event) await rpc(client,"cloud_apply_event",{p_provider:"wechat",p_environment:config.environment,p_event:event});
    return new Response(null,{status:204});
  } catch (error) { return failure(error); }
}
