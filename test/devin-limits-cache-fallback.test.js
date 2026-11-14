"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, beforeEach } = require("node:test");

const {
  getUsageLimits,
  resetUsageLimitsCache,
} = require("./helpers/usage-limits");

const { resolveDevinCacheIdentity } = require("../src/lib/devin-limits");

const TEST_TOKEN = "devin-test-session-token";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

// Resets are pinned to the future relative to the run: a cached window whose
// reset has already passed is dropped, so a "now-relative" fixture is the only
// stable shape across slow CI machines.
function futureResetUnix(secondsFromNow) {
  return Math.floor(Date.now() / 1000) + secondsFromNow;
}

function planStatusBody({
  planName = "Pro",
  billingStrategy = "BILLING_STRATEGY_QUOTA",
  dailyRemaining = 58,
  weeklyRemaining = 30,
} = {}) {
  return {
    planStatus: {
      planInfo: {
        planName,
        billingStrategy,
      },
      dailyQuotaRemainingPercent: dailyRemaining,
      weeklyQuotaRemainingPercent: weeklyRemaining,
      dailyQuotaResetAtUnix: String(futureResetUnix(86_400)),
      weeklyQuotaResetAtUnix: String(futureResetUnix(7 * 86_400)),
    },
  };
}

function makeDevinHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-devin-cache-"));
  const home = path.join(tmp, "home");
  const credentialsPath = path.join(home, ".local", "share", "devin", "credentials.toml");
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, `windsurf_api_key = "${TEST_TOKEN}"\n`);
  return { tmp, home, credentialsPath };
}

function cachePath(home) {
  return path.join(home, ".tokentracker", "tracker", "devin-usage-limits-cache.json");
}

function seedDevinCache(home, entry) {
  fs.mkdirSync(path.dirname(cachePath(home)), { recursive: true });
  fs.writeFileSync(cachePath(home), JSON.stringify({ devin: { identity: resolveDevinCacheIdentity({ home, env: {} }), ...entry } }));
}

// Live Devin fetch, other providers silent.
function devinFetchImpl(handler, { seen = null } = {}) {
  return async (url) => {
    if (String(url).includes("GetPlanStatus")) {
      if (seen) seen.calls += 1;
      return handler();
    }
    return jsonResponse(404, {});
  };
}

function baseOptions(home, overrides = {}) {
  return {
    home,
    env: { CLAUDE_CONFIG_DIR: path.join(home, "no-claude") },
    devinEnabled: true,
    fetchImpl: devinFetchImpl(() => jsonResponse(404, {})),
    ...overrides,
  };
}

