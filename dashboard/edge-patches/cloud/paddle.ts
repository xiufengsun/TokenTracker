import {
  type BillingEnvironment,
  BillingError,
  cents,
  type CloudOrder,
  type Fetcher,
  isoDate,
  object,
  type PaymentEvent,
  providerJson,
  text,
  uuid,
} from "./contracts.ts";
import { bytes, freshTimestamp, hexBytes } from "./cryptography.ts";

export interface PaddleConfig {
  environment: BillingEnvironment;
  apiKey: string;
  webhookSecret: string;
  monthlyPriceId: string;
  yearlyPriceId: string;
  checkoutPage: string;
}

export function paddleApiUrl(environment: BillingEnvironment): string {
  return environment === "sandbox"
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";
}

function priceId(order: CloudOrder, config: PaddleConfig): string {
  return order.provider_price_id ||
    (order.term_months === 12 ? config.yearlyPriceId : config.monthlyPriceId);
}

async function paddleRequest(
  path: string,
  config: PaddleConfig,
  request: Fetcher,
  value?: unknown,
) {
  if (!config.apiKey) throw new BillingError("paddle_not_configured", 503);
  const response = await request(`${paddleApiUrl(config.environment)}${path}`, {
    method: value === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Paddle-Version": "1",
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  return object((await providerJson(response)).data);
}

function assertPrice(
  price: Record<string, unknown>,
  order: CloudOrder,
  config: PaddleConfig,
) {
  const unit = object(price.unit_price);
  const cycle = object(price.billing_cycle);
  if (
    price.id !== priceId(order, config) ||
    unit.currency_code !== order.currency ||
    cents(unit.amount) !== order.amount_cents ||
    cycle.frequency !== 1 ||
    cycle.interval !== (order.term_months === 12 ? "year" : "month")
  ) {
    throw new BillingError("payment_price_mismatch");
  }
}

export async function validatePaddleCheckoutPrice(
  order: CloudOrder,
  config: PaddleConfig,
  request: Fetcher = fetch,
): Promise<void> {
  assertPaddleOrder(order, config);
  const price = await paddleRequest(
    `/prices/${encodeURIComponent(priceId(order, config))}`,
    config,
    request,
  );
  assertPrice(price, order, config);
  const quantity = object(price.quantity);
  if (
    price.status !== "active" || price.tax_mode !== "external" ||
    price.trial_period !== null ||
    !Array.isArray(price.unit_price_overrides) ||
    price.unit_price_overrides.length !== 0 ||
    quantity.minimum !== 1 || quantity.maximum !== 1
  ) {
    throw new BillingError("paddle_price_configuration_mismatch", 503);
  }
}

function assertTransaction(
  data: Record<string, unknown>,
  order: CloudOrder,
  config: PaddleConfig,
): void {
  assertPaddleOrder(order, config);
  const custom = object(data.custom_data);
  if (
    custom.tokentracker_order_id !== order.id ||
    custom.tokentracker_user_id !== order.user_id
  ) {
    throw new BillingError("payment_account_mismatch");
  }
  if (
    data.currency_code !== order.currency ||
    data.collection_mode !== "automatic"
  ) throw new BillingError("payment_currency_mismatch");
  if (!Array.isArray(data.items) || data.items.length !== 1) {
    throw new BillingError("payment_items_mismatch");
  }
  const item = object(data.items[0]);
  if (item.quantity !== 1 || item.proration != null) {
    throw new BillingError("payment_price_mismatch");
  }
  assertPrice(object(item.price), order, config);
  if (data.discount_id != null) {
    throw new BillingError("payment_amount_mismatch");
  }
}

export function paddleCheckoutBinding(
  data: unknown,
  order: CloudOrder,
  config: PaddleConfig,
) {
  const transaction = object(data);
  assertTransaction(transaction, order, config);
  const id = text(transaction.id);
  if (order.provider_order_id && order.provider_order_id !== id) return null;
  const checkout = transaction.checkout == null
    ? null
    : object(transaction.checkout);
  const url = typeof checkout?.url === "string" ? checkout.url : null;
  if (url) {
    const expected = new URL(config.checkoutPage);
    const returned = new URL(url);
    if (
      returned.origin !== expected.origin ||
      returned.pathname !== expected.pathname ||
      returned.searchParams.get("order") !== order.id ||
      returned.searchParams.get("_ptxn") !== id
    ) {
      throw new BillingError("invalid_provider_checkout_url", 502);
    }
  }
  return {
    transactionId: id,
    priceId: priceId(order, config),
    checkoutUrl: url,
  };
}

export async function createPaddleCheckout(
  order: CloudOrder,
  config: PaddleConfig,
  request: Fetcher = fetch,
) {
  if (!config.apiKey || !priceId(order, config)) {
    throw new BillingError("paddle_not_configured", 503);
  }
  if (
    order.provider !== "paddle" || order.environment !== config.environment ||
    order.currency !== "USD"
  ) {
    throw new BillingError("invalid_checkout_provider");
  }
  const checkout = new URL(config.checkoutPage);
  if (
    checkout.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(checkout.hostname)
  ) {
    throw new BillingError("invalid_checkout_configuration", 503);
  }
  checkout.searchParams.set("order", order.id);
  await validatePaddleCheckoutPrice(order, config, request);
  const data = await paddleRequest("/transactions", config, request, {
    items: [{ price_id: priceId(order, config), quantity: 1 }],
    currency_code: order.currency,
    collection_mode: "automatic",
    custom_data: {
      tokentracker_order_id: order.id,
      tokentracker_user_id: order.user_id,
    },
    checkout: { url: checkout.toString() },
  });
  const binding = paddleCheckoutBinding(data, order, config);
  if (!binding?.checkoutUrl) {
    throw new BillingError("invalid_provider_checkout_url", 502);
  }
  return { ...binding, checkoutUrl: binding.checkoutUrl };
}

export async function queryPaddleOrder(
  order: CloudOrder,
  config: PaddleConfig,
  request: Fetcher = fetch,
) {
  assertPaddleOrder(order, config);
  if (!order.provider_order_id) {
    throw new BillingError("checkout_confirmation_pending", 409);
  }
  const data = await paddleRequest(
    `/transactions/${encodeURIComponent(order.provider_order_id)}`,
    config,
    request,
  );
  if (data.id !== order.provider_order_id) {
    throw new BillingError("payment_order_mismatch");
  }
  assertTransaction(data, order, config);
  return data;
}

export async function queryPaddleSubscription(
  order: CloudOrder,
  subscriptionId: string,
  config: PaddleConfig,
  request: Fetcher = fetch,
) {
  assertPaddleOrder(order, config);
  const data = await paddleRequest(
    `/subscriptions/${encodeURIComponent(text(subscriptionId))}`,
    config,
    request,
  );
  if (data.id !== subscriptionId) {
    throw new BillingError("payment_order_mismatch");
  }
  const custom = object(data.custom_data);
  if (
    custom.tokentracker_order_id !== order.id ||
    custom.tokentracker_user_id !== order.user_id
  ) throw new BillingError("payment_account_mismatch");
  return data;
}

export async function createPaddlePortal(
  order: CloudOrder,
  subscriptionId: string,
  config: PaddleConfig,
  request: Fetcher = fetch,
) {
  const subscription = await queryPaddleSubscription(
    order,
    subscriptionId,
    config,
    request,
  );
  const customerId = text(subscription.customer_id);
  const session = await paddleRequest(
    `/customers/${encodeURIComponent(customerId)}/portal-sessions`,
    config,
    request,
    { subscription_ids: [subscriptionId] },
  );
  if (session.customer_id !== customerId) {
    throw new BillingError("payment_account_mismatch");
  }
  const url = text(object(object(session.urls).general).overview, 8192);
  const parsed = new URL(url);
  const host = config.environment === "sandbox"
    ? "sandbox-customer-portal.paddle.com"
    : "customer-portal.paddle.com";
  if (parsed.protocol !== "https:" || parsed.hostname !== host) {
    throw new BillingError("invalid_provider_portal_url", 502);
  }
  return url;
}

export async function cancelPaddleSubscription(
  order: CloudOrder,
  subscriptionId: string,
  config: PaddleConfig,
  request: Fetcher = fetch,
) {
  const current = await queryPaddleSubscription(
    order,
    subscriptionId,
    config,
    request,
  );
  if (
    current.status === "canceled" ||
    (current.scheduled_change != null &&
      object(current.scheduled_change).action === "cancel")
  ) return current;
  const data = await paddleRequest(
    `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    config,
    request,
    { effective_from: current.status === "paused" ? "immediately" : "next_billing_period" },
  );
  const custom = object(data.custom_data);
  if (
    data.id !== subscriptionId || custom.tokentracker_order_id !== order.id ||
    custom.tokentracker_user_id !== order.user_id ||
    (data.status !== "canceled" &&
      object(data.scheduled_change).action !== "cancel")
  ) throw new BillingError("subscription_cancellation_pending", 502);
  return data;
}

export async function verifyPaddleSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs = Date.now(),
): Promise<void> {
  if (!secret) throw new BillingError("paddle_not_configured", 503);
  if (!header) throw new BillingError("invalid_signature", 401);
  const timestamps: string[] = [];
  const signatures: string[] = [];
  for (const segment of header.split(";")) {
    const [key, value] = segment.trim().split("=");
    if (key === "ts" && value) timestamps.push(value);
    if (key === "h1" && value) signatures.push(value);
  }
  if (timestamps.length !== 1 || signatures.length === 0) {
    throw new BillingError("invalid_signature", 401);
  }
  freshTimestamp(timestamps[0], nowMs, 5);
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  for (const signature of signatures) {
    if (
      /^[0-9a-f]{64}$/i.test(signature) &&
      await crypto.subtle.verify(
        "HMAC",
        key,
        hexBytes(signature),
        bytes(`${timestamps[0]}:${rawBody}`),
      )
    ) return;
  }
  throw new BillingError("invalid_signature", 401);
}

export interface PaddleResolver {
  order(id: string): Promise<CloudOrder>;
  transactionOrder(transactionId: string): Promise<CloudOrder>;
}

export async function normalizePaddleEvent(
  payload: unknown,
  config: PaddleConfig,
  resolver: PaddleResolver,
): Promise<PaymentEvent | null> {
  const event = object(payload);
  const type = text(event.event_type);
  if (
    type !== "transaction.completed" && !type.startsWith("subscription.") &&
    type !== "adjustment.created" && type !== "adjustment.updated"
  ) return null;
  const data = object(event.data);
  const eventId = text(event.event_id);
  const occurredAt = isoDate(
    type.startsWith("subscription.")
      ? data.updated_at || event.occurred_at
      : event.occurred_at,
  );
  if (type.startsWith("adjustment.")) {
    if (
      data.status !== "approved" ||
      !["refund", "chargeback"].includes(String(data.action))
    ) return null;
    const transactionId = text(data.transaction_id);
    const order = await resolver.transactionOrder(transactionId);
    assertPaddleOrder(order, config);
    if (data.currency_code !== order.currency) {
      throw new BillingError("payment_currency_mismatch");
    }
    return {
      event_id: eventId,
      kind: "refund",
      action_id: text(data.id),
      order_id: order.id,
      occurred_at: occurredAt,
      transaction_id: transactionId,
      currency: order.currency,
      amount_cents: cents(object(data.totals).total),
    };
  }
  const custom = object(data.custom_data);
  const order = await resolver.order(uuid(custom.tokentracker_order_id));
  assertPaddleOrder(order, config);
  if (custom.tokentracker_user_id !== order.user_id) {
    throw new BillingError("payment_account_mismatch");
  }
  const items = data.items;
  if (!Array.isArray(items) || items.length !== 1) {
    throw new BillingError("payment_items_mismatch");
  }
  const item = object(items[0]);
  const price = object(item.price);
  if (item.quantity !== 1 || price.id !== priceId(order, config)) {
    throw new BillingError("payment_price_mismatch");
  }
  assertPrice(price, order, config);
  if (type === "transaction.completed") {
    assertTransaction(data, order, config);
    if (data.status !== "completed" || data.currency_code !== order.currency) {
      throw new BillingError("payment_not_completed");
    }
    const totals = object(object(data.details).totals);
    if (
      totals.currency_code !== order.currency ||
      cents(totals.subtotal) !== order.amount_cents ||
      cents(totals.discount) !== 0 || cents(totals.credit) !== 0
    ) throw new BillingError("payment_amount_mismatch");
    const period = object(data.billing_period);
    return {
      event_id: eventId,
      kind: "payment",
      action_id: text(data.id),
      order_id: order.id,
      occurred_at: occurredAt,
      subscription_id: text(data.subscription_id),
      currency: order.currency,
      base_amount_cents: order.amount_cents,
      amount_cents: cents(totals.grand_total),
      starts_at: isoDate(period.starts_at),
      ends_at: isoDate(period.ends_at),
    };
  }
  if (
    !["active", "canceled", "past_due", "paused", "trialing"].includes(
      String(data.status),
    )
  ) {
    throw new BillingError("invalid_subscription_status");
  }
  const scheduled = data.scheduled_change == null
    ? null
    : object(data.scheduled_change);
  return {
    event_id: eventId,
    kind: "subscription",
    action_id: eventId,
    order_id: order.id,
    occurred_at: occurredAt,
    subscription_id: text(data.id),
    status: String(data.status),
    cancel_at_period_end: scheduled?.action === "cancel",
    next_billed_at:data.next_billed_at == null ? null : isoDate(data.next_billed_at),
  };
}

function assertPaddleOrder(order: CloudOrder, config: PaddleConfig): void {
  if (
    order.provider !== "paddle" || order.environment !== config.environment ||
    order.currency !== "USD"
  ) {
    throw new BillingError("payment_order_mismatch");
  }
}
