import {
  type BillingEnvironment,
  BillingError,
  cents,
  type CloudOrder,
  type Fetcher,
  isoDate,
  object,
  type PaymentEvent,
  text,
  uuid,
} from "./contracts.ts";
import {
  base64Bytes,
  bytes,
  freshTimestamp,
  signRsa,
  verifyRsa,
} from "./cryptography.ts";

export interface WechatConfig {
  environment: BillingEnvironment;
  appId: string;
  merchantId: string;
  merchantSerial: string;
  merchantPrivateKey: string;
  platformKeyId: string;
  platformPublicKey: string;
  apiV3Key: string;
  notifyUrl: string;
}

export function merchantOrderId(id: string): string {
  return uuid(id).replace(/-/g, "");
}
export function localOrderId(value: unknown): string {
  const id = text(value);
  if (!/^[0-9a-f]{32}$/i.test(id)) throw new BillingError("invalid_order_id");
  return uuid(
    `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${
      id.slice(16, 20)
    }-${id.slice(20)}`,
  );
}

export async function verifyWechatMessage(
  raw: string,
  headers: Headers,
  config: WechatConfig,
  nowMs = Date.now(),
): Promise<void> {
  const timestamp = headers.get("Wechatpay-Timestamp");
  const nonce = headers.get("Wechatpay-Nonce");
  const signature = headers.get("Wechatpay-Signature");
  const serial = headers.get("Wechatpay-Serial");
  if (!config.platformKeyId || !config.platformPublicKey) {
    throw new BillingError("wechat_not_configured", 503);
  }
  if (
    !timestamp || !nonce || !signature || serial !== config.platformKeyId ||
    nonce.length > 200
  ) {
    throw new BillingError("invalid_signature", 401);
  }
  freshTimestamp(timestamp, nowMs, 300);
  if (
    !await verifyRsa(
      config.platformPublicKey,
      `${timestamp}\n${nonce}\n${raw}\n`,
      signature,
    )
  ) {
    throw new BillingError("invalid_signature", 401);
  }
}

export async function wechatRequest(
  method: "GET" | "POST",
  pathname: string,
  payload: Record<string, unknown> | null,
  config: WechatConfig,
  request: Fetcher = fetch,
): Promise<Record<string, unknown>> {
  // APIv3 Native orders use the live merchant API, not the older v2 sandbox.
  if (config.environment !== "live") {
    throw new BillingError("wechat_live_merchant_required", 503);
  }
  if (
    !config.merchantId || !config.merchantSerial || !config.merchantPrivateKey
  ) throw new BillingError("wechat_not_configured", 503);
  if (!pathname.startsWith("/v3/") || pathname.includes("\n")) {
    throw new BillingError("invalid_provider_request");
  }
  const body = payload ? JSON.stringify(payload) : "";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const signature = await signRsa(
    config.merchantPrivateKey,
    `${method}\n${pathname}\n${timestamp}\n${nonce}\n${body}\n`,
  );
  const authorization =
    `WECHATPAY2-SHA256-RSA2048 mchid="${config.merchantId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.merchantSerial}"`;
  const response = await request(`https://api.mch.weixin.qq.com${pathname}`, {
    method,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: authorization,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Wechatpay-Serial": config.platformKeyId,
    },
    ...(payload ? { body } : {}),
  });
  const raw = await response.text();
  await verifyWechatMessage(raw, response.headers, config);
  if (!response.ok) throw new BillingError("payment_provider_unavailable", 502);
  try {
    return object(JSON.parse(raw));
  } catch {
    throw new BillingError("invalid_provider_payload", 502);
  }
}

export async function createWechatCheckout(
  order: CloudOrder,
  config: WechatConfig,
  request: Fetcher = fetch,
) {
  assertWechatOrder(order, config);
  if (
    !config.appId || !config.notifyUrl || bytes(config.apiV3Key).length !== 32
  ) throw new BillingError("wechat_not_configured", 503);
  const notify = new URL(config.notifyUrl);
  if (notify.protocol !== "https:") {
    throw new BillingError("invalid_checkout_configuration", 503);
  }
  const data = await wechatRequest(
    "POST",
    "/v3/pay/transactions/native",
    {
      appid: config.appId,
      mchid: config.merchantId,
      out_trade_no: merchantOrderId(order.id),
      description: order.term_months === 12
        ? "TokenTracker Cloud annual membership"
        : "TokenTracker Cloud monthly membership",
      notify_url: notify.toString(),
      time_expire: order.expires_at,
      attach: order.id,
      amount: { total: order.amount_cents, currency: "CNY" },
    },
    config,
    request,
  );
  const codeUrl = text(data.code_url, 4096);
  const parsed = new URL(codeUrl);
  if (
    parsed.protocol !== "weixin:" || parsed.hostname !== "wxpay" ||
    parsed.pathname !== "/bizpayurl"
  ) {
    throw new BillingError("invalid_provider_checkout_url", 502);
  }
  return { checkoutUrl: codeUrl };
}

