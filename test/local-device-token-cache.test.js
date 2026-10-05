"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { test } = require("node:test");

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-device-cache-http-"));
  const tracker = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(tracker, { recursive: true });
  const saved = Object.fromEntries(["HOME", "USERPROFILE", "TOKENTRACKER_DEVICE_TOKEN", "TOKENTRACKER_INSFORGE_BASE_URL", "TOKENTRACKER_INSFORGE_ANON_KEY"].map((key) => [key, process.env[key]]));
  process.env.HOME = home; process.env.USERPROFILE = home;
  for (const key of Object.keys(saved).filter((key) => key.startsWith("TOKENTRACKER_"))) delete process.env[key];
  let owner = "user-a", mintCount = 0, issueCount = 0, ingestStatus = 200, refreshStatus = 200;
  let holdIssue = null, holdRefresh = null, holdAccount = null, holdIngest = null;
  let strictRefresh = false, validRefreshToken = "user-a-seed";
  const issued = [], ingested = [];
  const backend = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    let payload = {};
    let responseStatus = 200;
    if (req.url.startsWith("/api/auth/refresh")) {
      if (refreshStatus !== 200) {
        res.writeHead(refreshStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication unavailable" }));
        return;
      }
      if (strictRefresh && body.refresh_token !== validRefreshToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Refresh token already consumed" }));
        return;
      }
      mintCount += 1;
      const jwt = `e30.${Buffer.from(JSON.stringify({ sub: owner, exp: Date.now() / 1000 + 3600, nonce: mintCount })).toString("base64url")}.sig`;
      payload = { accessToken: jwt, refreshToken: `${owner}-refresh-${mintCount}`, csrfToken: "fixture-csrf" };
      validRefreshToken = payload.refreshToken;
      if (holdRefresh) await holdRefresh();
    } else if (req.url === "/api/auth/sign-in") {
      owner = body.owner || "user-b";
      payload = { refreshToken: `${owner}-seed`, csrfToken: "fixture-csrf" };
    } else if (req.url === "/functions/tokentracker-device-token-issue") {
      issueCount += 1;
      const sub = JSON.parse(Buffer.from(req.headers.authorization.split(".")[1], "base64url").toString()).sub;
      const token = `fixture-${sub}-${issueCount}`;
      issued.push(token);
      if (holdIssue) responseStatus = (await holdIssue(sub)) || 200;
      payload = responseStatus === 200 ? { token, device_id: "fixture-device", created_at: new Date().toISOString() } : { error: "Unauthorized" };
    } else if (req.url.startsWith("/functions/tokentracker-account-summary")) {
      if (holdAccount) await holdAccount();
      payload = { totals: { total_tokens: 900 } };
    } else if (req.url === "/functions/tokentracker-ingest") {
      ingested.push({ token: req.headers.authorization, anonKey: req.headers.apikey, body });
      responseStatus = holdIngest ? (await holdIngest(req.headers.authorization)) || ingestStatus : ingestStatus;
      payload = responseStatus === 200 ? { inserted: body.hourly.length, skipped: 0 } : { error: responseStatus === 403 ? "Account blocked" : "Unauthorized" };
    }
    res.writeHead(responseStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = `http://127.0.0.1:${backend.address().port}`;
  await fs.writeFile(path.join(tracker, "config.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${backend.address().port}` }));
  await fs.writeFile(path.join(tracker, "relay-cookies.json"), JSON.stringify({ insforge_refresh_token: "insforge_refresh_token=user-a-seed; Path=/; HttpOnly; SameSite=Lax" }));
  await fs.writeFile(path.join(tracker, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  const queue = path.join(tracker, "queue.jsonl");
  const row = { source: "fixture", model: "fixture-model", hour_start: "2026-10-01T00:00:00Z", input_tokens: 40, output_tokens: 0, total_tokens: 40, billable_total_tokens: 40, conversation_count: 1 };
  await fs.writeFile(queue, `${JSON.stringify(row)}\n`);
  const cloudAccount = require("../src/lib/cloud-account");
  cloudAccount.__resetCloudAccountCacheForTests();
  const spawn = childProcess.spawn;
  let spawned = 0;
  childProcess.spawn = (cmd, args, options) => {
    spawned += 1;
    return spawn(cmd, args, { ...options, env: {
      PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot || "", HOME: home, USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_DATA_HOME: path.join(home, ".local", "share"),
      TOKENTRACKER_AUTO_RETRY_NO_SPAWN: "1", TOKENTRACKER_WSL_MODE: "native-only",
      ...(options.env.TOKENTRACKER_DEVICE_TOKEN ? { TOKENTRACKER_DEVICE_TOKEN: options.env.TOKENTRACKER_DEVICE_TOKEN } : {}),
      ...(options.env.TOKENTRACKER_INSFORGE_BASE_URL ? { TOKENTRACKER_INSFORGE_BASE_URL: options.env.TOKENTRACKER_INSFORGE_BASE_URL } : {}),
      ...(options.env.TOKENTRACKER_INSFORGE_ANON_KEY ? { TOKENTRACKER_INSFORGE_ANON_KEY: options.env.TOKENTRACKER_INSFORGE_ANON_KEY } : {}),
      ...(options.env.TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN ? { TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN: options.env.TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN } : {}),
      ...(options.env.TOKENTRACKER_LOCAL_SYNC_ATTEMPT_ID ? { TOKENTRACKER_LOCAL_SYNC_ATTEMPT_ID: options.env.TOKENTRACKER_LOCAL_SYNC_ATTEMPT_ID } : {}),
    } });
  };
  delete require.cache[require.resolve("../src/lib/local-api")];
  const { createLocalApiHandler } = require("../src/lib/local-api");
  let handler = createLocalApiHandler({ queuePath: queue });
  const makeServer = () => http.createServer((req, res) => { handler(req, res, new URL(req.url, "http://localhost")).catch(() => { res.statusCode = 500; res.end(); }); });
  let local = makeServer();
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  let root = `http://127.0.0.1:${local.address().port}`;
  let auth = (await (await fetch(root + "/api/local-auth")).json()).token;
  const restartProxy = async () => {
    local.closeAllConnections();
    await new Promise((resolve) => local.close(resolve));
    cloudAccount.__resetCloudAccountCacheForTests();
    handler = createLocalApiHandler({ queuePath: queue });
    local = makeServer();
    await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
    root = `http://127.0.0.1:${local.address().port}`;
    auth = (await (await fetch(root + "/api/local-auth")).json()).token;
  };
  const post = async (url, body = {}) => {
    const response = await fetch(root + url, { method: "POST", headers: { "Content-Type": "application/json", "x-tokentracker-local-auth": auth }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const native = (extra = {}) => post("/functions/tokentracker-local-sync", { auto: true, background: true, publishAccount: true, ...extra });
  t.after(async () => {
    childProcess.spawn = spawn; cloudAccount.__resetCloudAccountCacheForTests();
    delete require.cache[require.resolve("../src/lib/local-api")];
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    local.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise((resolve) => local.close(resolve)), new Promise((resolve) => backend.close(resolve))]);
    await fs.rm(home, { recursive: true, force: true });
  });
  return { post, native, issued, ingested, queue, tracker, row, get root() { return root; }, restartProxy,
    setIngestStatus: (status) => { ingestStatus = status; },
    setRefreshStatus: (status) => { refreshStatus = status; },
    holdIssue: (callback) => { holdIssue = callback; },
    holdRefresh: (callback) => { holdRefresh = callback; },
    holdAccount: (callback) => { holdAccount = callback; },
    holdIngest: (callback) => { holdIngest = callback; },
    enableStrictRefresh: () => { strictRefresh = true; },
    counts: () => ({ mintCount, issueCount, spawned }),
  };
}

test("real local API and CLI reuse an issued token through refresh rotation and isolate a new owner", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  assert.equal((await x.native()).status, 200);
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 1);
  assert.equal((await x.post("/api/auth/refresh")).status, 200);
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 1, "normal JWT/refresh rotation must not issue another device token");
  assert.equal((await x.post("/api/auth/sign-in", { owner: "user-b" })).status, 200);
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 2);
  assert.notEqual(x.issued[0], x.issued[1]);
});

test("restarting the HTTP proxy reuses a private device token after confirming the signed-in owner", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  const file = path.join(x.tracker, "cloud-device-token.json");
  assert.equal((await x.native({ drain: true })).status, 200);
  const first = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(first.userId, "user-a");
  assert.equal(first.token, x.issued[0]);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await x.restartProxy();
  await fs.appendFile(x.queue, `${JSON.stringify({ ...x.row, hour_start: "2026-10-01T01:00:00Z" })}\n`);
  assert.equal((await x.native({ drain: true })).status, 200);
  assert.equal(x.counts().issueCount, 1, "proxy restart must not create another device credential");
  assert.equal(x.counts().mintCount, 2, "disk reuse still authenticates the current owner");
  assert.equal(x.ingested.length, 2);
  assert.ok(x.ingested.every((request) => request.token === `Bearer ${first.token}`));
  assert.equal((await x.post("/api/auth/logout")).status, 200);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  assert.equal((await x.post("/api/auth/sign-in", { owner: "user-b" })).status, 200);
  assert.equal((await x.native()).status, 200);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).userId, "user-b");
  await x.restartProxy();
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 2, "only the new owner receives a new credential");
});

