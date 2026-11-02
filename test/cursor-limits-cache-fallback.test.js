const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { describe, it, beforeEach } = require("node:test");

const { getUsageLimits, resetUsageLimitsCache } = require("./helpers/usage-limits");

const CURSOR_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const CURSOR_SAND_ACCESS_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandAccessStatus";
const CURSOR_SAND_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus";

const USER_ID = "user_alpha";
const AUTH_ID = `auth0|${USER_ID}`;
const JWT = "test-jwt-token-0123456789";

function inactiveRunner() {
  return { status: 1, stdout: "" };
}

// A minimal but real Cursor login state: the access token lives in state.vscdb
// (read back through the same sqlite3 CLI / node:sqlite path production uses)
// and the account id in ~/.cursor/cli-config.json, which extractCursorAuth
// prefers over decoding the JWT. fetchCursorLimits resolves paths against the
// running platform, so the fixture uses that platform's Cursor layout.
function buildCursorHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-cache-"));
  const appDir = process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Cursor")
    : path.join(home, ".config", "Cursor");
  const dbPath = path.join(appDir, "User", "globalStorage", "state.vscdb");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/accessToken", JWT);
  db.close();
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".cursor", "cli-config.json"),
    JSON.stringify({ authInfo: { authId: AUTH_ID } }),
  );
  return home;
}

function setCursorAccount(home, authId) {
  fs.writeFileSync(
    path.join(home, ".cursor", "cli-config.json"),
    JSON.stringify({ authInfo: { authId } }),
  );
}

