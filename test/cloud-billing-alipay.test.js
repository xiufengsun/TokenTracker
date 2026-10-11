const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, randomUUID, sign, verify } = require("node:crypto");
const { alipayClient,createAlipayCheckout, normalizeAlipayNotification, normalizeAlipayQuery, parseAlipayNotification, verifyAlipayNotification } = require("./helpers/load-cloud-module")("alipay");
const keys = generateKeyPairSync("rsa", { modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const config = { environment: "sandbox", appId: "app_test", sellerId: "seller_test", privateKey: keys.privateKey,
  publicKey: keys.publicKey, notifyUrl: "https://example.com/functions/tokentracker-alipay-webhook",
  checkoutPage: "https://www.tokentracker.cc/billing/checkout" };
const order = { id: randomUUID(), user_id: randomUUID(), environment: "sandbox", provider: "alipay",
  currency: "CNY", amount_cents: 2900, term_months: 1 };
function notification(overrides = {}) {
  const values = { app_id: config.appId, seller_id: config.sellerId, charset: "utf-8", sign_type: "RSA2",
    out_trade_no: order.id.replace(/-/g,""), trade_no: "ali_trade", notify_id: "ali_notification",
    total_amount: "29.00", trade_status: "TRADE_SUCCESS", gmt_payment: "2026-10-03 20:00:00",
    notify_time: "2026-10-03 20:00:01", ...overrides };
  const content = Object.keys(values).filter(k => k !== "sign" && k !== "sign_type" && values[k] !== "")
    .sort().map(k => `${k}=${values[k]}`).join("&");
  values.sign = sign("RSA-SHA256", Buffer.from(content), keys.privateKey).toString("base64");
  return values;
}

test("Alipay checkout uses signed page or mobile payment URLs with the server quote", () => {
  const sdk=alipayClient(config);
  assert.equal((sdk.config.alipayPublicKey.match(/-----END PUBLIC KEY-----/g)||[]).length,1);
  assert.equal((sdk.config.privateKey.match(/-----END PRIVATE KEY-----/g)||[]).length,1);
  for(const pem of [sdk.config.privateKey,sdk.config.alipayPublicKey]){
    assert.ok(pem.split("\n").slice(1,-1).every(line=>line.length>0&&line.length<=64),"Deno must receive wrapped PEM rather than the SDK's one-line key");
  }
  const checkout = new URL(createAlipayCheckout(order, config).checkoutUrl);
  assert.equal(checkout.origin, "https://openapi-sandbox.dl.alipaydev.com");
  assert.equal(checkout.searchParams.get("method"), "alipay.trade.page.pay");
  assert.equal(JSON.parse(checkout.searchParams.get("biz_content")).total_amount, "29.00");
  const fields = Object.fromEntries(checkout.searchParams);
  const content = Object.keys(fields).filter(k => k !== "sign" && fields[k] !== "").sort().map(k => `${k}=${fields[k]}`).join("&");
  assert.equal(verify("RSA-SHA256", Buffer.from(content), keys.publicKey, Buffer.from(fields.sign,"base64")), true);
  assert.equal(new URL(createAlipayCheckout(order, config, true).checkoutUrl).searchParams.get("method"), "alipay.trade.wap.pay");
});

test("the official SDK verifies decoded callback values once, including percent and ampersand characters", () => {
  const values = notification({ subject: "Cloud + 100% & annual" });
  const parsed = parseAlipayNotification(new URLSearchParams(values).toString());
  verifyAlipayNotification(parsed, config);
  assert.throws(() => verifyAlipayNotification({ ...parsed, total_amount: "0.01" }, config), /invalid_signature/);
  assert.throws(() => verifyAlipayNotification(notification({ seller_id: "another_seller" }), config), /payment_account_mismatch/);
  assert.throws(() => parseAlipayNotification("app_id=a&app_id=b"), /duplicate_provider_field/);
  assert.throws(() => verifyAlipayNotification(notification({ sign_type: "RSA" }), config), /invalid_signature/);
});

test("Alipay final payment states normalize precise decimal amounts and China timestamps", () => {
  const events = normalizeAlipayNotification(notification(), order, config);
  assert.equal(events.length, 1);
  assert.equal(events[0].amount_cents, 2900);
  assert.equal(events[0].occurred_at, "2026-10-03T12:00:00.000Z");
  assert.equal(normalizeAlipayNotification(notification({ trade_status: "WAIT_BUYER_PAY" }), order, config).length, 0);
  assert.throws(() => normalizeAlipayNotification(notification({ total_amount: "2.9e1" }), order, config), /invalid_provider_amount/);
  assert.throws(() => normalizeAlipayNotification(notification({ total_amount: "29.001" }), order, config), /invalid_provider_amount/);
  assert.throws(() => normalizeAlipayNotification(notification({ total_amount: "1.00" }), order, config), /payment_amount_mismatch/);
});

test("refund notifications carry cumulative totals rather than repeatedly subtracting earlier refunds", () => {
  const events = normalizeAlipayNotification(notification({ trade_status: "TRADE_CLOSED", refund_fee: "29.00" }), order, config);
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, "refund");
  assert.equal(events[1].refund_total_cents, 2900);
  assert.equal(events[1].action_id, "ali_trade:refund:2900");
  assert.equal(normalizeAlipayNotification(notification({ trade_status: "TRADE_CLOSED", refund_fee: "0.00" }), order, config).length, 0);
});

test("verified order queries grant only final merchant-bound amounts, never unpaid or fully refunded trades",()=>{
  const data={code:"10000",out_trade_no:order.id.replace(/-/g,""),trade_no:"ali_trade",total_amount:"29.00",
    trade_status:"TRADE_SUCCESS",send_pay_date:"2026-10-03 20:00:00",trans_currency:"CNY"};
  const event=normalizeAlipayQuery(data,order,config);assert.equal(event.action_id,"ali_trade");assert.equal(event.occurred_at,"2026-10-03T12:00:00.000Z");
  assert.equal(normalizeAlipayQuery(null,order,config),null);
  assert.equal(normalizeAlipayQuery({...data,trade_status:"WAIT_BUYER_PAY"},order,config),null);
  assert.equal(normalizeAlipayQuery({...data,trade_status:"TRADE_CLOSED"},order,config),null);
  assert.throws(()=>normalizeAlipayQuery({...data,out_trade_no:randomUUID().replace(/-/g,"")},order,config),/payment_order_mismatch/);
  assert.throws(()=>normalizeAlipayQuery({...data,trans_currency:"USD"},order,config),/payment_order_mismatch/);
  assert.throws(()=>normalizeAlipayQuery({...data,total_amount:"1.00"},order,config),/payment_amount_mismatch/);
});
