const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const { createHmac, randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { resolveRuntimeConfig, isPublicAnonKey, DEFAULT_ANON_KEY, DEFAULT_BASE_URL, DEFAULT_DASHBOARD_URL } = require("../src/lib/runtime-config");
const { createLocalApiHandler } = require("../src/lib/local-api");
const { cmdDeviceLogin } = require("../src/commands/device-login");

function jwt(role, secret, sub = randomUUID()) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role, sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + server.address().port;
}
async function instance(t, name, { beforeResponse, verificationBase, publicKey } = {}) {
  const anon = publicKey || jwt("anon", name); const user = randomUUID(); const access = jwt("authenticated", name, user);
  const calls = []; let base;
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, headers: req.headers, body });
    if (beforeResponse) await beforeResponse(req);
    res.setHeader("Content-Type", "application/json");
    if (req.headers.apikey !== anon) { res.writeHead(401); res.end(JSON.stringify({ error: "wrong instance key" })); return; }
    if (req.url.startsWith("/api/auth/sign-in")) {
      res.setHeader("Set-Cookie", [`insforge_refresh_token=refresh-${name}; Path=/; HttpOnly; SameSite=Lax`,
        `insforge_csrf_token=csrf-${name}; Path=/; SameSite=Lax`]);
      res.end(JSON.stringify({ accessToken: access, refreshToken: `refresh-${name}`, csrfToken: `csrf-${name}` })); return;
    }
    if (req.url.startsWith("/api/auth/refresh")) {
      if (body.refresh_token && body.refresh_token !== `refresh-${name}`) { res.writeHead(401); res.end("{}"); return; }
      res.end(JSON.stringify({ accessToken: access, refreshToken: `refresh-${name}`, csrfToken: `csrf-${name}` })); return;
    }
    if (req.url.includes("device-token-issue")) {
      assert.equal(req.headers.authorization, "Bearer " + access);
      res.end(JSON.stringify({ token: `device-${name}`, device_id: randomUUID() })); return;
    }
    if (req.url.includes("device-flow-authorize")) {
      res.end(JSON.stringify({ device_code: `code-${name}`, user_code: `USER-${name}`, expires_in: 900,
        verification_uri: (verificationBase || base) + "/device",
        verification_uri_complete: (verificationBase || base) + "/device?user_code=USER-" + name })); return;
    }
    if (req.url.includes("device-flow-poll")) {
      res.end(JSON.stringify({ status: "approved", user_id: user, device_token: `device-${name}`, device_id: randomUUID() })); return;
    }
    res.writeHead(404); res.end("{}");
  });
  base = await listen(server);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { base, anon, user, access, calls };
}
const opaque = length => "anon_" + "746573742d616e6f6e2d66616b65".repeat(3).slice(0, length);
test("opaque public key formats remain bound to their explicit Node runtime instance", () => {
  const baseUrl = "https://private.example.test";
  for (const length of [40, 64]) {
    const anonKey = opaque(length);
    assert.equal(isPublicAnonKey(anonKey), true);
    for (const input of [{ cli: { baseUrl, anonKey }, env: {} }, { config: { baseUrl, anonKey }, env: {} },
      { env: { TOKENTRACKER_INSFORGE_BASE_URL: baseUrl, TOKENTRACKER_INSFORGE_ANON_KEY: anonKey } }]) {
      const result = resolveRuntimeConfig(input);
      assert.equal(result.baseUrl, baseUrl); assert.equal(result.anonKey, anonKey); assert.equal(result.configurationError, null);
    }
    const changed = resolveRuntimeConfig({ cli: { baseUrl: "https://another.example.test" }, config: { baseUrl, anonKey }, env: {} });
    assert.equal(changed.anonKey, null); assert.equal(changed.configurationError, "custom_insforge_anon_key_required");
  }
});
test("invalid opaque formats never become public credentials or trigger the official fallback", () => {
  const invalid = ["anon_", ...[39, 41, 63, 65].map(length => "anon_" + "a".repeat(length)),
    "anon_" + opaque(40).slice(5).toUpperCase(), "anon_" + "g".repeat(40), "anon__" + "a".repeat(40),
    "an0n_" + "a".repeat(40), "ik_" + "a".repeat(40), "ik_" + jwt("anon", "test"), "a".repeat(64), "-----BEGIN PRIVATE KEY-----",
    jwt("service_role", "test"), jwt("authenticated", "test"), jwt("project_admin", "test")];
  for (const anonKey of invalid) {
    assert.equal(isPublicAnonKey(anonKey), false);
    const result = resolveRuntimeConfig({ cli: { baseUrl: "https://private.example.test", anonKey }, env: {} });
    assert.equal(result.anonKey, null); assert.equal(result.deviceToken, null); assert.equal(result.configurationError, "invalid_insforge_anon_key");
    assert.notEqual(result.baseUrl, DEFAULT_BASE_URL);
  }
});
async function local(t, { cloudSync = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tt-instance-isolation-"));
  const queue = path.join(directory, "queue.jsonl");
  const history = '{"source":"codex","model":"gpt-6","hour_start":"2026-10-01T12:00:00Z","total_tokens":123}\n';
  await fs.writeFile(queue, history);
  if (cloudSync) await fs.writeFile(path.join(directory, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  const handler = createLocalApiHandler({ queuePath: queue, trackerDataDir: directory });
  const server = http.createServer(async (req, res) => {
    try { if (!await handler(req, res, new URL(req.url, "http://localhost"))) { res.writeHead(404); res.end(); } }
    catch { res.writeHead(500); res.end(); }
  });
  const base = await listen(server);
  t.after(async () => { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); await fs.rm(directory, { recursive: true, force: true }); });
  const config = value => fs.writeFile(path.join(directory, "config.json"), JSON.stringify(value));
  const request = (route, value, headers = {}) => fetch(base + route, { method: value === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { directory, queue, history, base, config, request };
}

test("pure runtime parsing binds custom public keys and credentials to their selected instance", async () => {
  const before = fssync.existsSync(path.join(process.cwd(), "runtime-instance.json"));
  const a = "https://a.example.test"; const b = "https://b.example.test";
  const anon = jwt("anon", "A");
  const invalid = resolveRuntimeConfig({ cli: { baseUrl: b }, config: { baseUrl: a, anonKey: anon,
    deviceToken: "old-private-token", deviceTokenBaseUrl: a }, env: {} });
  assert.equal(invalid.anonKey, null); assert.equal(invalid.deviceToken, null);
  assert.equal(invalid.configurationError, "custom_insforge_anon_key_required");
  for (const key of [DEFAULT_ANON_KEY, "ik_privileged-test-only", jwt("service_role", "A")]) {
    const denied = resolveRuntimeConfig({ cli: { baseUrl: b, anonKey: key }, env: {} });
    assert.equal(denied.anonKey, null); assert.equal(denied.configurationError, "invalid_insforge_anon_key");
  }
  assert.equal(fssync.existsSync(path.join(process.cwd(), "runtime-instance.json")), before);
});

test("CLI init persists its own public configuration and resets cloud identity while keeping local history", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-selfhost-init-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const tracker = path.join(home, ".tokentracker", "tracker"); await fs.mkdir(tracker, { recursive: true });
  const configPath = path.join(tracker, "config.json");
  const a = "https://a.example.test"; const b = "https://b.example.test";
  const anonB = opaque(64); const keyFile = path.join(home, "public-anon.txt");
  const history = '{"total_tokens":123}\n'; const cursors = '{"codex":{"offset":99}}';
  await fs.writeFile(configPath, JSON.stringify({ baseUrl: a, anonKey: jwt("anon", "A"), dashboardUrl: a,
    deviceToken: "old-device-A", deviceTokenBaseUrl: a, deviceId: "old-id", user_id: "old-user", machineId: "same-machine",
    providerPreference: "preserved" }));
  await fs.writeFile(path.join(tracker, "queue.jsonl"), history);
  await fs.writeFile(path.join(tracker, "cursors.json"), cursors);
  await fs.writeFile(path.join(tracker, "queue.state.json"), '{"offset":123}');
  const transient = ["relay-cookies.json", "cloud-device-token.json", "cloud-upload-owner.json", "upload.throttle.json", "link_code_state.json"];
  for (const file of transient) await fs.writeFile(path.join(tracker, file), "{}");
  await fs.writeFile(keyFile, anonB + "\n");
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, ".codex"), OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
    TOKENTRACKER_SKIP_LOCAL_RUNTIME_COPY: "1", TOKENTRACKER_SKIP_FIRST_SYNC: "1", TOKENTRACKER_SKIP_OPENCLAW_CLI: "1" };
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "TMPDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  const run = args => promisify(execFile)(process.execPath,
    [path.join(__dirname, "..", "bin", "tracker.js"), "init", "--yes", "--no-auth", "--no-open", ...args],
    { env, cwd: home, timeout: 15000 });
  await run(["--base-url", b, "--anon-key-file", keyFile, "--dashboard-url", b + "/dashboard"]);
  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(saved.baseUrl, b); assert.equal(saved.anonKey, anonB); assert.equal(saved.dashboardUrl, b + "/dashboard");
  assert.equal(saved.deviceToken, undefined); assert.equal(saved.deviceId, undefined); assert.equal(saved.user_id, undefined);
  assert.equal(saved.machineId, "same-machine"); assert.equal(saved.providerPreference, "preserved");
  assert.equal(await fs.readFile(path.join(tracker, "queue.jsonl"), "utf8"), history);
  assert.equal(await fs.readFile(path.join(tracker, "cursors.json"), "utf8"), cursors);
  assert.equal(JSON.parse(await fs.readFile(path.join(tracker, "queue.state.json"), "utf8")).offset, 0);
  for (const file of transient) assert.equal(fssync.existsSync(path.join(tracker, file)), false);
  await run(["--base-url", DEFAULT_BASE_URL]);
  const official = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(official.baseUrl, DEFAULT_BASE_URL); assert.equal(official.anonKey, DEFAULT_ANON_KEY);
  assert.equal(official.dashboardUrl, DEFAULT_DASHBOARD_URL);
  const before = await fs.readFile(configPath, "utf8");
  await assert.rejects(run(["--base-url", b]), /requires its own public anon key/);
  await assert.rejects(run(["--base-url", b, "--anon-key", "ik_private-unsafe"]), /public anon key/);
  assert.equal(await fs.readFile(configPath, "utf8"), before);
  assert.equal(await fs.readFile(path.join(tracker, "queue.jsonl"), "utf8"), history);
});

