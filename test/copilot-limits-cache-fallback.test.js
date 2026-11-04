const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, beforeEach } = require("node:test");

const { getUsageLimits, resetUsageLimitsCache, readCopilotAuth } = require("./helpers/usage-limits");

const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";

const LOGIN = "octocat";

function futureDateOnly(daysAhead) {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

function inactiveRunner() {
  return { status: 1, stdout: "" };
}

// A minimal but real Copilot login state: the OAuth token lives in hosts.json
// (the plaintext path older editors write), alongside the non-secret GitHub
// login that production stamps into the cache as its partition identity.
// No sqlite/keychain involved, so the fixture runs on every engine.
function buildCopilotHome({ user = LOGIN } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-copilot-cache-"));
  writeCopilotAccount(home, user);
  return home;
}

function copilotConfigPath(home) {
  return path.join(home, ".config", "github-copilot", "hosts.json");
}

function writeCopilotAccount(home, user) {
  fs.mkdirSync(path.dirname(copilotConfigPath(home)), { recursive: true });
  fs.writeFileSync(copilotConfigPath(home), JSON.stringify({
    "github.com": {
      oauth_token: "gho_test_token_0123456789abcdef",
      ...(user ? { user } : {}),
    },
  }));
}

function copilotUserBody() {
  return {
    copilot_plan: "individual",
    quota_reset_date: futureDateOnly(20),
    quota_snapshots: {
      premium_interactions: { entitlement: 100, remaining: 75, percent_remaining: 75 },
      chat: { entitlement: 200, remaining: 100, percent_remaining: 50 },
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

// Live Copilot fetch, other providers silent.
function copilotFetchImpl({ user }) {
  return (url) => {
    if (url === COPILOT_USER_URL) return Promise.resolve().then(user);
    return Promise.resolve(errorResponse(500));
  };
}

function baseOptions(home, overrides = {}) {
  return {
    home,
    env: {},
    providerTimeoutMs: 2000,
    securityRunner: inactiveRunner,
    commandRunner: inactiveRunner,
    ...overrides,
  };
}

function cachePath(home) {
  return path.join(home, ".tokentracker", "tracker", "copilot-usage-limits-cache.json");
}

function seedCopilotCache(home, entry) {
  fs.mkdirSync(path.dirname(cachePath(home)), { recursive: true });
  fs.writeFileSync(cachePath(home), JSON.stringify({ copilot: entry }));
}

describe("Copilot limits disk-cache fallback", () => {
  beforeEach(() => {
    resetUsageLimitsCache();
  });

  it("persists a live read and serves it stale when a later fetch fails", async () => {
    const home = buildCopilotHome();
    try {
      const live = await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => okResponse(copilotUserBody()) }),
      }));
      assert.equal(live.copilot.configured, true);
      assert.equal(live.copilot.error, null);
      assert.equal(live.copilot.stale, false);
      assert.equal(live.copilot.primary_window.used_percent, 25);
      assert.equal(live.copilot.secondary_window.used_percent, 50);
      assert.equal(live.copilot.plan_label, "Individual");
      assert.equal(live.copilot.provenance.source, "provider-api");
      assert.ok(!("cache_identity" in live.copilot), "internal identity marker must not reach the payload");

      // Pin the on-disk schema: identity-stamped entry, windows only.
      const disk = JSON.parse(fs.readFileSync(cachePath(home), "utf8"));
      assert.deepEqual(Object.keys(disk.copilot).sort(), [
        "cached_at", "identity", "plan_name", "primary_window", "secondary_window",
      ]);
      assert.equal(disk.copilot.identity, LOGIN);
      assert.equal(disk.copilot.plan_name, "Individual");
      assert.equal(disk.copilot.primary_window.used_percent, 25);

      resetUsageLimitsCache();
      const stale = await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => errorResponse(503) }),
      }));
      assert.equal(stale.copilot.configured, true);
      assert.equal(stale.copilot.error, null, "stale cache must be served instead of a red error");
      assert.equal(stale.copilot.stale, true);
      assert.equal(stale.copilot.primary_window.used_percent, 25);
      assert.equal(stale.copilot.cached_at, live.copilot.cached_at, "stale read must preserve the original cached_at");
      assert.equal(stale.copilot.provenance.source, "disk-cache");
      assert.equal(stale.copilot.plan_label, "Individual");
      assert.ok(!("cache_identity" in stale.copilot));
      // The otel probe fields ride on every slot result and must survive the overlay.
      assert.equal(typeof stale.copilot.otel_default_dir, "string");
      assert.equal(stale.copilot.otel_has_files, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not hide a token-rejection error behind stale cache", async () => {
    const home = buildCopilotHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => okResponse(copilotUserBody()) }),
      }));
      resetUsageLimitsCache();

      const rejected = await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => errorResponse(401) }),
      }));
      // The cache file is on disk, but a 401 means re-authentication and must surface.
      assert.equal(
        rejected.copilot.error,
        "GitHub Copilot token rejected. Re-authenticate via GitHub Copilot CLI/extension.",
      );
      assert.notEqual(rejected.copilot.stale, true);
      assert.equal(rejected.copilot.primary_window, undefined);
      assert.ok(!("auth_error" in rejected.copilot), "internal auth marker must not reach the payload");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("serves stale cache when the provider timeout wins the race", async () => {
    const home = buildCopilotHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => okResponse(copilotUserBody()) }),
      }));
      resetUsageLimitsCache();

      // A hung upstream + a tiny provider budget: the outer timeout race is the
      // common failure mode this cache exists for, and the fallback must still
      // land (identity re-derived from the local auth store).
      const stale = await getUsageLimits(baseOptions(home, {
        providerTimeoutMs: 50,
        fetchImpl: copilotFetchImpl({ user: () => new Promise(() => {}) }),
      }));
      assert.equal(stale.copilot.configured, true);
      assert.equal(stale.copilot.error, null);
      assert.equal(stale.copilot.stale, true);
      assert.equal(stale.copilot.primary_window.used_percent, 25);
      assert.equal(stale.copilot.provenance.source, "disk-cache");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not serve another account's cached windows after an account switch", async () => {
    const home = buildCopilotHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => okResponse(copilotUserBody()) }),
      }));
      resetUsageLimitsCache();

      writeCopilotAccount(home, "someotherlogin");
      const switched = await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => errorResponse(500) }),
      }));
      assert.equal(switched.copilot.error, "GitHub Copilot API error: HTTP 500");
      assert.notEqual(switched.copilot.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  for (const nextLogin of ["another-login", ""]) {
    for (const failure of ["HTTP 500", "timeout"]) {
      it(`refuses stale windows when the login changes to ${nextLogin || "unknown"} during a ${failure}`, async () => {
        const home = buildCopilotHome();
        try {
          await getUsageLimits(baseOptions(home, {
            fetchImpl: copilotFetchImpl({ user: () => okResponse(copilotUserBody()) }),
          }));
          resetUsageLimitsCache();

          const result = await getUsageLimits(baseOptions(home, {
            providerTimeoutMs: failure === "timeout" ? 50 : 2000,
            fetchImpl: copilotFetchImpl({ user: () => {
              // The request already captured the old token and login.
              writeCopilotAccount(home, nextLogin);
              return failure === "timeout" ? new Promise(() => {}) : errorResponse(500);
            } }),
          }));
          assert.ok(result.copilot.error);
          assert.notEqual(result.copilot.stale, true);
          assert.equal(result.copilot.primary_window, undefined);
        } finally {
          resetUsageLimitsCache();
          fs.rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }

  for (const survivingWindow of [false, true]) {
    it(`checks resets after the failed request (${survivingWindow ? "partial" : "full"} rollover)`, async (t) => {
      const home = buildCopilotHome();
      const startedAt = Date.now();
      t.mock.method(Date, "now", () => startedAt);
      try {
        seedCopilotCache(home, {
          identity: LOGIN,
          plan_name: "Individual",
          primary_window: { used_percent: 25, reset_at: new Date(startedAt + 1000).toISOString() },
          secondary_window: survivingWindow
            ? { used_percent: 50, reset_at: new Date(startedAt + 86_400_000).toISOString() }
            : null,
          cached_at: new Date(startedAt - 60_000).toISOString(),
        });
        const result = await getUsageLimits(baseOptions(home, {
          fetchImpl: copilotFetchImpl({ user: () => {
            t.mock.method(Date, "now", () => startedAt + 2000);
            return errorResponse(500);
          } }),
        }));
        if (survivingWindow) {
          assert.equal(result.copilot.error, null);
          assert.equal(result.copilot.stale, true);
          assert.equal(result.copilot.primary_window, null);
          assert.equal(result.copilot.secondary_window.used_percent, 50);
        } else {
          assert.equal(result.copilot.error, "GitHub Copilot API error: HTTP 500");
          assert.notEqual(result.copilot.stale, true);
          assert.equal(result.copilot.primary_window, undefined);
        }
      } finally {
        resetUsageLimitsCache();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("drops a cached window whose reset_at has already passed", async () => {
    const home = buildCopilotHome();
    try {
      seedCopilotCache(home, {
        identity: LOGIN,
        plan_name: "Individual",
        primary_window: { used_percent: 25, reset_at: new Date(Date.now() - 3_600_000).toISOString() },
        secondary_window: null,
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => errorResponse(500) }),
      }));
      assert.equal(result.copilot.error, "GitHub Copilot API error: HTTP 500", "a rolled-over window is stale data, not a fallback");
      assert.notEqual(result.copilot.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("serves the surviving window when only one reset has rolled over", async () => {
    const home = buildCopilotHome();
    try {
      seedCopilotCache(home, {
        identity: LOGIN,
        plan_name: "Individual",
        primary_window: { used_percent: 25, reset_at: new Date(Date.now() - 3_600_000).toISOString() },
        secondary_window: { used_percent: 50, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => errorResponse(500) }),
      }));
      assert.equal(result.copilot.error, null);
      assert.equal(result.copilot.stale, true);
      assert.equal(result.copilot.primary_window, null);
      assert.equal(result.copilot.secondary_window.used_percent, 50);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores a cache entry older than the max-age TTL", async () => {
    const home = buildCopilotHome();
    try {
      seedCopilotCache(home, {
        identity: LOGIN,
        plan_name: "Individual",
        primary_window: { used_percent: 25, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
        secondary_window: null,
        cached_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => errorResponse(500) }),
      }));
      assert.equal(result.copilot.error, "GitHub Copilot API error: HTTP 500");
      assert.notEqual(result.copilot.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("never writes a cache entry when the auth source carries no login", async () => {
    const home = buildCopilotHome({ user: "" });
    try {
      assert.equal(readCopilotAuth({ home }).identity, null);

      const live = await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => okResponse(copilotUserBody()) }),
      }));
      assert.equal(live.copilot.error, null);
      assert.ok(!fs.existsSync(cachePath(home)), "an unreadable login must not pin bars in place");

      resetUsageLimitsCache();
      const failed = await getUsageLimits(baseOptions(home, {
        fetchImpl: copilotFetchImpl({ user: () => errorResponse(500) }),
      }));
      assert.equal(failed.copilot.error, "GitHub Copilot API error: HTTP 500");
      assert.notEqual(failed.copilot.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
