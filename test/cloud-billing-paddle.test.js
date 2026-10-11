const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac, randomUUID } = require("node:crypto");
const { createPaddleCheckout, normalizePaddleEvent, verifyPaddleSignature, validatePaddleCheckoutPrice,
  paddleCheckoutBinding, queryPaddleOrder, createPaddlePortal, cancelPaddleSubscription } = require("./helpers/load-cloud-module")("paddle");

const config = { environment: "sandbox", apiKey: "test-only-key", webhookSecret: "test-only-secret",
  monthlyPriceId: "pri_month", yearlyPriceId: "pri_year", checkoutPage: "https://www.tokentracker.cc/billing/checkout" };
const order = { id: randomUUID(), user_id: randomUUID(), environment: "sandbox", provider: "paddle",
  sku: "cloud_usd_monthly", currency: "USD", amount_cents: 599, term_months: 1,
  provider_order_id: null, checkout_url: null, status: "pending", expires_at: new Date(Date.now()+1800_000).toISOString() };
const resolver = { order: async id => { assert.equal(id, order.id); return order; }, transactionOrder: async () => order };

function completed() {
  return { event_id: "evt_paid", event_type: "transaction.completed", occurred_at: new Date().toISOString(),
    data: { id: "txn_paid", status: "completed", collection_mode: "automatic",currency_code: "USD", subscription_id: "sub_test",
      custom_data: { tokentracker_order_id: order.id, tokentracker_user_id: order.user_id },
      items: [{ quantity: 1, price: { id: "pri_month", unit_price: { amount: "599", currency_code: "USD" },
        billing_cycle: { interval: "month", frequency: 1 } } }],
      details: { totals: { currency_code: "USD", subtotal: "599", discount: "0", credit: "0", grand_total: "719" } },
      billing_period: { starts_at: "2026-10-03T10:00:00Z", ends_at: "2026-11-03T10:00:00Z" } } };
}

function catalogPrice(){
  return {...completed().data.items[0].price,status:"active",tax_mode:"external",trial_period:null,
    unit_price_overrides:[],quantity:{minimum:1,maximum:1}};
}

test("Paddle signatures use exact raw bytes, enforce timestamp freshness, and accept rotated keys", async () => {
  const raw = '{"event_id":"evt_signature","data":{"value":1}}';
  const now = Date.now(); const ts = String(Math.floor(now/1000));
  const h1 = createHmac("sha256", config.webhookSecret).update(`${ts}:${raw}`).digest("hex");
  await verifyPaddleSignature(raw, `ts=${ts};h1=${"0".repeat(64)};h1=${h1}`, config.webhookSecret, now);
  await assert.rejects(verifyPaddleSignature(raw + " ", `ts=${ts};h1=${h1}`, config.webhookSecret, now), /invalid_signature/);
  await assert.rejects(verifyPaddleSignature(raw, `ts=${ts};h1=${h1}`, config.webhookSecret, now+6000), /stale_signature/);
  await assert.rejects(verifyPaddleSignature(raw, `ts=${ts};ts=${ts};h1=${h1}`, config.webhookSecret, now), /invalid_signature/);
});

test("checkout sends only the server's product and bound account to the correct environment", async () => {
  const result = await createPaddleCheckout(order, config, async (url, init) => {
    if(url === "https://sandbox-api.paddle.com/prices/pri_month")return Response.json({data:catalogPrice()});
    assert.equal(url, "https://sandbox-api.paddle.com/transactions");
    const body = JSON.parse(init.body);
    assert.deepEqual(body.items, [{ price_id: "pri_month", quantity: 1 }]);
    assert.equal(body.custom_data.tokentracker_user_id, order.user_id);
    assert.equal(body.custom_data.tokentracker_order_id, order.id);
    return Response.json({ data: {...completed().data,id:"txn_created",status:"draft",checkout: { url: body.checkout.url + "&_ptxn=txn_created" } } });
  });
  assert.equal(result.transactionId, "txn_created");
  await assert.rejects(createPaddleCheckout(order, config, async url => Response.json({data:url.includes("/prices/")?catalogPrice():
    {...completed().data,id:"txn",checkout:{url:"https://example.org/steal"}}})), /invalid_provider_checkout_url/);
});

test("a misconfigured price is rejected before any provider transaction can be created",async()=>{
  const mutations=[p=>p.unit_price.amount="699",p=>p.unit_price.currency_code="EUR",p=>p.billing_cycle.interval="year",
    p=>p.tax_mode="internal",p=>p.trial_period={interval:"day",frequency:7},p=>p.unit_price_overrides=[{}],
    p=>p.quantity.maximum=2,p=>p.status="archived"];
  for(const mutate of mutations){
    const p=catalogPrice();mutate(p);let charges=0;
    await assert.rejects(createPaddleCheckout(order,config,async url=>{
      if(url.includes("/transactions"))charges++;
      return Response.json({data:p});
    }));
    assert.equal(charges,0);
  }
  await validatePaddleCheckoutPrice(order,config,async()=>Response.json({data:catalogPrice()}));
});

