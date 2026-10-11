// Provision test products without publishing them or changing existing products.
const fs = require("node:fs/promises");
const { WaffoPancake } = require("@waffo/pancake-ts");

const plans = [
  { sku: "cloud_usd_monthly", name: "TokenTracker Pro Monthly", amount: "4.99", months: 1, mode: "recurring" },
  { sku: "cloud_usd_yearly", name: "TokenTracker Pro Annual", amount: "39.99", months: 12, mode: "recurring" },
  { sku: "cloud_usd_monthly_fixed", name: "TokenTracker Pro 1 Month Pass", amount: "4.99", months: 1, mode: "fixed" },
  { sku: "cloud_usd_yearly_fixed", name: "TokenTracker Pro 1 Year Pass", amount: "39.99", months: 12, mode: "fixed" },
];

async function main() {
  if (process.env.WAFFO_ENVIRONMENT !== "test") throw Error("Product setup requires WAFFO_ENVIRONMENT=test");
  const merchantId = process.env.WAFFO_MERCHANT_ID;
  const storeId = process.env.WAFFO_STORE_ID;
  if (!merchantId || !storeId) throw Error("Merchant and store configuration required");
  const privateKey = process.env.WAFFO_PRIVATE_KEY || (process.env.WAFFO_PRIVATE_KEY_FILE
    ? await fs.readFile(process.env.WAFFO_PRIVATE_KEY_FILE, "utf8") : "");
  if (!privateKey) throw Error("Server private key configuration required");
  const client = new WaffoPancake({ merchantId, privateKey, environment: "test",
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }) });
  const query = { query: `query($id: String!) { store(id:$id) { id prodEnabled
    onetimeProducts { id status metadata prices { currency priceInfo { amount taxCategory } } }
    subscriptionProducts { id status metadata billingPeriod prices { currency priceInfo { amount taxCategory trialAmount } } }
  } }`, variables: { id: storeId } };
  const inventory = await client.graphql.query(query);
  if (inventory.errors?.length || !inventory.data?.store || inventory.data.store.id !== storeId) {
    throw Error("Unable to verify the selected test store");
  }
  const store = inventory.data.store;
  function check(product, plan) {
    const rows = product.prices.filter(price => price.currency === "USD");
    const meta = JSON.parse(product.metadata || "{}");
    if (product.status !== "active" || rows.length !== 1 || rows[0].priceInfo.amount !== plan.amount ||
        rows[0].priceInfo.taxCategory !== "saas" || rows[0].priceInfo.trialAmount != null ||
        (meta.trialDays != null && meta.trialDays !== 0) || (plan.mode === "recurring" &&
        product.billingPeriod !== (plan.months === 12 ? "yearly" : "monthly"))) {
      throw Error("Test product does not match the requested catalog: " + plan.sku);
    }
  }
  const manifest = { environment: "test", storeId, products: {} };
  for (const plan of plans) {
    const products = plan.mode === "recurring" ? store.subscriptionProducts : store.onetimeProducts;
    const matches = products.filter(product => {
      try { return JSON.parse(product.metadata || "{}").tokentrackerSku === plan.sku; } catch { return false; }
    });
    if (matches.length > 1) throw Error("Ambiguous test product binding for " + plan.sku);
    let product = matches[0];
    if (product) {
      check(product, plan);
    } else if (process.argv.includes("--apply")) {
      const params = { storeId, name: plan.name,
        description: "Hosted cross-device usage analysis and history. Local TokenTracker and community ranking remain free.",
        prices: { USD: { amount: plan.amount, taxCategory: "saas" } },
        metadata: { tokentrackerSku: plan.sku, billingMode: plan.mode } };
      const result = plan.mode === "recurring"
        ? await client.subscriptionProducts.create({ ...params, billingPeriod: plan.months === 12 ? "yearly" : "monthly" },
          { idempotencyKey: `${merchantId}_test_product_${plan.sku}` })
        : await client.onetimeProducts.create(params, { idempotencyKey: `${merchantId}_test_product_${plan.sku}` });
      product = result.product;
    }
    manifest.products[plan.sku] = { id: product?.id || null, billing_mode: plan.mode,
      currency: "USD", amount: plan.amount };
  }
  // Independent API read-back checks test product prices and ownership.
  const verified = await client.graphql.query(query);
  if (verified.errors?.length || !verified.data?.store) throw Error("Test catalog read-back failed");
  for (const plan of plans) {
    const id = manifest.products[plan.sku].id;
    if (!id) continue;
    const list = plan.mode === "recurring" ? verified.data.store.subscriptionProducts : verified.data.store.onetimeProducts;
    const product = list.find(product => product.id === id);
    if (!product) throw Error("Test catalog product read-back failed");
    check(product, plan);
  }
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch(() => { console.error("Waffo test catalog setup failed. Check configuration and the provider dashboard; no credentials were logged."); process.exitCode = 1; });
