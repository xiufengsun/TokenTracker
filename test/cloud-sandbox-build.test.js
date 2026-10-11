const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const Module = require("node:module");
const { createHash, createHmac, generateKeyPairSync, randomUUID, sign } = require("node:crypto");
const { build } = require("esbuild");
const { buildCloudFunctions } = require("../scripts/build-cloud-functions.cjs");
const ROOT = path.resolve(__dirname, "..");
const previous = { Deno: globalThis.Deno, fetch: globalThis.fetch };
const webhookEnvNames = ["WAFFO_WEBHOOK_TEST_PUBLIC_KEY", "WAFFO_WEBHOOK_PROD_PUBLIC_KEY", "WAFFO_WEBHOOK_PUBLIC_KEY"];
const previousWebhookEnv = Object.fromEntries(webhookEnvNames.map(name => [name, process.env[name]]));
const allowedUser = randomUUID();
const jwtSecret = "sandbox-builder-local-jwt";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const apiKey = "local-insforge-service-role";
let env, reads, requests, billing, webhook, production;
function jwt(user = allowedUser, secret = jwtSecret) {
  const input = [{ alg: "HS256" }, { sub: user, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }]
    .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return input + "." + createHmac("sha256", secret).update(input).digest("base64url");
}
async function load(filename) {
  const output = await build({ entryPoints: [filename], bundle: true, write: false,
    platform: "node", format: "cjs", target: "node20", logLevel: "silent",
    plugins: [{ name: "locked-npm-imports", setup(build) {
      build.onResolve({ filter: /^npm:/ }, args => {
        if (args.path === "npm:@insforge/sdk@1.4.5") return {
          path: path.join(path.dirname(require.resolve("@insforge/sdk", { paths: [path.join(ROOT, "dashboard")] })), "index.mjs") };
        const packageName = args.path.slice(4).replace(/@(\d[^/]*)/, "");
        return { path: require.resolve(packageName, { paths: [ROOT] }) };
      });
    } }] });
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(output.outputFiles[0].text, filename);
  return compiled.exports.default;
}
const fingerprint = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).map(async name =>
  [name, createHash("sha256").update(await fs.readFile(path.join(dir, name))).digest("hex")])));
