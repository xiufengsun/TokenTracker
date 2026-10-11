const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createHmac, randomUUID, createHash } = require("node:crypto");
const { buildSync } = require("esbuild");
const { buildNativeGateway } = require("../scripts/cloud-sandbox/build-native-gateway.cjs");
const { buildNativeReturnSite } = require("../scripts/cloud-sandbox/build-native-return-site.cjs");
const filename = path.resolve(__dirname, "../scripts/cloud-sandbox/native-gateway.ts");
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(buildSync({ entryPoints: [filename], bundle: true, write: false, platform: "node", format: "cjs", target: "node20",
  alias: { "npm:@insforge/sdk@1.4.5": path.join(path.dirname(require.resolve("@insforge/sdk", { paths: [path.resolve(__dirname, "../dashboard")] })), "index.mjs") }, logLevel: "silent" }).outputFiles[0].text, filename);
const { createNativeSandboxGateway, NATIVE_SANDBOX_REALM: realm, NATIVE_SANDBOX_URL: gatewayUrl, sandboxCheckoutUrl } = compiled.exports;
const owner = randomUUID(), peer = randomUUID(), unknown = randomUUID();
const secret = "gateway-local-signing-fixture";
const jwt = (id = owner, { role = "authenticated", signing = secret, exp = Date.now() / 1000 + 3600 } = {}) => {
  const input = [{ alg: "HS256" }, { sub: id, role, exp }].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return input + "." + createHmac("sha256", signing).update(input).digest("base64url");
};
function fixture(options = {}) {
  const env = { TOKENTRACKER_SANDBOX_GATEWAY_USER_IDS: [owner, peer].join(","), TOKENTRACKER_SANDBOX_ACCESS_USER_IDS: [owner, peer].join(","),
    TOKENTRACKER_SANDBOX_USER_IDS: owner, TOKENTRACKER_SANDBOX_GATEWAY_ORIGINS: "http://127.0.0.1:17680",
    TOKENTRACKER_SANDBOX_BILLING_SITE_URL: "https://native-sandbox-return.example", JWT_SECRET: secret, ...options.env };
  const calls = [], reads = [], tokenLookups = [], defaultToken = jwt();
  const handler = createNativeSandboxGateway({ getEnv: name => { reads.push(name); return env[name]; },
    lookupToken: async hash => { tokenLookups.push(hash); return options.tokenRow === undefined ? { user_id: owner, cloud_environment: "sandbox", revoked_at: null } : options.tokenRow; },
    fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return Response.json(options.response || { environment: "sandbox", membership: { environment: "sandbox", status: "free" } }, { status: options.status || 200 }); } });
  const invoke = (query, options = {}) => handler(new Request(gatewayUrl + "?" + query, { method: options.method || "GET",
    headers: { Origin: "http://127.0.0.1:17680", Authorization: "Bearer " + (options.token === undefined ? defaultToken : options.token),
      "X-TokenTracker-Sandbox-Realm": realm, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}) }));
  return { handler, invoke, env, calls, reads, tokenLookups, defaultToken };
}
test("public profile and signed identity disclose only the fixed QA contract and real signed subject", async () => {
  const f = fixture();
  const response = await f.handler(new Request(gatewayUrl + "?mode=profile"));
  const profile = await response.json();
  assert.equal(profile.realm, realm); assert.equal(profile.environment, "sandbox");
  assert.equal(profile.auth.issuerUnchanged, true); assert.deepEqual(profile.blockedBillingActions, ["portal"]);
  assert.equal(profile.functions["tokentracker-billing"].portal, undefined);
  assert.equal(JSON.stringify(profile).includes(owner), false);
  assert.equal((await f.invoke("mode=identity")).status, 200);
  const identity = await (await f.invoke("mode=identity")).json();
  assert.equal(identity.user_id, owner); assert.equal(identity.billing_allowed, true); assert.equal(f.calls.length, 0);
});
test("missing dedicated roster, wrong origins/realm, and forbidden credential headers fail before upstream", async () => {
  for (const value of [undefined, "", "*", owner + ","]) {
    const f = fixture({ env: { TOKENTRACKER_SANDBOX_GATEWAY_USER_IDS: value } });
    assert.equal((await f.invoke("fn=tokentracker-account-summary")).status, 503); assert.equal(f.calls.length, 0);
  }
  for (const headers of [{ Origin: "https://foreign.example" }, { "X-TokenTracker-Sandbox-Realm": "live" }, { Cookie: "not-a-real-cookie" },
    { apikey: "not-a-real-admin" }, { "x-csrf-token": "not-a-real-csrf" }]) {
    const f = fixture(); assert.equal((await f.invoke("fn=tokentracker-account-summary", { headers })).status, 403); assert.equal(f.calls.length, 0);
  }
});
test("forged, expired, service, anonymous and unapproved identities cannot dispatch", async () => {
  const f = fixture();
  for (const token of ["", jwt(owner, { signing: "wrong" }), jwt(owner, { exp: 1 }), jwt(owner, { role: "project_admin" }), jwt(owner, { role: "anon" })]) {
    assert.equal((await f.invoke("fn=tokentracker-account-summary", { token })).status, 401);
  }
  assert.equal((await f.invoke("fn=tokentracker-account-summary", { token: jwt(unknown) })).status, 403);
  assert.equal(f.calls.length, 0);
});
test("all approved private routes use only independent access sandbox slugs with the original verified bearer", async () => {
  const f = fixture();
  for (const name of ["summary", "daily", "hourly", "monthly", "heatmap", "model-breakdown", "devices"]) {
    assert.equal((await f.invoke("fn=tokentracker-account-" + name + "&from=2026-10-01")).status, 200);
    assert.equal(f.calls.at(-1).url.pathname, "/tokentracker-account-" + name + "-sandbox");
  }
  for (const [name, method] of [["device-token-issue", "POST"], ["device-rename", "PATCH"], ["device-flow-authorize", "POST"], ["device-flow-grant", "POST"], ["device-flow-poll", "POST"]]) {
    assert.equal((await f.invoke("fn=tokentracker-" + name, { method, body: {} })).status, 200);
    assert.equal(f.calls.at(-1).url.pathname, "/tokentracker-" + name + "-sandbox");
  }
  for (const call of f.calls) {
    assert.equal(call.url.origin, "https://srctyff5.function2.insforge.app");
    assert.equal(call.init.headers.Authorization, "Bearer " + f.defaultToken);
    assert.deepEqual(Object.keys(call.init.headers).sort(), call.init.body ? ["Authorization", "Content-Type"] : ["Authorization"]);
    assert.equal(call.init.redirect, "error");
  }
});
test("billing actions split finance from QA device management; neither can select live nor shared portal", async () => {
  const f = fixture();
  for (const action of ["account", "devices"]) {
    assert.equal((await f.invoke("fn=tokentracker-billing&action=" + action)).status, 200);
    assert.equal(f.calls.at(-1).url.pathname, "/tokentracker-billing-access-sandbox");
  }
  assert.equal((await f.invoke("fn=tokentracker-billing&action=remove-device", { method: "POST", body: { machine_id: randomUUID() } })).status, 200);
  assert.equal(f.calls.at(-1).url.pathname, "/tokentracker-billing-access-sandbox");
  assert.equal((await f.invoke("fn=tokentracker-billing&action=redeem-gift", { token: jwt(peer), method: "POST",
    body: { code: "TT-PRO-" + "A".repeat(32), request_id: randomUUID() } })).status, 200);
  assert.equal(f.calls.at(-1).url.pathname, "/tokentracker-billing-access-sandbox");
  assert.equal((await f.invoke("fn=tokentracker-billing&action=catalog")).status, 200);
  assert.equal(f.calls.at(-1).url.pathname, "/tokentracker-billing-sandbox");
  assert.equal((await f.invoke("fn=tokentracker-billing&action=catalog", { token: jwt(peer) })).status, 403);
  for (const action of ["checkout", "restart-checkout", "reconcile", "cancel", "trial"]) {
    assert.equal((await f.invoke("fn=tokentracker-billing&action=" + action, { method: "POST", body: {} })).status, 200);
    assert.equal(f.calls.at(-1).url.pathname, "/tokentracker-billing-sandbox");
  }
  const before = f.calls.length;
  assert.equal((await f.invoke("fn=tokentracker-billing&action=portal", { method: "POST", body: {} })).status, 503);
  assert.equal((await f.invoke("fn=tokentracker-billing&environment=live")).status, 400);
  assert.equal((await f.invoke("fn=tokentracker-billing&action=checkout", { method: "POST", body: { provider: "paddle" } })).status, 400);
  assert.equal(f.calls.length, before);
  assert.equal(f.reads.some(name => /WAFFO|PADDLE|ALIPAY|WECHAT|BILLING_ENVIRONMENT/.test(name)), false);
});
test("device ingest requires actual QA hash/owner/sandbox/non-revoked binding", async () => {
  const token = "f".repeat(64);
  const good = fixture(); assert.equal((await good.invoke("fn=tokentracker-ingest", { method: "POST", token, body: { buckets: [] } })).status, 200);
  assert.deepEqual(good.tokenLookups, [createHash("sha256").update(token).digest("hex")]);
  assert.equal(good.calls[0].url.pathname, "/tokentracker-ingest-sandbox");
  for (const row of [null, { user_id: owner, cloud_environment: "live", revoked_at: null }, { user_id: owner, cloud_environment: "sandbox", revoked_at: "2026-10-01" },
    { user_id: unknown, cloud_environment: "sandbox", revoked_at: null }]) {
    const f = fixture({ tokenRow: row }); assert.ok([401, 403].includes((await f.invoke("fn=tokentracker-ingest", { method: "POST", token, body: {} })).status)); assert.equal(f.calls.length, 0);
  }
});
test("the original installed SDK reads only the QA token table with server credentials; proof does not upload", async () => {
  const previous = globalThis.fetch, token = "a".repeat(64), reads = [], forwarded = [];
  const env = { TOKENTRACKER_SANDBOX_GATEWAY_USER_IDS: owner, TOKENTRACKER_SANDBOX_ACCESS_USER_IDS: owner, TOKENTRACKER_SANDBOX_USER_IDS: owner,
    TOKENTRACKER_SANDBOX_GATEWAY_ORIGINS: "http://127.0.0.1:17680", TOKENTRACKER_SANDBOX_BILLING_SITE_URL: "https://native-sandbox-return.example",
    INSFORGE_BASE_URL: "https://srctyff5.us-east.insforge.app", INSFORGE_SERVICE_ROLE_KEY: "local-server-credential-fixture", ANON_KEY: "local-public-key-fixture" };
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); reads.push(url);
      assert.equal(url.origin, env.INSFORGE_BASE_URL);
      assert.equal(url.pathname, "/api/database/records/tt_cloud_qa_tokentracker_device_tokens");
      assert.equal(url.searchParams.get("token_hash"), "eq." + createHash("sha256").update(token).digest("hex"));
      assert.equal(url.searchParams.get("revoked_at"), "is.null");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + env.INSFORGE_SERVICE_ROLE_KEY);
      assert.equal(init.method, "GET");
      return Response.json([{ user_id: owner, cloud_environment: "sandbox", revoked_at: null }]);
    };
    const handler = createNativeSandboxGateway({ getEnv: name => env[name], fetchImpl: async (...args) => { forwarded.push(args); throw Error("no proxy on proof"); } });
    const response = await handler(new Request(gatewayUrl + "?mode=device-identity", { headers: { Authorization: "Bearer " + token, "X-TokenTracker-Sandbox-Realm": realm } }));
    assert.equal(response.status, 200); const proof = await response.json();
    assert.equal(proof.user_id, owner); assert.equal(proof.upload_scope, "qa_device"); assert.equal(proof.environment, "sandbox");
    assert.equal(JSON.stringify(proof).includes(token), false); assert.equal(reads.length, 1); assert.equal(forwarded.length, 0);
  } finally { globalThis.fetch = previous; }
});
test("unknown/admin/database/live aliases and oversized/malformed mutations never reach upstream", async () => {
  const f = fixture();
  for (const query of ["fn=tokentracker-waffo-webhook", "fn=tokentracker-public-visibility", "fn=tokentracker-ingest-sandbox", "fn=tokentracker-account-summary&fn=tokentracker-billing", "mode=auth", "fn=tokentracker-account-summary&url=https://foreign.example"]) {
    assert.ok([400, 404].includes((await f.invoke(query)).status));
  }
  assert.equal((await f.invoke("fn=tokentracker-device-token-issue", { method: "POST", body: { name: "x".repeat(17_000) } })).status, 413);
  assert.equal((await f.invoke("fn=tokentracker-account-summary", { method: "POST", body: {} })).status, 405);
  assert.equal(f.calls.length, 0);
});
test("live/credential responses and ambiguous checkout URL are rejected without pretending payment succeeded", async () => {
  for (const response of [{ environment: "live" }, { membership: { environment: "live" } }, { api_key: "fake" },
    { order: { checkout_url: "https://pancake.waffo.ai/checkout?csId=fake" } }]) {
    assert.equal((await fixture({ response }).invoke("fn=tokentracker-billing&action=order&id=" + randomUUID())).status, 502);
  }
  const canonical = "https://pancake.waffo.ai/store/STO_fixture/checkout/cs_fixture?test=true";
  assert.equal(sandboxCheckoutUrl(canonical), true);
  for (const url of ["https://pancake.waffo.ai/checkout?csId=fake&test=true", canonical + "&csId=fake", canonical + "&test=true",
    canonical.replace("?test=true", ""), canonical.replace("test=true", "test=false"), canonical + "#fragment",
    canonical.replace("pancake.waffo.ai", "pancake.waffo.ai:443"), canonical.replace("pancake.waffo.ai", "caller@pancake.waffo.ai"),
    "https://pancake.waffo.ai/consumer/portal/login?test=true", canonical.replace("pancake.waffo.ai", "foreign.example")]) {
    assert.equal(sandboxCheckoutUrl(url), false, url);
  }
  const realShape = await fixture({ response: { order: { id: randomUUID(), checkout_url: canonical, status: "paid" },
    membership: { environment: "sandbox", status: "active" } } }).invoke("fn=tokentracker-billing&action=order&id=" + randomUUID());
  assert.equal(realShape.status, 200);
});
test("public client transport preserves actual issuer via broker and has no live/function fallback", async () => {
  const { createNativeSandboxTransport, GATEWAY, BACKEND, REALM } = await import("../scripts/cloud-sandbox/native-client-transport.mjs");
  const calls = [], auth = [], local = [];
  const profile = { schemaVersion: 1, realm: REALM, environment: "sandbox", backendBaseUrl: BACKEND, gatewayUrl: GATEWAY,
    returnSiteOrigin: "https://native-sandbox-return.example", returnPath: "/billing/checkout", protocol: "tokentracker-qa", auth: { issuerUnchanged: true, brokerRequired: true } };
  const transport = createNativeSandboxTransport({ profile, localOrigin: "http://127.0.0.1:17680", getAccessToken: async () => jwt(),
    fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return Response.json({}); },
    authBrokerFetch: async (input, init) => { auth.push({ input, init }); return Response.json({}); },
    localFetch: async (input, init) => { local.push({ input, init }); return Response.json({}); } });
  await transport("https://srctyff5.function2.insforge.app/tokentracker-billing?action=catalog", { headers: { apikey: "public-fake", Cookie: "fake", "x-csrf-token": "fake" } });
  assert.equal(calls[0].url.origin + calls[0].url.pathname, GATEWAY);
  assert.equal(calls[0].url.searchParams.get("fn"), "tokentracker-billing");
  assert.equal(calls[0].init.headers.get("x-tokentracker-sandbox-realm"), REALM);
  assert.equal(calls[0].init.headers.get("Cookie"), null); assert.equal(calls[0].init.headers.get("apikey"), null);
  await transport("http://127.0.0.1:17680/api/auth/refresh", { method: "POST", headers: { "x-csrf-token": "real-shape-fake-value" }, credentials: "include" });
  assert.equal(auth.length, 1); assert.equal(auth[0].init.credentials, "include"); assert.equal(auth[0].init.headers["x-csrf-token"], "real-shape-fake-value");
  await transport("http://127.0.0.1:17680/api/auth/logout", { method: "POST", headers: { "x-csrf-token": "logout-csrf-fixture", Cookie: "local-handle-fixture" }, credentials: "include" });
  assert.equal(auth.length, 2); assert.equal(auth[1].init.headers["x-csrf-token"], "logout-csrf-fixture");
  assert.equal(auth[1].init.headers.Cookie, "local-handle-fixture"); assert.equal(auth[1].init.credentials, "include");
  assert.equal((await transport("http://127.0.0.1:17680/api/auth/logout", { method: "GET" })).status, 503); assert.equal(auth.length, 2);
  await transport("http://127.0.0.1:17680/functions/tokentracker-cloud-session", { method: "POST", body: "{}" }); assert.equal(local.length, 1);
  for (const url of [BACKEND + "/api/database/records/auth.users", BACKEND + "/functions/tokentracker-telemetry", "https://foreign.example/functions/tokentracker-billing"]) assert.equal((await transport(url)).status, 503);
  assert.equal(calls.length, 1);
  assert.throws(() => createNativeSandboxTransport({ profile: { ...profile, environment: "live" } }), /profile_invalid/);
});
test("shared business classification includes every native alias without promoting fixture reads", async () => {
  const { classifyNativeSandboxFunction, BACKEND, FUNCTIONS } = await import("../scripts/cloud-sandbox/native-client-transport.mjs");
  const local = "http://127.0.0.1:17680";
  for (const name of ["tokentracker-billing", "tokentracker-account-summary", "tokentracker-device-token-issue", "tokentracker-ingest"]) {
    for (const url of [FUNCTIONS + "/" + name, BACKEND + "/functions/" + name, BACKEND + "/api/functions/" + name,
      local + "/functions/" + name, local + "/api/functions/" + name]) {
      assert.equal(classifyNativeSandboxFunction(url + "?action=checkout", local), name);
    }
  }
  for (const url of [local + "/functions/tokentracker-usage-summary", local + "/functions/tokentracker-local-sync",
    BACKEND + "/api/auth/refresh", FUNCTIONS + "/tokentracker-telemetry", "https://foreign.example/functions/tokentracker-billing",
    local + "/functions/tokentracker-billing/extra", local + "/functions/tokentracker-billing#fragment"]) {
    assert.equal(classifyNativeSandboxFunction(url, local), null);
  }
});
test("standalone builders emit only the new gateway and generic return source, without editing ordinary targets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-native-gateway-test-"));
  try {
    const before = await fs.readFile(path.resolve(__dirname, "../scripts/build-cloud-functions.cjs"));
    const result = await buildNativeGateway(path.join(directory, "function"));
    const code = await fs.readFile(result.file, "utf8");
    assert.ok(code.includes("tokentracker-native-sandbox-v1")); assert.ok(!code.includes("WAFFO_PRIVATE_KEY"));
    const site = await buildNativeReturnSite(path.join(directory, "return-site"));
    const script = await fs.readFile(path.join(site, "public/return.js"), "utf8");
    assert.ok(script.includes("tokentracker-qa://billing/return")); assert.ok(script.includes("params.getAll('order').length===1"));
    for (const value of [owner, peer, jwt(), secret]) assert.equal(script.includes(value), false);
    assert.deepEqual(await fs.readFile(path.resolve(__dirname, "../scripts/build-cloud-functions.cjs")), before);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
