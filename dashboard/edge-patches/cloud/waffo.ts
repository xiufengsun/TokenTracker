import { WaffoPancake, verifyWebhook, type WebhookEvent, type WebhookPublicKeys } from "npm:@waffo/pancake-ts@0.25.0";
import {
  type BillingEnvironment, BillingError, cents, type CloudOrder, decimalCents,
  type Fetcher, isoDate, object, type PaymentEvent, text, uuid,
} from "./contracts.ts";
import { pemBytes } from "./cryptography.ts";

export interface WaffoConfig {
  environment: BillingEnvironment;
  merchantId: string;
  privateKey: string;
  storeId: string;
  productIds: Record<string, string>;
  checkoutPage: string;
  livePrivateKeySha256?: string;
  webhookPublicKey?: WebhookPublicKeys;
}

export interface WaffoPeriod {
  waffo_order_id?: string;
  provider_price_id?: string;
  period_number: number;
  starts_at: string;
  ends_at: string;
}

type WaffoEvent = Omit<PaymentEvent, "kind"> & {
  kind: PaymentEvent["kind"] | "authorization";
  waffo_order_id: string;
  provider_price_id: string;
  period_number?: number;
};
type BoundOrder = CloudOrder & { waffo_order_id?: string | null; billing_mode?: "fixed" | "recurring" };
type ProviderOrder = Record<string, unknown>;

function mode(config: WaffoConfig): "test" | "prod" {
  if (config.environment !== "sandbox" && config.environment !== "live") {
    throw new BillingError("invalid_billing_environment");
  }
  return config.environment === "sandbox" ? "test" : "prod";
}

function shortId(value: unknown, prefix: string): string {
  const id = text(value);
  if (!new RegExp(`^${prefix}_[0-9A-Za-z]{22}$`).test(id)) {
    throw new BillingError("invalid_provider_identifier");
  }
  return id;
}

function assertOrder(order: CloudOrder, config: WaffoConfig): void {
  uuid(order.id);
  uuid(order.user_id);
  mode(config);
  if (String(order.provider) !== "waffo" || order.environment !== config.environment ||
      ![1, 12].includes(order.term_months)) throw new BillingError("invalid_checkout_provider");
  const billingMode = (order as BoundOrder).billing_mode;
  if (order.currency !== "USD" || !["fixed", "recurring"].includes(billingMode || "") ||
      !cents(order.amount_cents) ||
      order.sku !== `cloud_usd_${order.term_months === 12 ? "yearly" : "monthly"}${billingMode === "fixed" ? "_fixed" : ""}`) {
    throw new BillingError("payment_price_mismatch");
  }
}

export function waffoProductId(order: CloudOrder, config: WaffoConfig): string {
  assertOrder(order, config);
  const id = order.provider_price_id || config.productIds[order.sku];
  if (!id) throw new BillingError("waffo_not_configured", 503);
  return shortId(id, "PROD");
}

function client(config: WaffoConfig, request: Fetcher): WaffoPancake {
  if (!config.privateKey) throw new BillingError("waffo_not_configured", 503);
  shortId(config.merchantId, "MER");
  shortId(config.storeId, "STO");
  try {
    return new WaffoPancake({
      merchantId: config.merchantId, privateKey: config.privateKey, environment: mode(config),
      fetch: async (url, init) => {
        const response = await request(url, { ...init, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new BillingError("payment_provider_unavailable", 502);
        if (!response.body) return response;
        if (Number(response.headers.get("Content-Length")) > 8 * 1024 * 1024) {
          await response.body.cancel();
          throw new BillingError("waffo_snapshot_too_large", 503);
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new BillingError("waffo_snapshot_too_large", 503);
          }
          chunks.push(part.value);
        }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const part of chunks) { body.set(part, offset); offset += part.byteLength; }
        return new Response(body, { status: response.status, headers: response.headers });
      },
    });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError("waffo_not_configured", 503);
  }
}

async function providerCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError("payment_provider_unavailable", 502);
  }
}

async function query(config: WaffoConfig, request: Fetcher, document: string, variables: Record<string, unknown>) {
  const result = await providerCall(() => client(config, request).graphql.query({ query: document, variables }));
  if (result.errors?.length || result.data == null) throw new BillingError("payment_provider_unavailable", 502);
  return object(result.data);
}

function metadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return object(JSON.parse(value)); }
    catch { throw new BillingError("invalid_provider_payload"); }
  }
  return object(value);
}

function assertPrices(prices: unknown, order: CloudOrder): void {
  if (!Array.isArray(prices)) throw new BillingError("invalid_provider_payload");
  const rows = prices.map(object).filter(p => p.currency === order.currency);
  if (rows.length !== 1) throw new BillingError("payment_currency_mismatch");
  const price = object(rows[0].priceInfo);
  if (decimalCents(price.amount) !== order.amount_cents || price.taxCategory !== "saas" || price.trialAmount != null) {
    throw new BillingError("payment_price_mismatch");
  }
}

function assertNoTrial(value: unknown): void {
  const meta = metadata(value);
  if (meta.trialDays != null && meta.trialDays !== 0) throw new BillingError("waffo_trial_configuration_mismatch", 503);
}

async function assertVerifiedLiveKey(config: WaffoConfig): Promise<void> {
  // This pin binds the key file that the operator verified as production.
  // Matching key material does not itself prove a provider environment.
  const expected = config.livePrivateKeySha256;
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/i.test(expected)) {
    throw new BillingError("waffo_live_key_not_verified", 503);
  }
  try {
    const pem = config.privateKey.trim();
    if (!/^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----\s*[A-Za-z0-9+/=\s]+-----END \1-----$/.test(pem)) throw Error();
    const material = pemBytes(pem);
    if (!material.length) throw Error();
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", material)))
      .map(value => value.toString(16).padStart(2, "0")).join("");
    if (actual !== expected.toLowerCase()) throw Error();
  } catch { throw new BillingError("waffo_live_key_not_verified", 503); }
}

export async function validateWaffoProduct(order: CloudOrder, config: WaffoConfig, request: Fetcher = fetch): Promise<void> {
  const id = waffoProductId(order, config);
  const live = config.environment === "live";
  if (live) await assertVerifiedLiveKey(config);
  const subscription = (order as BoundOrder).billing_mode === "recurring";
  const field = subscription ? "subscriptionProduct" : "onetimeProduct";
  const data = await query(config, request, `query ($id: String!${live ? ", $storeId: String!" : ""}) {
    ${live ? "store(id: $storeId) { id prodEnabled }" : ""}
    ${field}(id: $id) { id storeId status metadata ${live ? "hasProdVersion" : ""} ${subscription ? "billingPeriod" : ""}
      prices { currency priceInfo { amount taxCategory ${subscription ? "trialAmount" : ""} } } }
  }`, { id, ...(live ? { storeId: config.storeId } : {}) });
  const product = object(data[field]);
  const store = live ? object(data.store || {}) : {};
  if (product.id !== id || product.storeId !== config.storeId || product.status !== "active" ||
      (subscription && product.billingPeriod !== (order.term_months === 12 ? "yearly" : "monthly")) ||
      (live && (product.hasProdVersion !== true || store.id !== config.storeId || store.prodEnabled !== true))) {
    throw new BillingError("waffo_product_configuration_mismatch", 503);
  }
  assertPrices(product.prices, order);
  assertNoTrial(product.metadata);
}

export async function createWaffoCheckout(order: CloudOrder, config: WaffoConfig, request: Fetcher = fetch) {
  const id = waffoProductId(order, config);
  let success: URL;
  try { success = new URL(config.checkoutPage); }
  catch { throw new BillingError("invalid_checkout_configuration", 503); }
  if (success.protocol !== "https:" || success.username || success.password) {
    throw new BillingError("invalid_checkout_configuration", 503);
  }
  success.searchParams.set("order", order.id);
  await validateWaffoProduct(order, config, request);
  const result = await providerCall(() => client(config, request).checkout.createSession({
    productId: id, currency: order.currency, withTrial: false,
    successUrl: success.toString(), expiresInSeconds: 1800,
    orderMerchantExternalId: order.id,
    metadata: { tokentracker_order_id: order.id, tokentracker_user_id: order.user_id,
      tokentracker_environment: order.environment },
  }, { idempotencyKey: `tokentracker-${config.environment}-checkout-${order.id}` }));
  const sessionId = text(result.sessionId);
  if (!/^cs_[0-9A-Za-z_-]+$/.test(sessionId)) throw new BillingError("invalid_provider_identifier");
  let checkout: URL;
  try { checkout = new URL(text(result.checkoutUrl, 8192)); }
  catch { throw new BillingError("invalid_provider_checkout_url", 502); }
  if (checkout.protocol !== "https:" || checkout.hostname !== "pancake.waffo.ai" || checkout.port ||
      checkout.username || checkout.password || !checkout.pathname.endsWith(`/checkout/${sessionId}`) ||
      !checkout.pathname.startsWith("/store/")) throw new BillingError("invalid_provider_checkout_url", 502);
  if (config.environment === "sandbox") checkout.searchParams.set("test", "true");
  else if (checkout.searchParams.has("test")) throw new BillingError("invalid_provider_checkout_url", 502);
  isoDate(result.expiresAt);
  return { checkoutUrl: checkout.toString(), sessionId, priceId: id };
}

