const assert = require("node:assert/strict");
const { test } = require("node:test");

const { resolveRuntimeConfig } = require("../src/lib/runtime-config");

test("the official session cutover keeps a legacy-bound device token and leaves self-hosted servers unchanged", () => {
  const env = { TOKENTRACKER_SESSION_MIGRATION: "1" };
  const legacy = "https://srctyff5.us-east.insforge.app";
  const runtime = resolveRuntimeConfig({
    config: { baseUrl: legacy, deviceTokenBaseUrl: legacy, deviceToken: "existing-device" }, env,
  });
  assert.equal(runtime.baseUrl, "https://api.tokentracker.cc");
  assert.equal(runtime.sessionMigrationFrom, legacy);
  assert.equal(runtime.deviceToken, "existing-device");
  const selfHosted = resolveRuntimeConfig({
    config: { baseUrl: "https://private.example", anonKey: "anon_" + "a".repeat(40),
      deviceTokenBaseUrl: "https://private.example", deviceToken: "private-device" }, env,
  });
  assert.equal(selfHosted.baseUrl, "https://private.example");
  assert.equal(selfHosted.deviceToken, "private-device");
  assert.equal(selfHosted.sessionMigrationFrom, undefined);
});

test("resolveRuntimeConfig prefers CLI flags over config and env", () => {
  const config = { baseUrl: "https://config.example", deviceToken: "cfg" };
  const result = resolveRuntimeConfig({
    cli: { baseUrl: "https://cli.example" },
    config,
    env: { TOKENTRACKER_DEVICE_TOKEN: "env" },
  });

  assert.equal(result.baseUrl, "https://cli.example");
  assert.equal(result.deviceToken, null, "an override must not reuse another instance's device token");
  assert.equal(result.sources.baseUrl, "cli");
  assert.equal(result.sources.deviceToken, "default");
});

test("resolveRuntimeConfig ignores non-TOKENTRACKER env inputs", () => {
  const result = resolveRuntimeConfig({
    env: {
      LEGACY_BASE_URL: "https://legacy.example",
      LEGACY_DEVICE_TOKEN: "legacy",
    },
  });

  assert.equal(result.deviceToken, null);
  assert.equal(result.sources.deviceToken, "default");
});

test("resolveRuntimeConfig recovers from the leaked Windows test base URL", () => {
  const recovered = resolveRuntimeConfig({
    config: { baseUrl: "https://example.invalid" },
    env: {},
  });

  assert.equal(recovered.baseUrl, "https://srctyff5.us-east.insforge.app");
  assert.equal(recovered.sources.baseUrl, "default");

  const explicit = resolveRuntimeConfig({
    cli: { baseUrl: "https://example.invalid" },
    config: { baseUrl: "https://config.example" },
    env: {},
  });
  assert.equal(explicit.baseUrl, "https://example.invalid");
  assert.equal(explicit.sources.baseUrl, "cli");
});

test("resolveRuntimeConfig normalizes timeout and flags", () => {
  const result = resolveRuntimeConfig({
    env: {
      TOKENTRACKER_HTTP_TIMEOUT_MS: "500",
      TOKENTRACKER_DEBUG: "1",
      TOKENTRACKER_AUTO_RETRY_NO_SPAWN: "1",
    },
  });

  assert.equal(result.httpTimeoutMs, 1000);
  assert.equal(result.debug, true);
  assert.equal(result.autoRetryNoSpawn, true);
});

test("the Cloudflare official host reuses only public defaults and binds each device token to its own deployment", () => {
  const { CLOUDFLARE_API_URL, DEFAULT_ANON_KEY, DEFAULT_BASE_URL, DEFAULT_DASHBOARD_URL } = require("../src/lib/runtime-config");
  const env = {};
  assert.equal(resolveRuntimeConfig({ env }).baseUrl, DEFAULT_BASE_URL);
  const cloud = resolveRuntimeConfig({ cli: { baseUrl: CLOUDFLARE_API_URL }, config: { baseUrl: DEFAULT_BASE_URL, deviceToken: "old" }, env });
  assert.deepEqual([cloud.configurationError, cloud.deviceToken, cloud.anonKey, cloud.dashboardUrl],
    [null, null, DEFAULT_ANON_KEY, DEFAULT_DASHBOARD_URL]);
  const config = { baseUrl: CLOUDFLARE_API_URL, deviceToken: "bound" };
  assert.equal(resolveRuntimeConfig({ config, env }).deviceToken, null);
  assert.equal(resolveRuntimeConfig({ config: { ...config, deviceTokenBaseUrl: CLOUDFLARE_API_URL }, env }).deviceToken, "bound");
  assert.equal(resolveRuntimeConfig({ config: { ...config, baseUrl: DEFAULT_BASE_URL, deviceTokenBaseUrl: CLOUDFLARE_API_URL }, env }).deviceToken, null);
  for (const baseUrl of [CLOUDFLARE_API_URL + ".example.org", CLOUDFLARE_API_URL + "/other", "https://tt.workers.dev"]) {
    const result = resolveRuntimeConfig({ cli: { baseUrl }, config, env });
    assert.ok(result.configurationError);
    assert.equal(result.deviceToken, null);
  }
});
