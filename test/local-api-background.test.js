const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

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
  return JSON.parse(res.body.toString("utf8")).token;
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

async function runLocalSync(body, options = {}) {
  const calls = [];
  const tmpHome = options.tmpHome || fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-local-api-background-"));
  const ownsTmpHome = !options.tmpHome;
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: options.queuePath || path.join(process.cwd(), "tmp-queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        ...(options.includeDeviceToken === false ? {} : { deviceToken: "device-token" }),
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
    return calls[0];
  } finally {
    restore();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (ownsTmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function createCloudSyncHome(prefix) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
  return { tmpHome, trackerDir };
}

function installDeviceTokenFetch(fetchCalls) {
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
}

test("local-api forwards strict boolean auto background sync", async () => {
  const call = await runLocalSync({ auto: true, background: true, nativeOnlyWsl: true });
  const args = call.args;
  assert.deepEqual(args.slice(-4), [
    path.join(process.cwd(), "bin/tracker.js"),
    "sync",
    "--auto",
    "--background",
  ]);
  assert.equal(call.options.env.TOKENTRACKER_WSL_MODE, "native-only");
});

test("local-api treats lightweight true as background alias", async () => {
  const call = await runLocalSync({ auto: true, lightweight: true });
  const args = call.args;
  assert.deepEqual(args.slice(-4), [
    path.join(process.cwd(), "bin/tracker.js"),
    "sync",
    "--auto",
    "--background",
  ]);
});

test("local-api combines background scan with drain upload", async () => {
  const call = await runLocalSync({
    drain: true,
    auto: true,
    background: true,
    allLocalSources: true,
    publishAccount: true,
  });
  const args = call.args;
  assert.deepEqual(args.slice(-7), [
    path.join(process.cwd(), "bin/tracker.js"),
    "sync",
    "--auto",
    "--background",
    "--publish-account",
    "--all-local-sources",
    "--drain",
  ]);
});

test("local-api background and lightweight require boolean true", async () => {
  const cases = [
    { background: false },
    { background: "true" },
    { background: 1 },
    { lightweight: false },
    { lightweight: "true" },
    { lightweight: 1 },
  ];

  for (const body of cases) {
    const call = await runLocalSync({ auto: true, ...body });
    const args = call.args;
    assert.deepEqual(args.slice(-4), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--wait-for-lock",
    ]);
  }
});

test("local-api only propagates native-only WSL for strict boolean background requests", async () => {
  const previousWslMode = process.env.TOKENTRACKER_WSL_MODE;
  delete process.env.TOKENTRACKER_WSL_MODE;

  try {
    const cases = [
      {
        body: { auto: true, background: true, nativeOnlyWsl: true },
        expected: "native-only",
      },
      { body: { auto: true, background: true, nativeOnlyWsl: false }, expected: undefined },
      { body: { auto: true, background: true, nativeOnlyWsl: "true" }, expected: undefined },
      { body: { auto: true, background: false, nativeOnlyWsl: true }, expected: undefined },
      { body: { auto: true, nativeOnlyWsl: true }, expected: undefined },
      { body: { nativeOnlyWsl: true }, expected: undefined },
    ];

    for (const { body, expected } of cases) {
      const call = await runLocalSync(body);
      assert.equal(call.options.env.TOKENTRACKER_WSL_MODE, expected, JSON.stringify(body));
    }
  } finally {
    if (previousWslMode === undefined) delete process.env.TOKENTRACKER_WSL_MODE;
    else process.env.TOKENTRACKER_WSL_MODE = previousWslMode;
  }
});

test("local-api background sync skips relayed cloud device-token issuance", async () => {
  const fixture = createCloudSyncHome("tokentracker-local-api-background-cloud-");
  const savedBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  const savedFetch = global.fetch;
  const fetchCalls = [];
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";
  global.fetch = async (urlStr) => {
    fetchCalls.push(String(urlStr));
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  try {
    const call = await runLocalSync(
      { auto: true, background: true },
      {
        tmpHome: fixture.tmpHome,
        queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
        includeDeviceToken: false,
      },
    );

    assert.deepEqual(call.args.slice(-4), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
    ]);
    assert.equal(call.options.env.TOKENTRACKER_DEVICE_TOKEN, undefined);
    assert.deepEqual(fetchCalls, []);
  } finally {
    if (savedBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = savedBaseUrl;
    global.fetch = savedFetch;
    fs.rmSync(fixture.tmpHome, { recursive: true, force: true });
  }
});

test("explicit account publication mints a cached token for bounded background sync", async () => {
  const fixture = createCloudSyncHome("tokentracker-local-api-background-publish-");
  const savedBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  const savedFetch = global.fetch;
  const fetchCalls = [];
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";
  installDeviceTokenFetch(fetchCalls);

  try {
    const call = await runLocalSync(
      { auto: true, background: true, publishAccount: true },
      {
        tmpHome: fixture.tmpHome,
        queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
        includeDeviceToken: false,
      },
    );

    assert.deepEqual(call.args.slice(-5), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
      "--publish-account",
    ]);
    assert.equal(call.options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token");
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/api/auth/refresh?client_type=mobile")).length, 1);
    assert.equal(fetchCalls.filter((c) => c.url.endsWith("/functions/tokentracker-device-token-issue")).length, 1);
  } finally {
    if (savedBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = savedBaseUrl;
    global.fetch = savedFetch;
    fs.rmSync(fixture.tmpHome, { recursive: true, force: true });
  }
});

test("disabled cloud sync suppresses background account publication even with a device token", async () => {
  const fixture = createCloudSyncHome("tokentracker-local-api-background-disabled-");
  fs.writeFileSync(
    path.join(fixture.trackerDir, "cloud-sync-pref.json"),
    JSON.stringify({ enabled: false }),
  );

  try {
    const call = await runLocalSync(
      { auto: true, background: true, publishAccount: true },
      {
        tmpHome: fixture.tmpHome,
        queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
      },
    );

    assert.deepEqual(call.args.slice(-4), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
    ]);
    assert.equal(call.options.env.TOKENTRACKER_DEVICE_TOKEN, "device-token");
  } finally {
    fs.rmSync(fixture.tmpHome, { recursive: true, force: true });
  }
});

test("local-api lightweight sync skips relayed cloud device-token issuance", async () => {
  const fixture = createCloudSyncHome("tokentracker-local-api-lightweight-cloud-");
  const savedBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  const savedFetch = global.fetch;
  const fetchCalls = [];
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";
  global.fetch = async (urlStr) => {
    fetchCalls.push(String(urlStr));
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  try {
    const call = await runLocalSync(
      { auto: true, lightweight: true },
      {
        tmpHome: fixture.tmpHome,
        queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
        includeDeviceToken: false,
      },
    );

    assert.deepEqual(call.args.slice(-4), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
    ]);
    assert.equal(call.options.env.TOKENTRACKER_DEVICE_TOKEN, undefined);
    assert.deepEqual(fetchCalls, []);
  } finally {
    if (savedBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = savedBaseUrl;
    global.fetch = savedFetch;
    fs.rmSync(fixture.tmpHome, { recursive: true, force: true });
  }
});

test("local-api manual and drain sync still issue relayed cloud device tokens", async () => {
  const savedBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  const savedFetch = global.fetch;
  const cases = [
    {
      prefix: "tokentracker-local-api-manual-cloud-",
      body: {},
      expectedArgs: ["sync", "--wait-for-lock"],
    },
    { prefix: "tokentracker-local-api-drain-cloud-", body: { drain: true }, expectedArgs: ["sync", "--drain"] },
  ];

  try {
    process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";
    for (const testCase of cases) {
      const fixture = createCloudSyncHome(testCase.prefix);
      const fetchCalls = [];
      installDeviceTokenFetch(fetchCalls);
      try {
        const call = await runLocalSync(
          testCase.body,
          {
            tmpHome: fixture.tmpHome,
            queuePath: path.join(fixture.trackerDir, "queue.jsonl"),
            includeDeviceToken: false,
          },
        );
        assert.deepEqual(call.args.slice(-testCase.expectedArgs.length), testCase.expectedArgs);
        assert.equal(call.options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token");
        assert.equal(fetchCalls.filter((c) => c.url.endsWith("/api/auth/refresh?client_type=mobile")).length, 1);
        assert.equal(fetchCalls.filter((c) => c.url.endsWith("/functions/tokentracker-device-token-issue")).length, 1);
      } finally {
        fs.rmSync(fixture.tmpHome, { recursive: true, force: true });
      }
    }
  } finally {
    if (savedBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = savedBaseUrl;
    global.fetch = savedFetch;
  }
});