export async function queryWechatOrder(
  order: CloudOrder,
  config: WechatConfig,
  request: Fetcher = fetch,
) {
  assertWechatOrder(order, config);
  const data = await wechatRequest(
    "GET",
    `/v3/pay/transactions/out-trade-no/${merchantOrderId(order.id)}?mchid=${
      encodeURIComponent(config.merchantId)
    }`,
    null,
    config,
    request,
  );
  if (
    data.mchid !== config.merchantId || data.appid !== config.appId ||
    localOrderId(data.out_trade_no) !== order.id
  ) {
    throw new BillingError("payment_order_mismatch");
  }
  if (data.trade_state !== "SUCCESS") return null;
  return normalizeWechatEvent(
    {
      id: `query:${text(data.transaction_id)}`,
      event_type: "TRANSACTION.SUCCESS",
      create_time: isoDate(data.success_time),
    },
    data,
    order,
    config,
  );
}

export async function decryptWechatResource(
  payload: unknown,
  config: WechatConfig,
): Promise<Record<string, unknown>> {
  if (bytes(config.apiV3Key).length !== 32) {
    throw new BillingError("wechat_not_configured", 503);
  }
  const resource = object(object(payload).resource);
  if (resource.algorithm !== "AEAD_AES_256_GCM") {
    throw new BillingError("invalid_provider_encryption");
  }
  const nonce = text(resource.nonce);
  const aad =
    resource.associated_data == null || resource.associated_data === ""
      ? ""
      : text(resource.associated_data);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      bytes(config.apiV3Key),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes(nonce),
        additionalData: bytes(aad),
        tagLength: 128,
      },
      key,
      base64Bytes(text(resource.ciphertext, 1_048_576)),
    );
    return object(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new BillingError("invalid_provider_encryption", 401);
  }
}

export function normalizeWechatEvent(
  payload: unknown,
  data: Record<string, unknown>,
  order: CloudOrder,
  config: WechatConfig,
): PaymentEvent | null {
  assertWechatOrder(order, config);
  const event = object(payload);
  if (
    data.mchid !== config.merchantId ||
    localOrderId(data.out_trade_no) !== order.id
  ) {
    throw new BillingError("payment_order_mismatch");
  }
  const common = {
    event_id: text(event.id),
    order_id: order.id,
    occurred_at: isoDate(event.create_time),
  };
  const amount = object(data.amount);
  if (event.event_type === "REFUND.SUCCESS") {
    if (data.refund_status !== "SUCCESS") return null;
    // The Native refund callback has no currency field. The signed merchant,
    // original transaction and CNY order establish its currency.
    if (
      (amount.currency != null && amount.currency !== "CNY") ||
      cents(amount.total) !== order.amount_cents
    ) throw new BillingError("payment_amount_mismatch");
    return {
      ...common,
      kind: "refund",
      action_id: text(data.refund_id),
      transaction_id: text(data.transaction_id),
      currency: "CNY",
      amount_cents: cents(amount.refund),
    };
  }
  if (
    event.event_type !== "TRANSACTION.SUCCESS" || data.trade_state !== "SUCCESS"
  ) return null;
  if (
    data.appid !== config.appId || data.trade_type !== "NATIVE" ||
    (data.attach != null && data.attach !== order.id)
  ) throw new BillingError("payment_account_mismatch");
  if (amount.currency !== "CNY" || cents(amount.total) !== order.amount_cents) {
    throw new BillingError("payment_amount_mismatch");
  }
  return {
    ...common,
    kind: "payment",
    action_id: text(data.transaction_id),
    currency: "CNY",
    base_amount_cents: order.amount_cents,
    amount_cents: order.amount_cents,
  };
}

function assertWechatOrder(order: CloudOrder, config: WechatConfig): void {
  if (
    order.provider !== "wechat" || order.environment !== config.environment ||
    order.currency !== "CNY"
  ) {
    throw new BillingError("payment_order_mismatch");
  }
}
