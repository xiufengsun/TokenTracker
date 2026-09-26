const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DEFAULT_BASE_URL } = require("../src/lib/runtime-config");

function createRequest({ method = "GET", headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;

  process.nextTick(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });

  return req;
}

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
    },
  };
}

async function getLocalAuthToken(handler) {
  const req = createRequest({ method: "GET" });
  const res = createResponse();
  const handled = await handler(req, res, new URL("http://127.0.0.1/api/local-auth"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  const body = JSON.parse(res.body.toString("utf8"));
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 0);
  return body.token;
}

function loadLocalApiWithSpawn(fakeSpawn) {
  const childProcess = require("node:child_process");
  const cloudAccount = require("../src/lib/cloud-account");
  const originalSpawn = childProcess.spawn;
  cloudAccount.__resetCloudAccountCacheForTests();
  childProcess.spawn = fakeSpawn;
  delete require.cache[require.resolve("../src/lib/local-api")];
  const mod = require("../src/lib/local-api");
  return {
    mod,
    restore() {
      childProcess.spawn = originalSpawn;
      cloudAccount.__resetCloudAccountCacheForTests();
      delete require.cache[require.resolve("../src/lib/local-api")];
    },
  };
}

test("local device metadata exposes the system name separately from machine identity", () => {
  const { getSystemDeviceName } = require("../src/lib/local-api");
  const expected = os.hostname().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128) || null;
  assert.equal(getSystemDeviceName(), expected);
  assert.doesNotMatch(getSystemDeviceName() || "", /^Token Tracker .*#/u);
});

function createSuccessfulSpawn(calls) {
  return (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", "sync ok");
      child.emit("close", 0);
    });
    return child;
  };
}

function createBusySpawn(calls) {
  return (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stderr.emit(
        "data",
        "Error: SYNC_BUSY: another sync is still running; no refresh was performed\n",
      );
      child.emit("close", 1);
    });
    return child;
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRelayedLoginFixture(prefix, { cloudSyncEnabled = true, includeRefreshToken = true } = {}) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: cloudSyncEnabled }));
  fs.writeFileSync(path.join(trackerDir, "config.json"), JSON.stringify({ machineId: "machine-abcdef12" }));
  if (includeRefreshToken) {
    fs.writeFileSync(
      path.join(trackerDir, "relay-cookies.json"),
      JSON.stringify({
        insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
      }),
    );
  }

  return {
    trackerDir,
    restore() {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
      else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

test("local sync rejects arbitrary insforgeBaseUrl overrides", async () => {
  const calls = [];
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://allowed.example";
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        deviceToken: "device-token",
        insforgeBaseUrl: "https://evil.example",
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), {
      ok: false,
      error: "Unsupported insforgeBaseUrl override",
    });
    assert.equal(calls.length, 0);
  } finally {
    restore();
    if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
  }
});

test("local sync preserves the SYNC_BUSY failure code", async () => {
  const calls = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-local-sync-busy-"));
  const { mod, restore } = loadLocalApiWithSpawn(createBusySpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(tempDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ drain: true, deviceToken: "device-token" }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body.toString("utf8"));
    assert.equal(body.ok, false);
    assert.equal(body.code, "SYNC_BUSY");
    assert.match(body.error, /no refresh was performed/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local sync accepts the configured insforgeBaseUrl override", async () => {
  const calls = [];
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://allowed.example";

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        deviceToken: "device-token",
        insforgeBaseUrl: "https://allowed.example/",
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].options.env.TOKENTRACKER_INSFORGE_BASE_URL,
      "https://allowed.example",
    );
  } finally {
    restore();
    if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
  }
});

test("local sync drain request runs sync with --drain", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        deviceToken: "device-token",
        drain: true,
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-3), [path.join(process.cwd(), "bin/tracker.js"), "sync", "--drain"]);
  } finally {
    restore();
  }
});

test("local sync auto background request runs sync with --auto --background", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        deviceToken: "device-token",
        auto: true,
        background: true,
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-4), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
    ]);
  } finally {
    restore();
  }
});

