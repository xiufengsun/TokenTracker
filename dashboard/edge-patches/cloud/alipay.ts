import { AlipaySdk } from "npm:alipay-sdk@4.14.0";
import {
  type BillingEnvironment,
  BillingError,
  type CloudOrder,
  decimalCents,
  type PaymentEvent,
  text,
} from "./contracts.ts";
import { localOrderId, merchantOrderId } from "./wechat.ts";

export interface AlipayConfig {
  environment: BillingEnvironment;
  appId: string;
  sellerId: string;
  privateKey: string;
  publicKey: string;
  notifyUrl: string;
  checkoutPage: string;
}

export function alipayClient(config: AlipayConfig): AlipaySdk {
  if (
    !config.appId || !config.sellerId || !config.privateKey || !config.publicKey
  ) throw new BillingError("alipay_not_configured", 503);
  const sdk=new AlipaySdk({
    appId: config.appId,
    privateKey: config.privateKey.trim(),
    alipayPublicKey: config.publicKey.trim(),
    keyType: "PKCS8",
    signType: "RSA2",
    charset: "utf-8",
    camelcase: false,
    timeout: 15_000,
    gateway: config.environment === "sandbox"
      ? "https://openapi-sandbox.dl.alipaydev.com/gateway.do"
      : "https://openapi.alipay.com/gateway.do",
    endpoint: config.environment === "sandbox"
      ? "https://openapi-sandbox.dl.alipaydev.com"
      : "https://openapi.alipay.com",
  });
  // The SDK joins PEM data onto one line. Deno's Node crypto parser requires
  // standard wrapped PEM, so retain the SDK with canonical key formatting.
  const pem=(value:string,label:string)=>{
    const encoded=value.replace(/-----[^-]+-----|\s/g,"");
    return `-----BEGIN ${label}-----\n${encoded.match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----`;
  };
  sdk.config.privateKey=pem(config.privateKey,"PRIVATE KEY");
  sdk.config.alipayPublicKey=pem(config.publicKey,"PUBLIC KEY");
  return sdk;
}

export function createAlipayCheckout(
  order: CloudOrder,
  config: AlipayConfig,
  mobile = false,
) {
  assertAlipayOrder(order, config);
  const notify = new URL(config.notifyUrl);
  const returnUrl = new URL(config.checkoutPage);
  if (
    notify.protocol !== "https:" ||
    (returnUrl.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(returnUrl.hostname))
  ) {
    throw new BillingError("invalid_checkout_configuration", 503);
  }
  returnUrl.searchParams.set("order", order.id);
  const amount = `${Math.floor(order.amount_cents / 100)}.${
    String(order.amount_cents % 100).padStart(2, "0")
  }`;
  const sdk = alipayClient(config);
  const checkoutUrl = sdk.pageExecute(
    mobile ? "alipay.trade.wap.pay" : "alipay.trade.page.pay",
    "GET",
    {
      bizContent: {
        out_trade_no: merchantOrderId(order.id),
        total_amount: amount,
        product_code: mobile ? "QUICK_WAP_WAY" : "FAST_INSTANT_TRADE_PAY",
        subject: order.term_months === 12
          ? "TokenTracker Cloud annual membership"
          : "TokenTracker Cloud monthly membership",
        timeout_express: "30m",
        seller_id: config.sellerId,
      },
      notifyUrl: notify.toString(),
      returnUrl: returnUrl.toString(),
    },
  );
  return { checkoutUrl };
}

export function parseAlipayNotification(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    if (Object.hasOwn(values, key)) {
      throw new BillingError("duplicate_provider_field");
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new BillingError("invalid_provider_field");
    }
    values[key] = value;
  }
  return values;
}

export function verifyAlipayNotification(
  values: Record<string, string>,
  config: AlipayConfig,
): void {
  if (
    values.sign_type !== "RSA2" || values.charset?.toLowerCase() !== "utf-8" ||
    !alipayClient(config).checkNotifySignV2(values)
  ) throw new BillingError("invalid_signature", 401);
  if (values.app_id !== config.appId || values.seller_id !== config.sellerId) {
    throw new BillingError("payment_account_mismatch");
  }
}