describe("Devin limits disk-cache fallback", () => {
  beforeEach(() => {
    resetUsageLimitsCache();
  });

  it("persists a live read and serves it stale when a later fetch fails", async () => {
    const { tmp, home } = makeDevinHome();
    try {
      const live = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(200, planStatusBody())),
      }));
      assert.equal(live.devin.configured, true);
      assert.equal(live.devin.error, null);
      assert.equal(live.devin.stale, false);
      assert.equal(live.devin.plan_label, "Pro");
      assert.equal(live.devin.primary_window.used_percent, 42);
      assert.equal(live.devin.secondary_window.used_percent, 70);
      assert.equal(live.devin.provenance.source, "provider-api");

      // The identity describes the credential file, never its secret contents.
      const disk = JSON.parse(fs.readFileSync(cachePath(home), "utf8"));
      assert.deepEqual(Object.keys(disk.devin).sort(), [
        "cached_at", "identity", "plan_label", "primary_window", "secondary_window",
      ]);
      assert.equal(typeof disk.devin.identity, "string");
      assert.equal(JSON.stringify(disk).includes(TEST_TOKEN), false);
      assert.equal("cache_identity" in live.devin, false);
      assert.equal(disk.devin.plan_label, "Pro");
      assert.equal(disk.devin.primary_window.used_percent, 42);

      resetUsageLimitsCache();
      const stale = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(503, {})),
      }));
      assert.equal(stale.devin.configured, true);
      assert.equal(stale.devin.error, null, "stale cache must be served instead of a red error");
      assert.equal(stale.devin.stale, true);
      assert.equal(stale.devin.plan_label, "Pro");
      assert.equal(stale.devin.primary_window.used_percent, 42);
      assert.equal(stale.devin.secondary_window.used_percent, 70);
      assert.equal(stale.devin.cached_at, live.devin.cached_at, "stale read must preserve the original cached_at");
      assert.equal(stale.devin.provenance.source, "disk-cache");
      assert.equal("cache_identity" in stale.devin, false);
      assert.equal("identity" in stale.devin, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not hide a session-expiry error behind stale cache", async () => {
    const { tmp, home } = makeDevinHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(200, planStatusBody())),
      }));
      resetUsageLimitsCache();

      const expired = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(401, {})),
      }));
      // The cache file is on disk, but a 401 means re-login and must surface.
      assert.equal(expired.devin.configured, true);
      assert.match(expired.devin.error, /devin auth login/);
      assert.equal(expired.devin.auth_action_required, "reauth");
      assert.notEqual(expired.devin.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not mask an ambiguous HTTP 400 behind stale cache", async () => {
    const { tmp, home } = makeDevinHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(200, planStatusBody())),
      }));
      resetUsageLimitsCache();

      const ambiguous = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(400, { code: "invalid_argument" })),
      }));
      // docs/devin-limits.md pins 400 as an ambiguous rejection, not proof of
      // expiry and not a transient blip — it surfaces instead of stale bars.
      assert.equal(ambiguous.devin.error, "Devin quota request was rejected (HTTP 400).");
      assert.notEqual(ambiguous.devin.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps serving stale cache on a rate-limited poll", async () => {
    const { tmp, home } = makeDevinHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(200, planStatusBody())),
      }));
      resetUsageLimitsCache();

      const limited = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(429, {})),
      }));
      assert.equal(limited.devin.configured, true);
      assert.equal(limited.devin.error, null);
      assert.equal(limited.devin.stale, true);
      assert.equal(limited.devin.primary_window.used_percent, 42);
      assert.equal(limited.devin.provenance.source, "disk-cache");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("clears the disk cache when a plan stops reporting quota windows", async () => {
    const { tmp, home } = makeDevinHome();
    try {
      seedDevinCache(home, {
        plan_label: "Pro",
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
        secondary_window: null,
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });

      // The account moves to a legacy billing strategy: the successful read
      // has no windows, so the prior quota entry must not survive to serve
      // the former plan's bars on a later blip.
      const live = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(200, planStatusBody({
          billingStrategy: "BILLING_STRATEGY_ACU",
        }))),
      }));
      assert.equal(live.devin.primary_window, null);
      assert.ok(!fs.existsSync(cachePath(home)), "a windowless successful read must clear the prior entry");

      resetUsageLimitsCache();
      const failed = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(503, {})),
      }));
      assert.equal(failed.devin.error, "Devin quota request was rejected (HTTP 503).");
      assert.notEqual(failed.devin.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves stale cache when the provider timeout wins the race", async () => {
    const { tmp, home } = makeDevinHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(200, planStatusBody())),
      }));
      resetUsageLimitsCache();

      // A hung upstream + a tiny provider budget: the outer timeout race is the
      // common failure mode this cache exists for, and the fallback must still
      // land from the assemble step.
      const stale = await getUsageLimits(baseOptions(home, {
        providerTimeoutMs: 50,
        fetchImpl: devinFetchImpl(() => new Promise(() => {})),
      }));
      assert.equal(stale.devin.configured, true);
      assert.equal(stale.devin.error, null);
      assert.equal(stale.devin.stale, true);
      assert.equal(stale.devin.primary_window.used_percent, 42);
      assert.equal(stale.devin.provenance.source, "disk-cache");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not mask a broken local sign-in behind stale cache", async () => {
    const { tmp, home, credentialsPath } = makeDevinHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(200, planStatusBody())),
      }));
      resetUsageLimitsCache();

      // Swap the credentials file for a directory: every read fails with
      // EISDIR on every platform — a deterministic "unreadable" fixture.
      fs.rmSync(credentialsPath);
      fs.mkdirSync(credentialsPath);
      const seen = { calls: 0 };
      const broken = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(200, planStatusBody()), { seen }),
      }));
      assert.equal(seen.calls, 0, "a broken credentials file must fail before any request");
      assert.match(broken.devin.error, /could not read/i);
      assert.match(broken.devin.error, /devin auth login/);
      assert.ok(!broken.devin.error.includes(tmp), "leaked fs path");
      assert.notEqual(broken.devin.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  for (const timing of ["before", "during"]) {
    for (const failure of ["HTTP 503", "timeout"]) {
      it(`refuses another credential's cache after replacement ${timing} a ${failure}`, async () => {
        const { tmp, home, credentialsPath } = makeDevinHome();
        try {
          await getUsageLimits(baseOptions(home, {
            fetchImpl: devinFetchImpl(() => jsonResponse(200, planStatusBody())),
          }));
          resetUsageLimitsCache();
          const replaceCredentials = () => {
            // Keep the stat, same-length edit and timestamp restoration on
            // one opened file, even if the path is concurrently replaced.
            const descriptor = fs.openSync(credentialsPath, "r+");
            try {
              const original = fs.fstatSync(descriptor);
              fs.writeFileSync(descriptor, `windsurf_api_key = "${TEST_TOKEN.replace("test", "next")}"\n`);
              fs.futimesSync(descriptor, original.atime, original.mtime);
            } finally {
              fs.closeSync(descriptor);
            }
          };
          if (timing === "before") replaceCredentials();
          const result = await getUsageLimits(baseOptions(home, {
            providerTimeoutMs: failure === "timeout" ? 50 : 2000,
            fetchImpl: devinFetchImpl(() => {
              if (timing === "during") replaceCredentials();
              return failure === "timeout" ? new Promise(() => {}) : jsonResponse(503, {});
            }),
          }));
          assert.ok(result.devin.error);
          assert.notEqual(result.devin.stale, true);
          assert.equal(result.devin.primary_window, undefined);
        } finally {
          resetUsageLimitsCache();
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  }

  it("does not attribute a successful in-flight response to replacement credentials", async () => {
    const { tmp, home, credentialsPath } = makeDevinHome();
    try {
      await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => {
          const replacement = `${credentialsPath}.new`;
          fs.writeFileSync(replacement, 'windsurf_api_key = "another-account"\n');
          fs.renameSync(replacement, credentialsPath);
          return jsonResponse(200, planStatusBody());
        }),
      }));
      assert.equal(fs.existsSync(cachePath(home)), false);
      resetUsageLimitsCache();
      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(503, {})),
      }));
      assert.ok(result.devin.error);
      assert.notEqual(result.devin.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses legacy unpartitioned cache entries", async () => {
    const { tmp, home } = makeDevinHome();
    try {
      seedDevinCache(home, {
        identity: undefined,
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });
      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(503, {})),
      }));
      assert.ok(result.devin.error);
      assert.notEqual(result.devin.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  for (const change of ["remove", "corrupt", "xdg"]) {
    it(`refuses cache after a mid-request credential change: ${change}`, async () => {
      const { tmp, home, credentialsPath } = makeDevinHome();
      const options = baseOptions(home);
      try {
        await getUsageLimits({
          ...options,
          fetchImpl: devinFetchImpl(() => jsonResponse(200, planStatusBody())),
        });
        resetUsageLimitsCache();
        const result = await getUsageLimits({
          ...options,
          fetchImpl: devinFetchImpl(() => {
            if (change === "remove") fs.rmSync(credentialsPath);
            if (change === "corrupt") fs.writeFileSync(credentialsPath, "no sign-in token");
            if (change === "xdg") {
              options.env.XDG_DATA_HOME = path.join(tmp, "xdg");
              const replacement = path.join(options.env.XDG_DATA_HOME, "devin", "credentials.toml");
              fs.mkdirSync(path.dirname(replacement), { recursive: true });
              fs.writeFileSync(replacement, 'windsurf_api_key = "another-account"\n');
            }
            return jsonResponse(503, {});
          }),
        });
        assert.ok(result.devin.error);
        assert.notEqual(result.devin.stale, true);
        assert.equal(result.devin.primary_window, undefined);
      } finally {
        resetUsageLimitsCache();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  for (const survivingWindow of [false, true]) {
    it(`checks resets after the failed request (${survivingWindow ? "partial" : "full"} rollover)`, async (t) => {
      const { tmp, home } = makeDevinHome();
      const startedAt = Date.now();
      t.mock.method(Date, "now", () => startedAt);
      try {
        seedDevinCache(home, {
          primary_window: { used_percent: 42, reset_at: new Date(startedAt + 1000).toISOString() },
          secondary_window: survivingWindow
            ? { used_percent: 70, reset_at: new Date(startedAt + 86_400_000).toISOString() }
            : null,
          cached_at: new Date(startedAt - 60_000).toISOString(),
        });
        const result = await getUsageLimits(baseOptions(home, {
          fetchImpl: devinFetchImpl(() => {
            t.mock.method(Date, "now", () => startedAt + 2000);
            return jsonResponse(503, {});
          }),
        }));
        if (survivingWindow) {
          assert.equal(result.devin.error, null);
          assert.equal(result.devin.stale, true);
          assert.equal(result.devin.primary_window, null);
          assert.equal(result.devin.secondary_window.used_percent, 70);
        } else {
          assert.ok(result.devin.error);
          assert.notEqual(result.devin.stale, true);
        }
      } finally {
        resetUsageLimitsCache();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it("drops a cached window whose reset_at has already passed", async () => {
    const { tmp, home } = makeDevinHome();
    try {
      seedDevinCache(home, {
        plan_label: "Pro",
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() - 3_600_000).toISOString() },
        secondary_window: null,
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(503, {})),
      }));
      assert.equal(
        result.devin.error,
        "Devin quota request was rejected (HTTP 503).",
        "a rolled-over window is stale data, not a fallback",
      );
      assert.notEqual(result.devin.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores a cache entry older than the max-age TTL", async () => {
    const { tmp, home } = makeDevinHome();
    try {
      seedDevinCache(home, {
        plan_label: "Pro",
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
        secondary_window: null,
        cached_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(503, {})),
      }));
      assert.equal(result.devin.error, "Devin quota request was rejected (HTTP 503).");
      assert.notEqual(result.devin.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not cache a legacy billing plan without quota windows", async () => {
    const { tmp, home } = makeDevinHome();
    try {
      const live = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(200, planStatusBody({
          billingStrategy: "BILLING_STRATEGY_ACU",
        }))),
      }));
      assert.equal(live.devin.configured, true);
      assert.equal(live.devin.plan_label, "Pro");
      assert.equal(live.devin.primary_window, null);
      assert.equal(live.devin.secondary_window, null);
      assert.ok(!fs.existsSync(cachePath(home)), "a windowless plan must not write a cache entry");

      resetUsageLimitsCache();
      const failed = await getUsageLimits(baseOptions(home, {
        fetchImpl: devinFetchImpl(() => jsonResponse(503, {})),
      }));
      assert.equal(failed.devin.error, "Devin quota request was rejected (HTTP 503).");
      assert.notEqual(failed.devin.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the opted-out selection a bare sentinel even with a cache on disk", async () => {
    const { tmp, home } = makeDevinHome();
    try {
      seedDevinCache(home, {
        plan_label: "Pro",
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
        secondary_window: null,
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const disabled = await getUsageLimits(baseOptions(home, { devinEnabled: false }));
      assert.deepEqual(disabled.devin, { configured: false });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
