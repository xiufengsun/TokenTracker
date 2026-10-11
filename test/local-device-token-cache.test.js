"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { test } = require("node:test");
const { publicAnonFor, bindPublicInstance } = require("./helpers/public-instance-fixture");

async function fixture(t, fixtureOptions={}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-device-cache-http-"));
  const tracker = path.join(home, "tracker");
  await fs.mkdir(tracker, { recursive: true });
  const saved = Object.fromEntries(["TOKENTRACKER_DEVICE_TOKEN", "TOKENTRACKER_INSFORGE_BASE_URL", "TOKENTRACKER_INSFORGE_ANON_KEY", "TOKENTRACKER_CLOUD_RECHECK"].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(saved).filter((key) => key.startsWith("TOKENTRACKER_"))) delete process.env[key];
  let owner = fixtureOptions.ownerId || "user-a", mintCount = 0, issueCount = 0, ingestStatus = 200, refreshStatus = 200;
  let holdIssue = null, holdRefresh = null, holdAccount = null, holdIngest = null;
  let issueDenial = null, ingestDenial = null;
  let strictRefresh = false, validRefreshToken = `${owner}-seed`;
  const issued = [], ingested = [];
  const publicAnon = publicAnonFor("device-cache");
  const database=fixtureOptions.database;
  const databaseRpc=async(name,args)=>(await database.query(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
  const backend = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (req.headers.apikey !== publicAnon) {
      res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Wrong instance public key" })); return;
    }
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
      payload = responseStatus === 200 ? { token, device_id: "fixture-device", created_at: new Date().toISOString() } : issueDenial || { error: "Unauthorized" };
      if(database && responseStatus===200){
        const result=await databaseRpc('cloud_issue_device_token',[sub,'sandbox',body.device_name,body.platform,body.machine_id,
          [body.device_name],require('node:crypto').randomUUID(),token,false,null]);
        responseStatus=result.ok?200:result.status;
        payload=result.ok?{...result,token}:result;
      }
    } else if (req.url.startsWith("/functions/tokentracker-account-summary")) {
      if (holdAccount) await holdAccount();
      payload = { totals: { total_tokens: 900 } };
    } else if (req.url === "/functions/tokentracker-ingest") {
      ingested.push({ token: req.headers.authorization, anonKey: req.headers.apikey, body });
      responseStatus = holdIngest ? (await holdIngest(req.headers.authorization)) || ingestStatus : ingestStatus;
      payload = responseStatus === 200 ? { inserted: body.hourly.length, skipped: 0 } : ingestDenial || { error: responseStatus === 403 ? "Account blocked" : "Unauthorized" };
      if(database && responseStatus===200){
        const rows=body.hourly.map(row=>({...row,conversations:row.conversations??row.conversation_count??0,
          cached_input_tokens:row.cached_input_tokens??0,cache_creation_input_tokens:row.cache_creation_input_tokens??0,
          reasoning_output_tokens:row.reasoning_output_tokens??0,total_cost_usd:row.total_cost_usd??0}));
        payload=await databaseRpc('cloud_ingest_usage',[req.headers.authorization.replace(/^Bearer /,''),'sandbox',
          JSON.stringify(rows),JSON.stringify(body.account_session_states||[]),body.upload_id||null]);
        responseStatus=payload.ok?200:payload.status;
      }
    }
    res.writeHead(responseStatus, { "Content-Type": "application/json",
      ...(payload.retry_after_seconds ? {"Retry-After":String(payload.retry_after_seconds)} : {}) });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = `http://127.0.0.1:${backend.address().port}`;
  await bindPublicInstance(tracker, process.env.TOKENTRACKER_INSFORGE_BASE_URL, publicAnon);
  await fs.writeFile(path.join(tracker, "relay-cookies.json"), JSON.stringify({ insforge_refresh_token: `insforge_refresh_token=${owner}-seed; Path=/; HttpOnly; SameSite=Lax` }));
  await fs.writeFile(path.join(tracker, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  const queue = path.join(tracker, "queue.jsonl");
  const row = { source: "fixture", model: "fixture-model", hour_start: "2026-10-01T00:00:00Z", input_tokens: 40, output_tokens: 0, total_tokens: 40, billable_total_tokens: 40, conversation_count: 1 };
  await fs.writeFile(queue, `${JSON.stringify(row)}\n`);
  const cloudAccount = require("../src/lib/cloud-account");
  cloudAccount.__resetCloudAccountCacheForTests();
  const spawn = childProcess.spawn;
  let spawned = 0; let lastSpawnEnv;
  childProcess.spawn = (cmd, args, options) => {
    spawned += 1;
    lastSpawnEnv = { ...options.env };
    const childArgs=fixtureOptions.boundedManual && options.env.TOKENTRACKER_CLOUD_RECHECK==='1'
      ? [...args,'--auto','--background','--publish-account'] : args;
    return spawn(cmd, childArgs, { ...options, env: {
      PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot || "",
      APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_DATA_HOME: path.join(home, ".local", "share"),
      TOKENTRACKER_AUTO_RETRY_NO_SPAWN: "1", TOKENTRACKER_WSL_MODE: "native-only",
      ...(options.env.TOKENTRACKER_DEVICE_TOKEN ? { TOKENTRACKER_DEVICE_TOKEN: options.env.TOKENTRACKER_DEVICE_TOKEN } : {}),
      ...(options.env.TOKENTRACKER_INSFORGE_BASE_URL ? { TOKENTRACKER_INSFORGE_BASE_URL: options.env.TOKENTRACKER_INSFORGE_BASE_URL } : {}),
      ...(options.env.TOKENTRACKER_INSFORGE_ANON_KEY ? { TOKENTRACKER_INSFORGE_ANON_KEY: options.env.TOKENTRACKER_INSFORGE_ANON_KEY } : {}),
      TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN: options.env.TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN || "",
      ...(options.env.TOKENTRACKER_CLOUD_RECHECK ? { TOKENTRACKER_CLOUD_RECHECK: options.env.TOKENTRACKER_CLOUD_RECHECK } : {}),
      ...(options.env.TOKENTRACKER_LOCAL_SYNC_ATTEMPT_ID ? { TOKENTRACKER_LOCAL_SYNC_ATTEMPT_ID: options.env.TOKENTRACKER_LOCAL_SYNC_ATTEMPT_ID } : {}),
    } });
  };
  delete require.cache[require.resolve("../src/lib/local-api")];
  const { createLocalApiHandler } = require("../src/lib/local-api");
  let handler = createLocalApiHandler({ queuePath: queue, trackerDataDir: tracker, syncContext: { scanSources: [] } });
  const makeServer = () => http.createServer((req, res) => { handler(req, res, new URL(req.url, "http://localhost")).catch(() => { res.statusCode = 500; res.end(); }); });
  let local = makeServer();
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  let root = `http://127.0.0.1:${local.address().port}`;
  let auth = (await (await fetch(root + "/api/local-auth")).json()).token;
  const restartProxy = async () => {
    local.closeAllConnections();
    await new Promise((resolve) => local.close(resolve));
    cloudAccount.__resetCloudAccountCacheForTests();
    handler = createLocalApiHandler({ queuePath: queue, trackerDataDir: tracker, syncContext: { scanSources: [] } });
    local = makeServer();
    await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
    root = `http://127.0.0.1:${local.address().port}`;
    auth = (await (await fetch(root + "/api/local-auth")).json()).token;
  };
  const post = async (url, body = {}, extraHeaders = {}) => {
    const response = await fetch(root + url, { method: "POST", headers: { "Content-Type": "application/json", "x-tokentracker-local-auth": auth,
      "x-tokentracker-instance": process.env.TOKENTRACKER_INSFORGE_BASE_URL, ...extraHeaders }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const native = (extra = {}) => post("/functions/tokentracker-local-sync", { auto: true, background: true, publishAccount: true, ...extra });
  const independentCli = async config => {
    assert.ok(lastSpawnEnv?.TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN, "the local API must first prove and issue its owner capability");
    const cliTracker = path.join(home, "independent-cli"); await fs.mkdir(cliTracker, { recursive: true });
    const configPath = path.join(cliTracker, "config.json");
    await fs.writeFile(configPath, JSON.stringify(config));
    await fs.writeFile(path.join(cliTracker, "queue.jsonl"), JSON.stringify(row) + "\n");
    const script = `require(${JSON.stringify(path.resolve(__dirname, "../src/commands/sync.js"))}).cmdSync(['--drain'],${JSON.stringify({trackerDataDir:cliTracker,home,scanSources:[]})}).catch(e=>{console.error(e.message);process.exitCode=1;});`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script], { env: { PATH: path.dirname(process.execPath),
        SystemRoot: process.env.SystemRoot || "", APPDATA: path.join(home,"AppData","Roaming"),
        LOCALAPPDATA: path.join(home,"AppData","Local"), XDG_DATA_HOME:path.join(home,".local","share"),
        TOKENTRACKER_NO_TELEMETRY:"1", TOKENTRACKER_WSL_MODE:"native-only", TOKENTRACKER_AUTO_RETRY_NO_SPAWN:"1",
        TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN:lastSpawnEnv.TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN,
        TOKENTRACKER_DEVICE_TOKEN:lastSpawnEnv.TOKENTRACKER_DEVICE_TOKEN,
        TOKENTRACKER_INSFORGE_BASE_URL:lastSpawnEnv.TOKENTRACKER_INSFORGE_BASE_URL,
        TOKENTRACKER_INSFORGE_ANON_KEY:lastSpawnEnv.TOKENTRACKER_INSFORGE_ANON_KEY,
      } });
      let stderr=""; child.stdout.resume(); child.stderr.on("data",chunk=>{stderr+=chunk;});
      child.on("error",reject); child.on("exit",code=>resolve({code,stderr}));
    });
    return {...result,configPath,tracker:cliTracker};
  };
  t.after(async () => {
    childProcess.spawn = spawn; cloudAccount.__resetCloudAccountCacheForTests();
    delete require.cache[require.resolve("../src/lib/local-api")];
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    local.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise((resolve) => local.close(resolve)), new Promise((resolve) => backend.close(resolve))]);
    await fs.rm(home, { recursive: true, force: true });
  });
  return { post, native, independentCli, issued, ingested, queue, tracker, row, publicAnon, get root() { return root; }, restartProxy,
    bridge: (userId = "user-a", expectedOwnerId = userId) => post("/functions/tokentracker-cloud-session", { expectedOwnerId }, { Authorization: `Bearer e30.${Buffer.from(JSON.stringify({ sub: userId, exp: Date.now()/1000+3600 })).toString("base64url")}.sig` }),
    setIngestStatus: (status) => { ingestStatus = status; },
    setIssueDenial: (data) => { issueDenial = data; },
    setIngestDenial: (data) => { ingestDenial = data; },
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
  assert.equal((await x.post("/functions/tokentracker-local-sync", { drain: true })).status, 200);
  const first = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(first.userId, "user-a");
  assert.equal(first.token, x.issued[0]);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await x.restartProxy();
  await fs.appendFile(x.queue, `${JSON.stringify({ ...x.row, hour_start: "2026-10-01T01:00:00Z" })}\n`);
  assert.equal((await x.post("/functions/tokentracker-local-sync", { drain: true })).status, 200);
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
  assert.equal((await x.native({ drain: true })).status, 200);
  x.ingested.length = 0;
  const config = {
    baseUrl: `http://127.0.0.1:${otherBackend.address().port}`,
    anonKey: publicAnonFor("different-cli"),
    deviceToken: "different-owner-cli-token",
    deviceTokenBaseUrl: `http://127.0.0.1:${otherBackend.address().port}`,
  };
  const result = await x.independentCli(config);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(x.ingested.length, 1);
  assert.equal(x.ingested[0].token, `Bearer ${x.issued[0]}`);
  assert.equal(x.ingested[0].anonKey, x.publicAnon);
  assert.deepEqual(otherBackendRequests, [], "an owner-proven capability never sends usage or CLI credentials to B");
  const persisted = JSON.parse(await fs.readFile(result.configPath, "utf8"));
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
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "auth_session_changed");
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


test("a paused-machine issuance keeps login, exposes recovery, and never starts a CLI upload",{timeout:15_000},async t=>{
  const x=await fixture(t);
  x.holdIssue(async()=>403);
  x.setIssueDenial({code:"cloud_machine_paused",error:"cloud_machine_paused",recovery_url:"https://www.tokentracker.cc/cloud"});
  const response=await x.native({drain:true});
  assert.equal(response.status,403);assert.equal(response.body.code,"cloud_machine_paused");
  assert.equal(response.body.recovery_url,"https://www.tokentracker.cc/cloud");
  assert.equal(x.ingested.length,0);
  const cookies=JSON.parse(await fs.readFile(path.join(x.tracker,"relay-cookies.json"),"utf8"));
  assert.ok(cookies.insforge_refresh_token.includes("user-a-refresh"));
});

test("renewal rechecks an authoritative cooldown only after an explicit local user action",{timeout:15_000},async t=>{
  const x=await fixture(t);
  x.setIngestStatus(429);x.setIngestDenial({code:"cloud_sync_throttled",retry_after_seconds:72000});
  const first=await x.native({drain:true});assert.equal(first.status,429);
  const file=path.join(x.tracker,"upload.throttle.json");
  const throttle=JSON.parse(await fs.readFile(file,"utf8"));
  assert.ok(throttle.backoffUntilMs-Date.now()>19*3600_000);
  const calls=x.ingested.length;
  x.setIngestStatus(200);
  const automatic=await x.native({drain:true,recheckCloudAccess:true});
  assert.equal(automatic.status,429);assert.equal(x.ingested.length,calls);
  const resumed=await x.post("/functions/tokentracker-local-sync",{drain:true,recheckCloudAccess:true});
  assert.equal(resumed.status,200);assert.equal(x.ingested.length,calls+1);
  assert.equal(JSON.parse(await fs.readFile(file,"utf8")).backoffUntilMs,0);
});


test("browser upload proves owner once in the local bridge and never accepts an arbitrary device token", { timeout: 15_000 }, async t => {
  const x = await fixture(t);
  const arbitrary = await x.post("/functions/tokentracker-local-sync", { deviceToken: "someone-else-token", drain: true });
  assert.equal(arbitrary.status, 409);
  assert.equal(x.counts().spawned, 0);
  const forgedOwner = await x.bridge("user-a", "user-b");
  assert.equal(forgedOwner.status, 409);
  assert.equal(forgedOwner.body.code, "auth_owner_mismatch");
  assert.equal(x.counts().issueCount, 0);
  const issued = await x.bridge();
  assert.equal(issued.status, 200);
  assert.equal(issued.body.token, undefined, "the browser never receives the device credential");
  const body = { cloudSessionId: issued.body.session_id, expectedOwnerId: "user-a", drain: true };
  assert.equal((await x.post("/functions/tokentracker-local-sync", body)).status, 200);
  assert.equal(x.counts().issueCount, 1, "the upload reuses the owner proof instead of issuing twice");
  assert.equal(x.counts().mintCount, 0, "the browser JWT does not consume a refresh rotation");
  assert.equal(x.ingested[0].token, `Bearer ${x.issued[0]}`);
  assert.equal((await x.post("/functions/tokentracker-local-sync", { ...body, expectedOwnerId: "user-b" })).status, 409);
});

test("logout during browser issuance cannot populate the next owner's private token store", { timeout: 15_000 }, async t => {
  const x = await fixture(t);
  let started, release;
  const seen = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  x.holdIssue(async owner => { if (owner === "user-a") { started(); await pending; } });
  const old = x.bridge();
  await seen;
  await x.post("/api/auth/logout");
  await x.post("/api/auth/sign-in", { owner: "user-b" });
  const next = await x.bridge("user-b");
  assert.equal(next.status, 200);
  release();
  assert.equal((await old).status, 409);
  const file = JSON.parse(await fs.readFile(path.join(x.tracker, "cloud-device-token.json"), "utf8"));
  assert.equal(file.userId, "user-b");
  assert.equal(file.token, x.issued[1]);
  assert.equal(x.counts().spawned, 0);
});

test("a stopped browser upload cannot overwrite a new owner's offset or cooldown", { timeout: 15_000 }, async t => {
  const x = await fixture(t);
  const issued = await x.bridge();
  let started, release;
  const seen = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  x.holdIngest(async token => { if (token.includes("user-a")) { started(); await pending; } });
  const old = x.post("/functions/tokentracker-local-sync", { cloudSessionId: issued.body.session_id, expectedOwnerId: "user-a", drain: true });
  await seen;
  await x.post("/api/auth/logout");
  await x.post("/api/auth/sign-in", { owner: "user-b" });
  const next = await x.bridge("user-b");
  assert.equal(next.status, 200);
  const result = await x.post("/functions/tokentracker-local-sync", { cloudSessionId: next.body.session_id, expectedOwnerId: "user-b", drain: true });
  assert.equal(result.status, 200);
  const stateBefore = await fs.readFile(path.join(x.tracker, "queue.state.json"), "utf8");
  const cooldownBefore = await fs.readFile(path.join(x.tracker, "upload.throttle.json"), "utf8");
  release();
  assert.equal((await old).status, 409);
  assert.equal(await fs.readFile(path.join(x.tracker, "queue.state.json"), "utf8"), stateBefore);
  assert.equal(await fs.readFile(path.join(x.tracker, "upload.throttle.json"), "utf8"), cooldownBefore);
  assert.ok(x.ingested.some(request => request.token.includes("user-b")), "new account receives the retained local queue");
  assert.equal((await x.post("/functions/tokentracker-local-sync", { cloudSessionId: issued.body.session_id, expectedOwnerId: "user-a", drain: true })).status, 409);
  const persisted = JSON.parse(await fs.readFile(path.join(x.tracker, "cloud-device-token.json"), "utf8"));
  assert.equal(persisted.userId, "user-b");
});


test("signed-out local sync cannot fall back to a separately configured CLI account", { timeout: 15_000 }, async t => {
  const x = await fixture(t);
  const config = { baseUrl: process.env.TOKENTRACKER_INSFORGE_BASE_URL, anonKey: x.publicAnon,
    deviceToken: "unrelated-cli-owner-token", deviceTokenBaseUrl: process.env.TOKENTRACKER_INSFORGE_BASE_URL };
  await fs.writeFile(path.join(x.tracker, "config.json"), JSON.stringify(config));
  await x.post("/api/auth/logout");
  const result = await x.post("/functions/tokentracker-local-sync", { drain: true });
  assert.equal(result.status, 200);
  assert.equal(x.ingested.length, 0);
  assert.equal(x.counts().issueCount, 0);
  const saved = JSON.parse(await fs.readFile(path.join(x.tracker, "config.json"), "utf8"));
  assert.equal(saved.deviceToken, config.deviceToken);
  assert.ok(await fs.readFile(x.queue, "utf8"), "local records remain intact");
});

test("native refresh cannot replace the browser mirror with a different relayed account", { timeout: 15_000 }, async t => {
  const x = await fixture(t);
  const binding = await x.bridge("user-b");
  assert.equal(binding.status, 200);
  const result = await x.native({ drain: true });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "auth_owner_mismatch");
  assert.equal(x.ingested.length, 0);
  assert.equal(x.counts().issueCount, 1, "a refresh for A must not issue a second account credential over B");
  const persisted = JSON.parse(await fs.readFile(path.join(x.tracker, "cloud-device-token.json"), "utf8"));
  assert.equal(persisted.userId, "user-b");
});

