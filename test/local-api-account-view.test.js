"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");

// The handler reads/writes ~/.tokentracker/tracker/. Redirect HOME to a temp
// dir so these tests never touch the developer's real relay cookies or pref.
let tmpHome;
let prevHome;
let prevUserProfile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-account-view-home-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete require.cache[require.resolve("../src/lib/cloud-account")];
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function freshHandler(queuePath) {
  // Re-require so module-level state (token cache) and the trackerDataDir
  // resolved at construction reflect the temp HOME.
  delete require.cache[require.resolve("../src/lib/local-api")];
  const { createLocalApiHandler } = require("../src/lib/local-api");
  return createLocalApiHandler({ queuePath });
}

function makeReq({ method = "GET", urlObj, headers = {}, body } = {}) {
  const base = Readable.from(body != null ? [Buffer.from(body)] : []);
  base.method = method;
  base.url = urlObj.pathname + urlObj.search;
  base.headers = { host: "localhost", ...headers };
  return base;
}

function makeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200,
    _headers: headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    writeHead(status, hdrs) {
      this.statusCode = status;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
    },
    end(body) {
      if (body) chunks.push(body);
    },
    body() {
      return chunks.join("");
    },
    json() {
      return JSON.parse(chunks.join(""));
    },
  };
}

async function call(handler, opts) {
  const urlObj = new URL(`http://localhost${opts.endpoint}`);
  const req = makeReq({ ...opts, urlObj });
  const res = makeRes();
  const handled = await handler(req, res, urlObj);
  assert.ok(handled, `endpoint must be handled: ${opts.endpoint}`);
  return res;
}

async function startAccountHttpFixture(t, refreshToken = "seed") {
  const http = require("node:http");
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  const cookiePath = path.join(trackerDir, "relay-cookies.json");
  fs.writeFileSync(cookiePath, JSON.stringify({
    insforge_refresh_token: `insforge_refresh_token=${refreshToken}; Path=/; HttpOnly; SameSite=Lax`,
  }));
  const handler = freshHandler(queuePath);
  const server = http.createServer((req, res) => {
    handler(req, res, new URL(req.url, "http://localhost")).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return {
    root: `http://127.0.0.1:${server.address().port}`,
    realFetch,
    cookiePath,
    readCookies: () => JSON.parse(fs.readFileSync(cookiePath, "utf8")),
  };
}

async function startAccountUpstreamFixture(t, reply) {
  const http = require("node:http");
  const realFetch = global.fetch;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    res.setHeader("Content-Type", "application/json");
    await reply(req, res, new URL(req.url, "http://localhost"), rawBody ? JSON.parse(rawBody) : {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  global.fetch = (url, init) => {
    const upstream = new URL(url);
    return realFetch(origin + upstream.pathname + upstream.search, init);
  };
  t.after(() => { global.fetch = realFetch; });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
}

function writeQueue(queuePath, rows) {
  fs.writeFileSync(queuePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const SAMPLE_ROW = {
  source: "claude",
  model: "claude-sonnet-4-6",
  hour_start: "2026-04-20T10:00:00.000Z",
  input_tokens: 100,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 20,
  reasoning_output_tokens: 0,
  total_tokens: 120,
  conversation_count: 1,
};

test("cloud-sync-pref defaults to disabled; account stays unavailable while signed out", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: "/functions/tokentracker-cloud-sync-pref" });
  assert.deepEqual(res.json(), { enabled: false, account_available: false });
});

test("user-status exposes account aggregation state", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: "/functions/tokentracker-user-status" });
  const body = res.json();
  assert.deepEqual(body.account, {
    available: false,
    cloud_sync_enabled: false,
    account_view: false,
  });
});

test("invalid cloud preferences fail closed and saved choices survive restart", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  const prefPath = path.join(trackerDir, "cloud-sync-pref.json");
  for (const [raw, expected] of [
    ["", false], ["{", false], ["null", false], ["{}", false],
    ['{"enabled":"true"}', false], ['{"enabled":false}', false], ['{"enabled":true}', true],
  ]) {
    fs.writeFileSync(prefPath, raw);
    const handler = freshHandler(queuePath);
    const res = await call(handler, { endpoint: "/functions/tokentracker-cloud-sync-pref" });
    assert.equal(res.json().enabled, expected, raw);
    assert.equal(fs.readFileSync(prefPath, "utf8"), raw, "reading must not rewrite saved preferences");
  }
});

test("POST cloud-sync-pref requires local auth, then persists and is reflected", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const handler = freshHandler(queuePath);

  // Without the local-auth token the mutation is rejected.
  const denied = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-cloud-sync-pref",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(denied.statusCode, 401);

  // Fetch the token the dashboard would use.
  const authRes = await call(handler, { endpoint: "/api/local-auth" });
  const { token } = authRes.json();
  assert.ok(token);

  const ok = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-cloud-sync-pref",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ enabled: true }),
  });
  assert.deepEqual(ok.json(), { ok: true, enabled: true });

  // Persisted to disk and reflected by a subsequent GET (new handler instance).
  const prefFile = path.join(tmpHome, ".tokentracker", "tracker", "cloud-sync-pref.json");
  assert.equal(JSON.parse(fs.readFileSync(prefFile, "utf8")).enabled, true);

  const handler2 = freshHandler(queuePath);
  const get2 = await call(handler2, { endpoint: "/functions/tokentracker-cloud-sync-pref" });
  assert.equal(get2.json().enabled, true);

  // A non-boolean payload is rejected (400) and must NOT overwrite the pref.
  const token2 = (await call(handler2, { endpoint: "/api/local-auth" })).json().token;
  const bad = await call(handler2, {
    method: "POST",
    endpoint: "/functions/tokentracker-cloud-sync-pref",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token2 },
    body: JSON.stringify({ enabled: "yes" }),
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(JSON.parse(fs.readFileSync(prefFile, "utf8")).enabled, true, "pref must be unchanged");
});

