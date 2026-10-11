const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  fetchCommandcodeLimits,
  readCommandcodeApiKey,
  resolveCommandcodeAuthPath,
  resolveCommandcodeOrigin,
  deriveCommandcodePlanLabel,
  normalizeResetAt,
  normalizeCommandcodeWindowLimits,
} = require("../src/lib/commandcode-limits");
const {
  getUsageLimits,
  resetUsageLimitsCache,
} = require("./helpers/usage-limits");

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function makeAuthHome({ apiKey = "k-abc", envKey = null } = {}) {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokentracker-commandcode-"),
  );
  const home = path.join(tmp, "home");
  const authDir = path.join(home, ".commandcode");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(authDir, "auth.json"),
    JSON.stringify({ apiKey, userName: "dev" }),
  );
  const env = {};
  if (envKey) env.COMMAND_CODE_API_KEY = envKey;
  return { tmp, home, authDir, env };
}

function creditsPayload({
  used5h = 8,
  cap5h = 16,
  usedWeekly = 20,
  capWeekly = 40,
} = {}) {
  return {
    credits: { monthlyCredits: 80, purchasedCredits: 5 },
    windowLimits: {
      limited: true,
      fiveHour: { used: used5h, cap: cap5h, resetAt: 1_800_000_000_000 },
      weekly: { used: usedWeekly, cap: capWeekly, resetAt: 1_860_000_000_000 },
    },
  };
}

it("keeps malformed usage unknown instead of displaying an unused window", () => {
  for (const used of [null, undefined, "", "  ", false, [], {}]) {
    assert.equal(normalizeCommandcodeWindowLimits({ fiveHour: { used, cap: 100 } }), null);
  }
  assert.equal(normalizeCommandcodeWindowLimits({ fiveHour: { used: 0, cap: 100 } }).fiveHour.used_percent, 0);
});

