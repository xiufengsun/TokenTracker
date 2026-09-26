const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { cmdSync } = require("../src/commands/sync");
const { cmdInit } = require("../src/commands/init");
const { cmdDeviceLogin } = require("../src/commands/device-login");
const {
  resolveRuntimeConfig,
  isLegacyInsforgeBaseUrl,
  DEFAULT_BASE_URL,
  DEFAULT_ANON_KEY,
} = require("../src/lib/runtime-config");

const LEGACY_BASE_URL = "https://b46ug8xu.us-east.insforge.app";

async function withTempHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-legacy-baseurl-"));
  const savedFetch = global.fetch;
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    CODE_HOME: process.env.CODE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    DSH_HOME: process.env.DSH_HOME,
    TOKENTRACKER_DSH_HOME: process.env.TOKENTRACKER_DSH_HOME,
    TOKENTRACKER_TRAE_HOME: process.env.TOKENTRACKER_TRAE_HOME,
    TOKENTRACKER_TRAE_DB: process.env.TOKENTRACKER_TRAE_DB,
    TOKENTRACKER_DEVICE_TOKEN: process.env.TOKENTRACKER_DEVICE_TOKEN,
    TOKENTRACKER_INSFORGE_BASE_URL: process.env.TOKENTRACKER_INSFORGE_BASE_URL,
    TOKENTRACKER_INSFORGE_ANON_KEY: process.env.TOKENTRACKER_INSFORGE_ANON_KEY,
    TOKENTRACKER_SKIP_FIRST_SYNC: process.env.TOKENTRACKER_SKIP_FIRST_SYNC,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    process.env.CODE_HOME = path.join(home, ".code");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.TOKENTRACKER_TRAE_HOME = path.join(home, ".trae");
    delete process.env.TOKENTRACKER_TRAE_DB;
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    delete process.env.TOKENTRACKER_INSFORGE_ANON_KEY;
    delete process.env.DSH_HOME;
    delete process.env.TOKENTRACKER_DSH_HOME;
    return await fn(home);
  } finally {
    global.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeTrackerState(home, { config, queue, queueState, uploadThrottle } = {}) {
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });
  if (config) {
    await fs.writeFile(path.join(trackerDir, "config.json"), JSON.stringify(config), "utf8");
  }
  if (queue) {
    await fs.writeFile(path.join(trackerDir, "queue.jsonl"), queue, "utf8");
  }
  if (queueState) {
    await fs.writeFile(
      path.join(trackerDir, "queue.state.json"),
      JSON.stringify(queueState),
      "utf8",
    );
  }
  if (uploadThrottle) {
    await fs.writeFile(
      path.join(trackerDir, "upload.throttle.json"),
      JSON.stringify(uploadThrottle),
      "utf8",
    );
  }
  return trackerDir;
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function successfulFetch(onIngest) {
  return async (url, options = {}) => {
    if (String(url).endsWith("/functions/tokentracker-ingest")) {
      onIngest?.(String(url), options);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ inserted: 1, skipped: 0 }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "{}",
      json: async () => ({}),
    };
  };
}

function sampleQueueLine() {
  return `${JSON.stringify({
    hour_start: "2026-04-20T00:00:00.000Z",
    source: "codex",
    model: "gpt-5.4",
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 120,
    conversation_count: 1,
  })}\n`;
}

function sampleQueueLines(count) {
  return Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      hour_start: "2026-04-20T00:00:00.000Z",
      source: "codex",
      model: `gpt-5.4-${index}`,
      input_tokens: index + 1,
      output_tokens: 1,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: index + 2,
      conversation_count: 1,
    }),
  ).join("\n") + "\n";
}

