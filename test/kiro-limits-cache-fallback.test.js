const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, beforeEach } = require("node:test");

const { getUsageLimits, resetUsageLimitsCache } = require("./helpers/usage-limits");

const BINARY_PROBE = process.platform === "win32" ? "where" : "which";
const KIRO_PTY_COMMANDS = new Set(["/usr/bin/script", "script"]);

const KIRO_USAGE_OUTPUT = `
Estimated Usage | resets on 2099-08-01 | KIRO PRO
████████████ 25%
(25 of 100 covered in plan)
`;

// The same non-secret resource id shape kiro-cli persists in
// ~/.aws/sso/cache/kiro-auth-token.json; it is the cache partition key.
const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/ALPHA";
const OTHER_PROFILE_ARN = "arn:aws:codewhisperer:us-west-2:444455556666:profile/BETA";

function inactiveRunner() {
  return { status: 1, stdout: "" };
}

// The slot never hits the network directly — everything funnels through the
// kiro-cli probe, its --version stamp and the PTY /usage round-trip, so the
// commandRunner is the whole provider surface. kiro-cli 2.13 goes straight to
// the PTY (no unsafe pipe attempt); other providers' probes get a quiet miss.
function kiroCommandRunner(ptyResult) {
  return (command, args) => {
    if (command === BINARY_PROBE) {
      return args[0] === "kiro-cli"
        ? { status: 0, stdout: "/opt/kiro-cli\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "" };
    }
    if (command === "/opt/kiro-cli" && args[0] === "--version") {
      return { status: 0, stdout: "kiro-cli 2.13.0\n", stderr: "" };
    }
    if (KIRO_PTY_COMMANDS.has(command)) return ptyResult();
    return { status: 1, stdout: "", stderr: "" };
  };
}

const okPty = () => ({ status: 0, stdout: KIRO_USAGE_OUTPUT, stderr: "" });
const failedPty = () => ({ status: 1, stdout: "", stderr: "" });
const timedOutPty = () => ({ status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT", message: "timed out" } });
const loggedOutPty = () => ({
  status: 0,
  stdout: "Not logged in to Kiro. Run 'kiro-cli login' first.",
  stderr: "",
});

// Every probe misses: kiro-cli is not on PATH.
const missingBinaryRunner = () => () => ({ status: 1, stdout: "", stderr: "" });

// Silent error for every non-Kiro route; nothing else in the aggregate may
// reach the real network from a bare temp home.
const allProvidersFail = () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) });

function baseOptions(home, commandRunner) {
  return {
    home,
    env: {},
    // The Windows runner has no PTY transport (kiroPtyInvocation returns null
    // there), so pin the darwin shape the stub answers — same pin the
    // fetchKiroLimits unit tests use.
    platform: "darwin",
    providerTimeoutMs: 2000,
    securityRunner: inactiveRunner,
    commandRunner,
    fetchImpl: allProvidersFail,
  };
}

function trackerDir(home) {
  return path.join(home, ".tokentracker", "tracker");
}

function cachePath(home) {
  return path.join(trackerDir(home), "kiro-usage-limits-cache.json");
}

// kiro-cli's own login file; tokens are present in shape but never read.
function seedKiroAuth(home, profileArn = PROFILE_ARN) {
  fs.mkdirSync(path.join(home, ".aws", "sso", "cache"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".aws", "sso", "cache", "kiro-auth-token.json"),
    JSON.stringify({
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      profileArn,
      authMethod: "social",
      provider: "Google",
    }),
  );
}

function seedKiroCache(home, entry) {
  fs.mkdirSync(trackerDir(home), { recursive: true });
  fs.writeFileSync(cachePath(home), JSON.stringify({ kiro: entry }));
}

function seedCreditsSidecar(home) {
  fs.mkdirSync(trackerDir(home), { recursive: true });
  fs.writeFileSync(
    path.join(trackerDir(home), "kiro-credits.json"),
    JSON.stringify({
      version: 1,
      total_credits: 1796.45,
      record_count: 193,
      session_count: 19,
      latest_at: "2026-07-22T15:28:20.659Z",
      updated_at: "2026-07-25T00:00:00.000Z",
    }),
  );
}

