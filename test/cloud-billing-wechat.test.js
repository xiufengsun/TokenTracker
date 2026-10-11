const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, randomUUID, sign, verify, createCipheriv } = require("node:crypto");
const { createWechatCheckout, decryptWechatResource, merchantOrderId, normalizeWechatEvent, queryWechatOrder, verifyWechatMessage } = require("./helpers/load-cloud-module")("wechat");
const keys = generateKeyPairSync("rsa", { modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const config = { environment: "live", appId: "wx_test", merchantId: "merchant_test", merchantSerial: "cert_test",
  merchantPrivateKey: keys.privateKey, platformKeyId: "platform_test", platformPublicKey: keys.publicKey,
  apiV3Key: "12345678901234567890123456789012", notifyUrl: "https://example.com/functions/tokentracker-wechat-webhook" };
const order = { id: randomUUID(), user_id: randomUUID(), environment: "live", provider: "wechat", currency: "CNY",
  amount_cents: 2900, term_months: 1, expires_at: new Date(Date.now()+1800_000).toISOString() };

function signedHeaders(raw, timestamp = String(Math.floor(Date.now()/1000))) {
  const nonce = "test_nonce";
  return new Headers({ "Wechatpay-Timestamp": timestamp, "Wechatpay-Nonce": nonce,
    "Wechatpay-Serial": config.platformKeyId,
    "Wechatpay-Signature": sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), keys.privateKey).toString("base64") });
}
function resource(data, aad = "transaction") {
  const nonce = "123456789012";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final(), cipher.getAuthTag()]);
  return { resource: { algorithm: "AEAD_AES_256_GCM", nonce, associated_data: aad, ciphertext: encrypted.toString("base64") } };
}
function transaction() {
  return { mchid: config.merchantId, appid: config.appId, out_trade_no: merchantOrderId(order.id),
    attach: order.id, trade_type: "NATIVE", trade_state: "SUCCESS", transaction_id: "wx_transaction",
    amount: { total: 2900, payer_total: 2800, currency: "CNY" } };
}

test("WeChat verifies exact response bytes, key identity, and the signed timestamp", async () => {
  const raw = '{"code_url":"weixin://wxpay/bizpayurl?pr=test"}';
  const headers = signedHeaders(raw);
  await verifyWechatMessage(raw, headers, config);
  await assert.rejects(verifyWechatMessage(raw + " ", headers, config), /invalid_signature/);
  headers.set("Wechatpay-Serial", "untrusted_key");
  await assert.rejects(verifyWechatMessage(raw, headers, config), /invalid_signature/);
  await assert.rejects(verifyWechatMessage(raw, signedHeaders(raw, "1"), config), /stale_signature/);
});

test("encrypted callback resources reject changes to ciphertext, associated data, or encryption keys", async () => {
  const payload = resource(transaction());
  assert.deepEqual(await decryptWechatResource(payload, config), transaction());
  const tampered = structuredClone(payload); tampered.resource.associated_data = "refund";
  await assert.rejects(decryptWechatResource(tampered, config), /invalid_provider_encryption/);
  await assert.rejects(decryptWechatResource(payload, { ...config, apiV3Key: "0".repeat(32) }), /invalid_provider_encryption/);
  assert.deepEqual(await decryptWechatResource(resource(transaction(),""), config), transaction());
});

