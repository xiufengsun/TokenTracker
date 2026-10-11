const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  readAntigravityLinuxSecretRaw,
  loadAntigravityCredentials,
  fetchAntigravityLimits,
  ANTIGRAVITY_OAUTH_CLIENT_SECRET,
} = require("../src/lib/usage-limits");

const NOW = Date.parse("2026-08-31T00:00:00Z");
const FRESH = "2026-08-31T01:00:00Z";
const EXPIRED = "2026-08-01T00:00:00Z";

/** Encode the nested agy token format using synthetic credentials. */
function credentials(accessToken, expiry) {
  return JSON.stringify({ token: {
    access_token: accessToken,
    refresh_token: "fixture-refresh",
    expiry,
  } });
}

/** Create an isolated home and register cleanup after the async test finishes. */
function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-keyring-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Write a file candidate to compare against the injected keyring entry. */
function writeFileCredentials(home, expiry) {
  const file = path.join(home, ".gemini", "jetski-standalone-oauth-token");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, credentials("fixture-file", expiry));
}

/** Seed last-good quota with a reset later than the fixed test clock. */
function writeCache(home) {
  const dir = path.join(home, ".tokentracker", "tracker");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "usage-limits-cache.json"), JSON.stringify({
    antigravity: {
      primary_window: { used_percent: 31, reset_at: FRESH },
      cached_at: new Date(NOW).toISOString(),
    },
  }));
}

/** Represent a process scan with no running language server. */
function noProcess() {
  return { status: 1, stdout: "" };
}

/** Run a real child with fixed JavaScript source and fixture data passed as argv. */
function fakeSecretProcess(t, script, scriptArgs = []) {
  const spawn = cp.spawn;
  let child;
  let closed;
  t.mock.method(cp, "spawnSync", () => {
    throw new Error("keyring discovery must not use spawnSync");
  });
  t.mock.method(cp, "spawn", (bin, args, options) => {
    assert.equal(bin, "secret-tool");
    assert.deepEqual(args, ["lookup", "service", "gemini", "username", "antigravity"]);
    child = spawn(process.execPath, ["-e", script, ...scriptArgs], options);
    closed = new Promise((resolve) => child.once("close", resolve));
    return child;
  });
  t.after(() => { if (child?.exitCode === null) child.kill("SIGKILL"); });
  return { child: () => child, closed: () => closed };
}

test("Linux keyring discovery leaves the event loop responsive", { skip: process.platform !== "linux" }, async (t) => {
  const raw = credentials("fixture-keyring", FRESH);
  fakeSecretProcess(t, "setTimeout(() => process.stdout.write(process.argv[1]), 200)", [raw]);
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 10);
  t.after(() => clearTimeout(timer));
  const pending = readAntigravityLinuxSecretRaw();
  assert.equal(typeof pending?.then, "function", "lookup must return a promise");
  assert.equal(await pending, raw);
  assert.equal(heartbeat, true, "timers must run while secret-tool is pending");
});

test("keyring fixture data containing quotes and line separators stays out of executable code", { skip: process.platform !== "linux" }, async (t) => {
  const raw = credentials("fixture\"\\\n\u2028\u2029", FRESH);
  fakeSecretProcess(t, "process.stdout.write(process.argv[1])", [raw]);
  assert.equal(await readAntigravityLinuxSecretRaw(), raw);
});

test("Linux keyring timeout terminates the subprocess", { skip: process.platform !== "linux" }, async (t) => {
  const processInfo = fakeSecretProcess(t, "setTimeout(() => {}, 10000)");
  const started = Date.now();
  assert.equal(await readAntigravityLinuxSecretRaw({ timeoutMs: 100 }), null);
  assert.ok(Date.now() - started < 1000, "lookup must return before child-exit grace expires");
  assert.ok(processInfo.child(), "the default reader must spawn secret-tool");
  await processInfo.closed();
  assert.ok(processInfo.child().signalCode, "the timed-out child must receive a signal");
});

test("Linux keyring abort terminates the subprocess", { skip: process.platform !== "linux" }, async (t) => {
  const processInfo = fakeSecretProcess(t, "setTimeout(() => {}, 10000)");
  const controller = new AbortController();
  const pending = readAntigravityLinuxSecretRaw({ signal: controller.signal });
  controller.abort();
  assert.equal(await pending, null);
  assert.ok(processInfo.child(), "the reader must start the subprocess before cancellation");
  await processInfo.closed();
  assert.ok(processInfo.child().signalCode);
});

