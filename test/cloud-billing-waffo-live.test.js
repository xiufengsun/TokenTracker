const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, createVerify, generateKeyPairSync, randomUUID } = require("node:crypto");
const load = require("./helpers/load-cloud-module");
const { createWaffoCheckout, validateWaffoProduct, queryWaffoOrder } = load("waffo");
const { waffoConfig, configuredProviders } = load("runtime");
const keys = () => generateKeyPairSync("rsa", { modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const testKeys = keys();
const modeledProductionKeys = keys();
const fingerprint = key => createHash("sha256").update(Buffer.from(key.replace(/-----[^-]+-----|\s/g, ""), "base64")).digest("hex");
const id = prefix => prefix + "_" + "f".repeat(22);
const order = { id: randomUUID(), user_id: randomUUID(), environment: "live", provider: "waffo", sku: "cloud_usd_monthly",
  billing_mode: "recurring", currency: "USD", amount_cents: 499, term_months: 1, status: "pending" };
const config = { environment: "live", merchantId: id("MER"), storeId: id("STO"), privateKey: modeledProductionKeys.privateKey,
  livePrivateKeySha256: fingerprint(modeledProductionKeys.privateKey), checkoutPage: "https://product.example.test/billing/checkout",
  productIds: { cloud_usd_monthly: id("PROD"), cloud_usd_monthly_fixed: "PROD_" + "g".repeat(22) } };
function fixture(options = {}) {
  const { keyPair = modeledProductionKeys, storeId = config.storeId, status = "active" } = options;
  const hasProdVersion = Object.hasOwn(options, "hasProdVersion") ? options.hasProdVersion : true;
  const prodEnabled = Object.hasOwn(options, "prodEnabled") ? options.prodEnabled : true;
  const requests = [];
  const request = async (input, init) => {
    const url = new URL(input); const body = JSON.parse(init.body);
    requests.push({ path: url.pathname, body });
    assert.equal(url.origin, "https://api.waffo.ai", "fixture intercepts the real SDK before any actual network call");
    const canonical = `POST\n${url.pathname}\n${init.headers["X-Timestamp"]}\n${createHash("sha256").update(init.body).digest("base64")}`;
    assert.equal(createVerify("sha256").update(canonical).verify(keyPair.publicKey, init.headers["X-Signature"], "base64"), true);
    const field = body.query?.includes("onetimeProduct") ? "onetimeProduct" : "subscriptionProduct";
    if (url.pathname.endsWith("graphql")) return Response.json({ data: {
      store: { id: storeId, prodEnabled },
      [field]: { id: body.variables.id, storeId: config.storeId, status, hasProdVersion, metadata: "{}", billingPeriod: "monthly",
        prices: [{ currency: "USD", priceInfo: { amount: "4.99", taxCategory: "saas", trialAmount: null } }] } } });
    return Response.json({ data: { sessionId: "cs_fixture", checkoutUrl: "https://pancake.waffo.ai/store/fixture/checkout/cs_fixture",
      expiresAt: new Date(Date.now() + 1_800_000).toISOString() } });
  };
  return { request, requests, created: () => requests.filter(row => row.path.endsWith("create-session")).length };
}

test("a live config cannot prepare a bare test checkout using an unattested test private key", async () => {
  const live = { ...config, privateKey: testKeys.privateKey, livePrivateKeySha256: undefined };
  const provider = fixture({ keyPair: testKeys, hasProdVersion: false, prodEnabled: false });
  await assert.rejects(createWaffoCheckout(order, live, provider.request), /waffo_live_key_not_verified/);
  assert.equal(provider.requests.length, 0);
  assert.equal(provider.created(), 0);
});
test("missing, malformed, or changed production private-key pins fail before product lookup or session creation", async () => {
  for (const pin of [undefined, "", "true", "f".repeat(63), "g".repeat(64), fingerprint(testKeys.privateKey)]) {
    const provider = fixture();
    await assert.rejects(createWaffoCheckout(order, { ...config, livePrivateKeySha256: pin }, provider.request), /waffo_live_key_not_verified/);
    await assert.rejects(validateWaffoProduct(order, { ...config, livePrivateKeySha256: pin }, provider.request), /waffo_live_key_not_verified/);
    assert.equal(provider.requests.length, 0);
  }
  const provider = fixture({ keyPair: testKeys });
  await assert.rejects(createWaffoCheckout(order, { ...config, privateKey: testKeys.privateKey }, provider.request), /waffo_live_key_not_verified/);
  assert.equal(provider.requests.length, 0);
});
test("an operator-bound modeled production key still requires a published active product and production-enabled store", async () => {
  for (const options of [{ hasProdVersion: false }, { hasProdVersion: undefined }, { prodEnabled: false },
    { prodEnabled: undefined }, { storeId: "STO_" + "x".repeat(22) }, { status: "inactive" }]) {
    const provider = fixture(options);
    await assert.rejects(createWaffoCheckout(order, config, provider.request), /waffo_product_configuration_mismatch/);
    assert.equal(provider.created(), 0);
  }
});
test("canonical PEM whitespace retains the verified material pin in a local modeled production fixture", async () => {
  const provider = fixture();
  const key = "\n" + config.privateKey.replace(/\n/g, "\r\n") + "\n";
  const checkout = await createWaffoCheckout(order, { ...config, privateKey: key }, provider.request);
  assert.equal(provider.created(), 1);
  assert.equal(checkout.checkoutUrl, "https://pancake.waffo.ai/store/fixture/checkout/cs_fixture");
  assert.match(provider.requests[0].body.query, /hasProdVersion/);
  assert.match(provider.requests[0].body.query, /store\(id: \$storeId\)/);
  assert.deepEqual(provider.requests[0].body.variables, { id: id("PROD"), storeId: config.storeId });
});
test("the same production attestation and published-version gates protect fixed passes", async () => {
  const fixed = { ...order, billing_mode: "fixed", sku: "cloud_usd_monthly_fixed" };
  const unpublished = fixture({ hasProdVersion: false });
  await assert.rejects(createWaffoCheckout(fixed, config, unpublished.request), /waffo_product_configuration_mismatch/);
  assert.equal(unpublished.created(), 0);
  const published = fixture();
  assert.equal((await createWaffoCheckout(fixed, config, published.request)).priceId, config.productIds[fixed.sku]);
  assert.equal(published.created(), 1);
  assert.match(published.requests[0].body.query, /onetimeProduct/);
});
test("sandbox does not require a production pin or published production snapshot", async () => {
  const sandboxOrder = { ...order, environment: "sandbox" };
  const sandbox = { ...config, environment: "sandbox", privateKey: testKeys.privateKey, livePrivateKeySha256: "not-used" };
  const provider = fixture({ keyPair: testKeys, hasProdVersion: false, prodEnabled: false });
  const checkout = await createWaffoCheckout(sandboxOrder, sandbox, provider.request);
  assert.equal(provider.created(), 1);
  assert.equal(new URL(checkout.checkoutUrl).searchParams.get("test"), "true");
  assert.deepEqual(provider.requests[0].body.variables, { id: id("PROD") });
  assert.doesNotMatch(provider.requests[0].body.query, /hasProdVersion|prodEnabled/);
});
test("a runtime sandbox never reads the live-key pin, while a live catalog requires a valid pin shape", () => {
  const previous = globalThis.Deno; const reads = [];
  const env = { TOKENTRACKER_BILLING_ENVIRONMENT: "sandbox", WAFFO_PRIVATE_KEY: testKeys.privateKey, WAFFO_MERCHANT_ID: id("MER"), WAFFO_STORE_ID: id("STO"),
    WAFFO_CLOUD_MONTHLY_PRODUCT_ID: id("PROD"), WAFFO_CLOUD_YEARLY_PRODUCT_ID: id("PROD"),
    WAFFO_CLOUD_MONTHLY_PASS_PRODUCT_ID: id("PROD"), WAFFO_CLOUD_YEARLY_PASS_PRODUCT_ID: id("PROD"), WAFFO_LIVE_PRIVATE_KEY_SHA256: "must-not-read" };
  globalThis.Deno = { env: { get: name => { reads.push(name); return env[name]; } } };
  try {
    assert.equal(waffoConfig().livePrivateKeySha256, undefined);
    assert.equal(configuredProviders().waffo, true);
    assert.equal(reads.includes("WAFFO_LIVE_PRIVATE_KEY_SHA256"), false);
    env.TOKENTRACKER_BILLING_ENVIRONMENT = "live";
    assert.equal(configuredProviders().waffo, false);
    env.WAFFO_LIVE_PRIVATE_KEY_SHA256 = fingerprint(modeledProductionKeys.privateKey);
    assert.equal(waffoConfig().livePrivateKeySha256, env.WAFFO_LIVE_PRIVATE_KEY_SHA256);
    assert.equal(configuredProviders().waffo, true, "catalog reports shape only; async material and provider checks still run before creation");
  } finally { globalThis.Deno = previous; }
});
test("a testMode provider order still cannot yield live financial events after a valid local key attestation", async () => {
  let returnedEvents = 0;
  await assert.rejects(async () => {
    const events = await queryWaffoOrder(order, config, async () => Response.json({ data: {
      subscriptionOrders: [{ id: id("ORD"), storeId: config.storeId, currency: "USD", testMode: true,
        orderMerchantExternalId: order.id, metadata: JSON.stringify({ tokentracker_order_id: order.id,
          tokentracker_user_id: order.user_id, tokentracker_environment: "live" }) }], subscriptionOrdersCount: 1 } }));
    returnedEvents += events.length;
  }, /payment_order_mismatch/);
  assert.equal(returnedEvents, 0);
});
