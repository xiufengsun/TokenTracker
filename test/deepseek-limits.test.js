const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEEPSEEK_BALANCE_CACHE_TTL_MS,
  balanceNumber,
  fetchDeepseekLimits,
  keyFingerprint,
  normalizeDeepseekBalanceResponse,
  readDeepseekLimitsCache,
  resolveDeepseekLimitsCachePath,
} = require("../src/lib/deepseek-limits");
const { writeStoredApiKey } = require("../src/lib/provider-api-key-store");

const BALANCE_BODY = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "110.02",
      granted_balance: "0.00",
      topped_up_balance: "110.02",
    },
    {
      currency: "USD",
      total_balance: "15.50",
      granted_balance: "2.00",
      topped_up_balance: "13.50",
    },
  ],
};

async function makeEnv({ envKey = null, storedKey = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-deepseek-"));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = {};
  if (envKey) env.DEEPSEEK_API_KEY = envKey;
  if (storedKey) {
    // Write through the same home the fetch reads (no trackerDir override),
    // so the key lands in <home>/.tokentracker/tracker/ where the reader looks.
    await writeStoredApiKey({ provider: "deepseek", home, apiKey: storedKey });
  }
  return { tmp, home, env };
}

function fetchResponding(status, body) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return text;
      },
    };
  };
  impl.seen = seen;
  return impl;
}

describe("normalizeDeepseekBalanceResponse", () => {
  it("parses string numbers and preserves multi-currency API order", () => {
    const balances = normalizeDeepseekBalanceResponse(BALANCE_BODY);
    assert.deepEqual(balances, [
      { currency: "CNY", total: 110.02, granted: 0, topped_up: 110.02 },
      { currency: "USD", total: 15.5, granted: 2, topped_up: 13.5 },
    ]);
  });

  it("drops entries with malformed numbers or blank currency", () => {
    const balances = normalizeDeepseekBalanceResponse({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "12.5" },
        { currency: "", total_balance: "1" },
        { currency: "USD", total_balance: "not-a-number" },
        { currency: "EUR", total_balance: -3 },
      ],
    });
    assert.deepEqual(balances, [{ currency: "CNY", total: 12.5, granted: 0, topped_up: 0 }]);
  });

  it("throws on unusable payloads so the caller can fall back to cache", () => {
    assert.throws(() => normalizeDeepseekBalanceResponse(null));
    assert.throws(() => normalizeDeepseekBalanceResponse({ balance_infos: [] }));
    assert.throws(() => normalizeDeepseekBalanceResponse({ balance_infos: [{ currency: "CNY", total_balance: "1" }] }));
  });

  it("balanceNumber rejects junk and negatives but accepts numeric strings", () => {
    assert.equal(balanceNumber("110.02"), 110.02);
    assert.equal(balanceNumber(7), 7);
    assert.equal(balanceNumber("abc"), null);
    assert.equal(balanceNumber("-1"), null);
    assert.equal(balanceNumber(""), null);
    assert.equal(balanceNumber(null), null);
  });
});