test("isLegacyInsforgeBaseUrl matches only the retired project host", () => {
  assert.equal(isLegacyInsforgeBaseUrl(LEGACY_BASE_URL), true);
  assert.equal(isLegacyInsforgeBaseUrl(`${LEGACY_BASE_URL}/`), true);
  assert.equal(isLegacyInsforgeBaseUrl("https://B46UG8XU.us-east.insforge.app"), true);
  assert.equal(isLegacyInsforgeBaseUrl(DEFAULT_BASE_URL), false);
  assert.equal(isLegacyInsforgeBaseUrl("https://example.invalid"), false);
  assert.equal(isLegacyInsforgeBaseUrl("not a url"), false);
  assert.equal(isLegacyInsforgeBaseUrl(undefined), false);
});

test("resolveRuntimeConfig recovers from a persisted legacy InsForge base URL", () => {
  const recovered = resolveRuntimeConfig({
    config: { baseUrl: LEGACY_BASE_URL },
    env: {},
  });
  assert.equal(recovered.baseUrl, DEFAULT_BASE_URL);
  assert.equal(recovered.sources.baseUrl, "default");

  // Explicit CLI values still win — only persisted config values are healed.
  const explicit = resolveRuntimeConfig({
    cli: { baseUrl: LEGACY_BASE_URL },
    config: {},
    env: {},
  });
  assert.equal(explicit.baseUrl, LEGACY_BASE_URL);
  assert.equal(explicit.sources.baseUrl, "cli");
});

test("sync preserves the legacy device token and replays the queue to the current backend exactly once", async () => {
  await withTempHome(async (home) => {
    // Settle the fresh-install one-time migrations first (they also reset the
    // upload offset on a brand-new cursors.json); production legacy installs
    // carry old cursors with those keys already marked done.
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    const queue = sampleQueueLine();
    await writeTrackerState(home, {
      config: {
        installedAt: "2026-03-23T08:16:55.409Z",
        baseUrl: LEGACY_BASE_URL,
        anonKey: "legacy-anon-key",
        deviceToken: "legacy-token",
        deviceId: "legacy-device",
        user_id: "legacy-user",
        device_login_at: "2026-03-23T08:20:00.000Z",
        machineId: "machine-1",
      },
      queue,
      queueState: {
        offset: Buffer.byteLength(queue),
        updatedAt: "2026-07-27T11:20:56.334Z",
        note: "old-note",
      },
      uploadThrottle: {
        version: 1,
        backoffStep: 13,
        lastError: "HTTP 503: No backend services available for app: b46ug8xu",
      },
    });

    const ingestCalls = [];
    global.fetch = successfulFetch((url, options) => ingestCalls.push({ url, options }));
    await cmdSync(["--auto"]);

    const config = await readJsonFile(path.join(trackerDir, "config.json"));
    assert.equal(config.baseUrl, undefined);
    assert.equal(config.anonKey, undefined);
    assert.equal(config.deviceToken, "legacy-token");
    assert.equal(config.deviceId, "legacy-device");
    assert.equal(config.user_id, "legacy-user");
    assert.equal(config.device_login_at, "2026-03-23T08:20:00.000Z");
    // Identity anchor and install metadata survive the repair.
    assert.equal(config.machineId, "machine-1");
    assert.equal(config.installedAt, "2026-03-23T08:16:55.409Z");
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(path.join(trackerDir, "config.json"))).mode & 0o777, 0o600);
    }

    const queueState = await readJsonFile(path.join(trackerDir, "queue.state.json"));
    assert.equal(queueState.offset, Buffer.byteLength(queue));
    assert.equal(queueState.note, "reset_after_legacy_baseurl_migration_2026_07");

    assert.equal(ingestCalls.length, 1);
    assert.equal(ingestCalls[0].url, `${DEFAULT_BASE_URL}/functions/tokentracker-ingest`);
    assert.equal(ingestCalls[0].options.headers.apikey, DEFAULT_ANON_KEY);
    assert.equal(ingestCalls[0].options.headers.Authorization, "Bearer legacy-token");
    assert.deepEqual(JSON.parse(ingestCalls[0].options.body).hourly, [JSON.parse(queue)]);

    const uploadThrottle = await readJsonFile(path.join(trackerDir, "upload.throttle.json"));
    assert.equal(uploadThrottle.backoffStep, 0);
    assert.equal(uploadThrottle.lastError, null);

    // Second run must not reset again, and a newly pending row must upload
    // with the current runtime key after the legacy config key was removed.
    const pendingRow = {
      ...JSON.parse(queue),
      hour_start: "2026-04-20T00:30:00.000Z",
      model: "gpt-5.4-follow-up",
    };
    const pendingLine = `${JSON.stringify(pendingRow)}\n`;
    await fs.appendFile(path.join(trackerDir, "queue.jsonl"), pendingLine, "utf8");
    await fs.writeFile(
      path.join(trackerDir, "queue.state.json"),
      JSON.stringify({
        offset: Buffer.byteLength(queue),
        updatedAt: new Date().toISOString(),
        note: "manual",
      }),
      "utf8",
    );
    await cmdSync(["--auto"]);
    const after = await readJsonFile(path.join(trackerDir, "queue.state.json"));
    assert.equal(after.offset, Buffer.byteLength(queue) + Buffer.byteLength(pendingLine));
    assert.equal(after.note, "manual");
    assert.equal(ingestCalls.length, 2);
    assert.equal(ingestCalls[1].options.headers.apikey, DEFAULT_ANON_KEY);
    assert.equal(ingestCalls[1].options.headers.Authorization, "Bearer legacy-token");
    assert.deepEqual(JSON.parse(ingestCalls[1].options.body).hourly, [pendingRow]);
  });
});