test("native publication uses the authenticated backend and credentials rather than another CLI account", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  const otherBackendRequests = [];
  const otherBackend = http.createServer((req, res) => {
    otherBackendRequests.push({ path: req.url, token: req.headers.authorization, anonKey: req.headers.apikey });
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ inserted: 1 }));
  });
  await new Promise((resolve) => otherBackend.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    otherBackend.closeAllConnections();
    await new Promise((resolve) => otherBackend.close(resolve));
  });
  process.env.TOKENTRACKER_INSFORGE_ANON_KEY = "fixture-runtime-anon-key";
  const configPath = path.join(x.tracker, "config.json");
  const config = {
    baseUrl: `http://127.0.0.1:${otherBackend.address().port}`,
    anonKey: "different-backend-cli-anon-key",
    deviceToken: "different-owner-cli-token",
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  assert.equal((await x.native({ drain: true })).status, 200);
  assert.equal(x.ingested.length, 1);
  assert.equal(x.ingested[0].token, `Bearer ${x.issued[0]}`);
  assert.equal(x.ingested[0].anonKey, "fixture-runtime-anon-key");
  assert.ok(otherBackendRequests.every((request) => request.path === "/functions/tokentracker-telemetry" && request.token === undefined && request.anonKey === config.anonKey), "only the independent public CLI heartbeat may use its own configured backend");
  const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
  for (const key of ["baseUrl", "anonKey", "deviceToken"]) assert.equal(persisted[key], config[key]);
  const { resolveRuntimeConfig } = require("../src/lib/runtime-config");
  const ordinary = resolveRuntimeConfig({ config, env: { TOKENTRACKER_DEVICE_TOKEN: "environment-token", TOKENTRACKER_INSFORGE_BASE_URL: "https://environment.test", TOKENTRACKER_INSFORGE_ANON_KEY: "environment-key" } });
  for (const key of ["baseUrl", "anonKey", "deviceToken"]) assert.equal(ordinary[key], config[key]);
});