test("local sync all-local background request forwards the source expansion flag", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        deviceToken: "device-token",
        auto: true,
        background: true,
        allLocalSources: true,
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-5), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
      "--all-local-sources",
    ]);
  } finally {
    restore();
  }
});

test("local sync lightweight alias forwards background mode", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        deviceToken: "device-token",
        auto: true,
        lightweight: true,
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-4), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
    ]);
  } finally {
    restore();
  }
});

test("local sync combines background scan with drain priority", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        deviceToken: "device-token",
        drain: true,
        auto: true,
        background: true,
        lightweight: true,
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-5), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
      "--drain",
    ]);
  } finally {
    restore();
  }
});

test("local sync only treats boolean true as background or lightweight", async () => {
  const cases = [
    { background: false },
    { background: "true" },
    { background: 1 },
    { lightweight: false },
    { lightweight: "true" },
    { lightweight: 1 },
  ];

  for (const body of cases) {
    const calls = [];
    const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

    try {
      const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
      const localAuthToken = await getLocalAuthToken(handler);
      const req = createRequest({
        method: "POST",
        headers: { "x-tokentracker-local-auth": localAuthToken },
        body: JSON.stringify({
          deviceToken: "device-token",
          auto: true,
          ...body,
        }),
      });
      const res = createResponse();

      const handled = await handler(
        req,
        res,
        new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
      );

      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(-4), [
        path.join(process.cwd(), "bin/tracker.js"),
        "sync",
        "--auto",
        "--wait-for-lock",
      ]);
    } finally {
      restore();
    }
  }
});

test("local sync only treats boolean true as drain", async () => {
  const cases = [
    {},
    { drain: false },
    { drain: "true" },
    { drain: 1 },
  ];

  for (const body of cases) {
    const calls = [];
    const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

    try {
      const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
      const localAuthToken = await getLocalAuthToken(handler);
      const req = createRequest({
        method: "POST",
        headers: { "x-tokentracker-local-auth": localAuthToken },
        body: JSON.stringify({
          deviceToken: "device-token",
          ...body,
        }),
      });
      const res = createResponse();

      const handled = await handler(
        req,
        res,
        new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
      );

      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(-3), [
        path.join(process.cwd(), "bin/tracker.js"),
        "sync",
        "--wait-for-lock",
      ]);
    } finally {
      restore();
    }
  }
});

test("local sync non-drain request mints a device token from relayed login when none is provided", async () => {
  const calls = [];
  const fixture = createRelayedLoginFixture("tt-local-sync-auto-");
  const prevFetch = global.fetch;

  const fetchCalls = [];
  global.fetch = async (urlStr, opts = {}) => {
    fetchCalls.push({ url: String(urlStr), opts });
    if (String(urlStr) === "https://cloud.example/api/auth/refresh?client_type=mobile") {
      return { ok: true, status: 200, json: async () => ({ accessToken: "access-token" }) };
    }
    if (String(urlStr) === "https://cloud.example/functions/tokentracker-device-token-issue") {
      assert.equal(opts.headers.Authorization, "Bearer access-token");
      const body = JSON.parse(String(opts.body || "{}"));
      assert.equal(body.machine_id, "machine-abcdef12");
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "issued-device-token", device_id: "device-id" }),
      };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({}),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-3), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--wait-for-lock",
    ]);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token");
    assert.ok(fetchCalls.some((c) => c.url.endsWith("/api/auth/refresh?client_type=mobile")));
    assert.ok(fetchCalls.some((c) => c.url.endsWith("/functions/tokentracker-device-token-issue")));
  } finally {
    restore();
    global.fetch = prevFetch;
    fixture.restore();
  }
});

