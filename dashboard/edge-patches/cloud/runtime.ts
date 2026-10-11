import { createClient } from "npm:@insforge/sdk@1.4.5";
import { BillingError, object, type BillingEnvironment } from "./contracts.ts";
import { billingUserId } from "./auth.ts";
import type { PaddleConfig } from "./paddle.ts";
import type { WechatConfig } from "./wechat.ts";
import type { AlipayConfig } from "./alipay.ts";
import type { WaffoConfig } from "./waffo.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { ...cors, "Cache-Control": "no-store" } });
}

export function billingEnvironment(): BillingEnvironment {
  const value = Deno.env.get("TOKENTRACKER_BILLING_ENVIRONMENT") || "live";
  if (value !== "sandbox" && value !== "live") throw new BillingError("billing_configuration_invalid", 503);
  return value;
}

export function paddleConfig(): PaddleConfig {
  return { environment: billingEnvironment(),
    apiKey: Deno.env.get("PADDLE_API_KEY") || "", webhookSecret: Deno.env.get("PADDLE_WEBHOOK_SECRET") || "",
    monthlyPriceId: Deno.env.get("PADDLE_CLOUD_MONTHLY_PRICE_ID") || "",
    yearlyPriceId: Deno.env.get("PADDLE_CLOUD_YEARLY_PRICE_ID") || "",
    checkoutPage: `${billingSiteUrl()}/billing/checkout` };
}

export function wechatConfig(): WechatConfig {
  const baseUrl = Deno.env.get("INSFORGE_BASE_URL") || "";
  return { environment: billingEnvironment(), appId: Deno.env.get("WECHATPAY_APP_ID") || "",
    merchantId: Deno.env.get("WECHATPAY_MCH_ID") || "",
    merchantSerial: Deno.env.get("WECHATPAY_MERCHANT_SERIAL") || "",
    merchantPrivateKey: Deno.env.get("WECHATPAY_MERCHANT_PRIVATE_KEY") || "",
    platformKeyId: Deno.env.get("WECHATPAY_PUBLIC_KEY_ID") || "",
    platformPublicKey: Deno.env.get("WECHATPAY_PUBLIC_KEY") || "",
    apiV3Key: Deno.env.get("WECHATPAY_API_V3_KEY") || "",
    notifyUrl: `${baseUrl.replace(/\/$/,"")}/functions/tokentracker-wechat-webhook` };
}

export function alipayConfig(): AlipayConfig {
  const baseUrl = Deno.env.get("INSFORGE_BASE_URL") || "";
  return { environment: billingEnvironment(), appId: Deno.env.get("ALIPAY_APP_ID") || "",
    sellerId: Deno.env.get("ALIPAY_SELLER_ID") || "",
    privateKey: Deno.env.get("ALIPAY_PRIVATE_KEY") || "",
    publicKey: Deno.env.get("ALIPAY_PUBLIC_KEY") || "",
    notifyUrl: `${baseUrl.replace(/\/$/,"")}/functions/tokentracker-alipay-webhook`,
    checkoutPage: `${billingSiteUrl()}/billing/checkout` };
}

export function configuredProviders() {
  const paddle = paddleConfig(); const wechat = wechatConfig(); const alipay = alipayConfig();
  const waffo = waffoConfig();
  return {
    waffo: Boolean(waffo.merchantId && waffo.privateKey && waffo.storeId &&
      Object.values(waffo.productIds).every(Boolean) && (waffo.environment !== "live" ||
        /^[0-9a-f]{64}$/i.test(waffo.livePrivateKeySha256 || ""))),
    paddle: Boolean(paddle.apiKey && paddle.webhookSecret && paddle.monthlyPriceId &&
      paddle.yearlyPriceId && Deno.env.get("PADDLE_CLIENT_TOKEN")),
    wechat: wechat.environment === "live" && Boolean(wechat.appId && wechat.merchantId &&
      wechat.merchantSerial && wechat.merchantPrivateKey && wechat.platformKeyId &&
      wechat.platformPublicKey && new TextEncoder().encode(wechat.apiV3Key).byteLength === 32),
    alipay: Boolean(alipay.appId && alipay.sellerId && alipay.privateKey && alipay.publicKey),
  };
}