test("a stale mirror from another dashboard cannot re-enable a newer opt-out", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const handler = freshHandler(queuePath);
  const token = (await call(handler, { endpoint: "/api/local-auth" })).json().token;
  for (const [enabled, changedAtMs, expected] of [[true, 10, true], [false, 20, false], [true, 10, false], [true, 20, false], [true, 21, true]]) {
    const res = await call(handler, {
      method: "POST", endpoint: "/functions/tokentracker-cloud-sync-pref",
      headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
      body: JSON.stringify({ enabled, changedAtMs }),
    });
    assert.equal(res.json().enabled, expected);
  }
  const restarted = await call(freshHandler(queuePath), { endpoint: "/functions/tokentracker-cloud-sync-pref" });
  assert.equal(restarted.json().enabled, true);
});

test("usage-summary?account=1 falls back to local data when not signed in", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  // Enable the pref but provide no relay refresh token → not signed in.
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));

  const handler = freshHandler(queuePath);
  const res = await call(handler, {
    endpoint: "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&tz=UTC&account=1",
  });
  // Local (single-machine) data served, tagged as not-account-view.
  assert.equal(res._headers["x-tokentracker-account-view"], "0");
  const body = res.json();
  assert.equal(body.scope, "all");
  assert.equal(body.totals.total_tokens, 120);
});

test("account-view failures are briefly backed off so refresh fan-out stays responsive", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-failing; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const realFetch = global.fetch;
  let refreshCalls = 0;
  global.fetch = async () => {
    refreshCalls += 1;
    throw new Error("offline");
  };
  try {
    const handler = freshHandler(queuePath);
    const endpoint = "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&account=1";
    const first = await call(handler, { endpoint });
    const second = await call(handler, { endpoint });
    assert.equal(first._headers["x-tokentracker-account-view"], "0");
    assert.equal(second._headers["x-tokentracker-account-view"], "0");
    assert.equal(refreshCalls, 1, "the second refresh should use the failure backoff");
    assert.equal(second.json().totals.total_tokens, 120);
  } finally {
    global.fetch = realFetch;
  }
});

test("concurrent account-view fan-out shares one pending cloud probe", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-concurrent; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const realFetch = global.fetch;
  let refreshCalls = 0;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  global.fetch = async () => {
    refreshCalls += 1;
    started();
    await gate;
    throw new Error("offline");
  };

  try {
    const handler = freshHandler(queuePath);
    const endpoint = "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&account=1";
    const firstPromise = call(handler, { endpoint });
    await startedPromise;
    // Both callers await the same probe and receive the same outage reason.
    const secondPromise = call(handler, { endpoint });
    assert.equal(refreshCalls, 1);
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first._headers["x-tokentracker-account-view"], "0");
    assert.equal(first.json().totals.total_tokens, 120);
    assert.equal(second._headers["x-tokentracker-account-view"], "0");
    assert.equal(second._headers["x-tokentracker-account-fallback"], first._headers["x-tokentracker-account-fallback"]);
    assert.equal(second.json().totals.total_tokens, 120);
  } finally {
    global.fetch = realFetch;
  }
});

test("HTTP account fan-out shares a healthy read while manual refresh supersedes its pending cache", async (t) => {
  const http = require("node:http");
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "relay-cookies.json"), JSON.stringify({
    insforge_refresh_token: "insforge_refresh_token=fanout; Path=/; HttpOnly; SameSite=Lax",
  }));
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  const handler = freshHandler(queuePath);
  let received = 0;
  const waits = new Map();
  const server = http.createServer((req, res) => {
    received += 1;
    waits.get(received)?.();
    handler(req, res, new URL(req.url, "http://localhost")).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const untilReceived = (n) => received >= n ? Promise.resolve() : new Promise((resolve) => waits.set(n, resolve));
  const realFetch = global.fetch;
  let mintCalls = 0;
  let edgeCalls = 0;
  const releases = [];
  const token = `e30.${Buffer.from(JSON.stringify({ sub: "fanout-user", exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
  global.fetch = async (url) => {
    if (String(url).includes("/api/auth/refresh")) {
      mintCalls += 1;
      return { ok: true, json: async () => ({ accessToken: token }) };
    }
    edgeCalls += 1;
    return new Promise((resolve) => releases.push((value) => resolve({ ok: true, json: async () => ({ totals: { total_tokens: value } }) })));
  };
  t.after(() => { global.fetch = realFetch; });
  const root = `http://127.0.0.1:${server.address().port}`;
  const endpoint = "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-02&account=1";
  const reordered = "/functions/tokentracker-usage-summary?account=1&to=2026-10-02&from=2026-10-01";
  const ordinary = [realFetch(root + endpoint), realFetch(root + reordered), realFetch(root + endpoint)];
  await untilReceived(3);
  await new Promise(setImmediate);
  assert.equal(mintCalls, 1);
  assert.equal(edgeCalls, 1);
  // A manual request bypasses the pending ordinary result, but concurrent
  // manual consumers still share their own fresh read.
  const manual = [realFetch(root + endpoint + "&refresh=1"), realFetch(root + reordered + "&refresh=1")];
  await untilReceived(5);
  await new Promise(setImmediate);
  assert.equal(edgeCalls, 2);
  releases[1](456);
  for (const response of await Promise.all(manual)) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-tokentracker-account-view"), "1");
    assert.equal(response.headers.get("x-tokentracker-account-fallback"), null);
    assert.equal((await response.json()).totals.total_tokens, 456);
  }
  releases[0](123);
  for (const response of await Promise.all(ordinary)) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-tokentracker-account-view"), "1");
    assert.equal(response.headers.get("x-tokentracker-account-fallback"), null);
    assert.equal((await response.json()).totals.total_tokens, 123);
  }
  const cached = await realFetch(root + endpoint);
  assert.equal((await cached.json()).totals.total_tokens, 456);
  assert.equal(mintCalls, 1);
  assert.equal(edgeCalls, 2);
});