test("an unbound legacy upload cursor replays once after owner proof and keeps that binding over restart", { timeout: 15_000 }, async t => {
  const x = await fixture(t);
  const size = (await fs.stat(x.queue)).size;
  await fs.writeFile(path.join(x.tracker, "queue.state.json"), JSON.stringify({ offset: size }));
  await fs.writeFile(path.join(x.tracker, "upload.throttle.json"), JSON.stringify({ lastSuccessMs: Date.now(), nextAllowedAtMs: Date.now() + 86400_000 }));
  const issued = await x.bridge();
  assert.equal(issued.status, 200);
  const upload = await x.post("/functions/tokentracker-local-sync", { cloudSessionId: issued.body.session_id, expectedOwnerId: "user-a", drain: true });
  assert.equal(upload.status, 200);
  assert.equal(x.ingested.length, 1);
  assert.equal(x.ingested[0].body.hourly[0].total_tokens, 40);
  await x.restartProxy();
  assert.equal((await x.native()).status, 200);
  assert.equal(x.ingested.length, 1, "the confirmed owner keeps its cursor over a server restart");
});


test("a rejected owner-bound local token cannot fall back to another CLI token during legacy migration", { timeout: 15_000 }, async t => {
  const x = await fixture(t);
  assert.equal((await x.native({drain:true})).status,200); x.ingested.length=0;
  const legacy = { baseUrl: "https://b46ug8xu.us-east.insforge.app", deviceToken: "unrelated-cli-owner-token" };
  x.setIngestStatus(401);
  const result = await x.independentCli(legacy);
  assert.equal(result.code, 1); assert.match(result.stderr,/HTTP 401/);
  const failure=JSON.parse(await fs.readFile(path.join(result.tracker,"upload.throttle.json"),"utf8"));
  assert.equal(failure.lastErrorStatus,401); assert.equal(failure.lastErrorCode,"CLOUD_DEVICE_TOKEN_REJECTED");
  assert.equal(x.ingested.length, 1);
  assert.equal(x.ingested[0].token, `Bearer ${x.issued[0]}`);
  const retained = JSON.parse(await fs.readFile(result.configPath, "utf8"));
  assert.equal(retained.deviceToken, legacy.deviceToken);
  assert.equal(retained.baseUrl, legacy.baseUrl);
});