function usageSummaryBody() {
  return {
    membershipType: "pro",
    billingCycleStart: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    billingCycleEnd: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    individualUsage: { plan: { totalPercentUsed: 42 } },
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

// Live Cursor fetch, other providers silent.
function cursorFetchImpl({ summary }) {
  return (url) => {
    if (url === CURSOR_SUMMARY_URL) return Promise.resolve().then(summary);
    if (url === CURSOR_SAND_ACCESS_URL || url === CURSOR_SAND_USAGE_URL) {
      // Sand failures are isolated by design; a plain 500 keeps them null.
      return Promise.resolve(errorResponse(500));
    }
    return Promise.resolve(errorResponse(500));
  };
}

function baseOptions(home, overrides = {}) {
  return {
    home,
    platform: "linux",
    providerTimeoutMs: 2000,
    securityRunner: inactiveRunner,
    commandRunner: inactiveRunner,
    ...overrides,
  };
}

function cachePath(home) {
  return path.join(home, ".tokentracker", "tracker", "cursor-usage-limits-cache.json");
}

function seedCursorCache(home, entry) {
  fs.mkdirSync(path.dirname(cachePath(home)), { recursive: true });
  fs.writeFileSync(cachePath(home), JSON.stringify({ cursor: entry }));
}

describe("Cursor limits disk-cache fallback", () => {
  beforeEach(() => {
    resetUsageLimitsCache();
  });

  it("persists a live read and serves it stale when a later fetch fails", async () => {
    const home = buildCursorHome();
    try {
      const live = await getUsageLimits(baseOptions(home, {
        fetchImpl: cursorFetchImpl({ summary: () => okResponse(usageSummaryBody()) }),
      }));
      assert.equal(live.cursor.configured, true);
      assert.equal(live.cursor.error, null);
      assert.equal(live.cursor.stale, false);
      assert.equal(live.cursor.primary_window.used_percent, 42);
      assert.equal(live.cursor.plan_label, "Pro");
      assert.equal(live.cursor.provenance.source, "provider-api");
      assert.ok(!("cache_identity" in live.cursor), "internal identity marker must not reach the payload");

      // Pin the on-disk schema: identity-stamped entry, windows only.
      const disk = JSON.parse(fs.readFileSync(cachePath(home), "utf8"));
      assert.deepEqual(Object.keys(disk.cursor).sort(), [
        "cached_at", "identity", "membership_type", "primary_window",
        "quaternary_window", "secondary_window", "tertiary_window",
      ]);
      assert.equal(disk.cursor.identity, USER_ID);
      assert.equal(disk.cursor.membership_type, "pro");
      assert.equal(disk.cursor.primary_window.used_percent, 42);

      resetUsageLimitsCache();
      const stale = await getUsageLimits(baseOptions(home, {
        fetchImpl: cursorFetchImpl({ summary: () => errorResponse(503) }),
      }));
      assert.equal(stale.cursor.configured, true);
      assert.equal(stale.cursor.error, null, "stale cache must be served instead of a red error");
      assert.equal(stale.cursor.stale, true);
      assert.equal(stale.cursor.primary_window.used_percent, 42);
      assert.equal(stale.cursor.cached_at, live.cursor.cached_at, "stale read must preserve the original cached_at");
      assert.equal(stale.cursor.provenance.source, "disk-cache");
      assert.equal(stale.cursor.plan_label, "Pro");
      assert.ok(!("cache_identity" in stale.cursor));
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not hide a session-expiry error behind stale cache", async () => {
    const home = buildCursorHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: cursorFetchImpl({ summary: () => okResponse(usageSummaryBody()) }),
      }));
      resetUsageLimitsCache();

      const expired = await getUsageLimits(baseOptions(home, {
        fetchImpl: cursorFetchImpl({ summary: () => errorResponse(401) }),
      }));
      // The cache file is on disk, but a 401 means re-login and must surface.
      assert.equal(expired.cursor.error, "Cursor session expired — re-login in Cursor to refresh");
      assert.notEqual(expired.cursor.stale, true);
      assert.equal(expired.cursor.primary_window, undefined);
      assert.ok(!("auth_error" in expired.cursor), "internal auth marker must not reach the payload");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("serves stale cache when the provider timeout wins the race", async () => {
    const home = buildCursorHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: cursorFetchImpl({ summary: () => okResponse(usageSummaryBody()) }),
      }));
      resetUsageLimitsCache();

      // A hung upstream + a tiny provider budget: the outer timeout race is the
      // common failure mode this cache exists for, and the fallback must still
      // land (identity re-derived from the local state DB).
      const stale = await getUsageLimits(baseOptions(home, {
        providerTimeoutMs: 50,
        fetchImpl: cursorFetchImpl({ summary: () => new Promise(() => {}) }),
      }));
      assert.equal(stale.cursor.configured, true);
      assert.equal(stale.cursor.error, null);
      assert.equal(stale.cursor.stale, true);
      assert.equal(stale.cursor.primary_window.used_percent, 42);
      assert.equal(stale.cursor.provenance.source, "disk-cache");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not serve another account's cached windows after an account switch", async () => {
    const home = buildCursorHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: cursorFetchImpl({ summary: () => okResponse(usageSummaryBody()) }),
      }));
      resetUsageLimitsCache();

      setCursorAccount(home, "github|424242");
      const switched = await getUsageLimits(baseOptions(home, {
        fetchImpl: cursorFetchImpl({ summary: () => errorResponse(500) }),
      }));
      assert.equal(switched.cursor.error, "Cursor API returned 500");
      assert.notEqual(switched.cursor.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops a cached window whose reset_at has already passed", async () => {
    const home = buildCursorHome();
    try {
      seedCursorCache(home, {
        identity: USER_ID,
        membership_type: "pro",
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() - 3_600_000).toISOString() },
        secondary_window: null,
        tertiary_window: null,
        quaternary_window: null,
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: cursorFetchImpl({ summary: () => errorResponse(500) }),
      }));
      assert.equal(result.cursor.error, "Cursor API returned 500", "a rolled-over window is stale data, not a fallback");
      assert.notEqual(result.cursor.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores a cache entry older than the max-age TTL", async () => {
    const home = buildCursorHome();
    try {
      seedCursorCache(home, {
        identity: USER_ID,
        membership_type: "pro",
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
        secondary_window: null,
        tertiary_window: null,
        quaternary_window: null,
        cached_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: cursorFetchImpl({ summary: () => errorResponse(500) }),
      }));
      assert.equal(result.cursor.error, "Cursor API returned 500");
      assert.notEqual(result.cursor.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