test("device login rejects another dashboard before publishing any credentials", async t => {
  const b = await instance(t, "B", { verificationBase: "https://wrong.example.test" });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-device-wrong-dashboard-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const tracker = path.join(home, ".tokentracker", "tracker"); await fs.mkdir(tracker, { recursive: true });
  const configPath = path.join(tracker, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ baseUrl: b.base, anonKey: b.anon, dashboardUrl: b.base }));
  await assert.rejects(cmdDeviceLogin([], { home, sleep: async () => {} }), /different dashboard/);
  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(saved.deviceToken, undefined); assert.equal(b.calls.length, 1);
});

test("device login cannot overwrite a concurrent instance or public-key change", async t => {
  for (const stage of ["authorize", "poll"]) await t.test(stage, async sub => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-device-instance-race-"));
    sub.after(() => fs.rm(home, { recursive: true, force: true }));
    const tracker = path.join(home, ".tokentracker", "tracker"); await fs.mkdir(tracker, { recursive: true });
    const configPath = path.join(tracker, "config.json");
    const replacementKey = jwt("anon", "replacement"); let b;
    b = await instance(sub, "B", { beforeResponse: async req => {
      if (req.url.includes("device-flow-" + stage)) await fs.writeFile(configPath, JSON.stringify({
        baseUrl: stage === "authorize" ? b.base : "https://new.example.test", anonKey: replacementKey,
        dashboardUrl: b.base, concurrentSetting: "kept",
      }));
    } });
    await fs.writeFile(configPath, JSON.stringify({ baseUrl: b.base, anonKey: b.anon, dashboardUrl: b.base }));
    await assert.rejects(cmdDeviceLogin([], { home, sleep: async () => {} }), /Backend instance changed/);
    const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(saved.anonKey, replacementKey); assert.equal(saved.concurrentSetting, "kept");
    assert.equal(saved.deviceToken, undefined); assert.equal(saved.user_id, undefined);
    assert.equal(b.calls.length, stage === "authorize" ? 1 : 2);
  });
});

