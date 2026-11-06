"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, beforeEach } = require("node:test");

const {
  clearCacheFile,
  createLimitsCache,
  parseTimeMs,
  stripInternalMarkers,
  withLimitsCacheFallback,
} = require("../src/lib/limits-cache");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "limits-cache-test-"));
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function iso(ms) {
  return new Date(ms).toISOString();
}

function windowAt(resetMs, used = 40, limit = 100) {
  return { used_percent: (used / limit) * 100, reset_at: resetMs === null ? null : iso(resetMs) };
}

// The standard cursor-family shape: one account partition, three windows,
// two scalar fields — the configuration shared by most providers.
function standardCache(home) {
  return createLimitsCache({
    file: "test-usage-limits-cache.json",
    key: "test",
    fields: { plan_label: "string", parallel_limit: "number" },
    windowKeys: ["primary_window", "secondary_window"],
    identityField: "identity",
    identityRequired: true,
  });
}

describe("limits-cache parseTimeMs", () => {
  it("parses ISO stamps and rejects everything else", () => {
    assert.equal(parseTimeMs("2026-01-01T00:00:00.000Z"), Date.parse("2026-01-01T00:00:00.000Z"));
    assert.equal(parseTimeMs(""), null);
    assert.equal(parseTimeMs("not-a-date"), null);
    assert.equal(parseTimeMs(123), null);
    assert.equal(parseTimeMs(null), null);
  });
});

describe("limits-cache standard provider cache", () => {
  let home;
  let cache;
  beforeEach(() => {
    home = tmpHome();
    cache = standardCache(home);
  });

  it("round-trips a written record and serves it stale", () => {
    const now = 1_000_000_000_000;
    cache.write({
      configured: true,
      error: null,
      plan_label: "Pro",
      parallel_limit: 5,
      primary_window: windowAt(now + 3 * HOUR),
      secondary_window: windowAt(now + 20 * DAY),
    }, { home, nowMs: now, identity: "acct-1" });

    const cached = cache.read({ home, nowMs: now + HOUR, identity: "acct-1" });
    assert.ok(cached, "cache hit expected");
    assert.equal(cached.configured, true);
    assert.equal(cached.error, null);
    assert.equal(cached.plan_label, "Pro");
    assert.equal(cached.parallel_limit, 5);
    assert.equal(cached.stale, true);
    assert.equal(cached.cached_at, iso(now));
  });

  it("refuses write and read without an identity", () => {
    const now = 1_000_000_000_000;
    cache.write({ configured: true, error: null, primary_window: windowAt(now + HOUR) },
      { home, nowMs: now, identity: null });
    assert.equal(fs.existsSync(cache.path({ home })), false, "no identity → no file");
    assert.equal(cache.read({ home, nowMs: now, identity: null }), null);
  });

  it("never serves another account's entry", () => {
    const now = 1_000_000_000_000;
    cache.write({ configured: true, error: null, primary_window: windowAt(now + HOUR) },
      { home, nowMs: now, identity: "acct-1" });
    assert.equal(cache.read({ home, nowMs: now + 1, identity: "acct-2" }), null);
  });

  it("refuses to write error-shaped or windowless records", () => {
    const now = 1_000_000_000_000;
    cache.write({ configured: true, error: "fetch failed", primary_window: windowAt(now + HOUR) },
      { home, nowMs: now, identity: "acct-1" });
    cache.write({ configured: true, error: null, primary_window: null },
      { home, nowMs: now, identity: "acct-1" });
    cache.write({ configured: false, primary_window: windowAt(now + HOUR) },
      { home, nowMs: now, identity: "acct-1" });
    assert.equal(fs.existsSync(cache.path({ home })), false);
  });

  it("rejects snapshots older than the max-age TTL and stamps from the future beyond skew", () => {
    const now = 1_000_000_000_000;
    cache.write({ configured: true, error: null, primary_window: windowAt(now + HOUR) },
      { home, nowMs: now, identity: "acct-1" });
    assert.equal(cache.read({ home, nowMs: now + 7 * DAY + 1, identity: "acct-1" }), null);
    assert.equal(cache.read({ home, nowMs: now - 61_000, identity: "acct-1" }), null,
      "future stamp beyond +60s skew is rejected");
    assert.ok(cache.read({ home, nowMs: now - 60_000, identity: "acct-1" }),
      "a stamp within +60s skew still reads");
  });

  it("drops windows whose reset has passed and null when no window survives", () => {
    const now = 1_000_000_000_000;
    cache.write({
      configured: true, error: null,
      primary_window: windowAt(now - HOUR),
      secondary_window: windowAt(now + HOUR),
    }, { home, nowMs: now, identity: "acct-1" });
    const cached = cache.read({ home, nowMs: now + 1, identity: "acct-1" });
    assert.equal(cached.primary_window, null, "rolled-over window is dropped");
    assert.deepEqual(cached.secondary_window, windowAt(now + HOUR));

    cache.write({ configured: true, error: null, primary_window: windowAt(now - HOUR) },
      { home, nowMs: now, identity: "acct-1" });
    assert.equal(cache.read({ home, nowMs: now + 1, identity: "acct-1" }), null);
  });

  it("keeps undated windows within the global max-age by default", () => {
    const now = 1_000_000_000_000;
    cache.write({
      configured: true, error: null,
      primary_window: { used_percent: 40, reset_at: null },
    }, { home, nowMs: now, identity: "acct-1" });
    assert.ok(cache.read({ home, nowMs: now + 6 * DAY, identity: "acct-1" }));
    assert.equal(cache.read({ home, nowMs: now + 8 * DAY, identity: "acct-1" }), null,
      "the global max-age bounds undated windows");
  });

  it("bounds undated windows by unknownResetTtlMs when configured", () => {
    const cache12h = createLimitsCache({
      file: "test-unknown-reset-cache.json",
      key: "test",
      windowKeys: ["primary_window"],
      unknownResetTtlMs: 12 * HOUR,
    });
    const now = 1_000_000_000_000;
    cache12h.write({ configured: true, error: null, primary_window: { used_percent: 40 } },
      { home, nowMs: now });
    assert.ok(cache12h.read({ home, nowMs: now + 11 * HOUR }));
    assert.equal(cache12h.read({ home, nowMs: now + 13 * HOUR }), null);
  });
});