test("a successful owner-bound upload leaves an unrelated legacy CLI account and migration marker intact", { timeout: 15_000 }, async t => {
  const x = await fixture(t);
  assert.equal((await x.native({drain:true})).status,200); x.ingested.length=0;
  const legacy = { baseUrl: "https://b46ug8xu.us-east.insforge.app", anonKey: publicAnonFor("legacy-cli"), deviceToken: "unrelated-cli-owner-token", user_id: "unrelated-cli-owner" };
  const result = await x.independentCli(legacy);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(x.ingested.length, 1);
  assert.equal(x.ingested[0].token, `Bearer ${x.issued[0]}`);
  const retained = JSON.parse(await fs.readFile(result.configPath, "utf8"));
  for (const key of ["baseUrl", "anonKey", "deviceToken", "user_id"]) assert.equal(retained[key], legacy[key]);
});

test("a zero-batch manual drain leaves the successful cooldown intact and reports no uploaded readiness", { timeout: 15_000 }, async t=>{
  const x=await fixture(t);
  assert.equal((await x.post('/functions/tokentracker-local-sync',{drain:true})).status,200);
  const throttlePath=path.join(x.tracker,'upload.throttle.json');
  const before=await fs.readFile(throttlePath,'utf8');
  const calls=x.ingested.length;
  const result=await x.post('/functions/tokentracker-local-sync',{drain:true,recheckCloudAccess:true});
  assert.equal(result.status,200);assert.equal(result.body.uploaded,false);assert.equal(result.body.pending,false);
  assert.equal(await fs.readFile(throttlePath,'utf8'),before);
  assert.equal(x.ingested.length,calls);
});