test("an already-aborted lookup does not invoke the runner", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  assert.equal(await readAntigravityLinuxSecretRaw({
    signal: controller.signal,
    secretToolRunner() { calls += 1; return { status: 0, stdout: "unexpected" }; },
  }), null);
  assert.equal(calls, 0);
});

test("a zero lookup budget does not invoke the runner", async () => {
  let calls = 0;
  assert.equal(await readAntigravityLinuxSecretRaw({
    timeoutMs: 0,
    secretToolRunner() { calls += 1; return { status: 0, stdout: "unexpected" }; },
  }), null);
  assert.equal(calls, 0);
});

test("a hanging injected keyring runner is bounded and cancelled", async () => {
  let signal;
  const started = Date.now();
  assert.equal(await readAntigravityLinuxSecretRaw({
    timeoutMs: 40,
    secretToolRunner(_bin, _args, options) {
      signal = options.signal;
      return new Promise(() => {});
    },
  }), null);
  assert.ok(Date.now() - started < 500);
  assert.equal(signal.aborted, true);
});

test("reader failures and empty output are treated as keyring misses", async () => {
  assert.equal(await readAntigravityLinuxSecretRaw({ secretToolRunner() { throw new Error("unavailable"); } }), null);
  assert.equal(await readAntigravityLinuxSecretRaw({ secretToolRunner: async () => ({ error: new Error("ENOENT") }) }), null);
  assert.equal(await readAntigravityLinuxSecretRaw({ secretToolRunner: async () => ({ status: 1, stdout: "ignored" }) }), null);
  assert.equal(await readAntigravityLinuxSecretRaw({ secretToolRunner: async () => ({ status: 0, stdout: " \n" }) }), null);
  assert.equal(await readAntigravityLinuxSecretRaw({ secretToolRunner: async () => ({ status: 0, stdout: Buffer.from(" payload \n") }) }), "payload");
});

test("fresh keyring credentials replace an expired file", async (t) => {
  const home = tempHome(t);
  writeFileCredentials(home, EXPIRED);
  const result = await loadAntigravityCredentials({
    home, platform: "linux", nowMs: NOW,
    secretToolRunner: async () => ({ status: 0, stdout: credentials("fixture-keyring", FRESH) }),
  });
  assert.equal(result.source, "keyring");
  assert.equal(result.accessToken, "fixture-keyring");
});

test("a fresh file wins over expired keyring credentials", async (t) => {
  const home = tempHome(t);
  writeFileCredentials(home, FRESH);
  const result = await loadAntigravityCredentials({
    home, platform: "linux", nowMs: NOW,
    secretToolRunner: async () => ({ status: 0, stdout: credentials("fixture-keyring", EXPIRED) }),
  });
  assert.equal(result.source, "file");
  assert.equal(result.accessToken, "fixture-file");
});

test("malformed keyring output preserves file credentials", async (t) => {
  const home = tempHome(t);
  writeFileCredentials(home, FRESH);
  const result = await loadAntigravityCredentials({
    home, platform: "linux", nowMs: NOW,
    secretToolRunner: async () => ({ status: 0, stdout: "not JSON" }),
  });
  assert.equal(result.source, "file");
});

test("keyring discovery consumes the provider budget and preserves cached quota", async (t) => {
  const home = tempHome(t);
  writeCache(home);
  let lookupSignal;
  let lookupTimeout;
  let processCalls = 0;
  const started = Date.now();
  const result = await fetchAntigravityLimits({
    home, platform: "linux", nowMs: NOW, providerTimeoutMs: 100,
    secretToolRunner(_bin, _args, options) {
      lookupSignal = options.signal;
      lookupTimeout = options.timeout;
      return new Promise(() => {});
    },
    commandRunner() { processCalls += 1; return noProcess(); },
    fetchImpl() { throw new Error("must not fetch without credentials"); },
  });
  assert.ok(Date.now() - started < 500, "lookup must not get a separate 2-second budget");
  assert.ok(lookupTimeout > 0 && lookupTimeout < 100);
  assert.equal(lookupSignal.aborted, true);
  assert.equal(processCalls, 0, "process scanning must not start after the budget is spent");
  assert.equal(result.cached, true);
  assert.equal(result.primary_window.used_percent, 31);
});