describe("limits-cache parameter space", () => {
  let home;
  beforeEach(() => { home = tmpHome(); });

  it("reads unix-seconds reset stamps (codex style)", () => {
    const cache = createLimitsCache({
      file: "test-unix-cache.json",
      key: "test",
      windowKeys: ["primary_window"],
      resetTimeMode: "unix-seconds",
    });
    const now = 1_000_000_000_000;
    cache.write({
      configured: true, error: null,
      primary_window: { used_percent: 40, reset_at: Math.floor((now + HOUR) / 1000) },
    }, { home, nowMs: now });
    assert.ok(cache.read({ home, nowMs: now + 1 }));
    cache.write({
      configured: true, error: null,
      primary_window: { used_percent: 40, reset_at: Math.floor((now - HOUR) / 1000) },
    }, { home, nowMs: now });
    assert.equal(cache.read({ home, nowMs: now + 1 }), null);
  });

  it("supports a flat payload and fail-open identity (ark style)", () => {
    const cache = createLimitsCache({
      file: "test-flat-cache.json",
      key: null,
      fields: { plan_label: "string", profile_identity: "string" },
      windowKeys: ["primary_window"],
      identityField: "profile_identity",
      maxAgeMs: null,
      unknownResetTtlMs: 12 * HOUR,
      cachedFlag: true,
      stale: true,
      source: { const: "disk-cache" },
    });
    const now = 1_000_000_000_000;
    cache.write({
      configured: true, error: null,
      plan_label: "Max", profile_identity: "p-1",
      primary_window: { used_percent: 40, reset_at: iso(now + HOUR) },
    }, { home, nowMs: now });

    const raw = JSON.parse(fs.readFileSync(cache.path({ home }), "utf8"));
    assert.ok(!("test" in raw), "flat payload has no wrapper key");

    const cached = cache.read({ home, nowMs: now + 1, identity: "p-1" });
    assert.equal(cached.cached, true);
    assert.equal(cached.stale, true);
    assert.equal(cached.source, "disk-cache");
    // Fail-open: an unknown identity (profile show also failed) still serves.
    assert.ok(cache.read({ home, nowMs: now + 1, identity: null }));
    assert.equal(cache.read({ home, nowMs: now + 1, identity: "p-2" }), null,
      "a known different identity must not match");
  });

  it("lets a future-dated window outlive the global max-age (qoder gate)", () => {
    const cache = createLimitsCache({
      file: "test-gate-cache.json",
      key: "test",
      windowKeys: ["primary_window", "secondary_window"],
      sparseWindowKeys: ["secondary_window"],
      maxAgeMs: 7 * DAY,
      maxAgeGate: "ifNoDatedSurvivor",
      unknownResetTtlMs: 12 * HOUR,
      stale: "byAge",
      freshTtlMs: 10 * 60 * 1000,
      cachedFlag: true,
      source: "provenance",
      fields: { plan_label: "string", quota_exceeded: "boolTrue", source: "string" },
    });
    const now = 1_000_000_000_000;
    cache.write({
      configured: true, error: null,
      plan_label: "Pro", quota_exceeded: true,
      source: "local-ipc",
      primary_window: windowAt(now + 30 * DAY),
    }, { home, nowMs: now });

    // Sparse window: absent tertiary-like key stays absent on write.
    const raw = JSON.parse(fs.readFileSync(cache.path({ home }), "utf8")).test;
    assert.ok(!("secondary_window" in raw), "sparse key omitted when absent");

    // Fresh hit: honest provenance, stale false.
    const fresh = cache.read({ home, nowMs: now + 5 * 60 * 1000 });
    assert.equal(fresh.stale, false);
    assert.equal(fresh.source, "local-ipc");
    assert.equal(fresh.cached, true);
    assert.equal(fresh.quota_exceeded, true);

    // A future-dated window outlives the global max-age…
    const old = cache.read({ home, nowMs: now + 10 * DAY });
    assert.ok(old, "dated survivor bypasses the global max-age");
    assert.equal(old.stale, true);
    assert.equal(old.source, "disk-cache", "stale hits report the disk cache");

    // …while an undated-only snapshot does not.
    cache.write({
      configured: true, error: null,
      primary_window: { used_percent: 40, reset_at: iso(now + HOUR) },
    }, { home, nowMs: now });
    cache.write({
      configured: true, error: null,
      primary_window: { used_percent: 40, reset_at: null },
    }, { home, nowMs: now });
    assert.equal(cache.read({ home, nowMs: now + 8 * DAY }), null);
  });

  it("supports source-dependent max-age (opencode-go style)", () => {
    const cache = createLimitsCache({
      file: "test-source-age-cache.json",
      key: "test",
      windowKeys: ["primary_window"],
      maxAgeMs: (raw) => raw?.source === "local-estimate" ? HOUR : 7 * DAY,
      fields: { source: { read: (raw) => typeof raw?.source === "string" ? raw.source : "api", write: (r) => r?.source || "api" } },
    });
    const now = 1_000_000_000_000;
    cache.write({ configured: true, error: null, primary_window: { used_percent: 40 } },
      { home, nowMs: now });
    // Written without a source → read default "api" → 7d bound.
    const raw = JSON.parse(fs.readFileSync(cache.path({ home }), "utf8")).test;
    assert.equal(raw.source, "api");
    assert.ok(cache.read({ home, nowMs: now + 2 * HOUR }));
    // A local-estimate snapshot expires within the hour.
    cache.write({ configured: true, error: null, source: "local-estimate", primary_window: { used_percent: 40 } },
      { home, nowMs: now });
    assert.equal(cache.read({ home, nowMs: now + 2 * HOUR }), null);
  });

  it("honors dirOverride so a caller-supplied tracker dir wins", () => {
    const cache = createLimitsCache({
      file: "test-dir-override-cache.json",
      key: "test",
      windowKeys: ["primary_window"],
      dirOverride: "trackerDir",
    });
    const now = 1_000_000_000_000;
    const trackerDir = fs.mkdtempSync(path.join(os.tmpdir(), "limits-cache-dir-"));
    cache.write({ configured: true, error: null, primary_window: windowAt(now + HOUR) },
      { home, nowMs: now, trackerDir });
    assert.ok(fs.existsSync(path.join(trackerDir, "test-dir-override-cache.json")),
      "the override dir receives the file");
    assert.equal(fs.existsSync(cache.path({ home })), false, "the default dir does not");
    assert.ok(cache.read({ home, nowMs: now + 1, trackerDir }));
    // Without the override the dir is silently ignored again.
    assert.equal(cache.read({ home, nowMs: now + 1 }), null);
  });

  it("honors a custom writeGuard (ark: no window check)", () => {
    const cache = createLimitsCache({
      file: "test-guard-cache.json",
      key: null,
      fields: { plan_label: "string" },
      windowKeys: ["primary_window"],
      writeGuard: (record) => Boolean(record?.configured) && !record.error,
    });
    const now = 1_000_000_000_000;
    cache.write({ configured: true, error: null, plan_label: "Max" }, { home, nowMs: now });
    assert.ok(fs.existsSync(cache.path({ home })), "guard allows the write");
    // The per-window gate still applies on read: a windowless record is never
    // servable — mirroring ark, whose normalizer throws on windowless payloads
    // upstream, making the relaxed guard latent rather than behavioral.
    assert.equal(cache.read({ home, nowMs: now + 1, identity: null }), null);
  });
});