test("owner-proven trial recheck can replace a successful community deadline while automatic and cross-account requests cannot", {timeout:20_000},async t=>{
  const {setup,migration}=require('./helpers/cloud-usage-archive-fixture');
  const {randomUUID}=require('node:crypto');
  const pg=await setup();t.after(()=>pg.close());
  await pg.exec(migration('20261003120000_cloud-subscriptions.sql'));
  await pg.exec(migration('20261004120000_cloud-machine-access.sql'));
  await pg.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now() WHERE environment='sandbox'");
  const owner=randomUUID();await pg.query('INSERT INTO auth.users VALUES($1)',[owner]);
  const directSpawn=childProcess.spawn;
  const x=await fixture(t,{database:pg,ownerId:owner,boundedManual:true});
  const first=await x.native({drain:true});assert.equal(first.status,200);
  const throttlePath=path.join(x.tracker,'upload.throttle.json');
  const community=JSON.parse(await fs.readFile(throttlePath,'utf8'));
  assert.equal(community.lastErrorCode,null);assert.equal(community.backoffUntilMs,0);
  assert.ok(community.serverNextAllowedAtMs>Date.now());
  const binding=await x.bridge(owner);assert.equal(binding.status,200);
  // Simulate sixteen elapsed minutes at the actual server. The durable local
  // daily deadline remains unchanged; no artificial error/backoff is inserted.
  await pg.exec("UPDATE tokentracker_cloud_machines SET last_upload_at=now()-interval '16 minutes',upload_window_until=now()-interval '15 minutes'");
  const trial=(await pg.query("SELECT cloud_start_trial($1,'sandbox') membership",[owner])).rows[0].membership;
  assert.equal(trial.status,'trial');assert.equal(trial.can_upload_cloud,true);
  await fs.appendFile(x.queue,JSON.stringify({...x.row,hour_start:'2026-10-01T01:00:00Z',input_tokens:70,total_tokens:70,billable_total_tokens:70})+'\n');
  const calls=x.ingested.length;
  process.env.TOKENTRACKER_CLOUD_RECHECK='1';
  const automatic=await x.native({drain:true,recheckCloudAccess:true});
  assert.equal(automatic.status,429);assert.equal(x.ingested.length,calls);
  assert.equal(JSON.parse(await fs.readFile(throttlePath,'utf8')).serverNextAllowedAtMs,community.serverNextAllowedAtMs);
  const wrong=await x.post('/functions/tokentracker-local-sync',{cloudSessionId:randomUUID(),expectedOwnerId:owner,drain:true,recheckCloudAccess:true});
  assert.equal(wrong.status,409);assert.equal(x.ingested.length,calls);
  const configPath=path.join(x.tracker,'config.json');
  const config=JSON.parse(await fs.readFile(configPath,'utf8'));
  await fs.writeFile(configPath,JSON.stringify({...config,deviceToken:x.issued[0],deviceTokenBaseUrl:config.baseUrl}));
  const script=`require(${JSON.stringify(path.resolve(__dirname,'../src/commands/sync.js'))}).cmdSync(['--auto','--background','--publish-account','--drain'],${JSON.stringify({trackerDataDir:x.tracker,home:path.dirname(x.tracker),scanSources:[]})}).catch(()=>{process.exitCode=1;});`;
  const unproved=await new Promise((resolve,reject)=>{
    const child=directSpawn(process.execPath,['-e',script],{env:{PATH:path.dirname(process.execPath),SystemRoot:process.env.SystemRoot||'',
      TOKENTRACKER_CLOUD_RECHECK:'1',TOKENTRACKER_AUTO_RETRY_NO_SPAWN:'1'}});
    child.stdout.resume();child.stderr.resume();child.on('error',reject);child.on('exit',resolve);
  });
  assert.equal(unproved,1,'a recheck flag without the current-owner capability cannot bypass the deadline');
  assert.equal(x.ingested.length,calls);
  const manual=await x.post('/functions/tokentracker-local-sync',{cloudSessionId:binding.body.session_id,expectedOwnerId:owner,drain:true,recheckCloudAccess:true});
  assert.equal(manual.status,200);assert.equal(manual.body.uploaded,true);assert.equal(x.ingested.length,calls+1);
  const paidCadence=JSON.parse(await fs.readFile(throttlePath,'utf8'));
  assert.ok(paidCadence.serverNextAllowedAtMs-community.lastSuccessMs<16*60_000);
  assert.ok(paidCadence.serverNextAllowedAtMs<community.serverNextAllowedAtMs);
  assert.equal((await pg.query('SELECT count(*)::int n FROM tokentracker_hourly WHERE user_id=$1',[owner])).rows[0].n,2);
  const other=randomUUID();await pg.query('INSERT INTO auth.users VALUES($1)',[other]);
  await x.post('/api/auth/sign-in',{owner:other});
  const late=await x.post('/functions/tokentracker-local-sync',{cloudSessionId:binding.body.session_id,expectedOwnerId:owner,drain:true,recheckCloudAccess:true});
  assert.equal(late.status,409);assert.equal(x.ingested.length,calls+1);
  assert.equal((await pg.query('SELECT count(*)::int n FROM tokentracker_hourly WHERE user_id=$1',[other])).rows[0].n,0);
});


