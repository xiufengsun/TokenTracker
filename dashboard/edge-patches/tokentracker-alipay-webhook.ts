import { BillingError, object, type CloudOrder } from "./cloud/contracts.ts";
import { normalizeAlipayNotification, parseAlipayNotification, verifyAlipayNotification } from "./cloud/alipay.ts";
import { localOrderId } from "./cloud/wechat.ts";
import { alipayConfig, billingClient, failure, preflight, rpc } from "./cloud/runtime.ts";

export default async function(req: Request): Promise<Response> {
  const options = preflight(req); if (options) return options;
  try {
    if (req.method !== "POST") throw new BillingError("method_not_allowed",405);
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 131_072) throw new BillingError("request_too_large",413);
    const config = alipayConfig();
    const values = parseAlipayNotification(raw);
    verifyAlipayNotification(values,config);
    const client = billingClient();
    const result = await client.database.from("tokentracker_cloud_orders").select("*")
      .eq("id",localOrderId(values.out_trade_no)).eq("provider","alipay").eq("environment",config.environment).maybeSingle();
    if (result.error || !result.data) throw new BillingError("payment_order_not_available",503);
    const events = normalizeAlipayNotification(values,object(result.data) as unknown as CloudOrder,config);
    if (events.length) await rpc(client,"cloud_apply_events",{p_provider:"alipay",p_environment:config.environment,p_events:events});
    return new Response("success",{headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}});
  } catch (error) { return failure(error); }
}
