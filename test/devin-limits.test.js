"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { fetchDevinLimits } = require("../src/lib/devin-limits");
const {
  getUsageLimits,
  resetUsageLimitsCache,
} = require("./helpers/usage-limits");

const TEST_TOKEN = "devin-test-session-token";

// Expected request values written independently of the implementation's
// constants so a drift in either direction is caught.
const EXPECTED_URL =
  "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function makeDevinHome({ toml = null, at } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-devin-"));
  const home = path.join(tmp, "home");
  const env = {};
  const credentialsDir =
    at === "xdg"
      ? path.join(tmp, "xdg", "devin")
      : path.join(home, ".local", "share", "devin");
  if (toml !== null && toml !== undefined) {
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(path.join(credentialsDir, "credentials.toml"), toml);
  }
  if (at === "xdg") env.XDG_DATA_HOME = path.join(tmp, "xdg");
  return { tmp, home, env };
}

const SIGNED_IN_TOML = `windsurf_api_key = "${TEST_TOKEN}"
api_server_url = "https://server.codeium.com"
devin_api_url = "https://api.devin.ai"
`;

function planStatusBody({
  planName = "Pro",
  billingStrategy = "BILLING_STRATEGY_QUOTA",
  dailyRemaining = 100,
  weeklyRemaining = 100,
  dailyReset = 1_789_200_000,
  weeklyReset = 1_789_286_400,
  hideDaily = false,
  hideWeekly = false,
} = {}) {
  return {
    planStatus: {
      planInfo: {
        planName,
        teamsTier: "TEAMS_TIER_DEVIN_PRO",
        billingStrategy,
        hideDailyQuota: hideDaily,
        hideWeeklyQuota: hideWeekly,
      },
      dailyQuotaRemainingPercent: dailyRemaining,
      weeklyQuotaRemainingPercent: weeklyRemaining,
      dailyQuotaResetAtUnix: String(dailyReset),
      weeklyQuotaResetAtUnix: String(weeklyReset),
    },
  };
}