test("two live HTTP instances never receive another instance's cookie, key, bearer or upload capability", async t => {
  const a = await instance(t, "A", { publicKey: opaque(40) }); const b = await instance(t, "B", { publicKey: opaque(64) }); const app = await local(t, { cloudSync: true });
  await app.config({ baseUrl: a.base, anonKey: a.anon, dashboardUrl: a.base });
  const script = await app.request("/api/runtime-config.js");
  assert.equal(script.headers.get("Cache-Control"), "no-store"); assert.equal(script.headers.get("X-Content-Type-Options"), "nosniff");
  const context = { window: {} }; vm.runInNewContext(await script.text(), context);
  assert.equal(context.window.__TOKENTRACKER_RUNTIME_CONFIG__.baseUrl, a.base);
  assert.equal(context.window.__TOKENTRACKER_RUNTIME_CONFIG__.anonKey, a.anon);
  assert.equal((await app.request("/api/auth/sign-in", {}, { apikey: a.anon, "x-tokentracker-instance": a.base })).status, 200);
  const localAuth = (await (await app.request("/api/local-auth")).json()).token;
  const session = await app.request("/functions/tokentracker-cloud-session", { expectedOwnerId: a.user, insforgeBaseUrl: a.base },
    { "x-tokentracker-local-auth": localAuth, Authorization: "Bearer " + a.access });
  assert.equal(session.status, 200); const oldSession = await session.json();
  await fs.writeFile(path.join(app.directory, "queue.state.json"), JSON.stringify({ offset: 77 }));
  await fs.writeFile(path.join(app.directory, "upload.throttle.json"), JSON.stringify({ nextAllowedAtMs: Date.now() + 50000 }));
  await app.config({ baseUrl: b.base, anonKey: b.anon, dashboardUrl: b.base,
    deviceToken: "device-A", deviceTokenBaseUrl: a.base, user_id: a.user, localPreference: "kept" });
  const changed = await app.request("/api/runtime-config.js");
  const changedBody = await changed.text(); assert.ok(!changedBody.includes("device-A") && !changedBody.includes(a.user));
  const count = b.calls.length;
  assert.equal((await app.request("/api/auth/refresh", {}, { "x-tokentracker-instance": a.base, Cookie: "insforge_refresh_token=refresh-A" })).status, 409);
  assert.equal(b.calls.length, count);
  assert.equal((await app.request("/api/auth/refresh", {}, { "x-tokentracker-instance": b.base, apikey: b.anon,
    Authorization: "Bearer " + a.access })).status, 409);
  assert.equal(b.calls.length, count, "a current marker cannot rebind a known token from another instance");
  assert.equal((await app.request("/api/auth/refresh", {}, { "x-tokentracker-instance": b.base, apikey: b.anon,
    Cookie: "insforge_refresh_token=refresh-A; insforge_csrf_token=csrf-A", "x-csrf-token": "csrf-A" })).status, 200);
  assert.equal(b.calls.at(-1).headers.cookie, undefined); assert.equal(b.calls.at(-1).headers["x-csrf-token"], undefined);
  assert.equal((await app.request("/functions/tokentracker-local-sync", { drain: true, cloudSessionId: oldSession.session_id, expectedOwnerId: a.user },
    { "x-tokentracker-local-auth": localAuth })).status, 409);
  assert.equal((await app.request("/functions/tokentracker-cloud-session", { expectedOwnerId: a.user, insforgeBaseUrl: a.base },
    { "x-tokentracker-local-auth": localAuth, Authorization: "Bearer " + a.access })).status, 409);
  assert.equal((await app.request("/api/auth/refresh", {}, { "x-tokentracker-instance": b.base, apikey: b.anon,
    Authorization: "Bearer " + jwt("authenticated", "existing-B") })).status, 200,
    "existing sessions unknown to the local proxy still reach their configured verifier");
  assert.equal(await fs.readFile(app.queue, "utf8"), app.history);
  assert.equal(JSON.parse(await fs.readFile(path.join(app.directory, "queue.state.json"), "utf8")).offset, 0);
  const saved = JSON.parse(await fs.readFile(path.join(app.directory, "config.json"), "utf8"));
  assert.equal(saved.deviceToken, undefined); assert.equal(saved.user_id, undefined); assert.equal(saved.localPreference, "kept");
  for (const call of b.calls) {
    assert.equal(call.headers.apikey, b.anon); assert.notEqual(call.headers.authorization, "Bearer " + a.access);
    assert.ok(!JSON.stringify(call).includes("refresh-A"));
  }
  await app.config({ baseUrl: a.base, anonKey: a.anon, dashboardUrl: a.base,
    deviceToken: "new-device-A", deviceTokenBaseUrl: a.base });
  await app.request("/api/runtime-config.js");
  const relogged = JSON.parse(await fs.readFile(path.join(app.directory, "config.json"), "utf8"));
  assert.equal(relogged.deviceToken, "new-device-A", "a newly issued device identity explicitly bound to the new target survives reload");
  assert.equal((await app.request("/functions/tokentracker-local-sync", { drain: true, cloudSessionId: oldSession.session_id, expectedOwnerId: a.user },
    { "x-tokentracker-local-auth": localAuth })).status, 409, "returning to A cannot revive its previous upload capability");
});