export function waffoCheckoutVerified(policy: Record<string, unknown>, configured: boolean, now = Date.now()): boolean {
  const launch = Date.parse(String(policy.launch_at));
  return billingEnvironment() === "live" && configured && policy.phase === "active" &&
    Number.isFinite(launch) && launch <= now &&
    Deno.env.get("TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED") === "true";
}

export function waffoConfig(): WaffoConfig {
  const privateKey = Deno.env.get("WAFFO_PRIVATE_KEY") || "";
  const environment = billingEnvironment();
  return {
    environment,
    merchantId: Deno.env.get("WAFFO_MERCHANT_ID") || "",
    storeId: Deno.env.get("WAFFO_STORE_ID") || "",
    privateKey,
    ...(environment === "live" ? { livePrivateKeySha256: Deno.env.get("WAFFO_LIVE_PRIVATE_KEY_SHA256") } : {}),
    checkoutPage: `${billingSiteUrl()}/billing/checkout`,
    productIds: {
      cloud_usd_monthly: Deno.env.get("WAFFO_CLOUD_MONTHLY_PRODUCT_ID") || "",
      cloud_usd_yearly: Deno.env.get("WAFFO_CLOUD_YEARLY_PRODUCT_ID") || "",
      cloud_usd_monthly_fixed: Deno.env.get("WAFFO_CLOUD_MONTHLY_PASS_PRODUCT_ID") || "",
      cloud_usd_yearly_fixed: Deno.env.get("WAFFO_CLOUD_YEARLY_PASS_PRODUCT_ID") || "",
    },
  };
}

export function billingSiteUrl(): string {
  const value = Deno.env.get("TOKENTRACKER_BILLING_SITE_URL") || "https://www.tokentracker.cc";
  const url = new URL(value);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new BillingError("billing_configuration_invalid", 503);
  }
  return url.origin;
}

export function billingClient() {
  const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
  const edgeFunctionToken = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") || Deno.env.get("ANON_KEY");
  if (!baseUrl || !edgeFunctionToken || !anonKey) throw new BillingError("billing_not_configured", 503);
  return createClient({ baseUrl, edgeFunctionToken, anonKey, headers: { apikey: anonKey } });
}

export async function signedInUser(req: Request): Promise<string> {
  return await billingUserId(req.headers.get("Authorization"), {
    jwtSecret: Deno.env.get("JWT_SECRET"), jwtPublicKey: Deno.env.get("JWT_PUBLIC_KEY"),
  });
}

export async function rpc(client: ReturnType<typeof billingClient>, name: string, data: Record<string, unknown>) {
  const result = await client.database.rpc(name, data);
  if (result.error) {
    const message = result.error.message || "";
    const code = message.includes("self-hosted access is free") ? "self_hosted_free"
      : message.includes("gift_membership_active") ? "gift_membership_active"
      : message.includes("payment conflict must be resolved") ? "payment_conflict"
      : (message.includes("previous retry order has a successful payment") ||
      message.includes("paid Waffo order cannot be restarted")) ? "checkout_already_paid"
      : message.includes("existing checkout") ? "pending_checkout_exists"
      : message.includes("existing subscription") ? "subscription_already_exists"
      : message.includes("fixed membership term") ? "fixed_term_still_active"
      : message.includes("before the first purchase") ? "trial_unavailable"
      : message.includes("trial has not launched") ? "trial_not_launched"
      : (message.includes("different purchase") || message.includes("retry request already belongs")) ? "checkout_request_conflict"
      : "billing_operation_failed";
    throw new BillingError(code, code === "billing_operation_failed" ? 503 : 409);
  }
  return object(result.data);
}

export function failure(error: unknown): Response {
  if (error instanceof BillingError) return json({ error: error.code }, error.status);
  // Never expose or log upstream bodies, payment credentials, or customer data.
  console.error("cloud-billing: operation failed");
  return json({ error: "billing_operation_failed" }, 503);
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get("Content-Length") || 0);
  if (contentLength > 16_384) throw new BillingError("request_too_large", 413);
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > 16_384) throw new BillingError("request_too_large", 413);
  try { return object(JSON.parse(raw)); }
  catch { throw new BillingError("invalid_request"); }
}

export function preflight(req: Request): Response | null {
  return req.method === "OPTIONS" ? new Response(null, { status: 204, headers: cors }) : null;
}