test("native auto drain exposes a fresh 401 and evicts its rejected token, while 403 retains it", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  const file = path.join(x.tracker, "cloud-device-token.json");
  x.setIngestStatus(401);
  const first = await x.native({ drain: true });
  assert.equal(first.status, 401);
  assert.equal(first.body.code, "CLOUD_DEVICE_TOKEN_REJECTED");
  assert.equal(x.counts().issueCount, 1);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  await x.restartProxy();
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 2, "revoked token is replaced once even while upload backoff is active");
  x.setIngestStatus(403);
  const denied = await x.post("/functions/tokentracker-local-sync", { drain: true });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "CLOUD_UPLOAD_FORBIDDEN");
  const token = JSON.parse(await fs.readFile(file, "utf8")).token;
  await x.restartProxy();
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 2, "policy denial must not churn otherwise valid credentials");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).token, token);
});

test("503 upload backoff survives proxy restart without issuing a replacement token", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  x.setIngestStatus(503);
  const first = await x.native({ drain: true });
  assert.equal(first.status, 503);
  const file = path.join(x.tracker, "cloud-device-token.json");
  const token = JSON.parse(await fs.readFile(file, "utf8")).token;
  await x.restartProxy();
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().issueCount, 1);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).token, token);
  assert.equal(x.ingested.length, 1, "backoff suppresses another failed upload");
});

test("an explicit auth 401 clears the persisted credential while auth 503 retains it", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  assert.equal((await x.native()).status, 200);
  const file = path.join(x.tracker, "cloud-device-token.json");
  const token = JSON.parse(await fs.readFile(file, "utf8")).token;
  await x.restartProxy();
  x.setRefreshStatus(503);
  assert.equal((await x.native({ drain: true })).status, 502);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).token, token);
  x.setRefreshStatus(401);
  assert.equal((await x.native({ drain: true })).status, 502);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  assert.equal(x.counts().issueCount, 1);
});

