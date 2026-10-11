const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { randomUUID, generateKeyPairSync, createHmac, createSign, createVerify, createHash } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const load = require("./helpers/load-cloud-module");
const { functionSql } = require("./helpers/cloud-usage-archive-fixture");
const handlers = { billing: load("../tokentracker-billing").default,
  webhook: load("../tokentracker-waffo-webhook").default };
const originalFetch = globalThis.fetch;
const previousDeno = globalThis.Deno;
const previousWebhookKey = process.env.WAFFO_WEBHOOK_TEST_PUBLIC_KEY;
const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const requestKeys = rsa();
const webhookKeys = rsa();
const secret = "isolated-waffo-http-auth-secret";
const shortId = prefix => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 22)}`;
const storeId = shortId("STO");
const merchantId = shortId("MER");
const products = new Map();
const sessions = new Map();
const providerOrders = new Map();
const cancellations = new Map();
const customerSessions = new Map();
const unpaidCancelKeys = [];
const sdkKeys = [];
let db, server, base, env, failAfterSession = false, sessionCount = 0, cancelCount = 0;
let failApplyBatch = 0, applyBatchCalls = 0, failAuthorizationOnce = false;
const plans = [
  { sku: "cloud_usd_monthly", amount: 499, months: 1, mode: "recurring", variable: "WAFFO_CLOUD_MONTHLY_PRODUCT_ID" },
  { sku: "cloud_usd_yearly", amount: 3999, months: 12, mode: "recurring", variable: "WAFFO_CLOUD_YEARLY_PRODUCT_ID" },
  { sku: "cloud_usd_monthly_fixed", amount: 499, months: 1, mode: "fixed", variable: "WAFFO_CLOUD_MONTHLY_PASS_PRODUCT_ID" },
  { sku: "cloud_usd_yearly_fixed", amount: 3999, months: 12, mode: "fixed", variable: "WAFFO_CLOUD_YEARLY_PASS_PRODUCT_ID" },
].map(p => ({ ...p, id: shortId("PROD") }));
const decimal = amount => (amount / 100).toFixed(2);
const money = amount => ({ amount: String(amount), currency: "USD", display: decimal(amount) });
const breakdown = (amount, tax) => ({ currency: "USD", subtotal: decimal(amount), taxAmount: decimal(tax),
  total: decimal(amount + tax), taxCategory: "saas" });
const migration = name => fs.readFileSync(path.join(__dirname, "../migrations", name), "utf8");
const identifier = value => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw Error("unsupported database identifier");
  return '"' + value + '"';
};

function token(sub, role = "authenticated") {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub, role, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `${header}.${claims}.${createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url")}`;
}