test("sync preserves an anon key replaced while legacy migration is uploading", async () => {
  await withTempHome(async (home) => {
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    const queue = sampleQueueLine();
    const configPath = path.join(trackerDir, "config.json");
    await writeTrackerState(home, {
      config: {
        baseUrl: LEGACY_BASE_URL,
        anonKey: "legacy-anon-key",
        deviceToken: "legacy-token",
        machineId: "machine-1",
      },
      queue,
      queueState: { offset: Buffer.byteLength(queue) },
    });

    global.fetch = async (url) => {
      if (String(url).endsWith("/functions/tokentracker-ingest")) {
        await fs.writeFile(
          configPath,
          JSON.stringify({
            baseUrl: LEGACY_BASE_URL,
            anonKey: "current-anon-key",
            deviceToken: "legacy-token",
            machineId: "machine-1",
          }),
          "utf8",
        );
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ inserted: 1, skipped: 0 }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "{}",
        json: async () => ({}),
      };
    };

    await cmdSync(["--auto"]);

    const config = await readJsonFile(configPath);
    assert.equal(config.baseUrl, undefined);
    assert.equal(config.anonKey, "current-anon-key");
    assert.equal(config.deviceToken, "legacy-token");
  });
});

test("sync removes an unchanged legacy anon key after a concurrent login updates the base URL", async () => {
  await withTempHome(async (home) => {
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    const queue = sampleQueueLine();
    const configPath = path.join(trackerDir, "config.json");
    await writeTrackerState(home, {
      config: {
        baseUrl: LEGACY_BASE_URL,
        anonKey: "legacy-anon-key",
        deviceToken: "legacy-token",
        machineId: "machine-1",
      },
      queue,
      queueState: { offset: Buffer.byteLength(queue) },
    });

    const ingestCalls = [];
    global.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/functions/tokentracker-ingest")) {
        ingestCalls.push(options);
        if (ingestCalls.length === 1) {
          await fs.writeFile(
            configPath,
            JSON.stringify({
              baseUrl: DEFAULT_BASE_URL,
              anonKey: "legacy-anon-key",
              deviceToken: "current-login-token",
              user_id: "current-user",
              machineId: "machine-1",
            }),
            "utf8",
          );
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ inserted: 1, skipped: 0 }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "{}",
        json: async () => ({}),
      };
    };

    await cmdSync(["--auto"]);
    const config = await readJsonFile(configPath);
    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.equal(config.anonKey, undefined);
    assert.equal(config.deviceToken, "current-login-token");
    assert.equal(config.user_id, "current-user");

    const pendingRow = {
      ...JSON.parse(queue),
      hour_start: "2026-04-20T00:30:00.000Z",
      model: "gpt-5.4-after-login",
    };
    const pendingLine = `${JSON.stringify(pendingRow)}\n`;
    await fs.appendFile(path.join(trackerDir, "queue.jsonl"), pendingLine, "utf8");
    await cmdSync(["--auto"]);

    assert.equal(ingestCalls.length, 2);
    assert.equal(ingestCalls[1].headers.apikey, DEFAULT_ANON_KEY);
    assert.equal(ingestCalls[1].headers.Authorization, "Bearer current-login-token");
  });
});

