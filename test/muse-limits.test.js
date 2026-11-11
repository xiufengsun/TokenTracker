"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  MUSE_FIVE_HOUR_WINDOW_SECONDS,
  MUSE_WEEKLY_WINDOW_SECONDS,
  MUSE_SUBSCRIPTION_REQUIRED_MESSAGE,
  MUSE_AUTH_EXPIRED_MESSAGE,
  deriveMusePlanLabel,
  resolveMuseCommand,
  normalizeMuseUsageResponse,
  fetchMuseLimits,
} = require("../src/lib/muse-limits");
const {
  getUsageLimits,
  resetUsageLimitsCache,
  USAGE_LIMITS_PROVIDER_IDS,
} = require("../src/lib/usage-limits");

function makeTempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-muse-limits-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeMuseAuth(home, { email = "dev@example.com", subsActive = true } = {}) {
  const configDir = path.join(home, ".config", "muse");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "auth.json"),
    JSON.stringify({
      providers: {
        meta: {
          user_email: email,
          subs_active: subsActive,
        },
      },
    }),
    "utf8",
  );
}

function writeUnixMuseBinary(home) {
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, "muse");
  fs.writeFileSync(binPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return binPath;
}

describe("muse-limits", () => {
  it("returns configured: false with zero subprocess spawns when Muse Code is not installed", async (t) => {
    const home = makeTempHome(t);
    let spawns = 0;
    const result = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      globalBinDirs: [path.join(home, "empty-bin")],
      commandRunner() {
        spawns += 1;
        return { status: 1, stdout: "", stderr: "" };
      },
    });

    assert.deepEqual(result, { configured: false });
    assert.equal(spawns, 0);
  });

  it("resolves pinned Windows muse-bin-<version>.exe directly without cmd.exe shell", async (t) => {
    const home = makeTempHome(t);
    const localAppData = path.join(home, "AppData", "Local");
    const installDir = path.join(localAppData, "Programs", "muse");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, ".muse-version"), "0.1.33\n", "utf8");
    const pinnedExe = path.join(installDir, "muse-bin-0.1.33.exe");
    const olderExe = path.join(installDir, "muse-bin-0.1.31.exe");
    const cmdShim = path.join(installDir, "muse.cmd");
    fs.writeFileSync(pinnedExe, "stub");
    fs.writeFileSync(olderExe, "stub");
    fs.writeFileSync(cmdShim, "@echo off\r\n");

    const resolved = await resolveMuseCommand({
      home,
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
      globalBinDirs: [],
    });

    assert.deepEqual(resolved, {
      binaryPath: pinnedExe,
      useShell: false,
    });

    // When .muse-version is absent, fall back to highest semver/release muse-bin-*.exe
    // including Meta's real -R<build>.<patch> release suffix.
    fs.unlinkSync(path.join(installDir, ".muse-version"));
    const releaseOlder = path.join(installDir, "muse-bin-1.4.14-R7309.1.exe");
    const releaseNewer = path.join(installDir, "muse-bin-1.4.15-R8339.1.exe");
    fs.writeFileSync(releaseOlder, "stub");
    fs.writeFileSync(releaseNewer, "stub");
    const fallbackResolved = await resolveMuseCommand({
      home,
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
      globalBinDirs: [],
    });
    assert.deepEqual(fallbackResolved, {
      binaryPath: releaseNewer,
      useShell: false,
    });
  });

  it("resolves native muse-bin-<version> on macOS and Linux and honors MUSE_INSTALL_DIR, TOKENTRACKER_MUSE_HOME, and MUSE_AUTH_PATH", async (t) => {
    const home = makeTempHome(t);
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, ".muse-version"), "1.4.15-R8339.1\n", "utf8");
    const nativeDarwinBin = path.join(localBin, "muse-bin-1.4.15-R8339.1");
    fs.writeFileSync(nativeDarwinBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(localBin, "muse"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const darwinResolved = await resolveMuseCommand({
      home,
      platform: "darwin",
      env: {},
    });
    assert.deepEqual(darwinResolved, {
      binaryPath: nativeDarwinBin,
      useShell: false,
    });

    // Custom Linux install dir + TOKENTRACKER_MUSE_HOME + MUSE_AUTH_PATH + MUSE_NO_AUTO_UPDATE=1
    const linuxHome = makeTempHome(t);
    const customInstallDir = path.join(linuxHome, "opt", "muse-cli");
    const customDataDir = path.join(linuxHome, "custom-muse-data");
    const customAuthPath = path.join(linuxHome, "secrets", "muse-auth.json");
    fs.mkdirSync(customInstallDir, { recursive: true });
    fs.mkdirSync(customDataDir, { recursive: true });
    fs.mkdirSync(path.dirname(customAuthPath), { recursive: true });
    const customLinuxBin = path.join(customInstallDir, "muse-bin-1.4.15-R8339.1");
    fs.writeFileSync(customLinuxBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(
      customAuthPath,
      JSON.stringify({
        providers: { meta: { user_email: "linux@example.com", subs_active: true } },
      }),
      "utf8",
    );

    const nowMs = Date.parse("2026-11-11T08:00:00.000Z");
    let capturedCmd = null;
    let capturedEnv = null;
    const linuxResult = await fetchMuseLimits({
      home: linuxHome,
      platform: "linux",
      nowMs,
      env: {
        MUSE_INSTALL_DIR: customInstallDir,
        TOKENTRACKER_MUSE_HOME: customDataDir,
        MUSE_AUTH_PATH: customAuthPath,
      },
      globalBinDirs: [],
      commandRunner(cmd, _args, opts) {
        capturedCmd = cmd;
        capturedEnv = opts?.env;
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "power",
              window: { usedPercent: 14, resetsAtMs: nowMs + 3600_000 },
              weekly: { usedPercent: 5, resetsAtMs: nowMs + 86400_000 },
            },
          }),
          stderr: "",
        };
      },
    });

    assert.equal(capturedCmd, customLinuxBin);
    assert.equal(capturedEnv?.MUSE_NO_AUTO_UPDATE, "1");
    assert.equal(linuxResult.configured, true);
    assert.equal(linuxResult.plan_label, "Power");
    assert.equal(linuxResult.primary_window.used_percent, 14);
  });

  it("normalizes tier labels and clamps rolling 5h + weekly quota windows", () => {
    assert.equal(deriveMusePlanLabel("power"), "Power");
    assert.equal(deriveMusePlanLabel("muse_pro"), "Pro");
    assert.equal(deriveMusePlanLabel("enterprise"), "Enterprise");

    const nowMs = Date.parse("2026-11-11T08:00:00.000Z");
    const reset5hMs = Date.parse("2026-11-11T12:30:00.000Z");
    const resetWeeklyMs = Date.parse("2026-11-17T00:00:00.000Z");

    const outcome = normalizeMuseUsageResponse(
      {
        allowance: {
          tier: "power",
          window: { usedPercent: 142, resetsAtMs: reset5hMs },
          weekly: { usedPercent: -4, resetsAtMs: resetWeeklyMs },
        },
      },
      { profileIdentity: "acct-1", nowMs },
    );

    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.record.configured, true);
    assert.equal(outcome.record.error, null);
    assert.equal(outcome.record.plan_label, "Power");
    assert.deepEqual(outcome.record.primary_window, {
      used_percent: 100,
      reset_at: "2026-11-11T12:30:00.000Z",
      limit_window_seconds: MUSE_FIVE_HOUR_WINDOW_SECONDS,
    });
    assert.deepEqual(outcome.record.secondary_window, {
      used_percent: 0,
      reset_at: "2026-11-17T00:00:00.000Z",
      limit_window_seconds: MUSE_WEEKLY_WINDOW_SECONDS,
    });
  });

  it("surfaces idle 0% windows on server_sent_no_usage for active subscribers and preserves cached plan_label", async (t) => {
    const home = makeTempHome(t);
    writeUnixMuseBinary(home);
    writeMuseAuth(home, { email: "user@example.com", subsActive: true });

    const nowMs = Date.parse("2026-11-11T08:00:00.000Z");

    // Seed disk cache with a live Power reading first.
    const live = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs,
      injectedNowMs: nowMs,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "power",
              window: { usedPercent: 28, resetsAtMs: nowMs + 3600_000 },
              weekly: { usedPercent: 12, resetsAtMs: nowMs + 86400_000 },
            },
          }),
          stderr: "",
        };
      },
    });
    assert.equal(live.plan_label, "Power");
    assert.equal(live.primary_window.used_percent, 28);

    // After the window rolls over idle, Muse CLI reports server_sent_no_usage.
    const idle = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 7200_000,
      injectedNowMs: nowMs + 7200_000,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: null,
            reason: "server_sent_no_usage",
          }),
          stderr: "",
        };
      },
    });

    assert.equal(idle.configured, true);
    assert.equal(idle.error, null);
    assert.equal(idle.plan_label, "Power");
    assert.equal(idle.primary_window.used_percent, 0);
    assert.equal(idle.primary_window.reset_at, null);
    assert.equal(idle.secondary_window.used_percent, 0);
    assert.equal(idle.secondary_window.reset_at, null);
  });

  it("clears disk cache and reports subscription required on no_allowance or subs_active=false", async (t) => {
    const home = makeTempHome(t);
    writeUnixMuseBinary(home);
    writeMuseAuth(home, { email: "sub@example.com", subsActive: true });
    const nowMs = Date.parse("2026-11-11T08:00:00.000Z");

    await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs,
      injectedNowMs: nowMs,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "power",
              window: { usedPercent: 45, resetsAtMs: nowMs + 7200_000 },
              weekly: { usedPercent: 20, resetsAtMs: nowMs + 86400_000 },
            },
          }),
          stderr: "",
        };
      },
    });

    // Positive control: transient failure serves the warm disk cache.
    const warm = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 60_000,
      injectedNowMs: nowMs + 60_000,
      commandRunner() {
        return { status: 1, stdout: "", stderr: "usage refresh rate-limited" };
      },
    });
    assert.equal(warm.cached, true);
    assert.equal(warm.primary_window.used_percent, 45);

    // Explicit no_allowance retires the cached subscription.
    const retired = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 120_000,
      injectedNowMs: nowMs + 120_000,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({ allowance: null, reason: "no_allowance" }),
          stderr: "",
        };
      },
    });
    assert.equal(retired.configured, true);
    assert.equal(retired.error, MUSE_SUBSCRIPTION_REQUIRED_MESSAGE);

    // Subsequent transient failure must NOT resurrect the retired plan's bars.
    const afterRetire = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 180_000,
      injectedNowMs: nowMs + 180_000,
      commandRunner() {
        return { status: 1, stdout: "", stderr: "network timeout" };
      },
    });
    assert.equal(afterRetire.cached, undefined);
    assert.match(afterRetire.error, /network timeout/);
  });

  it("never masks credential_rejected behind stale cache and partitions cache by account", async (t) => {
    const home = makeTempHome(t);
    writeUnixMuseBinary(home);
    writeMuseAuth(home, { email: "alice@example.com", subsActive: true });
    const nowMs = Date.parse("2026-11-11T08:00:00.000Z");

    await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs,
      injectedNowMs: nowMs,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "power",
              window: { usedPercent: 61, resetsAtMs: nowMs + 7200_000 },
              weekly: { usedPercent: 33, resetsAtMs: nowMs + 86400_000 },
            },
          }),
          stderr: "",
        };
      },
    });

    // Auth rejection punches straight through even with a warm cache.
    const rejected = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 30_000,
      injectedNowMs: nowMs + 30_000,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({ allowance: null, reason: "credential_rejected" }),
          stderr: "",
        };
      },
    });
    assert.equal(rejected.configured, true);
    assert.equal(rejected.error, MUSE_AUTH_EXPIRED_MESSAGE);
    assert.equal(rejected.auth_action_required, "reauth");

    // Positive control: Alice still gets her cache on a transient rate-limit.
    const aliceCached = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 60_000,
      injectedNowMs: nowMs + 60_000,
      commandRunner() {
        return { status: 1, stdout: "", stderr: "usage refresh rate-limited" };
      },
    });
    assert.equal(aliceCached.cached, true);
    assert.equal(aliceCached.primary_window.used_percent, 61);

    // Switching local auth to Bob refuses Alice's cached bars.
    writeMuseAuth(home, { email: "bob@example.com", subsActive: true });
    const bobFallback = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 90_000,
      injectedNowMs: nowMs + 90_000,
      commandRunner() {
        return { status: 1, stdout: "", stderr: "usage refresh rate-limited" };
      },
    });
    assert.equal(bobFallback.cached, undefined);
    assert.match(bobFallback.error, /rate-limited/);
  });

  it("wires muse into getUsageLimits with official provenance and respects hiddenProviders", async (t) => {
    resetUsageLimitsCache({ invalidateInFlight: true });
    const home = makeTempHome(t);
    writeUnixMuseBinary(home);
    writeMuseAuth(home, { email: "owner@example.com", subsActive: true });

    const nowMs = Date.parse("2026-11-11T08:00:00.000Z");
    const otherProviders = USAGE_LIMITS_PROVIDER_IDS.filter((id) => id !== "muse");
    let museCalls = 0;

    const data = await getUsageLimits({
      home,
      env: {},
      platform: "linux",
      nowMs,
      hiddenProviders: otherProviders,
      commandRunner(_cmd, args) {
        if (Array.isArray(args) && args[0] === "usage") {
          museCalls += 1;
          return {
            status: 0,
            stdout: JSON.stringify({
              allowance: {
                tier: "power",
                window: { usedPercent: 19, resetsAtMs: nowMs + 10800_000 },
                weekly: { usedPercent: 7, resetsAtMs: nowMs + 500000_000 },
              },
            }),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: "" };
      },
    });

    assert.equal(museCalls, 1);
    assert.equal(data.muse.configured, true);
    assert.equal(data.muse.plan_label, "Power");
    assert.equal(data.muse.primary_window.used_percent, 19);
    assert.equal(data.muse.secondary_window.used_percent, 7);
    assert.equal(data.muse.provenance.confidence, "official");
  });
});
