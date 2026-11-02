const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, beforeEach } = require("node:test");

const { getUsageLimits, resetUsageLimitsCache } = require("./helpers/usage-limits");

const CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

const EMAIL = "alpha@gmail.com";
const SWITCHED_EMAIL = "beta@gmail.com";

function inactiveRunner() {
  return { status: 1, stdout: "" };
}

function geminiIdToken(email) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "none" })}.${segment({ email })}.sig`;
}

// A minimal but real Gemini CLI login state: settings.json + oauth_creds.json
// with a future expiry_date, so no token refresh is attempted. The fixture
// places both under the exact directory the fetch side resolves from —
// env.GEMINI_HOME pinned inside the temp home — because baseOptions injects
// that env and the fetch side's resolveGeminiHome honors it over `home`. A
// host's own GEMINI_HOME can therefore never leak into the test (nor the test
// into the host).
function geminiEnv(home) {
  return { GEMINI_HOME: path.join(home, ".gemini") };
}

function buildGeminiHome({ email = EMAIL } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-gemini-cache-"));
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({}));
  fs.writeFileSync(path.join(home, ".gemini", "oauth_creds.json"), JSON.stringify({
    access_token: "ya29.test-access-token",
    id_token: geminiIdToken(email),
    refresh_token: "1//test-refresh-token",
    expiry_date: Date.now() + 3_600_000,
  }));
  return home;
}

function setGeminiAccount(home, email) {
  const credsPath = path.join(home, ".gemini", "oauth_creds.json");
  const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  creds.id_token = geminiIdToken(email);
  fs.writeFileSync(credsPath, JSON.stringify(creds));
}

function setGeminiAuthType(home, selectedType) {
  fs.writeFileSync(
    path.join(home, ".gemini", "settings.json"),
    JSON.stringify({ security: { auth: { selectedType } } }),
  );
}

function quotaBody() {
  const future = new Date(Date.now() + 20 * 3_600_000).toISOString();
  // remainingFraction values chosen so 100 - f*100 is an exact integer —
  // 0.58 would give 42.00000000000001 and trip strictEqual on the round-trip.
  return {
    buckets: [
      { modelId: "gemini-2.5-pro", remainingFraction: 0.42, resetTime: future },
      { modelId: "gemini-2.5-flash", remainingFraction: 0.9, resetTime: future },
      { modelId: "gemini-2.5-flash-lite", remainingFraction: 0.95, resetTime: future },
    ],
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

// Live Gemini quota fetch, other endpoints silent. loadCodeAssist answers a
// free tier so account_plan is pinned too; its failures are tolerated by
// design, so a 500 there would be equally valid.
function geminiFetchImpl({ quota }) {
  return (url) => {
    if (url === QUOTA_URL) return Promise.resolve().then(quota);
    if (url === CODE_ASSIST_URL) {
      return Promise.resolve(okResponse({ currentTier: { id: "free-tier" } }));
    }
    return Promise.resolve(errorResponse(500));
  };
}

function baseOptions(home, overrides = {}) {
  return {
    home,
    // env.GEMINI_HOME pinned inside the temp home (see buildGeminiHome).
    env: geminiEnv(home),
    providerTimeoutMs: 2000,
    securityRunner: inactiveRunner,
    commandRunner: inactiveRunner,
    ...overrides,
  };
}

function cachePath(home) {
  return path.join(home, ".tokentracker", "tracker", "gemini-usage-limits-cache.json");
}

function seedGeminiCache(home, entry) {
  fs.mkdirSync(path.dirname(cachePath(home)), { recursive: true });
  fs.writeFileSync(cachePath(home), JSON.stringify({ gemini: entry }));
}

describe("Gemini limits disk-cache fallback", () => {
  beforeEach(() => {
    resetUsageLimitsCache();
  });

  it("persists a live read and serves it stale when a later fetch fails", async () => {
    const home = buildGeminiHome();
    try {
      const live = await getUsageLimits(baseOptions(home, {
        fetchImpl: geminiFetchImpl({ quota: () => okResponse(quotaBody()) }),
      }));
      assert.equal(live.gemini.configured, true);
      assert.equal(live.gemini.error, null);
      assert.equal(live.gemini.stale, false);
      assert.equal(live.gemini.primary_window.used_percent, 58);
      assert.equal(live.gemini.secondary_window.used_percent, 10);
      assert.equal(live.gemini.tertiary_window.used_percent, 5);
      assert.equal(live.gemini.account_email, EMAIL);
      assert.equal(live.gemini.account_plan, "Free");
      // "Free" is deliberately normalized away (normalizePlanLabel) — the panel
      // falls back to the bare brand name for free-tier accounts.
      assert.equal(live.gemini.plan_label, null);
      assert.equal(live.gemini.provenance.source, "provider-api");
      assert.ok(!("cache_identity" in live.gemini), "internal identity marker must not reach the payload");

      // Pin the on-disk schema: identity-stamped entry, windows only.
      const disk = JSON.parse(fs.readFileSync(cachePath(home), "utf8"));
      assert.deepEqual(Object.keys(disk.gemini).sort(), [
        "account_email", "account_plan", "cached_at", "identity",
        "primary_window", "secondary_window", "tertiary_window",
      ]);
      assert.equal(disk.gemini.identity, EMAIL);
      assert.equal(disk.gemini.account_plan, "Free");
      assert.equal(disk.gemini.primary_window.used_percent, 58);

      resetUsageLimitsCache();
      const stale = await getUsageLimits(baseOptions(home, {
        fetchImpl: geminiFetchImpl({ quota: () => errorResponse(503) }),
      }));
      assert.equal(stale.gemini.configured, true);
      assert.equal(stale.gemini.error, null, "stale cache must be served instead of a red error");
      assert.equal(stale.gemini.stale, true);
      assert.equal(stale.gemini.primary_window.used_percent, 58);
      assert.equal(stale.gemini.account_email, EMAIL);
      assert.equal(stale.gemini.cached_at, live.gemini.cached_at, "stale read must preserve the original cached_at");
      assert.equal(stale.gemini.provenance.source, "disk-cache");
      assert.equal(stale.gemini.plan_label, null);
      assert.ok(!("cache_identity" in stale.gemini));
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not hide a session-expiry error behind stale cache", async () => {
    const home = buildGeminiHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: geminiFetchImpl({ quota: () => okResponse(quotaBody()) }),
      }));
      resetUsageLimitsCache();

      const expired = await getUsageLimits(baseOptions(home, {
        fetchImpl: geminiFetchImpl({ quota: () => errorResponse(401) }),
      }));
      // The cache file is on disk, but a 401 means re-login and must surface.
      assert.equal(expired.gemini.error, "Not logged in to Gemini. Run 'gemini' in Terminal to authenticate.");
      assert.notEqual(expired.gemini.stale, true);
      assert.equal(expired.gemini.primary_window, undefined);
      assert.ok(!("auth_error" in expired.gemini), "internal auth marker must not reach the payload");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("serves stale cache when the provider timeout wins the race", async () => {
    const home = buildGeminiHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: geminiFetchImpl({ quota: () => okResponse(quotaBody()) }),
      }));
      resetUsageLimitsCache();

      // A hung upstream + a tiny provider budget: the outer timeout race is the
      // common failure mode this cache exists for, and the fallback must still
      // land (identity re-derived from the local id_token).
      const stale = await getUsageLimits(baseOptions(home, {
        providerTimeoutMs: 50,
        fetchImpl: geminiFetchImpl({ quota: () => new Promise(() => {}) }),
      }));
      assert.equal(stale.gemini.configured, true);
      assert.equal(stale.gemini.error, null);
      assert.equal(stale.gemini.stale, true);
      assert.equal(stale.gemini.primary_window.used_percent, 58);
      assert.equal(stale.gemini.provenance.source, "disk-cache");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not serve another account's cached windows after an account switch", async () => {
    const home = buildGeminiHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: geminiFetchImpl({ quota: () => okResponse(quotaBody()) }),
      }));
      resetUsageLimitsCache();

      setGeminiAccount(home, SWITCHED_EMAIL);
      const switched = await getUsageLimits(baseOptions(home, {
        fetchImpl: geminiFetchImpl({ quota: () => errorResponse(500) }),
      }));
      assert.equal(switched.gemini.error, "Gemini API error: HTTP 500");
      assert.notEqual(switched.gemini.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops a cached window whose reset_at has already passed", async () => {
    const home = buildGeminiHome();
    try {
      seedGeminiCache(home, {
        identity: EMAIL,
        account_email: EMAIL,
        account_plan: "Free",
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() - 3_600_000).toISOString() },
        secondary_window: null,
        tertiary_window: null,
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: geminiFetchImpl({ quota: () => errorResponse(500) }),
      }));
      assert.equal(result.gemini.error, "Gemini API error: HTTP 500", "a rolled-over window is stale data, not a fallback");
      assert.notEqual(result.gemini.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores a cache entry older than the max-age TTL", async () => {
    const home = buildGeminiHome();
    try {
      seedGeminiCache(home, {
        identity: EMAIL,
        account_email: EMAIL,
        account_plan: "Free",
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
        secondary_window: null,
        tertiary_window: null,
        cached_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: geminiFetchImpl({ quota: () => errorResponse(500) }),
      }));
      assert.equal(result.gemini.error, "Gemini API error: HTTP 500");
      assert.notEqual(result.gemini.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not hide an unsupported auth-mode error behind stale cache", async () => {
    const home = buildGeminiHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: geminiFetchImpl({ quota: () => okResponse(quotaBody()) }),
      }));
      resetUsageLimitsCache();

      // Switching the CLI to api-key auth is a stable, actionable state — the
      // quota RPC can never succeed, and stale OAuth-era bars would mislead.
      setGeminiAuthType(home, "api-key");
      const switched = await getUsageLimits(baseOptions(home, {
        fetchImpl: geminiFetchImpl({ quota: () => errorResponse(500) }),
      }));
      assert.equal(switched.gemini.error, "Gemini API key auth not supported. Use Google account (OAuth) instead.");
      assert.notEqual(switched.gemini.stale, true);
      assert.ok(!("auth_error" in switched.gemini), "internal auth marker must not reach the payload");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
