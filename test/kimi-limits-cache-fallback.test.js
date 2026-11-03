"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, beforeEach } = require("node:test");

const { getUsageLimits, resetUsageLimitsCache } = require("./helpers/usage-limits");
const { resolveKimiProfile } = require("../src/lib/kimi-profile");

const MAINLAND = {
  oauthHost: "https://auth.kimi.com",
  baseUrl: "https://api.kimi.com/coding/v1",
  key: "kimi-code",
};
const GLOBAL = {
  oauthHost: "https://auth.kimi.ai",
  baseUrl: "https://api.kimi.ai/coding/v1",
  key: "kimi-code-env-0e4f99c69cc27850",
};

function inactiveRunner() {
  return { status: 1, stdout: "" };
}

// A minimal but real Kimi login: the managed Code profile's config.toml picks the
// endpoint pair, and resolveKimiProfile then derives the endpoint-scoped credential
// slot the fetch side reads. The fixture places both files via production's own
// resolver with the same arguments the fetch side receives ({ home, env }) —
// baseOptions injects an empty env, because KIMI_HOME / KIMI_CODE_HOME in the host
// environment would silently redirect both sides out of the temp dir.
function writeKimiProfile(home, region, { expiresAt = 4_000_000_000, refreshToken = true } = {}) {
  fs.mkdirSync(path.join(home, ".kimi-code"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".kimi-code", "config.toml"),
    `[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "${region.baseUrl}"\n` +
    `[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "oauth/${region.key}"\noauth_host = "${region.oauthHost}"\n`,
  );
  const profile = resolveKimiProfile({ home, env: {} });
  assert.equal(profile.error, null, "fixture must build a supported profile");
  fs.mkdirSync(path.dirname(profile.credsPath), { recursive: true });
  const creds = { access_token: "kimi-access-token", expires_at: expiresAt };
  if (refreshToken) creds.refresh_token = "kimi-refresh-token";
  fs.writeFileSync(profile.credsPath, JSON.stringify(creds), { mode: 0o600 });
  return profile;
}

function profileIdentity(profile) {
  return `${profile.home}::${profile.oauthHost}`;
}