test("sync adopts a current-backend device token supplied by the signed-in local API", async () => {
  await withTempHome(async (home) => {
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    const queue = sampleQueueLine();
    await writeTrackerState(home, {
      config: {
        baseUrl: LEGACY_BASE_URL,
        deviceToken: "legacy-token",
        deviceId: "legacy-device",
        machineId: "machine-1",
      },
      queue,
      queueState: { offset: Buffer.byteLength(queue) },
    });
    process.env.TOKENTRACKER_DEVICE_TOKEN = "current-session-token";

    const ingestCalls = [];
    global.fetch = successfulFetch((url, options) => ingestCalls.push({ url, options }));
    await cmdSync(["--auto"]);

    const config = await readJsonFile(path.join(trackerDir, "config.json"));
    assert.equal(config.baseUrl, undefined);
    assert.equal(config.deviceToken, "current-session-token");
    assert.equal(config.deviceId, "legacy-device");
    assert.equal(config.machineId, "machine-1");
    assert.equal(ingestCalls.length, 1);
    assert.equal(ingestCalls[0].options.headers.Authorization, "Bearer current-session-token");
  });
});

test("sync falls back to the preserved device token before committing a rejected replacement", async () => {
  await withTempHome(async (home) => {
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    const queue = sampleQueueLine();
    await writeTrackerState(home, {
      config: {
        baseUrl: LEGACY_BASE_URL,
        deviceToken: "known-valid-legacy-token",
        deviceId: "legacy-device",
        machineId: "machine-1",
      },
      queue,
      queueState: { offset: Buffer.byteLength(queue) },
    });
    process.env.TOKENTRACKER_DEVICE_TOKEN = "rejected-session-token";

    const attemptedTokens = [];
    global.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/functions/tokentracker-ingest")) {
        const token = String(options.headers?.Authorization || "").replace(/^Bearer\s+/, "");
        attemptedTokens.push(token);
        const ok = token === "known-valid-legacy-token";
        return {
          ok,
          status: ok ? 200 : 401,
          headers: { get: () => null },
          text: async () =>
            ok
              ? JSON.stringify({ inserted: 1, skipped: 0 })
              : JSON.stringify({ error: "Unauthorized" }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "{}",
        json: async () => ({}),
      };
    };

    await cmdSync(["--auto"]);

    const config = await readJsonFile(path.join(trackerDir, "config.json"));
    assert.equal(config.baseUrl, undefined);
    assert.equal(config.deviceToken, "known-valid-legacy-token");
    assert.deepEqual(attemptedTokens, [
      "rejected-session-token",
      "known-valid-legacy-token",
    ]);
    const queueState = await readJsonFile(path.join(trackerDir, "queue.state.json"));
    assert.equal(queueState.offset, Buffer.byteLength(queue));
  });
});