async function setupDatabase() {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE tokentracker_devices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,
      device_name text NOT NULL,platform text,machine_id text,revoked_at timestamptz,
      name_customized boolean NOT NULL DEFAULT false,default_device_name text,created_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX active_machine ON tokentracker_devices(user_id,machine_id) WHERE revoked_at IS NULL;
    CREATE UNIQUE INDEX active_name ON tokentracker_devices(user_id,platform,device_name) WHERE revoked_at IS NULL;
    CREATE TABLE tokentracker_device_machine(device_id uuid PRIMARY KEY,machine_cluster_id text);
    CREATE TABLE tokentracker_device_tokens(id uuid PRIMARY KEY,user_id uuid,device_id uuid,token_hash text UNIQUE,
      revoked_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE tokentracker_device_codes(device_code text PRIMARY KEY,user_code text UNIQUE,status text,
      user_id uuid,expires_at timestamptz,approved_at timestamptz,client_info text,machine_id text);
    CREATE TABLE tokentracker_hourly(user_id uuid,device_id uuid,hour_start timestamptz,source text,model text,
      input_tokens bigint,cached_input_tokens bigint,cache_creation_input_tokens bigint,output_tokens bigint,
      reasoning_output_tokens bigint,total_tokens bigint CHECK(total_tokens>=0),billable_total_tokens bigint,
      conversations integer,total_cost_usd numeric,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
      PRIMARY KEY(user_id,device_id,hour_start,source,model));
    GRANT USAGE ON SCHEMA auth TO project_admin;
    GRANT SELECT(id) ON auth.users TO project_admin;
    GRANT ALL ON tokentracker_devices,tokentracker_device_machine,tokentracker_device_tokens,
      tokentracker_device_codes,tokentracker_hourly TO project_admin;`);
  await db.exec(functionSql(migration("20260719152022_harden-backend-concurrency.sql"), "refresh_tokentracker_device_identity"));
  const sessionsSql = migration("20260817120000_account-session-states.sql");
  await db.exec(sessionsSql.slice(0, sessionsSql.indexOf("-- Leaderboard: account-level sources")));
  for (const name of ["20261003120000_cloud-subscriptions.sql", "20261004120000_cloud-machine-access.sql",
    "20261007120000_cloud-waffo.sql", "20261007130000_cloud-waffo-retry.sql",
    "20261007140000_cloud-waffo-attempts.sql", "20261007150000_cloud-waffo-authorizations.sql",
    "20261007160000_cloud-waffo-sandbox-periods.sql",
    "20261008120000_self-hosted-access.sql", "20261009120000_cloud-gifts.sql"]) await db.exec(migration(name));
  await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now()-interval '1 hour' WHERE environment='sandbox'");
}

async function databaseGateway(req, res, url, raw) {
  const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  assert.equal(req.headers.authorization, "Bearer " + env.INSFORGE_SERVICE_ROLE_KEY);
  await db.transaction(async tx => {
    await tx.exec("SET LOCAL ROLE project_admin");
    if (url.pathname.startsWith("/api/database/rpc/")) {
      const params = JSON.parse(raw || "{}");
      if (url.pathname.endsWith("/cloud_apply_waffo_events")) {
        applyBatchCalls++;
        if (applyBatchCalls === failApplyBatch) throw Error("isolated transient batch failure");
      }
      if (url.pathname.endsWith("/cloud_record_waffo_authorization") && failAuthorizationOnce) {
        failAuthorizationOnce = false;
        throw Error("isolated authorization audit failure");
      }
      const names = Object.keys(params);
      const values = names.map(k => k === "p_waffo_order_ids" ? params[k]
        : params[k] && typeof params[k] === "object" ? JSON.stringify(params[k]) : params[k]);
      const sql = `SELECT ${identifier(url.pathname.split("/").pop())}(${names.map((k, i) => `${identifier(k)} => $${i + 1}`).join(",")}) AS r`;
      const result = await tx.query(sql, values);
      send(200, result.rows[0].r); return;
    }
    const params = []; const filters = [];
    for (const [key, value] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(key)) continue;
      if (value.startsWith("eq.")) { params.push(value.slice(3)); filters.push(identifier(key) + "=$" + params.length); }
      else if (value === "not.is.null") filters.push(identifier(key) + " IS NOT NULL");
      else if (value.startsWith("in.(") && value.endsWith(")")) {
        params.push(value.slice(4, -1).split(",")); filters.push(identifier(key) + "=ANY($" + params.length + "::text[])");
      } else throw Error("unsupported database filter");
    }
    const select = url.searchParams.get("select") || "*";
    let sql = `SELECT ${select === "*" ? "*" : select.split(",").map(identifier).join(",")} FROM ${identifier(url.pathname.split("/").pop())}`;
    if (filters.length) sql += " WHERE " + filters.join(" AND ");
    if (url.searchParams.has("order")) {
      sql += " ORDER BY " + url.searchParams.get("order").split(",").map(term => {
        const [field, direction] = term.split(".");
        return identifier(field) + (direction === "desc" ? " DESC" : " ASC");
      }).join(",");
    }
    sql += " LIMIT " + Math.min(100, Number(url.searchParams.get("limit")) || 100);
    const offset = Number(url.searchParams.get("offset") || 0);
    assert.ok(Number.isSafeInteger(offset) && offset >= 0);
    sql += " OFFSET " + offset;
    const result = await tx.query(sql, params);
    if (req.headers.accept?.includes("vnd.pgrst.object")) {
      if (result.rows.length !== 1) { send(406, { code: "PGRST116", message: "No single object", details: "The result contains " + result.rows.length + " rows" }); return; }
      send(200, result.rows[0]);
    } else send(200, result.rows);
  });
}

const allProviderOrders = () => [...providerOrders.values()].flatMap(value => Array.isArray(value) ? value : [value]);

function providerRequest(input, init) {
  const url = new URL(typeof input === "string" ? input : input.url || input.href);
  assert.equal(url.origin, "https://api.waffo.ai", "the integration fixture must never call a merchant service");
  const body = JSON.parse(init.body);
  if (init.headers.Authorization) {
    assert.equal(init.headers["X-Environment"], "test");
    assert.equal(init.headers["X-Merchant-Id"], undefined);
    const session = customerSessions.get(init.headers.Authorization.slice("Bearer ".length));
    assert.ok(session);
    const remote = allProviderOrders().find(o => o.id === (body.variables?.id || body.orderId));
    assert.equal(remote?.storeId, session.storeId);
    assert.equal(remote?.merchantProvidedBuyerIdentity, session.buyerIdentity);
    if (url.pathname === "/v1/graphql") {
      assert.ok(!/\bmetadata\b/.test(body.query),"the real customer OnetimeOrder schema has no metadata field");
      return Response.json({ data: { onetimeOrder: {id:remote.id,storeId:remote.storeId,currency:remote.currency,
        testMode:remote.testMode,orderMerchantExternalId:remote.orderMerchantExternalId,
        productVersion:{productId:remote.productVersion.productId}} } });
    }
    assert.equal(url.pathname, "/v1/actions/onetime-order/cancel-order");
    assert.equal(init.headers["X-Idempotency-Key"], `tokentracker-sandbox-close-${remote.orderMerchantExternalId}-${remote.id}`);
    const key = init.headers["X-Idempotency-Key"];
    if (cancellations.has(key)) return Response.json({ data: cancellations.get(key) });
    assert.equal(remote.status, "pending");
    unpaidCancelKeys.push(key);
    remote.status = "canceled"; remote.updatedAt = new Date().toISOString();
    const canceled = { orderId: remote.id, status: "canceled" }; cancellations.set(key,canceled);
    return Response.json({ data: canceled });
  }
  const canonical = `POST\n${url.pathname}\n${init.headers["X-Timestamp"]}\n${createHash("sha256").update(init.body).digest("base64")}`;
  assert.equal(init.headers["X-Merchant-Id"], merchantId);
  assert.equal(createVerify("sha256").update(canonical).verify(requestKeys.publicKey, init.headers["X-Signature"], "base64"), true);
  if (url.pathname === "/v1/graphql") {
    if (body.query.includes("subscriptionProduct(id:") || body.query.includes("onetimeProduct(id:")) {
      const field = body.query.includes("subscriptionProduct(id:") ? "subscriptionProduct" : "onetimeProduct";
      const product = products.get(body.variables.id);
      const matches = product?.mode === (field === "subscriptionProduct" ? "recurring" : "fixed");
      return Response.json({ data: { [field]: matches ? product : null } });
    }
    assert.match(body.query, /storeId: \$storeId, filter: \{ orderMerchantExternalId: \{ eq: \$ref \} \}/);
    assert.equal(body.variables.storeId, storeId);
    const field = body.query.includes("subscriptionOrders(") ? "subscriptionOrders" : "onetimeOrders";
    const value = providerOrders.get(body.variables.ref);
    const rows = Array.isArray(value) ? value : value ? [value] : [];
    const offset = Number(body.variables.offset) || 0;
    return Response.json({ data: { [field]: rows.slice(offset, offset + 100), [field + "Count"]: rows.length } });
  }
  if (url.pathname === "/v1/actions/checkout/create-session") {
    assert.equal(body.productType, undefined); assert.equal(body.withTrial, false);
    assert.equal(body.priceSnapshot, undefined); assert.equal(body.originOrderId, undefined);
    const key = init.headers["X-Idempotency-Key"];
    assert.match(key, /^tokentracker-sandbox-checkout-[0-9a-f-]{36}$/);
    assert.equal(key, `tokentracker-sandbox-checkout-${body.orderMerchantExternalId}`);
    sdkKeys.push(key);
    if (!sessions.has(key)) {
      sessionCount++;
      const sessionId = "cs_" + randomUUID();
      sessions.set(key, { sessionId, checkoutUrl: "https://pancake.waffo.ai/store/isolated/checkout/" + sessionId,
        expiresAt: new Date(Date.now() + 1800_000).toISOString(), metadata: body.metadata, productId: body.productId });
    }
    if (failAfterSession) { failAfterSession = false; return Response.json({ errors: [{ layer: "transport", message: "isolated lost response" }] }, { status: 502 }); }
    return Response.json({ data: sessions.get(key) });
  }
  if (url.pathname === "/v1/actions/subscription-order/cancel-order") {
    const remote = allProviderOrders().find(o => o.id === body.orderId);
    assert.ok(remote);
    const key = init.headers["X-Idempotency-Key"];
    const operation = createHash("sha256").update(remote.updatedAt).digest("hex");
    if (cancellations.has(key)) return Response.json({ data: cancellations.get(key) });
    assert.ok(key === `tokentracker-sandbox-cancel-${remote.orderMerchantExternalId}-${operation}` ||
      key === `tokentracker-sandbox-close-${remote.orderMerchantExternalId}-${remote.id}`);
    cancelCount++;
    if (key.includes("-close-")) unpaidCancelKeys.push(key);
    remote.status = remote.status === "pending" ? "canceled" : "canceling"; remote.willRenew = false;
    remote.updatedAt = new Date(Math.max(Date.now(), Date.parse(remote.updatedAt)) + 1000).toISOString();
    const result = { orderId: remote.id, status: remote.status };
    cancellations.set(key, result);
    return Response.json({ data: result });
  }
  if (url.pathname === "/v1/actions/auth/issue-session-token") {
    assert.equal(body.storeId, storeId); assert.equal(typeof body.buyerIdentity, "string");
    assert.equal(init.headers["X-Idempotency-Key"], undefined);
    const token = "isolated-customer-" + randomUUID();
    customerSessions.set(token, { storeId, buyerIdentity: body.buyerIdentity });
    return Response.json({ data: { token, expiresAt: new Date(Date.now() + 900_000).toISOString() } });
  }
  throw Error("unsupported isolated provider operation");
}

test.before(async () => {
  await setupDatabase();
  server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, base);
    try {
      if (url.pathname.startsWith("/functions/")) {
        const handler = url.pathname.endsWith("billing") ? handlers.billing : handlers.webhook;
        const result = await handler(new Request(url, { method: req.method, headers: req.headers, ...(raw ? { body: raw } : {}) }));
        res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text()); return;
      }
      await databaseGateway(req, res, url, raw);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: error.code || "LOCAL_SQL", message: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  env = { INSFORGE_BASE_URL: base, INSFORGE_SERVICE_ROLE_KEY: token(randomUUID(), "project_admin"), ANON_KEY: token(randomUUID(), "anon"),
    JWT_SECRET: secret, TOKENTRACKER_BILLING_ENVIRONMENT: "sandbox", TOKENTRACKER_BILLING_SITE_URL: "https://www.tokentracker.cc",
    WAFFO_MERCHANT_ID: merchantId, WAFFO_STORE_ID: storeId, WAFFO_PRIVATE_KEY: requestKeys.privateKey };
  for (const plan of plans) {
    env[plan.variable] = plan.id;
    products.set(plan.id, { ...plan, storeId, status: "active", metadata: "{}",
      billingPeriod: plan.months === 12 ? "yearly" : "monthly",
      prices: [{ currency: "USD", priceInfo: { amount: decimal(plan.amount), taxCategory: "saas", trialAmount: null } }] });
  }
  process.env.WAFFO_WEBHOOK_TEST_PUBLIC_KEY = webhookKeys.publicKey;
  globalThis.Deno = { env: { get: key => env[key] } };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url || input.href);
    return url.origin === base ? originalFetch(input, init) : providerRequest(input, init);
  };
});

test.after(async () => {
  try {
    globalThis.fetch = originalFetch;
    if (previousDeno === undefined) delete globalThis.Deno; else globalThis.Deno = previousDeno;
    if (previousWebhookKey === undefined) delete process.env.WAFFO_WEBHOOK_TEST_PUBLIC_KEY;
    else process.env.WAFFO_WEBHOOK_TEST_PUBLIC_KEY = previousWebhookKey;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await db?.close();
  }
});

async function user() { const id = randomUUID(); await db.query("INSERT INTO auth.users VALUES($1)", [id]); return id; }
async function api(action, value, owner) {
  const response = await originalFetch(`${base}/functions/billing?action=${action}`, { method: value === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + token(owner), "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { response, data: await response.json() };
}
async function checkout(owner, sku = "cloud_usd_monthly", request_id = randomUUID()) {
  return api("checkout", { provider: "waffo", sku, request_id }, owner);
}
async function localOrder(id) { return (await db.query("SELECT * FROM tokentracker_cloud_orders WHERE id=$1", [id])).rows[0]; }
async function account(owner) { const result = await api("account", undefined, owner); assert.equal(result.response.status, 200); return result.data; }
function makeRemote(local, tax = 0) {
  const plan = plans.find(p => p.sku === local.sku);
  const start = new Date(Date.now() - 1000); const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + local.term_months);
  const total = local.amount_cents + tax;
  const snapshot = breakdown(local.amount_cents, tax);
  const remote = { id: shortId("ORD"), storeId, status: plan.mode === "recurring" ? "active" : "completed",
    currency: "USD", testMode: true, orderMerchantExternalId: local.id,
    merchantProvidedBuyerIdentity: local.user_id,
    metadata: JSON.stringify({ tokentracker_order_id: local.id, tokentracker_user_id: local.user_id, tokentracker_environment: "sandbox" }),
    productVersion: { id: shortId("VER"), productId: plan.id, prices: products.get(plan.id).prices,
      metadata: "{}", billingPeriod: plan.months === 12 ? "yearly" : "monthly" },
    priceSnapshot: plan.mode === "recurring" ? { currency: "USD", specialPhase: null, specialPhaseDays: null, regularPhase: snapshot } : snapshot,
    billingPeriod: plan.months === 12 ? "yearly" : "monthly", isInTrial: false, willRenew: true,
    currentPeriodStart: start.toISOString(), currentPeriodEnd: end.toISOString(), currentPeriodNumber: 1,
    changeOriginOrderId: null, supersededByOrderId: null, createdAt: start.toISOString(), updatedAt: new Date().toISOString() };
  remote.payments = [{ id: shortId("PAY"), orderId: remote.id, status: "succeeded", testMode: true,
    periodNumber: plan.mode === "recurring" ? 1 : null, orderMerchantExternalId: local.id, createdAt: start.toISOString(),
    amount: money(total), snapshotAmountDetails: { ...snapshot, phase: "regular" },
    pspAmountDetails: { amount: decimal(total), currency: "USD" }, refunds: [] }];
  providerOrders.set(local.id, remote); return remote;
}
function notification(remote, type = "subscription.activated", data = {}) {
  const phaseEvent = type !== "subscription.payment_succeeded" && type.startsWith("subscription.");
  const payment = remote.payments.find(p => p.periodNumber === remote.currentPeriodNumber) || remote.payments[0];
  const refund = remote.payments.flatMap(p => p.refunds).filter(r => r.status === "succeeded").at(-1);
  const eventId = type.startsWith("refund.") ? refund?.id || shortId("REF")
    : phaseEvent ? remote.id : payment.id;
  return { id: randomUUID(), timestamp: new Date().toISOString(), eventId,
    eventType: type, mode: "test", storeId, data: { orderId: remote.id,
      orderMerchantExternalId: remote.orderMerchantExternalId, currency: "USD", ...data,
      ...(phaseEvent ? { periodNumber: remote.currentPeriodNumber, currentPeriodStart: remote.currentPeriodStart,
        currentPeriodEnd: remote.currentPeriodEnd } : {}) } };
}
async function webhook(event, options = {}) {
  const raw = JSON.stringify(event);
  const timestamp = Date.now();
  const signature = `t=${timestamp},v1=${createSign("sha256").update(`${timestamp}.${raw}`).sign(webhookKeys.privateKey, "base64")}`;
  const response = await originalFetch(`${base}/functions/webhook`, { method: "POST", headers: { "x-waffo-signature": signature },
    body: options.tamper ? raw + " " : raw });
  return { response, data: await response.json() };
}

test("global Waffo catalog and four authenticated checkouts freeze the correct mode and product", async () => {
  const owner = await user();
  const catalog = await api("catalog", undefined, owner);
  assert.equal(catalog.response.status, 200); assert.equal(catalog.data.providers.waffo, true);
  assert.equal(catalog.data.prices.length, 4);
  assert.ok(catalog.data.prices.every(p => p.currency === "USD"));
  assert.deepEqual(catalog.data.prices.map(p => [p.sku, p.amount_cents, p.billing_mode]).sort(),
    plans.map(p => [p.sku, p.amount, p.mode]).sort());
  for (const plan of plans) {
    const owner = await user();
    assert.equal((await account(owner)).membership.can_upload_cloud, false);
    const created = await checkout(owner, plan.sku); assert.equal(created.response.status, 200);
    const row = await localOrder(created.data.order.id);
    assert.equal(row.billing_mode, plan.mode); assert.equal(row.amount_cents, plan.amount);
    assert.equal(row.provider_price_id, plan.id); assert.match(row.provider_checkout_id, /^cs_/);
    assert.equal(row.provider_order_id, null); assert.equal(row.waffo_order_id, null);
    assert.equal((await account(owner)).membership.can_upload_cloud, false);
    const redirect = await api("order&id=" + row.id + "&success=true", undefined, owner);
    assert.equal(redirect.data.order.payment_state, "unpaid"); assert.equal(redirect.data.membership.can_upload_cloud, false);
    const tax = plan.months === 12 ? 800 : 100;
    const remote = makeRemote(row, tax);
    assert.equal((await webhook(notification(remote, plan.mode === "recurring" ? "subscription.activated" : "order.completed"))).response.status, 200);
    const paid = await account(owner);
    assert.equal(paid.membership.can_upload_cloud, true);
    assert.equal(paid.payments[0].amount_cents, plan.amount + tax);
    assert.equal(paid.subscriptions.length, plan.mode === "recurring" ? 1 : 0);
  }
  for (const provider of ["paddle", "wechat", "alipay"]) {
    const rejected = await api("checkout", { provider, sku: "cloud_usd_monthly", request_id: randomUUID() }, await user());
    assert.equal(rejected.response.status, 503); assert.equal(rejected.data.error, "payment_provider_not_configured");
  }
});

test("a lost checkout response retries the same SDK session and returning to success grants nothing", async () => {
  const owner = await user(); const request = randomUUID(); const before = sessionCount;
  failAfterSession = true;
  const ambiguous = await checkout(owner, "cloud_usd_monthly", request);
  assert.equal(ambiguous.response.status, 202); assert.equal(ambiguous.data.pending, true);
  const recovered = await checkout(owner, "cloud_usd_monthly", request);
  assert.equal(recovered.response.status, 200); assert.equal(recovered.data.order.id, ambiguous.data.order.id);
  assert.equal(sessionCount, before + 1);
  const key = `tokentracker-sandbox-checkout-${recovered.data.order.id}`;
  assert.equal(sdkKeys.filter(value => value === key).length, 2);
  const repeated = await checkout(owner, "cloud_usd_monthly", request);
  assert.equal(repeated.response.status, 200); assert.equal(repeated.data.order.checkout_url, recovered.data.order.checkout_url);
  assert.equal(sessionCount, before + 1);
  assert.equal((await account(owner)).membership.can_upload_cloud, false);
  const pending = await api("reconcile", { id: recovered.data.order.id }, owner);
  assert.equal(pending.response.status, 200); assert.equal(pending.data.confirmed, false);
  assert.equal((await api("reconcile", { id: recovered.data.order.id }, owner)).response.status, 429);
});

test("a payment callback waits for its phase, then SQL activates once and owner cancellation keeps the paid term", async () => {
  const owner = await user(); const outsider = await user();
  const created = await checkout(owner); const row = await localOrder(created.data.order.id);
  const remote = makeRemote(row, 100); const starts = remote.currentPeriodStart; const ends = remote.currentPeriodEnd;
  remote.currentPeriodStart = null; remote.currentPeriodEnd = null;
  const early = await webhook(notification(remote, "subscription.payment_succeeded"));
  assert.equal(early.response.status, 503); assert.equal(early.data.error, "waffo_billing_period_pending");
  assert.equal((await account(owner)).payments.length, 0);
  remote.currentPeriodStart = starts; remote.currentPeriodEnd = ends;
  assert.equal((await webhook(notification(remote))).response.status, 200);
  const active = await account(owner);
  assert.equal(active.membership.status, "active"); assert.equal(active.membership.can_upload_cloud, true);
  assert.equal(active.payments.length, 1); assert.equal(active.payments[0].amount_cents, 599);
  assert.equal(active.subscriptions[0].provider_subscription_id, remote.id);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_periods WHERE order_id=$1", [row.id])).rows[0].n, 1);
  const duplicate = await webhook(notification(remote, "subscription.payment_succeeded"));
  assert.equal(duplicate.response.status, 200);
  const repeated = await account(owner); assert.equal(repeated.payments.length, 1);
  assert.equal(repeated.membership.expires_at, active.membership.expires_at);
  assert.equal((await api("reconcile", { id: row.id }, outsider)).response.status, 404);
  assert.equal((await api("cancel", { subscription_id: remote.id }, outsider)).response.status, 404);
  assert.equal((await api("portal", { subscription_id: remote.id }, outsider)).response.status, 404);
  const reconciled = await api("reconcile", { id: row.id }, owner);
  assert.equal(reconciled.response.status, 200); assert.equal(reconciled.data.confirmed, true);
  const cancelled = await api("cancel", { subscription_id: remote.id }, owner);
  assert.equal(cancelled.response.status, 200); assert.equal(cancelCount, 1);
  const after = await account(owner);
  assert.equal(after.subscriptions[0].cancel_at_period_end, true);
  assert.equal(after.subscriptions[0].next_billed_at, null);
  assert.equal(after.membership.expires_at, active.membership.expires_at);
  assert.equal(after.membership.can_upload_cloud, true);
});

test("invalid signatures, stores, modes, business references and actual amounts never grant membership", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const event = notification(remote);
  assert.equal((await webhook(event, { tamper: true })).response.status, 401);
  assert.equal((await webhook({ ...event, mode: "prod" })).response.status, 401);
  assert.equal((await webhook({ ...event, storeId: shortId("STO") })).response.status, 401);
  assert.equal((await webhook({ ...event, data: { ...event.data, orderMerchantExternalId: randomUUID() } })).response.status, 404);
  remote.payments[0].pspAmountDetails.amount = "0.01";
  assert.equal((await webhook(event)).response.status, 400);
  assert.equal((await account(owner)).payments.length, 0);
  assert.equal((await account(owner)).membership.can_upload_cloud, false);
  remote.payments[0].pspAmountDetails.amount = "4.99";
  remote.metadata = JSON.stringify({ tokentracker_order_id: row.id, tokentracker_user_id: randomUUID(), tokentracker_environment: "sandbox" });
  assert.equal((await webhook(event)).response.status, 400);
  assert.equal((await account(owner)).payments.length, 0);
});

test("a signed older phase can recover delayed charges without applying the current phase to old payments", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const firstEnd = new Date(Date.now() + 3600_000); const firstStart = new Date(firstEnd); firstStart.setUTCMonth(firstStart.getUTCMonth() - 1);
  const secondEnd = new Date(firstEnd); secondEnd.setUTCMonth(secondEnd.getUTCMonth() + 1);
  remote.payments[0].createdAt = firstStart.toISOString();
  remote.payments.push({ ...structuredClone(remote.payments[0]), id: shortId("PAY"), periodNumber: 2, createdAt: new Date().toISOString() });
  remote.currentPeriodNumber = 2; remote.currentPeriodStart = firstEnd.toISOString(); remote.currentPeriodEnd = secondEnd.toISOString();
  remote.updatedAt = new Date(Date.now() + 1000).toISOString();
  const missing = await webhook(notification(remote, "subscription.payment_succeeded"));
  assert.equal(missing.response.status, 503); assert.equal(missing.data.error, "waffo_billing_period_pending");
  assert.equal((await account(owner)).payments.length, 0);
  const older = notification(remote, "subscription.renewed");
  older.data.periodNumber = 1; older.data.currentPeriodStart = firstStart.toISOString(); older.data.currentPeriodEnd = firstEnd.toISOString();
  assert.equal((await webhook(older)).response.status, 200);
  const paid = await db.query("SELECT transaction_id,starts_at,ends_at FROM tokentracker_cloud_payments WHERE order_id=$1 ORDER BY paid_at", [row.id]);
  assert.equal(paid.rows.length, 2);
  assert.equal(paid.rows[0].ends_at.toISOString(), firstEnd.toISOString());
  assert.equal(paid.rows[1].starts_at.toISOString(), firstEnd.toISOString());
  assert.equal(paid.rows[1].ends_at.toISOString(), secondEnd.toISOString());
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_periods WHERE order_id=$1", [row.id])).rows[0].n, 2);
});

function precisePilotPeriod() {
  const starts = new Date(); starts.setUTCHours(15, 14, 30, 0);
  if (starts > new Date()) starts.setUTCDate(starts.getUTCDate() - 1);
  const ends = new Date(starts); ends.setUTCMonth(ends.getUTCMonth() + 1);
  return { starts: starts.toISOString(), ends: ends.toISOString() };
}

test("date-only activation follows the precise API payment period without replacing 15:14:30 with midnight", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const precise = precisePilotPeriod();
  remote.currentPeriodStart = precise.starts; remote.currentPeriodEnd = precise.ends;
  remote.payments[0].createdAt = precise.starts;
  assert.equal((await webhook(notification(remote, "subscription.payment_succeeded"))).response.status, 200);
  const active = await account(owner);
  const activation = notification(remote);
  activation.data.currentPeriodStart = precise.starts.slice(0, 10);
  activation.data.currentPeriodEnd = precise.ends.slice(0, 10);
  assert.equal((await webhook(activation)).response.status, 200);
  assert.equal((await webhook(activation)).response.status, 200);
  const cached = (await db.query("SELECT starts_at,ends_at FROM tokentracker_cloud_waffo_periods WHERE order_id=$1", [row.id])).rows[0];
  assert.equal(cached.starts_at.toISOString(), precise.starts); assert.equal(cached.ends_at.toISOString(), precise.ends);
  const after = await account(owner);
  assert.equal(after.payments.length, 1); assert.equal(after.payments[0].amount_cents, 499);
  assert.equal(after.membership.can_upload_cloud, true);
  assert.equal(after.membership.expires_at, active.membership.expires_at);
  assert.equal(new Date(after.membership.expires_at).toISOString(), precise.ends);
});

test("a date-only notification on the wrong UTC day cannot override the verified precise period", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const precise = precisePilotPeriod();
  remote.currentPeriodStart = precise.starts; remote.currentPeriodEnd = precise.ends;
  remote.payments[0].createdAt = precise.starts;
  const wrong = notification(remote); const earlier = new Date(precise.starts); earlier.setUTCDate(earlier.getUTCDate() - 1);
  wrong.data.currentPeriodStart = earlier.toISOString().slice(0, 10);
  wrong.data.currentPeriodEnd = precise.ends.slice(0, 10);
  const rejected = await webhook(wrong);
  assert.equal(rejected.response.status, 409); assert.equal(rejected.data.error, "waffo_billing_period_conflict");
  assert.equal((await account(owner)).payments.length, 0);
  const cached = (await db.query("SELECT starts_at,ends_at FROM tokentracker_cloud_waffo_periods WHERE order_id=$1", [row.id])).rows[0];
  assert.equal(cached.starts_at.toISOString(), precise.starts); assert.equal(cached.ends_at.toISOString(), precise.ends);
  wrong.data.currentPeriodStart = precise.starts.slice(0, 10);
  assert.equal((await webhook(wrong)).response.status, 200);
  assert.equal((await account(owner)).payments.length, 1);
});

test("an unknown historical date-only period remains pending without inventing midnight timestamps", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const current = precisePilotPeriod(); const previous = new Date(current.starts); previous.setUTCMonth(previous.getUTCMonth() - 1);
  remote.currentPeriodNumber = 2; remote.currentPeriodStart = current.starts; remote.currentPeriodEnd = current.ends;
  remote.payments[0].createdAt = previous.toISOString();
  remote.payments.push({ ...structuredClone(remote.payments[0]), id: shortId("PAY"), periodNumber: 2, createdAt: current.starts });
  const historic = notification(remote, "subscription.renewed");
  historic.data.periodNumber = 1;
  historic.data.currentPeriodStart = previous.toISOString().slice(0, 10);
  historic.data.currentPeriodEnd = current.starts.slice(0, 10);
  const pending = await webhook(historic);
  assert.equal(pending.response.status, 503); assert.equal(pending.data.error, "waffo_billing_period_pending");
  assert.equal((await account(owner)).payments.length, 0);
  const cached = await db.query("SELECT period_number,starts_at,ends_at FROM tokentracker_cloud_waffo_periods WHERE order_id=$1", [row.id]);
  assert.equal(cached.rows.length, 1); assert.equal(cached.rows[0].period_number, 2);
  assert.equal(cached.rows[0].starts_at.toISOString(), current.starts);
  assert.equal(cached.rows[0].ends_at.toISOString(), current.ends);
});

test("fixed purchases expose the provider login portal and actual partial or full refunds come from ledger truth", async () => {
  const owner = await user(); const outsider = await user();
  assert.equal((await api("portal", {}, owner)).response.status, 404);
  const created = await checkout(owner, "cloud_usd_monthly_fixed"); const row = await localOrder(created.data.order.id);
  const remote = makeRemote(row, 100);
  assert.equal((await webhook(notification(remote, "order.completed"))).response.status, 200);
  const active = await account(owner);
  assert.equal(active.payments.length, 1); assert.equal(active.payments[0].amount_cents, 599);
  assert.equal(active.subscriptions.length, 0); assert.equal(active.membership.can_upload_cloud, true);
  const portal = await api("portal", {}, owner);
  assert.equal(portal.response.status, 200); assert.equal(portal.data.url, "https://pancake.waffo.ai/consumer/portal/login");
  assert.equal((await api("portal", {}, outsider)).response.status, 404);
  const refund = amount => ({ id: shortId("REF"), paymentId: remote.payments[0].id, status: "succeeded", testMode: true,
    orderMerchantExternalId: row.id, createdAt: new Date().toISOString(), amount: money(amount),
    pspAmountDetails: { amount: decimal(amount), currency: "USD" },
    requestedAmountDetails: { amount: "5.99", currency: "USD" } });
  remote.payments[0].refunds = [refund(99)];
  assert.equal((await webhook(notification(remote, "refund.succeeded"))).response.status, 200);
  const partial = await api("order&id=" + row.id, undefined, owner);
  assert.equal(partial.data.order.payment_state, "partially_refunded");
  assert.equal(partial.data.order.provider_order_id, undefined);
  assert.equal((await account(owner)).payments[0].refunded_cents, 99);
  assert.equal((await account(owner)).membership.expires_at, active.membership.expires_at);
  remote.payments[0].refunds.push(refund(500));
  assert.equal((await webhook(notification(remote, "refund.succeeded"))).response.status, 200);
  assert.equal((await webhook(notification(remote, "order.completed"))).response.status, 200);
  const after = await account(owner);
  assert.equal(after.payments.length, 1); assert.equal(after.payments[0].refunded_cents, 599);
  assert.equal(after.membership.can_upload_cloud, false);
  assert.equal((await api("order&id=" + row.id, undefined, owner)).data.order.payment_state, "refunded");
});

test("a paid callback with no fresh provider order stays retryable until its action is durable", async () => {
  const owner = await user(); const created = await checkout(owner, "cloud_usd_monthly_fixed");
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const event = notification(remote, "order.completed");
  providerOrders.delete(row.id);
  const missing = await webhook(event);
  assert.equal(missing.response.status, 503);
  const state = await account(owner);
  assert.equal(state.payments.length, 0); assert.equal(state.membership.can_upload_cloud, false);
  assert.equal((await localOrder(row.id)).waffo_order_id, null);
  providerOrders.set(row.id, remote);
  assert.equal((await webhook(event)).response.status, 200);
  assert.equal((await account(owner)).payments.length, 1);
});

test("a refund callback cannot be acknowledged merely because older payments are visible", async () => {
  const owner = await user(); const created = await checkout(owner, "cloud_usd_monthly_fixed");
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  assert.equal((await webhook(notification(remote, "order.completed"))).response.status, 200);
  const refund = { id: shortId("REF"), paymentId: remote.payments[0].id, status: "succeeded", testMode: true,
    orderMerchantExternalId: row.id, createdAt: new Date().toISOString(), amount: money(499),
    pspAmountDetails: { amount: "4.99", currency: "USD" } };
  const event = notification(remote, "refund.succeeded", { paymentId: remote.payments[0].id, refundedAmount: "4.99" });
  event.eventId = refund.id;
  const missing = await webhook(event);
  assert.equal(missing.response.status, 503);
  const state = await account(owner);
  assert.equal(state.payments[0].refunded_cents, 0); assert.equal(state.membership.can_upload_cloud, true);
  remote.payments[0].refunds.push(refund);
  assert.equal((await webhook(event)).response.status, 200);
  assert.equal((await account(owner)).payments[0].refunded_cents, 499);
  assert.equal((await account(owner)).membership.can_upload_cloud, false);
});

test("a signed phase with another order ID cannot bind or cache anything when the fresh phase is absent", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const event = notification(remote); event.data.orderId = shortId("ORD");
  remote.currentPeriodStart = null; remote.currentPeriodEnd = null; remote.currentPeriodNumber = null;
  const rejected = await webhook(event);
  assert.equal(rejected.response.status, 409);
  assert.equal((await localOrder(row.id)).waffo_order_id, null);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_attempts WHERE waffo_order_id=$1", [event.data.orderId])).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_periods WHERE order_id=$1", [row.id])).rows[0].n, 0);
  assert.equal((await account(owner)).payments.length, 0);
});

test("a closed order cannot create a provider session through the ambiguous-response recovery path", async () => {
  const owner = await user(); const request = randomUUID();
  const row = (await db.query("SELECT cloud_create_order($1,$2,$3,$4,$5) r",
    [owner, "sandbox", "waffo", "cloud_usd_monthly", request])).rows[0].r;
  await db.query("UPDATE tokentracker_cloud_orders SET status=$2,provider_price_id=$3 WHERE id=$1", [row.id, "closed", plans[0].id]);
  const before = sessionCount; const attempts = sdkKeys.length;
  const rejected = await checkout(owner, "cloud_usd_monthly", request);
  assert.equal(rejected.response.status, 409);
  assert.equal(sessionCount, before); assert.equal(sdkKeys.length, attempts);
  const persisted = await localOrder(row.id);
  assert.equal(persisted.status, "closed"); assert.equal(persisted.provider_checkout_id, null);
});

test("expiry while validating a product cannot bypass the SQL checkout claim", async () => {
  const owner = await user(); const request = randomUUID();
  const row = (await db.query("SELECT cloud_create_order($1,$2,$3,$4,$5) r",
    [owner, "sandbox", "waffo", "cloud_usd_monthly", request])).rows[0].r;
  await db.query("UPDATE tokentracker_cloud_orders SET expires_at=$2 WHERE id=$1", [row.id, new Date(Date.now() + 500).toISOString()]);
  const restore = globalThis.fetch; const before = sessionCount; const attempts = sdkKeys.length;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).origin === "https://api.waffo.ai" && JSON.parse(init.body).query?.includes("subscriptionProduct(id:")) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    return restore(input, init);
  };
  let rejected;
  try { rejected = await checkout(owner, "cloud_usd_monthly", request); }
  finally { globalThis.fetch = restore; }
  assert.equal(rejected.response.status, 409);
  assert.equal(sessionCount, before); assert.equal(sdkKeys.length, attempts);
  const persisted = await localOrder(row.id);
  assert.ok(Date.parse(persisted.expires_at) <= Date.now());
  assert.equal(persisted.provider_checkout_id, null);
});

test("canceling again after the provider portal uncancels is a distinct idempotent operation", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  assert.equal((await webhook(notification(remote))).response.status, 200);
  const expires = (await account(owner)).membership.expires_at;
  const before = cancelCount;
  assert.equal((await api("cancel", { subscription_id: remote.id }, owner)).response.status, 200);
  assert.equal(cancelCount, before + 1);
  assert.equal((await api("cancel", { subscription_id: remote.id }, owner)).response.status, 200);
  assert.equal(cancelCount, before + 1);
  remote.status = "active"; remote.willRenew = true;
  remote.updatedAt = new Date(Date.parse(remote.updatedAt) + 1000).toISOString();
  assert.equal((await webhook(notification(remote, "subscription.uncanceled"))).response.status, 200);
  assert.equal((await account(owner)).subscriptions[0].cancel_at_period_end, false);
  assert.equal((await api("cancel", { subscription_id: remote.id }, owner)).response.status, 200);
  assert.equal(cancelCount, before + 2);
  const after = await account(owner);
  assert.equal(remote.status, "canceling"); assert.equal(after.subscriptions[0].cancel_at_period_end, true);
  assert.equal(after.membership.expires_at, expires);
});

test("unpaid closing uses SDK merchant or scoped customer credentials and rejects in-flight attempts", async () => {
  const { closeUnpaidWaffoOrder } = load("waffo");
  const { waffoConfig } = load("runtime");
  for (const sku of ["cloud_usd_monthly", "cloud_usd_monthly_fixed"]) {
    const owner = await user(); const created = await checkout(owner, sku);
    const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
    remote.status = "pending"; remote.payments[0].status = "failed";
    assert.equal(await closeUnpaidWaffoOrder(row, waffoConfig()), remote.id);
    assert.equal(remote.status, "canceled");
    assert.equal((await account(owner)).membership.can_upload_cloud, false);
  }
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  remote.status = "pending"; remote.payments[0].status = "pending";
  const before = cancelCount;
  await assert.rejects(closeUnpaidWaffoOrder(row, waffoConfig()), /checkout_confirmation_pending/);
  assert.equal(cancelCount, before); assert.equal(remote.status, "pending");
});

test("failed fixed and recurring checkouts close their old order and retry a single new purchase", async () => {
  for (const sku of ["cloud_usd_monthly", "cloud_usd_monthly_fixed"]) {
    const owner = await user(); const outsider = await user(); const created = await checkout(owner, sku);
    const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
    remote.status = "pending"; remote.payments[0].status = "failed";
    remote.currentPeriodStart = null; remote.currentPeriodEnd = null; remote.currentPeriodNumber = null;
    const request_id = randomUUID();
    assert.equal((await api("restart-checkout", { id: row.id, request_id }, outsider)).response.status, 404);
    const before = sessionCount;
    const restarted = await api("restart-checkout", { id: row.id, request_id }, owner);
    assert.equal(restarted.response.status, 200); assert.notEqual(restarted.data.order.id, row.id);
    assert.equal(remote.status, "canceled");
    const old = await localOrder(row.id); const next = await localOrder(restarted.data.order.id);
    assert.equal(old.status, "closed"); assert.equal(old.retry_order_id, next.id);
    assert.equal(next.sku, sku); assert.equal(next.billing_mode, row.billing_mode);
    assert.equal(next.provider_order_id, null); assert.equal(next.waffo_order_id, null);
    assert.equal(sessionCount, before + 1);
    for (const retry of [request_id, randomUUID()]) {
      const repeated = await api("restart-checkout", { id: row.id, request_id: retry }, owner);
      assert.equal(repeated.response.status, 200); assert.equal(repeated.data.order.id, next.id);
      assert.equal(repeated.data.order.checkout_url, restarted.data.order.checkout_url);
    }
    assert.equal(sessionCount, before + 1); assert.equal((await account(owner)).payments.length, 0);
    const completed = makeRemote(next);
    assert.equal((await webhook(notification(completed, row.billing_mode === "recurring" ? "subscription.activated" : "order.completed"))).response.status, 200);
    const active = await account(owner); assert.equal(active.payments.length, 1);
    assert.equal(active.membership.can_upload_cloud, true);
    assert.equal((await localOrder(row.id)).status, "closed");
  }
});

test("concurrent restart clicks share one successor and one SDK checkout session", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  remote.status = "pending"; remote.payments[0].status = "failed";
  remote.currentPeriodStart = null; remote.currentPeriodEnd = null; remote.currentPeriodNumber = null;
  const before = sessionCount;
  const results = await Promise.all([api("restart-checkout", { id: row.id, request_id: randomUUID() }, owner),
    api("restart-checkout", { id: row.id, request_id: randomUUID() }, owner)]);
  assert.ok(results.every(r => r.response.status === 200));
  assert.equal(results[0].data.order.id, results[1].data.order.id);
  assert.equal(sessionCount, before + 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_orders WHERE user_id=$1", [owner])).rows[0].n, 2);
});

test("provider-closed or expired failed attempts restart with a new UUID without canceling again", async () => {
  for (const sku of ["cloud_usd_monthly", "cloud_usd_monthly_fixed"]) {
    for (const status of ["closed", "expired"]) {
      const owner = await user(); const created = await checkout(owner, sku);
      const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
      remote.status = status; remote.payments[0].status = "failed";
      remote.currentPeriodStart = null; remote.currentPeriodEnd = null; remote.currentPeriodNumber = null;
      const cancels = cancelCount; const tokens = customerSessions.size;
      const restarted = await api("restart-checkout", { id: row.id, request_id: randomUUID() }, owner);
      assert.equal(restarted.response.status, 200); assert.notEqual(restarted.data.order.id, row.id);
      assert.equal(cancelCount, cancels); assert.equal(customerSessions.size, tokens);
      assert.equal(remote.status, status);
      const old = await localOrder(row.id);
      assert.equal(old.status, "closed"); assert.equal(old.retry_order_id, restarted.data.order.id);
      assert.equal((await account(owner)).payments.length, 0);
      const replacement = makeRemote(await localOrder(restarted.data.order.id));
      assert.equal((await webhook(notification(replacement, row.billing_mode === "recurring" ? "subscription.activated" : "order.completed"))).response.status, 200);
      assert.equal((await account(owner)).membership.can_upload_cloud, true);
    }
  }
});

test("in-flight and fully refunded payments cannot be replaced with an unpaid retry", async () => {
  for (const status of ["pending", "succeeded"]) {
    const owner = await user(); const created = await checkout(owner, "cloud_usd_monthly_fixed");
    const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
    remote.status = status === "succeeded" ? "canceled" : "pending";
    remote.payments[0].status = status;
    if (status === "succeeded") remote.payments[0].refundedAmount = money(499);
    const before = sessionCount;
    const rejected = await api("restart-checkout", { id: row.id, request_id: randomUUID() }, owner);
    assert.equal(rejected.response.status, 409); assert.equal(sessionCount, before);
    assert.equal((await localOrder(row.id)).retry_order_id, null);
  }
});

test("a late real payment on the old attempt is retained and exposes the retry conflict", async () => {
  const owner = await user(); const created = await checkout(owner, "cloud_usd_monthly_fixed");
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  remote.status = "pending"; remote.payments[0].status = "failed";
  const restarted = await api("restart-checkout", { id: row.id, request_id: randomUUID() }, owner);
  assert.equal(restarted.response.status, 200);
  remote.status = "completed"; remote.payments[0].status = "succeeded";
  assert.equal((await webhook(notification(remote, "order.completed"))).response.status, 200);
  const state = await account(owner); assert.equal(state.payments.length, 1);
  assert.equal(state.membership.can_upload_cloud, true);
  assert.equal(state.conflict_orders.length, 2);
  assert.ok(state.conflict_orders.every(order => order.retry_payment_conflict_at));
  const old = await localOrder(row.id); const next = await localOrder(restarted.data.order.id);
  assert.ok(old.retry_payment_conflict_at); assert.ok(next.retry_payment_conflict_at);
  assert.equal((await api("order&id=" + row.id, undefined, owner)).data.order.payment_state, "paid");
  const before = sessionCount;
  assert.equal((await api("restart-checkout", { id: next.id, request_id: randomUUID() }, owner)).response.status, 409);
  const blocked = await api("restart-checkout", { id: row.id, request_id: randomUUID() }, owner);
  assert.equal(blocked.response.status, 409); assert.equal(blocked.data.error, "payment_conflict");
  assert.equal((await checkout(owner, next.sku, next.request_id)).response.status, 409);
  assert.equal(sessionCount, before);
});

function failedAttempt(local, status = "closed") {
  const remote = makeRemote(local); remote.status = status;
  remote.payments[0].status = "failed";
  remote.currentPeriodNumber = null; remote.currentPeriodStart = null; remote.currentPeriodEnd = null;
  return remote;
}

test("official checkout replacement attributes the new paid ORD while the old failed ORD never freezes canonical identity", async () => {
  for (const sku of ["cloud_usd_monthly", "cloud_usd_monthly_fixed"]) {
    const owner = await user(); const created = await checkout(owner, sku);
    const row = await localOrder(created.data.order.id); const old = failedAttempt(row);
    const unpaid = await api("reconcile", { id: row.id }, owner);
    assert.equal(unpaid.response.status, 200); assert.equal(unpaid.data.confirmed, false);
    assert.equal((await localOrder(row.id)).waffo_order_id, null);
    const paid = makeRemote(row);
    providerOrders.set(row.id, [old, paid]);
    const event = notification(paid, row.billing_mode === "recurring" ? "subscription.payment_succeeded" : "order.completed");
    assert.equal((await webhook(event)).response.status, 200);
    assert.equal((await webhook(event)).response.status, 200);
    const state = await account(owner);
    assert.equal(state.payments.length, 1); assert.equal(state.membership.can_upload_cloud, true);
    assert.equal(state.conflict_orders.length, 0);
    const current = await localOrder(row.id);
    assert.equal(current.waffo_order_id, paid.id); assert.equal(current.provider_order_id, paid.payments[0].id);
    const attempts = await db.query("SELECT waffo_order_id FROM tokentracker_cloud_waffo_attempts WHERE order_id=$1", [row.id]);
    assert.deepEqual(attempts.rows.map(r => r.waffo_order_id).sort(), [old.id, paid.id].sort());
  }
});

test("multiple genuine paid attempts retain every PAY, freeze the first canonical and isolate equal-numbered periods", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const first = makeRemote(row);
  assert.equal((await webhook(notification(first))).response.status, 200);
  const canonical = await localOrder(row.id);
  const second = makeRemote(row); const start = new Date(second.currentPeriodStart); start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  second.currentPeriodStart = start.toISOString(); second.currentPeriodEnd = end.toISOString();
  providerOrders.set(row.id, [second, first]);
  assert.equal((await webhook(notification(second))).response.status, 200);
  const state = await account(owner);
  assert.equal(state.payments.length, 2); assert.equal(state.conflict_orders.length, 1);
  const after = await localOrder(row.id);
  assert.equal(after.waffo_order_id, canonical.waffo_order_id); assert.equal(after.provider_order_id, canonical.provider_order_id);
  const periods = await db.query("SELECT waffo_order_id,period_number,starts_at FROM tokentracker_cloud_waffo_periods WHERE order_id=$1", [row.id]);
  assert.equal(periods.rows.length, 2); assert.ok(periods.rows.every(p => p.period_number === 1));
  assert.equal(periods.rows.find(p => p.waffo_order_id === first.id).starts_at.toISOString(), first.currentPeriodStart);
  assert.equal(periods.rows.find(p => p.waffo_order_id === second.id).starts_at.toISOString(), second.currentPeriodStart);
  const rejected = await checkout(owner, "cloud_usd_monthly_fixed");
  assert.equal(rejected.response.status, 409); assert.equal(rejected.data.error, "payment_conflict");
  second.payments[0].refunds.push({ id: shortId("REF"), paymentId: second.payments[0].id, status: "succeeded", testMode: true,
    orderMerchantExternalId: row.id, createdAt: new Date().toISOString(), amount: money(499), pspAmountDetails: { amount: "4.99", currency: "USD" } });
  assert.equal((await webhook(notification(second, "refund.succeeded"))).response.status, 200);
  const balances = await db.query("SELECT transaction_id,waffo_order_id,refunded_cents FROM tokentracker_cloud_payments WHERE order_id=$1", [row.id]);
  assert.equal(balances.rows.find(p => p.waffo_order_id === first.id).refunded_cents, 0);
  assert.equal(balances.rows.find(p => p.waffo_order_id === second.id).refunded_cents, 499);
});

test("terminal failed replacement bundles recover one successor while processing bundles never auto-cancel", async () => {
  for (const sku of ["cloud_usd_monthly", "cloud_usd_monthly_fixed"]) {
    const owner = await user(); const created = await checkout(owner, sku);
    const row = await localOrder(created.data.order.id); const first = failedAttempt(row);
    const second = failedAttempt(row, "canceled"); providerOrders.set(row.id, [first, second]);
    const cancels = cancelCount; const tokens = customerSessions.size;
    const restarted = await api("restart-checkout", { id: row.id, request_id: randomUUID() }, owner);
    assert.equal(restarted.response.status, 200); assert.notEqual(restarted.data.order.id, row.id);
    assert.equal(cancelCount, cancels); assert.equal(customerSessions.size, tokens);
    const old = await localOrder(row.id); assert.equal(old.retry_order_id, restarted.data.order.id);
    assert.equal(old.waffo_order_id, null);
  }
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const first = failedAttempt(row);
  const second = failedAttempt(row, "pending"); second.payments[0].status = "processing"; providerOrders.set(row.id, [first, second]);
  const cancels = cancelCount; const before = sessionCount;
  const waiting = await api("restart-checkout", { id: row.id, request_id: randomUUID() }, owner);
  assert.equal(waiting.response.status, 409); assert.equal(cancelCount, cancels); assert.equal(sessionCount, before);
  assert.equal((await localOrder(row.id)).retry_order_id, null);
});

test("a replacement candidate with foreign identity prevents any arbitrary paid-attempt selection", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const first = failedAttempt(row); const paid = makeRemote(row);
  first.metadata = JSON.stringify({ tokentracker_order_id: row.id, tokentracker_user_id: randomUUID(), tokentracker_environment: "sandbox" });
  providerOrders.set(row.id, [first, paid]);
  const rejected = await webhook(notification(paid));
  assert.equal(rejected.response.status, 400); assert.equal(rejected.data.error, "payment_account_mismatch");
  assert.equal((await account(owner)).payments.length, 0); assert.equal((await localOrder(row.id)).waffo_order_id, null);
});

test("101 provider replacement candidates paginate fully and all lifecycle batches finish before ACK", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id);
  const attempts = Array.from({ length: 100 }, () => failedAttempt(row)); const paid = makeRemote(row);
  attempts.push(paid); providerOrders.set(row.id, attempts);
  const before = applyBatchCalls;
  assert.equal((await webhook(notification(paid, "subscription.payment_succeeded"))).response.status, 200);
  assert.equal(applyBatchCalls, before + 2);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_attempts WHERE order_id=$1", [row.id])).rows[0].n, 101);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_subscriptions WHERE order_id=$1", [row.id])).rows[0].n, 101);
  assert.equal((await account(owner)).payments.length, 1); assert.equal((await localOrder(row.id)).waffo_order_id, paid.id);
});

test("a failure after the first durable payment batch returns non-200 and replay never duplicates paid terms", async () => {
  const owner = await user(); const created = await checkout(owner, "cloud_usd_monthly_fixed");
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  remote.payments = Array.from({ length: 101 }, () => ({ ...structuredClone(remote.payments[0]), id: shortId("PAY") }));
  const event = notification(remote, "order.completed");
  failApplyBatch = applyBatchCalls + 2;
  let failed;
  try { failed = await webhook(event); }
  finally { failApplyBatch = 0; }
  assert.equal(failed.response.status, 503);
  const count = () => db.query("SELECT count(*)::int n FROM tokentracker_cloud_payments WHERE order_id=$1", [row.id]);
  assert.equal((await count()).rows[0].n, 100);
  assert.equal((await webhook(event)).response.status, 200);
  assert.equal((await count()).rows[0].n, 101);
  const expires = (await account(owner)).membership.expires_at;
  assert.equal((await webhook(event)).response.status, 200);
  assert.equal((await count()).rows[0].n, 101);
  assert.equal((await account(owner)).membership.expires_at, expires);
});

test("a lifecycle notification stays retryable while the API still exposes an older active state", async () => {
  for (const eventType of ["subscription.canceling", "subscription.canceled", "subscription.past_due"]) {
    const owner = await user(); const created = await checkout(owner); assert.equal(created.response.status,200);
    const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
    remote.status = "active"; remote.willRenew = true;
    remote.updatedAt = new Date(Date.now()-500).toISOString();
    const received = await webhook(notification(remote,eventType));
    assert.equal(received.response.status,503,eventType);
    const state = await account(owner);
    assert.equal(state.subscriptions.length,0,eventType);
    assert.equal(state.payments.length,0,eventType);
    assert.equal(state.membership.can_upload_cloud,false,eventType);
    assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_events WHERE order_id=$1",[row.id])).rows[0].n,0);
  }
});

test("a lifecycle notification acknowledges its matching API state even when its timestamp is slightly later", async () => {
  for (const [eventType,remoteStatus,localStatus,cancelAtEnd] of [
    ["subscription.canceling","canceling","active",true],
    ["subscription.canceled","canceled","canceled",false],
    ["subscription.past_due","past_due","past_due",false],
  ]) {
    const owner = await user(); const created = await checkout(owner); assert.equal(created.response.status,200);
    const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
    remote.status = remoteStatus; remote.willRenew = remoteStatus === "past_due";
    remote.updatedAt = new Date(Date.now()-500).toISOString();
    const event = notification(remote,eventType);
    assert.ok(Date.parse(event.timestamp)>Date.parse(remote.updatedAt));
    const received = await webhook(event); assert.equal(received.response.status,200,eventType);
    const state = await account(owner);
    assert.equal(state.subscriptions[0].status,localStatus,eventType);
    assert.equal(state.subscriptions[0].cancel_at_period_end,cancelAtEnd,eventType);
    assert.equal(state.payments.length,1,eventType);
    assert.equal(state.membership.can_upload_cloud,true,eventType);
  }
});

test("a newer verified API state supersedes an older cancellation notification without rolling it back", async () => {
  const owner = await user(); const created = await checkout(owner); assert.equal(created.response.status,200);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const canceled = notification(remote,"subscription.canceled");
  remote.status = "active"; remote.willRenew = true;
  remote.updatedAt = new Date(Date.parse(canceled.timestamp)+1000).toISOString();
  const received = await webhook(canceled); assert.equal(received.response.status,200);
  const state = await account(owner);
  assert.equal(state.subscriptions[0].status,"active");
  assert.equal(state.subscriptions[0].cancel_at_period_end,false);
  assert.equal(state.payments.length,1);
});

test("invalid restart request IDs cause no SDK cancellation, token mint, registration or successor", async () => {
  for (const sku of ["cloud_usd_monthly", "cloud_usd_monthly_fixed"]) {
    const owner = await user(); const created = await checkout(owner, sku);
    const row = await localOrder(created.data.order.id); const remote = failedAttempt(row, "pending");
    const cancels = cancelCount; const tokens = customerSessions.size;
    for (const request_id of [undefined, "not-a-uuid"]) {
      const rejected = await api("restart-checkout", { id: row.id, request_id }, owner);
      assert.equal(rejected.response.status, 400);
      assert.equal(remote.status, "pending"); assert.equal(cancelCount, cancels); assert.equal(customerSessions.size, tokens);
      assert.equal((await localOrder(row.id)).retry_order_id, null);
      assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_attempts WHERE order_id=$1", [row.id])).rows[0].n, 0);
    }
  }
});

test("date-only activation of the 101st current attempt uses the durable precise period beyond one database page", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id);
  const attempts = Array.from({ length: 101 }, () => makeRemote(row)); providerOrders.set(row.id, attempts);
  const paid = attempts.at(-1); const event = notification(paid);
  event.data.currentPeriodStart = paid.currentPeriodStart.slice(0, 10);
  event.data.currentPeriodEnd = paid.currentPeriodEnd.slice(0, 10);
  assert.equal((await webhook(event)).response.status, 200);
  const cached = (await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_periods WHERE order_id=$1", [row.id])).rows[0].n;
  const payments = (await db.query("SELECT count(*)::int n FROM tokentracker_cloud_payments WHERE order_id=$1", [row.id])).rows[0].n;
  assert.equal(cached, 101); assert.equal(payments, 101);
  const target = (await db.query("SELECT starts_at,ends_at FROM tokentracker_cloud_waffo_periods WHERE order_id=$1 AND waffo_order_id=$2", [row.id, paid.id])).rows[0];
  assert.equal(target.starts_at.toISOString(), paid.currentPeriodStart);
  assert.equal(target.ends_at.toISOString(), paid.currentPeriodEnd);
});

test("a payment in the 101st historical billing period reads past the first precise-cache page", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const baseDate = new Date(); baseDate.setUTCDate(1); baseDate.setUTCHours(15, 14, 30, 0); baseDate.setUTCMonth(baseDate.getUTCMonth() - 101);
  await db.query("SELECT cloud_register_waffo_attempt($1,$2,$3,$4,$5)", [row.id, "sandbox", remote.id, row.provider_price_id, "recurring"]);
  const ranges = [];
  for (let index = 0; index < 102; index++) {
    const starts = new Date(baseDate); starts.setUTCMonth(starts.getUTCMonth() + index);
    const ends = new Date(starts); ends.setUTCMonth(ends.getUTCMonth() + 1);
    ranges.push({ starts: starts.toISOString(), ends: ends.toISOString() });
    if (index < 101) await db.query("SELECT cloud_record_waffo_period($1,$2,$3,$4,$5,$6,$7)",
      [row.id, "sandbox", remote.id, row.provider_price_id, index + 1, ranges[index].starts, ranges[index].ends]);
  }
  remote.currentPeriodNumber = 102; remote.currentPeriodStart = ranges[101].starts; remote.currentPeriodEnd = ranges[101].ends;
  remote.payments[0].periodNumber = 101; remote.payments[0].createdAt = ranges[100].starts;
  remote.payments.push({ ...structuredClone(remote.payments[0]), id: shortId("PAY"), periodNumber: 102, createdAt: new Date().toISOString() });
  const event = notification(remote, "subscription.payment_succeeded");
  assert.equal((await webhook(event)).response.status, 200);
  const paid = await db.query("SELECT transaction_id,starts_at,ends_at FROM tokentracker_cloud_payments WHERE order_id=$1", [row.id]);
  assert.equal(paid.rows.length, 2);
  assert.equal(paid.rows.find(p => p.transaction_id === remote.payments[0].id).starts_at.toISOString(), ranges[100].starts);
  assert.equal(paid.rows.find(p => p.transaction_id === remote.payments[0].id).ends_at.toISOString(), ranges[100].ends);
});

function authorizationAttempt(remote) {
  const authorization = structuredClone(remote.payments[0]);
  authorization.id = shortId("PAY"); authorization.periodNumber = 0;
  authorization.amount = money(0); authorization.pspAmountDetails = { amount: "0.00", currency: "USD" };
  authorization.refunds = [];
  return authorization;
}

test("a signed zero-authorization callback commits audit evidence without paid identity, time or Cloud access", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const authorization = authorizationAttempt(remote);
  remote.payments = [authorization]; remote.currentPeriodNumber = 0;
  remote.currentPeriodStart = null; remote.currentPeriodEnd = null;
  const event = notification(remote, "subscription.payment_succeeded", { paymentId: authorization.id, periodNumber: 0, chargedAmount: "0.00" });
  assert.equal((await webhook(event)).response.status, 200);
  assert.equal((await webhook(event)).response.status, 200);
  const audits = await db.query("SELECT normalized_event FROM tokentracker_cloud_waffo_authorizations WHERE order_id=$1", [row.id]);
  assert.equal(audits.rows.length, 1); assert.equal(audits.rows[0].normalized_event.kind, "authorization");
  const state = await account(owner);
  assert.equal(state.payments.length, 0); assert.equal(state.membership.can_upload_cloud, false);
  const unpaid = await localOrder(row.id);
  assert.equal(unpaid.provider_order_id, null); assert.equal(unpaid.waffo_order_id, null); assert.equal(unpaid.status, "ready");
  const actual = structuredClone(authorization); actual.id = shortId("PAY"); actual.periodNumber = 1;
  actual.amount = money(499); actual.pspAmountDetails.amount = "4.99";
  remote.payments.push(actual);
  const starts = new Date(Date.now() - 1000); const ends = new Date(starts); ends.setUTCMonth(ends.getUTCMonth() + 1);
  remote.currentPeriodNumber = 1; remote.currentPeriodStart = starts.toISOString(); remote.currentPeriodEnd = ends.toISOString();
  remote.updatedAt = new Date(Date.now() + 1000).toISOString();
  assert.equal((await webhook(notification(remote, "subscription.payment_succeeded", { paymentId: actual.id, periodNumber: 1, chargedAmount: "4.99" }))).response.status, 200);
  const paid = await account(owner);
  assert.equal(paid.payments.length, 1); assert.equal(paid.payments[0].amount_cents, 499);
  assert.equal(paid.membership.can_upload_cloud, true); assert.equal((await localOrder(row.id)).provider_order_id, actual.id);
});

test("zero authorization is never acknowledged before its independent durable audit succeeds", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const authorization = authorizationAttempt(remote);
  remote.payments = [authorization]; remote.currentPeriodNumber = 0;
  remote.currentPeriodStart = null; remote.currentPeriodEnd = null;
  const event = notification(remote, "subscription.payment_succeeded", { paymentId: authorization.id, periodNumber: 0 });
  failAuthorizationOnce = true;
  try { assert.equal((await webhook(event)).response.status, 503); }
  finally { failAuthorizationOnce = false; }
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_authorizations WHERE order_id=$1", [row.id])).rows[0].n, 0);
  assert.equal((await account(owner)).membership.can_upload_cloud, false);
  assert.equal((await webhook(event)).response.status, 200);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_authorizations WHERE order_id=$1", [row.id])).rows[0].n, 1);
});

test("zero fixed purchases and nonzero-period charges cannot borrow the authorization audit path", async () => {
  for (const [sku, period] of [["cloud_usd_monthly_fixed", 0], ["cloud_usd_monthly", 1], ["cloud_usd_monthly", null]]) {
    const owner = await user(); const created = await checkout(owner, sku);
    const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
    const authorization = authorizationAttempt(remote); authorization.periodNumber = period; remote.payments = [authorization];
    const rejected = await webhook(notification(remote, row.billing_mode === "recurring" ? "subscription.payment_succeeded" : "order.completed"));
    assert.equal(rejected.response.status, 400); assert.equal(rejected.data.error, "payment_amount_mismatch");
    assert.equal((await account(owner)).payments.length, 0);
    assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_authorizations WHERE order_id=$1", [row.id])).rows[0].n, 0);
  }
});

test("an unpaid terminal authorization can restart without mistaking the zero PAY for a paid term", async () => {
  const owner = await user(); const created = await checkout(owner);
  const row = await localOrder(created.data.order.id); const remote = makeRemote(row);
  const authorization = authorizationAttempt(remote);
  remote.status = "closed"; remote.payments = [authorization]; remote.currentPeriodNumber = 0;
  remote.currentPeriodStart = null; remote.currentPeriodEnd = null; remote.willRenew = false;
  const restarted = await api("restart-checkout", { id: row.id, request_id: randomUUID() }, owner);
  assert.equal(restarted.response.status, 200); assert.notEqual(restarted.data.order.id, row.id);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_authorizations WHERE order_id=$1", [row.id])).rows[0].n, 1);
  const state = await account(owner); assert.equal(state.payments.length, 0); assert.equal(state.membership.can_upload_cloud, false);
});

test("multiple owned pending failures close by separate ORD keys and restart one durable successor",async()=>{
  for(const sku of ["cloud_usd_yearly_fixed","cloud_usd_monthly"]) {
    const owner=await user();const created=await checkout(owner,sku);assert.equal(created.response.status,200);
    const row=await localOrder(created.data.order.id);
    const first=failedAttempt(row,"pending");const second=failedAttempt(row,"pending");
    first.merchantProvidedBuyerIdentity="owned-buyer-first-"+row.id;
    second.merchantProvidedBuyerIdentity="owned-buyer-second-"+row.id;
    providerOrders.set(row.id,[first,second]);
    const beforeKeys=unpaidCancelKeys.length;const beforeSessions=sessionCount;
    const requestId=randomUUID();const restarted=await api("restart-checkout",{id:row.id,request_id:requestId},owner);
    assert.equal(restarted.response.status,200,restarted.data.error);
    assert.notEqual(restarted.data.order.id,row.id);
    assert.equal(first.status,"canceled");assert.equal(second.status,"canceled");
    const keys=unpaidCancelKeys.slice(beforeKeys);assert.equal(keys.length,2);assert.equal(new Set(keys).size,2);
    for(const attempt of [first,second])assert.ok(keys.some(key=>key.endsWith(attempt.id)));
    assert.equal(sessionCount,beforeSessions+1);
    const repeat=await api("restart-checkout",{id:row.id,request_id:randomUUID()},owner);
    assert.equal(repeat.response.status,200);assert.equal(repeat.data.order.id,restarted.data.order.id);
    assert.equal(unpaidCancelKeys.length,beforeKeys+2);assert.equal(sessionCount,beforeSessions+1);
    assert.equal((await account(owner)).payments.length,0);
  }
});

test("annual failed-renewal collection grace updates lifecycle without becoming purchased time",async()=>{
  const owner=await user();const created=await checkout(owner,"cloud_usd_yearly");assert.equal(created.response.status,200);
  const row=await localOrder(created.data.order.id);const remote=makeRemote(row);
  assert.equal((await webhook(notification(remote,"subscription.activated"))).response.status,200);
  const before=await account(owner);const originalEnd=remote.currentPeriodEnd;
  const failed={...structuredClone(remote.payments[0]),id:shortId("PAY"),status:"failed",periodNumber:2,createdAt:new Date().toISOString()};
  remote.payments.unshift(failed);remote.currentPeriodNumber=2;remote.currentPeriodStart=originalEnd;
  remote.currentPeriodEnd=new Date(Date.parse(originalEnd)+(55*60+33)*1000).toISOString();
  remote.status="past_due";remote.willRenew=false;remote.updatedAt=new Date(Date.now()+1000).toISOString();
  const overdue=notification(remote,"subscription.past_due");
  overdue.data.currentPeriodStart=remote.currentPeriodStart.slice(0,10);overdue.data.currentPeriodEnd=remote.currentPeriodEnd.slice(0,10);
  const accepted=await webhook(overdue);assert.equal(accepted.response.status,200,accepted.data.error);
  const pastDue=await account(owner);assert.equal(pastDue.subscriptions[0].status,"past_due");
  assert.equal(pastDue.payments.length,1);assert.equal(pastDue.membership.expires_at,before.membership.expires_at);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_periods WHERE order_id=$1 AND period_number=2",[row.id])).rows[0].n,0);
  remote.status="canceled";remote.updatedAt=new Date(Date.now()+1500).toISOString();
  assert.equal((await webhook(notification(remote,"subscription.canceled"))).response.status,200);
  assert.equal((await account(owner)).subscriptions[0].status,"canceled");
  failed.status="succeeded";remote.status="active";remote.willRenew=true;
  const recoveredEnd=new Date(originalEnd);recoveredEnd.setUTCMonth(recoveredEnd.getUTCMonth()+12);
  remote.currentPeriodEnd=recoveredEnd.toISOString();remote.updatedAt=new Date(Date.now()+2000).toISOString();
  const recovered=await webhook(notification(remote,"subscription.recovered"));assert.equal(recovered.response.status,200,recovered.data.error);
  const state=await account(owner);assert.equal(state.subscriptions[0].status,"active");assert.equal(state.payments.length,2);
  assert.equal((await db.query("SELECT ends_at FROM tokentracker_cloud_waffo_periods WHERE order_id=$1 AND period_number=2",[row.id])).rows[0].ends_at.toISOString(),recoveredEnd.toISOString());
});

test("an entirely unpaid short-grace subscription is acknowledged without Cloud entitlement or phase cache",async()=>{
  const owner=await user();const created=await checkout(owner,"cloud_usd_yearly");assert.equal(created.response.status,200);
  const row=await localOrder(created.data.order.id);const remote=makeRemote(row);
  remote.payments[0].status="failed";remote.payments[0].periodNumber=2;
  remote.currentPeriodNumber=2;remote.status="past_due";remote.willRenew=false;
  remote.currentPeriodEnd=new Date(Date.parse(remote.currentPeriodStart)+(55*60+33)*1000).toISOString();
  const notice=notification(remote,"subscription.past_due");notice.data.currentPeriodStart=remote.currentPeriodStart.slice(0,10);
  notice.data.currentPeriodEnd=remote.currentPeriodEnd.slice(0,10);
  const accepted=await webhook(notice);assert.equal(accepted.response.status,200,accepted.data.error);
  const state=await account(owner);assert.equal(state.subscriptions[0].status,"past_due");assert.equal(state.payments.length,0);
  assert.equal(state.membership.can_upload_cloud,false);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_waffo_periods WHERE order_id=$1",[row.id])).rows[0].n,0);
});

test("a provider-confirmed sandbox annual thirteen-minute future window records money without granting current access",async()=>{
  const owner=await user();const created=await checkout(owner,"cloud_usd_yearly");assert.equal(created.response.status,200);
  const row=await localOrder(created.data.order.id);const remote=makeRemote(row);
  remote.currentPeriodNumber=3;remote.currentPeriodStart="2027-10-07T17:08:25.000Z";
  remote.currentPeriodEnd="2027-10-07T17:22:06.000Z";remote.payments[0].periodNumber=3;
  const accepted=await webhook(notification(remote,"subscription.recovered"));
  assert.equal(accepted.response.status,200,accepted.data.error);
  const state=await account(owner);assert.equal(state.payments.length,1);assert.equal(state.payments[0].amount_cents,3999);
  assert.equal(state.payments[0].starts_at,remote.currentPeriodStart);assert.equal(state.payments[0].ends_at,remote.currentPeriodEnd);
  assert.equal(state.membership.can_upload_cloud,false);assert.equal(state.membership.can_read_cloud,false);
  assert.equal(state.membership.expires_at,null);assert.equal(state.membership.read_only_until,null);
  const repeated=await webhook(notification(remote,"subscription.payment_succeeded"));assert.equal(repeated.response.status,200);
  assert.equal((await account(owner)).payments.length,1);
});

test("renewed acknowledges a matching real sandbox P3 thirteen-minute charge without duplicating it",async()=>{
  const owner=await user();const created=await checkout(owner,"cloud_usd_yearly");assert.equal(created.response.status,200);
  const row=await localOrder(created.data.order.id);const remote=makeRemote(row);
  remote.currentPeriodNumber=3;remote.currentPeriodStart="2027-10-07T17:08:25.000Z";
  remote.currentPeriodEnd="2027-10-07T17:22:06.000Z";remote.payments[0].periodNumber=3;
  remote.updatedAt=new Date(Date.now()-500).toISOString();
  const renewed=notification(remote,"subscription.renewed");
  renewed.data.currentPeriodStart=remote.currentPeriodStart.slice(0,10);
  renewed.data.currentPeriodEnd=remote.currentPeriodEnd.slice(0,10);
  assert.ok(Date.parse(remote.updatedAt)<Date.parse(renewed.timestamp));
  const accepted=await webhook(renewed);assert.equal(accepted.response.status,200,accepted.data.error);
  const state=await account(owner);assert.equal(state.payments.length,1);assert.equal(state.payments[0].amount_cents,3999);
  assert.equal(state.payments[0].starts_at,remote.currentPeriodStart);assert.equal(state.payments[0].ends_at,remote.currentPeriodEnd);
  assert.equal(state.membership.can_upload_cloud,false);assert.equal(state.membership.can_read_cloud,false);
  const repeated=await webhook(renewed);assert.equal(repeated.response.status,200,repeated.data.error);
  assert.equal((await account(owner)).payments.length,1);
});

test("an older active P1 snapshot cannot acknowledge activated or recovered notifications for P3",async()=>{
  for(const type of ["subscription.activated","subscription.recovered"]) {
    const owner=await user();const created=await checkout(owner,"cloud_usd_yearly");assert.equal(created.response.status,200);
    const row=await localOrder(created.data.order.id);const remote=makeRemote(row);
    remote.updatedAt=new Date(Date.now()-500).toISOString();
    const notice=notification(remote,type);notice.data.periodNumber=3;
    notice.data.currentPeriodStart="2027-10-07T17:08:25.000Z";notice.data.currentPeriodEnd="2027-10-07T17:22:06.000Z";
    const pending=await webhook(notice);assert.equal(pending.response.status,503,type);
    const state=await account(owner);assert.equal(state.payments.length,0,type);assert.equal(state.subscriptions.length,0,type);
    assert.equal(state.membership.can_upload_cloud,false,type);assert.equal(state.membership.can_read_cloud,false,type);
    assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_events WHERE order_id=$1",[row.id])).rows[0].n,0);
  }
});

test("renewed stays retryable without a same-ORD same-period real charge even if API state is newer",async()=>{
  const owner=await user();const created=await checkout(owner,"cloud_usd_yearly");assert.equal(created.response.status,200);
  const row=await localOrder(created.data.order.id);const remote=makeRemote(row);
  assert.equal((await webhook(notification(remote,"subscription.activated"))).response.status,200);
  const before=await account(owner);assert.equal(before.payments.length,1);
  const eventCount=(await db.query("SELECT count(*)::int n FROM tokentracker_cloud_events WHERE order_id=$1",[row.id])).rows[0].n;
  remote.currentPeriodNumber=3;remote.currentPeriodStart="2027-10-07T17:08:25.000Z";
  remote.currentPeriodEnd="2027-10-07T17:22:06.000Z";remote.updatedAt=new Date(Date.now()+1000).toISOString();
  const notice=notification(remote,"subscription.renewed");
  const pending=await webhook(notice);assert.equal(pending.response.status,503,pending.data.error);
  const after=await account(owner);assert.equal(after.payments.length,1);assert.equal(after.membership.expires_at,before.membership.expires_at);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_events WHERE order_id=$1",[row.id])).rows[0].n,eventCount);
});
