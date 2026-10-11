"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeArkPlansResponse,
  arkProfileIdentity,
  normalizeArkCodingPlanResponse,
  fetchArkCodingPlanLimits,
  writeArkCodingPlanLimitsCache,
} = require("../src/lib/ark-coding-plan-limits");
const {
  runCommand,
  resolveBinaryPath,
  whichBinary,
  commonGlobalBinDirectories,
} = require("../src/lib/command-runner");

const PROFILE_JSON = JSON.stringify({ profile: "coding-plan_test_region_personal", user_id: "test-user-001" });

const USAGE_JSON = JSON.stringify({
  viewer: {
    auth_method: "sso",
    user_id: "test-user-001",
    profile: "coding-plan_test_region_personal",
  },
  items: [
    {
      product: "coding-plan",
      edition: "personal",
      subscribed: true,
      periods: [
        { label: "session", percent: 32.7377, reset_at: "2026-08-11T17:42:00+08:00" },
        { label: "weekly", percent: 15.670588333333333, reset_at: "2026-08-17T00:00:00+08:00" },
        { label: "monthly", percent: 8.179090833333333, reset_at: "2026-09-09T23:59:59+08:00" },
      ],
    },
  ],
});

// Fetch-path fixtures use reset times relative to `nowMs` so the cache
// rollover tests never go stale as wall-clock time moves past a fixed date.
// The viewer identity mirrors PROFILE_JSON so cache snapshots written from
// the usage payload match the identity guard computed from `profile show`.
function usageJsonFor({ nowMs = Date.now(), withTier = false } = {}) {
  const iso = (ms) => new Date(ms).toISOString();
  return JSON.stringify({
    viewer: {
      auth_method: "sso",
      user_id: "test-user-001",
      profile: "coding-plan_test_region_personal",
    },
    items: [
      {
        product: "coding-plan",
        edition: "personal",
        subscribed: true,
        ...(withTier ? { tier: "lite" } : {}),
        periods: [
          { label: "session", percent: 32.7377, reset_at: iso(nowMs + 3 * 3600_000) },
          { label: "weekly", percent: 15.670588333333333, reset_at: iso(nowMs + 3 * 86400_000) },
          { label: "monthly", percent: 8.179090833333333, reset_at: iso(nowMs + 20 * 86400_000) },
        ],
      },
    ],
  });
}

const PLANS_JSON = JSON.stringify({
  plans: [
    { key: "coding-plan", name: "Coding Plan", scope: "personal", tier: "lite", status: "Running" },
  ],
});

// Injects a spawnSync-shaped runner that dispatches on the command name.
// Ark commands arrive as the absolute path resolved by the discovery probe,
// never as a bare "arkcli" — matching what the provider spawns.
function isArkCommand(command) {
  return /arkcli(\.exe)?$/i.test(String(command || ""));
}