test("local sync reuses relayed device token cache across repeated requests", async () => {
  const calls = [];
  const fixture = createRelayedLoginFixture("tt-local-sync-auto-cache-");
  const prevFetch = global.fetch;
  const fetchCalls = [];

  global.fetch = async (urlStr, opts) => {
    fetchCalls.push({ url: String(urlStr), opts });
    if (String(urlStr) === "https://cloud.example/api/auth/refresh?client_type=mobile") {
      assert.equal(JSON.parse(String(opts.body || "{}")).refresh_token, "refresh-xyz");
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: "access-token", refreshToken: "refresh-rotated" }),
      };
    }
    if (String(urlStr) === "https://cloud.example/functions/tokentracker-device-token-issue") {
      assert.equal(opts.headers.Authorization, "Bearer access-token");
      const body = JSON.parse(String(opts.body || "{}"));
      assert.equal(body.machine_id, "machine-abcdef12");
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "issued-device-token", device_id: "device-id" }),
      };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);

    for (let i = 0; i < 2; i += 1) {
      const req = createRequest({
        method: "POST",
        headers: { "x-tokentracker-local-auth": localAuthToken },
        body: JSON.stringify({}),
      });
      const res = createResponse();
      const handled = await handler(
        req,
        res,
        new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
      );
      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
    }

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token");
    assert.equal(calls[1].options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token");
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/api/auth/refresh?client_type=mobile")).length, 1);
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/functions/tokentracker-device-token-issue")).length, 1);
  } finally {
    restore();
    global.fetch = prevFetch;
    fixture.restore();
  }
});

test("local sync reuses relayed device token cache without refresh rotation", async () => {
  const calls = [];
  const fixture = createRelayedLoginFixture("tt-local-sync-auto-cache-stable-");
  const prevFetch = global.fetch;
  const fetchCalls = [];

  global.fetch = async (urlStr, opts) => {
    fetchCalls.push({ url: String(urlStr), opts });
    if (String(urlStr) === "https://cloud.example/api/auth/refresh?client_type=mobile") {
      assert.equal(JSON.parse(String(opts.body || "{}")).refresh_token, "refresh-xyz");
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: "access-token" }),
      };
    }
    if (String(urlStr) === "https://cloud.example/functions/tokentracker-device-token-issue") {
      assert.equal(opts.headers.Authorization, "Bearer access-token");
      const body = JSON.parse(String(opts.body || "{}"));
      assert.equal(body.machine_id, "machine-abcdef12");
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "issued-device-token", device_id: "device-id" }),
      };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);

    for (let i = 0; i < 2; i += 1) {
      const req = createRequest({
        method: "POST",
        headers: { "x-tokentracker-local-auth": localAuthToken },
        body: JSON.stringify({}),
      });
      const res = createResponse();
      const handled = await handler(
        req,
        res,
        new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
      );
      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
    }

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token");
    assert.equal(calls[1].options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token");
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/api/auth/refresh?client_type=mobile")).length, 1);
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/functions/tokentracker-device-token-issue")).length, 1);
  } finally {
    restore();
    global.fetch = prevFetch;
    fixture.restore();
  }
});

test("local sync dedupes concurrent relayed device token minting", async () => {
  const calls = [];
  const fixture = createRelayedLoginFixture("tt-local-sync-auto-cache-inflight-");
  const prevFetch = global.fetch;
  const fetchCalls = [];
  const issueStarted = createDeferred();
  const issueGate = createDeferred();

  global.fetch = async (urlStr, opts) => {
    fetchCalls.push({ url: String(urlStr), opts });
    if (String(urlStr) === "https://cloud.example/api/auth/refresh?client_type=mobile") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: "access-token" }),
      };
    }
    if (String(urlStr) === "https://cloud.example/functions/tokentracker-device-token-issue") {
      issueStarted.resolve();
      await issueGate.promise;
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "issued-device-token", device_id: "device-id" }),
      };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);

    const firstReq = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({}),
    });
    const firstRes = createResponse();
    const firstSync = handler(firstReq, firstRes, new URL("http://127.0.0.1/functions/tokentracker-local-sync"));
    await issueStarted.promise;

    const secondReq = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({}),
    });
    const secondRes = createResponse();
    const secondSync = handler(secondReq, secondRes, new URL("http://127.0.0.1/functions/tokentracker-local-sync"));
    await new Promise((resolve) => setImmediate(resolve));
    issueGate.resolve();

    assert.equal(await firstSync, true);
    assert.equal(await secondSync, true);
    assert.equal(firstRes.statusCode, 200);
    assert.equal(secondRes.statusCode, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token");
    assert.equal(calls[1].options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token");
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/api/auth/refresh?client_type=mobile")).length, 1);
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/functions/tokentracker-device-token-issue")).length, 1);
  } finally {
    restore();
    global.fetch = prevFetch;
    fixture.restore();
  }
});