// Fetch the limits through the public seam with a signed-in fictional home.
async function signedInLimits({ fetchImpl, toml = SIGNED_IN_TOML, at } = {}) {
  const { tmp, home, env } = makeDevinHome({ toml, at });
  try {
    return await fetchDevinLimits({ home, env, fetchImpl, enabled: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function okFetch(body = planStatusBody()) {
  return async () => jsonResponse(200, body);
}

describe("opt-in gate", () => {
  it("returns configured:false by default without reading credentials or fetching", async () => {
    // A directory where credentials.toml should be makes any read attempt
    // fail — so a stray credential read would throw instead of passing.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-devin-"));
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".local", "share", "devin", "credentials.toml"), {
      recursive: true,
    });
    let calls = 0;
    try {
      const result = await fetchDevinLimits({
        home,
        env: {},
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(200, planStatusBody());
        },
      });
      assert.deepEqual(result, { configured: false });
      assert.equal(calls, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stays off for a non-true enabled flag", async () => {
    let calls = 0;
    for (const enabled of [false, "1", 1, null, undefined]) {
      const result = await fetchDevinLimits({
        home: null,
        env: {},
        enabled,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(200, planStatusBody());
        },
      });
      assert.deepEqual(result, { configured: false }, `enabled=${enabled}`);
    }
    assert.equal(calls, 0);
  });
});

describe("credential discovery", () => {
  it("uses $XDG_DATA_HOME/devin before the home fallback", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML, at: "xdg" });
    let calledUrl = null;
    try {
      await fetchDevinLimits({
        home,
        env,
        enabled: true,
        fetchImpl: async (url) => {
          calledUrl = url;
          return jsonResponse(200, planStatusBody());
        },
      });
      assert.equal(calledUrl, EXPECTED_URL);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to ~/.local/share/devin/credentials.toml", async () => {
    let calledUrl = null;
    await signedInLimits({
      fetchImpl: async (url) => {
        calledUrl = url;
        return jsonResponse(200, planStatusBody());
      },
    });
    assert.equal(calledUrl, EXPECTED_URL);
  });

  it("reports configured:false without any home or credentials env", async () => {
    let calls = 0;
    const result = await fetchDevinLimits({
      home: null,
      env: {},
      enabled: true,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(200, planStatusBody());
      },
    });
    assert.deepEqual(result, { configured: false });
    assert.equal(calls, 0);
  });

  it("reports configured:false when the credentials file is absent", async () => {
    const { tmp, home, env } = makeDevinHome();
    let calls = 0;
    try {
      const result = await fetchDevinLimits({
        home,
        env,
        enabled: true,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(200, planStatusBody());
        },
      });
      assert.deepEqual(result, { configured: false });
      assert.equal(calls, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces a credential-read failure instead of pretending signed-out", async () => {
    // A directory where credentials.toml should be makes readFileSync fail
    // with EISDIR on every platform — a deterministic "unreadable" fixture.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-devin-"));
    const home = path.join(tmp, "home");
    const dir = path.join(home, ".local", "share", "devin", "credentials.toml");
    fs.mkdirSync(dir, { recursive: true });
    let calls = 0;
    try {
      await assert.rejects(
        fetchDevinLimits({
          home,
          env: {},
          enabled: true,
          fetchImpl: async () => {
            calls += 1;
            return jsonResponse(200, planStatusBody());
          },
        }),
        (error) => {
          assert.match(error.message, /could not read/i);
          assert.match(error.message, /devin auth login/);
          assert.ok(!error.message.includes(tmp), "leaked fs path");
          return true;
        },
      );
      assert.equal(calls, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws an actionable error for a signed-out credentials file", async () => {
    await assert.rejects(
      signedInLimits({
        toml: 'api_server_url = "https://server.codeium.com"\n',
        fetchImpl: okFetch(),
      }),
      /devin auth login/,
    );
  });

  it("rejects a custom api_server_url without any network call", async () => {
    let calls = 0;
    await assert.rejects(
      signedInLimits({
        toml: `windsurf_api_key = "${TEST_TOKEN}"\napi_server_url = "https://evil.example.invalid"\n`,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(200, planStatusBody());
        },
      }),
      /api_server_url/,
    );
    assert.equal(calls, 0);
  });
});

describe("response normalization", () => {
  it("maps 100% remaining to 0% used on both windows", async () => {
    const result = await signedInLimits({ fetchImpl: okFetch() });
    assert.equal(result.primary_window.used_percent, 0);
    assert.equal(result.secondary_window.used_percent, 0);
    assert.equal(result.plan_label, "Pro");
  });

  it("converts unix-second reset strings to ISO timestamps", async () => {
    const result = await signedInLimits({ fetchImpl: okFetch() });
    assert.equal(
      result.primary_window.reset_at,
      new Date(1_789_200_000 * 1000).toISOString(),
    );
    assert.equal(result.primary_window.limit_window_seconds, 86400);
    assert.equal(result.secondary_window.limit_window_seconds, 604800);
  });

  it("treats an absent remaining-percent field as exhausted when the reset is live", async () => {
    const body = planStatusBody();
    delete body.planStatus.dailyQuotaRemainingPercent;
    const result = await signedInLimits({ fetchImpl: okFetch(body) });
    assert.equal(result.primary_window.used_percent, 100);
  });

  it("suppresses an absent daily window while keeping a valid weekly window", async () => {
    const body = planStatusBody();
    delete body.planStatus.dailyQuotaRemainingPercent;
    delete body.planStatus.dailyQuotaResetAtUnix;
    const result = await signedInLimits({ fetchImpl: okFetch(body) });
    assert.equal(result.primary_window, null);
    assert.equal(result.secondary_window.used_percent, 0);
  });

  it("handles asymmetric nonzero daily/weekly remaining percentages", async () => {
    const result = await signedInLimits({
      fetchImpl: okFetch(planStatusBody({ dailyRemaining: 40, weeklyRemaining: 75 })),
    });
    assert.equal(result.primary_window.used_percent, 60);
    assert.equal(result.secondary_window.used_percent, 25);
  });

  it("suppresses windows hidden by the planInfo hide flags", async () => {
    const result = await signedInLimits({
      fetchImpl: okFetch(planStatusBody({ hideDaily: true, hideWeekly: true })),
    });
    assert.equal(result.primary_window, null);
    assert.equal(result.secondary_window, null);
  });

  it("suppresses quota windows for legacy non-QUOTA billing", async () => {
    const result = await signedInLimits({
      fetchImpl: okFetch(planStatusBody({ billingStrategy: "BILLING_STRATEGY_ACU" })),
    });
    assert.equal(result.primary_window, null);
    assert.equal(result.secondary_window, null);
    assert.equal(result.plan_label, "Pro");
  });

  it("throws on a missing planStatus instead of reporting a free plan", async () => {
    await assert.rejects(signedInLimits({ fetchImpl: okFetch({}) }), /planStatus/);
  });

  it("treats explicit null or malformed values as errors, never defaults", async () => {
    for (const bad of [null, "", "abc", {}, [], true]) {
      const body = planStatusBody();
      body.planStatus.dailyQuotaRemainingPercent = bad;
      await assert.rejects(
        signedInLimits({ fetchImpl: okFetch(body) }),
        /malformed/,
        `expected malformed rejection for ${JSON.stringify(bad)}`,
      );
    }
  });

  it("clamps out-of-range percentages defensively", async () => {
    const result = await signedInLimits({
      fetchImpl: okFetch(planStatusBody({ dailyRemaining: -5, weeklyRemaining: 150 })),
    });
    assert.equal(result.primary_window.used_percent, 100);
    assert.equal(result.secondary_window.used_percent, 0);
  });

  it("rejects reset timestamps beyond the JS Date range on either window", async () => {
    // 8640000000001s × 1000 exceeds Date's maximum representable ms.
    for (const field of ["dailyReset", "weeklyReset"]) {
      const body = planStatusBody({ [field]: 8_640_000_000_001 });
      await assert.rejects(
        signedInLimits({ fetchImpl: okFetch(body) }),
        /malformed quota reset timestamp/,
        `expected malformed rejection for ${field}`,
      );
    }
  });
});

describe("request and transport", () => {
  it("posts an empty JSON body with the x-auth-token header to the fixed endpoint", async () => {
    let seen = null;
    await signedInLimits({
      fetchImpl: async (url, options) => {
        seen = { url, options };
        return jsonResponse(200, planStatusBody());
      },
    });
    assert.equal(seen.url, EXPECTED_URL);
    assert.equal(seen.options.method, "POST");
    assert.equal(seen.options.headers["x-auth-token"], TEST_TOKEN);
    assert.equal(seen.options.headers["Content-Type"], "application/json");
    assert.equal(seen.options.headers["Connect-Protocol-Version"], "1");
    assert.equal(seen.options.body, "{}");
    assert.equal(seen.options.redirect, "error");
  });

  it("flags HTTP 401/403 as AUTH_EXPIRED", async () => {
    for (const status of [401, 403]) {
      const error = await signedInLimits({
        fetchImpl: async () => jsonResponse(status, {}),
      }).then(
        () => null,
        (e) => e,
      );
      assert.equal(error.code, "AUTH_EXPIRED");
      assert.match(error.message, /devin auth login/);
    }
  });

  it("treats HTTP 400 as an ambiguous rejection, not credential expiry", async () => {
    const error = await signedInLimits({
      fetchImpl: async () => jsonResponse(400, { code: "invalid_argument" }),
    }).then(
      () => null,
      (e) => e,
    );
    assert.notEqual(error.code, "AUTH_EXPIRED");
    assert.match(error.message, /rejected|HTTP 400/);
  });

  it("rejects non-JSON and planStatus-less responses", async () => {
    await assert.rejects(
      signedInLimits({
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("bad json");
          },
        }),
      }),
      /not JSON/,
    );
  });

  it("uses owned transport errors that leak no token, path or identity", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-devin-"));
    const home = path.join(tmp, "home");
    const dir = path.join(home, ".local", "share", "devin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "credentials.toml"), SIGNED_IN_TOML);
    const secretPath = path.join(dir, "credentials.toml");
    try {
      const error = await fetchDevinLimits({
        home,
        env: {},
        enabled: true,
        fetchImpl: async () => {
          throw new Error(
            `upstream refused ${TEST_TOKEN} at ${secretPath} for private@example.invalid`,
          );
        },
      }).then(
        () => null,
        (e) => e,
      );
      assert.equal(error.message, "Devin quota request failed.");
      assert.ok(!error.message.includes(TEST_TOKEN), "leaked token");
      assert.ok(!error.message.includes(secretPath), "leaked path");
      assert.ok(!error.message.includes("private@example.invalid"), "leaked identity");
      assert.ok(!error.message.includes("upstream refused"), "forwarded upstream text");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("classifies aborted requests as timeouts without dependency text", async () => {
    const error = await signedInLimits({
      fetchImpl: async () => {
        const e = new Error("The operation was aborted by the user agent internals");
        e.name = "AbortError";
        throw e;
      },
    }).then(
      () => null,
      (e) => e,
    );
    assert.equal(error.message, "Devin quota request timed out.");
  });
});

describe("devin inside the aggregated usage-limits round", () => {
  it("stays configured:false by default and never reads credentials or calls the RPC", async () => {
    // Credentials path is a directory — any read attempt throws — and the
    // fetch stub fails the test if GetPlanStatus is ever requested.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-devin-"));
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".local", "share", "devin", "credentials.toml"), {
      recursive: true,
    });
    resetUsageLimitsCache();
    try {
      const data = await getUsageLimits({
        home,
        env: { CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude") },
        fetchImpl: async (url) => {
          assert.ok(
            !String(url).includes("GetPlanStatus"),
            "Devin RPC called while the provider was off",
          );
          return jsonResponse(404, {});
        },
      });
      assert.equal(data.devin.configured, false);
      assert.equal(data.devin.primary_window, undefined);
      assert.equal(data.devin.error, undefined);
      assert.ok("claude" in data && "codex" in data);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns data.devin with plan label and both windows", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    resetUsageLimitsCache();
    try {
      const data = await getUsageLimits({
        home,
        env: { ...env, CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude") },
        devinEnabled: true,
        fetchImpl: async (url) => {
          if (String(url).includes("GetPlanStatus")) {
            return jsonResponse(
              200,
              planStatusBody({ dailyRemaining: 60, weeklyRemaining: 10 }),
            );
          }
          return jsonResponse(404, {});
        },
      });
      const devin = data.devin;
      assert.equal(devin.configured, true);
      assert.equal(devin.error, null);
      assert.equal(devin.plan_label, "Pro");
      assert.equal(devin.stale, false);
      assert.ok(devin.cached_at);
      assert.equal(devin.provenance.source, "provider-api");
      assert.equal(devin.primary_window.used_percent, 40);
      assert.equal(devin.secondary_window.used_percent, 90);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps enabled and disabled selections in separate cache slots", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    resetUsageLimitsCache();
    let devinFetches = 0;
    const base = {
      home,
      env: { ...env, CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude") },
      fetchImpl: async (url) => {
        if (String(url).includes("GetPlanStatus")) {
          devinFetches += 1;
          return jsonResponse(200, planStatusBody({ dailyRemaining: 60 }));
        }
        return jsonResponse(404, {});
      },
    };
    try {
      const enabled = await getUsageLimits({ ...base, devinEnabled: true });
      assert.equal(enabled.devin.configured, true);
      assert.equal(enabled.devin.primary_window.used_percent, 40);
      assert.equal(devinFetches, 1);

      // A disabled caller must not be served (or join) the enabled result.
      const disabled = await getUsageLimits({ ...base, devinEnabled: false });
      assert.equal(disabled.devin.configured, false);
      assert.equal(disabled.devin.primary_window, undefined);
      assert.equal(devinFetches, 1, "disabled caller re-fetched Devin");

      // The enabled variant stays cached for enabled callers.
      const enabledAgain = await getUsageLimits({ ...base, devinEnabled: true });
      assert.equal(enabledAgain.devin.configured, true);
      assert.equal(devinFetches, 1, "enabled cache slot was not reused");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not join a disabled caller onto an in-flight enabled fetch", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    resetUsageLimitsCache();
    let resolveDevin;
    const devinGate = new Promise((resolve) => {
      resolveDevin = resolve;
    });
    const base = {
      home,
      env: { ...env, CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude") },
      fetchImpl: async (url) => {
        if (String(url).includes("GetPlanStatus")) {
          await devinGate;
          return jsonResponse(200, planStatusBody());
        }
        return jsonResponse(404, {});
      },
    };
    try {
      const enabledPromise = getUsageLimits({ ...base, devinEnabled: true });
      const disabled = await getUsageLimits({ ...base, devinEnabled: false });
      assert.equal(
        disabled.devin.configured,
        false,
        "disabled caller received the in-flight enabled result",
      );
      assert.equal(disabled.devin.primary_window, undefined);
      resolveDevin();
      const enabled = await enabledPromise;
      assert.equal(enabled.devin.configured, true);
    } finally {
      resolveDevin();
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns configured:false for devin without credentials without breaking peers", async () => {
    const { tmp, home, env } = makeDevinHome();
    resetUsageLimitsCache();
    try {
      const data = await getUsageLimits({
        home,
        env: { ...env, CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude") },
        devinEnabled: true,
        fetchImpl: async () => jsonResponse(404, {}),
      });
      assert.equal(data.devin.configured, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces a credential-read failure as a provider error in the aggregate", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-devin-"));
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".local", "share", "devin", "credentials.toml"), {
      recursive: true,
    });
    resetUsageLimitsCache();
    try {
      const data = await getUsageLimits({
        home,
        env: { CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude") },
        devinEnabled: true,
        fetchImpl: async () => jsonResponse(404, {}),
      });
      assert.equal(data.devin.configured, true);
      assert.match(data.devin.error, /could not read/i);
      assert.ok(!data.devin.error.includes(tmp), "leaked fs path");
      assert.ok("claude" in data && "codex" in data);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("isolates a devin transport failure from the other providers", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    resetUsageLimitsCache();
    try {
      const data = await getUsageLimits({
        home,
        env: { ...env, CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude") },
        devinEnabled: true,
        fetchImpl: async (url) => {
          if (String(url).includes("GetPlanStatus")) {
            throw new Error("socket hang up");
          }
          return jsonResponse(404, {});
        },
      });
      assert.equal(data.devin.configured, true);
      assert.equal(data.devin.error, "Devin quota request failed.");
      assert.equal(data.devin.provenance.stale, false);
      assert.ok("claude" in data && "codex" in data);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
