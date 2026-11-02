const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, beforeEach } = require("node:test");

const { getUsageLimits, resetUsageLimitsCache } = require("./helpers/usage-limits");
const { resolveGrokHome } = require("../src/lib/grok-limits");

const GROK_BILLING_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

const ACCOUNT_SUBJECT = "grok-user-alpha";
const SCOPE_KEY = "https://auth.x.ai::client-abc";

function inactiveRunner() {
  return { status: 1, stdout: "" };
}

// Minimal unsigned JWT whose payload carries the OIDC subject; production
// reads only `sub` out of it for the cache-partition id. No expires_at: the
// key never trips the refresh path.
function subjectToken(subject) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub: subject })}.signature`;
}

// The fixture places auth.json via production's own resolveGrokHome with the
// same arguments the fetch side receives ({ home, env }) — baseOptions injects
// an empty env, because a host GROK_HOME / TOKENTRACKER_GROK_HOME override
// would silently redirect both sides out of the temp dir.
function buildGrokHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-grok-cache-"));
  const authPath = path.join(resolveGrokHome({ home, env: {} }), "auth.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({
    [SCOPE_KEY]: { key: subjectToken(ACCOUNT_SUBJECT) },
  }));
  return home;
}

function setGrokAccount(home, subject) {
  const authPath = path.join(resolveGrokHome({ home, env: {} }), "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({
    [SCOPE_KEY]: { key: subjectToken(subject) },
  }));
}

// An auth.json whose access token is opaque (no JWT structure / no sub claim).
function buildGrokHomeOpaqueToken() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-grok-cache-"));
  const authPath = path.join(resolveGrokHome({ home, env: {} }), "auth.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({
    [SCOPE_KEY]: { key: "opaque-access-token" },
  }));
  return home;
}

function billingBody() {
  return {
    subscriptionTier: "supergrok",
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        end: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      },
      creditUsagePercent: 42,
      productUsage: [
        { product: "GrokBuild", usagePercent: 30 },
        { product: "GrokChat", usagePercent: 12 },
      ],
    },
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

// Live Grok billing fetch, other providers silent.
function grokFetchImpl({ billing }) {
  return (url) => {
    if (url === GROK_BILLING_CREDITS_URL) return Promise.resolve().then(billing);
    return Promise.resolve(errorResponse(500));
  };
}

function baseOptions(home, overrides = {}) {
  return {
    home,
    // Empty env: the fetch side and the cache-identity fallback must resolve
    // Grok's files inside the temp home, not under a host GROK_HOME override.
    env: {},
    providerTimeoutMs: 2000,
    securityRunner: inactiveRunner,
    commandRunner: inactiveRunner,
    ...overrides,
  };
}

function cachePath(home) {
  return path.join(home, ".tokentracker", "tracker", "grok-usage-limits-cache.json");
}

function seedGrokCache(home, entry) {
  fs.mkdirSync(path.dirname(cachePath(home)), { recursive: true });
  fs.writeFileSync(cachePath(home), JSON.stringify({ grok: entry }));
}

describe("Grok limits disk-cache fallback", () => {
  beforeEach(() => {
    resetUsageLimitsCache();
  });

  it("persists a live read and serves it stale when a later fetch fails", async () => {
    const home = buildGrokHome();
    try {
      const live = await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({ billing: () => okResponse(billingBody()) }),
      }));
      assert.equal(live.grok.configured, true);
      assert.equal(live.grok.error, null);
      assert.equal(live.grok.stale, false);
      assert.equal(live.grok.primary_window.used_percent, 42);
      assert.equal(live.grok.plan_label, "SuperGrok");
      assert.equal(live.grok.period_type, "weekly");
      assert.equal(live.grok.products.length, 2);
      assert.equal(live.grok.provenance.source, "provider-api");
      assert.ok(!("cache_identity" in live.grok), "internal identity marker must not reach the payload");

      // Pin the on-disk schema: identity-stamped entry, full normalized payload.
      const disk = JSON.parse(fs.readFileSync(cachePath(home), "utf8"));
      assert.deepEqual(Object.keys(disk.grok).sort(), [
        "billing_period_start", "cached_at", "credit_usage_percent", "identity",
        "monthly_credits_limit", "monthly_credits_used", "on_demand_cap",
        "on_demand_used", "period_type", "plan_label", "primary_window",
        "products", "secondary_window",
      ]);
      assert.equal(disk.grok.identity, ACCOUNT_SUBJECT);
      assert.equal(disk.grok.plan_label, "SuperGrok");
      assert.equal(disk.grok.primary_window.used_percent, 42);
      assert.equal(disk.grok.products.length, 2);

      resetUsageLimitsCache();
      const stale = await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({ billing: () => errorResponse(500) }),
      }));
      assert.equal(stale.grok.configured, true);
      assert.equal(stale.grok.error, null, "stale cache must be served instead of a red error");
      assert.equal(stale.grok.stale, true);
      assert.equal(stale.grok.primary_window.used_percent, 42);
      assert.equal(stale.grok.plan_label, "SuperGrok");
      assert.equal(stale.grok.period_type, "weekly");
      assert.equal(stale.grok.products.length, 2);
      assert.equal(stale.grok.cached_at, live.grok.cached_at, "stale read must preserve the original cached_at");
      assert.equal(stale.grok.provenance.source, "disk-cache");
      assert.ok(!("cache_identity" in stale.grok));
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not hide a re-login error behind stale cache", async () => {
    const home = buildGrokHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({ billing: () => okResponse(billingBody()) }),
      }));
      resetUsageLimitsCache();

      const rejected = await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({ billing: () => errorResponse(401) }),
      }));
      // The cache file is on disk, but a 401 means re-login and must surface.
      assert.equal(
        rejected.grok.error,
        "Not logged in to Grok Build. Run `grok login` in Terminal to authenticate.",
      );
      assert.notEqual(rejected.grok.stale, true);
      assert.equal(rejected.grok.primary_window, undefined);
      assert.ok(!("auth_error" in rejected.grok), "internal auth marker must not reach the payload");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("serves stale cache when the provider timeout wins the race", async () => {
    const home = buildGrokHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({ billing: () => okResponse(billingBody()) }),
      }));
      resetUsageLimitsCache();

      // A hung upstream + a tiny provider budget: the outer timeout race is the
      // common failure mode this cache exists for, and the fallback must still
      // land (identity re-derived from auth.json when the race strips the
      // fetcher's own identity field).
      const stale = await getUsageLimits(baseOptions(home, {
        providerTimeoutMs: 50,
        fetchImpl: grokFetchImpl({ billing: () => new Promise(() => {}) }),
      }));
      assert.equal(stale.grok.configured, true);
      assert.equal(stale.grok.error, null);
      assert.equal(stale.grok.stale, true);
      assert.equal(stale.grok.primary_window.used_percent, 42);
      assert.equal(stale.grok.provenance.source, "disk-cache");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not serve another account's cached windows after an account switch", async () => {
    const home = buildGrokHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({ billing: () => okResponse(billingBody()) }),
      }));
      resetUsageLimitsCache();

      // Same auth.json scope, freshly logged-in account: the OIDC subject in
      // the new token no longer matches the cached entry's identity.
      setGrokAccount(home, "grok-user-beta");
      const switched = await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({ billing: () => errorResponse(500) }),
      }));
      assert.match(switched.grok.error, /Grok billing API returned 500/);
      assert.notEqual(switched.grok.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses the cache entirely for an opaque token without a subject", async () => {
    const home = buildGrokHomeOpaqueToken();
    try {
      // The live read succeeds (the token still authenticates billing), but no
      // identity can be derived, so nothing is written to disk.
      const live = await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({ billing: () => okResponse(billingBody()) }),
      }));
      assert.equal(live.grok.configured, true);
      assert.equal(live.grok.error, null);
      assert.equal(live.grok.primary_window.used_percent, 42);
      assert.equal(fs.existsSync(cachePath(home)), false, "an unattributable login must not write a cache entry");

      // A later failure has no fallback to serve: the scope key stays constant
      // across account switches, so it must not stand in for an identity.
      // (Seed a scope-key-stamped entry by hand — production refused to write.)
      resetUsageLimitsCache();
      fs.mkdirSync(path.dirname(cachePath(home)), { recursive: true });
      fs.writeFileSync(cachePath(home), JSON.stringify({
        grok: {
          identity: SCOPE_KEY,
          plan_label: "SuperGrok",
          primary_window: { used_percent: 42, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
          cached_at: new Date(Date.now() - 60_000).toISOString(),
        },
      }));
      const failed = await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({ billing: () => errorResponse(500) }),
      }));
      assert.match(failed.grok.error, /Grok billing API returned 500/, "a scope-key-seeded entry must not be served");
      assert.notEqual(failed.grok.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not attribute an in-flight result to an account that logged in mid-fetch", async () => {
    const home = buildGrokHomeOpaqueToken();
    try {
      // auth.json switches to another account's JWT while the billing request
      // is in flight. The finished fetch carries no identity (opaque token), so
      // the write must be refused — not re-attributed by re-reading auth.json.
      const live = await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({
          billing: () => {
            setGrokAccount(home, "grok-user-beta");
            return Promise.resolve(okResponse(billingBody()));
          },
        }),
      }));
      assert.equal(live.grok.error, null);
      assert.equal(fs.existsSync(cachePath(home)), false, "a finished fetch must not be re-attributed to a later login");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops a cached window whose reset_at has already passed", async () => {
    const home = buildGrokHome();
    try {
      seedGrokCache(home, {
        identity: ACCOUNT_SUBJECT,
        plan_label: "SuperGrok",
        period_type: "weekly",
        monthly_credits_limit: null,
        monthly_credits_used: null,
        credit_usage_percent: 42,
        on_demand_cap: null,
        on_demand_used: null,
        billing_period_start: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() - 3_600_000).toISOString() },
        secondary_window: null,
        products: [],
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({ billing: () => errorResponse(500) }),
      }));
      assert.match(result.grok.error, /Grok billing API returned 500/, "a rolled-over window is stale data, not a fallback");
      assert.notEqual(result.grok.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores a cache entry older than the max-age TTL", async () => {
    const home = buildGrokHome();
    try {
      seedGrokCache(home, {
        identity: ACCOUNT_SUBJECT,
        plan_label: "SuperGrok",
        period_type: "weekly",
        monthly_credits_limit: null,
        monthly_credits_used: null,
        credit_usage_percent: 42,
        on_demand_cap: null,
        on_demand_used: null,
        billing_period_start: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
        secondary_window: null,
        products: [],
        cached_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: grokFetchImpl({ billing: () => errorResponse(500) }),
      }));
      assert.match(result.grok.error, /Grok billing API returned 500/);
      assert.notEqual(result.grok.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