test("checkout binding and reconciliation cannot adopt a different customer or transaction",async()=>{
  const d=completed().data;d.checkout={url:config.checkoutPage+"?order="+order.id+"&_ptxn=txn_paid"};
  assert.equal(paddleCheckoutBinding(d,order,config).transactionId,"txn_paid");
  assert.equal(paddleCheckoutBinding(d,{...order,provider_order_id:"txn_other"},config),null);
  await queryPaddleOrder({...order,provider_order_id:"txn_paid"},config,async url=>{
    assert.equal(url,"https://sandbox-api.paddle.com/transactions/txn_paid");return Response.json({data:d});
  });
  await assert.rejects(queryPaddleOrder({...order,provider_order_id:"txn_other"},config,async()=>Response.json({data:d})),/payment_order_mismatch/);
  d.custom_data.tokentracker_user_id=randomUUID();
  assert.throws(()=>paddleCheckoutBinding(d,order,config),/payment_account_mismatch/);
});

test("only the verified owner's customer portal is opened and cancellation retains the paid period",async()=>{
  const subscription={...completed().data,id:"sub_test",customer_id:"ctm_test",status:"active",updated_at:new Date().toISOString(),scheduled_change:null};
  const portal=await createPaddlePortal(order,"sub_test",config,async(url,init)=>{
    if(url.includes("/subscriptions/"))return Response.json({data:subscription});
    assert.equal(url,"https://sandbox-api.paddle.com/customers/ctm_test/portal-sessions");
    assert.deepEqual(JSON.parse(init.body),{subscription_ids:["sub_test"]});
    return Response.json({data:{customer_id:"ctm_test",urls:{general:{overview:"https://sandbox-customer-portal.paddle.com/cpl_test?token=test-only"}}}});
  });
  assert.equal(new URL(portal).origin, "https://sandbox-customer-portal.paddle.com");
  const canceled=await cancelPaddleSubscription(order,"sub_test",config,async(url,init)=>{
    if(init.method === "GET")return Response.json({data:subscription});
    assert.equal(url,"https://sandbox-api.paddle.com/subscriptions/sub_test/cancel");
    assert.deepEqual(JSON.parse(init.body),{effective_from:"next_billing_period"});
    return Response.json({data:{...subscription,scheduled_change:{action:"cancel",effective_at:"2026-11-03T10:00:00Z"}}});
  });
  assert.equal(canceled.status,"active");assert.equal(canceled.billing_period.ends_at,subscription.billing_period.ends_at);
  const paused=await cancelPaddleSubscription(order,"sub_test",config,async(_url,init)=>{
    if(init.method === "GET")return Response.json({data:{...subscription,status:"paused"}});
    assert.deepEqual(JSON.parse(init.body),{effective_from:"immediately"});
    return Response.json({data:{...subscription,status:"canceled"}});
  });
  assert.equal(paused.billing_period.ends_at,subscription.billing_period.ends_at);
  await assert.rejects(createPaddlePortal(order,"sub_test",config,async()=>Response.json({data:{...subscription,custom_data:{...subscription.custom_data,tokentracker_user_id:randomUUID()}}})),/payment_account_mismatch/);
  await assert.rejects(createPaddlePortal(order,"sub_test",config,async url=>Response.json({data:url.includes("/subscriptions/")?subscription:
    {customer_id:"ctm_test",urls:{general:{overview:"https://example.org/steal"}}}})),/invalid_provider_portal_url/);
});

test("completed payments preserve the actual tax-inclusive amount and billing period", async () => {
  const normalized = await normalizePaddleEvent(completed(), config, resolver);
  assert.equal(normalized.kind, "payment");
  assert.equal(normalized.base_amount_cents, 599);
  assert.equal(normalized.amount_cents, 719);
  assert.equal(normalized.ends_at, "2026-11-03T10:00:00.000Z");
  assert.equal(normalized.order_id, order.id);
});

test("wrong account, price, quantity, amount, currency, and billing interval cannot fulfill", async () => {
  const mutations = [
    e => { e.data.custom_data.tokentracker_user_id = randomUUID(); },
    e => { e.data.items[0].price.id = "pri_unrelated"; },
    e => { e.data.items[0].quantity = 2; },
    e => { e.data.details.totals.subtotal = "1"; },
    e => { e.data.details.totals.currency_code = "CNY"; },
    e => { e.data.items[0].price.billing_cycle.interval = "year"; },
    e => { e.data.details.totals.credit = "599"; },
  ];
  for (const mutate of mutations) {
    const event = completed(); mutate(event);
    await assert.rejects(normalizePaddleEvent(event, config, resolver));
  }
});

test("pending or rejected refunds do not revoke membership, including automatically approved refund creation", async () => {
  const event = { event_id: "evt_refund", event_type: "adjustment.created", occurred_at: new Date().toISOString(),
    data: { id: "adj_refund", action: "refund", status: "pending_approval", transaction_id: "txn_paid", currency_code: "USD", totals: { total: "719" } } };
  assert.equal(await normalizePaddleEvent(event, config, resolver), null);
  event.data.status = "rejected";
  assert.equal(await normalizePaddleEvent(event, config, resolver), null);
  event.data.status = "approved";
  const normalized = await normalizePaddleEvent(event, config, resolver);
  assert.equal(normalized.kind, "refund");
  assert.equal(normalized.action_id, "adj_refund");
  assert.equal(normalized.amount_cents, 719);
});

test("subscription cancellation normalizes state without inventing a paid grant", async () => {
  const event = completed(); event.event_type = "subscription.updated";
  event.data.id = "sub_test"; event.data.status = "active"; event.data.scheduled_change = { action: "cancel" };
  const normalized = await normalizePaddleEvent(event, config, resolver);
  assert.equal(normalized.kind, "subscription");
  assert.equal(normalized.cancel_at_period_end, true);
  assert.equal(normalized.amount_cents, undefined);
});