test("switching a custom instance back to official never relays its old browser cookies", async t => {
  const a = await instance(t, "A"); const app = await local(t); const officialCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith(DEFAULT_BASE_URL + "/")) {
      officialCalls.push({ url: String(url), headers: options.headers, body: options.body });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(url, options);
  };
  t.after(() => { global.fetch = originalFetch; });
  await app.config({ baseUrl: a.base, anonKey: a.anon, dashboardUrl: a.base });
  assert.equal((await app.request("/api/auth/sign-in", {}, { apikey: a.anon, "x-tokentracker-instance": a.base })).status, 200);
  await app.config({ baseUrl: DEFAULT_BASE_URL });
  assert.equal((await app.request("/api/runtime-config.js")).status, 200);
  assert.equal((await app.request("/api/auth/refresh", {}, { apikey: DEFAULT_ANON_KEY, "x-tokentracker-instance": DEFAULT_BASE_URL,
    Cookie: "insforge_refresh_token=refresh-A; insforge_csrf_token=csrf-A", "x-csrf-token": "csrf-A" })).status, 200);
  assert.equal(officialCalls.length, 1);
  assert.equal(officialCalls[0].headers.cookie, undefined); assert.equal(officialCalls[0].headers["x-csrf-token"], undefined);
  assert.equal(officialCalls[0].headers.apikey, DEFAULT_ANON_KEY);
  assert.ok(!JSON.stringify(officialCalls).includes("refresh-A"));
  assert.equal((await app.request("/api/auth/refresh", {}, { apikey: DEFAULT_ANON_KEY,
    "x-tokentracker-instance": DEFAULT_BASE_URL, Authorization: "Bearer " + a.access })).status, 409);
  assert.equal(officialCalls.length, 1, "a known custom JWT is rejected before the official request");
});