test("usage-summary?account=1 serves the cross-device aggregate when signed in + cloud sync on", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  // Seed a relayed refresh token (what the auth proxy would have captured).
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  // Mock the network: token refresh, then the account-summary aggregate.
  const accessJwt = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.sig`;
  const accountPayload = {
    from: "2026-04-20",
    to: "2026-04-20",
    scope: "all",
    totals: { total_tokens: 999999, total_cost_usd: "1.50" },
  };
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (urlStr, opts) => {
    seen.push(String(urlStr));
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-summary")) {
      assert.equal(opts.headers.Authorization, `Bearer ${accessJwt}`);
      return { ok: true, status: 200, json: async () => accountPayload };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, {
      endpoint: "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&tz=UTC&account=1",
    });
    assert.equal(res._headers["x-tokentracker-account-view"], "1");
    assert.deepEqual(res.json(), accountPayload);
    assert.ok(seen.some((u) => u.includes("/api/auth/refresh")));
    assert.ok(seen.some((u) => u.includes("/tokentracker-account-summary")));
  } finally {
    global.fetch = realFetch;
  }
});

test("usage-hourly?account=1 serves account hourly data when signed in + cloud sync on", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const accessJwt = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.sig`;
  const accountPayload = {
    day: "2026-04-20",
    data: [
      {
        hour: "2026-04-20T10:00:00",
        total_tokens: 999999,
        conversation_count: 3,
        models: { "claude-sonnet-4-6": 999999 },
      },
    ],
  };
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (urlStr, opts) => {
    seen.push(String(urlStr));
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-hourly")) {
      assert.equal(opts.headers.Authorization, `Bearer ${accessJwt}`);
      return { ok: true, status: 200, json: async () => accountPayload };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, {
      endpoint: "/functions/tokentracker-usage-hourly?day=2026-04-20&tz=UTC&account=1",
    });
    assert.equal(res._headers["x-tokentracker-account-view"], "1");
    assert.deepEqual(res.json(), accountPayload);
    assert.ok(seen.some((u) => u.includes("/tokentracker-account-hourly")));
  } finally {
    global.fetch = realFetch;
  }
});

test("usage-hourly?account=1 falls back to local hourly data when account hourly fails", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const accessJwt = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.sig`;
  const realFetch = global.fetch;
  global.fetch = async (urlStr) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-hourly")) {
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, {
      endpoint: "/functions/tokentracker-usage-hourly?day=2026-04-20&tz=UTC&account=1",
    });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    const body = res.json();
    assert.equal(body.day, "2026-04-20");
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].hour, "2026-04-20T10:00:00");
    assert.equal(body.data[0].total_tokens, 120);
  } finally {
    global.fetch = realFetch;
  }
});

test("usage-hourly?account=1 falls back to local hourly data when account hourly times out", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const accessJwt = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.sig`;

  const prevTimeout = process.env.TOKENTRACKER_HTTP_TIMEOUT_MS;
  process.env.TOKENTRACKER_HTTP_TIMEOUT_MS = "10"; // 超低超时：10ms

  const realFetch = global.fetch;
  global.fetch = async (urlStr, opts) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-hourly")) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          resolve({ ok: true, status: 200, json: async () => ({ day: "2026-04-20", data: [] }) });
        }, 10000);
        if (opts && opts.signal) {
          opts.signal.addEventListener("abort", () => {
            clearTimeout(t);
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, {
      endpoint: "/functions/tokentracker-usage-hourly?day=2026-04-20&tz=UTC&account=1",
    });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    const body = res.json();
    assert.equal(body.day, "2026-04-20");
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].hour, "2026-04-20T10:00:00");
    assert.equal(body.data[0].total_tokens, 120);
  } finally {
    global.fetch = realFetch;
    if (prevTimeout === undefined) {
      delete process.env.TOKENTRACKER_HTTP_TIMEOUT_MS;
    } else {
      process.env.TOKENTRACKER_HTTP_TIMEOUT_MS = prevTimeout;
    }
  }
});

// --- Fallback classification -------------------------------------------------
//
// The popover keeps its last account (cross-device) snapshot when a cloud read
// fails transiently, but must switch to this-machine data when the user signs
// out or turns cloud sync off. That is only possible if the local server says
// WHICH of the two happened.

function seedSignedInTracker() {
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );
  return trackerDir;
}

function freshAccessJwt() {
  return `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.sig`;
}

const HEATMAP_ENDPOINT = "/functions/tokentracker-usage-heatmap?weeks=52&tz=UTC&account=1";

test("account fallback is tagged 'signed-out' when there is no relayed session", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));

  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
  assert.equal(res._headers["x-tokentracker-account-view"], "0");
  assert.equal(res._headers["x-tokentracker-account-fallback"], "signed-out");
});

test("account fallback is tagged 'cloud-sync-off' when the pref is disabled", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = seedSignedInTracker();
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: false }));

  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
  assert.equal(res._headers["x-tokentracker-account-view"], "0");
  assert.equal(res._headers["x-tokentracker-account-fallback"], "cloud-sync-off");
});

test("a failing account read is tagged transient, not as a local view", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const accessJwt = freshAccessJwt();
  const realFetch = global.fetch;
  global.fetch = async (urlStr) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-heatmap")) {
      return { ok: false, status: 502, json: async () => ({ error: "bad gateway" }) };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };
  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    assert.equal(res._headers["x-tokentracker-account-fallback"], "transient-upstream");
  } finally {
    global.fetch = realFetch;
  }
});