export function verifyWaffoWebhook(raw: string, signature: string | null, config: WaffoConfig): WebhookEvent {
  let event: WebhookEvent;
  try { event = verifyWebhook(raw, signature, { environment: mode(config), publicKeys: config.webhookPublicKey }); }
  catch { throw new BillingError("invalid_signature", 401); }
  const payload = object(event);
  if (payload.mode !== mode(config) || payload.storeId !== config.storeId) {
    throw new BillingError("payment_environment_mismatch", 401);
  }
  text(payload.id);
  text(payload.eventId);
  text(payload.eventType);
  isoDate(payload.timestamp);
  object(payload.data);
  return event;
}

const moneyFields = "amount currency display";
const breakdownFields = "currency subtotal taxAmount total taxCategory";
const paymentFields = `id orderId status testMode periodNumber orderMerchantExternalId createdAt
  amount { ${moneyFields} } snapshotAmountDetails { ${breakdownFields} phase }
  pspAmountDetails { amount currency }
  refunds { id paymentId status testMode orderMerchantExternalId createdAt
    amount { ${moneyFields} } pspAmountDetails { amount currency } }`;

async function providerOrders(order: BoundOrder, config: WaffoConfig, request: Fetcher): Promise<ProviderOrder[]> {
  const id = waffoProductId(order, config);
  const subscription = (order as BoundOrder).billing_mode === "recurring";
  const field = subscription ? "subscriptionOrders" : "onetimeOrders";
  const subscriptionFields = `billingPeriod isInTrial willRenew currentPeriodStart currentPeriodEnd currentPeriodNumber
    changeOriginOrderId supersededByOrderId`;
  const document = `query ($storeId: String!, $ref: String!, $offset: Int!) {
    ${field}(storeId: $storeId, filter: { orderMerchantExternalId: { eq: $ref } }, limit: 100, offset: $offset) {
      id storeId status currency testMode orderMerchantExternalId merchantProvidedBuyerIdentity metadata createdAt updatedAt
      ${subscription ? subscriptionFields : ""}
      productVersion { id productId metadata ${subscription ? "billingPeriod" : ""}
        prices { currency priceInfo { amount taxCategory ${subscription ? "trialAmount" : ""} } } }
      priceSnapshot { currency ${subscription ? `specialPhaseDays specialPhase { subtotal taxAmount total taxCategory }
        regularPhase { subtotal taxAmount total taxCategory }` : "subtotal taxAmount total taxCategory"} }
      payments { ${paymentFields} }
    }
    ${field}Count(storeId: $storeId, filter: { orderMerchantExternalId: { eq: $ref } })
  }`;
  const all: ProviderOrder[] = [];
  const ids = new Set<string>();
  let total: number | null = null;
  for (let offset = 0; ; offset += 100) {
    const data = await query(config, request, document, { storeId: config.storeId, ref: order.id, offset });
    const rows = data[field];
    const count = data[`${field}Count`];
    if (!Array.isArray(rows) || !Number.isSafeInteger(count) || Number(count) < 0) {
      throw new BillingError("invalid_provider_payload");
    }
    if (Number(count) > 1000) throw new BillingError("waffo_attempt_limit_exceeded", 503);
    if (total !== null && total !== count) throw new BillingError("waffo_notification_pending", 503);
    total = Number(count);
    if (rows.length > 100 || (rows.length === 0 && all.length < total)) {
      throw new BillingError("waffo_notification_pending", 503);
    }
    for (const value of rows) {
      const remote = validateProviderOrder(value, order, config, id, subscription);
      const remoteId = text(remote.id);
      if (ids.has(remoteId)) throw new BillingError("ambiguous_payment_binding", 409);
      ids.add(remoteId);
      all.push(remote);
    }
    if (all.length === total) return all;
    if (all.length > total) throw new BillingError("invalid_provider_payload");
  }
}

