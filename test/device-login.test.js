"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { cmdDeviceLogin, pollOnce } = require("../src/commands/device-login");
const publicAnon = [Buffer.from('{"alg":"HS256"}').toString("base64url"),
  Buffer.from('{"role":"anon"}').toString("base64url"), "test-signature"].join(".");

test("pollOnce maps approved device token fields from server response", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, _opts) => ({
    ok: true,
    status: 200,
    async json() {
      return {
        status: "approved",
        user_id: "user-1",
        device_token: "device-token-1",
        device_id: "device-1",
      };
    },
  });
  try {
    const result = await pollOnce({ baseUrl: "https://example.invalid", deviceCode: "abc" });
    assert.equal(result.status, "approved");
    assert.equal(result.user_id, "user-1");
    assert.equal(result.deviceToken, "device-token-1");
    assert.equal(result.deviceId, "device-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("cmdDeviceLogin persists the approved device token used by sync", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "device-login-"));
  const configPath = path.join(home, ".tokentracker", "tracker", "config.json");
  const calls = [];
  const originalFetch = global.fetch;
  const originalStdoutWrite = process.stdout.write;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    if (String(url).endsWith("/tokentracker-device-flow-authorize")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            device_code: "d".repeat(64),
            user_code: "ABCD-2345",
            verification_uri: "https://www.tokentracker.cc/device",
            verification_uri_complete: "https://www.tokentracker.cc/device?user_code=ABCD-2345",
            expires_in: 900,
            interval: 5,
          };
        },
      };
    }
    const currentConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    await fs.writeFile(
      configPath,
      JSON.stringify({
        ...currentConfig,
        anonKey: publicAnon,
        concurrentSetting: "preserved",
      }),
      "utf8",
    );
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          status: "approved",
          user_id: "user-1",
          device_token: "device-token-1",
          device_id: "device-1",
        };
      },
    };
  };
  process.stdout.write = () => true;

  try {
    await cmdDeviceLogin(["--base-url", "https://example.invalid", "--anon-key", publicAnon,
      "--dashboard-url", "https://www.tokentracker.cc"], { home, sleep: async () => {} });
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(config.user_id, "user-1");
    assert.equal(config.deviceToken, "device-token-1");
    assert.equal(config.deviceId, "device-1");
    assert.equal(config.baseUrl, "https://example.invalid");
    assert.equal(config.anonKey, publicAnon);
    assert.equal(config.deviceTokenBaseUrl, "https://example.invalid");
    assert.equal(config.concurrentSetting, "preserved");
    assert.equal(calls.length, 2);
    // Machine-anchored device identity: authorize must carry the SAME
    // machineId that was persisted to config.json, so the server can anchor
    // the issued device to the machine instead of the hostname-derived name.
    const authorizeCall = calls.find((c) => c.url.endsWith("/tokentracker-device-flow-authorize"));
    assert.ok(authorizeCall, "authorize call recorded");
    assert.equal(
      authorizeCall.body.machine_id,
      config.machineId,
      "authorize must send the persisted config.json machineId",
    );
    assert.ok(
      typeof config.machineId === "string" && config.machineId.length >= 8,
      "login must persist a machineId",
    );
  } finally {
    process.stdout.write = originalStdoutWrite;
    global.fetch = originalFetch;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("cmdDeviceLogin rejects approved responses without a usable device token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "device-login-missing-token-"));
  const originalFetch = global.fetch;
  const originalStdoutWrite = process.stdout.write;
  global.fetch = async (url) => {
    if (String(url).endsWith("/tokentracker-device-flow-authorize")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            device_code: "d".repeat(64),
            user_code: "ABCD-2345",
            verification_uri: "https://www.tokentracker.cc/device",
            expires_in: 900,
          };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { status: "approved", user_id: "user-1" };
      },
    };
  };
  process.stdout.write = () => true;

  try {
    await assert.rejects(
      () => cmdDeviceLogin(["--base-url", "https://example.invalid", "--anon-key", publicAnon,
        "--dashboard-url", "https://www.tokentracker.cc"], { home, sleep: async () => {} }),
      /server did not return a device token/,
    );
    // Login start persists a machineId in config.json (machine-anchored
    // device identity), but a failed login must never persist credentials.
    const raw = await fs
      .readFile(path.join(home, ".tokentracker", "tracker", "config.json"), "utf8")
      .catch(() => "{}");
    const config = JSON.parse(raw);
    assert.equal(config.deviceToken, undefined, "failed login must not persist a device token");
    assert.equal(config.user_id, undefined, "failed login must not persist a user id");
  } finally {
    process.stdout.write = originalStdoutWrite;
    global.fetch = originalFetch;
    await fs.rm(home, { recursive: true, force: true });
  }
});