describe("limits-cache storage primitives", () => {
  it("clear removes the file without throwing when absent", () => {
    const home = tmpHome();
    const cache = standardCache(home);
    const now = Date.now();
    cache.write({ configured: true, error: null, primary_window: windowAt(now + HOUR) },
      { home, nowMs: now, identity: "acct-1" });
    assert.ok(fs.existsSync(cache.path({ home })));
    clearCacheFile(cache.path({ home }));
    clearCacheFile(cache.path({ home }), "second clear is a no-op");
    assert.equal(fs.existsSync(cache.path({ home })), false);
  });
});

describe("stripInternalMarkers", () => {
  it("removes only the listed plumbing markers", () => {
    const stripped = stripInternalMarkers({
      configured: true, cache_identity: "acct", auth_error: true, config_error: true,
      primary_window: { used_percent: 40 },
    }, ["cache_identity", "auth_error"]);
    assert.deepEqual(stripped, { configured: true, config_error: true, primary_window: { used_percent: 40 } });
    assert.equal(stripInternalMarkers(null, ["cache_identity"]), null);
    assert.deepEqual(stripInternalMarkers({ configured: true }, ["cache_identity"]), { configured: true });
  });
});

describe("withLimitsCacheFallback", () => {
  let home;
  let cache;
  let writes;
  beforeEach(() => {
    home = tmpHome();
    cache = standardCache(home);
    writes = [];
    // Spy on writes so assertions can check them without re-reading files.
    const realWrite = cache.write.bind(cache);
    cache.write = (record, opts) => { writes.push({ record, opts }); realWrite(record, opts); };
  });

  function slot(ok, extra = {}) {
    return ok
      ? { configured: true, error: null, plan_label: "Live", primary_window: windowAt(Date.now() + HOUR), ...extra }
      : { configured: true, error: "fetch failed", ...extra };
  }

  it("stamps a live success fresh and writes the cache", async () => {
    const now = 1_000_000_000_000;
    const out = await withLimitsCacheFallback(slot(true), {
      cache, home, nowMs: now,
      resolveWriteIdentity: () => "acct-1",
      resolveReadIdentity: () => "acct-1",
    });
    assert.equal(out.stale, false);
    assert.equal(out.cached_at, iso(now));
    assert.equal(out.plan_label, "Live");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].opts.identity, "acct-1");
    assert.ok(cache.read({ home, nowMs: now + 1, identity: "acct-1" }), "cache persisted");
  });

  it("never writes when the write-identity hook refuses", async () => {
    const now = 1_000_000_000_000;
    await withLimitsCacheFallback(slot(true), {
      cache, home, nowMs: now,
      resolveWriteIdentity: () => null,
    });
    assert.equal(writes.length, 0);
    assert.equal(fs.existsSync(cache.path({ home })), false);
  });

  it("skips the write for a superseded fetch generation", async () => {
    const now = 1_000_000_000_000;
    await withLimitsCacheFallback(slot(true), {
      cache, home, nowMs: now,
      isCurrentGeneration: () => false,
      resolveWriteIdentity: () => "acct-1",
    });
    assert.equal(writes.length, 0);
  });

  it("serves the cache on a transient failure and strips markers", async () => {
    const now = 1_000_000_000_000;
    cache.write({ configured: true, error: null, plan_label: "Cached", primary_window: windowAt(now + 2 * HOUR) },
      { home, nowMs: now - HOUR, identity: "acct-1" });
    const out = await withLimitsCacheFallback(slot(false, { cache_identity: "acct-1", auth_error: false }), {
      cache, home, nowMs: now + HOUR,
      resolveWriteIdentity: () => "acct-1",
      resolveReadIdentity: () => "acct-1",
    });
    assert.equal(out.plan_label, "Cached", "replace merge serves the cached record");
    assert.equal(out.stale, true);
    assert.ok(!("cache_identity" in out), "plumbing markers are stripped");
    assert.ok(!("auth_error" in out));
  });

  it("keeps the failed slot when the cache is missing or identity-gated away", async () => {
    const now = 1_000_000_000_000;
    const out = await withLimitsCacheFallback(slot(false), {
      cache, home, nowMs: now,
      resolveReadIdentity: () => "acct-1",
    });
    assert.equal(out.error, "fetch failed");
    // A switched account must not see the previous account's entry.
    cache.write({ configured: true, error: null, primary_window: windowAt(now + HOUR) },
      { home, nowMs: now, identity: "acct-1" });
    const switched = await withLimitsCacheFallback(slot(false), {
      cache, home, nowMs: now + 1,
      resolveReadIdentity: () => "acct-2",
    });
    assert.equal(switched.error, "fetch failed");
  });

  it("overlays cached windows on a failed slot carrying sidecar fields", async () => {
    const now = 1_000_000_000_000;
    cache.write({ configured: true, error: null, plan_label: "Cached", primary_window: windowAt(now + 2 * HOUR) },
      { home, nowMs: now, identity: "acct-1" });
    const out = await withLimitsCacheFallback(
      { configured: true, error: "timeout", otel_probe: "ok" }, {
        cache, home, nowMs: now + HOUR,
        resolveReadIdentity: () => "acct-1",
        merge: "overlay",
      });
    assert.equal(out.plan_label, "Cached", "cached entry wins the limit fields");
    assert.equal(out.otel_probe, "ok", "sidecar fields survive the overlay");
    assert.equal(out.error, null);
  });

  it("passes actionable errors through untouched", async () => {
    const now = 1_000_000_000_000;
    cache.write({ configured: true, error: null, plan_label: "Cached", primary_window: windowAt(now + HOUR) },
      { home, nowMs: now, identity: "acct-1" });
    const out = await withLimitsCacheFallback(
      { configured: true, error: "token_expired", auth_error: true, cache_identity: "acct-1" }, {
        cache, home, nowMs: now + HOUR,
        resolveReadIdentity: () => "acct-1",
        passthrough: (s) => s.auth_error === true,
      });
    assert.equal(out.error, "token_expired", "re-login errors are never masked");
    assert.ok(!("cache_identity" in out));
  });

  it("lets beforeRead veto the fallback or override clock and identity", async () => {
    const now = Date.now() - 60_000;
    cache.write({ configured: true, error: null, primary_window: windowAt(now + HOUR) },
      { home, nowMs: now, identity: "acct-1" });
    // A mid-flight auth-mode switch must surface the error, not stale bars.
    const vetoed = await withLimitsCacheFallback(slot(false), {
      cache, home, nowMs: now,
      resolveReadIdentity: () => "acct-1",
      beforeRead: () => null,
    });
    assert.equal(vetoed.error, "fetch failed");
    // Wall-clock read (kiro style).
    const out = await withLimitsCacheFallback(slot(false), {
      cache, home, nowMs: now,
      beforeRead: () => ({ nowMs: Date.now(), identity: "acct-1" }),
    });
    assert.equal(out.error, null);
  });

  it("does not write when the fetch generation is superseded during the async write-identity lookup", async () => {
    const now = 1_000_000_000_000;
    let current = true;
    await withLimitsCacheFallback(slot(true), {
      cache, home, nowMs: now,
      isCurrentGeneration: () => current,
      resolveWriteIdentity: async () => {
        // A newer poll bumps the generation while the (copilot-style) async
        // identity re-read is still in flight: the superseded fetch must not
        // land a write after it finally resolves.
        current = false;
        return "acct-1";
      },
      resolveReadIdentity: () => "acct-1",
    });
    assert.equal(writes.length, 0, "a write from a superseded generation is poison");
    assert.equal(fs.existsSync(cache.path({ home })), false);
  });
});