test("sync keeps the legacy marker when neither token is accepted", async () => {
  await withTempHome(async (home) => {
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    const queue = sampleQueueLine();
    await writeTrackerState(home, {
      config: {
        baseUrl: LEGACY_BASE_URL,
        deviceToken: "rejected-legacy-token",
        machineId: "machine-1",
      },
      queue,
      queueState: { offset: Buffer.byteLength(queue) },
    });
    process.env.TOKENTRACKER_DEVICE_TOKEN = "rejected-session-token";

    const attemptedTokens = [];
    global.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/functions/tokentracker-ingest")) {
        attemptedTokens.push(
          String(options.headers?.Authorization || "").replace(/^Bearer\s+/, ""),
        );
        return {
          ok: false,
          status: 401,
          headers: { get: () => null },
          text: async () => JSON.stringify({ error: "Unauthorized" }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "{}",
        json: async () => ({}),
      };
    };

    await cmdSync(["--auto"]);

    const config = await readJsonFile(path.join(trackerDir, "config.json"));
    assert.equal(config.baseUrl, LEGACY_BASE_URL);
    assert.equal(config.deviceToken, "rejected-legacy-token");
    assert.deepEqual(attemptedTokens, [
      "rejected-session-token",
      "rejected-legacy-token",
    ]);
    const queueState = await readJsonFile(path.join(trackerDir, "queue.state.json"));
    assert.equal(queueState.offset, 0);

    // A hook firing again inside the recorded failure backoff must not erase
    // the throttle and immediately retry both rejected credentials.
    await cmdSync(["--auto"]);
    assert.deepEqual(attemptedTokens, [
      "rejected-session-token",
      "rejected-legacy-token",
    ]);
  });
});

test("tokenless migration preparation is stable across repeated hooks", async () => {
  await withTempHome(async (home) => {
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    const queue = sampleQueueLine();
    await writeTrackerState(home, {
      config: {
        baseUrl: LEGACY_BASE_URL,
        machineId: "machine-1",
      },
      queue,
      queueState: { offset: Buffer.byteLength(queue) },
    });

    let ingestCalls = 0;
    global.fetch = successfulFetch(() => {
      ingestCalls += 1;
    });
    await cmdSync(["--auto"]);
    const queueStatePath = path.join(trackerDir, "queue.state.json");
    const afterFirstHook = await fs.readFile(queueStatePath, "utf8");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await cmdSync(["--auto"]);
    const afterSecondHook = await fs.readFile(queueStatePath, "utf8");

    assert.equal(afterSecondHook, afterFirstHook);
    assert.equal(ingestCalls, 0);
  });
});

test("a partial non-auth upload failure resumes after the committed offset", async () => {
  await withTempHome(async (home) => {
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    const queue = sampleQueueLines(201);
    await writeTrackerState(home, {
      config: {
        baseUrl: LEGACY_BASE_URL,
        deviceToken: "legacy-token",
        machineId: "machine-1",
      },
      queue,
      queueState: { offset: Buffer.byteLength(queue) },
    });

    let firstRunIngestCalls = 0;
    global.fetch = async (url) => {
      if (String(url).endsWith("/functions/tokentracker-ingest")) {
        firstRunIngestCalls += 1;
        if (firstRunIngestCalls === 1) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify({ inserted: 200, skipped: 0 }),
          };
        }
        return {
          ok: false,
          status: 500,
          headers: { get: () => null },
          text: async () => JSON.stringify({ error: "temporary failure" }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "{}",
        json: async () => ({}),
      };
    };

    await cmdSync(["--auto"]);
    const queueStatePath = path.join(trackerDir, "queue.state.json");
    const afterPartialFailure = await readJsonFile(queueStatePath);
    assert.ok(afterPartialFailure.offset > 0);
    assert.ok(afterPartialFailure.offset < Buffer.byteLength(queue));

    // Simulate the recorded backoff expiring before the next hook.
    await fs.writeFile(
      path.join(trackerDir, "upload.throttle.json"),
      JSON.stringify({
        version: 1,
        nextAllowedAtMs: 0,
        backoffUntilMs: 0,
        backoffStep: 0,
      }),
      "utf8",
    );

    const retryBatchSizes = [];
    global.fetch = successfulFetch((_url, options) => {
      retryBatchSizes.push(JSON.parse(options.body).hourly.length);
    });
    await cmdSync(["--auto"]);

    assert.deepEqual(retryBatchSizes, [1]);
    const afterRetry = await readJsonFile(queueStatePath);
    assert.equal(afterRetry.offset, Buffer.byteLength(queue));
    const config = await readJsonFile(path.join(trackerDir, "config.json"));
    assert.equal(config.baseUrl, undefined);
  });
});

