const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const pkg = require("../package.json");
const {
  HEARTBEAT_FUNCTION_SLUG,
  HEARTBEAT_STATE_FILE,
  HEARTBEAT_INTERVAL_MS,
  isTelemetryDisabled,
  hashMachineId,
  resolveShell,
  buildHeartbeatPayload,
  maybeSendHeartbeat,
} = require("../src/lib/telemetry");

// A sandboxed <home>/.tokentracker/tracker layout so machine-id's seed file
// mirroring stays inside the temp home (see defaultSeedPath in machine-id.js).
async function makeTrackerDir() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-telemetry-"));
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });
  return { home, trackerDir };
}

// Env WITHOUT the test-runner marker, so maybeSendHeartbeat is exercised for
// real; individual tests layer opt-out flags on top.
const BASE_ENV = {};

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift() || { ok: true, status: 204 };
    return next;
  };
  return { calls, impl };
}

test("isTelemetryDisabled honors TOKENTRACKER_NO_TELEMETRY, DO_NOT_TRACK, and config", () => {
  assert.equal(isTelemetryDisabled({ env: {}, config: {} }), false);
  assert.equal(isTelemetryDisabled({ env: { TOKENTRACKER_NO_TELEMETRY: "1" }, config: {} }), true);
  assert.equal(isTelemetryDisabled({ env: { TOKENTRACKER_NO_TELEMETRY: "true" }, config: {} }), true);
  assert.equal(isTelemetryDisabled({ env: { TOKENTRACKER_NO_TELEMETRY: "0" }, config: {} }), false);
  assert.equal(isTelemetryDisabled({ env: { DO_NOT_TRACK: "1" }, config: {} }), true);
  assert.equal(isTelemetryDisabled({ env: {}, config: { telemetry: false } }), true);
  assert.equal(isTelemetryDisabled({ env: {}, config: { telemetry: true } }), false);
});

test("hashMachineId is a one-way 64-hex digest, never the raw id", () => {
  const hash = hashMachineId("my-machine-id-123");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, "my-machine-id-123");
  assert.ok(!hash.includes("my-machine-id"));
  assert.equal(hash, hashMachineId("my-machine-id-123")); // deterministic
  assert.notEqual(hash, hashMachineId("other-machine"));
});

test("resolveShell only accepts known shells and defaults to cli", () => {
  assert.equal(resolveShell({}), "cli");
  assert.equal(resolveShell({ TOKENTRACKER_APP_SHELL: "macos" }), "macos");
  assert.equal(resolveShell({ TOKENTRACKER_APP_SHELL: "WINDOWS" }), "windows");
  assert.equal(resolveShell({ TOKENTRACKER_APP_SHELL: "linux" }), "linux");
  assert.equal(resolveShell({ TOKENTRACKER_APP_SHELL: "evil-value" }), "cli");
});

test("buildHeartbeatPayload carries exactly four anonymous fields", () => {
  const payload = buildHeartbeatPayload({
    machineId: "abc12345",
    platform: "darwin",
    env: { TOKENTRACKER_APP_SHELL: "macos" },
  });
  assert.deepEqual(Object.keys(payload).sort(), ["app_version", "machine_hash", "platform", "shell"]);
  assert.match(payload.machine_hash, /^[0-9a-f]{64}$/);
  assert.equal(payload.app_version, pkg.version);
  assert.equal(payload.platform, "darwin");
  assert.equal(payload.shell, "macos");
});