function validateProviderOrder(value: unknown, order: BoundOrder, config: WaffoConfig,
  id: string, subscription: boolean): ProviderOrder {
  const remote = object(value);
  shortId(remote.id, "ORD");
  if (remote.storeId !== config.storeId || remote.testMode !== (mode(config) === "test") ||
      remote.orderMerchantExternalId !== order.id) {
    throw new BillingError("payment_order_mismatch");
  }
  const meta = metadata(remote.metadata);
  if (meta.tokentracker_order_id !== order.id || meta.tokentracker_user_id !== order.user_id ||
      meta.tokentracker_environment !== order.environment) throw new BillingError("payment_account_mismatch");
  const version = object(remote.productVersion);
  if (version.productId !== id || remote.currency !== order.currency ||
      (subscription && (remote.billingPeriod !== (order.term_months === 12 ? "yearly" : "monthly") ||
       version.billingPeriod !== remote.billingPeriod || remote.isInTrial !== false ||
       remote.changeOriginOrderId != null || remote.supersededByOrderId != null))) {
    throw new BillingError("payment_price_mismatch");
  }
  assertPrices(version.prices, order);
  assertNoTrial(version.metadata);
  const snapshot = object(remote.priceSnapshot);
  if (snapshot.currency !== order.currency) throw new BillingError("payment_currency_mismatch");
  if (subscription && (snapshot.specialPhaseDays != null || snapshot.specialPhase != null)) {
    throw new BillingError("payment_price_mismatch");
  }
  assertBreakdown(subscription ? object(snapshot.regularPhase) : snapshot, order);
  isoDate(remote.createdAt);
  isoDate(remote.updatedAt);
  return remote;
}

async function providerOrder(order: BoundOrder, config: WaffoConfig, request: Fetcher,
  targetId?: string): Promise<ProviderOrder | null> {
  const rows = await providerOrders(order, config, request);
  if (targetId) return rows.find(remote => remote.id === targetId) || null;
  if (rows.length > 1) throw new BillingError("ambiguous_payment_binding", 409);
  return rows[0] || null;
}

function assertBreakdown(snapshot: Record<string, unknown>, order: CloudOrder): number {
  const subtotal = decimalCents(snapshot.subtotal);
  const tax = decimalCents(snapshot.taxAmount);
  const total = decimalCents(snapshot.total);
  if (subtotal !== order.amount_cents || subtotal + tax !== total || snapshot.taxCategory !== "saas") {
    throw new BillingError("payment_amount_mismatch");
  }
  return total;
}

function money(value: unknown, currency: string): number {
  const amount = object(value);
  const minor = cents(amount.amount);
  if (amount.currency !== currency || decimalCents(amount.display) !== minor) {
    throw new BillingError("payment_amount_mismatch");
  }
  return minor;
}

function pspMoney(value: unknown, currency: string): number {
  const amount = object(value);
  if (amount.currency !== currency) throw new BillingError("payment_currency_mismatch");
  return decimalCents(amount.amount);
}

function isZeroAuthorization(payment: Record<string, unknown>, order: BoundOrder): boolean {
  if (order.billing_mode !== "recurring" || payment.status !== "succeeded" || payment.periodNumber !== 0) return false;
  const snapshot = object(payment.snapshotAmountDetails);
  if (snapshot.currency !== order.currency || snapshot.phase !== "regular") throw new BillingError("payment_currency_mismatch");
  assertBreakdown(snapshot, order);
  const amount = pspMoney(payment.pspAmountDetails, order.currency);
  if (money(payment.amount, order.currency) !== amount) throw new BillingError("payment_amount_mismatch");
  return amount === 0 && Array.isArray(payment.refunds) && payment.refunds.length === 0;
}