test("local sync scopes relayed device token cache by InsForge base URL", async () => {
  const calls = [];
  const fixture = createRelayedLoginFixture("tt-local-sync-auto-cache-base-url-");
  const prevFetch = global.fetch;
  const fetchCalls = [];
  const defaultRoot = DEFAULT_BASE_URL.replace(/\/$/, "");
  const tokensByRoot = new Map([
    ["https://cloud.example", "cloud-device-token"],
    [defaultRoot, "default-device-token"],
  ]);

  global.fetch = async (urlStr, opts) => {
    const url = String(urlStr);
    fetchCalls.push({ url, opts });
    if (url === "https://cloud.example/api/auth/refresh?client_type=mobile") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: "cloud-access-token" }),
      };
    }
    if (url === `${defaultRoot}/api/auth/refresh?client_type=mobile`) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: "default-access-token" }),
      };
    }
    if (url.endsWith("/functions/tokentracker-device-token-issue")) {
      const root = url.slice(0, -"/functions/tokentracker-device-token-issue".length);
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: tokensByRoot.get(root), device_id: "device-id" }),
      };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);

    const firstReq = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({}),
    });
    const firstRes = createResponse();
    assert.equal(
      await handler(firstReq, firstRes, new URL("http://127.0.0.1/functions/tokentracker-local-sync")),
      true,
    );
    assert.equal(firstRes.statusCode, 200);

    const secondReq = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ insforgeBaseUrl: DEFAULT_BASE_URL }),
    });
    const secondRes = createResponse();
    assert.equal(
      await handler(secondReq, secondRes, new URL("http://127.0.0.1/functions/tokentracker-local-sync")),
      true,
    );
    assert.equal(secondRes.statusCode, 200);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, "cloud-device-token");
    assert.equal(calls[1].options.env.TOKENTRACKER_DEVICE_TOKEN, "default-device-token");
    assert.equal(calls[1].options.env.TOKENTRACKER_INSFORGE_BASE_URL, defaultRoot);
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/api/auth/refresh?client_type=mobile")).length, 2);
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/functions/tokentracker-device-token-issue")).length, 2);
  } finally {
    restore();
    global.fetch = prevFetch;
    fixture.restore();
  }
});