describe("readCommandcodeApiKey", () => {
  it("prefers COMMAND_CODE_API_KEY over the auth file", () => {
    const { tmp, home } = makeAuthHome({
      apiKey: "file-key",
      envKey: "env-key",
    });
    try {
      assert.equal(
        readCommandcodeApiKey({
          home,
          env: { COMMAND_CODE_API_KEY: "env-key" },
        }),
        "env-key",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads apiKey from ~/.commandcode/auth.json", () => {
    const { tmp, home } = makeAuthHome({ apiKey: "file-key" });
    try {
      assert.equal(readCommandcodeApiKey({ home, env: {} }), "file-key");
      assert.equal(
        resolveCommandcodeAuthPath({ home }),
        path.join(home, ".commandcode", "auth.json"),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null without a home, auth file, or env key", () => {
    assert.equal(readCommandcodeApiKey({ home: null, env: {} }), null);
    assert.equal(
      readCommandcodeApiKey({ home: "/nonexistent/home", env: {} }),
      null,
    );
    assert.equal(resolveCommandcodeAuthPath({ home: null, env: {} }), null);
  });

  it("tolerates a malformed or missing auth file", () => {
    const { tmp, home } = makeAuthHome();
    try {
      fs.writeFileSync(
        path.join(home, ".commandcode", "auth.json"),
        "not json",
        "utf8",
      );
      assert.equal(readCommandcodeApiKey({ home, env: {} }), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("deriveCommandcodePlanLabel", () => {
  it("maps known plan ids to the CLI's display tiers", () => {
    assert.equal(deriveCommandcodePlanLabel("individual-go"), "Go");
    assert.equal(deriveCommandcodePlanLabel("individual-goat"), "GOAT");
    assert.equal(deriveCommandcodePlanLabel("individual-pro"), "Pro");
    // Longest-prefix first: the v1 suffix must not fall through to "Pro".
    assert.equal(deriveCommandcodePlanLabel("individual-pro-v1"), "Pro");
    assert.equal(deriveCommandcodePlanLabel("individual-provider"), "Provider");
    assert.equal(deriveCommandcodePlanLabel("individual-max"), "Max");
    assert.equal(deriveCommandcodePlanLabel("individual-ultra"), "Ultra");
    assert.equal(deriveCommandcodePlanLabel("teams-pro"), "Teams Pro");
  });

  it("normalizes underscores and case", () => {
    assert.equal(deriveCommandcodePlanLabel("INDIVIDUAL_GOAT"), "GOAT");
  });

  it("returns null for unknown or empty ids", () => {
    assert.equal(deriveCommandcodePlanLabel("enterprise-custom"), null);
    assert.equal(deriveCommandcodePlanLabel(""), null);
    assert.equal(deriveCommandcodePlanLabel(null), null);
    assert.equal(deriveCommandcodePlanLabel(undefined), null);
  });
});

describe("normalizeResetAt", () => {
  it("accepts epoch milliseconds, epoch seconds, and ISO strings", () => {
    assert.equal(
      normalizeResetAt(1_800_000_000_000),
      "2027-01-15T08:00:00.000Z",
    );
    assert.equal(normalizeResetAt(1_800_000_000), "2027-01-15T08:00:00.000Z");
    assert.equal(
      normalizeResetAt("2027-01-15T08:00:00.000Z"),
      "2027-01-15T08:00:00.000Z",
    );
  });

  it("returns null for empty or invalid values", () => {
    assert.equal(normalizeResetAt(null), null);
    assert.equal(normalizeResetAt(undefined), null);
    assert.equal(normalizeResetAt(""), null);
    assert.equal(normalizeResetAt("not-a-date"), null);
    assert.equal(normalizeResetAt(0), null);
  });
});

describe("normalizeCommandcodeWindowLimits", () => {
  it("derives used_percent and reset_at for 5h + weekly windows", () => {
    const out = normalizeCommandcodeWindowLimits(creditsPayload().windowLimits);
    assert.ok(out, "expected windows");
    assert.equal(out.fiveHour.used_percent, 50);
    assert.equal(out.fiveHour.reset_at, "2027-01-15T08:00:00.000Z");
    assert.equal(out.fiveHour.limit_window_seconds, 5 * 60 * 60);
    assert.equal(out.weekly.used_percent, 50);
    assert.equal(out.weekly.limit_window_seconds, 7 * 24 * 60 * 60);
  });

  it("returns null when no window carries usable data", () => {
    assert.equal(normalizeCommandcodeWindowLimits({ limited: true }), null);
    assert.equal(normalizeCommandcodeWindowLimits(null), null);
    assert.equal(
      normalizeCommandcodeWindowLimits({
        limited: true,
        fiveHour: { used: 1, cap: 0, resetAt: 1_800_000_000_000 },
        weekly: { used: 1, cap: 0, resetAt: 1_860_000_000_000 },
      }),
      null,
    );
  });

  it("tolerates a missing 5h window (weekly-only payloads)", () => {
    const out = normalizeCommandcodeWindowLimits({
      limited: true,
      weekly: { used: 10, cap: 40, resetAt: 1_860_000_000_000 },
    });
    assert.ok(out, "expected a weekly window");
    assert.equal(out.fiveHour, null);
    assert.equal(out.weekly.used_percent, 25);
  });

  it("accepts snake_case window spellings", () => {
    const out = normalizeCommandcodeWindowLimits({
      limited: true,
      five_hour: { used: 4, total: 16, reset_at: "2027-01-15T08:00:00.000Z" },
      weekly: { used: 10, limit: 40, reset: 1_800_000_000 },
    });
    assert.ok(out, "expected windows");
    assert.equal(out.fiveHour.used_percent, 25);
    assert.equal(out.fiveHour.reset_at, "2027-01-15T08:00:00.000Z");
    assert.equal(out.weekly.used_percent, 25);
    assert.equal(out.weekly.reset_at, "2027-01-15T08:00:00.000Z");
  });
});

describe("fetchCommandcodeLimits", () => {
  it("returns { configured: false } without credentials and never fetches", async () => {
    let calls = 0;
    const out = await fetchCommandcodeLimits({
      home: null,
      env: {},
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not fetch without an api key");
      },
    });
    assert.deepEqual(out, { configured: false });
    assert.equal(calls, 0);
  });

  it("resolves org-scoped endpoints and normalizes the response", async () => {
    const { tmp, home } = makeAuthHome({ apiKey: "k-abc" });
    try {
      const urls = [];
      let whoamiOrgId = "org-7";
      const out = await fetchCommandcodeLimits({
        home,
        env: {},
        nowMs: 1_700_000_000_000,
        fetchImpl: async (url) => {
          urls.push(String(url));
          const u = String(url);
          if (u.includes("/alpha/whoami")) {
            return jsonResponse(200, { data: { org: { id: whoamiOrgId } } });
          }
          if (u.includes("/alpha/billing/credits")) {
            return jsonResponse(200, creditsPayload());
          }
          if (u.includes("/alpha/billing/subscriptions")) {
            return jsonResponse(200, {
              data: { planId: "individual-pro-v1", status: "active" },
            });
          }
          throw new Error(`unexpected url ${url}`);
        },
      });
      assert.equal(out.configured, true);
      assert.equal(out.error, null);
      assert.equal(out.plan_label, "Pro");
      assert.equal(out.subscription_status, "active");
      assert.equal(out.primary_window.used_percent, 50);
      assert.equal(out.secondary_window.used_percent, 50);
      assert.equal(out.stale, false);
      assert.ok(
        urls.some((u) => u.endsWith("/alpha/billing/credits?orgId=org-7")),
      );
      assert.ok(
        urls.some((u) =>
          u.endsWith("/alpha/billing/subscriptions?orgId=org-7"),
        ),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("omits the orgId param for personal (no-org) accounts", async () => {
    const { tmp, home } = makeAuthHome({ apiKey: "k-personal" });
    try {
      const urls = [];
      const out = await fetchCommandcodeLimits({
        home,
        env: {},
        fetchImpl: async (url) => {
          urls.push(String(url));
          const u = String(url);
          if (u.includes("/alpha/whoami")) {
            return jsonResponse(200, { data: { user: { userName: "dev" } } });
          }
          if (u.includes("/alpha/billing/credits")) {
            return jsonResponse(200, creditsPayload());
          }
          if (u.includes("/alpha/billing/subscriptions")) {
            return jsonResponse(200, {
              data: { planId: "individual-go", status: "active" },
            });
          }
        },
      });
      assert.equal(out.configured, true);
      assert.equal(out.plan_label, "Go");
      assert.ok(
        !urls.some((u) => u.includes("orgId=")),
        "no orgId on a personal account",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws AUTH_EXPIRED on 401 so the aggregator can flag reauth", async () => {
    const { tmp, home } = makeAuthHome({ apiKey: "k-expired" });
    try {
      await assert.rejects(
        fetchCommandcodeLimits({
          home,
          env: {},
          fetchImpl: async (url) => {
            if (String(url).includes("/alpha/whoami"))
              return jsonResponse(401, {});
            throw new Error(`unexpected url ${url}`);
          },
        }),
        (error) =>
          error?.code === "AUTH_EXPIRED" && /cmd login/.test(error.message),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws a readable error when credits lack windowLimits", async () => {
    const { tmp, home } = makeAuthHome({ apiKey: "k-empty" });
    try {
      await assert.rejects(
        fetchCommandcodeLimits({
          home,
          env: {},
          fetchImpl: async (url) => {
            const u = String(url);
            if (u.includes("/alpha/whoami"))
              return jsonResponse(200, { data: { user: {} } });
            if (u.includes("/alpha/billing/credits"))
              return jsonResponse(200, { credits: {} });
            if (u.includes("/alpha/billing/subscriptions")) {
              return jsonResponse(200, {
                data: { planId: "individual-go", status: "active" },
              });
            }
            throw new Error(`unexpected url ${url}`);
          },
        }),
        /missing windowLimits/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws a readable error on non-JSON or transport failure", async () => {
    const { tmp, home } = makeAuthHome({ apiKey: "k-net" });
    try {
      await assert.rejects(
        fetchCommandcodeLimits({
          home,
          env: {},
          fetchImpl: async (url) => {
            if (String(url).includes("/alpha/whoami")) {
              return {
                ok: true,
                status: 200,
                async json() {
                  throw new Error("bad json");
                },
              };
            }
            throw new Error(`unexpected url ${url}`);
          },
        }),
        /was not JSON/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("wraps a transport throw in a readable error", async () => {
    const { tmp, home } = makeAuthHome({ apiKey: "k-down" });
    try {
      await assert.rejects(
        fetchCommandcodeLimits({
          home,
          env: {},
          fetchImpl: async () => {
            throw new Error("ECONNRESET");
          },
        }),
        /CommandCode account lookup request failed: ECONNRESET/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("coerces a non-string org id into the orgId param", async () => {
    const { tmp, home } = makeAuthHome({ apiKey: "k-org" });
    try {
      const urls = [];
      await fetchCommandcodeLimits({
        home,
        env: {},
        fetchImpl: async (url) => {
          urls.push(String(url));
          const u = String(url);
          if (u.includes("/alpha/whoami")) {
            return jsonResponse(200, { data: { org: { id: 42 } } });
          }
          if (u.includes("/alpha/billing/credits")) {
            return jsonResponse(200, creditsPayload());
          }
          if (u.includes("/alpha/billing/subscriptions")) {
            return jsonResponse(200, {
              data: { planId: "individual-go", status: "active" },
            });
          }
          throw new Error(`unexpected url ${url}`);
        },
      });
      assert.ok(
        urls.some((u) => u.endsWith("/alpha/billing/credits?orgId=42")),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("commandCode in getUsageLimits", () => {
  // Fail-fast stubs for every other provider: unknown hosts answer 404 so the
  // parallel batch settles instead of hanging on never-resolving fetches.
  function commandCodeFetchImpl({
    credits = creditsPayload(),
    subscription = { data: { planId: "individual-goat", status: "active" } },
    whoami = { data: { org: { id: "org-7" } } },
    status = 200,
  } = {}) {
    return async (url) => {
      const u = String(url);
      if (u.includes("api.commandcode.ai/alpha/whoami")) {
        return status === 200
          ? jsonResponse(200, whoami)
          : jsonResponse(status, {});
      }
      if (u.includes("api.commandcode.ai/alpha/billing/credits")) {
        return jsonResponse(200, credits);
      }
      if (u.includes("api.commandcode.ai/alpha/billing/subscriptions")) {
        return jsonResponse(200, subscription);
      }
      return jsonResponse(404, {});
    };
  }

  function limitsOptions(home, fetchImpl) {
    return {
      home,
      env: {},
      platform: "linux",
      providerTimeoutMs: 1000,
      commandRunner() {
        return { status: 1, stdout: "" };
      },
      requestFn() {
        throw new Error("no local requests");
      },
      securityRunner() {
        return { status: 1, stdout: "" };
      },
      fetchImpl,
    };
  }

  it("carries the normalized windows, GOAT label, and official provenance", async () => {
    resetUsageLimitsCache();
    const { tmp, home } = makeAuthHome({ apiKey: "k-full" });
    try {
      const data = await getUsageLimits(
        limitsOptions(home, commandCodeFetchImpl()),
      );
      const cc = data.commandCode;
      assert.equal(cc.configured, true);
      assert.equal(cc.error, null);
      assert.equal(cc.plan_label, "GOAT");
      assert.equal(cc.primary_window.used_percent, 50);
      assert.equal(cc.secondary_window.used_percent, 50);
      assert.equal(cc.stale, false);
      assert.equal(cc.provenance.source, "provider-api");
      assert.equal(cc.provenance.confidence, "official");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags an expired login for reauth instead of a generic error", async () => {
    resetUsageLimitsCache();
    const { tmp, home } = makeAuthHome({ apiKey: "k-expired" });
    try {
      const data = await getUsageLimits(
        limitsOptions(home, commandCodeFetchImpl({ status: 401 })),
      );
      assert.equal(data.commandCode.configured, true);
      assert.match(data.commandCode.error, /cmd login/);
      assert.equal(data.commandCode.auth_action_required, "reauth");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports configured:false without credentials so the panel hides the row", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "tokentracker-commandcode-nokey-"),
    );
    try {
      let calls = 0;
      const data = await getUsageLimits(
        limitsOptions(tmp, async () => {
          calls += 1;
          return jsonResponse(404, {});
        }),
      );
      assert.deepEqual(
        { configured: data.commandCode.configured, calls },
        { configured: false, calls: 0 },
      );
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveCommandcodeOrigin", () => {
  it("accepts the default https origin and trims slashes", () => {
    assert.equal(
      resolveCommandcodeOrigin("https://api.commandcode.ai/"),
      "https://api.commandcode.ai",
    );
  });

  it("rejects cleartext http origins that would leak the Bearer key", () => {
    assert.throws(
      () => resolveCommandcodeOrigin("http://api.commandcode.ai"),
      /must use https/,
    );
  });

  it("rejects malformed origins", () => {
    assert.throws(() => resolveCommandcodeOrigin("notaurl"), /invalid/);
  });

  it("allows loopback http for local staging servers", () => {
    assert.equal(
      resolveCommandcodeOrigin("http://localhost:9090/"),
      "http://localhost:9090",
    );
    assert.equal(
      resolveCommandcodeOrigin("http://127.0.0.1:9090"),
      "http://127.0.0.1:9090",
    );
  });

  it("refuses a custom http baseUrl before any fetch fires", async () => {
    const { tmp, home } = makeAuthHome({ apiKey: "k-origin" });
    try {
      let calls = 0;
      await assert.rejects(
        fetchCommandcodeLimits({
          home,
          env: {},
          baseUrl: "http://api.commandcode.ai",
          fetchImpl: async () => {
            calls += 1;
            throw new Error("must not fetch");
          },
        }),
        /must use https/,
      );
      assert.equal(calls, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