function period(value: WaffoPeriod, remoteId: string, priceId: string): WaffoPeriod {
  if (!Number.isSafeInteger(value.period_number) || value.period_number < 1 ||
      (value.waffo_order_id && value.waffo_order_id !== remoteId) ||
      (value.provider_price_id && value.provider_price_id !== priceId)) throw new BillingError("invalid_billing_period");
  const starts_at = isoDate(value.starts_at);
  const ends_at = isoDate(value.ends_at);
  if (Date.parse(ends_at) <= Date.parse(starts_at)) throw new BillingError("invalid_billing_period");
  return { waffo_order_id: remoteId, provider_price_id: priceId, period_number: value.period_number, starts_at, ends_at };
}

function currentPeriod(remote: ProviderOrder, priceId: string, order: CloudOrder): WaffoPeriod | null {
  if (remote.currentPeriodStart == null || remote.currentPeriodEnd == null || remote.currentPeriodNumber == null ||
      remote.currentPeriodNumber === 0) return null;
  if (["past_due","canceling","canceled","closed","expired"].includes(String(remote.status))) {
    if (!Array.isArray(remote.payments)) throw new BillingError("invalid_provider_payload");
    const paidCurrent = remote.payments.some(value => {
      const payment = object(value);
      if (payment.status !== "succeeded" || payment.periodNumber !== remote.currentPeriodNumber) return false;
      if (payment.orderId !== remote.id || payment.orderMerchantExternalId !== order.id ||
        payment.testMode !== remote.testMode) throw new BillingError("payment_order_mismatch");
      const actual = pspMoney(payment.pspAmountDetails,order.currency);
      if (money(payment.amount,order.currency) !== actual) throw new BillingError("payment_amount_mismatch");
      if (!actual) return false;
      const snapshot = object(payment.snapshotAmountDetails);
      if (snapshot.currency !== order.currency || snapshot.phase !== "regular" || assertBreakdown(snapshot,order) !== actual) {
        throw new BillingError("payment_amount_mismatch");
      }
      return true;
    });
    // Failed renewals expose a short collection grace window, not purchased time.
    if (!paidCurrent) return null;
  }
  return period({ period_number: remote.currentPeriodNumber as number,
    starts_at: remote.currentPeriodStart as string, ends_at: remote.currentPeriodEnd as string }, text(remote.id), priceId);
}

export async function queryWaffoPeriod(order: BoundOrder, config: WaffoConfig, request: Fetcher = fetch): Promise<WaffoPeriod | null> {
  if (order.billing_mode !== "recurring") { assertOrder(order, config); return null; }
  return (await queryWaffoBinding(order, config, request))?.current_period || null;
}

export async function queryWaffoBindings(order: BoundOrder, config: WaffoConfig, request: Fetcher = fetch) {
  const remotes = await providerOrders(order, config, request);
  const priceId = waffoProductId(order, config);
  return remotes.map(remote => ({ waffo_order_id: shortId(remote.id, "ORD"), provider_price_id: priceId,
    current_period: order.billing_mode === "recurring" ? currentPeriod(remote, priceId, order) : null }));
}

export async function queryWaffoBinding(order: BoundOrder, config: WaffoConfig, request: Fetcher = fetch) {
  const remote = await providerOrder(order, config, request);
  if (!remote) return null;
  const priceId = waffoProductId(order, config);
  return { waffo_order_id: shortId(remote.id, "ORD"), provider_price_id: priceId,
    current_period: order.billing_mode === "recurring" ? currentPeriod(remote, priceId, order) : null };
}