for (const lateRequest of ["issuer", "upload"]) {
  test(`a late account-A ${lateRequest} 401 leaves account-B's persisted token intact`, { timeout: 15_000 }, async (t) => {
    const x = await fixture(t);
    let started, release;
    const seen = new Promise((resolve) => { started = resolve; });
    const pending = new Promise((resolve) => { release = resolve; });
    const hold = async (identity) => {
      if (identity.includes("user-a")) { started(); await pending; return 401; }
      return 200;
    };
    if (lateRequest === "issuer") x.holdIssue(hold); else x.holdIngest(hold);
    const old = x.native({ drain: true });
    await seen;
    assert.equal((await x.post("/api/auth/logout")).status, 200);
    assert.equal((await x.post("/api/auth/sign-in", { owner: "user-b" })).status, 200);
    const next = x.native();
    const file = path.join(x.tracker, "cloud-device-token.json");
    let current;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      current = JSON.parse(await fs.readFile(file, "utf8").catch(() => "null"));
      if (current?.userId === "user-b") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(current.userId, "user-b");
    release();
    const result = await old;
    assert.equal(result.status, lateRequest === "issuer" ? 409 : 401);
    assert.equal((await next).status, 200);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).token, current.token);
    await x.restartProxy();
    assert.equal((await x.native()).status, 200);
    assert.equal(x.counts().issueCount, 2, "late A failure must not force B to reissue");
  });
}

test("logout and account switch cancel an in-flight issuance before spawning the old sync", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  let started, release;
  const seen = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  x.holdIssue(async (owner) => { if (owner === "user-a") { started(); await pending; } });
  const old = x.native();
  await seen;
  assert.equal((await x.post("/api/auth/logout")).status, 200);
  assert.equal((await x.post("/api/auth/sign-in", { owner: "user-b" })).status, 200);
  release();
  const cancelled = await old;
  assert.equal(cancelled.status, 409);
  assert.equal(cancelled.body.code, "auth_session_changed");
  assert.equal(x.counts().spawned, 0);
  assert.equal((await x.native()).status, 200);
  assert.equal(x.counts().spawned, 1);
  assert.ok(x.ingested.every((request) => request.token.includes("user-b")));
});

test("cloud sync off retains local background parsing and rejects an explicit foreground upload", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  assert.equal((await x.native()).status, 200);
  const originalIngests = x.ingested.length;
  await fs.appendFile(x.queue, `${JSON.stringify({ ...x.row, total_tokens: 50, input_tokens: 50, billable_total_tokens: 50 })}\n`);
  assert.equal((await x.post("/functions/tokentracker-cloud-sync-pref", { enabled: false })).status, 200);
  const denied = await x.post("/functions/tokentracker-local-sync", { deviceToken: x.issued[0], drain: true });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, "CLOUD_SYNC_DISABLED");
  assert.equal((await x.native({ deviceToken: x.issued[0] })).status, 200);
  assert.equal(x.ingested.length, originalIngests);
});

for (const mode of ["proxy", "mobile"]) {
  test(`turning cloud sync off preserves a consumed refresh token through ${mode} HTTP refresh`, { timeout: 15_000 }, async (t) => {
    const x = await fixture(t);
    x.enableStrictRefresh();
    let started, release;
    const seen = new Promise((resolve) => { started = resolve; });
    const pending = new Promise((resolve) => { release = resolve; });
    x.holdRefresh(async () => { started(); await pending; });
    const old = mode === "proxy" ? x.post("/api/auth/refresh") : x.native({ drain: true });
    await seen;
    assert.equal((await x.post("/functions/tokentracker-cloud-sync-pref", { enabled: false })).status, 200);
    release();
    const result = await old;
    assert.equal(result.status, mode === "proxy" ? 200 : 409);
    if (mode === "mobile") assert.equal(result.body.code, "CLOUD_SYNC_CHANGED");
    const persisted = JSON.parse(await fs.readFile(path.join(x.tracker, "relay-cookies.json"), "utf8"));
    assert.ok(persisted.insforge_refresh_token.includes("refresh-1"), "same-account rotation must replace the consumed credential");
    assert.ok(persisted.insforge_csrf_token.includes("fixture-csrf"));
    x.holdRefresh(null);
    assert.equal((await x.post("/api/auth/refresh")).status, 200, "the next authentication refresh still succeeds while cloud sync is off");
    assert.equal(x.counts().issueCount, 0);
    assert.equal(x.counts().spawned, 0);
    assert.equal(x.ingested.length, 0);
  });
}

test("cloud sync off suppresses a late account response after preserving its rotation", { timeout: 15_000 }, async (t) => {
  const x = await fixture(t);
  x.enableStrictRefresh();
  let started, release;
  const seen = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  x.holdAccount(async () => { started(); await pending; });
  const old = fetch(x.root + "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-01&account=1");
  await seen;
  assert.equal((await x.post("/functions/tokentracker-cloud-sync-pref", { enabled: false })).status, 200);
  release();
  const response = await old;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-tokentracker-account-view"), "0");
  assert.equal(response.headers.get("x-tokentracker-account-fallback"), "cloud-sync-off");
  assert.equal((await response.json()).totals.total_tokens, 40);
  assert.equal((await x.post("/api/auth/refresh")).status, 200);
  assert.equal(x.counts().issueCount, 0);
  assert.equal(x.ingested.length, 0);
});
