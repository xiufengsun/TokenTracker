"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeArkAgentPlansResponse,
  normalizeArkAgentPlanResponse,
  percentFromPeriod,
  fetchArkAgentPlanLimits,
  writeArkAgentPlanLimitsCache,
} = require("../src/lib/ark-agent-plan-limits");

// Real-world shape from issue #555 (Agent Plan subscriber, arkcli 1.0.24):
// periods carry used/total and may omit percent entirely (fresh 5h window).
function usageJsonFor({ nowMs = Date.now(), periods } = {}) {
  return JSON.stringify({
    viewer: { auth_method: "sso", user_id: "test-user-001", profile: "agent-plan_cn-beijing_personal" },
    items: [
      {
        product: "agent-plan",
        edition: "personal",
        tier: "medium",
        subscribed: true,
        periods,
      },
    ],
  });
}

function mockRunner({ which = true, usageStdout = "", usageStatus = 0, plansStdout = "{}" } = {}) {
  return (command, args) => {
    if (command === "which" || command === "where") {
      return which
        ? { status: 0, stdout: "/usr/local/bin/arkcli\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "" };
    }
    if (/arkcli(\.exe)?$/i.test(String(command || ""))) {
      if (args[0] === "usage") return { status: usageStatus, stdout: usageStdout, stderr: "" };
      if (args[0] === "plans") return { status: 0, stdout: plansStdout, stderr: "" };
      if (args[0] === "profile") {
        return { status: 0, stdout: JSON.stringify({ profile: "agent-plan_cn-beijing_personal", user_id: "test-user-001" }), stderr: "" };
      }
    }
    return { status: 1, stdout: "", stderr: "" };
  };
}

function tmpHome(t, { arkcliDir = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-agent-plan-test-"));
  if (arkcliDir) fs.mkdirSync(path.join(dir, ".arkcli"), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("normalizeArkAgentPlansResponse extracts the agent-plan tier", () => {
  assert.equal(normalizeArkAgentPlansResponse({ plans: [{ key: "agent-plan", tier: "medium" }] }), "medium");
  assert.equal(normalizeArkAgentPlansResponse({ plans: [{ key: "coding-plan", tier: "lite" }] }), null);
  assert.equal(normalizeArkAgentPlansResponse({ plans: [] }), null);
});

test("normalizeArkAgentPlanResponse maps 5h/weekly/monthly and skips daily", () => {
  const result = normalizeArkAgentPlanResponse(JSON.parse(usageJsonFor({
    periods: [
      { label: "5h", used: 250, total: 10000, percent: 2.5, reset_at: "2026-09-03T06:00:00+08:00" },
      { label: "weekly", used: 5961.07, total: 35000, percent: 17.03162857142857, reset_at: "2026-09-07T00:00:00+08:00" },
      { label: "monthly", used: 5961.07, total: 100000, percent: 5.961069999999999, reset_at: "2026-10-01T23:59:59+08:00" },
      { label: "daily", used: 100, total: 1000, percent: 10, reset_at: "2026-09-03T00:00:00+08:00" },
    ],
  })));
  assert.equal(result.configured, true);
  assert.equal(result.product, "agent-plan");
  assert.equal(result.plan_label, "Medium");
  assert.equal(result.primary_window.used_percent, 2.5);
  assert.equal(result.secondary_window.used_percent, 17.03162857142857);
  assert.equal(result.tertiary_window.used_percent, 5.961069999999999);
});

test("normalizeArkAgentPlanResponse derives percent from used/total when percent is null or blank", () => {
  // Real #555 shape: the fresh 5h period has no percent/used at all — the
  // window is genuinely 0% and must not block the other periods.
  const result = normalizeArkAgentPlanResponse(JSON.parse(usageJsonFor({
    periods: [
      { label: "5h", total: 10000, percent: 0 },
      { label: "weekly", used: 5961.07, total: 35000, percent: null, reset_at: "2026-09-07T00:00:00+08:00" },
      { label: "monthly", used: 5961.07, total: 100000, percent: "", reset_at: "2026-10-01T23:59:59+08:00" },
    ],
  })));
  assert.equal(result.primary_window.used_percent, 0);
  assert.equal(result.secondary_window.used_percent, (5961.07 / 35000) * 100);
  assert.equal(result.tertiary_window.used_percent, (5961.07 / 100000) * 100);
});

test("percentFromPeriod treats null and blank percent as absent and derives used/total", () => {
  assert.equal(percentFromPeriod({ percent: null, used: 250, total: 1000 }), 25);
  assert.equal(percentFromPeriod({ percent: "", used: 250, total: 1000 }), 25);
  assert.equal(percentFromPeriod({ percent: undefined, used: 1, total: 4 }), 25);
  assert.equal(percentFromPeriod({ percent: 0 }), 0);
  assert.equal(percentFromPeriod({ percent: 10, used: 250, total: 1000 }), 10);
  assert.ok(Number.isNaN(percentFromPeriod({ percent: null })));
});

test("team products are not surfaced as the personal agent plan", () => {
  const result = normalizeArkAgentPlanResponse({
    viewer: { user_id: "1", profile: "p" },
    items: [{ product: "agent-plan-team", subscribed: true, tier: "large", periods: [{ label: "5h", percent: 10 }] }],
  });
  assert.equal(result, null);
});

test("fetchArkAgentPlanLimits succeeds with a real agent-plan payload", async (t) => {
  const home = tmpHome(t);
  const nowMs = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const usageStdout = usageJsonFor({
    nowMs,
    periods: [
      { label: "5h", used: 250, total: 10000, percent: 2.5, reset_at: iso(nowMs + 3 * 3600_000) },
      { label: "weekly", used: 5961.07, total: 35000, percent: 17, reset_at: iso(nowMs + 3 * 86400_000) },
      { label: "monthly", used: 5961.07, total: 100000, percent: 6, reset_at: iso(nowMs + 20 * 86400_000) },
    ],
  });
  const result = await fetchArkAgentPlanLimits({
    commandRunner: mockRunner({ usageStdout, plansStdout: JSON.stringify({ plans: [{ key: "agent-plan", tier: "medium" }] }) }),
    home,
    nowMs,
  });
  assert.equal(result.configured, true);
  assert.equal(result.error, null);
  assert.equal(result.plan_label, "Medium");
  assert.equal(result.primary_window.used_percent, 2.5);
  const cachePath = path.join(home, ".tokentracker", "tracker", "ark-agent-plan-limits-cache.json");
  assert.equal(fs.existsSync(cachePath), true);
});

test("fetchArkAgentPlanLimits reports a friendly 127 message and serves the disk cache", async (t) => {
  const home = tmpHome(t);
  const nowMs = Date.now();
  writeArkAgentPlanLimitsCache({
    configured: true,
    error: null,
    plan_label: "Medium",
    product: "agent-plan",
    primary_window: { used_percent: 25, reset_at: new Date(nowMs + 3600_000).toISOString(), unit: "calls" },
  }, { home, nowMs });

  const cached = await fetchArkAgentPlanLimits({
    commandRunner: (command) => (command === "which" || command === "where"
      ? { status: 0, stdout: "/usr/local/bin/arkcli\n", stderr: "" }
      : { status: 127, stdout: "", stderr: "command not found" }),
    home,
    nowMs,
  });
  assert.equal(cached.cached, true);
  assert.equal(cached.stale, true);
  assert.equal(cached.primary_window.used_percent, 25);

  // Without a cache the raw 127 becomes an actionable hint instead.
  const home2 = tmpHome(t);
  const errored = await fetchArkAgentPlanLimits({
    commandRunner: (command) => (command === "which" || command === "where"
      ? { status: 0, stdout: "/usr/local/bin/arkcli\n", stderr: "" }
      : { status: 127, stdout: "", stderr: "command not found" }),
    home: home2,
    nowMs,
  });
  assert.match(errored.error, /update arkcli/);
});

test("fetchArkAgentPlanLimits reports configured:false when arkcli is missing", async (t) => {
  const result = await fetchArkAgentPlanLimits({
    commandRunner: mockRunner({ which: false }),
    home: tmpHome(t),
    globalBinDirs: [],
  });
  assert.deepEqual(result, { configured: false });
});