export async function queryWaffoOrder(order: BoundOrder, config: WaffoConfig, request: Fetcher = fetch,
  periods: WaffoPeriod[] = []): Promise<WaffoEvent[]> {
  const remotes = await providerOrders(order, config, request);
  if (order.waffo_order_id && !remotes.some(remote => remote.id === order.waffo_order_id)) {
    throw new BillingError("payment_order_mismatch");
  }
  const events = remotes.flatMap(remote => normalizeWaffoOrder(remote, order, config, periods));
  if (order.provider_order_id && !events.some(event => event.kind === "payment" && event.action_id === order.provider_order_id)) {
    throw new BillingError("payment_order_mismatch");
  }
  const actions = new Set<string>();
  for (const event of events) {
    if (event.kind === "subscription") continue;
    const key = `${event.kind}:${event.action_id}`;
    if (actions.has(key)) throw new BillingError("ambiguous_payment_binding", 409);
    actions.add(key);
  }
  const precedence = { authorization: 0, payment: 1, refund: 2, subscription: 3 };
  return events.sort((a, b) => precedence[a.kind] - precedence[b.kind] || Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
}

function normalizeWaffoOrder(remote: ProviderOrder, order: BoundOrder, config: WaffoConfig,
  periods: WaffoPeriod[]): WaffoEvent[] {
  const remoteId = text(remote.id);
  const priceId = waffoProductId(order, config);
  const subscription = (order as BoundOrder).billing_mode === "recurring";
  const current = subscription ? currentPeriod(remote, priceId, order) : null;
  const cache = new Map<number, WaffoPeriod>();
  for (const value of [...periods.filter(value => value.waffo_order_id === remoteId), ...(current ? [current] : [])]) {
    const checked = period(value, remoteId, priceId);
    const previous = cache.get(checked.period_number);
    if (previous && (previous.starts_at !== checked.starts_at || previous.ends_at !== checked.ends_at)) {
      throw new BillingError("waffo_billing_period_conflict", 409);
    }
    cache.set(checked.period_number, checked);
  }
  if (!Array.isArray(remote.payments)) throw new BillingError("invalid_provider_payload");
  const payments = remote.payments.map(object).filter(p => p.status === "succeeded")
    .sort((a, b) => Date.parse(isoDate(a.createdAt)) - Date.parse(isoDate(b.createdAt)));
  const events: WaffoEvent[] = [];
  const paymentIds = new Set<string>();
  const refundIds = new Set<string>();
  for (const payment of payments) {
    const paymentId = shortId(payment.id, "PAY");
    if (paymentIds.has(paymentId)) throw new BillingError("ambiguous_payment_binding", 409);
    paymentIds.add(paymentId);
    if (payment.orderId !== remoteId || payment.testMode !== (mode(config) === "test") ||
        payment.orderMerchantExternalId !== order.id) throw new BillingError("payment_order_mismatch");
    const snapshot = object(payment.snapshotAmountDetails);
    if (snapshot.currency !== order.currency || (subscription && snapshot.phase !== "regular")) {
      throw new BillingError("payment_currency_mismatch");
    }
    const total = assertBreakdown(snapshot, order);
    const actual = pspMoney(payment.pspAmountDetails, order.currency);
    if (money(payment.amount, order.currency) !== actual) {
      throw new BillingError("payment_amount_mismatch");
    }
    if (isZeroAuthorization(payment, order)) {
      events.push({ event_id: `waffo_${config.environment}_authorization_${paymentId}`, kind: "authorization", action_id: paymentId,
        order_id: order.id, occurred_at: isoDate(payment.createdAt), transaction_id: paymentId,
        waffo_order_id: remoteId, provider_price_id: priceId, currency: order.currency,
        base_amount_cents: order.amount_cents, amount_cents: 0, subscription_id: remoteId, period_number: 0 });
      continue;
    }
    if (actual !== total) throw new BillingError("payment_amount_mismatch");
    const paidPeriod = subscription ? cache.get(payment.periodNumber as number) : null;
    if (subscription && !paidPeriod) throw new BillingError("waffo_billing_period_pending", 503);
    events.push({ event_id: `waffo_${config.environment}_payment_${paymentId}`, kind: "payment", action_id: paymentId,
      order_id: order.id, occurred_at: isoDate(payment.createdAt), transaction_id: paymentId,
      waffo_order_id: remoteId, provider_price_id: priceId, currency: order.currency,
      base_amount_cents: order.amount_cents, amount_cents: actual,
      ...(paidPeriod ? { subscription_id: remoteId, period_number: paidPeriod.period_number,
        starts_at: paidPeriod.starts_at, ends_at: paidPeriod.ends_at } : {}) });
    if (!Array.isArray(payment.refunds)) throw new BillingError("invalid_provider_payload");
    let refunded = 0;
    for (const entry of payment.refunds) {
      const refund = object(entry);
      if (refund.status !== "succeeded") continue;
      const refundId = shortId(refund.id, "(?:RFD|REF)");
      if (refundIds.has(refundId)) throw new BillingError("ambiguous_payment_binding", 409);
      refundIds.add(refundId);
      if (refund.paymentId !== paymentId || refund.testMode !== (mode(config) === "test") ||
          refund.orderMerchantExternalId !== order.id) throw new BillingError("payment_order_mismatch");
      const amount = pspMoney(refund.pspAmountDetails, order.currency);
      refunded += amount;
      if (!amount || amount !== money(refund.amount, order.currency) || refunded > actual) {
        throw new BillingError("payment_amount_mismatch");
      }
      events.push({ event_id: `waffo_${config.environment}_refund_${refundId}`, kind: "refund", action_id: refundId,
        order_id: order.id, occurred_at: isoDate(refund.createdAt), transaction_id: paymentId,
        waffo_order_id: remoteId, provider_price_id: priceId, currency: order.currency, amount_cents: amount,
        ...(subscription ? { subscription_id: remoteId } : {}) });
    }
  }
  if (subscription && remote.status !== "pending") {
    const status = remote.status === "canceling" ? "active" : remote.status;
    if (!["active", "past_due", "canceled", "expired", "closed"].includes(String(status))) {
      throw new BillingError("invalid_provider_subscription_status");
    }
    const updated = isoDate(remote.updatedAt);
    const canceled = remote.status === "canceling";
    if (typeof remote.willRenew !== "boolean") throw new BillingError("invalid_provider_payload");
    events.push({ event_id: `waffo_${config.environment}_subscription_${remoteId}_${updated}`, kind: "subscription",
      action_id: `${remoteId}:${updated}`, order_id: order.id, occurred_at: updated,
      subscription_id: remoteId, waffo_order_id: remoteId, provider_price_id: priceId,
      status: status === "expired" || status === "closed" ? "canceled" : String(status),
      cancel_at_period_end: canceled, next_billed_at: status === "active" && !canceled && remote.willRenew && current ? current.ends_at : null,
      ...(current ? { starts_at: current.starts_at, ends_at: current.ends_at, period_number: current.period_number } : {}) });
  }
  return events;
}

export async function cancelWaffoSubscription(order: BoundOrder, subscriptionId: string, config: WaffoConfig,
  request: Fetcher = fetch) {
  assertOrder(order, config);
  if (order.billing_mode !== "recurring") throw new BillingError("invalid_checkout_provider");
  const id = shortId(subscriptionId, "ORD");
  const remote = await providerOrder(order, config, request, id);
  if (!remote || remote.id !== id) throw new BillingError("payment_order_mismatch");
  if (remote.status === "canceling" || remote.status === "canceled") {
    return { orderId: id, status: remote.status };
  }
  const version = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text(remote.updatedAt))));
  const operation = Array.from(version, byte => byte.toString(16).padStart(2, "0")).join("");
  const result = await providerCall(() => client(config, request).orders.cancelSubscription({ orderId: id },
    { idempotencyKey: `tokentracker-${config.environment}-cancel-${order.id}-${operation}` }));
  if (result.orderId !== id || !["canceling", "canceled"].includes(result.status)) {
    throw new BillingError("invalid_provider_subscription_status");
  }
  const confirmed = await providerOrder(order, config, request, id);
  if (!confirmed || confirmed.id !== id || !["canceling", "canceled"].includes(String(confirmed.status))) {
    throw new BillingError("subscription_cancellation_pending", 503);
  }
  return { orderId: id, status: String(confirmed.status) };
}