test("an account read that times out is tagged transient-timeout", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const accessJwt = freshAccessJwt();
  const prevTimeout = process.env.TOKENTRACKER_HTTP_TIMEOUT_MS;
  process.env.TOKENTRACKER_HTTP_TIMEOUT_MS = "10";

  const realFetch = global.fetch;
  global.fetch = async (urlStr, opts) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-heatmap")) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({}) }), 10000);
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };
  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    assert.equal(res._headers["x-tokentracker-account-fallback"], "transient-timeout");
  } finally {
    global.fetch = realFetch;
    if (prevTimeout === undefined) delete process.env.TOKENTRACKER_HTTP_TIMEOUT_MS;
    else process.env.TOKENTRACKER_HTTP_TIMEOUT_MS = prevTimeout;
  }
});

test("a rejected token refresh is tagged transient-auth, not signed-out", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const realFetch = global.fetch;
  global.fetch = async (urlStr) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: false, status: 401, json: async () => ({ error: "token consumed" }) };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };
  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    assert.equal(
      res._headers["x-tokentracker-account-fallback"],
      "transient-auth",
      "A rejected refresh must never look like the user signing out.",
    );
  } finally {
    global.fetch = realFetch;
  }
});

test("an offline account read is tagged transient-network", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const realFetch = global.fetch;
  global.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
    assert.equal(res._headers["x-tokentracker-account-view"], "0");
    assert.equal(res._headers["x-tokentracker-account-fallback"], "transient-network");
  } finally {
    global.fetch = realFetch;
  }
});

test("a successful account read carries no fallback header", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const accessJwt = freshAccessJwt();
  const payload = { weeks: [], active_days: 3 };
  const realFetch = global.fetch;
  global.fetch = async (urlStr) => {
    if (String(urlStr).includes("/api/auth/refresh")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: accessJwt }) };
    }
    if (String(urlStr).includes("/tokentracker-account-heatmap")) {
      return { ok: true, status: 200, json: async () => payload };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };
  try {
    const handler = freshHandler(queuePath);
    const res = await call(handler, { endpoint: HEATMAP_ENDPOINT });
    assert.equal(res._headers["x-tokentracker-account-view"], "1");
    assert.equal(res._headers["x-tokentracker-account-fallback"], undefined);
    assert.deepEqual(res.json(), payload);
  } finally {
    global.fetch = realFetch;
  }
});

test("one popover refresh mints ONE access token across concurrent account reads", async () => {
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  seedSignedInTracker();

  const accessJwt = freshAccessJwt();
  let refreshCalls = 0;
  const realFetch = global.fetch;
  global.fetch = async (urlStr) => {
    const u = String(urlStr);
    if (u.includes("/api/auth/refresh")) {
      refreshCalls += 1;
      // Rotate on every call: a second refresh with the same (already consumed)
      // token is exactly what used to fail intermittently.
      if (refreshCalls > 1) return { ok: false, status: 401, json: async () => ({ error: "consumed" }) };
      await new Promise((r) => setTimeout(r, 5));
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: accessJwt, refreshToken: "rotated-1" }),
      };
    }
    if (u.includes("/tokentracker-account-")) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };
  try {
    const handler = freshHandler(queuePath);
    const endpoints = [
      HEATMAP_ENDPOINT,
      "/functions/tokentracker-usage-daily?from=2026-04-20&to=2026-04-20&tz=UTC&account=1",
      "/functions/tokentracker-usage-monthly?from=2026-04-01&to=2026-04-30&tz=UTC&account=1",
      "/functions/tokentracker-usage-model-breakdown?from=2026-04-20&to=2026-04-20&tz=UTC&account=1",
    ];
    const results = await Promise.all(endpoints.map((endpoint) => call(handler, { endpoint })));
    assert.equal(refreshCalls, 1, "concurrent account reads must share one token refresh");
    for (const res of results) {
      assert.equal(res._headers["x-tokentracker-account-view"], "1");
    }
  } finally {
    global.fetch = realFetch;
  }
});

