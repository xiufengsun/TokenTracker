const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getUsageLimits, resetUsageLimitsCache, USAGE_LIMITS_PROVIDER_IDS } = require("./helpers/usage-limits");

const customUrl = "https://user:password@gateway.example:8443/v1?key=secret";
const customOrigin = "https://gateway.example:8443";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-custom-limits-"));
  resetUsageLimitsCache();
  t.after(() => {
    resetUsageLimitsCache();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const write = (file, value) => {
    const target = path.join(home, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
  };
  write(".claude/.credentials.json", { claudeAiOauth: { accessToken: "test-oauth-token", subscriptionType: "max" } });
  const requests = [];
  const usage = { five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3600000).toISOString() } };
  const options = {
    home, env: {}, platform: "linux",
    hiddenProviders: USAGE_LIMITS_PROVIDER_IDS.filter((id) => id !== "claude"),
    securityRunner: () => ({ status: 1, stdout: "" }),
    commandRunner: () => ({ status: 1, stdout: "" }),
    fetchImpl: async (url) => {
      const parsed = new URL(typeof url === "string" ? url : url.url);
      requests.push(parsed.hostname);
      return { ok: true, status: 200, json: async () => parsed.hostname === "api.anthropic.com" ? usage : { status: { indicator: "none" } } };
    },
  };
  return { home, write, requests, usage, options };
}

function assertCustom(claude, origin = customOrigin) {
  assert.deepEqual(claude, {
    configured: true, backend: "custom", backend_origin: origin,
    limits_status: "not_applicable", cost_status: "unknown", error: null,
  });
}

for (const scenario of ["live", "fresh tracker cache", "stale tracker cache", "Claude Code cache", "forced refresh", "environment", "config directory", "hook observation"]) {
  test(`custom backend with OAuth bypasses Anthropic quotas: ${scenario}`, async (t) => {
    const f = fixture(t);
    if (scenario === "environment") {
      f.options.env.ANTHROPIC_BASE_URL = customUrl;
    } else if (scenario === "config directory") {
      f.options.env.CLAUDE_CONFIG_DIR = path.join(f.home, "alternate-claude");
      f.write("alternate-claude/settings.json", { env: { ANTHROPIC_BASE_URL: customUrl } });
    } else if (scenario === "hook observation") {
      f.write(".tokentracker/tracker/claude-backend-current.json", { backend: "custom", backend_origin: customOrigin });
    } else {
      f.write(".claude/settings.json", { env: { ANTHROPIC_BASE_URL: customUrl } });
    }
    if (scenario.includes("tracker cache") || scenario === "forced refresh") {
      f.write(".tokentracker/tracker/claude-usage-limits-cache.json", {
        claude: { ...f.usage, cached_at: new Date(Date.now() - (scenario === "stale tracker cache" ? 3600000 : 0)).toISOString() },
      });
    }
    if (scenario === "Claude Code cache") {
      f.write(".claude.json", {
        oauthAccount: { accountUuid: "test-account" },
        cachedUsageUtilization: { accountUuid: "test-account", fetchedAtMs: Date.now(), utilization: f.usage },
      });
    }
    f.options.forceRefresh = scenario === "forced refresh";
    const result = await getUsageLimits(f.options);
    // Assert after the call: the limits fetcher catches errors thrown by fetchImpl.
    assert.equal(f.requests.filter((host) => host === "api.anthropic.com").length, 0);
    assertCustom(result.claude);
    assert.equal(f.requests.length, 0, "custom backends also skip Anthropic service-status probes");
  });
}

test("backend changes bypass cached aggregates and preserve each custom origin", async (t) => {
  const f = fixture(t);
  const anthropic = await getUsageLimits(f.options);
  assert.equal(anthropic.claude.five_hour.utilization, 42);
  f.requests.length = 0;
  f.write(".claude/settings.json", { env: { ANTHROPIC_BASE_URL: customUrl } });
  assertCustom((await getUsageLimits(f.options)).claude);
  f.write(".claude/settings.json", { env: { ANTHROPIC_BASE_URL: "https://second.example/v1" } });
  assertCustom((await getUsageLimits(f.options)).claude, "https://second.example");
  assert.equal(f.requests.length, 0);
  f.write(".claude/settings.json", { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } });
  assert.equal((await getUsageLimits(f.options)).claude.five_hour.utilization, 42);
});

test("custom backend does not join an in-flight Anthropic request", async (t) => {
  const f = fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(release);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const fetchImpl = f.options.fetchImpl;
  f.options.fetchImpl = async (url) => {
    if (new URL(url).hostname === "api.anthropic.com") {
      started();
      await gate;
    }
    return fetchImpl(url);
  };
  const pending = getUsageLimits(f.options);
  await ready;
  f.write(".claude/settings.json", { env: { ANTHROPIC_BASE_URL: customUrl } });
  const custom = getUsageLimits(f.options);
  release();
  const [anthropic, result] = await Promise.all([pending, custom]);
  assert.equal(anthropic.claude.five_hour.utilization, 42);
  assertCustom(result.claude);
  assertCustom((await getUsageLimits(f.options)).claude);
});

test("hidden Claude stays unconfigured even with a custom backend and OAuth", async (t) => {
  const f = fixture(t);
  f.options.env.ANTHROPIC_BASE_URL = customUrl;
  f.options.hiddenProviders = USAGE_LIMITS_PROVIDER_IDS;
  assert.deepEqual((await getUsageLimits(f.options)).claude, { configured: false });
  assert.equal(f.requests.length, 0);
});