function alipayDate(value: unknown): string {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    throw new BillingError("invalid_provider_date");
  }
  const date = new Date(`${raw.replace(" ", "T")}+08:00`);
  if (!Number.isFinite(date.getTime())) {
    throw new BillingError("invalid_provider_date");
  }
  return date.toISOString();
}

export function normalizeAlipayNotification(
  values: Record<string, string>,
  order: CloudOrder,
  config: AlipayConfig,
): PaymentEvent[] {
  assertAlipayOrder(order, config);
  if (
    values.app_id !== config.appId || values.seller_id !== config.sellerId ||
    localOrderId(values.out_trade_no) !== order.id
  ) throw new BillingError("payment_order_mismatch");
  if (decimalCents(values.total_amount) !== order.amount_cents) {
    throw new BillingError("payment_amount_mismatch");
  }
  const refundTotal = values.refund_fee ? decimalCents(values.refund_fee) : 0;
  if (
    !["TRADE_SUCCESS", "TRADE_FINISHED"].includes(values.trade_status) &&
    !(values.trade_status === "TRADE_CLOSED" && refundTotal > 0)
  ) return [];
  if (refundTotal > order.amount_cents) {
    throw new BillingError("payment_amount_mismatch");
  }
  const transactionId = text(values.trade_no);
  const notificationId = text(values.notify_id, 160);
  const occurred = alipayDate(values.gmt_payment || values.notify_time);
  const payment: PaymentEvent = {
    event_id: `${notificationId}:payment`,
    kind: "payment",
    action_id: transactionId,
    order_id: order.id,
    occurred_at: occurred,
    currency: "CNY",
    base_amount_cents: order.amount_cents,
    amount_cents: order.amount_cents,
  };
  if (refundTotal === 0) return [payment];
  return [payment, {
    event_id: `${notificationId}:refund`,
    kind: "refund",
    action_id: `${transactionId}:refund:${refundTotal}`,
    order_id: order.id,
    occurred_at: alipayDate(values.notify_time),
    transaction_id: transactionId,
    currency: "CNY",
    amount_cents: refundTotal,
    refund_total_cents: refundTotal,
  }];
}

export async function queryAlipayOrder(
  order: CloudOrder,
  config: AlipayConfig,
): Promise<Record<string, unknown> | null> {
  assertAlipayOrder(order, config);
  // Page checkout uses the v2 product API; its matching query also verifies the raw response signature.
  const data = await alipayClient(config).exec("alipay.trade.query", {
    bizContent: { out_trade_no: merchantOrderId(order.id) },
  }, { validateSign: true });
  if (data.code === "40004" && data.sub_code === "ACQ.TRADE_NOT_EXIST") {
    return null;
  }
  if (data.code !== "10000") {
    throw new BillingError("payment_provider_unavailable", 502);
  }
  if (data.out_trade_no !== merchantOrderId(order.id)) {
    throw new BillingError("payment_order_mismatch");
  }
  return data;
}

export function normalizeAlipayQuery(
  data: Record<string, unknown> | null,
  order: CloudOrder,
  config: AlipayConfig,
): PaymentEvent | null {
  assertAlipayOrder(order, config);
  if (!data) return null;
  // This is called only on a merchant-authenticated, SDK-verified query response.
  if (
    data.code !== "10000" || data.out_trade_no !== merchantOrderId(order.id) ||
    (data.trans_currency != null && data.trans_currency !== "CNY")
  ) throw new BillingError("payment_order_mismatch");
  if (decimalCents(data.total_amount) !== order.amount_cents) {
    throw new BillingError("payment_amount_mismatch");
  }
  if (
    !["TRADE_SUCCESS", "TRADE_FINISHED"].includes(String(data.trade_status))
  ) return null;
  const transactionId = text(data.trade_no);
  return {
    event_id: `query:${transactionId}:payment`,
    kind: "payment",
    action_id: transactionId,
    order_id: order.id,
    occurred_at: alipayDate(data.send_pay_date),
    currency: "CNY",
    base_amount_cents: order.amount_cents,
    amount_cents: order.amount_cents,
  };
}

function assertAlipayOrder(order: CloudOrder, config: AlipayConfig): void {
  if (
    order.provider !== "alipay" || order.environment !== config.environment ||
    order.currency !== "CNY"
  ) {
    throw new BillingError("payment_order_mismatch");
  }
}