// Claude-style provider: fixed object windows plus an array field that carries
// its own expiry logic (weekly_scoped). The field declares when its content
// still counts as a window survivor so windowless-looking snapshots are
// written and restored like any other.
describe("limits-cache extra survivor fields", () => {
  function scopedCache(home) {
    return createLimitsCache({
      file: "test-scoped-limits-cache.json",
      key: "scoped",
      fields: {
        label: "string",
        scoped_windows: {
          write: (record) => (Array.isArray(record?.scoped_windows) && record.scoped_windows.length > 0
            ? record.scoped_windows
            : null),
          read: (raw) => (Array.isArray(raw?.scoped_windows) && raw.scoped_windows.length > 0
            ? raw.scoped_windows
            : null),
          // An entry survives only while its own expiry lies in the future —
          // the implementer's per-entry reset gate, mirroring claude's
          // normalizeClaudeCachedScopedWeekly.
          survivor: (value, { nowMs }) => Array.isArray(value) &&
            value.some((entry) => entry && Number.isFinite(entry.expiryMs) && entry.expiryMs > nowMs),
        },
      },
      windowKeys: ["primary_window"],
    });
  }

  let home;
  let cache;
  beforeEach(() => {
    home = tmpHome();
    cache = scopedCache(home);
  });

  it("writes and serves a snapshot carrying only the extra survivor field", () => {
    const now = 1_000_000_000_000;
    cache.write({
      configured: true,
      error: null,
      label: "Fable",
      scoped_windows: [{ expiryMs: now + 2 * HOUR }],
    }, { home, nowMs: now });

    const cached = cache.read({ home, nowMs: now + HOUR });
    assert.ok(cached, "scoped-only snapshot must be served on a later failure");
    assert.equal(cached.label, "Fable");
    assert.deepEqual(cached.scoped_windows, [{ expiryMs: now + 2 * HOUR }]);
    assert.equal(cached.primary_window, null);
  });

  it("drops a snapshot whose extra-field entries have all expired", () => {
    const now = 1_000_000_000_000;
    const expiredOnly = {
      label: "Fable",
      scoped_windows: [{ expiryMs: now - HOUR }],
      cached_at: iso(now - 30_000),
    };
    fs.mkdirSync(path.dirname(cache.path({ home })), { recursive: true });
    fs.writeFileSync(cache.path({ home }), JSON.stringify({ scoped: expiredOnly }));
    assert.equal(cache.read({ home, nowMs: now }), null,
      "all-expired survivors must refuse the snapshot, never serve an empty shell");
  });

  it("still refuses to write a snapshot with no surfaces at all", () => {
    const now = 1_000_000_000_000;
    cache.write({
      configured: true,
      error: null,
      label: "Fable",
      scoped_windows: [],
    }, { home, nowMs: now });
    assert.equal(fs.existsSync(cache.path({ home })), false, "no window state, no cache write");
  });
});