function makeHome({ withAuth = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kiro-cache-"));
  if (withAuth) seedKiroAuth(home);
  return home;
}

describe("Kiro limits disk-cache fallback", () => {
  beforeEach(() => {
    resetUsageLimitsCache();
  });

  it("persists a live read and serves it stale when a later CLI round-trip fails", async () => {
    const home = makeHome();
    try {
      seedCreditsSidecar(home);
      const live = await getUsageLimits(baseOptions(home, kiroCommandRunner(okPty)));
      assert.equal(live.kiro.configured, true);
      assert.equal(live.kiro.error, null);
      assert.equal(live.kiro.stale, false);
      assert.equal(live.kiro.primary_window.used_percent, 25);
      assert.equal(live.kiro.plan_label, "Pro");
      assert.equal(live.kiro.provenance.source, "provider-api");

      // Pin the on-disk schema: identity stamp + windows only, no usage-sidecar bleed.
      const disk = JSON.parse(fs.readFileSync(cachePath(home), "utf8"));
      assert.deepEqual(Object.keys(disk.kiro).sort(), [
        "cached_at", "identity", "plan_name", "primary_window", "secondary_window",
      ]);
      assert.equal(disk.kiro.identity, PROFILE_ARN);
      assert.equal(disk.kiro.plan_name, "KIRO PRO");
      assert.equal(disk.kiro.primary_window.used_percent, 25);
      assert.equal(disk.kiro.primary_window.reset_at, "2099-08-01T00:00:00.000Z");

      resetUsageLimitsCache();
      const stale = await getUsageLimits(baseOptions(home, kiroCommandRunner(failedPty)));
      assert.equal(stale.kiro.configured, true);
      assert.equal(stale.kiro.error, null, "stale cache must be served instead of a red error");
      assert.equal(stale.kiro.stale, true);
      assert.equal(stale.kiro.primary_window.used_percent, 25);
      assert.equal(stale.kiro.cached_at, live.kiro.cached_at, "stale read must preserve the original cached_at");
      assert.equal(stale.kiro.provenance.source, "disk-cache");
      assert.equal(stale.kiro.plan_label, "Pro");
      // The credits sidecar stays live-read on the fallback path, matching the
      // fetcher's own contract of merging it into every slot result.
      assert.equal(stale.kiro.tracked_credits, 1796.45);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not hide a not-logged-in error behind stale cache", async () => {
    const home = makeHome();
    try {
      await getUsageLimits(baseOptions(home, kiroCommandRunner(okPty)));
      resetUsageLimitsCache();

      const expired = await getUsageLimits(baseOptions(home, kiroCommandRunner(loggedOutPty)));
      // The cache file is on disk, but a logged-out CLI means re-login and
      // must surface instead of pinning the previous account's bars.
      assert.equal(expired.kiro.error, "Not logged in to Kiro. Run 'kiro-cli login' first.");
      assert.notEqual(expired.kiro.stale, true);
      assert.equal(expired.kiro.primary_window, undefined);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("serves stale cache when the CLI attempt times out", async () => {
    const home = makeHome();
    try {
      await getUsageLimits(baseOptions(home, kiroCommandRunner(okPty)));
      resetUsageLimitsCache();

      // The 20s command budget expiring is the common failure mode this cache
      // exists for; the fallback must still land.
      const stale = await getUsageLimits(baseOptions(home, kiroCommandRunner(timedOutPty)));
      assert.equal(stale.kiro.configured, true);
      assert.equal(stale.kiro.error, null);
      assert.equal(stale.kiro.stale, true);
      assert.equal(stale.kiro.primary_window.used_percent, 25);
      assert.equal(stale.kiro.provenance.source, "disk-cache");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not treat a CLI-less credits-only read as a cacheable failure", async () => {
    const home = makeHome();
    try {
      seedCreditsSidecar(home);
      seedKiroCache(home, {
        identity: PROFILE_ARN,
        plan_name: "KIRO PRO",
        primary_window: { used_percent: 25, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
        secondary_window: null,
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });

      // No kiro-cli on PATH: the slot reports the sidecar credits with no
      // error. That is a success, not a fetch failure — the seeded cache must
      // not leak its windows into the payload.
      const result = await getUsageLimits(baseOptions(home, missingBinaryRunner()));
      assert.equal(result.kiro.configured, true);
      assert.equal(result.kiro.error, null);
      assert.equal(result.kiro.tracked_credits, 1796.45);
      assert.notEqual(result.kiro.stale, true);
      assert.equal(result.kiro.primary_window, undefined);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not serve another account's cached windows after an account switch", async () => {
    const home = makeHome();
    try {
      await getUsageLimits(baseOptions(home, kiroCommandRunner(okPty)));
      resetUsageLimitsCache();

      // A different kiro-cli login now owns the home: the previous account's
      // entry must not resurface as this one's fallback.
      seedKiroAuth(home, OTHER_PROFILE_ARN);
      const switched = await getUsageLimits(baseOptions(home, kiroCommandRunner(failedPty)));
      assert.equal(switched.kiro.error, "Kiro CLI failed with status 1.");
      assert.notEqual(switched.kiro.stale, true);
      assert.equal(switched.kiro.primary_window, undefined);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to write a cache entry when the login identity is unreadable", async () => {
    const home = makeHome({ withAuth: false });
    try {
      const live = await getUsageLimits(baseOptions(home, kiroCommandRunner(okPty)));
      assert.equal(live.kiro.error, null);
      assert.equal(live.kiro.primary_window.used_percent, 25);
      assert.equal(
        fs.existsSync(cachePath(home)),
        false,
        "no readable identity must mean no disk entry",
      );
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops a cached window whose reset_at has already passed", async () => {
    const home = makeHome();
    try {
      seedKiroCache(home, {
        identity: PROFILE_ARN,
        plan_name: "KIRO PRO",
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() - 3_600_000).toISOString() },
        secondary_window: null,
        cached_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, kiroCommandRunner(failedPty)));
      assert.equal(result.kiro.error, "Kiro CLI failed with status 1.", "a rolled-over window is stale data, not a fallback");
      assert.notEqual(result.kiro.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores a cache entry older than the max-age TTL", async () => {
    const home = makeHome();
    try {
      seedKiroCache(home, {
        identity: PROFILE_ARN,
        plan_name: "KIRO PRO",
        primary_window: { used_percent: 42, reset_at: new Date(Date.now() + 86_400_000).toISOString() },
        secondary_window: null,
        cached_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      });

      const result = await getUsageLimits(baseOptions(home, kiroCommandRunner(failedPty)));
      assert.equal(result.kiro.error, "Kiro CLI failed with status 1.");
      assert.notEqual(result.kiro.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