function futureIso(hours) {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

function usageBody() {
  return {
    user: { membership: { level: "LEVEL_INTERMEDIATE" } },
    subType: "TYPE_SUBMIT",
    parallel: { limit: 5 },
    usage: { used: 4, limit: 10, resetTime: futureIso(3) },
    limits: [{ detail: { used: 40, limit: 100, resetTime: futureIso(3) } }],
    totalQuota: { used: 44, limit: 110, resetTime: futureIso(24 * 20) },
  };
}

const okResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const errorResponse = (status) => ({
  ok: false,
  status,
  json: async () => ({}),
});

// Live Kimi usage fetch + token refresh, other providers silent.
function kimiFetchImpl(profile, { usage, refresh } = {}) {
  return (url) => {
    if (url === `${profile.baseUrl}/usages`) return Promise.resolve().then(usage);
    if (url === `${profile.oauthHost}/api/oauth/token`) return Promise.resolve().then(refresh);
    return Promise.resolve(errorResponse(500));
  };
}

function baseOptions(home, overrides = {}) {
  return {
    home,
    // Empty env: the fetch side and the cache-identity fallback must resolve
    // Kimi's files inside the temp home, not under a host KIMI_HOME.
    env: {},
    providerTimeoutMs: 2000,
    securityRunner: inactiveRunner,
    commandRunner: inactiveRunner,
    ...overrides,
  };
}

function cachePath(home) {
  return path.join(home, ".tokentracker", "tracker", "kimi-usage-limits-cache.json");
}

function seedKimiCache(home, profile, entry) {
  fs.mkdirSync(path.dirname(cachePath(home)), { recursive: true });
  fs.writeFileSync(
    cachePath(home),
    JSON.stringify({ kimi: { identity: profileIdentity(profile), ...entry } }),
  );
}

describe("Kimi limits disk-cache fallback", () => {
  beforeEach(() => {
    resetUsageLimitsCache();
  });

  it("persists a live read and serves it stale when a later fetch fails", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kimi-cache-"));
    try {
      const profile = writeKimiProfile(home, MAINLAND);
      const live = await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(profile, { usage: () => okResponse(usageBody()) }),
      }));
      assert.equal(live.kimi.configured, true);
      assert.equal(live.kimi.error, null);
      assert.equal(live.kimi.stale, false);
      assert.equal(live.kimi.primary_window.used_percent, 40);
      assert.equal(live.kimi.secondary_window.used_percent, 40);
      assert.equal(live.kimi.tertiary_window.used_percent, 40);
      assert.equal(live.kimi.membership_level, "LEVEL_INTERMEDIATE");
      assert.equal(live.kimi.subscription_type, "TYPE_SUBMIT");
      assert.equal(live.kimi.parallel_limit, 5);
      // Kimi shows the bare brand (issue #130): no plan_label is derived.
      assert.equal(live.kimi.plan_label, null);
      assert.equal(live.kimi.provenance.source, "provider-api");
      assert.ok(!("cache_identity" in live.kimi), "internal identity marker must not reach the payload");

      // Pin the on-disk schema: identity-stamped entry, windows only.
      const disk = JSON.parse(fs.readFileSync(cachePath(home), "utf8"));
      assert.deepEqual(Object.keys(disk.kimi).sort(), [
        "cached_at", "identity", "membership_level", "parallel_limit",
        "primary_window", "secondary_window", "subscription_type", "tertiary_window",
      ]);
      assert.equal(disk.kimi.identity, profileIdentity(profile));
      assert.equal(disk.kimi.primary_window.used_percent, 40);

      resetUsageLimitsCache();
      const stale = await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(profile, { usage: () => errorResponse(503) }),
      }));
      assert.equal(stale.kimi.configured, true);
      assert.equal(stale.kimi.error, null, "stale cache must be served instead of a red error");
      assert.equal(stale.kimi.stale, true);
      assert.equal(stale.kimi.primary_window.used_percent, 40);
      assert.equal(stale.kimi.membership_level, "LEVEL_INTERMEDIATE");
      assert.equal(stale.kimi.cached_at, live.kimi.cached_at, "stale read must preserve the original cached_at");
      assert.equal(stale.kimi.provenance.source, "disk-cache");
      assert.ok(!("cache_identity" in stale.kimi));
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not hide a re-login error behind stale cache", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kimi-cache-"));
    try {
      const profile = writeKimiProfile(home, MAINLAND);
      await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(profile, { usage: () => okResponse(usageBody()) }),
      }));
      resetUsageLimitsCache();

      // An expired access token sends the fetcher into the refresh flow; a 401
      // there means the login is gone and must surface instead of stale bars.
      writeKimiProfile(home, MAINLAND, { expiresAt: 1 });
      const expired = await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(profile, {
          refresh: () => errorResponse(401),
          usage: () => errorResponse(500),
        }),
      }));
      assert.equal(expired.kimi.error, "Not logged in to Kimi. Run 'kimi' in Terminal to authenticate.");
      assert.notEqual(expired.kimi.stale, true);
      assert.equal(expired.kimi.primary_window, undefined);
      assert.ok(!("auth_error" in expired.kimi), "internal auth marker must not reach the payload");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not hide token_expired behind stale cache when no refresh token exists", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kimi-cache-"));
    try {
      const profile = writeKimiProfile(home, MAINLAND);
      await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(profile, { usage: () => okResponse(usageBody()) }),
      }));
      resetUsageLimitsCache();

      writeKimiProfile(home, MAINLAND, { refreshToken: false });
      const expired = await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(profile, { usage: () => errorResponse(401) }),
      }));
      assert.equal(expired.kimi.error, "token_expired");
      assert.notEqual(expired.kimi.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("serves stale cache when the provider timeout wins the race", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kimi-cache-"));
    try {
      const profile = writeKimiProfile(home, MAINLAND);
      await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(profile, { usage: () => okResponse(usageBody()) }),
      }));
      resetUsageLimitsCache();

      // A hung upstream + a tiny provider budget: the outer timeout race is the
      // common failure mode this cache exists for, and the fallback must still
      // land (identity re-derived from the local Kimi profile).
      const stale = await getUsageLimits(baseOptions(home, {
        providerTimeoutMs: 50,
        fetchImpl: kimiFetchImpl(profile, { usage: () => new Promise(() => {}) }),
      }));
      assert.equal(stale.kimi.configured, true);
      assert.equal(stale.kimi.error, null);
      assert.equal(stale.kimi.stale, true);
      assert.equal(stale.kimi.primary_window.used_percent, 40);
      assert.equal(stale.kimi.provenance.source, "disk-cache");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not serve another profile's cached windows after switching regions", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kimi-cache-"));
    try {
      const mainland = writeKimiProfile(home, MAINLAND);
      await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(mainland, { usage: () => okResponse(usageBody()) }),
      }));
      resetUsageLimitsCache();

      // Point the managed profile at the global endpoints; the global slot has
      // its own identity, so the mainland entry must not be served.
      const global = writeKimiProfile(home, GLOBAL);
      const switched = await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(global, { usage: () => errorResponse(500) }),
      }));
      assert.equal(switched.kimi.error, "Kimi API returned 500");
      assert.notEqual(switched.kimi.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops a cached window whose reset_at has already passed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kimi-cache-"));
    try {
      const profile = writeKimiProfile(home, MAINLAND);
      seedKimiCache(home, profile, {
        membership_level: "LEVEL_INTERMEDIATE",
        subscription_type: "TYPE_SUBMIT",
        parallel_limit: 5,
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() - 3_600_000).toISOString() },
        secondary_window: null,
        tertiary_window: null,
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(profile, { usage: () => errorResponse(500) }),
      }));
      assert.equal(result.kimi.error, "Kimi API returned 500", "a rolled-over window is stale data, not a fallback");
      assert.notEqual(result.kimi.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores a cache entry older than the max-age TTL", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kimi-cache-"));
    try {
      const profile = writeKimiProfile(home, MAINLAND);
      seedKimiCache(home, profile, {
        membership_level: "LEVEL_INTERMEDIATE",
        subscription_type: "TYPE_SUBMIT",
        parallel_limit: 5,
        primary_window: { used_percent: 42, reset_at: futureIso(24) },
        secondary_window: null,
        tertiary_window: null,
        cached_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(profile, { usage: () => errorResponse(500) }),
      }));
      assert.equal(result.kimi.error, "Kimi API returned 500");
      assert.notEqual(result.kimi.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not hide a profile misconfiguration behind stale cache", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kimi-cache-"));
    try {
      const profile = writeKimiProfile(home, MAINLAND);
      await getUsageLimits(baseOptions(home, {
        fetchImpl: kimiFetchImpl(profile, { usage: () => okResponse(usageBody()) }),
      }));
      resetUsageLimitsCache();

      // An unsupported endpoint override is an actionable config problem; the
      // card must show it even though a last-good entry sits on disk.
      const broken = await getUsageLimits(baseOptions(home, {
        env: { KIMI_CODE_BASE_URL: "https://api.example.com/coding/v1" },
        fetchImpl: kimiFetchImpl(profile, { usage: () => okResponse(usageBody()) }),
      }));
      assert.equal(
        broken.kimi.error,
        "Unsupported Kimi quota endpoints; configure a matching official mainland or global profile",
      );
      assert.notEqual(broken.kimi.stale, true);
      assert.ok(!("config_error" in broken.kimi), "internal config marker must not reach the payload");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