test("a late auth response cannot restore the previous instance's relay credentials", async t => {
  let started; let release;
  const arrived = new Promise(resolve => { started = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const a = await instance(t, "A", { beforeResponse: async req => {
    if (req.url.startsWith("/api/auth/refresh")) { started(); await paused; }
  } });
  const b = await instance(t, "B"); const app = await local(t);
  await app.config({ baseUrl: a.base, anonKey: a.anon, dashboardUrl: a.base });
  assert.equal((await app.request("/api/auth/sign-in", {}, { apikey: a.anon, "x-tokentracker-instance": a.base })).status, 200);
  const pending = app.request("/api/auth/refresh", {}, { apikey: a.anon, "x-tokentracker-instance": a.base });
  await arrived;
  await app.config({ baseUrl: b.base, anonKey: b.anon, dashboardUrl: b.base });
  await app.request("/api/runtime-config.js"); release();
  const response = await pending;
  assert.equal(response.status, 409); assert.equal(response.headers.get("set-cookie"), null);
  assert.ok(!(await response.text()).includes(a.access));
  assert.equal(fssync.existsSync(path.join(app.directory, "relay-cookies.json")), false);
  assert.equal((await app.request("/api/auth/refresh", {}, { apikey: b.anon, "x-tokentracker-instance": b.base,
    Cookie: "insforge_refresh_token=refresh-A" })).status, 200);
  assert.ok(b.calls.every(call => !JSON.stringify(call).includes("refresh-A")));
});

test("custom missing or privileged client configuration fails closed without exposing secrets", async t => {
  const b = await instance(t, "B"); const app = await local(t);
  for (const config of [{ baseUrl: b.base }, { baseUrl: b.base, anonKey: "ik_private-do-not-expose" },
    { baseUrl: "https://user:secret@example.test", anonKey: b.anon }]) {
    await app.config(config);
    const script = await app.request("/api/runtime-config.js"); const body = await script.text();
    assert.ok(!body.includes(DEFAULT_ANON_KEY) && !body.includes("ik_private") && !body.includes("user:secret"));
    assert.equal((await app.request("/api/auth/sign-in", {})).status, 503);
    assert.equal(b.calls.length, 0);
  }
});

test("malformed local configuration never falls back into an official authentication request", async t => {
  const app = await local(t); const originalFetch = global.fetch; const remote = [];
  global.fetch = async (url, options) => {
    if (String(url).startsWith(app.base + "/")) return originalFetch(url, options);
    remote.push(String(url)); throw new Error("unconfigured remote request");
  };
  t.after(() => { global.fetch = originalFetch; });
  for (const raw of ["not-json", "null", "[]", '"incorrect"']) {
    await fs.writeFile(path.join(app.directory, "config.json"), raw);
    const script = await app.request("/api/runtime-config.js"); const context = { window: {} };
    vm.runInNewContext(await script.text(), context);
    assert.equal(context.window.__TOKENTRACKER_RUNTIME_CONFIG__.configurationError, "invalid_local_config");
    assert.equal(context.window.__TOKENTRACKER_RUNTIME_CONFIG__.anonKey, null);
    assert.equal((await app.request("/api/auth/sign-in", {})).status, 503);
    assert.equal(await fs.readFile(path.join(app.directory, "config.json"), "utf8"), raw);
    const history = await app.request("/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-01");
    assert.equal(history.status, 200); assert.equal((await history.json()).totals.total_tokens, 123);
  }
  assert.deepEqual(remote, []);
  assert.equal(fssync.existsSync(path.join(app.directory, "runtime-instance.json")), false);
});

test("an uninitialized queue path never writes runtime markers or upload state on a read", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tt-uninitialized-instance-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const handler = createLocalApiHandler({ queuePath: path.join(directory, "absent-queue.jsonl") });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://localhost")));
  const base = await listen(server); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal((await fetch(base + "/api/runtime-config.js")).status, 200);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("device login uses the persisted custom public key and returns only its own live dashboard", async t => {
  const b = await instance(t, "B"); const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-selfhost-login-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const tracker = path.join(home, ".tokentracker", "tracker"); await fs.mkdir(tracker, { recursive: true });
  await fs.writeFile(path.join(tracker, "config.json"), JSON.stringify({ baseUrl: b.base, anonKey: b.anon, dashboardUrl: b.base }));
  const output = []; const previous = process.stdout.write;
  process.stdout.write = chunk => { output.push(String(chunk)); return true; };
  try { await cmdDeviceLogin([], { home, sleep: async () => {} }); }
  finally { process.stdout.write = previous; }
  const saved = JSON.parse(await fs.readFile(path.join(tracker, "config.json"), "utf8"));
  assert.equal(saved.deviceToken, "device-B"); assert.equal(saved.deviceTokenBaseUrl, b.base);
  assert.ok(output.join("").includes(b.base + "/device")); assert.ok(!output.join("").includes("tokentracker.cc/device"));
  assert.ok(b.calls.every(call => call.headers.apikey === b.anon));
});