function assertUnpaid(remote: ProviderOrder, order: CloudOrder, config: WaffoConfig): void {
  if (!["pending", "canceled", "closed", "expired"].includes(String(remote.status)) || !Array.isArray(remote.payments) ||
      remote.payments.some(payment => !["failed", "canceled", "expired"].includes(String(object(payment).status)) &&
        !isZeroAuthorization(object(payment), order))) {
    throw new BillingError("checkout_confirmation_pending", 409);
  }
  for (const value of remote.payments) {
    const payment = object(value);
    shortId(payment.id, "PAY");
    if (payment.orderId !== remote.id || payment.testMode !== (mode(config) === "test") ||
        payment.orderMerchantExternalId !== order.id) throw new BillingError("payment_order_mismatch");
  }
}

async function closeSingleUnpaidWaffoOrder(order: BoundOrder, targetId: string, config: WaffoConfig, request: Fetcher = fetch): Promise<string> {
  const remote = await providerOrder(order, config, request, targetId);
  if (!remote) throw new BillingError("checkout_confirmation_pending", 409);
  if (order.provider_order_id) throw new BillingError("checkout_confirmation_pending", 409);
  assertUnpaid(remote, order, config);
  const id = shortId(remote.id, "ORD");
  if (["canceled", "closed", "expired"].includes(String(remote.status))) {
    const confirmed = await providerOrder(order, config, request, targetId);
    if (!confirmed || confirmed.id !== id || !["canceled", "closed", "expired"].includes(String(confirmed.status))) {
      throw new BillingError("checkout_confirmation_pending", 409);
    }
    assertUnpaid(confirmed, order, config);
    return id;
  }
  const api = client(config, request);
  const options = { idempotencyKey: `tokentracker-${config.environment}-close-${order.id}-${id}` };
  let result: { orderId: string; status: string };
  if (order.billing_mode === "recurring") {
    result = await providerCall(() => api.orders.cancelSubscription({ orderId: id }, options));
  } else {
    if (!remote.merchantProvidedBuyerIdentity) throw new BillingError("checkout_confirmation_pending", 409);
    const session = await providerCall(() => api.auth.issueSessionToken({
      storeId: config.storeId, buyerIdentity: text(remote.merchantProvidedBuyerIdentity, 512),
    }));
    const customer = api.customer(text(session.token, 8192), { environment: mode(config) });
    const visible = await providerCall(() => customer.graphql.query({ query: `query ($id: String!) {
      onetimeOrder(id: $id) { id storeId currency testMode orderMerchantExternalId productVersion { productId } }
    }`, variables: { id } }));
    if (visible.errors?.length || visible.data == null) throw new BillingError("payment_provider_unavailable", 502);
    const owned = object(object(visible.data).onetimeOrder);
    if (owned.id !== id || owned.storeId !== config.storeId || owned.currency !== order.currency ||
        owned.testMode !== (mode(config) === "test") || owned.orderMerchantExternalId !== order.id ||
        object(owned.productVersion).productId !== waffoProductId(order, config)) {
      throw new BillingError("payment_order_mismatch");
    }
    result = await providerCall(() => customer.cancelOnetimeOrder({ orderId: id }, options));
  }
  if (result.orderId !== id || result.status !== "canceled") throw new BillingError("checkout_confirmation_pending", 409);
  const confirmed = await providerOrder(order, config, request, targetId);
  if (!confirmed || confirmed.id !== id || confirmed.status !== "canceled") {
    throw new BillingError("checkout_confirmation_pending", 409);
  }
  assertUnpaid(confirmed, order, config);
  return id;
}