test("local sync remints relayed device token after active refresh token changes", async () => {
  const calls = [];
  const fixture = createRelayedLoginFixture("tt-local-sync-auto-cache-split-");
  const prevFetch = global.fetch;
  const fetchCalls = [];
  const issueTokens = ["issued-device-token-1", "issued-device-token-2"];

  function jsonProxyResponse(data) {
    const body = Buffer.from(JSON.stringify(data));
    return {
      ok: true,
      status: 200,
      headers: {
        entries: () => [["content-type", "application/json"]],
        get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null),
      },
      arrayBuffer: async () => body,
    };
  }

  global.fetch = async (urlStr, opts) => {
    const parsedBody = JSON.parse(String(opts.body || "{}"));
    fetchCalls.push({ url: String(urlStr), body: parsedBody });
    if (String(urlStr) === "https://cloud.example/api/auth/refresh?client_type=mobile") {
      if (parsedBody.refresh_token === "refresh-xyz" && opts.credentials === "include") {
        return jsonProxyResponse({ accessToken: "proxy-access-token", refreshToken: "refresh-new" });
      }
      const suffix = parsedBody.refresh_token === "refresh-new" ? "2" : "1";
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: `access-token-${suffix}` }),
      };
    }
    if (String(urlStr) === "https://cloud.example/functions/tokentracker-device-token-issue") {
      const token = issueTokens.shift();
      assert.ok(token, "unexpected extra device-token issue request");
      assert.match(opts.headers.Authorization, /^Bearer access-token-[12]$/);
      const body = JSON.parse(String(opts.body || "{}"));
      assert.equal(body.machine_id, "machine-abcdef12");
      return {
        ok: true,
        status: 200,
        json: async () => ({ token, device_id: "device-id" }),
      };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);

    const firstSyncReq = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({}),
    });
    const firstSyncRes = createResponse();
    assert.equal(
      await handler(firstSyncReq, firstSyncRes, new URL("http://127.0.0.1/functions/tokentracker-local-sync")),
      true,
    );
    assert.equal(firstSyncRes.statusCode, 200);

    const refreshReq = createRequest({ method: "POST" });
    refreshReq[Symbol.asyncIterator] = async function* () {};
    const refreshRes = createResponse();
    assert.equal(
      await handler(refreshReq, refreshRes, new URL("http://127.0.0.1/api/auth/refresh")),
      true,
    );
    assert.equal(refreshRes.statusCode, 200, refreshRes.body.toString("utf8"));

    const secondSyncReq = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({}),
    });
    const secondSyncRes = createResponse();
    assert.equal(
      await handler(secondSyncReq, secondSyncRes, new URL("http://127.0.0.1/functions/tokentracker-local-sync")),
      true,
    );
    assert.equal(secondSyncRes.statusCode, 200);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token-1");
    assert.equal(calls[1].options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token-2");
    assert.deepEqual(
      fetchCalls.filter((c) => c.url.endsWith("/api/auth/refresh?client_type=mobile")).map((c) => c.body.refresh_token),
      ["refresh-xyz", "refresh-xyz", "refresh-new"],
    );
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/functions/tokentracker-device-token-issue")).length, 2);
    assert.equal(issueTokens.length, 0);
  } finally {
    restore();
    global.fetch = prevFetch;
    fixture.restore();
  }
});

test("local sync non-drain request keeps explicit device token without relayed minting", async () => {
  const calls = [];
  const fixture = createRelayedLoginFixture("tt-local-sync-explicit-token-");
  const prevFetch = global.fetch;

  global.fetch = async (urlStr) => {
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ deviceToken: "explicit-device-token" }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-3), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--wait-for-lock",
    ]);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, "explicit-device-token");
  } finally {
    restore();
    global.fetch = prevFetch;
    fixture.restore();
  }
});

test("local sync non-drain request falls back to local sync when relayed device token cannot be issued", async () => {
  const calls = [];
  const fixture = createRelayedLoginFixture("tt-local-sync-auto-fail-");
  const prevFetch = global.fetch;

  global.fetch = async (urlStr) => {
    if (String(urlStr) === "https://cloud.example/api/auth/refresh?client_type=mobile") {
      return { ok: true, status: 200, json: async () => ({ accessToken: "access-token" }) };
    }
    if (String(urlStr) === "https://cloud.example/functions/tokentracker-device-token-issue") {
      return { ok: false, status: 502, json: async () => ({ error: "upstream unavailable" }) };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({}),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-2), [path.join(process.cwd(), "bin/tracker.js"), "sync"]);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, undefined);
  } finally {
    restore();
    global.fetch = prevFetch;
    fixture.restore();
  }
});

test("local sync non-drain request skips relayed minting when cloud sync is disabled", async () => {
  const calls = [];
  const fixture = createRelayedLoginFixture("tt-local-sync-cloud-off-", { cloudSyncEnabled: false });
  const prevFetch = global.fetch;

  global.fetch = async (urlStr) => {
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({}),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-2), [path.join(process.cwd(), "bin/tracker.js"), "sync"]);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, undefined);
  } finally {
    restore();
    global.fetch = prevFetch;
    fixture.restore();
  }
});

test("local sync non-drain request skips relayed minting when refresh token is absent", async () => {
  const calls = [];
  const fixture = createRelayedLoginFixture("tt-local-sync-no-refresh-", { includeRefreshToken: false });
  const prevFetch = global.fetch;

  global.fetch = async (urlStr) => {
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({}),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-2), [path.join(process.cwd(), "bin/tracker.js"), "sync"]);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, undefined);
  } finally {
    restore();
    global.fetch = prevFetch;
    fixture.restore();
  }
});

