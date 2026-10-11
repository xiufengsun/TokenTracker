const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const Module = require("node:module");
const { createHash, createHmac, randomUUID } = require("node:crypto");
const { build } = require("esbuild");
const { buildCloudFunctions } = require("../scripts/build-cloud-functions.cjs");
const { TABLE_MAP, RPC_MAP } = require("../scripts/cloud-sandbox/qa-database.cjs");
const ROOT = path.resolve(__dirname, "..");
const original = { Deno: globalThis.Deno, fetch: globalThis.fetch };
const users = [randomUUID(), randomUUID()];
const secret = "local-qa-access-test-jwt";
const deviceId = randomUUID();
const token = "d".repeat(64);
const tokenHash = createHash("sha256").update(token).digest("hex");
let env, reads, requests, handlers, sdk, tokenRow, codeRow, codeLookups, raceOwner, raceFirstApproved;
const config = () => ({ baseUrl: env.INSFORGE_BASE_URL, edgeFunctionToken: env.INSFORGE_SERVICE_ROLE_KEY,
  anonKey: env.ANON_KEY, headers: { apikey: env.ANON_KEY } });
const jwt = (sub = users[0], role = "authenticated", signingSecret = secret) => {
  const input = [{ alg: "HS256" }, { sub, role, exp: Math.floor(Date.now() / 1000) + 3600 }]
    .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return input + "." + createHmac("sha256", signingSecret).update(input).digest("base64url");
};
async function load(filename) {
  const output = await build({ entryPoints: [filename], bundle: true, write: false, platform: "node", format: "cjs", target: "node20", logLevel: "silent",
    plugins: [{ name: "actual-locked-sdk", setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, args => {
        if (args.path === "npm:@insforge/sdk@1.4.5") return {
          path: path.join(path.dirname(require.resolve("@insforge/sdk", { paths: [path.join(ROOT, "dashboard")] })), "index.mjs") };
        return { path: require.resolve(args.path.slice(4).replace(/@(\d[^/]*)/, ""), { paths: [ROOT] }) };
      });
    } }] });
  const compiled = new Module(filename, module);
  compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(output.outputFiles[0].text, filename);
  return compiled.exports;
}
const hashes = async output => Object.fromEntries(await Promise.all((await fs.readdir(output)).map(async name =>
  [name, createHash("sha256").update(await fs.readFile(path.join(output, name))).digest("hex")])));