test("loopback account reads invalidate on successful-upload state, reset, and explicit refresh", async (t) => {
  const http = require("node:http");
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(path.join(trackerDir, "relay-cookies.json"), JSON.stringify({
    insforge_refresh_token: "insforge_refresh_token=upload-test; Path=/; HttpOnly; SameSite=Lax",
  }));
  const statePath = path.join(tmpHome, "queue.state.json");
  fs.writeFileSync(statePath, JSON.stringify({ offset: 100, updatedAt: "first" }));
  const handler = freshHandler(queuePath);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    handler(req, res, url).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const realFetch = global.fetch;
  let edgeCalls = 0;
  let holdNextRead;
  const token = `e30.${Buffer.from(JSON.stringify({ sub: "upload-user", exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
  global.fetch = async (url) => {
    if (String(url).includes("/api/auth/refresh")) return { ok: true, json: async () => ({ accessToken: token }) };
    const value = ++edgeCalls;
    if (holdNextRead) {
      const hold = holdNextRead;
      holdNextRead = null;
      hold.started();
      await hold.gate;
    }
    return { ok: true, json: async () => ({ totals: { total_tokens: value } }) };
  };
  t.after(() => { global.fetch = realFetch; });
  const root = `http://127.0.0.1:${server.address().port}`;
  const endpoint = "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-02&account=1";
  const read = async (suffix = "") => {
    const response = await realFetch(root + endpoint + suffix);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-tokentracker-account-view"), "1");
    return (await response.json()).totals.total_tokens;
  };
  assert.equal(await read(), 1);
  assert.equal(await read(), 1);
  fs.writeFileSync(statePath, JSON.stringify({ offset: 200, updatedAt: "second" }));
  assert.equal(await read(), 2);
  assert.equal(await read(), 2);
  // A rewritten queue can finish a successful upload at the same byte offset.
  fs.writeFileSync(statePath, JSON.stringify({ offset: 200, updatedAt: "rewrite" }));
  assert.equal(await read(), 3);
  fs.writeFileSync(statePath, JSON.stringify({ offset: 0, updatedAt: "reset" }));
  assert.equal(await read(), 4);
  fs.unlinkSync(statePath);
  assert.equal(await read(), 5);
  assert.equal(await read(), 5);
  assert.equal(await read("&refresh=1"), 6);
  assert.equal(await read(), 6);
  assert.equal(edgeCalls, 6);
  let started;
  const seen = new Promise((resolve) => { started = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  holdNextRead = { started, gate };
  fs.writeFileSync(statePath, JSON.stringify({ offset: 300, updatedAt: "before-pending" }));
  const beforeUpload = read();
  await seen;
  fs.writeFileSync(statePath, JSON.stringify({ offset: 400, updatedAt: "during-pending" }));
  assert.equal(await read(), 8, "the completed upload must start a new read rather than join the older flight");
  release();
  assert.equal(await beforeUpload, 7);
  assert.equal(await read(), 8, "the older response cannot repopulate the upload-invalidated cache");
  assert.equal(edgeCalls, 8);
});

test("logout and account switch during an HTTP account read cannot restore the old relay token", async (t) => {
  const http = require("node:http");
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  const cookiePath = path.join(trackerDir, "relay-cookies.json");
  fs.writeFileSync(cookiePath, JSON.stringify({ insforge_refresh_token: "insforge_refresh_token=a; Path=/; HttpOnly; SameSite=Lax" }));
  const handler = freshHandler(queuePath);
  let readsArrived = 0;
  let bothArrived;
  const bothReadsArrived = new Promise((resolve) => { bothArrived = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith("tokentracker-usage-summary") && ++readsArrived === 2) bothArrived();
    handler(req, res, url).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const root = `http://127.0.0.1:${server.address().port}`;
  const realFetch = global.fetch;
  const jwt = (sub) => `e30.${Buffer.from(JSON.stringify({ sub, exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
  const tokenA = jwt("user-a");
  const tokenB = jwt("user-b");
  let started;
  const seenA = new Promise((resolve) => { started = resolve; });
  let release;
  const responseA = new Promise((resolve) => { release = resolve; });
  global.fetch = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/auth/logout") return new Response("{}", { headers: { "content-type": "application/json" } });
    if (pathname === "/api/auth/sign-in") return new Response(JSON.stringify({ refreshToken: "b", csrfToken: "csrf-b" }), { headers: { "content-type": "application/json" } });
    if (pathname === "/api/auth/refresh") {
      const account = JSON.parse(init.body).refresh_token;
      const isA = account === "a" || account === "rotated-a";
      return { ok: true, json: async () => ({ accessToken: isA ? tokenA : tokenB, refreshToken: isA ? "rotated-a" : "rotated-b" }) };
    }
    if (init.headers.Authorization === `Bearer ${tokenA}`) {
      started();
      return responseA;
    }
    return { ok: true, json: async () => ({ totals: { total_tokens: 987 } }) };
  };
  t.after(() => { global.fetch = realFetch; });
  const endpoint = "/functions/tokentracker-usage-summary?from=2026-04-20&to=2026-04-20&account=1";
  const oldRead = realFetch(root + endpoint);
  await seenA;
  const oldReadTwin = realFetch(root + endpoint);
  await bothReadsArrived;
  await new Promise(setImmediate);
  assert.equal((await realFetch(root + "/api/auth/logout", { method: "POST" })).status, 200);
  assert.equal(fs.existsSync(cookiePath), false);
  assert.equal((await realFetch(root + "/api/auth/sign-in", { method: "POST" })).status, 200);
  const newRead = await realFetch(root + endpoint);
  assert.equal(newRead.headers.get("x-tokentracker-account-view"), "1");
  assert.equal((await newRead.json()).totals.total_tokens, 987);
  release({ ok: true, json: async () => ({ totals: { total_tokens: 12345 } }) });
  for (const oldResponse of await Promise.all([oldRead, oldReadTwin])) {
    assert.equal(oldResponse.status, 409);
    assert.equal(oldResponse.headers.get("x-tokentracker-account-view"), null);
    assert.deepEqual(await oldResponse.json(), { error: "Account session changed", code: "auth_session_changed" });
  }
  const persisted = JSON.parse(fs.readFileSync(cookiePath, "utf8"));
  assert.ok(persisted.insforge_refresh_token.includes("rotated-b"));
  assert.ok(!persisted.insforge_refresh_token.includes("rotated-a"));
});

test("a late HTTP auth refresh cannot overwrite a new login's relay cookies", async (t) => {
  const http = require("node:http");
  const queuePath = path.join(tmpHome, "queue.jsonl");
  writeQueue(queuePath, [SAMPLE_ROW]);
  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  const cookiePath = path.join(trackerDir, "relay-cookies.json");
  fs.writeFileSync(cookiePath, JSON.stringify({ insforge_refresh_token: "insforge_refresh_token=a; Path=/; HttpOnly; SameSite=Lax" }));
  const handler = freshHandler(queuePath);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    handler(req, res, url).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const root = `http://127.0.0.1:${server.address().port}`;
  const realFetch = global.fetch;
  let started;
  const seenRefresh = new Promise((resolve) => { started = resolve; });
  let release;
  const responseA = new Promise((resolve) => { release = resolve; });
  global.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/auth/refresh") { started(); return responseA; }
    return new Response(JSON.stringify(pathname === "/api/auth/sign-in" ? { refreshToken: "b", csrfToken: "csrf-b" } : {}), { headers: { "content-type": "application/json" } });
  };
  t.after(() => { global.fetch = realFetch; });
  const oldRefresh = realFetch(root + "/api/auth/refresh", { method: "POST" });
  await seenRefresh;
  assert.equal((await realFetch(root + "/api/auth/logout", { method: "POST" })).status, 200);
  assert.equal((await realFetch(root + "/api/auth/sign-in", { method: "POST" })).status, 200);
  release(new Response(JSON.stringify({ refreshToken: "rotated-a", csrfToken: "csrf-a" }), {
    headers: { "content-type": "application/json", "set-cookie": "insforge_refresh_token=rotated-a; Path=/; HttpOnly" },
  }));
  const response = await oldRefresh;
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), { error: "Account session changed", code: "auth_session_changed" });
  const persisted = JSON.parse(fs.readFileSync(cookiePath, "utf8"));
  assert.ok(persisted.insforge_refresh_token.startsWith("insforge_refresh_token=b;"));
  assert.ok(!persisted.insforge_refresh_token.includes("rotated-a"));
});