describe("fetchDeepseekLimits", () => {
  it("reports configured:false when no key is available", async () => {
    const { tmp, home, env } = await makeEnv({});
    try {
      const impl = fetchResponding(200, BALANCE_BODY);
      const result = await fetchDeepseekLimits({ home, env, fetchImpl: impl });
      assert.deepEqual(result, { configured: false });
      assert.equal(impl.seen.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prefers the env key over the stored key and stamps credential_source", async () => {
    const { tmp, home, env } = await makeEnv({ envKey: "sk-env-key-123", storedKey: "sk-stored-key-456" });
    try {
      const impl = fetchResponding(200, BALANCE_BODY);
      const result = await fetchDeepseekLimits({ home, env, fetchImpl: impl });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.credential_source, "env");
      assert.equal(result.source, "provider-api");
      assert.equal(result.stale, false);
      assert.equal(result.is_available, true);
      assert.equal(result.balances.length, 2);
      assert.match(impl.seen[0].init.headers.Authorization, /^Bearer sk-env-key-123$/);
      assert.ok(impl.seen[0].url.startsWith("https://api.deepseek.com/user/balance"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to the stored key when the env var is absent", async () => {
    const { tmp, home, env } = await makeEnv({ storedKey: "sk-stored-key-456" });
    try {
      const impl = fetchResponding(200, BALANCE_BODY);
      const result = await fetchDeepseekLimits({ home, env, fetchImpl: impl });
      assert.equal(result.credential_source, "stored");
      assert.match(impl.seen[0].init.headers.Authorization, /^Bearer sk-stored-key-456$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves the last-good cache on a transient failure and keeps is_available", async () => {
    const { tmp, home, env } = await makeEnv({ envKey: "sk-live-key-123" });
    try {
      await fetchDeepseekLimits({ home, env, fetchImpl: fetchResponding(200, BALANCE_BODY) });
      const cachePath = resolveDeepseekLimitsCachePath({ home });
      assert.ok(fs.existsSync(cachePath));
      // POSIX mode bits don't exist on Windows; atomic-json.test.js has the
      // same guard.
      if (process.platform !== "win32") assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);

      const second = await fetchDeepseekLimits({ home, env, fetchImpl: fetchResponding(500, "boom") });
      assert.equal(second.configured, true);
      assert.equal(second.error, null);
      assert.equal(second.stale, true);
      assert.equal(second.source, "disk-cache");
      assert.equal(second.is_available, true);
      assert.equal(second.balances.length, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("never serves a cache written by a different API key", async () => {
    const { tmp, home, env } = await makeEnv({ envKey: "sk-live-key-123" });
    try {
      await fetchDeepseekLimits({ home, env, fetchImpl: fetchResponding(200, BALANCE_BODY) });

      // A different key must not read the previous account's balance.
      const swapped = { DEEPSEEK_API_KEY: "sk-other-key-456" };
      const impl = fetchResponding(500, "boom");
      const cross = await fetchDeepseekLimits({ home, env: swapped, fetchImpl: impl });
      assert.equal(cross.error, "DeepSeek balance API returned 500");
      assert.equal(cross.balances, undefined);

      // A cache written under the same key still falls back.
      const same = await fetchDeepseekLimits({ home, env, fetchImpl: impl });
      assert.equal(same.stale, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lets the pure TTL expire the cache (no reset window exists)", async () => {
    const { tmp, home, env } = await makeEnv({ envKey: "sk-live-key-123" });
    try {
      await fetchDeepseekLimits({ home, env, fetchImpl: fetchResponding(200, BALANCE_BODY) });
      const expired = await fetchDeepseekLimits({
        home,
        env,
        fetchImpl: fetchResponding(503, "unavailable"),
        nowMs: Date.now() + DEEPSEEK_BALANCE_CACHE_TTL_MS + 1000,
      });
      assert.equal(expired.error, "DeepSeek balance API returned 503");
      assert.equal(expired.balances, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces auth errors instead of masking them with stale cache", async () => {
    const { tmp, home, env } = await makeEnv({ envKey: "sk-live-key-123" });
    try {
      await fetchDeepseekLimits({ home, env, fetchImpl: fetchResponding(200, BALANCE_BODY) });
      const rejected = await fetchDeepseekLimits({ home, env, fetchImpl: fetchResponding(401, { error: { message: "Invalid credential" } }) });
      assert.equal(rejected.auth_error, true);
      assert.match(rejected.error, /rejected \(401\)/);
      assert.equal(rejected.balances, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps balances with is_available:false — a valid reading, not an error", async () => {
    const { tmp, home, env } = await makeEnv({ envKey: "sk-live-key-123" });
    try {
      const drained = { is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00" }] };
      const result = await fetchDeepseekLimits({ home, env, fetchImpl: fetchResponding(200, drained) });
      assert.equal(result.error, null);
      assert.equal(result.is_available, false);
      assert.deepEqual(result.balances, [{ currency: "CNY", total: 0, granted: 0, topped_up: 0 }]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("honors persistCache:false by leaving no disk trace", async () => {
    const { tmp, home, env } = await makeEnv({ envKey: "sk-live-key-123" });
    try {
      await fetchDeepseekLimits({ home, env, fetchImpl: fetchResponding(200, BALANCE_BODY), persistCache: false });
      assert.equal(fs.existsSync(resolveDeepseekLimitsCachePath({ home })), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("deepseek cache plumbing", () => {
  it("keyFingerprint is stable and key-sensitive", () => {
    assert.equal(keyFingerprint("sk-abc"), keyFingerprint("sk-abc"));
    assert.notEqual(keyFingerprint("sk-abc"), keyFingerprint("sk-abd"));
  });

  it("readDeepseekLimitsCache rejects a future cached_at and empty balances", async () => {
    const { tmp, home } = await makeEnv({});
    try {
      const cachePath = resolveDeepseekLimitsCachePath({ home });
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });

      // Positive control: a valid entry on this exact path is read back, so a
      // wrong path can never make the rejection cases below vacuously pass.
      fs.writeFileSync(cachePath, JSON.stringify({
        deepseek: {
          is_available: true,
          balances: [{ currency: "CNY", total: 1 }],
          cached_at: new Date().toISOString(),
        },
      }));
      const positive = readDeepseekLimitsCache({ home });
      assert.ok(positive);
      assert.equal(positive.balances.length, 1);

      fs.writeFileSync(cachePath, JSON.stringify({
        deepseek: {
          is_available: true,
          balances: [{ currency: "CNY", total: 1 }],
          cached_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        },
      }));
      assert.equal(readDeepseekLimitsCache({ home }), null);

      fs.writeFileSync(cachePath, JSON.stringify({
        deepseek: { is_available: true, balances: [], cached_at: new Date().toISOString() },
      }));
      assert.equal(readDeepseekLimitsCache({ home }), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