export async function closeUnpaidWaffoAttempts(order: BoundOrder, config: WaffoConfig,
  request: Fetcher = fetch): Promise<string[]> {
  const remotes = await providerOrders(order, config, request);
  if (!remotes.length || order.provider_order_id) throw new BillingError("checkout_confirmation_pending", 409);
  for (const remote of remotes) assertUnpaid(remote, order, config);
  const expected = remotes.map(remote => text(remote.id)).sort();
  const sameAttempts = (current: ProviderOrder[]) => {
    const ids = current.map(remote => text(remote.id)).sort();
    if (expected.length !== ids.length || expected.some((id,index) => id !== ids[index])) {
      throw new BillingError("checkout_confirmation_pending",409);
    }
    for (const remote of current) assertUnpaid(remote,order,config);
  };
  for (const id of remotes.filter(remote => remote.status === "pending").map(remote => text(remote.id)).sort()) {
    const current = await providerOrders(order,config,request);
    sameAttempts(current);
    if (current.find(remote => remote.id === id)?.status === "pending") {
      await closeSingleUnpaidWaffoOrder(order,id,config,request);
    }
  }
  const confirmed = await providerOrders(order, config, request);
  sameAttempts(confirmed);
  for (const remote of confirmed) {
    assertUnpaid(remote, order, config);
    if (!["canceled", "closed", "expired"].includes(String(remote.status))) {
      throw new BillingError("checkout_confirmation_pending", 409);
    }
  }
  return expected;
}

export async function closeUnpaidWaffoOrder(order: BoundOrder, config: WaffoConfig,
  request: Fetcher = fetch): Promise<string> {
  // The legacy scalar helper rejects a replacement bundle before any mutation.
  await providerOrder(order,config,request);
  const attempts = await closeUnpaidWaffoAttempts(order, config, request);
  if (attempts.length !== 1) throw new BillingError("ambiguous_payment_binding", 409);
  return attempts[0];
}
