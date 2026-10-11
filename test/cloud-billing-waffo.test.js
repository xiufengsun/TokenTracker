const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, randomUUID, createSign, createVerify, createHash } = require("node:crypto");
const {
  waffoProductId, validateWaffoProduct, createWaffoCheckout, verifyWaffoWebhook,
  queryWaffoOrder, queryWaffoPeriod, cancelWaffoSubscription,
  closeUnpaidWaffoOrder, closeUnpaidWaffoAttempts, queryWaffoBindings,
} = require("./helpers/load-cloud-module")("waffo");

const keys = generateKeyPairSync("rsa", { modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const id = (prefix, letter) => `${prefix}_${letter.repeat(22)}`;
const productId = id("PROD", "m");
const yearlyId = id("PROD", "y");
const fixedId = id("PROD", "f");
const fixedYearlyId = id("PROD", "g");
const remoteId = id("ORD", "o");
const paymentId = id("PAY", "p");
const config = { environment: "sandbox", merchantId: id("MER", "m"), storeId: id("STO", "s"),
  privateKey: keys.privateKey, webhookPublicKey: { test: keys.publicKey },
  checkoutPage: "https://www.tokentracker.cc/billing/checkout",
  productIds: { cloud_usd_monthly: productId, cloud_usd_yearly: yearlyId,
    cloud_usd_monthly_fixed: fixedId, cloud_usd_yearly_fixed: fixedYearlyId } };
const order = { id: randomUUID(), user_id: randomUUID(), environment: "sandbox", provider: "waffo",
  billing_mode: "recurring", sku: "cloud_usd_monthly", currency: "USD", amount_cents: 499, term_months: 1,
  provider_order_id: null, checkout_url: null, status: "pending", expires_at: "2026-10-07T12:30:00.000Z" };
const fixed = { ...order, billing_mode: "fixed", sku: "cloud_usd_monthly_fixed" };
const display = amount => (amount / 100).toFixed(2);
const money = amount => ({ amount: String(amount), currency: "USD", display: display(amount) });
const breakdown = tax => ({ currency: "USD", subtotal: "4.99", taxAmount: display(tax),
  total: display(499 + tax), taxCategory: "saas" });
const metadata = target => JSON.stringify({ tokentracker_order_id: target.id,
  tokentracker_user_id: target.user_id, tokentracker_environment: target.environment });

function product(target = order) {
  return { id: config.productIds[target.sku], storeId: config.storeId, status: "active", metadata: "{}",
    billingPeriod: target.term_months === 12 ? "yearly" : "monthly",
    prices: [{ currency: "USD", priceInfo: { amount: display(target.amount_cents), taxCategory: "saas", trialAmount: null } }] };
}

function remote(target = order, tax = 0) {
  const subscription = target.billing_mode === "recurring";
  const p = product(target);
  return { id: remoteId, storeId: config.storeId, status: subscription ? "active" : "completed",
    testMode: true, currency: "USD", orderMerchantExternalId: target.id, metadata: metadata(target),
    createdAt: "2026-10-07T12:00:00.000Z", updatedAt: "2026-10-07T12:00:01.000Z",
    productVersion: { id: id("VER", "v"), productId: p.id, prices: p.prices, metadata: "{}", billingPeriod: p.billingPeriod },
    priceSnapshot: subscription ? { currency: "USD", regularPhase: breakdown(tax), specialPhase: null, specialPhaseDays: null }
      : breakdown(tax),
    billingPeriod: p.billingPeriod, isInTrial: false, willRenew: true, changeOriginOrderId: null, supersededByOrderId: null,
    currentPeriodStart: "2026-10-07T12:00:00.000Z", currentPeriodEnd: "2026-11-07T12:00:00.000Z", currentPeriodNumber: 1,
    payments: [{ id: paymentId, orderId: remoteId, status: "succeeded", testMode: true,
      orderMerchantExternalId: target.id, createdAt: "2026-10-07T12:00:00.000Z", periodNumber: subscription ? 1 : null,
      amount: money(499 + tax), snapshotAmountDetails: { ...breakdown(tax), phase: "regular" },
      pspAmountDetails: { currency: "USD", amount: display(499 + tax) }, refunds: [] }] };
}

function customerVisible(remote) {
  return {id:remote.id,storeId:remote.storeId,currency:remote.currency,testMode:remote.testMode,
    orderMerchantExternalId:remote.orderMerchantExternalId,productVersion:{productId:remote.productVersion.productId}};
}

function verifiedRequest(handler) {
  return async (url, init) => {
    assert.equal(new URL(url).origin, "https://api.waffo.ai");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-Merchant-Id"], config.merchantId);
    const canonical = `POST\n${new URL(url).pathname}\n${init.headers["X-Timestamp"]}\n${createHash("sha256").update(init.body).digest("base64")}`;
    assert.equal(createVerify("sha256").update(canonical).verify(keys.publicKey, init.headers["X-Signature"], "base64"), true);
    assert.ok(init.signal instanceof AbortSignal);
    const response = await handler(url, JSON.parse(init.body), init);
    if (new URL(url).pathname.endsWith("graphql")) {
      const result = await response.clone().json();
      for (const field of ["subscriptionOrders", "onetimeOrders"]) {
        if (Array.isArray(result.data?.[field]) && result.data[field + "Count"] === undefined) {
          result.data[field + "Count"] = result.data[field].length;
        }
      }
      return Response.json(result, { status: response.status });
    }
    return response;
  };
}

function lookup(data, target = order) {
  return verifiedRequest((_url, body) => {
    assert.match(body.query, /\$storeId: String!, \$ref: String!, \$offset: Int!/);
    assert.match(body.query, /storeId: \$storeId, filter: \{ orderMerchantExternalId: \{ eq: \$ref \} \}/);
    assert.deepEqual(body.variables, { storeId: config.storeId, ref: target.id, offset: 0 });
    return Response.json({ data: { [target.billing_mode === "recurring" ? "subscriptionOrders" : "onetimeOrders"]: data } });
  });
}

function replacement(source, letter) {
  const copy = structuredClone(source);
  copy.id = id("ORD", letter);
  copy.payments.forEach((payment, index) => {
    payment.id = `PAY_${letter.repeat(20)}${String(index).padStart(2, "0")}`;
    payment.orderId = copy.id;
  });
  return copy;
}

test("a replacement paid order remains attributable when the previous attempt failed and closed", async () => {
  const failed = remote(); failed.status = "closed"; failed.payments[0].status = "failed";
  failed.currentPeriodNumber = null; failed.currentPeriodStart = null; failed.currentPeriodEnd = null;
  const paid = replacement(remote(), "b");
  const request = lookup([failed, paid]);
  const bindings = await queryWaffoBindings(order, config, request);
  assert.equal(bindings.length, 2); assert.equal(bindings[0].current_period, null);
  assert.equal(bindings[1].waffo_order_id, paid.id);
  const events = await queryWaffoOrder(order, config, request);
  assert.equal(events.filter(e => e.kind === "payment").length, 1);
  assert.equal(events[0].waffo_order_id, paid.id); assert.equal(events[0].action_id, paid.payments[0].id);
  assert.equal(events.find(e => e.waffo_order_id === failed.id).status, "canceled");
});

function zeroAuthorization(source = remote()) {
  const payment = structuredClone(source.payments[0]);
  payment.id = id("PAY", "z"); payment.periodNumber = 0;
  payment.amount = money(0); payment.pspAmountDetails = { currency: "USD", amount: "0.00" };
  payment.refunds = [];
  return payment;
}

test("an official period-zero authorization is audit-only and cannot block the later full-price charge", async () => {
  const subscription = remote(); const authorization = zeroAuthorization(subscription);
  subscription.payments.unshift(authorization);
  const events = await queryWaffoOrder(order, config, lookup([subscription]));
  const audit = events.find(e => e.kind === "authorization");
  assert.equal(audit.action_id, authorization.id); assert.equal(audit.transaction_id, authorization.id);
  assert.equal(audit.amount_cents, 0); assert.equal(audit.base_amount_cents, 499); assert.equal(audit.period_number, 0);
  assert.equal(audit.subscription_id, remoteId); assert.equal(audit.starts_at, undefined); assert.equal(audit.ends_at, undefined);
  const paid = events.filter(e => e.kind === "payment");
  assert.equal(paid.length, 1); assert.equal(paid[0].amount_cents, 499); assert.equal(paid[0].action_id, paymentId);
  subscription.payments = [authorization]; subscription.currentPeriodNumber = 0;
  subscription.currentPeriodStart = null; subscription.currentPeriodEnd = null;
  const only = await queryWaffoOrder(order, config, lookup([subscription]));
  assert.equal(only.filter(e => e.kind === "authorization").length, 1);
  assert.equal(only.filter(e => e.kind === "payment").length, 0);
});

test("zero amounts outside explicit recurring period-zero authorization remain strict errors", async () => {
  for (const value of [1, null, "0"]) {
    const subscription = remote(); const auth = zeroAuthorization(subscription); auth.periodNumber = value;
    subscription.payments = [auth];
    await assert.rejects(queryWaffoOrder(order, config, lookup([subscription])), /payment_amount_mismatch/);
  }
  const purchase = remote(fixed); purchase.payments = [zeroAuthorization(purchase)];
  await assert.rejects(queryWaffoOrder(fixed, config, lookup([purchase], fixed)), /payment_amount_mismatch/);
  for (const mutate of [p => p.amount.display = "0.01", p => p.pspAmountDetails.currency = "CNY",
    p => p.pspAmountDetails.amount = "", p => p.snapshotAmountDetails.subtotal = "0.00",
    p => p.snapshotAmountDetails.phase = "trial", p => p.refunds = [{ status: "pending" }]]) {
    const subscription = remote(); const auth = zeroAuthorization(subscription); mutate(auth); subscription.payments = [auth];
    await assert.rejects(queryWaffoOrder(order, config, lookup([subscription])));
  }
});

test("a terminal zero-authorized attempt may retry but a real charge or unknown refund cannot", async () => {
  const subscription = remote(); subscription.status = "closed"; subscription.payments = [zeroAuthorization(subscription)];
  assert.deepEqual(await closeUnpaidWaffoAttempts(order, config, lookup([subscription])), [remoteId]);
  subscription.payments[0].refunds = [{ status: "pending" }];
  await assert.rejects(closeUnpaidWaffoAttempts(order, config, lookup([subscription])), /checkout_confirmation_pending/);
  subscription.payments = [zeroAuthorization(subscription), remote().payments[0]];
  await assert.rejects(closeUnpaidWaffoAttempts(order, config, lookup([subscription])), /checkout_confirmation_pending/);
});

test("each replacement candidate is checked independently and cannot borrow another attempt's period", async () => {
  const first = remote(); const second = replacement(remote(), "c");
  second.currentPeriodStart = "2026-10-08T15:14:30.000Z";
  second.currentPeriodEnd = "2026-11-08T15:14:30.000Z";
  const events = await queryWaffoOrder(order, config, lookup([second, first]));
  const payments = events.filter(e => e.kind === "payment");
  assert.equal(payments.length, 2);
  assert.equal(payments.find(e => e.waffo_order_id === first.id).starts_at, first.currentPeriodStart);
  assert.equal(payments.find(e => e.waffo_order_id === second.id).starts_at, second.currentPeriodStart);
  second.currentPeriodNumber = 2;
  await assert.rejects(queryWaffoOrder(order, config, lookup([first, second]), [{ waffo_order_id: first.id,
    period_number: 1, starts_at: first.currentPeriodStart, ends_at: first.currentPeriodEnd }]), /waffo_billing_period_pending/);
  for (const mutate of [p => p.storeId = id("STO", "x"), p => p.testMode = false,
    p => p.metadata = metadata({ ...order, user_id: randomUUID() }), p => p.productVersion.productId = yearlyId]) {
    const wrong = replacement(remote(), "d"); mutate(wrong);
    await assert.rejects(queryWaffoBindings(order, config, lookup([first, wrong])));
  }
});

test("candidate pagination validates the full count and refuses an oversized or changing snapshot", async () => {
  const attempts = Array.from({ length: 101 }, (_, index) => {
    const attempt = remote(); attempt.id = `ORD_${String(index).padStart(22, "0")}`;
    attempt.status = "closed"; attempt.payments = [];
    attempt.currentPeriodNumber = null; attempt.currentPeriodStart = null; attempt.currentPeriodEnd = null;
    return attempt;
  });
  const offsets = [];
  const request = verifiedRequest((_url, body) => {
    const offset = body.variables.offset; offsets.push(offset);
    return Response.json({ data: { subscriptionOrders: attempts.slice(offset, offset + 100), subscriptionOrdersCount: 101 } });
  });
  assert.equal((await queryWaffoBindings(order, config, request)).length, 101);
  assert.deepEqual(offsets, [0, 100]);
  await assert.rejects(queryWaffoBindings(order, config, verifiedRequest(() => Response.json({ data: {
    subscriptionOrders: [], subscriptionOrdersCount: 1001 } }))), /waffo_attempt_limit_exceeded/);
  await assert.rejects(queryWaffoBindings(order, config, verifiedRequest((_url, body) => Response.json({ data: {
    subscriptionOrders: attempts.slice(body.variables.offset, body.variables.offset + 100),
    subscriptionOrdersCount: body.variables.offset ? 102 : 101 } }))), /waffo_notification_pending/);
});

test("an oversized provider response is canceled before the SDK parses or truncates payment truth", async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/json" } });
  await assert.rejects(queryWaffoBindings(order, config, async () => response), /waffo_snapshot_too_large/);
  assert.equal(canceled, true);
});

test("an excessive Content-Length cancels the live provider stream without reading it", async () => {
  let canceled = false; let reads = 0;
  const response = new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(1)); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/json", "Content-Length": String(9 * 1024 * 1024) } });
  await assert.rejects(queryWaffoBindings(order, config, async () => response), /waffo_snapshot_too_large/);
  assert.equal(canceled, true); assert.equal(reads, 0);
});