test("sync does not persist an unverified replacement when the replay queue is empty", async () => {
  await withTempHome(async (home) => {
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    await writeTrackerState(home, {
      config: {
        baseUrl: LEGACY_BASE_URL,
        deviceToken: "legacy-token",
        machineId: "machine-1",
      },
      queueState: { offset: 0 },
    });
    process.env.TOKENTRACKER_DEVICE_TOKEN = "unverified-session-token";

    let ingestCalls = 0;
    global.fetch = successfulFetch(() => {
      ingestCalls += 1;
    });
    await cmdSync(["--auto"]);

    const config = await readJsonFile(path.join(trackerDir, "config.json"));
    assert.equal(config.baseUrl, LEGACY_BASE_URL);
    assert.equal(config.deviceToken, "legacy-token");
    assert.equal(ingestCalls, 0);
  });
});

test("sync migration does not overwrite a concurrent successful device login", async () => {
  await withTempHome(async (home) => {
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    const queue = sampleQueueLine();
    const configPath = path.join(trackerDir, "config.json");
    await writeTrackerState(home, {
      config: {
        baseUrl: LEGACY_BASE_URL,
        deviceToken: "legacy-token",
        deviceId: "legacy-device",
        user_id: "legacy-user",
        machineId: "machine-1",
      },
      queue,
      queueState: { offset: Buffer.byteLength(queue) },
    });

    global.fetch = async (url) => {
      if (String(url).endsWith("/functions/tokentracker-ingest")) {
        await fs.writeFile(
          configPath,
          JSON.stringify({
            baseUrl: DEFAULT_BASE_URL,
            deviceToken: "concurrent-login-token",
            deviceId: "concurrent-device",
            user_id: "concurrent-user",
            machineId: "machine-1",
          }),
          "utf8",
        );
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ inserted: 1, skipped: 0 }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "{}",
        json: async () => ({}),
      };
    };

    await cmdSync(["--auto"]);

    const config = await readJsonFile(configPath);
    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.equal(config.deviceToken, "concurrent-login-token");
    assert.equal(config.deviceId, "concurrent-device");
    assert.equal(config.user_id, "concurrent-user");
    assert.equal(config.machineId, "machine-1");
  });
});

test("device-login ignores a retired persisted backend before the first sync", async () => {
  await withTempHome(async (home) => {
    await writeTrackerState(home, {
      config: {
        baseUrl: LEGACY_BASE_URL,
        deviceToken: "legacy-token",
      },
    });

    const calls = [];
    const savedStdoutWrite = process.stdout.write;
    process.stdout.write = () => true;
    global.fetch = async (url) => {
      calls.push(String(url));
      throw new Error("stop after first request");
    };
    try {
      await assert.rejects(
        () => cmdDeviceLogin([], { home, sleep: async () => {} }),
        /stop after first request/,
      );
    } finally {
      process.stdout.write = savedStdoutWrite;
    }

    assert.equal(
      calls[0],
      `${DEFAULT_BASE_URL}/functions/tokentracker-device-flow-authorize`,
    );
  });
});