test("an immediate trial probe replaces tomorrow's success deadline with the server's remaining fifteen-minute cooldown", {timeout:20_000},async t=>{
  const {setup,migration}=require('./helpers/cloud-usage-archive-fixture');
  const {randomUUID}=require('node:crypto');
  const pg=await setup();t.after(()=>pg.close());
  await pg.exec(migration('20261003120000_cloud-subscriptions.sql'));
  await pg.exec(migration('20261004120000_cloud-machine-access.sql'));
  await pg.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now() WHERE environment='sandbox'");
  const owner=randomUUID();await pg.query('INSERT INTO auth.users VALUES($1)',[owner]);
  const x=await fixture(t,{database:pg,ownerId:owner,boundedManual:true});
  assert.equal((await x.native({drain:true})).status,200);
  const pathThrottle=path.join(x.tracker,'upload.throttle.json');
  const before=JSON.parse(await fs.readFile(pathThrottle,'utf8'));
  assert.equal(before.lastErrorCode,null);assert.ok(before.nextAllowedAtMs-Date.now()>12*3600_000);
  const binding=await x.bridge(owner);assert.equal(binding.status,200);
  await pg.query("SELECT cloud_start_trial($1,'sandbox')",[owner]);
  await fs.appendFile(x.queue,JSON.stringify({...x.row,hour_start:'2026-10-01T01:00:00Z',input_tokens:70,total_tokens:70,billable_total_tokens:70})+'\n');
  const probe=await x.post('/functions/tokentracker-local-sync',{cloudSessionId:binding.body.session_id,expectedOwnerId:owner,drain:true,recheckCloudAccess:true});
  assert.equal(probe.status,429);assert.equal(probe.body.code,'cloud_sync_throttled');
  const after=JSON.parse(await fs.readFile(pathThrottle,'utf8'));
  assert.ok(after.nextAllowedAtMs-Date.now()>14*60_000);
  assert.ok(after.nextAllowedAtMs-Date.now()<=15*60_000);
  assert.ok(after.nextAllowedAtMs<before.nextAllowedAtMs);
  assert.equal(after.lastSuccessMs,before.lastSuccessMs,'a denied probe is not a successful upload');
  const calls=x.ingested.length;
  assert.equal((await x.native({drain:true})).status,429);assert.equal(x.ingested.length,calls);
  assert.equal((await pg.query('SELECT count(*)::int n FROM tokentracker_hourly WHERE user_id=$1',[owner])).rows[0].n,1);
});