test("different HTTP account queries reuse the rotated session while the first cloud GET is pending", async (t) => {
  const { root, realFetch, readCookies } = await startAccountHttpFixture(t);
  let refreshCalls = 0;
  let edgeCalls = 0;
  let started;
  const firstEdgeStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const firstEdge = new Promise((resolve) => { release = resolve; });
  const token = `e30.${Buffer.from(JSON.stringify({ sub: "early-persist-user", exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
  global.fetch = async (url, init) => {
    if (String(url).includes("/api/auth/refresh")) {
      refreshCalls += 1;
      assert.equal(JSON.parse(init.body).refresh_token, "seed");
      if (refreshCalls > 1) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ accessToken: token, refreshToken: "rotated", csrfToken: "fresh-csrf" }));
    }
    const value = ++edgeCalls;
    if (value === 1) { started(); await firstEdge; }
    return new Response(JSON.stringify({ totals: { total_tokens: value } }));
  };
  const path = "/functions/tokentracker-usage-summary?account=1&from=";
  const first = realFetch(root + path + "2026-10-01&to=2026-10-01");
  await firstEdgeStarted;
  assert.ok(readCookies().insforge_refresh_token.startsWith("insforge_refresh_token=rotated;"));
  assert.ok(Object.values(readCookies()).some((cookie) => cookie.includes("fresh-csrf")));
  const second = await realFetch(root + path + "2026-10-02&to=2026-10-02");
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-tokentracker-account-view"), "1");
  assert.equal((await second.json()).totals.total_tokens, 2);
  assert.equal(refreshCalls, 1, "the second query must not refresh the already-consumed seed");
  assert.equal(edgeCalls, 2);
  release();
  const response = await first;
  assert.equal(response.headers.get("x-tokentracker-account-view"), "1");
  assert.equal((await response.json()).totals.total_tokens, 1);
});

test("a failed HTTP account GET preserves its rotated session for the next read", async (t) => {
  const { root, realFetch, readCookies } = await startAccountHttpFixture(t);
  let refreshCalls = 0;
  let edgeCalls = 0;
  const token = `e30.${Buffer.from(JSON.stringify({ sub: "failed-edge-user", exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
  global.fetch = async (url) => {
    if (String(url).includes("/api/auth/refresh")) {
      refreshCalls += 1;
      if (refreshCalls > 1) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ accessToken: token, refreshToken: "rotated", csrfToken: "fresh-csrf" }));
    }
    edgeCalls += 1;
    return edgeCalls === 1 ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify({ totals: { total_tokens: 789 } }));
  };
  const path = "/functions/tokentracker-usage-summary?account=1&from=2026-10-01&to=2026-10-01";
  const failure = await realFetch(root + path);
  assert.equal(failure.status, 200);
  assert.equal(failure.headers.get("x-tokentracker-account-view"), "0");
  assert.equal(failure.headers.get("x-tokentracker-account-fallback"), "transient-upstream");
  assert.ok(readCookies().insforge_refresh_token.startsWith("insforge_refresh_token=rotated;"));
  assert.ok(Object.values(readCookies()).some((cookie) => cookie.includes("fresh-csrf")));
  const retry = await realFetch(root + path + "&refresh=1");
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get("x-tokentracker-account-view"), "1");
  assert.equal((await retry.json()).totals.total_tokens, 789);
  assert.equal(refreshCalls, 1);
  assert.equal(edgeCalls, 2);
});