test("Native checkout is merchant-signed, uses the server quote, and verifies the returned QR payload", async () => {
  const result = await createWechatCheckout(order, config, async (url, init) => {
    assert.equal(url, "https://api.mch.weixin.qq.com/v3/pay/transactions/native");
    const body = JSON.parse(init.body);
    assert.equal(body.amount.total, 2900);
    assert.equal(body.out_trade_no, order.id.replace(/-/g, ""));
    const header = Object.fromEntries([...init.headers.Authorization.matchAll(/(\w+)="([^"]+)"/g)].map(m => [m[1],m[2]]));
    assert.equal(verify("RSA-SHA256", Buffer.from(`POST\n/v3/pay/transactions/native\n${header.timestamp}\n${header.nonce_str}\n${init.body}\n`), keys.publicKey, Buffer.from(header.signature,"base64")), true);
    const response = JSON.stringify({ code_url: "weixin://wxpay/bizpayurl?pr=test" });
    return new Response(response, { headers: signedHeaders(response) });
  });
  assert.equal(result.checkoutUrl, "weixin://wxpay/bizpayurl?pr=test");
  await assert.rejects(createWechatCheckout({ ...order, environment: "sandbox" }, { ...config, environment: "sandbox" }), /wechat_live_merchant_required/);
  await assert.rejects(createWechatCheckout(order, config, async () => Response.json({ code_url: "weixin://wxpay/bizpayurl?pr=test" })), /invalid_signature/);
});

test("callback fulfillment checks merchant, app, order, amount, currency, and final payment state", () => {
  const event = { id: "notification_test", event_type: "TRANSACTION.SUCCESS", create_time: new Date().toISOString() };
  const result = normalizeWechatEvent(event, transaction(), order, config);
  assert.equal(result.kind, "payment");
  assert.equal(result.amount_cents, 2900);
  assert.equal(result.action_id, "wx_transaction");
  for (const [field, value] of [["mchid", "other"], ["appid", "other"], ["out_trade_no", "0".repeat(32)], ["attach", randomUUID()]]) {
    assert.throws(() => normalizeWechatEvent(event, { ...transaction(), [field]: value }, order, config));
  }
  assert.throws(() => normalizeWechatEvent(event, { ...transaction(), amount: { total: 1, currency: "CNY" } }, order, config), /payment_amount_mismatch/);
  assert.equal(normalizeWechatEvent(event, { ...transaction(), trade_state: "NOTPAY" }, order, config), null);
});

test("only completed WeChat refunds reduce the paid ledger", () => {
  const event = { id: "refund_notification", event_type: "REFUND.SUCCESS", create_time: new Date().toISOString() };
  const data = { mchid: config.merchantId, out_trade_no: merchantOrderId(order.id), transaction_id: "wx_transaction",
    refund_id: "wx_refund", refund_status: "SUCCESS", amount: { total: 2900, refund: 2900, payer_total: 2900, payer_refund: 2900 } };
  assert.equal(normalizeWechatEvent(event, data, order, config).kind, "refund");
  assert.equal(normalizeWechatEvent(event, { ...data, refund_status: "PROCESSING" }, order, config), null);
});

test("order reconciliation verifies the merchant-signed query and never treats an unpaid response as paid",async()=>{
  const result=await queryWechatOrder(order,config,async(url,init)=>{
    const pathname=`/v3/pay/transactions/out-trade-no/${merchantOrderId(order.id)}?mchid=${config.merchantId}`;
    assert.equal(url,"https://api.mch.weixin.qq.com"+pathname);assert.equal(init.method,"GET");
    const auth=Object.fromEntries([...init.headers.Authorization.matchAll(/(\w+)="([^"]+)"/g)].map(m=>[m[1],m[2]]));
    assert.equal(verify("RSA-SHA256",Buffer.from(`GET\n${pathname}\n${auth.timestamp}\n${auth.nonce_str}\n\n`),keys.publicKey,Buffer.from(auth.signature,"base64")),true);
    const raw=JSON.stringify({...transaction(),success_time:"2026-10-03T20:00:00+08:00"});
    return new Response(raw,{headers:signedHeaders(raw)});
  });
  assert.equal(result.action_id,"wx_transaction");assert.equal(result.occurred_at,"2026-10-03T12:00:00.000Z");
  const raw=JSON.stringify({...transaction(),trade_state:"NOTPAY"});
  assert.equal(await queryWechatOrder(order,config,async()=>new Response(raw,{headers:signedHeaders(raw)})),null);
  await assert.rejects(queryWechatOrder(order,config,async()=>new Response(raw)),/invalid_signature/);
});