function mockRunner({
  which = true,
  plansStdout = PLANS_JSON,
  usageStdout = usageJsonFor(),
  usageStatus = 0,
  usageError = null,
} = {}) {
  return (command, args) => {
    if (command === "which" || command === "where") {
      return which
        ? { status: 0, stdout: "/usr/local/bin/arkcli\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "" };
    }
    // Native Windows discovery probe (where.exe).
    if (command === "where") {
      return which
        ? { status: 0, stdout: "C:\\Program Files\\arkcli.exe\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "" };
    }
    if (isArkCommand(command)) {
      if (args[0] === "plans") {
        return { status: 0, stdout: plansStdout, stderr: "" };
      }
      if (args[0] === "usage") {
        return {
          status: usageStatus,
          stdout: usageStdout,
          stderr: usageError ? "boom" : "",
          ...(usageError ? { error: usageError } : {}),
        };
      }
      if (args[0] === "profile") {
        return { status: 0, stdout: PROFILE_JSON, stderr: "" };
      }
    }
    return { status: 1, stdout: "", stderr: "unknown command" };
  };
}

// Temporary HOME with the ~/.arkcli install-evidence directory by default —
// the spawn-free gate requires it before any binary probe runs.
function tmpHome(t, { arkcliDir = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-plan-test-"));
  if (arkcliDir) fs.mkdirSync(path.join(dir, ".arkcli"), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("normalizeArkCodingPlanResponse maps three periods to windows", () => {
  const result = normalizeArkCodingPlanResponse(JSON.parse(USAGE_JSON));
  assert.equal(result.configured, true);
  assert.equal(result.primary_window.used_percent, 32.7377);
  assert.equal(result.primary_window.reset_at, "2026-08-11T09:42:00.000Z");
  assert.equal(result.primary_window.unit, "calls");
  assert.equal(result.secondary_window.used_percent, 15.670588333333333);
  assert.equal(result.secondary_window.reset_at, "2026-08-16T16:00:00.000Z");
  assert.equal(result.tertiary_window.used_percent, 8.179090833333333);
  assert.equal(result.tertiary_window.reset_at, "2026-09-09T15:59:59.000Z");
  assert.equal(result.source, "provider-api");
});

test("normalizeArkCodingPlanResponse returns null when not subscribed", () => {
  const body = JSON.parse(USAGE_JSON);
  body.items[0].subscribed = false;
  assert.equal(normalizeArkCodingPlanResponse(body), null);
  assert.equal(normalizeArkCodingPlanResponse({ items: [] }), null);
});

test("normalizeArkCodingPlanResponse throws on unusable payload", () => {
  assert.throws(() => normalizeArkCodingPlanResponse(null));
  assert.throws(() => normalizeArkCodingPlanResponse({ items: [{ product: "coding-plan", subscribed: true, periods: [] }] }));
});

test("percentFromPeriod treats null and blank percent as absent and derives used/total", () => {
  const { percentFromPeriod } = require("../src/lib/ark-coding-plan-limits");
  // Number(null) and Number("") are both 0 — a naive check would report a fake
  // fresh 0% window instead of deriving real usage (review #563).
  assert.equal(percentFromPeriod({ percent: null, used: 250, total: 1000 }), 25);
  assert.equal(percentFromPeriod({ percent: "", used: 250, total: 1000 }), 25);
  assert.equal(percentFromPeriod({ percent: undefined, used: 1, total: 4 }), 25);
  // A genuine 0 with no used/total stays 0 (fresh window).
  assert.equal(percentFromPeriod({ percent: 0 }), 0);
  // Direct percent still wins over used/total.
  assert.equal(percentFromPeriod({ percent: 10, used: 250, total: 1000 }), 10);
  // Nothing usable -> NaN so the caller skips the period.
  assert.ok(Number.isNaN(percentFromPeriod({ percent: null })));
});

test("normalizeArkPlansResponse extracts tier from plans payload", () => {
  assert.equal(normalizeArkPlansResponse(JSON.parse(PLANS_JSON)), "lite");
  assert.equal(normalizeArkPlansResponse({ plans: [] }), null);
  assert.equal(normalizeArkPlansResponse({ plans: [{ key: "agent-plan", tier: "pro" }] }), null);
});

test("arkProfileIdentity extracts the account id from profile show's owner_trn", () => {
  // `arkcli profile show --format json` has no user_id field; the account
  // surfaces through owner_trn / identity_key instead.
  const body = {
    name: "coding-plan_cn-beijing_personal",
    owner_trn: "trn:iam::1234567890:root",
    identity_key: "volc-1234567890",
  };
  assert.equal(arkProfileIdentity(body), "coding-plan_cn-beijing_personal:1234567890");
  assert.equal(
    arkProfileIdentity({ name: "p", identity_key: "volc-9876543210" }),
    "p:9876543210",
  );
  // The usage payload's viewer shape must produce the same identity so the
  // cache guard compares equal across both sources.
  assert.equal(
    arkProfileIdentity({ user_id: "1234567890", profile: "coding-plan_cn-beijing_personal" }),
    "coding-plan_cn-beijing_personal:1234567890",
  );
});

test("runCommand stops a verbose child when its combined output exceeds maxBuffer", async () => {
  const result = await runCommand(
    undefined,
    process.execPath,
    [path.join(__dirname, "fixtures", "noisy-command.js")],
    { maxBuffer: 1024, timeout: 2_000 },
  );
  assert.equal(result.status, null);
  assert.equal(result.error?.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
});

test("resolveBinaryPath falls back to a spawn-free probe of global bin dirs", async (t) => {
  const home = tmpHome(t, { arkcliDir: false });
  const binDir = path.join(home, ".npm-global", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "arkcli"), "#!/bin/sh\n", { mode: 0o755 });
  // `which` fails (minimal PATH); the directory probe must find the binary
  // and return its absolute path without any extra spawn.
  const resolved = await resolveBinaryPath("arkcli", {
    commandRunner: async () => ({ status: 1, stdout: "", stderr: "" }),
    home,
    globalBinDirs: [path.join(home, ".npm-global", "bin")],
  });
  assert.equal(resolved, path.join(binDir, "arkcli"));
});

test("resolveBinaryPath returns null when nothing resolves", async (t) => {
  const home = tmpHome(t, { arkcliDir: false });
  const resolved = await resolveBinaryPath("arkcli", {
    commandRunner: async () => ({ status: 1, stdout: "", stderr: "" }),
    home,
    globalBinDirs: [path.join(home, "empty-bin")],
  });
  assert.equal(resolved, null);
});

test("fetchArkCodingPlanLimits succeeds with real payloads", async (t) => {
  const home = tmpHome(t);
  const result = await fetchArkCodingPlanLimits({ commandRunner: mockRunner(), home });
  assert.equal(result.configured, true);
  assert.equal(result.error, null);
  assert.equal(result.plan_label, "Lite");
  assert.equal(result.primary_window.used_percent, 32.7377);
  assert.equal(result.secondary_window.used_percent, 15.670588333333333);
  assert.equal(result.tertiary_window.used_percent, 8.179090833333333);
  assert.equal(result.source, "provider-api");
  // Cache should have been written.
  const cachePath = path.join(home, ".tokentracker", "tracker", "ark-coding-plan-limits-cache.json");
  assert.equal(fs.existsSync(cachePath), true);
});

test("fetchArkCodingPlanLimits skips every spawn without install evidence", async (t) => {
  const calls = [];
  const runner = (command, args) => {
    calls.push({ command, args });
    return mockRunner()(command, args);
  };
  // No config-dir evidence AND no arkcli in any global bin dir → arkcli was
  // never installed on this machine; the provider must bail out before any
  // probe so the 5s poll cadence never pays a spawn for it.
  const result = await fetchArkCodingPlanLimits({
    commandRunner: runner,
    home: tmpHome(t, { arkcliDir: false }),
    globalBinDirs: [],
  });
  assert.deepEqual(result, { configured: false });
  assert.equal(calls.length, 0);
});

test("fetchArkCodingPlanLimits accepts a global-bin arkcli without config-dir evidence", async (t) => {
  // arkcli may keep its config outside ~/.arkcli (e.g. ~/.config/arkcli on
  // Linux): a binary found in a global bin directory still counts as
  // install evidence, resolved spawn-free.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-plan-bindir-"));
  const fakeArkcli = path.join(binDir, "arkcli");
  fs.writeFileSync(fakeArkcli, "#!/bin/sh\n");
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));

  const calls = [];
  const runner = (command, args) => {
    calls.push({ command, args });
    return mockRunner({
      which: false,
      // Tier on the usage payload keeps `plans get` out of this test —
      // the assertion below expects exactly one spawn.
      usageStdout: usageJsonFor({ withTier: true }),
    })(command, args);
  };
  const result = await fetchArkCodingPlanLimits({
    commandRunner: runner,
    home: tmpHome(t, { arkcliDir: false }),
    globalBinDirs: [binDir],
  });
  assert.equal(result.configured, true);
  assert.equal(result.plan_label, "Lite");
  // The stat-resolved absolute path is spawned directly — no `which` spawn
  // was spent to find it.
  assert.deepEqual(calls.map(({ command }) => command), [fakeArkcli]);
});

test("fetchArkCodingPlanLimits reports configured:false when arkcli is missing", async (t) => {
  const result = await fetchArkCodingPlanLimits({
    commandRunner: mockRunner({ which: false }),
    home: tmpHome(t),
    // Empty probe list keeps the directory fallback away from the real
    // filesystem: this machine has arkcli in /opt/homebrew/bin, and the
    // fallback would otherwise find it and break the test.
    globalBinDirs: [],
  });
  assert.deepEqual(result, { configured: false });
});

test("fetchArkCodingPlanLimits reports configured:false when not subscribed", async (t) => {
  const body = JSON.parse(USAGE_JSON);
  body.items[0].subscribed = false;
  const result = await fetchArkCodingPlanLimits({
    commandRunner: mockRunner({ usageStdout: JSON.stringify(body) }),
    home: tmpHome(t),
  });
  assert.deepEqual(result, { configured: false });
});

test("fetchArkCodingPlanLimits falls back to disk cache on command failure", async (t) => {
  const home = tmpHome(t);
  // First run succeeds and writes the cache.
  await fetchArkCodingPlanLimits({ commandRunner: mockRunner(), home });
  // Second run fails; the cached snapshot must be served with stale flags.
  const runner = mockRunner({
    usageError: new Error("ETIMEDOUT"),
    usageStatus: null,
  });
  const result = await fetchArkCodingPlanLimits({ commandRunner: runner, home });
  assert.equal(result.configured, true);
  assert.equal(result.stale, true);
  assert.equal(result.source, "disk-cache");
  assert.equal(result.primary_window.used_percent, 32.7377);
});

test("fetchArkCodingPlanLimits surfaces an error when nothing is usable", async (t) => {
  const runner = mockRunner({
    usageError: new Error("ETIMEDOUT"),
    usageStatus: null,
  });
  const result = await fetchArkCodingPlanLimits({ commandRunner: runner, home: tmpHome(t) });
  assert.equal(result.configured, true);
  assert.match(result.error, /ETIMEDOUT/);
});

test("fetchArkCodingPlanLimits discovers arkcli via where.exe on Windows", async (t) => {
  const calls = [];
  const runner = (command, args) => {
    calls.push({ command, args });
    return mockRunner()(command, args);
  };
  const result = await fetchArkCodingPlanLimits({
    commandRunner: runner,
    home: tmpHome(t),
    platform: "win32",
  });
  assert.equal(result.configured, true);
  assert.equal(result.plan_label, "Lite");
  // Native Windows discovery must use `where`, never the Unix `which` — on
  // Windows `which` does not exist, so spawning it returns ENOENT and every
  // provider would look unconfigured even when arkcli is installed.
  const commands = calls.map(({ command }) => command);
  assert.ok(commands.includes("where"), `expected where.exe probe, got calls: ${commands.join(", ")}`);
  assert.ok(!commands.includes("which"), `must not use which on win32, got calls: ${commands.join(", ")}`);
  assert.deepEqual(calls.find(({ command }) => command === "where")?.args, ["arkcli"]);
});

test("fetchArkCodingPlanLimits spawns the resolved absolute path, not a bare name", async (t) => {
  const arkCommands = [];
  const runner = (command, args) => {
    if (isArkCommand(command)) arkCommands.push(command);
    return mockRunner()(command, args);
  };
  await fetchArkCodingPlanLimits({ commandRunner: runner, home: tmpHome(t) });
  assert.ok(arkCommands.length > 0);
  // Every ark spawn goes through the absolute path from the discovery probe.
  // A bare "arkcli" would re-run PATH search — and on Windows cmd.exe
  // searches the current directory first, enabling a cwd hijack.
  assert.ok(
    arkCommands.every((command) => path.isAbsolute(command)),
    `expected absolute paths, got: ${arkCommands.join(", ")}`,
  );
});

test("fetchArkCodingPlanLimits executes Ark commands through the Windows shell", async (t) => {
  const options = [];
  const runner = (command, args, commandOptions) => {
    options.push({ command, commandOptions });
    return mockRunner()(command, args);
  };
  await fetchArkCodingPlanLimits({ commandRunner: runner, home: tmpHome(t), platform: "win32" });
  assert.ok(options.every(({ command, commandOptions }) => command === "where" || commandOptions.platform === "win32"));
});

test("fetchArkCodingPlanLimits skips plans get when the usage payload carries a tier", async (t) => {
  const calls = [];
  const runner = (command, args) => {
    calls.push(`${String(command).split(path.sep).pop()} ${args[0]}`);
    return mockRunner({ usageStdout: usageJsonFor({ withTier: true }) })(command, args);
  };
  const result = await fetchArkCodingPlanLimits({ commandRunner: runner, home: tmpHome(t) });
  assert.equal(result.configured, true);
  assert.equal(result.plan_label, "Lite");
  // `plans get` is a per-fetch extra round trip — it must only run when the
  // usage response did not already carry the tier.
  assert.ok(!calls.some((entry) => entry.endsWith("plans")), `plans get must be skipped, got: ${calls.join(" | ")}`);
});

test("fetchArkCodingPlanLimits fetches the tier on demand when usage lacks it", async (t) => {
  const order = [];
  const runner = (command, args) => {
    if (isArkCommand(command) && args[0] === "usage") order.push("usage");
    if (isArkCommand(command) && args[0] === "plans") order.push("plans");
    return mockRunner()(command, args);
  };
  const result = await fetchArkCodingPlanLimits({ commandRunner: runner, home: tmpHome(t) });
  assert.equal(result.configured, true);
  assert.equal(result.plan_label, "Lite");
  assert.deepEqual(order, ["usage", "plans"]);
});

test("fetchArkCodingPlanLimits does not serve cache windows past their reset_at", async (t) => {
  const home = tmpHome(t);
  const nowMs = Date.now();
  const expired = new Date(nowMs - 60_000).toISOString();
  // Write a cache whose every window reset before `nowMs` — the quota has
  // rolled over, so the old percentages must not be served as stale data.
  writeArkCodingPlanLimitsCache({
    configured: true,
    error: null,
    plan_label: "Lite",
    profile_identity: "coding-plan_test_region_personal:test-user-001",
    primary_window: { used_percent: 100, reset_at: expired, unit: "calls" },
    secondary_window: { used_percent: 50, reset_at: expired, unit: "calls" },
    tertiary_window: { used_percent: 10, reset_at: expired, unit: "calls" },
  }, { home, nowMs });

  const runner = mockRunner({
    usageError: new Error("ETIMEDOUT"),
    usageStatus: null,
  });
  const result = await fetchArkCodingPlanLimits({ commandRunner: runner, home, nowMs });
  assert.equal(result.configured, true);
  assert.equal(result.stale, undefined, "expired cache must not be served as stale data");
  assert.equal(result.source, undefined);
  assert.match(result.error, /ETIMEDOUT/);
});

test("fetchArkCodingPlanLimits keeps only cache windows that have not reset", async (t) => {
  const home = tmpHome(t);
  const nowMs = Date.now();
  const expired = new Date(nowMs - 60_000).toISOString();
  const future = new Date(nowMs + 60_000).toISOString();
  writeArkCodingPlanLimitsCache({
    configured: true,
    error: null,
    plan_label: "Lite",
    profile_identity: "coding-plan_test_region_personal:test-user-001",
    primary_window: { used_percent: 100, reset_at: expired, unit: "calls" },
    secondary_window: { used_percent: 50, reset_at: future, unit: "calls" },
    tertiary_window: { used_percent: 10, reset_at: expired, unit: "calls" },
  }, { home, nowMs });

  const result = await fetchArkCodingPlanLimits({
    commandRunner: mockRunner({ usageError: new Error("ETIMEDOUT"), usageStatus: null }),
    home,
    nowMs,
  });
  assert.equal(result.configured, true);
  assert.equal(result.stale, true);
  assert.equal(result.source, "disk-cache");
  assert.equal(result.primary_window, null);
  assert.equal(result.secondary_window.used_percent, 50);
  assert.equal(result.tertiary_window, null);
});

test("readArkCodingPlanLimitsCache expires an undated window even with a dated sibling", async (t) => {
  const home = tmpHome(t);
  const nowMs = Date.now();
  writeArkCodingPlanLimitsCache({
    configured: true,
    primary_window: { used_percent: 90, reset_at: null, unit: "calls" },
    secondary_window: { used_percent: 20, reset_at: new Date(nowMs + 86400_000).toISOString(), unit: "calls" },
  }, { home, nowMs: nowMs - 13 * 3600_000 });

  const result = require("../src/lib/ark-coding-plan-limits").readArkCodingPlanLimitsCache({ home, nowMs });
  assert.equal(result.primary_window, null);
  assert.equal(result.secondary_window.used_percent, 20);
});

test("fetchArkCodingPlanLimits passes its cancellation signal to every Ark command", async (t) => {
  const controller = new AbortController();
  const signals = [];
  const runner = (command, args, options) => {
    signals.push({ command, signal: options?.signal });
    return mockRunner()(command, args);
  };

  const result = await fetchArkCodingPlanLimits({
    commandRunner: runner,
    home: tmpHome(t),
    signal: controller.signal,
  });
  assert.equal(result.configured, true);
  // which probe + usage plan + (tier missing →) plans get.
  assert.equal(signals.length, 3);
  assert.ok(signals.every(({ signal }) => signal === controller.signal));
});

test("fetchArkCodingPlanLimits refuses a cache from another profile", async (t) => {
  const home = tmpHome(t);
  const nowMs = Date.now();
  writeArkCodingPlanLimitsCache({
    configured: true,
    profile_identity: "profile-a:user-a",
    primary_window: { used_percent: 42, reset_at: new Date(nowMs + 3600_000).toISOString(), unit: "calls" },
  }, { home, nowMs });
  const runner = (command, args) => {
    if (command === "which" || command === "where") return { status: 0, stdout: "/usr/local/bin/arkcli\n", stderr: "" };
    if (isArkCommand(command) && args[0] === "profile") {
      return { status: 0, stdout: JSON.stringify({ profile: "profile-b", user_id: "user-b" }), stderr: "" };
    }
    return { status: null, stdout: "", stderr: "", error: new Error("ETIMEDOUT") };
  };
  const result = await fetchArkCodingPlanLimits({ commandRunner: runner, home, nowMs });
  assert.equal(result.stale, undefined);
  assert.match(result.error, /ETIMEDOUT/);
});

test("fetchArkCodingPlanLimits opts into shell execution only for arkcli spawns on Windows", async (t) => {
  const seen = [];
  const runner = (command, args, options) => {
    seen.push({ command, args, options });
    return mockRunner()(command, args);
  };
  const result = await fetchArkCodingPlanLimits({
    commandRunner: runner,
    home: tmpHome(t),
    platform: "win32",
  });
  assert.equal(result.configured, true);

  // where.exe is a real executable: a direct spawn resolves it fine, and
  // shell execution would hand its arguments to cmd.exe for re-parsing.
  const whereCall = seen.find(({ command }) => command === "where");
  assert.ok(whereCall, "expected a where.exe discovery probe");
  assert.equal(whereCall.options.useShell, false);

  // npm installs arkcli as a .cmd shim on Windows, which only a shell
  // spawn can execute. Every argument is a constant, so this is safe.
  const arkCalls = seen.filter(({ command }) => isArkCommand(command));
  assert.ok(arkCalls.length > 0);
  for (const call of arkCalls) {
    assert.equal(call.options.useShell, true, `expected shell for ${call.args.join(" ")}`);
  }
});

test("fetchArkCodingPlanLimits bounds profile show with a short timeout on the cache path", async (t) => {
  const seen = [];
  const runner = (command, args, options) => {
    seen.push({ command, args, options });
    return mockRunner({ usageStatus: 1 })(command, args);
  };
  const result = await fetchArkCodingPlanLimits({
    commandRunner: runner,
    home: tmpHome(t),
    globalBinDirs: [],
  });
  // usage plan failed and no cache exists — but the profile guard still ran.
  assert.equal(result.configured, true);
  assert.match(result.error, /exited with code 1/);

  const usageCall = seen.find(({ args }) => args[0] === "usage");
  assert.equal(usageCall.options.timeout, 10_000);
  // `profile show` runs after `usage plan` already failed; a slow arkcli
  // here must not starve the disk-cache read waiting behind it.
  const profileCall = seen.find(({ args }) => args[0] === "profile");
  assert.ok(profileCall, "expected profile show on the cache-guard path");
  assert.equal(profileCall.options.timeout, 2_500);
});

test("fetchArkCodingPlanLimits shrinks later CLI timeouts as the provider budget drains", async (t) => {
  const seen = [];
  const runner = async (command, args, options) => {
    seen.push({ command, args, options });
    // Binary discovery burns real wall-clock budget, as it would against
    // a PATH full of slow directories.
    if (command === "which" || command === "where") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: 0, stdout: "/usr/local/bin/arkcli\n", stderr: "" };
    }
    // usage plan fails so the cache-guard path (profile show) runs too.
    return mockRunner({ usageStatus: 1 })(command, args);
  };
  const result = await fetchArkCodingPlanLimits({
    commandRunner: runner,
    home: tmpHome(t),
    providerTimeoutMs: 4_000,
  });
  assert.equal(result.configured, true);

  const usageCall = seen.find(({ args }) => args[0] === "usage");
  assert.ok(usageCall, "expected usage plan to still run");
  // ~300ms spent on discovery leaves ~3.7s; minus the 1.5s kill guard the
  // usage timeout must clamp well below its full 10s.
  assert.ok(usageCall.options.timeout > 0 && usageCall.options.timeout <= 2_600,
    `usage timeout should be clamped to the remaining budget, got ${usageCall.options.timeout}`);

  const profileCall = seen.find(({ args }) => args[0] === "profile");
  assert.ok(profileCall, "expected profile show on the cache-guard path");
  assert.ok(profileCall.options.timeout > 0 && profileCall.options.timeout < 2_500,
    `profile timeout should shrink below its full 2.5s, got ${profileCall.options.timeout}`);
});

test("fetchArkCodingPlanLimits still serves the disk cache after a hung usage plan drains the budget", async (t) => {
  const home = tmpHome(t);
  const nowMs = Date.now();
  writeArkCodingPlanLimitsCache({
    configured: true,
    plan_label: "Lite",
    primary_window: { used_percent: 42, reset_at: new Date(nowMs + 3600_000).toISOString(), unit: "calls" },
  }, { home, nowMs });

  const seen = [];
  const result = await fetchArkCodingPlanLimits({
    commandRunner: async (command, args, options) => {
      seen.push({ command, args, options });
      if (command === "which" || command === "where") {
        return { status: 0, stdout: "/usr/local/bin/arkcli\n", stderr: "" };
      }
      if (args[0] === "usage") {
        // Simulate `usage plan` running until its budgeted timeout kills
        // it: real elapsed time, then a timeout-shaped failure.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return { status: null, stdout: "", stderr: "", error: new Error("spawn arkcli ETIMEDOUT") };
      }
      return mockRunner()(command, args, options);
    },
    home,
    nowMs,
    providerTimeoutMs: 2_600,
  });

  // Last-known data instead of an error — clamping the serial chain to
  // the provider budget is what lets the cache fallback resolve inside
  // the outer race.
  assert.equal(result.cached, true);
  assert.equal(result.stale, true);
  assert.equal(result.source, "disk-cache");
  assert.equal(result.plan_label, "Lite");

  // `usage plan` ran to its (shrunk) timeout; `profile show` no longer
  // fits in the remaining budget, so it is skipped and the cache is read
  // fail-open — exactly the hung-CLI scenario the guard exists for.
  const arkCommands = seen.filter(({ command }) => isArkCommand(command)).map(({ args }) => args[0]);
  assert.deepEqual(arkCommands, ["usage"], "profile show must be skipped once the budget is drained");
});

test("whichBinary strips CRLF when where lists multiple matches", async () => {
  // Windows `where` emits CRLF and one line per PATH hit. The first line
  // must come back without its `\r`, or the polluted path fails at spawn.
  const runner = (command) => {
    if (command === "where") {
      return { status: 0, stdout: "C:\\A\\arkcli.cmd\r\nC:\\B\\arkcli.cmd\r\n", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
  const resolved = await whichBinary("arkcli", { commandRunner: runner, platform: "win32" });
  assert.equal(resolved, "C:\\A\\arkcli.cmd");
});

test("fetchArkCodingPlanLimits drops the cache once the plan is unsubscribed", async (t) => {
  const home = tmpHome(t);
  const nowMs = Date.now();
  const cachePath = path.join(home, ".tokentracker", "tracker", "ark-coding-plan-limits-cache.json");

  // Subscribed era: a live read wrote the cache.
  writeArkCodingPlanLimitsCache({
    configured: true,
    plan_label: "Lite",
    primary_window: { used_percent: 42, reset_at: new Date(nowMs + 3600_000).toISOString(), unit: "calls" },
  }, { home, nowMs });
  assert.equal(fs.existsSync(cachePath), true);

  // The user unsubscribes: the authoritative live response says so.
  const unsubscribed = JSON.parse(usageJsonFor({ nowMs }));
  unsubscribed.items[0].subscribed = false;
  const gone = await fetchArkCodingPlanLimits({
    commandRunner: mockRunner({ usageStdout: JSON.stringify(unsubscribed) }),
    home,
    nowMs,
  });
  assert.deepEqual(gone, { configured: false });
  assert.equal(fs.existsSync(cachePath), false, "cache must be dropped on unsubscribe");

  // A later transient CLI failure must not resurrect the retired plan.
  const hung = await fetchArkCodingPlanLimits({
    commandRunner: (command, args) => {
      if (command === "which" || command === "where") return { status: 0, stdout: "/usr/local/bin/arkcli\n", stderr: "" };
      if (isArkCommand(command)) {
        return { status: null, stdout: "", stderr: "", error: new Error("ETIMEDOUT") };
      }
      return { status: 1, stdout: "", stderr: "" };
    },
    home,
    nowMs,
  });
  assert.equal(hung.stale, undefined);
  assert.equal(hung.cached, undefined);
  assert.match(hung.error, /ETIMEDOUT/);
});

test("fetchArkCodingPlanLimits keeps the cache when the payload carries no coding-plan entry", async (t) => {
  const home = tmpHome(t);
  const nowMs = Date.now();
  const cachePath = path.join(home, ".tokentracker", "tracker", "ark-coding-plan-limits-cache.json");
  writeArkCodingPlanLimitsCache({
    configured: true,
    plan_label: "Lite",
    primary_window: { used_percent: 42, reset_at: new Date(nowMs + 3600_000).toISOString(), unit: "calls" },
  }, { home, nowMs });

  // `{}`, empty items, or a renamed product key can all be transient states
  // (not logged in, backend degraded) — none of them is a confirmed
  // unsubscribe, so none may destroy the disk cache.
  const ambiguous = [
    {},
    { items: [] },
    { items: [{ product: "some-other-plan", subscribed: true }] },
  ];
  for (const body of ambiguous) {
    const result = await fetchArkCodingPlanLimits({
      commandRunner: mockRunner({ usageStdout: JSON.stringify(body) }),
      home,
      nowMs,
    });
    assert.deepEqual(result, { configured: false });
  }
  assert.equal(fs.existsSync(cachePath), true, "ambiguous payloads must not destroy the cache");
});

test("commonGlobalBinDirectories expands nvm and fnm version directories", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ark-bin-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".nvm", "versions", "node", "v22.1.0", "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, ".nvm", "versions", "node", "v18.0.0", "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, ".local", "share", "fnm", "node-versions", "v22.1.0", "installation", "bin"), { recursive: true });
  // A stray file inside the versions root must not become a bin candidate.
  fs.writeFileSync(path.join(home, ".nvm", "versions", "node", "release-notes.txt"), "not a version");

  const dirs = commonGlobalBinDirectories({ home, platform: "linux" });
  // nvm entries are expanded newest-first so the active Node's global bin
  // is probed before stale versions.
  assert.deepEqual(
    dirs.filter((dir) => dir.includes(".nvm")),
    [
      path.join(home, ".nvm", "versions", "node", "v22.1.0", "bin"),
      path.join(home, ".nvm", "versions", "node", "v18.0.0", "bin"),
    ],
  );
  assert.ok(dirs.includes(
    path.join(home, ".local", "share", "fnm", "node-versions", "v22.1.0", "installation", "bin"),
  ));
});