test("a failed queue-state reset leaves the legacy config intact so migration retries", async () => {
  await withTempHome(async (home) => {
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    const queue = sampleQueueLine();
    await writeTrackerState(home, {
      config: {
        baseUrl: LEGACY_BASE_URL,
        deviceToken: "legacy-token",
        machineId: "machine-1",
      },
      queue,
      uploadThrottle: {
        backoffStep: 4,
        lastError: "HTTP 503",
      },
    });
    const queueStatePath = path.join(trackerDir, "queue.state.json");
    await fs.rm(queueStatePath, { force: true });
    await fs.mkdir(queueStatePath);

    await assert.rejects(() => cmdSync(["--auto"]));
    const afterFailure = await readJsonFile(path.join(trackerDir, "config.json"));
    assert.equal(afterFailure.baseUrl, LEGACY_BASE_URL);
    assert.equal(afterFailure.deviceToken, "legacy-token");

    await fs.rm(queueStatePath, { recursive: true, force: true });
    await fs.writeFile(
      queueStatePath,
      JSON.stringify({ offset: Buffer.byteLength(queue) }),
      "utf8",
    );
    global.fetch = successfulFetch();
    await cmdSync(["--auto"]);

    const afterRetry = await readJsonFile(path.join(trackerDir, "config.json"));
    assert.equal(afterRetry.baseUrl, undefined);
    assert.equal(afterRetry.deviceToken, "legacy-token");
    const queueState = await readJsonFile(queueStatePath);
    assert.equal(queueState.offset, Buffer.byteLength(queue));
  });
});

test("sync leaves a current base URL config untouched", async () => {
  await withTempHome(async (home) => {
    // Settle fresh-install migrations before measuring (see above).
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    await writeTrackerState(home, {
      config: {
        installedAt: "2026-05-01T00:00:00.000Z",
        baseUrl: DEFAULT_BASE_URL,
        deviceToken: "current-token",
      },
      queueState: { offset: 500, updatedAt: "2026-07-27T00:00:00.000Z" },
    });

    await cmdSync(["--auto"]);

    const config = await readJsonFile(path.join(trackerDir, "config.json"));
    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.equal(config.deviceToken, "current-token");

    const queueState = await readJsonFile(path.join(trackerDir, "queue.state.json"));
    assert.equal(queueState.offset, 500);
  });
});

test("init leaves the migration marker for sync, which preserves credentials and replays history", async () => {
  await withTempHome(async (home) => {
    // Match a real pre-0.5.67 install whose older one-time queue migrations
    // have already settled before the backend URL repair ships.
    const trackerDir = await writeTrackerState(home, {});
    await cmdSync(["--auto"]);

    process.env.TOKENTRACKER_SKIP_FIRST_SYNC = "1";
    const queue = sampleQueueLine();
    await writeTrackerState(home, {
      config: {
        installedAt: "2026-03-23T08:16:55.409Z",
        baseUrl: LEGACY_BASE_URL,
        deviceToken: "legacy-token",
        deviceId: "legacy-device",
        machineId: "machine-1",
      },
      queue,
      queueState: { offset: Buffer.byteLength(queue) },
    });

    await cmdInit(["--yes", "--no-auth", "--no-open"]);

    const afterInit = await readJsonFile(path.join(trackerDir, "config.json"));
    assert.equal(afterInit.baseUrl, LEGACY_BASE_URL);
    assert.equal(afterInit.deviceToken, "legacy-token");

    const ingestCalls = [];
    global.fetch = successfulFetch((url, options) => ingestCalls.push({ url, options }));
    await cmdSync(["--auto"]);

    const afterSync = await readJsonFile(path.join(trackerDir, "config.json"));
    assert.equal(afterSync.baseUrl, undefined);
    assert.equal(afterSync.deviceToken, "legacy-token");
    assert.equal(afterSync.deviceId, "legacy-device");
    assert.equal(afterSync.machineId, "machine-1");
    assert.equal(ingestCalls.length, 1);
    assert.equal(ingestCalls[0].url, `${DEFAULT_BASE_URL}/functions/tokentracker-ingest`);
  });
});