test("local sync drain request mints a device token from relayed login when none is provided", async () => {
  const calls = [];
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-local-sync-drain-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  const prevFetch = global.fetch;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(path.join(trackerDir, "config.json"), JSON.stringify({ machineId: "machine-abcdef12" }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const fetchCalls = [];
  global.fetch = async (urlStr, opts = {}) => {
    fetchCalls.push({ url: String(urlStr), opts });
    if (String(urlStr) === "https://cloud.example/api/auth/refresh?client_type=mobile") {
      return { ok: true, status: 200, json: async () => ({ accessToken: "access-token" }) };
    }
    if (String(urlStr) === "https://cloud.example/functions/tokentracker-device-token-issue") {
      assert.equal(opts.headers.Authorization, "Bearer access-token");
      const body = JSON.parse(String(opts.body || "{}"));
      assert.equal(body.machine_id, "machine-abcdef12");
      assert.equal(body.device_name, os.hostname().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128));
      assert.equal(
        body.platform,
        process.platform === "darwin" ? "MacIntel" :
          process.platform === "win32" ? "Win32" :
            process.platform === "linux" ? "Linux x86_64" :
              "web",
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "issued-device-token", device_id: "device-id" }),
      };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ drain: true }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-3), [path.join(process.cwd(), "bin/tracker.js"), "sync", "--drain"]);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token");
    assert.ok(fetchCalls.some((c) => c.url.endsWith("/api/auth/refresh?client_type=mobile")));
    assert.ok(fetchCalls.some((c) => c.url.endsWith("/functions/tokentracker-device-token-issue")));
  } finally {
    restore();
    global.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("local sync drain request fails when relayed device token cannot be issued", async () => {
  const calls = [];
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-local-sync-drain-fail-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  const prevFetch = global.fetch;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(path.join(trackerDir, "config.json"), JSON.stringify({ machineId: "machine-abcdef12" }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  global.fetch = async (urlStr) => {
    if (String(urlStr) === "https://cloud.example/api/auth/refresh?client_type=mobile") {
      return { ok: true, status: 200, json: async () => ({ accessToken: "access-token" }) };
    }
    if (String(urlStr) === "https://cloud.example/functions/tokentracker-device-token-issue") {
      return { ok: false, status: 502, json: async () => ({ error: "upstream unavailable" }) };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ drain: true }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), {
      ok: false,
      error: "Unable to issue cloud device token for local sync",
    });
    assert.equal(calls.length, 0);
  } finally {
    restore();
    global.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("local sync rejects requests without the local auth token", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const req = createRequest({
      method: "POST",
      body: JSON.stringify({ deviceToken: "device-token" }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), {
      ok: false,
      error: "Unauthorized",
    });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("auth bridge mutation requires the local auth token", async () => {
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn([]));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const req = createRequest({
      method: "PUT",
      body: JSON.stringify({ native: true }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/api/auth-bridge/verifier"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), { error: "Unauthorized" });
  } finally {
    restore();
  }
});

test("an app-started sign-in marks exactly one browser relay", async () => {
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn([]));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const verifier = new URL("http://127.0.0.1/api/auth-bridge/verifier");
    assert.equal(handler.takeNativeAuthPending(), false);

    const localAuthToken = await getLocalAuthToken(handler);
    const put = createResponse();
    await handler(
      createRequest({
        method: "PUT",
        headers: { "x-tokentracker-local-auth": localAuthToken },
        body: JSON.stringify({ native: true }),
      }),
      put,
      verifier,
    );
    assert.equal(put.statusCode, 200);

    assert.equal(handler.takeNativeAuthPending(), true);
    assert.equal(handler.takeNativeAuthPending(), false);
    const get = createResponse();
    await handler(createRequest({ method: "GET" }), get, verifier);
    assert.deepEqual(JSON.parse(get.body.toString("utf8")), { native: false });
  } finally {
    restore();
  }
});

test("usage-limits honors devin=1 only on locally authenticated requests", async () => {
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn([]));
  // Stub the aggregate seam so the handler never touches real credentials or
  // the network; only the forwarded selection flag is observed.
  const usageLimits = require("../src/lib/usage-limits");
  const originalGet = usageLimits.getUsageLimits;
  const originalReset = usageLimits.resetUsageLimitsCache;
  const forwarded = [];
  let aggregateCalls = 0;
  let cacheResets = 0;
  usageLimits.getUsageLimits = async (options) => {
    aggregateCalls += 1;
    forwarded.push(options);
    return { fetched_at: "2026-01-01T00:00:00Z", devin: { configured: false } };
  };
  usageLimits.resetUsageLimitsCache = () => {
    cacheResets += 1;
  };

  async function requestLimits({ devin, token, refresh, origin } = {}) {
    const params = new URLSearchParams();
    if (devin) params.set("devin", devin);
    if (refresh) params.set("refresh", refresh);
    const query = params.size ? `?${params}` : "";
    const headers = {};
    if (token) headers["x-tokentracker-local-auth"] = token;
    if (origin) headers.origin = origin;
    const req = createRequest({ method: "GET", headers });
    const res = createResponse();
    const handled = await handler(
      req,
      res,
      new URL(`http://127.0.0.1/functions/tokentracker-usage-limits${query}`),
    );
    assert.equal(handled, true);
    return res;
  }

  const handler = mod.createLocalApiHandler({
    queuePath: path.join(process.cwd(), "tmp-queue.jsonl"),
  });
  try {
    const localAuthToken = await getLocalAuthToken(handler);

    // An explicit opt-in without local auth is rejected outright — before any
    // cache reset or aggregate work, so nothing downstream can misreport the
    // enabled client as a disabled provider.
    for (const token of [undefined, "wrong-token"]) {
      const res = await requestLimits({ devin: "1", refresh: "1", token });
      assert.equal(res.statusCode, 401, `devin=1 with token=${token} must 401`);
      assert.deepEqual(JSON.parse(res.body.toString("utf8")), { error: "Unauthorized" });
    }
    // The devin=true alias is the same opt-in: rejected without auth, and a
    // valid token from a non-loopback origin fails the check all the same.
    const trueUnauthed = await requestLimits({ devin: "true" });
    assert.equal(trueUnauthed.statusCode, 401, "devin=true without auth must 401");
    const badOrigin = await requestLimits({
      devin: "1",
      token: localAuthToken,
      origin: "https://evil.example",
    });
    assert.equal(badOrigin.statusCode, 401, "devin=1 from a foreign origin must 401");
    assert.equal(aggregateCalls, 0, "unauthorized opt-in reached the aggregate");
    assert.equal(cacheResets, 0, "unauthorized opt-in reset the limits cache");

    const ok = await requestLimits({ devin: "1", token: localAuthToken });
    assert.equal(ok.statusCode, 200);
    assert.equal(forwarded.at(-1).devinEnabled, true, "authenticated opt-in forwards enabled");

    const trueOk = await requestLimits({ devin: "true", token: localAuthToken });
    assert.equal(trueOk.statusCode, 200);
    assert.equal(forwarded.at(-1).devinEnabled, true, "devin=true with auth forwards enabled");

    // devin=0/false are absent opt-ins: no auth needed, provider stays off.
    for (const devin of ["0", "false"]) {
      const res = await requestLimits({ devin });
      assert.equal(res.statusCode, 200, `devin=${devin} must not require auth`);
      assert.equal(forwarded.at(-1).devinEnabled, false, `devin=${devin} stays off`);
    }

    // Ordinary requests — with or without local auth but no devin flag — keep
    // their previous behavior.
    for (const token of [localAuthToken, undefined]) {
      const res = await requestLimits({ token });
      assert.equal(res.statusCode, 200);
      assert.equal(forwarded.at(-1).devinEnabled, false, `token=${token} without opt-in stays off`);
    }
  } finally {
    usageLimits.getUsageLimits = originalGet;
    usageLimits.resetUsageLimitsCache = originalReset;
    restore();
  }
});