test("cancelling discovery skips the remaining provider work", async (t) => {
  const home = tempHome(t);
  writeCache(home);
  const controller = new AbortController();
  let lookupSignal;
  let processCalls = 0;
  const pending = fetchAntigravityLimits({
    home, platform: "linux", nowMs: NOW, signal: controller.signal,
    secretToolRunner(_bin, _args, options) {
      lookupSignal = options.signal;
      return new Promise(() => {});
    },
    commandRunner() { processCalls += 1; return noProcess(); },
    fetchImpl() { throw new Error("must not fetch"); },
  });
  controller.abort();
  const result = await pending;
  assert.equal(lookupSignal.aborted, true);
  assert.equal(processCalls, 0);
  assert.equal(result.cached, true);
});

test("expired keyring credentials refresh once and use the renewed token for quota", async (t) => {
  const home = tempHome(t);
  let lookups = 0;
  let refreshes = 0;
  let writes = 0;
  const result = await fetchAntigravityLimits({
    home, platform: "linux", nowMs: NOW,
    secretToolRunner: async (_bin, args) => {
      if (args[0] === "store") {
        writes += 1;
        return { status: 0, stdout: "" };
      }
      lookups += 1;
      return { status: 0, stdout: credentials("fixture-expired", EXPIRED) };
    },
    commandRunner: noProcess,
    async fetchImpl(url, options) {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        refreshes += 1;
        assert.equal(options.body.get("refresh_token"), "fixture-refresh");
        assert.equal(options.body.get("client_secret"), ANTIGRAVITY_OAUTH_CLIENT_SECRET);
        return { ok: true, status: 200, json: async () => ({ access_token: "fixture-renewed", expires_in: 3600 }) };
      }
      assert.equal(options.headers.Authorization, "Bearer fixture-renewed");
      const payload = String(url).includes("retrieveUserQuotaSummary")
        ? { groups: [{ buckets: [{ bucketId: "3p-weekly", remainingFraction: 0.75, resetTime: FRESH }] }] }
        : { paidTier: { name: "Google AI Pro" } };
      return { ok: true, status: 200, json: async () => payload };
    },
  });
  assert.equal(result.error, null);
  assert.equal(result.primary_window.used_percent, 25);
  assert.equal(lookups, 2, "read once for discovery and once before saving rotated tokens");
  assert.equal(refreshes, 1);
  assert.equal(writes, 1);
});

test("keyring failure keeps a usable file token and leaves the provider signal active", async (t) => {
  const home = tempHome(t);
  writeFileCredentials(home, FRESH);
  const controller = new AbortController();
  const result = await fetchAntigravityLimits({
    home, platform: "linux", nowMs: NOW, signal: controller.signal,
    secretToolRunner() {
      return { error: new Error("keyring unavailable"), status: null, stdout: "" };
    },
    commandRunner: noProcess,
    async fetchImpl(url, options) {
      assert.equal(options.headers.Authorization, "Bearer fixture-file");
      assert.equal(options.signal.aborted, false);
      const payload = String(url).includes("retrieveUserQuotaSummary")
        ? { groups: [{ buckets: [{ bucketId: "3p-weekly", remainingFraction: 0.6, resetTime: FRESH }] }] }
        : {};
      return { ok: true, status: 200, json: async () => payload };
    },
  });
  assert.equal(result.error, null);
  assert.equal(result.primary_window.used_percent, 40);
  assert.equal(controller.signal.aborted, false);
});

test("a keyring timeout preserves file credentials without aborting the caller", async (t) => {
  const home = tempHome(t);
  writeFileCredentials(home, FRESH);
  const controller = new AbortController();
  let lookupSignal;
  const result = await loadAntigravityCredentials({
    home, platform: "linux", nowMs: NOW, timeoutMs: 20, signal: controller.signal,
    secretToolRunner(_bin, _args, options) {
      lookupSignal = options.signal;
      return new Promise(() => {});
    },
  });
  assert.equal(result.source, "file");
  assert.equal(lookupSignal.aborted, true);
  assert.equal(controller.signal.aborted, false);
});

test("the cache fallback does not read the keyring a second time", async (t) => {
  const home = tempHome(t);
  writeCache(home);
  let lookups = 0;
  const result = await fetchAntigravityLimits({
    home, platform: "linux", nowMs: NOW,
    secretToolRunner: async () => {
      lookups += 1;
      return { status: 0, stdout: credentials("fixture-expired", EXPIRED) };
    },
    commandRunner: noProcess,
    fetchImpl: async () => ({ ok: false, status: 400 }),
  });
  assert.equal(lookups, 1);
  assert.equal(result.cached, true);
  assert.equal(result.auth_action_required, "reauth");
});
