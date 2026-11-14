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
  fingerprintMuseAccount,
  resolveMuseCommand,
  normalizeMuseUsageResponse,
  museLimitsCachePath,
  readMuseLimitsCache,
  clearMuseLimitsCache,
  readCachedMusePlanLabel,
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

  it("preserves unexpired cached weekly quota on server_sent_no_usage and returns secondary_window: null when unknown", async (t) => {
    const home = makeTempHome(t);
    writeUnixMuseBinary(home);
    writeMuseAuth(home, { email: "user@example.com", subsActive: true });

    const nowMs = Date.parse("2026-11-11T08:00:00.000Z");
    const weeklyResetMs = nowMs + 86400_000;

    // Cold-start server_sent_no_usage before any cached snapshot exists:
    // 5h is idle 0%, weekly is unknown (null) rather than fabricated 0%.
    const coldIdle = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs,
      injectedNowMs: nowMs,
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
    assert.equal(coldIdle.configured, true);
    assert.equal(coldIdle.error, null);
    assert.equal(coldIdle.plan_label, null);
    assert.equal("profile_identity" in coldIdle, false);
    assert.equal(coldIdle.cached, undefined);
    assert.equal(coldIdle.stale, false);
    assert.equal(coldIdle.source, "provider-api");
    assert.equal(coldIdle.cached_at, new Date(nowMs).toISOString());
    assert.deepEqual(coldIdle.primary_window, {
      used_percent: 0,
      reset_at: null,
      limit_window_seconds: MUSE_FIVE_HOUR_WINDOW_SECONDS,
    });
    assert.equal(coldIdle.secondary_window, null);

    // Seed disk cache with a live Power reading carrying non-zero weekly usage.
    const liveCapturedAtMs = nowMs + 60_000;
    const live = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: liveCapturedAtMs,
      injectedNowMs: liveCapturedAtMs,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "power",
              window: { usedPercent: 28, resetsAtMs: nowMs + 3600_000 },
              weekly: { usedPercent: 12, resetsAtMs: weeklyResetMs },
            },
          }),
          stderr: "",
        };
      },
    });
    assert.equal(live.plan_label, "Power");
    assert.equal(live.primary_window.used_percent, 28);
    assert.equal(live.cached_at, new Date(liveCapturedAtMs).toISOString());
    assert.equal("profile_identity" in live, false);

    // After the 5h window rolls over idle, weekly is still unexpired -> preserve 12%
    // AND preserve the weekly snapshot's original capture time + disk-cache provenance.
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
    assert.equal("profile_identity" in idle, false);
    assert.equal(idle.cached, true);
    assert.equal(idle.stale, true);
    assert.equal(idle.source, "disk-cache");
    assert.equal(idle.cached_at, live.cached_at);
    assert.deepEqual(idle.primary_window, {
      used_percent: 0,
      reset_at: null,
      limit_window_seconds: MUSE_FIVE_HOUR_WINDOW_SECONDS,
    });
    assert.deepEqual(idle.secondary_window, {
      used_percent: 12,
      reset_at: new Date(weeklyResetMs).toISOString(),
      limit_window_seconds: MUSE_WEEKLY_WINDOW_SECONDS,
    });

    // Repeated idle polls must not launder the preserved weekly snapshot's age,
    // and getUsageLimits must surface disk-cache / observed stale provenance.
    resetUsageLimitsCache({ invalidateInFlight: true });
    const otherProviders = USAGE_LIMITS_PROVIDER_IDS.filter((id) => id !== "muse");
    const aggregatedIdle = await getUsageLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 14400_000,
      forceRefresh: true,
      hiddenProviders: otherProviders,
      commandRunner(_cmd, args) {
        if (Array.isArray(args) && args[0] === "usage") {
          return {
            status: 0,
            stdout: JSON.stringify({
              allowance: null,
              reason: "server_sent_no_usage",
            }),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: "" };
      },
    });
    assert.equal(aggregatedIdle.muse.secondary_window.used_percent, 12);
    assert.equal(aggregatedIdle.muse.cached_at, live.cached_at);
    assert.equal(aggregatedIdle.muse.provenance.source, "disk-cache");
    assert.equal(aggregatedIdle.muse.provenance.confidence, "observed");
    assert.equal(aggregatedIdle.muse.provenance.stale, true);
    assert.equal(aggregatedIdle.muse.provenance.captured_at, live.cached_at);

    // Once the weekly reset has also elapsed, secondary_window drops to null (unknown)
    // and the idle response returns to fresh provider-api provenance.
    const afterWeeklyResetMs = weeklyResetMs + 60_000;
    const afterWeeklyReset = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: afterWeeklyResetMs,
      injectedNowMs: afterWeeklyResetMs,
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
    assert.equal(afterWeeklyReset.plan_label, "Power");
    assert.equal(afterWeeklyReset.primary_window.used_percent, 0);
    assert.equal(afterWeeklyReset.primary_window.reset_at, null);
    assert.equal(afterWeeklyReset.secondary_window, null);
    assert.equal(afterWeeklyReset.cached, undefined);
    assert.equal(afterWeeklyReset.stale, false);
    assert.equal(afterWeeklyReset.source, "provider-api");
    assert.equal(afterWeeklyReset.cached_at, new Date(afterWeeklyResetMs).toISOString());
  });

  it("keeps a fresh idle 5h window cacheable when the carried weekly snapshot is older than 12h", async (t) => {
    const home = makeTempHome(t);
    writeUnixMuseBinary(home);
    writeMuseAuth(home, { email: "split@example.com", subsActive: true });

    const liveMs = Date.parse("2026-11-11T08:00:00.000Z");
    const weeklyResetMs = liveMs + 3 * 86400_000;
    const idleRunner = () => ({
      status: 0,
      stdout: JSON.stringify({ allowance: null, reason: "server_sent_no_usage" }),
      stderr: "",
    });
    const failingRunner = () => ({ status: 1, stdout: "", stderr: "temporary outage" });

    const live = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: liveMs,
      injectedNowMs: liveMs,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "power",
              window: { usedPercent: 40, resetsAtMs: liveMs + 3600_000 },
              weekly: { usedPercent: 33, resetsAtMs: weeklyResetMs },
            },
          }),
          stderr: "",
        };
      },
    });
    const liveCapturedAt = new Date(liveMs).toISOString();
    assert.equal(live.cached_at, liveCapturedAt);

    // 13h later (past the 12h undated-window TTL): idle poll carries weekly forward.
    const idleMs = liveMs + 13 * 3600_000;
    const idle = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: idleMs,
      injectedNowMs: idleMs,
      commandRunner: idleRunner,
    });
    assert.equal(idle.secondary_window.used_percent, 33);
    assert.equal(idle.primary_window.used_percent, 0);
    assert.equal(idle.cached_at, liveCapturedAt);
    assert.equal(idle.stale, true);
    assert.equal(idle.source, "disk-cache");
    assert.equal("secondary_captured_at" in idle, false);
    assert.equal("profile_identity" in idle, false);

    // On disk the entry is stamped with the idle poll time; the weekly window
    // keeps its original capture time separately.
    const raw = JSON.parse(fs.readFileSync(museLimitsCachePath({ home }), "utf8"));
    assert.equal(raw.cached_at, new Date(idleMs).toISOString());
    assert.equal(raw.secondary_captured_at, liveCapturedAt);

    // A transient CLI failure right after the idle poll still serves BOTH windows,
    // reporting the weekly snapshot's (older) capture time.
    const fallback = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: idleMs + 60_000,
      injectedNowMs: idleMs + 60_000,
      commandRunner: failingRunner,
    });
    assert.equal(fallback.cached, true);
    assert.equal(fallback.stale, true);
    assert.deepEqual(fallback.primary_window, {
      used_percent: 0,
      reset_at: null,
      limit_window_seconds: MUSE_FIVE_HOUR_WINDOW_SECONDS,
    });
    assert.equal(fallback.secondary_window.used_percent, 33);
    assert.equal(fallback.cached_at, liveCapturedAt);
    assert.equal("secondary_captured_at" in fallback, false);
    assert.equal("profile_identity" in fallback, false);

    // A later idle poll must not launder the weekly capture time.
    const laterIdleMs = idleMs + 3600_000;
    const laterIdle = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: laterIdleMs,
      injectedNowMs: laterIdleMs,
      commandRunner: idleRunner,
    });
    assert.equal(laterIdle.secondary_window.used_percent, 33);
    assert.equal(laterIdle.cached_at, liveCapturedAt);
    const rawLater = JSON.parse(fs.readFileSync(museLimitsCachePath({ home }), "utf8"));
    assert.equal(rawLater.cached_at, new Date(laterIdleMs).toISOString());
    assert.equal(rawLater.secondary_captured_at, liveCapturedAt);

    // A fresh live allowance clears the carried-weekly marker.
    const relive = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: laterIdleMs + 60_000,
      injectedNowMs: laterIdleMs + 60_000,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "power",
              window: { usedPercent: 5, resetsAtMs: laterIdleMs + 3600_000 },
              weekly: { usedPercent: 35, resetsAtMs: weeklyResetMs },
            },
          }),
          stderr: "",
        };
      },
    });
    assert.equal(relive.stale, false);
    assert.equal(relive.cached_at, new Date(laterIdleMs + 60_000).toISOString());
    const rawRelive = JSON.parse(fs.readFileSync(museLimitsCachePath({ home }), "utf8"));
    assert.equal(rawRelive.secondary_captured_at, null);
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

    // Positive control: transient failure serves the warm disk cache and strips profile_identity.
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
    assert.equal("profile_identity" in warm, false);
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

  it("isolates cache reads, writes, and clears across custom trackerDir directories", async (t) => {
    const home = makeTempHome(t);
    writeUnixMuseBinary(home);
    writeMuseAuth(home, { email: "isolated@example.com", subsActive: true });
    const nowMs = Date.parse("2026-11-11T08:00:00.000Z");

    const trackerDirA = path.join(home, "tracker-a");
    const trackerDirB = path.join(home, "tracker-b");

    assert.equal(
      museLimitsCachePath({ home, trackerDir: trackerDirA }),
      path.join(trackerDirA, "muse-limits-cache.json"),
    );
    assert.equal(
      museLimitsCachePath({ home, trackerDir: trackerDirB }),
      path.join(trackerDirB, "muse-limits-cache.json"),
    );

    await fetchMuseLimits({
      home,
      trackerDir: trackerDirA,
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
              window: { usedPercent: 31, resetsAtMs: nowMs + 7200_000 },
              weekly: { usedPercent: 11, resetsAtMs: nowMs + 86400_000 },
            },
          }),
          stderr: "",
        };
      },
    });

    assert.equal(fs.existsSync(path.join(home, ".tokentracker", "tracker", "muse-limits-cache.json")), false);

    // trackerDirB has no cache entry yet, so a transient failure misses cleanly.
    const missB = await fetchMuseLimits({
      home,
      trackerDir: trackerDirB,
      env: {},
      platform: "linux",
      nowMs: nowMs + 10_000,
      injectedNowMs: nowMs + 10_000,
      commandRunner() {
        return { status: 1, stdout: "", stderr: "temporary outage" };
      },
    });
    assert.equal(missB.cached, undefined);
    assert.match(missB.error, /temporary outage/);

    // Populate trackerDirB with distinct values.
    await fetchMuseLimits({
      home,
      trackerDir: trackerDirB,
      env: {},
      platform: "linux",
      nowMs: nowMs + 20_000,
      injectedNowMs: nowMs + 20_000,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "pro",
              window: { usedPercent: 74, resetsAtMs: nowMs + 7200_000 },
              weekly: { usedPercent: 52, resetsAtMs: nowMs + 86400_000 },
            },
          }),
          stderr: "",
        };
      },
    });

    const warmA = await fetchMuseLimits({
      home,
      trackerDir: trackerDirA,
      env: {},
      platform: "linux",
      nowMs: nowMs + 30_000,
      injectedNowMs: nowMs + 30_000,
      commandRunner() {
        return { status: 1, stdout: "", stderr: "rate-limited" };
      },
    });
    const warmB = await fetchMuseLimits({
      home,
      trackerDir: trackerDirB,
      env: {},
      platform: "linux",
      nowMs: nowMs + 30_000,
      injectedNowMs: nowMs + 30_000,
      commandRunner() {
        return { status: 1, stdout: "", stderr: "rate-limited" };
      },
    });
    assert.equal(warmA.plan_label, "Power");
    assert.equal(warmA.primary_window.used_percent, 31);
    assert.equal(warmB.plan_label, "Pro");
    assert.equal(warmB.primary_window.used_percent, 74);

    // Clearing trackerDirA leaves trackerDirB intact.
    clearMuseLimitsCache({ home, trackerDir: trackerDirA });
    const clearedA = await fetchMuseLimits({
      home,
      trackerDir: trackerDirA,
      env: {},
      platform: "linux",
      nowMs: nowMs + 40_000,
      injectedNowMs: nowMs + 40_000,
      commandRunner() {
        return { status: 1, stdout: "", stderr: "rate-limited" };
      },
    });
    const survivingB = await fetchMuseLimits({
      home,
      trackerDir: trackerDirB,
      env: {},
      platform: "linux",
      nowMs: nowMs + 40_000,
      injectedNowMs: nowMs + 40_000,
      commandRunner() {
        return { status: 1, stdout: "", stderr: "rate-limited" };
      },
    });
    assert.equal(clearedA.cached, undefined);
    assert.equal(survivingB.cached, true);
    assert.equal(survivingB.primary_window.used_percent, 74);
  });

  it("fails closed when auth.json is missing or lacks identity after sign-out", async (t) => {
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
              window: { usedPercent: 58, resetsAtMs: nowMs + 7200_000 },
              weekly: { usedPercent: 29, resetsAtMs: nowMs + 86400_000 },
            },
          }),
          stderr: "",
        };
      },
    });

    assert.equal(
      readCachedMusePlanLabel({
        home,
        profileIdentity: fingerprintMuseAccount("alice@example.com"),
      }),
      "Power",
    );
    assert.equal(readCachedMusePlanLabel({ home, profileIdentity: null }), null);
    assert.equal(
      readCachedMusePlanLabel({
        home,
        profileIdentity: fingerprintMuseAccount("bob@example.com"),
      }),
      null,
    );
    assert.equal(readMuseLimitsCache({ home, nowMs: nowMs + 10_000, profileIdentity: null }), null);

    // Simulate sign-out by removing auth.json: neither transient fallback nor
    // server_sent_no_usage may leak Alice's cached quota or plan_label.
    fs.unlinkSync(path.join(home, ".config", "muse", "auth.json"));

    const signedOutFallback = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 30_000,
      injectedNowMs: nowMs + 30_000,
      commandRunner() {
        return { status: 1, stdout: "", stderr: "network unreachable" };
      },
    });
    assert.equal(signedOutFallback.cached, undefined);
    assert.match(signedOutFallback.error, /network unreachable/);

    const identitylessIdle = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 60_000,
      injectedNowMs: nowMs + 60_000,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({ allowance: null, reason: "server_sent_no_usage" }),
          stderr: "",
        };
      },
    });
    assert.equal(identitylessIdle.plan_label, null);
    assert.equal(identitylessIdle.secondary_window, null);
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
    assert.equal("profile_identity" in aliceCached, false);
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

  it("withholds live quota and skips cache write when auth.json switches accounts or signs out mid-command", async (t) => {
    const home = makeTempHome(t);
    writeUnixMuseBinary(home);
    writeMuseAuth(home, { email: "alice@example.com", subsActive: true });
    const nowMs = Date.parse("2026-11-11T08:00:00.000Z");

    // Alice starts `muse usage --json`, and while the CLI is running the user
    // logs in as Bob. Alice's 77% quota must neither be returned for Bob nor
    // written into Bob's disk cache.
    const racedSwitch = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs,
      injectedNowMs: nowMs,
      commandRunner() {
        writeMuseAuth(home, { email: "bob@example.com", subsActive: true });
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "power",
              window: { usedPercent: 77, resetsAtMs: nowMs + 7200_000 },
              weekly: { usedPercent: 41, resetsAtMs: nowMs + 86400_000 },
            },
          }),
          stderr: "",
        };
      },
    });
    assert.equal(racedSwitch.configured, true);
    assert.equal(racedSwitch.primary_window, undefined);
    assert.equal(racedSwitch.cached, undefined);
    assert.match(racedSwitch.error, /account changed/i);

    // Verify Bob's cache was NOT poisoned by Alice's in-flight response.
    const bobAfterRace = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 15_000,
      injectedNowMs: nowMs + 15_000,
      commandRunner() {
        return { status: 1, stdout: "", stderr: "rate-limited" };
      },
    });
    assert.equal(bobAfterRace.cached, undefined);
    assert.match(bobAfterRace.error, /rate-limited/);
    assert.equal(
      readMuseLimitsCache({
        home,
        nowMs: nowMs + 15_000,
        profileIdentity: fingerprintMuseAccount("bob@example.com"),
      }),
      null,
    );

    // Seed Bob's legitimate cache (22%), switch to Alice before a poll, then
    // switch back to Bob mid-command: fallback serves Bob's 22% (without
    // profile_identity), never Alice's 88%.
    await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 30_000,
      injectedNowMs: nowMs + 30_000,
      commandRunner() {
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "pro",
              window: { usedPercent: 22, resetsAtMs: nowMs + 7200_000 },
              weekly: { usedPercent: 9, resetsAtMs: nowMs + 86400_000 },
            },
          }),
          stderr: "",
        };
      },
    });

    writeMuseAuth(home, { email: "alice@example.com", subsActive: true });
    const racedBackToBob = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 45_000,
      injectedNowMs: nowMs + 45_000,
      commandRunner() {
        writeMuseAuth(home, { email: "bob@example.com", subsActive: true });
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "power",
              window: { usedPercent: 88, resetsAtMs: nowMs + 7200_000 },
              weekly: { usedPercent: 64, resetsAtMs: nowMs + 86400_000 },
            },
          }),
          stderr: "",
        };
      },
    });
    assert.equal(racedBackToBob.cached, true);
    assert.equal("profile_identity" in racedBackToBob, false);
    assert.equal(racedBackToBob.plan_label, "Pro");
    assert.equal(racedBackToBob.primary_window.used_percent, 22);

    // Mid-command sign-out (auth.json deleted while Bob's CLI call is running)
    // must also withhold Bob's live response and Bob's warm cache.
    const racedSignOut = await fetchMuseLimits({
      home,
      env: {},
      platform: "linux",
      nowMs: nowMs + 60_000,
      injectedNowMs: nowMs + 60_000,
      commandRunner() {
        fs.unlinkSync(path.join(home, ".config", "muse", "auth.json"));
        return {
          status: 0,
          stdout: JSON.stringify({
            allowance: {
              tier: "pro",
              window: { usedPercent: 25, resetsAtMs: nowMs + 7200_000 },
              weekly: { usedPercent: 10, resetsAtMs: nowMs + 86400_000 },
            },
          }),
          stderr: "",
        };
      },
    });
    assert.equal(racedSignOut.cached, undefined);
    assert.equal(racedSignOut.primary_window, undefined);
    assert.match(racedSignOut.error, /account changed/i);
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
