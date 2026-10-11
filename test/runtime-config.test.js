const assert = require("node:assert/strict");
const { test } = require("node:test");

const { resolveRuntimeConfig } = require("../src/lib/runtime-config");

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
