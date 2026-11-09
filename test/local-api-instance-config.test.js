"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");

let tmpHome;
let prevHome;
let prevUserProfile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-instance-config-home-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
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

async function authToken(handler) {
  const authRes = await call(handler, { endpoint: "/api/local-auth" });
  return authRes.json().token;
}

function configPath() {
  return path.join(tmpHome, ".tokentracker", "tracker", "config.json");
}

function setupQueue() {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  fs.writeFileSync(configPath(), JSON.stringify({ machineId: "machine-abcdef12", telemetry: true }));
  return queuePath;
}

const SELF_HOSTED_URL = "https://insforge.self.example.com";
const ANON_KEY = `anon_${"a".repeat(40)}`;

test("GET instance-config reports the official cloud by default", async () => {
  const queuePath = setupQueue();
  const handler = freshHandler(queuePath);
  const res = await call(handler, { endpoint: "/functions/tokentracker-instance-config" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.custom, false);
  assert.equal(body.baseUrl, body.officialUrl);
  assert.equal(body.configurationError, null);
  assert.ok(body.anonKeySet === true || body.anonKeySet === false);
});

test("POST instance-config requires local auth", async () => {
  const queuePath = setupQueue();
  const handler = freshHandler(queuePath);
  const denied = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-instance-config",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: SELF_HOSTED_URL, anonKey: ANON_KEY }),
  });
  assert.equal(denied.statusCode, 401);
});

test("POST instance-config rejects bad URLs and missing or unsafe keys", async () => {
  const queuePath = setupQueue();
  const handler = freshHandler(queuePath);
  const token = await authToken(handler);
  const post = (payload) =>
    call(handler, {
      method: "POST",
      endpoint: "/functions/tokentracker-instance-config",
      headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
      body: JSON.stringify(payload),
    });

  const badUrl = await post({ baseUrl: "ftp://example.com", anonKey: ANON_KEY });
  assert.equal(badUrl.statusCode, 400);
  assert.equal(badUrl.json().error, "invalid_instance_url");

  const credentialsInUrl = await post({ baseUrl: "https://user:pass@example.com", anonKey: ANON_KEY });
  assert.equal(credentialsInUrl.statusCode, 400);
  assert.equal(credentialsInUrl.json().error, "invalid_instance_url");

  const missingKey = await post({ baseUrl: SELF_HOSTED_URL });
  assert.equal(missingKey.statusCode, 400);
  assert.equal(missingKey.json().error, "instance_anon_key_required");

  const officialKey = await post({
    baseUrl: SELF_HOSTED_URL,
    anonKey: require("../src/lib/runtime-config").DEFAULT_ANON_KEY,
  });
  assert.equal(officialKey.statusCode, 400);
  assert.equal(officialKey.json().error, "invalid_instance_anon_key");

  const adminKey = await post({ baseUrl: SELF_HOSTED_URL, anonKey: "ik_full_access_key" });
  assert.equal(adminKey.statusCode, 400);
  assert.equal(adminKey.json().error, "invalid_instance_anon_key");
});

test("POST instance-config persists a self-hosted instance and GET reflects it", async () => {
  const queuePath = setupQueue();
  const handler = freshHandler(queuePath);
  const token = await authToken(handler);

  const saved = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-instance-config",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ baseUrl: SELF_HOSTED_URL, anonKey: ANON_KEY }),
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json();
  assert.equal(body.ok, true);
  assert.equal(body.custom, true);
  assert.equal(body.baseUrl, SELF_HOSTED_URL);
  assert.equal(body.dashboardUrl, SELF_HOSTED_URL);

  const persisted = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
  assert.equal(persisted.baseUrl, SELF_HOSTED_URL);
  assert.equal(persisted.anonKey, ANON_KEY);
  assert.equal(persisted.machineId, "machine-abcdef12");

  const after = await call(handler, { endpoint: "/functions/tokentracker-instance-config" });
  assert.equal(after.json().custom, true);
  assert.equal(after.json().baseUrl, SELF_HOSTED_URL);
});

test("POST instance-config accepts plain-http loopback deployments", async () => {
  const queuePath = setupQueue();
  const handler = freshHandler(queuePath);
  const token = await authToken(handler);
  const saved = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-instance-config",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ baseUrl: "http://127.0.0.1:8787", anonKey: ANON_KEY }),
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().baseUrl, "http://127.0.0.1:8787");
});

test("POST instance-config restores the official cloud by persisting the official selection", async () => {
  const queuePath = setupQueue();
  const handler = freshHandler(queuePath);
  const token = await authToken(handler);
  const post = (payload) =>
    call(handler, {
      method: "POST",
      endpoint: "/functions/tokentracker-instance-config",
      headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
      body: JSON.stringify(payload),
    });

  await post({ baseUrl: SELF_HOSTED_URL, anonKey: ANON_KEY });

  const restored = await post({
    baseUrl: "https://srctyff5.us-east.insforge.app",
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().ok, true);
  assert.equal(restored.json().custom, false);

  // The official selection is persisted explicitly (not merely un-set), so a
  // custom TOKENTRACKER_INSFORGE_BASE_URL in the environment cannot quietly
  // become active again after the UI reports a successful restore.
  const persisted = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
  assert.equal(persisted.baseUrl, "https://srctyff5.us-east.insforge.app");
  assert.equal(typeof persisted.anonKey, "string");
  assert.ok(persisted.anonKey.length > 0);
  assert.equal("dashboardUrl" in persisted, false);
});

test("restoring the official cloud overrides a custom environment base URL", async () => {
  const queuePath = setupQueue();
  const handler = freshHandler(queuePath);
  const token = await authToken(handler);
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = SELF_HOSTED_URL;
  try {
    const restored = await call(handler, {
      method: "POST",
      endpoint: "/functions/tokentracker-instance-config",
      headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
      body: JSON.stringify({ baseUrl: "https://srctyff5.us-east.insforge.app" }),
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().custom, false);
    assert.equal(restored.json().baseUrl, "https://srctyff5.us-east.insforge.app");
  } finally {
    delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  }
test("POST instance-test requires auth and a valid URL", async () => {
  const queuePath = setupQueue();
  const handler = freshHandler(queuePath);
  const denied = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-instance-test",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: SELF_HOSTED_URL }),
  });
  assert.equal(denied.statusCode, 401);
  const token = await authToken(handler);
  const bad = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-instance-test",
    headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
    body: JSON.stringify({ baseUrl: "not-a-url" }),
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "invalid_instance_url");
});
test("POST instance-test reports reachability without insisting on a 2xx", async () => {
  const queuePath = setupQueue();
  const handler = freshHandler(queuePath);
  const token = await authToken(handler);
  const probe = (baseUrl) =>
    call(handler, {
      method: "POST",
      endpoint: "/functions/tokentracker-instance-test",
      headers: { "content-type": "application/json", "x-tokentracker-local-auth": token },
      body: JSON.stringify({ baseUrl }),
    });
  const reachable = await probe("https://srctyff5.us-east.insforge.app");
  assert.equal(reachable.statusCode, 200);
  const body = reachable.json();
  assert.equal(body.ok, true);
  assert.equal(body.reachable, true);
  assert.equal(typeof body.status, "number");
  // .invalid TLD cannot resolve: any HTTP answer counts as reachable, so this
  // must come back reachable=false rather than throwing.
  const unreachable = await probe("https://instance.unreachable.invalid");
  assert.equal(unreachable.statusCode, 200);
  const down = unreachable.json();
  assert.equal(down.ok, true);
  assert.equal(down.reachable, false);
  assert.equal(typeof down.error, "string");
});