test("an HTTP account mint completing after logout and login cannot persist the old rotation", async (t) => {
  const { root, realFetch, readCookies, cookiePath } = await startAccountHttpFixture(t, "a");
  let started;
  const mintStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const mintA = new Promise((resolve) => { release = resolve; });
  let edgeACalls = 0;
  const jwt = (sub) => `e30.${Buffer.from(JSON.stringify({ sub, exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
  const tokenA = jwt("old-mint-a");
  const tokenB = jwt("new-login-b");
  global.fetch = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/auth/logout") return new Response("{}");
    if (pathname === "/api/auth/sign-in") return new Response(JSON.stringify({ refreshToken: "b", csrfToken: "csrf-b" }), {
      headers: { "Content-Type": "application/json" },
    });
    if (pathname === "/api/auth/refresh") {
      if (JSON.parse(init.body).refresh_token === "a") { started(); return mintA; }
      return new Response(JSON.stringify({ accessToken: tokenB, refreshToken: "rotated-b", csrfToken: "fresh-csrf-b" }));
    }
    if (init.headers.Authorization === `Bearer ${tokenA}`) edgeACalls += 1;
    return new Response(JSON.stringify({ totals: { total_tokens: 987 } }));
  };
  const path = "/functions/tokentracker-usage-summary?account=1&from=2026-10-01&to=2026-10-01";
  const old = realFetch(root + path);
  await mintStarted;
  assert.equal((await realFetch(root + "/api/auth/logout", { method: "POST" })).status, 200);
  assert.equal(fs.existsSync(cookiePath), false);
  assert.equal((await realFetch(root + "/api/auth/sign-in", { method: "POST" })).status, 200);
  const newer = await realFetch(root + path);
  assert.equal(newer.headers.get("x-tokentracker-account-view"), "1");
  assert.equal((await newer.json()).totals.total_tokens, 987);
  release(new Response(JSON.stringify({ accessToken: tokenA, refreshToken: "rotated-a", csrfToken: "fresh-csrf-a" })));
  const rejected = await old;
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: "Account session changed", code: "auth_session_changed" });
  assert.equal(edgeACalls, 0);
  const saved = readCookies();
  assert.ok(saved.insforge_refresh_token.startsWith("insforge_refresh_token=rotated-b;"));
  assert.ok(Object.values(saved).some((cookie) => cookie.includes("fresh-csrf-b")));
  assert.ok(!JSON.stringify(saved).includes("rotated-a"));
  assert.ok(!JSON.stringify(saved).includes("fresh-csrf-a"));
});

test("closing cloud sync during an HTTP account mint keeps the rotation but publishes local data", async (t) => {
  const { root, realFetch, readCookies } = await startAccountHttpFixture(t);
  let started;
  const mintStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const mint = new Promise((resolve) => { release = resolve; });
  let edgeCalls = 0;
  let refreshCalls = 0;
  const token = `e30.${Buffer.from(JSON.stringify({ sub: "cloud-off-user", exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
  global.fetch = async (url) => {
    if (String(url).includes("/api/auth/refresh")) { refreshCalls += 1; started(); return mint; }
    edgeCalls += 1;
    return new Response(JSON.stringify({ totals: { total_tokens: 987654 } }));
  };
  const path = "/functions/tokentracker-usage-summary?account=1&from=2026-10-01&to=2026-10-01";
  const pending = realFetch(root + path);
  await mintStarted;
  const localAuth = await (await realFetch(root + "/api/local-auth")).json();
  const off = await realFetch(root + "/functions/tokentracker-cloud-sync-pref", {
    method: "POST", headers: { "Content-Type": "application/json", "X-TokenTracker-Local-Auth": localAuth.token },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(off.status, 200);
  release(new Response(JSON.stringify({ accessToken: token, refreshToken: "rotated", csrfToken: "fresh-csrf" })));
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-tokentracker-account-view"), "0");
  assert.equal(response.headers.get("x-tokentracker-account-fallback"), "cloud-sync-off");
  assert.notEqual((await response.json()).totals.total_tokens, 987654);
  assert.ok(readCookies().insforge_refresh_token.startsWith("insforge_refresh_token=rotated;"));
  assert.ok(Object.values(readCookies()).some((cookie) => cookie.includes("fresh-csrf")));
  assert.equal(refreshCalls, 1);
  assert.equal(edgeCalls, 1);
  const stillOff = await realFetch(root + path);
  assert.equal(stillOff.headers.get("x-tokentracker-account-view"), "0");
  assert.equal(refreshCalls, 1);
  assert.equal(edgeCalls, 1);
});

for (const oldStatus of [401, 503]) {
  test(`a late real HTTP ${oldStatus} for account A cannot invalidate account B's pending read`, async (t) => {
    const { root, realFetch, readCookies } = await startAccountHttpFixture(t, "a");
    const jwt = (sub) => `e30.${Buffer.from(JSON.stringify({ sub, exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
    const tokenA = jwt("late-rejection-a");
    const tokenB = jwt("pending-success-b");
    let startedA;
    const seenA = new Promise((resolve) => { startedA = resolve; });
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    let startedB;
    const seenB = new Promise((resolve) => { startedB = resolve; });
    let releaseB;
    const gateB = new Promise((resolve) => { releaseB = resolve; });
    await startAccountUpstreamFixture(t, async (req, res, url, body) => {
      if (url.pathname === "/api/auth/logout") { res.end("{}"); return; }
      if (url.pathname === "/api/auth/sign-in") {
        res.end(JSON.stringify({ refreshToken: "b", csrfToken: "csrf-b" }));
        return;
      }
      if (url.pathname === "/api/auth/refresh") {
        const isA = body.refresh_token === "a";
        res.end(JSON.stringify({ accessToken: isA ? tokenA : tokenB, refreshToken: isA ? "rotated-a" : "rotated-b" }));
        return;
      }
      if (req.headers.authorization === `Bearer ${tokenA}`) {
        startedA();
        await gateA;
        res.statusCode = oldStatus;
        res.end("{}");
        return;
      }
      assert.equal(req.headers.authorization, `Bearer ${tokenB}`);
      startedB();
      await gateB;
      res.end(JSON.stringify({ totals: { total_tokens: 987 } }));
    });
    const path = "/functions/tokentracker-usage-summary?account=1&from=2026-10-01&to=2026-10-01";
    const old = realFetch(root + path);
    await seenA;
    assert.equal((await realFetch(root + "/api/auth/logout", { method: "POST" })).status, 200);
    assert.equal((await realFetch(root + "/api/auth/sign-in", { method: "POST" })).status, 200);
    const newer = realFetch(root + path);
    await seenB;
    releaseA();
    const oldResponse = await old;
    releaseB();
    const success = await newer;
    assert.equal(oldResponse.status, 409);
    assert.notEqual(oldResponse.headers.get("x-tokentracker-account-view"), "1");
    assert.deepEqual(await oldResponse.json(), { error: "Account session changed", code: "auth_session_changed" });
    assert.equal(success.status, 200);
    assert.equal(success.headers.get("x-tokentracker-account-view"), "1");
    assert.equal((await success.json()).totals.total_tokens, 987);
    assert.ok(readCookies().insforge_refresh_token.startsWith("insforge_refresh_token=rotated-b;"));
  });
}

test("a real HTTP 503 completing after cloud sync is disabled remains a permanent cloud-off fallback", async (t) => {
  const { root, realFetch, readCookies } = await startAccountHttpFixture(t);
  const token = `e30.${Buffer.from(JSON.stringify({ sub: "cloud-off-late-error", exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
  let edgeCalls = 0;
  let refreshCalls = 0;
  let started;
  const edgeStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const edge = new Promise((resolve) => { release = resolve; });
  await startAccountUpstreamFixture(t, async (req, res, url) => {
    if (url.pathname === "/api/auth/refresh") {
      refreshCalls += 1;
      res.end(JSON.stringify({ accessToken: token, refreshToken: "rotated", csrfToken: "fresh-csrf" }));
      return;
    }
    edgeCalls += 1;
    started();
    await edge;
    res.statusCode = 503;
    res.end("{}");
  });
  const path = "/functions/tokentracker-usage-summary?account=1&from=2026-10-01&to=2026-10-01";
  const pending = realFetch(root + path);
  await edgeStarted;
  const localAuth = await (await realFetch(root + "/api/local-auth")).json();
  const off = await realFetch(root + "/functions/tokentracker-cloud-sync-pref", {
    method: "POST", headers: { "Content-Type": "application/json", "X-TokenTracker-Local-Auth": localAuth.token },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(off.status, 200);
  release();
  for (const response of [await pending, ...await Promise.all([0, 1, 2].map(() => realFetch(root + path)))]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-tokentracker-account-view"), "0");
    assert.equal(response.headers.get("x-tokentracker-account-fallback"), "cloud-sync-off");
  }
  assert.equal(refreshCalls, 1);
  assert.equal(edgeCalls, 1, "subsequent reads must not retry a cloud source disabled by the user");
  assert.ok(readCookies().insforge_refresh_token.startsWith("insforge_refresh_token=rotated;"));
  assert.ok(Object.values(readCookies()).some((cookie) => cookie.includes("fresh-csrf")));
});

for (const status of [401, 403]) {
  test(`a current-session real HTTP ${status} keeps the transient authentication fallback`, async (t) => {
    const { root, realFetch } = await startAccountHttpFixture(t);
    const token = `e30.${Buffer.from(JSON.stringify({ sub: "current-auth-error", exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
    await startAccountUpstreamFixture(t, async (req, res, url) => {
      if (url.pathname === "/api/auth/refresh") {
        res.end(JSON.stringify({ accessToken: token }));
        return;
      }
      res.statusCode = status;
      res.end("{}");
    });
    const response = await realFetch(root + "/functions/tokentracker-usage-summary?account=1&from=2026-10-01&to=2026-10-01");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-tokentracker-account-view"), "0");
    assert.equal(response.headers.get("x-tokentracker-account-fallback"), "transient-auth");
  });
}

test("a late real HTTP account GET cannot replace a newer same-account RT and CSRF rotation", async (t) => {
  const { root, realFetch, readCookies } = await startAccountHttpFixture(t);
  let refreshCalls = 0;
  let edgeCalls = 0;
  let started;
  const firstEdgeStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const firstEdge = new Promise((resolve) => { release = resolve; });
  const jwt = (seconds) => `e30.${Buffer.from(JSON.stringify({ sub: "same-account-rotation", exp: Date.now() / 1000 + seconds })).toString("base64url")}.sig`;
  await startAccountUpstreamFixture(t, async (req, res, url, body) => {
    if (url.pathname === "/api/auth/refresh") {
      refreshCalls += 1;
      assert.equal(body.refresh_token, refreshCalls === 1 ? "seed" : "rotated-1");
      res.end(JSON.stringify({
        accessToken: jwt(refreshCalls === 1 ? 30 : 3600),
        refreshToken: `rotated-${refreshCalls}`, csrfToken: `fresh-csrf-${refreshCalls}`,
      }));
      return;
    }
    const value = ++edgeCalls;
    if (value === 1) { started(); await firstEdge; }
    res.end(JSON.stringify({ totals: { total_tokens: value } }));
  });
  const path = "/functions/tokentracker-usage-summary?account=1&from=";
  const first = realFetch(root + path + "2026-10-01&to=2026-10-01");
  await firstEdgeStarted;
  assert.ok(readCookies().insforge_refresh_token.startsWith("insforge_refresh_token=rotated-1;"));
  // The first JWT is valid but inside the normal 60s refresh skew. A second
  // query therefore rotates again while the first cloud GET is still pending.
  const second = await realFetch(root + path + "2026-10-02&to=2026-10-02");
  assert.equal(second.headers.get("x-tokentracker-account-view"), "1");
  assert.equal((await second.json()).totals.total_tokens, 2);
  const afterSecond = readCookies();
  assert.ok(afterSecond.insforge_refresh_token.startsWith("insforge_refresh_token=rotated-2;"));
  assert.ok(Object.values(afterSecond).some((cookie) => cookie.includes("fresh-csrf-2")));
  release();
  const late = await first;
  assert.equal(late.headers.get("x-tokentracker-account-view"), "1");
  assert.equal((await late.json()).totals.total_tokens, 1);
  assert.deepEqual(readCookies(), afterSecond, "the first GET must not restore rotated-1/fresh-csrf-1");
  assert.equal(refreshCalls, 2);
  assert.equal(edgeCalls, 2);
});