test("maybeSendHeartbeat sends once, records state, and throttles the same day", async () => {
  const { trackerDir } = await makeTrackerDir();
  const { calls, impl } = fakeFetch([{ ok: true, status: 204 }]);
  const nowMs = Date.UTC(2026, 6, 6, 12, 0, 0);

  const first = await maybeSendHeartbeat({ trackerDir, fetchImpl: impl, nowMs, env: BASE_ENV });
  assert.equal(first.sent, true);
  assert.equal(calls.length, 1);

  const { url, options } = calls[0];
  assert.ok(url.endsWith(`/${HEARTBEAT_FUNCTION_SLUG}`), url);
  assert.equal(options.method, "POST");
  assert.ok(options.headers.apikey, "apikey header present");
  const body = JSON.parse(options.body);
  assert.deepEqual(Object.keys(body).sort(), ["app_version", "machine_hash", "platform", "shell"]);
  assert.match(body.machine_hash, /^[0-9a-f]{64}$/);

  const state = JSON.parse(await fs.readFile(path.join(trackerDir, HEARTBEAT_STATE_FILE), "utf8"));
  assert.equal(state.lastSuccessMs, nowMs);
  assert.ok(state.nextAllowedAtMs >= nowMs + HEARTBEAT_INTERVAL_MS);

  // One hour later: throttled, no second request.
  const second = await maybeSendHeartbeat({
    trackerDir,
    fetchImpl: impl,
    nowMs: nowMs + 60 * 60 * 1000,
    env: BASE_ENV,
  });
  assert.equal(second.sent, false);
  assert.equal(second.reason, "throttled");
  assert.equal(calls.length, 1);

  // 25 hours later (past interval + max jitter): sends again.
  const third = await maybeSendHeartbeat({
    trackerDir,
    fetchImpl: impl,
    nowMs: nowMs + 25 * 60 * 60 * 1000,
    env: BASE_ENV,
  });
  assert.equal(third.sent, true);
  assert.equal(calls.length, 2);
});

test("maybeSendHeartbeat is a no-op on every opt-out path", async () => {
  const { trackerDir } = await makeTrackerDir();
  const { calls, impl } = fakeFetch([]);

  for (const env of [{ TOKENTRACKER_NO_TELEMETRY: "1" }, { DO_NOT_TRACK: "1" }]) {
    const result = await maybeSendHeartbeat({ trackerDir, fetchImpl: impl, nowMs: Date.now(), env });
    assert.equal(result.sent, false);
    assert.equal(result.reason, "opt-out");
  }

  await fs.writeFile(path.join(trackerDir, "config.json"), JSON.stringify({ telemetry: false }));
  const result = await maybeSendHeartbeat({
    trackerDir,
    fetchImpl: impl,
    nowMs: Date.now(),
    env: BASE_ENV,
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "opt-out");
  assert.equal(calls.length, 0);
});

test("maybeSendHeartbeat never fires under the node test runner env marker", async () => {
  const { trackerDir } = await makeTrackerDir();
  const { calls, impl } = fakeFetch([]);
  const result = await maybeSendHeartbeat({
    trackerDir,
    fetchImpl: impl,
    nowMs: Date.now(),
    env: { NODE_TEST_CONTEXT: "child-v8" },
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "test-env");
  assert.equal(calls.length, 0);
});

test("maybeSendHeartbeat records backoff on HTTP failure and never throws", async () => {
  const { trackerDir } = await makeTrackerDir();
  const { calls, impl } = fakeFetch([{ ok: false, status: 500 }]);
  const nowMs = Date.UTC(2026, 6, 6, 12, 0, 0);

  const result = await maybeSendHeartbeat({ trackerDir, fetchImpl: impl, nowMs, env: BASE_ENV });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "http-error");
  assert.equal(calls.length, 1);

  const state = JSON.parse(await fs.readFile(path.join(trackerDir, HEARTBEAT_STATE_FILE), "utf8"));
  assert.ok(state.backoffUntilMs > nowMs);
  assert.equal(state.lastSuccessMs, 0);

  // Retry inside the backoff window stays silent.
  const retry = await maybeSendHeartbeat({
    trackerDir,
    fetchImpl: impl,
    nowMs: nowMs + 1000,
    env: BASE_ENV,
  });
  assert.equal(retry.sent, false);
  assert.equal(calls.length, 1);
});

test("maybeSendHeartbeat survives a rejecting fetch (network error)", async () => {
  const { trackerDir } = await makeTrackerDir();
  const impl = async () => {
    throw new Error("network down");
  };
  const result = await maybeSendHeartbeat({
    trackerDir,
    fetchImpl: impl,
    nowMs: Date.now(),
    env: BASE_ENV,
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "error");
});