test("a terminal unpaid bundle can restart while missing identity and processing candidates stay blocked", async () => {
  const first = remote(fixed); first.status = "closed"; first.payments[0].status = "failed";
  const second = replacement(remote(fixed), "e"); second.status = "canceled"; second.payments[0].status = "canceled";
  assert.deepEqual(await closeUnpaidWaffoAttempts(fixed, config, lookup([first, second], fixed)), [first.id, second.id].sort());
  second.status = "pending";
  await assert.rejects(closeUnpaidWaffoAttempts(fixed, config, lookup([first, second], fixed)), /checkout_confirmation_pending/);
  second.status = "closed"; second.payments[0].status = "pending";
  await assert.rejects(closeUnpaidWaffoAttempts(fixed, config, lookup([first, second], fixed)), /checkout_confirmation_pending/);
});

test("cancellation targets a verified specific subscription instead of another paid attempt", async () => {
  const first = remote(); const second = replacement(remote(), "f"); second.status = "canceling";
  const result = await cancelWaffoSubscription(order, second.id, config, lookup([first, second]));
  assert.deepEqual(result, { orderId: second.id, status: "canceling" });
  assert.equal(first.status, "active");
});

test("Waffo SDK signs product and checkout requests with a stable environment and UUID idempotency key", async () => {
  const calls = [];
  const request = verifiedRequest((url, body, init) => {
    calls.push(init.headers["X-Idempotency-Key"]);
    if (url.endsWith("/graphql")) {
      assert.match(body.query, /subscriptionProduct\(id: \$id\)/);
      assert.match(body.query, /prices \{ currency priceInfo \{ amount taxCategory trialAmount/);
      assert.deepEqual(body.variables, { id: productId });
      return Response.json({ data: { subscriptionProduct: product() } });
    }
    assert.equal(url, "https://api.waffo.ai/v1/actions/checkout/create-session");
    assert.equal(body.productId, productId);
    assert.equal(body.currency, "USD");
    assert.equal(body.withTrial, false);
    assert.equal(body.orderMerchantExternalId, order.id);
    assert.equal(body.metadata.tokentracker_user_id, order.user_id);
    assert.equal(body.metadata.tokentracker_environment, "sandbox");
    assert.equal(body.productType, undefined);
    assert.equal(body.priceSnapshot, undefined);
    assert.equal(body.includePaymentMethods, undefined);
    assert.equal(body.originOrderId, undefined);
    assert.equal(new URL(body.successUrl).searchParams.get("order"), order.id);
    return Response.json({ data: { sessionId: "cs_test_session", checkoutUrl: "https://pancake.waffo.ai/store/test/checkout/cs_test_session",
      expiresAt: "2026-10-07T12:30:00.000Z" } });
  });
  const result = await createWaffoCheckout(order, config, request);
  assert.deepEqual(result, { sessionId: "cs_test_session", priceId: productId,
    checkoutUrl: "https://pancake.waffo.ai/store/test/checkout/cs_test_session?test=true" });
  await createWaffoCheckout(order, config, request);
  assert.deepEqual(calls.filter(Boolean), [`tokentracker-sandbox-checkout-${order.id}`, `tokentracker-sandbox-checkout-${order.id}`]);
});

test("global fixed and recurring plans resolve distinct products with the same authoritative price", async () => {
  assert.equal(waffoProductId(fixed, config), fixedId);
  const annual = { ...order, sku: "cloud_usd_yearly", term_months: 12, amount_cents: 3999 };
  assert.equal(waffoProductId(annual, config), yearlyId);
  assert.equal(waffoProductId({ ...annual, sku: "cloud_usd_yearly_fixed", billing_mode: "fixed" }, config), fixedYearlyId);
  await validateWaffoProduct(fixed, config, verifiedRequest((_url, body) => {
    assert.match(body.query, /onetimeProduct\(id: \$id\)/);
    assert.doesNotMatch(body.query, /trialAmount|billingPeriod/);
    return Response.json({ data: { onetimeProduct: product(fixed) } });
  }));
  assert.throws(() => waffoProductId({ ...order, currency: "CNY", sku: "cloud_cny_monthly" }, config));
  assert.throws(() => waffoProductId({ ...order, billing_mode: "fixed" }, config));
  assert.throws(() => waffoProductId({ ...order, environment: "live" }, config));
});

test("bad catalog prices, scope, cycle and provider trials cannot create a checkout", async () => {
  const mutations = [p => p.id = yearlyId, p => p.storeId = id("STO", "u"), p => p.status = "inactive",
    p => p.billingPeriod = "yearly", p => p.prices[0].currency = "EUR", p => p.prices[0].priceInfo.amount = "499",
    p => p.prices[0].priceInfo.amount = "4.999", p => p.prices[0].priceInfo.amount = 4.99,
    p => p.prices[0].priceInfo.taxCategory = "consulting", p => p.prices[0].priceInfo.trialAmount = "0.00",
    p => p.metadata = '{"trialDays":7}', p => p.prices.push(p.prices[0])];
  for (const mutate of mutations) {
    const p = product(); mutate(p); let checkouts = 0;
    await assert.rejects(createWaffoCheckout(order, config, verifiedRequest(url => {
      if (!url.endsWith("graphql")) checkouts++;
      return Response.json({ data: { subscriptionProduct: p } });
    })));
    assert.equal(checkouts, 0);
  }
  for (const target of [order, fixed]) {
    await assert.rejects(createWaffoCheckout(target, config, verifiedRequest((_url, body) => {
      const expected = target.billing_mode === "recurring" ? "subscriptionProduct" : "onetimeProduct";
      assert.match(body.query, new RegExp(expected + "\\(id: \\$id\\)"));
      return Response.json({ data: { [expected]: null } });
    })));
  }
});

test("checkout URLs must remain on the official Waffo host and matching session", async () => {
  for (const url of ["http://pancake.waffo.ai/store/test/checkout/cs_ok", "https://evil.test/store/test/checkout/cs_ok",
    "https://pancake.waffo.ai/store/test/checkout/cs_other", "https://pancake.waffo.ai/store/test/change/cs_ok",
    "https://user:password@pancake.waffo.ai/store/test/checkout/cs_ok"]) {
    await assert.rejects(createWaffoCheckout(order, config, verifiedRequest(requestUrl => Response.json({ data:
      requestUrl.endsWith("graphql") ? { subscriptionProduct: product() }
        : { sessionId: "cs_ok", checkoutUrl: url, expiresAt: order.expires_at } }))), /invalid_provider_checkout_url/);
  }
  await assert.rejects(createWaffoCheckout(order, { ...config, checkoutPage: "http://localhost/billing" }), /invalid_checkout_configuration/);
});

test("Waffo SDK verifies exact raw webhook bytes, replay window, expected environment and store", () => {
  const timestamp = Date.now();
  const event = { id: randomUUID(), timestamp: new Date().toISOString(), eventId: paymentId,
    eventType: "subscription.payment_succeeded", storeId: config.storeId, mode: "test", data: { orderId: remoteId } };
  const sign = (payload, ts = timestamp) => `t=${ts},v1=${createSign("sha256").update(`${ts}.${payload}`).sign(keys.privateKey, "base64")}`;
  const raw = JSON.stringify(event);
  assert.deepEqual(verifyWaffoWebhook(raw, sign(raw), config), event);
  assert.throws(() => verifyWaffoWebhook(raw + " ", sign(raw), config), /invalid_signature/);
  assert.throws(() => verifyWaffoWebhook(raw, sign(raw, timestamp - 46 * 60_000), config), /invalid_signature/);
  assert.throws(() => verifyWaffoWebhook(raw, sign(raw, timestamp + 120_000), config), /invalid_signature/);
  assert.throws(() => verifyWaffoWebhook(raw, null, config), /invalid_signature/);
  for (const mutate of [e => e.mode = "prod", e => e.storeId = id("STO", "x")]) {
    const wrong = structuredClone(event); mutate(wrong); const payload = JSON.stringify(wrong);
    assert.throws(() => verifyWaffoWebhook(payload, sign(payload), config), /payment_environment_mismatch/);
  }
});

test("the verified product snapshot and PSP charge preserve tax without guessing decimal units", async () => {
  const r = remote(order, 100);
  const events = await queryWaffoOrder(order, config, lookup([r]));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { event_id: `waffo_sandbox_payment_${paymentId}`, kind: "payment", action_id: paymentId,
    order_id: order.id, occurred_at: "2026-10-07T12:00:00.000Z", transaction_id: paymentId,
    waffo_order_id: remoteId, provider_price_id: productId, currency: "USD", base_amount_cents: 499, amount_cents: 599,
    subscription_id: remoteId, period_number: 1, starts_at: r.currentPeriodStart, ends_at: r.currentPeriodEnd });
  assert.equal(events[1].kind, "subscription");
  assert.equal(events[1].status, "active");
  assert.equal(events[1].next_billed_at, r.currentPeriodEnd);
  assert.equal(events[1].occurred_at, r.updatedAt);
  assert.equal(events[1].amount_cents, undefined);
});

test("provider order, payment, product version and tax snapshots must all match the local owner", async () => {
  const mutations = [r => r.storeId = id("STO", "u"), r => r.testMode = false,
    r => r.orderMerchantExternalId = randomUUID(), r => r.metadata = metadata({ ...order, user_id: randomUUID() }),
    r => r.productVersion.productId = yearlyId, r => r.productVersion.prices[0].priceInfo.amount = "0.01",
    r => r.productVersion.billingPeriod = "yearly", r => r.billingPeriod = "yearly", r => r.isInTrial = true,
    r => r.changeOriginOrderId = id("ORD", "c"), r => r.priceSnapshot.specialPhaseDays = 7,
    r => r.currency = "EUR", r => r.payments[0].orderId = id("ORD", "u"), r => r.payments[0].testMode = false,
    r => r.payments[0].orderMerchantExternalId = randomUUID(), r => r.payments[0].amount.currency = "CNY",
    r => r.payments[0].amount.amount = "4.99", r => r.payments[0].amount.display = "499",
    r => r.payments[0].pspAmountDetails.amount = "499", r => r.payments[0].pspAmountDetails.currency = "CNY",
    r => r.payments[0].snapshotAmountDetails.subtotal = "0.01", r => r.payments[0].snapshotAmountDetails.phase = "trial",
    r => r.payments[0].snapshotAmountDetails.taxAmount = "0.01", r => r.payments[0].snapshotAmountDetails.total = "0.00"];
  for (const mutate of mutations) {
    const r = remote(); mutate(r);
    await assert.rejects(queryWaffoOrder(order, config, lookup([r])));
  }
  await assert.rejects(queryWaffoOrder({ ...order, waffo_order_id: id("ORD", "u") }, config, lookup([remote()])), /payment_order_mismatch/);
  await assert.rejects(queryWaffoOrder({ ...order, provider_order_id: id("PAY", "u") }, config, lookup([remote()])), /payment_order_mismatch/);
  await assert.rejects(queryWaffoOrder(order, config, lookup([remote(), remote()])), /ambiguous_payment_binding/);
  assert.deepEqual(await queryWaffoOrder(order, config, lookup([])), []);
});

test("successful fixed purchases use the same price and never become an automatic subscription", async () => {
  const events = await queryWaffoOrder(fixed, config, lookup([remote(fixed)], fixed));
  assert.equal(events.length, 1);
  assert.equal(events[0].provider_price_id, fixedId);
  assert.equal(events[0].subscription_id, undefined);
  assert.equal(events[0].starts_at, undefined);
  assert.equal(events[0].ends_at, undefined);
  assert.equal(await queryWaffoPeriod(fixed, config, () => { throw Error("no request expected"); }), null);
});

test("payments retain their own billing period when the subscription has already renewed", async () => {
  const r = remote();
  r.currentPeriodNumber = 2; r.currentPeriodStart = "2026-11-07T12:00:00.000Z";
  r.currentPeriodEnd = "2026-12-07T12:00:00.000Z"; r.updatedAt = "2026-11-07T12:00:01.000Z";
  r.payments.push({ ...structuredClone(r.payments[0]), id: id("PAY", "q"), periodNumber: 2, createdAt: r.currentPeriodStart });
  await assert.rejects(queryWaffoOrder(order, config, lookup([r])), /waffo_billing_period_pending/);
  const old = { waffo_order_id: remoteId, period_number: 1, starts_at: "2026-10-07T12:00:00.000Z", ends_at: "2026-11-07T12:00:00.000Z" };
  const events = await queryWaffoOrder(order, config, lookup([r]), [old]);
  assert.equal(events[0].ends_at, old.ends_at);
  assert.equal(events[1].starts_at, r.currentPeriodStart);
  const current = await queryWaffoPeriod(order, config, lookup([r]));
  assert.deepEqual(current, { waffo_order_id: remoteId, provider_price_id: productId, period_number: 2,
    starts_at: r.currentPeriodStart, ends_at: r.currentPeriodEnd });
  await assert.rejects(queryWaffoOrder(order, config, lookup([r]), [old, { ...current, ends_at: "2027-01-07T12:00:00.000Z" }]), /waffo_billing_period_conflict/);
  r.payments[0].periodNumber = null;
  await assert.rejects(queryWaffoOrder(order, config, lookup([r]), [old]), /waffo_billing_period_pending/);
});

test("partial refunds use the PSP's real incremental amount and stable refund identity", async () => {
  const r = remote();
  const refund = { id: id("REF", "r"), paymentId, status: "succeeded", testMode: true,
    orderMerchantExternalId: order.id, createdAt: "2026-10-08T12:00:00.000Z",
    amount: money(99), pspAmountDetails: { currency: "USD", amount: "0.99" },
    requestedAmountDetails: { currency: "USD", amount: "4.99" } };
  r.payments[0].refunds = [refund, { ...refund, id: id("REF", "t"), status: "pending" }];
  const events = await queryWaffoOrder(order, config, lookup([r]));
  assert.equal(events[1].kind, "refund"); assert.equal(events[1].action_id, refund.id);
  assert.equal(events[1].transaction_id, paymentId); assert.equal(events[1].amount_cents, 99);
  assert.equal(events[1].subscription_id, remoteId);
  assert.equal(events[1].refund_total_cents, undefined);
  for (const mutate of [f => f.paymentId = id("PAY", "q"), f => f.testMode = false,
    f => f.orderMerchantExternalId = randomUUID(), f => f.pspAmountDetails.currency = "CNY",
    f => f.pspAmountDetails.amount = "99", f => f.amount.display = "4.99"]) {
    const wrong = structuredClone(r); mutate(wrong.payments[0].refunds[0]);
    await assert.rejects(queryWaffoOrder(order, config, lookup([wrong])));
  }
  r.payments[0].refunds.push({ ...refund, id: id("RFD", "v"), amount: money(499), pspAmountDetails: { currency: "USD", amount: "4.99" } });
  await assert.rejects(queryWaffoOrder(order, config, lookup([r])), /payment_amount_mismatch/);
});

test("canceling, overdue, and terminal lifecycle states preserve verified payment periods", async () => {
  for (const [status, expected, cancels] of [["canceling", "active", true], ["past_due", "past_due", false],
    ["canceled", "canceled", false], ["expired", "canceled", false], ["closed", "canceled", false]]) {
    const r = remote(); r.status = status; r.willRenew = false;
    const events = await queryWaffoOrder(order, config, lookup([r]));
    assert.equal(events[0].ends_at, r.currentPeriodEnd);
    assert.equal(events[1].status, expected); assert.equal(events[1].cancel_at_period_end, cancels);
    assert.equal(events[1].next_billed_at, null);
  }
  const r = remote(); r.currentPeriodNumber = null;
  assert.equal(await queryWaffoPeriod(order, config, lookup([r])), null);
  await assert.rejects(queryWaffoOrder(order, config, lookup([r])), /waffo_billing_period_pending/);
});

test("cancellation checks the owner and uses the SDK's signed idempotent cancellation method", async () => {
  const subscription = remote();
  const operation = createHash("sha256").update(subscription.updatedAt).digest("hex");
  const result = await cancelWaffoSubscription(order, remoteId, config, verifiedRequest((url, body, init) => {
    if (url.endsWith("graphql")) return Response.json({ data: { subscriptionOrders: [subscription] } });
    assert.equal(url, "https://api.waffo.ai/v1/actions/subscription-order/cancel-order");
    assert.deepEqual(body, { orderId: remoteId });
    assert.equal(init.headers["X-Idempotency-Key"], `tokentracker-sandbox-cancel-${order.id}-${operation}`);
    subscription.status = "canceling"; subscription.willRenew = false;
    return Response.json({ data: { orderId: remoteId, status: "canceling" } });
  }));
  assert.deepEqual(result, { orderId: remoteId, status: "canceling" });
  await assert.rejects(cancelWaffoSubscription(order, id("ORD", "u"), config, lookup([remote()])), /payment_order_mismatch/);
  await assert.rejects(cancelWaffoSubscription(fixed, remoteId, config), /invalid_checkout_provider/);
});

test("cancellation is confirmed through fresh provider state and already canceled states require no write", async () => {
  const subscription = remote(); let writes = 0;
  await assert.rejects(cancelWaffoSubscription(order, remoteId, config, verifiedRequest(url => {
    if (url.endsWith("graphql")) return Response.json({ data: { subscriptionOrders: [subscription] } });
    writes++;
    return Response.json({ data: { orderId: remoteId, status: "canceling" } });
  })), /subscription_cancellation_pending/);
  assert.equal(writes, 1);
  for (const status of ["canceling", "canceled"]) {
    subscription.status = status;
    const result = await cancelWaffoSubscription(order, remoteId, config, verifiedRequest(url => {
      assert.ok(url.endsWith("graphql"));
      return Response.json({ data: { subscriptionOrders: [subscription] } });
    }));
    assert.deepEqual(result, { orderId: remoteId, status });
  }
});

test("unpaid recurring recovery cancels only a failed pending attempt and independently confirms it", async () => {
  const subscription = remote(); subscription.status = "pending";
  subscription.payments[0].status = "failed";
  let writes = 0;
  const request = verifiedRequest((url, body, init) => {
    if (url.endsWith("graphql")) return Response.json({ data: { subscriptionOrders: [subscription] } });
    assert.equal(url, "https://api.waffo.ai/v1/actions/subscription-order/cancel-order");
    assert.deepEqual(body, { orderId: remoteId });
    assert.equal(init.headers["X-Idempotency-Key"], `tokentracker-sandbox-close-${order.id}-${remoteId}`);
    writes++; subscription.status = "canceled";
    return Response.json({ data: { orderId: remoteId, status: "canceled" } });
  });
  assert.equal(await closeUnpaidWaffoOrder(order, config, request), remoteId);
  assert.equal(await closeUnpaidWaffoOrder(order, config, request), remoteId);
  assert.equal(writes, 1);
});

test("recovery rejects paid, processing, unknown, refunded and ambiguously bound attempts before a cancel write", async () => {
  for (const status of ["pending", "processing", "created", "unknown", "succeeded"]) {
    const subscription = remote(); subscription.status = "pending";
    subscription.payments[0].status = status;
    await assert.rejects(closeUnpaidWaffoOrder(order, config, lookup([subscription])), /checkout_confirmation_pending/);
  }
  const canceled = remote(); canceled.status = "canceled"; canceled.payments[0].status = "succeeded";
  canceled.payments[0].refundedAmount = money(499);
  await assert.rejects(closeUnpaidWaffoOrder(order, config, lookup([canceled])), /checkout_confirmation_pending/);
  canceled.payments = [];
  await assert.rejects(closeUnpaidWaffoOrder({ ...order, provider_order_id: paymentId }, config, lookup([canceled])), /checkout_confirmation_pending/);
  await assert.rejects(closeUnpaidWaffoOrder(order, config, lookup([canceled, canceled])), /ambiguous_payment_binding/);
  const subscription = remote(); subscription.status = "pending"; subscription.payments[0].status = "failed";
  await assert.rejects(closeUnpaidWaffoOrder(order, config, verifiedRequest(url => {
    if (url.endsWith("graphql")) return Response.json({ data: { subscriptionOrders: [subscription] } });
    return Response.json({ data: { orderId: remoteId, status: "canceled" } });
  })), /checkout_confirmation_pending/);
  subscription.status = "canceled"; subscription.payments[0].status = "pending";
  await assert.rejects(closeUnpaidWaffoOrder(order, config, lookup([subscription])), /checkout_confirmation_pending/);
});

test("fixed recovery uses an ephemeral SDK customer token and checks the exact owned order", async () => {
  const purchase = remote(fixed); purchase.status = "pending"; purchase.payments[0].status = "failed";
  purchase.merchantProvidedBuyerIdentity = fixed.user_id;
  let tokens = 0; let cancels = 0;
  const signed = verifiedRequest((url, body, init) => {
    if (url.endsWith("graphql")) return Response.json({ data: { onetimeOrders: [purchase] } });
    assert.equal(url, "https://api.waffo.ai/v1/actions/auth/issue-session-token");
    assert.deepEqual(body, { storeId: config.storeId, buyerIdentity: fixed.user_id });
    assert.equal(init.headers["X-Idempotency-Key"], undefined);
    tokens++;
    return Response.json({ data: { token: "isolated-customer-token", expiresAt: new Date(Date.now() + 900_000).toISOString() } });
  });
  const request = (url, init) => {
    if (!init.headers.Authorization) return signed(url, init);
    assert.equal(init.headers.Authorization, "Bearer isolated-customer-token");
    assert.equal(init.headers["X-Environment"], "test");
    assert.equal(init.headers["X-Merchant-Id"], undefined);
    const body = JSON.parse(init.body);
    if (url.endsWith("graphql")) {
      assert.deepEqual(body.variables, { id: remoteId });
      assert.ok(!/\bmetadata\b/.test(body.query));
      return Response.json({ data: { onetimeOrder: customerVisible(purchase) } });
    }
    assert.equal(url, "https://api.waffo.ai/v1/actions/onetime-order/cancel-order");
    assert.deepEqual(body, { orderId: remoteId });
    assert.equal(init.headers["X-Idempotency-Key"], `tokentracker-sandbox-close-${fixed.id}-${remoteId}`);
    cancels++; purchase.status = "canceled";
    return Response.json({ data: { orderId: remoteId, status: "canceled" } });
  };
  assert.equal(await closeUnpaidWaffoOrder(fixed, config, request), remoteId);
  assert.equal(tokens, 1); assert.equal(cancels, 1);
  purchase.status = "pending"; purchase.merchantProvidedBuyerIdentity = "";
  await assert.rejects(closeUnpaidWaffoOrder(fixed, config, request), /checkout_confirmation_pending/);
});

test("closing a pending checkout stops when a charge succeeds during cancellation", async () => {
  const subscription = remote(); subscription.status = "pending"; subscription.payments[0].status = "failed";
  await assert.rejects(closeUnpaidWaffoOrder(order, config, verifiedRequest(url => {
    if (url.endsWith("graphql")) return Response.json({ data: { subscriptionOrders: [subscription] } });
    subscription.status = "canceled"; subscription.payments[0].status = "succeeded";
    return Response.json({ data: { orderId: remoteId, status: "canceled" } });
  })), /checkout_confirmation_pending/);
});

test("closed or expired failed checkouts confirm the terminal state without another cancellation", async () => {
  for (const target of [order, fixed]) {
    for (const status of ["closed", "expired"]) {
      const terminated = remote(target); terminated.status = status; terminated.payments[0].status = "failed";
      let reads = 0;
      const request = verifiedRequest(url => {
        assert.ok(url.endsWith("graphql")); reads++;
        return Response.json({ data: { [target.billing_mode === "recurring" ? "subscriptionOrders" : "onetimeOrders"]: [terminated] } });
      });
      assert.equal(await closeUnpaidWaffoOrder(target, config, request), remoteId);
      assert.ok(reads >= 2, "terminal state needs an independent provider read-back");
      terminated.payments[0].status = "pending";
      await assert.rejects(closeUnpaidWaffoOrder(target, config, request), /checkout_confirmation_pending/);
    }
  }
  const terminated = remote(); terminated.status = "closed"; terminated.payments[0].status = "failed";
  let reads = 0;
  await assert.rejects(closeUnpaidWaffoOrder(order, config, verifiedRequest(() => {
    reads++;
    if (reads === 2) terminated.payments[0].status = "succeeded";
    return Response.json({ data: { subscriptionOrders: [terminated] } });
  })), /checkout_confirmation_pending/);
});

test("fixed recovery preserves merchant owner proof and checks customer-visible ORD, store, environment and product", async () => {
  const purchase = remote(fixed); purchase.status = "pending"; purchase.payments[0].status = "failed";
  purchase.merchantProvidedBuyerIdentity = fixed.user_id;
  const signed = verifiedRequest(url => url.endsWith("graphql")
    ? Response.json({ data: { onetimeOrders: [purchase] } })
    : Response.json({ data: { token: "isolated-customer-token", expiresAt: new Date(Date.now() + 900_000).toISOString() } }));
  for (const mutate of [v=>v.id=id("ORD","x"),v=>v.storeId=id("STO","x"),v=>v.testMode=false,
    v=>v.currency="CNY",v=>v.orderMerchantExternalId=randomUUID(),v=>v.productVersion.productId=yearlyId]) {
    let cancellations = 0;
    await assert.rejects(closeUnpaidWaffoOrder(fixed, config, (url, init) => {
      if (!init.headers.Authorization) return signed(url, init);
      if (url.endsWith("graphql")) {
        const body=JSON.parse(init.body); assert.ok(!/\bmetadata\b/.test(body.query));
        const visible=customerVisible(purchase); mutate(visible);
        return Response.json({ data: { onetimeOrder: visible } });
      }
      cancellations++;
      return Response.json({ data: { orderId: remoteId, status: "canceled" } });
    }), /payment_order_mismatch/);
    assert.equal(cancellations,0);
  }
  purchase.metadata=metadata({...fixed,user_id:randomUUID()});
  await assert.rejects(closeUnpaidWaffoOrder(fixed,config,signed),/payment_account_mismatch/);
});

test("provider failures stay private and a large reconciliation cannot silently truncate payments", async () => {
  await assert.rejects(queryWaffoOrder(order, config, async () => Response.json({ data: { secret: "must not leak" } }, { status: 500 })),
    { message: "payment_provider_unavailable", status: 502 });
  await assert.rejects(queryWaffoOrder(order, config, async () => Response.json({ data: { subscriptionOrders: [remote()] },
    errors: [{ message: "must not leak", layer: "database" }] })), { message: "payment_provider_unavailable", status: 502 });
  const r = remote(fixed);
  r.payments = Array.from({ length: 101 }, (_, n) => ({ ...structuredClone(r.payments[0]),
    id: `PAY_${String(n).padStart(22, "0")}` }));
  const all = await queryWaffoOrder(fixed, config, lookup([r], fixed));
  assert.equal(all.length, 101);
});

function multiPendingRequest(target,remotes,options={}) {
  const cancelKeys=[];const minted=[];const cancellations=new Map();const sessions=new Map();
  const signed=verifiedRequest((url,body,init)=>{
    if(url.endsWith("graphql"))return Response.json({data:{[target.billing_mode==="recurring"?"subscriptionOrders":"onetimeOrders"]:remotes}});
    if(url.endsWith("issue-session-token")) {
      assert.equal(init.headers["X-Idempotency-Key"],undefined);
      const token="isolated-multi-customer-"+randomUUID();sessions.set(token,body.buyerIdentity);minted.push(body.buyerIdentity);
      return Response.json({data:{token,expiresAt:new Date(Date.now()+900_000).toISOString()}});
    }
    return cancel(body,init);
  });
  function cancel(body,init) {
    const remote=remotes.find(r=>r.id===body.orderId);assert.ok(remote);
    const key=init.headers["X-Idempotency-Key"];
    assert.equal(key,`tokentracker-sandbox-close-${target.id}-${remote.id}`);
    if(cancellations.has(key))return Response.json({data:cancellations.get(key)});
    assert.equal(remote.status,"pending");cancelKeys.push(key);remote.status="canceled";
    const result={orderId:remote.id,status:"canceled"};cancellations.set(key,result);
    if(cancelKeys.length===1&&options.afterFirst)options.afterFirst(remotes);
    return Response.json({data:result});
  }
  const request=(url,init)=>{
    if(!init.headers.Authorization)return signed(url,init);
    assert.equal(init.headers["X-Environment"],"test");assert.equal(init.headers["X-Merchant-Id"],undefined);
    const buyer=sessions.get(init.headers.Authorization.slice("Bearer ".length));assert.ok(buyer);
    const body=JSON.parse(init.body);const visible=remotes.find(r=>r.id===(body.variables?.id||body.orderId));assert.ok(visible);
    assert.equal(visible.merchantProvidedBuyerIdentity,buyer);
    if(url.endsWith("graphql")) {
      assert.ok(!/\bmetadata\b/.test(body.query));
      return Response.json({data:{onetimeOrder:customerVisible(options.foreignCustomer?{...visible,id:id("ORD","x")}:visible)}});
    }
    return cancel(body,init);
  };
  return {request,cancelKeys,minted};
}
function pendingPair(target) {
  const first=remote(target);const second=replacement(remote(target),"b");
  for(const [index,attempt]of [first,second].entries()) {
    attempt.status="pending";attempt.payments[0].status="failed";
    attempt.merchantProvidedBuyerIdentity="verified-existing-buyer-"+index;
  }
  return [first,second];
}

test("two strongly owned pending attempts cancel by distinct ORD keys and repeated recovery converges",async()=>{
  for(const target of [order,fixed]) {
    const remotes=pendingPair(target);const fixture=multiPendingRequest(target,remotes);
    const expected=remotes.map(r=>r.id).sort();
    assert.deepEqual(await closeUnpaidWaffoAttempts(target,config,fixture.request),expected);
    assert.equal(fixture.cancelKeys.length,2);assert.equal(new Set(fixture.cancelKeys).size,2);
    assert.ok(remotes.every(r=>r.status==="canceled"));
    if(target.billing_mode==="fixed")assert.equal(new Set(fixture.minted).size,2);
    assert.deepEqual(await closeUnpaidWaffoAttempts(target,config,fixture.request),expected);
    assert.equal(fixture.cancelKeys.length,2);
  }
});

test("payment or candidate drift after the first cancellation prevents confirming an unpaid retry bundle",async()=>{
  for(const afterFirst of [remotes=>{const pending=remotes.find(r=>r.status==="pending");pending.payments[0].status="succeeded";},
    remotes=>{const added=replacement(remote(),"j");added.status="pending";added.payments[0].status="failed";remotes.push(added);}]) {
    const remotes=pendingPair(order);const fixture=multiPendingRequest(order,remotes,{afterFirst});
    await assert.rejects(closeUnpaidWaffoAttempts(order,config,fixture.request),/checkout_confirmation_pending/);
    assert.equal(fixture.cancelKeys.length,1);assert.equal(remotes.filter(r=>r.status==="canceled").length,1);
  }
});

test("fixed multi-attempt customer proof cannot use a different visible ORD or invent a missing buyer identity",async()=>{
  const remotes=pendingPair(fixed);const foreign=multiPendingRequest(fixed,remotes,{foreignCustomer:true});
  await assert.rejects(closeUnpaidWaffoAttempts(fixed,config,foreign.request),/payment_order_mismatch/);
  assert.equal(foreign.cancelKeys.length,0);
  const unknown=pendingPair(fixed);unknown.forEach(r=>r.merchantProvidedBuyerIdentity="");
  const fixture=multiPendingRequest(fixed,unknown);
  await assert.rejects(closeUnpaidWaffoAttempts(fixed,config,fixture.request),/checkout_confirmation_pending/);
  assert.equal(fixture.cancelKeys.length,0);assert.equal(fixture.minted.length,0);
});

test("failed annual renewal grace never becomes a paid billing period or blocks the lifecycle",async()=>{
  const annual={...order,sku:"cloud_usd_yearly",amount_cents:3999,term_months:12};
  const past=remote(annual);past.status="past_due";past.willRenew=false;
  past.payments[0].amount=money(3999);past.payments[0].pspAmountDetails.amount="39.99";
  past.payments[0].snapshotAmountDetails={currency:"USD",subtotal:"39.99",taxAmount:"0.00",total:"39.99",taxCategory:"saas",phase:"regular"};
  past.priceSnapshot.regularPhase={...past.payments[0].snapshotAmountDetails};
  const paidPeriod={waffo_order_id:past.id,provider_price_id:yearlyId,period_number:1,
    starts_at:"2026-10-07T16:12:52.000Z",ends_at:"2027-10-07T16:12:52.000Z"};
  const failed={...structuredClone(past.payments[0]),id:id("PAY","h"),status:"failed",periodNumber:2};
  past.payments.unshift(failed);past.currentPeriodNumber=2;
  past.currentPeriodStart="2027-10-07T16:12:52.000Z";past.currentPeriodEnd="2027-10-07T17:08:25.000Z";
  for(const state of ["past_due","canceling","canceled","closed","expired"]) {
    past.status=state;
    const bindings=await queryWaffoBindings(annual,config,lookup([past],annual));assert.equal(bindings[0].current_period,null,state);
    const events=await queryWaffoOrder(annual,config,lookup([past],annual),[paidPeriod]);
    assert.equal(events.filter(e=>e.kind==="payment").length,1,state);
    assert.equal(events[0].ends_at,paidPeriod.ends_at,state);
    const lifecycle=events.find(e=>e.kind==="subscription");
    assert.equal(lifecycle.status,state==="past_due"?"past_due":state==="canceling"?"active":"canceled");
    assert.equal(lifecycle.starts_at,undefined);assert.equal(lifecycle.ends_at,undefined);assert.equal(lifecycle.period_number,undefined);
  }
  past.status="active";past.willRenew=true;
  past.currentPeriodEnd="2028-10-07T16:12:52.000Z";
  failed.status="succeeded";
  const bindings=await queryWaffoBindings(annual,config,lookup([past],annual));
  assert.equal(bindings[0].current_period.period_number,2);assert.equal(bindings[0].current_period.ends_at,past.currentPeriodEnd);
  const recovered=await queryWaffoOrder(annual,config,lookup([past],annual),[paidPeriod]);
  assert.equal(recovered.filter(e=>e.kind==="payment").length,2);
  assert.equal(recovered.find(e=>e.action_id===failed.id).starts_at,paidPeriod.ends_at);
});