test.before(async () => {
  const normal = await buildCloudFunctions(); const normalBefore = await hashes(normal.output);
  const financial = await buildCloudFunctions({ sandbox: true }); const financialBefore = await hashes(financial.output);
  const access = await buildCloudFunctions({ accessSandbox: true });
  assert.deepEqual(await hashes(normal.output), normalBefore);
  assert.deepEqual(await hashes(financial.output), financialBefore);
  assert.equal(access.functions.length, 14);
  env = { INSFORGE_BASE_URL: "https://qa-access.invalid", INSFORGE_SERVICE_ROLE_KEY: "qa-test-service", ANON_KEY: "qa-test-anon", JWT_SECRET: secret,
    TOKENTRACKER_BILLING_ENVIRONMENT: "live", TOKENTRACKER_SANDBOX_USER_IDS: randomUUID(),
    TOKENTRACKER_SANDBOX_ACCESS_USER_IDS: users.join(","), TOKENTRACKER_SANDBOX_ACCESS_SITE_URL: "http://127.0.0.1:5196",
    WAFFO_PRIVATE_KEY: "never-read", TOKENTRACKER_SANDBOX_WAFFO_PRIVATE_KEY: "never-read" };
  reads = []; requests = [];
  globalThis.Deno = { env: { get: name => { reads.push(name); return env[name]; } } };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url || input.href);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method, body });
    assert.equal(url.origin, env.INSFORGE_BASE_URL, "unit guards must never reach a hosted backend");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + env.INSFORGE_SERVICE_ROLE_KEY);
    const name = url.pathname.split("/").pop();
    if (url.pathname.includes("/rpc/")) {
      if (["cloud_gift_account", "cloud_redeem_gift"].includes(name)) {
        const args = JSON.parse(init.body);
        assert.equal(args.p_environment, "sandbox");
        assert.equal(args.p_user_id, users[0]);
        if (name === "cloud_gift_account") return Response.json({ gift_redemption_available: true, gifts: [] });
        return Response.json({ ok: false, status: 400, code: "gift_code_unavailable" });
      }
      assert.ok(name.startsWith("tt_cloud_qa_"));
      if (name === RPC_MAP.cloud_issue_device_token) return Response.json({ ok: true, device_id: deviceId, machine_id: randomUUID(), created_at: new Date().toISOString(), membership: { status: "active", machine_limit: 5 } });
      if (name === RPC_MAP.cloud_account_access) return Response.json({ ok: false, code: "cloud_membership_required", status: 402 });
      if (name === RPC_MAP.cloud_ingest_usage) return Response.json({ ok: true, uploaded: 1 });
      if (name === RPC_MAP.cloud_membership) return Response.json({ status: "free", trial_available: true });
      if (name === RPC_MAP.cloud_grant_device_code) return Response.json({ ok: true, status: "approved" });
      if ([RPC_MAP.cloud_list_machines, RPC_MAP.cloud_remove_machine, RPC_MAP.cloud_resume_machine].includes(name)) return Response.json({ ok: true, machines: [], machine_count: 0 });
      throw Error("Unexpected QA RPC");
    }
    if (name === TABLE_MAP.tokentracker_device_tokens) return Response.json(tokenRow && url.searchParams.get("token_hash") === "eq." + tokenHash ? [tokenRow] : []);
    if (name === TABLE_MAP.tokentracker_device_codes) {
      codeLookups++;
      const row = raceOwner ? { ...codeRow, user_id: codeLookups === 1 ? (raceFirstApproved ? users[0] : null) : raceOwner,
        status: codeLookups === 1 && !raceFirstApproved ? "pending" : "approved" } : codeRow;
      return Response.json(method === "POST" ? [] : row ? [row] : []);
    }
    if (name === TABLE_MAP.tokentracker_devices) return Response.json([{ id: deviceId, user_id: users[0], device_name: "QA machine", name_customized: false, platform: "web" }]);
    assert.ok(["tokentracker_cloud_orders", "tokentracker_cloud_payments", "tokentracker_cloud_subscriptions"].includes(name));
    assert.equal(method, "GET", "financial evidence is read only");
    assert.equal(url.searchParams.get("user_id"), "eq." + users[0]);
    assert.equal(url.searchParams.get("environment"), "eq.sandbox");
    return Response.json([]);
  };
  handlers = {};
  for (const name of access.functions) handlers[name.replace(/^tokentracker-|-sandbox$/g, "")] = (await load(path.join(access.output, name + ".js"))).default;
  sdk = await load(path.join(ROOT, "scripts/cloud-sandbox/qa-sdk.ts"));
});
test.after(() => { globalThis.Deno = original.Deno; globalThis.fetch = original.fetch; });
test.beforeEach(() => {
  reads.length = 0; requests.length = 0;
  codeLookups = 0; raceOwner = null; raceFirstApproved = false;
  tokenRow = { user_id: users[0], device_id: deviceId, cloud_environment: "sandbox" };
  codeRow = { user_id: users[0], status: "approved", expires_at: new Date(Date.now() + 60_000).toISOString(), client_info: "QA", machine_id: "qa-machine-flow" };
});
function request(name, { method, body, authorization = jwt(), query = "" } = {}) {
  method ||= name.startsWith("account-") ? "GET" : "POST";
  const url = "https://qa-access.invalid/functions/tokentracker-" + name + "-sandbox?environment=live&" + query;
  return new Request(url, { method, headers: { Authorization: "Bearer " + authorization, "Content-Type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {}) });
}

test("all access functions fail closed without their dedicated allowlist", async () => {
  const saved = env.TOKENTRACKER_SANDBOX_ACCESS_USER_IDS;
  try {
    for (const value of [undefined, "", "*", users[0] + ","]) {
      env.TOKENTRACKER_SANDBOX_ACCESS_USER_IDS = value;
      for (const [name, handler] of Object.entries(handlers)) assert.equal((await handler(request(name))).status, 503);
    }
    assert.equal(requests.length, 0);
  } finally { env.TOKENTRACKER_SANDBOX_ACCESS_USER_IDS = saved; }
});
test("user handlers reject missing, forged, service/admin, or unapproved identities before SQL", async () => {
  for (const [name, handler] of Object.entries(handlers)) {
    if (name === "ingest") continue;
    for (const authorization of ["", jwt(users[0], "authenticated", "wrong"), jwt(users[0], "anon"), jwt(users[0], "project_admin")]) {
      assert.equal((await handler(request(name, { authorization }))).status, 401);
    }
    assert.equal((await handler(request(name, { authorization: jwt(randomUUID()) }))).status, 403);
  }
  assert.equal(requests.length, 0);
});
test("real SDK issuance writes only the QA RPC and pins sandbox even when a client requests live", async () => {
  for (const sub of users) {
    const response = await handlers["device-token-issue"](request("device-token-issue", { authorization: jwt(sub),
      body: { machine_id: "qa-machine", device_name: "QA", environment: "live", user_id: randomUUID() } }));
    assert.equal(response.status, 200);
    assert.match((await response.json()).token, /^[0-9a-f]{64}$/);
    const call = requests.at(-1);
    assert.equal(call.url.pathname, "/api/database/rpc/" + RPC_MAP.cloud_issue_device_token);
    assert.equal(call.body.p_environment, "sandbox"); assert.equal(call.body.p_user_id, sub);
  }
  assert.equal(reads.includes("TOKENTRACKER_BILLING_ENVIRONMENT"), false);
  assert.equal(reads.some(name => name.includes("WAFFO") || name.startsWith("PADDLE") || name.startsWith("ALIPAY") || name.startsWith("WECHAT")), false);
});
test("device bearer ownership and environment are verified in the isolated QA token table before original ingest", async () => {
  const body = { upload_id: randomUUID(), hourly: [{ hour_start: "2026-10-08T00:00:00Z", source: "codex", model: "gpt-6", total_tokens: 10 }] };
  const send = () => handlers.ingest(request("ingest", { authorization: token, body }));
  assert.equal((await send()).status, 200);
  assert.equal(requests.filter(value => value.url.pathname.includes("/rpc/")).length, 1);
  assert.equal(requests.at(-1).body.p_environment, "sandbox");
  for (const row of [null, { ...tokenRow, cloud_environment: "live" }, { ...tokenRow, user_id: randomUUID() }]) {
    requests.length = 0; tokenRow = row;
    const response = await send(); assert.equal(response.status, row?.cloud_environment === "sandbox" ? 403 : 401);
    assert.equal(requests.filter(value => value.url.pathname.includes("/rpc/")).length, 0);
  }
  assert.ok(requests.every(value => value.url.pathname.endsWith(TABLE_MAP.tokentracker_device_tokens)));
});
test("all seven original readers call the mapped membership gate before any aggregation", async () => {
  for (const suffix of ["summary", "daily", "hourly", "monthly", "heatmap", "model-breakdown", "devices"]) {
    requests.length = 0;
    assert.equal((await handlers["account-" + suffix](request("account-" + suffix, { query: "from=2026-10-01&to=2026-10-08&day=2026-10-08" }))).status, 402);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.pathname, "/api/database/rpc/" + RPC_MAP.cloud_account_access);
    assert.equal(requests[0].body.p_environment, "sandbox");
  }
});
test("the SDK adapter has no public, schema, or unmapped RPC fallback and cannot write financial evidence", () => {
  const client = sdk.createClient(config());
  for (const name of ["tokentracker_hourly", "tt_cloud_qa_tokentracker_devices", "auth.users"]) assert.throws(() => client.database.from(name), /qa_table_not_allowed/);
  for (const name of ["cloud_start_trial", "cloud_create_order", "tt_cloud_qa_cloud_membership"]) assert.throws(() => client.database.rpc(name), /qa_rpc_not_allowed/);
  assert.throws(() => client.database.schema("public"), /qa_database_operation_not_allowed/);
  assert.equal(client.database.from("tokentracker_cloud_orders").update, undefined);
  assert.equal(client.database.from("tokentracker_cloud_payments").insert, undefined);
  assert.throws(() => sdk.createClient({ ...config(), baseUrl: "https://other.invalid" }), /qa_client_configuration_rejected/);
  assert.throws(() => sdk.createClient({ ...config(), db: { schema: "public" } }), /qa_client_configuration_rejected/);
  assert.throws(() => sdk.createClient({ ...config(), headers: { apikey: "client-controlled" } }), /qa_client_headers_rejected/);
  assert.equal(requests.length, 0);
});
test("mutable PostgREST builders cannot escape the final namespace, schema, or financial read-only transport", async () => {
  const client = sdk.createClient(config());
  const financial = () => client.database.from("tokentracker_cloud_payments").select("id")
    .eq("user_id", users[0]).eq("environment", "sandbox");
  const patch = financial(); patch.method = "PATCH"; patch.body = { refunded_cents: 100 };
  assert.ok((await patch).error);
  const getBody = financial(); getBody.body = { refunded_cents: 100 };
  assert.ok((await getBody).error);
  assert.ok((await client.database.from("tokentracker_cloud_payments").select("id").eq("user_id", users[0])).error);
  const otherSchema = financial();
  if (otherSchema.headers instanceof Headers) otherSchema.headers.set("Accept-Profile", "other");
  else otherSchema.headers["Accept-Profile"] = "other";
  assert.ok((await otherSchema).error);
  const live = client.database.from("tokentracker_cloud_payments").select("id").eq("user_id", users[0]).eq("environment", "live");
  assert.ok((await live).error);
  const escape = client.database.rpc("cloud_list_machines", { p_user_id: users[0], p_environment: "sandbox" });
  escape.url.pathname = "/rpc/cloud_create_order";
  assert.ok((await escape).error);
  const changedEnvironment = client.database.rpc("cloud_list_machines", { p_user_id: users[0], p_environment: "sandbox" });
  changedEnvironment.body.p_environment = "live";
  assert.ok((await changedEnvironment).error);
  for (const key of ["getHttpClient", "auth", "functions", "storage"]) assert.throws(() => client[key], /qa_client_operation_not_allowed/);
  assert.equal(requests.length, 0, "transport mutations must be rejected before the actual fetch");
});
test("device management rejects every paid operation while actual financial metadata remains read only", async () => {
  for (const action of ["checkout", "trial", "cancel", "portal", "reconcile", "restart-checkout", "catalog"]) {
    assert.equal((await handlers["billing-access"](request("billing-access", { query: "action=" + action }))).status, 404);
  }
  assert.equal(requests.length, 0);
  const response = await handlers["billing-access"](request("billing-access", { method: "GET", query: "action=account" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).environment, "sandbox");
  assert.equal(requests.filter(value => value.url.pathname.includes("/records/")).length, 4);
  assert.equal(reads.some(name => name.includes("WAFFO") || name.startsWith("PADDLE") || name.startsWith("ALIPAY") || name.startsWith("WECHAT")), false);
});
test("gift redemption uses only the account-bound sandbox RPC and never permits admin issuance", async () => {
  const response = await handlers["billing-access"](request("billing-access", { method: "POST", query: "action=redeem-gift",
    body: { code: "TT-PRO-" + "A".repeat(32), request_id: randomUUID() } }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "gift_code_unavailable");
  const gift = requests.find(x => x.url.pathname.endsWith("/cloud_redeem_gift"));
  assert.equal(gift.body.p_user_id, users[0]);
  assert.equal(gift.body.p_environment, "sandbox");
  assert.match(gift.body.p_code_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(gift).includes("TT-PRO-"));
  requests.length = 0;
  const anonKey = env.INSFORGE_ANON_KEY || env.ANON_KEY;
  const client = sdk.createClient({ baseUrl: env.INSFORGE_BASE_URL, anonKey,
    edgeFunctionToken: env.INSFORGE_SERVICE_ROLE_KEY, headers: { apikey: anonKey } });
  for (const [name, args] of [
    ["cloud_create_gift_batch", { p_environment: "sandbox", p_user_id: users[0] }],
    ["cloud_gift_account", { p_environment: "live", p_user_id: users[0] }],
    ["cloud_gift_account", { p_environment: "sandbox", p_user_id: randomUUID() }],
    ["cloud_gift_account", { p_environment: "sandbox", p_user_id: users[0], p_role: "project_admin" }],
  ]) { try { await client.database.rpc(name, args); } catch {} }
  assert.equal(requests.length, 0, "admin, foreign environment and actor overrides stop before upstream");
});
test("rename updates only the QA devices table through the original handler", async () => {
  const response = await handlers["device-rename"](request("device-rename", { body: { device_id: deviceId, device_name: "Renamed QA" } }));
  assert.equal(response.status, 200);
  const patch = requests.find(value => value.method === "PATCH");
  assert.equal(patch.url.pathname, "/api/database/records/" + TABLE_MAP.tokentracker_devices);
  assert.equal(patch.url.searchParams.get("user_id"), "eq." + users[0]);
  assert.equal(patch.body.device_name, "Renamed QA");
});
test("device flow is private, rewrites only its verification destination, and binds approved polling to its real owner", async () => {
  const response = await handlers["device-flow-authorize"](request("device-flow-authorize", { body: { machine_id: "qa-flow-machine" } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verification_uri, "http://127.0.0.1:5196/device");
  assert.equal(requests[0].url.pathname, "/api/database/records/" + TABLE_MAP.tokentracker_device_codes);
  assert.equal(requests[0].method, "POST");
  codeRow.user_id = users[1];
  for (const device_code of ["a".repeat(64), " \t" + "a".repeat(64) + "\n "]) {
    requests.length = 0;
    const denied = await handlers["device-flow-poll"](request("device-flow-poll", { body: { device_code } }));
    assert.equal(denied.status, 403);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.pathname, "/api/database/records/" + TABLE_MAP.tokentracker_device_codes);
    assert.equal(requests[0].url.searchParams.get("device_code"), "eq." + "a".repeat(64));
  }
});
test("adapter table and RPC contracts are a closed subset of the isolated SQL manifest", () => {
  for (const name of sdk.QA_TABLE_NAMES) assert.equal(TABLE_MAP[name], "tt_cloud_qa_" + name);
  for (const name of sdk.QA_RPC_NAMES) assert.equal(RPC_MAP[name], "tt_cloud_qa_" + name);
});
test("a pending-to-approved owner race waits before the real poll handler can mint or rotate a peer token", async () => {
  raceOwner = users[1];
  const response = await handlers["device-flow-poll"](request("device-flow-poll", { body: { device_code: "a".repeat(64) } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "pending" });
  assert.equal(codeLookups, 1);
  assert.equal(requests.some(value => value.url.pathname.endsWith(RPC_MAP.cloud_issue_device_token)), false);
});
test("a changed owner returned by the real poll handler is withheld even after an approved precheck", async () => {
  raceOwner = users[1]; raceFirstApproved = true;
  const response = await handlers["device-flow-poll"](request("device-flow-poll", { body: { device_code: "a".repeat(64) } }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "sandbox_access_user_not_allowed" });
  const issued = requests.find(value => value.url.pathname.endsWith(RPC_MAP.cloud_issue_device_token));
  assert.ok(issued, "the original handler may mint a QA token during the race, but the guard must withhold it");
  assert.equal(issued.body.p_user_id, users[1]);
});