test.before(async () => {
  production = await buildCloudFunctions();
  const hashes = await fingerprint(production.output);
  const sandbox = await buildCloudFunctions({ sandbox: true });
  assert.deepEqual(sandbox.functions, ["tokentracker-billing-sandbox", "tokentracker-waffo-webhook-sandbox"]);
  assert.deepEqual(await fingerprint(production.output), hashes, "sandbox build must not overwrite deployed function slugs");
  env = { INSFORGE_BASE_URL: "https://sandbox-builder.invalid", INSFORGE_SERVICE_ROLE_KEY: apiKey, ANON_KEY: "local-anon", JWT_SECRET: jwtSecret,
    TOKENTRACKER_BILLING_ENVIRONMENT: "live", TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED: "true", TOKENTRACKER_BILLING_SITE_URL: "https://live-site.invalid",
    TOKENTRACKER_SANDBOX_USER_IDS: allowedUser, TOKENTRACKER_SANDBOX_BILLING_SITE_URL: "https://test-site.invalid",
    TOKENTRACKER_SANDBOX_WAFFO_MERCHANT_ID: "MER_" + "T".repeat(22), TOKENTRACKER_SANDBOX_WAFFO_STORE_ID: "STO_" + "T".repeat(22),
    TOKENTRACKER_SANDBOX_WAFFO_PRIVATE_KEY: keys.privateKey, TOKENTRACKER_SANDBOX_WAFFO_WEBHOOK_TEST_PUBLIC_KEY: keys.publicKey,
    TOKENTRACKER_SANDBOX_WAFFO_CLOUD_MONTHLY_PRODUCT_ID: "PROD_" + "T".repeat(22), TOKENTRACKER_SANDBOX_WAFFO_CLOUD_YEARLY_PRODUCT_ID: "PROD_" + "Y".repeat(22),
    TOKENTRACKER_SANDBOX_WAFFO_CLOUD_MONTHLY_PASS_PRODUCT_ID: "PROD_" + "F".repeat(22), TOKENTRACKER_SANDBOX_WAFFO_CLOUD_YEARLY_PASS_PRODUCT_ID: "PROD_" + "A".repeat(22),
    WAFFO_MERCHANT_ID: "must-not-read-live", WAFFO_STORE_ID: "must-not-read-live", WAFFO_PRIVATE_KEY: "must-not-read-live",
    PADDLE_API_KEY: "must-not-read-live", PADDLE_WEBHOOK_SECRET: "must-not-read-live", PADDLE_CLIENT_TOKEN: "must-not-read-live",
    PADDLE_CLOUD_MONTHLY_PRICE_ID: "must-not-read-live", PADDLE_CLOUD_YEARLY_PRICE_ID: "must-not-read-live",
    WECHATPAY_APP_ID: "must-not-read-live", ALIPAY_APP_ID: "must-not-read-live" };
  reads = []; requests = [];
  globalThis.Deno = { env: { get: name => { reads.push(name); return env[name]; } } };
  for (const name of webhookEnvNames) process.env[name] = "must-not-read-shared-provider-key";
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url || input.href);
    requests.push({ url, init });
    assert.equal(url.origin, env.INSFORGE_BASE_URL, "guard tests must never reach a real provider");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + apiKey);
    if (url.pathname.endsWith("tokentracker_cloud_catalog")) return Response.json([{ sku: "cloud_usd_monthly", currency: "USD", amount_cents: 499 }]);
    if (url.pathname.endsWith("tokentracker_cloud_policy")) return Response.json({ phase: "active", launch_at: "2026-01-01T00:00:00Z", hosting_mode: "hosted" });
    if (url.pathname.endsWith("cloud_start_trial")) return Response.json({ cloud_available: true });
    throw Error("Unexpected guard test request");
  };
  billing = await load(path.join(sandbox.output, "tokentracker-billing-sandbox.js"));
  webhook = await load(path.join(sandbox.output, "tokentracker-waffo-webhook-sandbox.js"));
});
test.after(() => {
  globalThis.Deno = previous.Deno; globalThis.fetch = previous.fetch;
  for (const name of webhookEnvNames) {
    if (previousWebhookEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousWebhookEnv[name];
  }
});
test.beforeEach(() => { reads.length = 0; requests.length = 0; });

function request(action = "catalog", authorization = jwt(), method = "GET", body) {
  return new Request("https://sandbox-builder.invalid/functions/tokentracker-billing-sandbox?action=" + action + "&environment=live", {
    method, headers: { Authorization: "Bearer " + authorization, "X-Environment": "prod", "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}

test("preflight is public, while catalog, account, trials, and checkout require a signed allowlisted user", async () => {
  assert.equal((await billing(request("catalog", "", "OPTIONS"))).status, 204);
  for (const [action, method] of [["catalog", "GET"], ["account", "GET"], ["trial", "POST"], ["checkout", "POST"]]) {
    for (const token of ["", jwt(allowedUser, "wrong-secret")]) assert.equal((await billing(request(action, token, method))).status, 401);
    const denied = await billing(request(action, jwt(randomUUID()), method));
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "sandbox_user_not_allowed");
  }
  assert.equal(requests.length, 0, "unauthorized calls must not read or mutate the database");
});

test("a missing or malformed allowlist closes the sandbox before database access", async () => {
  const original = env.TOKENTRACKER_SANDBOX_USER_IDS;
  try {
    for (const value of [undefined, "", "*", allowedUser + ",", "not-a-uuid"]) {
      env.TOKENTRACKER_SANDBOX_USER_IDS = value;
      const response = await billing(request());
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, "sandbox_not_configured");
    }
    assert.equal(requests.length, 0);
  } finally { env.TOKENTRACKER_SANDBOX_USER_IDS = original; }
});

test("client mode overrides and live project secrets cannot escape the fixed sandbox environment", async () => {
  const response = await billing(request());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.environment, "sandbox");
  assert.equal(data.checkout_verified, false);
  assert.deepEqual(data.providers, { waffo: true, paddle: false, wechat: false, alipay: false });
  assert.equal(requests.find(value => value.url.pathname.endsWith("tokentracker_cloud_policy")).url.searchParams.get("environment"), "eq.sandbox");
  assert.equal(reads.some(name => name.startsWith("WAFFO_") || name.startsWith("PADDLE_") || name.startsWith("WECHATPAY_") || name.startsWith("ALIPAY_")), false);
  assert.equal(reads.includes("TOKENTRACKER_BILLING_ENVIRONMENT"), false);
  assert.equal(env.TOKENTRACKER_BILLING_ENVIRONMENT, "live", "sandbox must never mutate global platform settings");
  requests.length = 0;
  assert.equal((await billing(request("trial", jwt(), "POST", { environment: "live" }))).status, 200);
  assert.equal(JSON.parse(requests[0].init.body).p_environment, "sandbox");
});

test("dedicated Waffo credentials and site URL have no fallback to production credentials", async () => {
  const originalKey = env.TOKENTRACKER_SANDBOX_WAFFO_PRIVATE_KEY;
  const originalSite = env.TOKENTRACKER_SANDBOX_BILLING_SITE_URL;
  try {
    delete env.TOKENTRACKER_SANDBOX_WAFFO_PRIVATE_KEY;
    assert.equal((await (await billing(request())).json()).providers.waffo, false);
    delete env.TOKENTRACKER_SANDBOX_BILLING_SITE_URL;
    const response = await billing(request());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "billing_operation_failed");
    assert.equal(reads.includes("WAFFO_PRIVATE_KEY"), false);
    assert.equal(reads.includes("TOKENTRACKER_BILLING_SITE_URL"), false);
  } finally {
    env.TOKENTRACKER_SANDBOX_WAFFO_PRIVATE_KEY = originalKey;
    env.TOKENTRACKER_SANDBOX_BILLING_SITE_URL = originalSite;
  }
});

test("sandbox webhook still verifies the raw signature and rejects live mode or other stores before SQL", async () => {
  const send = async (event, valid = true) => {
    const raw = JSON.stringify(event);
    const timestamp = String(Date.now());
    const signature = sign("RSA-SHA256", Buffer.from(timestamp + "." + raw), keys.privateKey).toString("base64");
    return webhook(new Request("https://sandbox-builder.invalid/functions/tokentracker-waffo-webhook-sandbox", { method: "POST", body: raw,
      headers: { "x-waffo-signature": valid ? `t=${timestamp},v1=${signature}` : `t=${timestamp},v1=invalid` } }));
  };
  const event = { id: "evt_local", eventId: "evt_local", eventType: "order.completed", timestamp: new Date().toISOString(),
    mode: "test", storeId: env.TOKENTRACKER_SANDBOX_WAFFO_STORE_ID, data: {} };
  assert.equal((await send(event, false)).status, 401);
  assert.equal((await send({ ...event, mode: "prod" })).status, 401);
  assert.equal((await send({ ...event, storeId: "STO_" + "L".repeat(22) })).status, 401);
  const response = await send(event);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, ignored: true });
  assert.equal(requests.length, 0);
});

test("ordinary Cloud builds retain original environment reads and do not read sandbox settings", async () => {
  const source = await fs.readFile(path.join(production.output, "tokentracker-billing.js"), "utf8");
  assert.match(source, /Deno\.env\.get\("TOKENTRACKER_BILLING_ENVIRONMENT"\)/);
  assert.match(source, /npm:@waffo\/pancake-ts@0\.25\.0/);
  assert.match(source, /Alipay SDK 4\.14\.0/);
  assert.equal(source.includes("TOKENTRACKER_SANDBOX_"), false);
  assert.equal(source.includes("tokentrackerSandboxEnv"), false);
  assert.equal(production.functions.length, 18);
});
