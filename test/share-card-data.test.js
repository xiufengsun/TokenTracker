const test = require("node:test");
const assert = require("node:assert/strict");
const { loadDashboardModule } = require("./helpers/load-dashboard-module");

let mod;

test.before(async () => {
  // These fixtures assert English copy. Node's navigator follows the Windows
  // system language, so pin the simulated browser language during module init.
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language: "en-US", languages: ["en-US"] },
  });
  try {
    mod = await loadDashboardModule("dashboard/src/ui/share/build-share-card-data.ts");
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
});

test("buildShareCardData with full data", () => {
  const data = mod.buildShareCardData({
    handle: "rynn",
    startDate: "2026-01-15",
    activeDays: 42,
    summary: { billable_total_tokens: 1234567, total_cost_usd: 12.34 },
    topModels: [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", tokens: 800000, percent: "64.8" },
      { id: "gpt-5.1", name: "GPT-5.1", tokens: 300000, percent: "24.3" },
      { id: "gemini-2.5", name: "Gemini 2.5", tokens: 134567, percent: "10.9" },
    ],
    rank: 42,
    period: "month",
    periodFrom: "2026-04-01",
    periodTo: "2026-04-30",
  });
  assert.equal(data.handle, "rynn");
  assert.equal(data.totalTokens, 1234567);
  assert.equal(data.totalCost, 12.34);
  assert.equal(data.rank, 42);
  assert.equal(data.activeDays, 42);
  assert.equal(data.topModels.length, 3);
  assert.equal(data.topModels[0].name, "Claude Opus 4.6");
});

test("buildShareCardData handles missing summary and rank", () => {
  const data = mod.buildShareCardData({
    handle: "",
    startDate: null,
    activeDays: 0,
    summary: null,
    topModels: null,
    rank: null,
    period: "total",
    periodFrom: null,
    periodTo: null,
  });
  assert.equal(data.handle, "—");
  assert.equal(data.totalTokens, 0);
  assert.equal(data.totalCost, 0);
  assert.equal(data.rank, null);
  assert.deepEqual(data.topModels, []);
});

test("buildShareCardData caps topModels at 3", () => {
  const data = mod.buildShareCardData({
    handle: "a",
    startDate: null,
    activeDays: 1,
    summary: { total_tokens: 10 },
    topModels: [
      { id: "1", name: "m1", tokens: 5, percent: "50" },
      { id: "2", name: "m2", tokens: 3, percent: "30" },
      { id: "3", name: "m3", tokens: 1, percent: "10" },
      { id: "4", name: "m4", tokens: 1, percent: "10" },
    ],
    rank: 1,
    period: "week",
    periodFrom: null,
    periodTo: null,
  });
  assert.equal(data.topModels.length, 3);
});

test("buildShareCardData rejects negative/non-finite rank", () => {
  const data = mod.buildShareCardData({
    handle: "a",
    startDate: null,
    activeDays: 0,
    summary: null,
    topModels: [],
    rank: -5,
    period: "week",
    periodFrom: null,
    periodTo: null,
  });
  assert.equal(data.rank, null);
});

test("formatTokens formats large numbers", () => {
  assert.equal(mod.formatTokens(0), "0");
  assert.equal(mod.formatTokens(1234567), "1,234,567");
});

test("formatCost formats usd correctly", () => {
  assert.equal(mod.formatCost(0), "$0.00");
  assert.equal(mod.formatCost(0.5), "$0.50");
  assert.equal(mod.formatCost(12.34), "$12.34");
  assert.equal(mod.formatCost(1234.5), "$1,235");
});

test("formatShortDate returns month + year", () => {
  assert.equal(mod.formatShortDate("2026-04-11"), "APR 2026");
  assert.equal(mod.formatShortDate(null), "—");
});

test("formatIssueLabel responds to period", () => {
  const base = {
    handle: "a",
    startDate: null,
    activeDays: 0,
    totalTokens: 0,
    totalCost: 0,
    topModels: [],
    rank: null,
    capturedAt: new Date().toISOString(),
  };
  assert.equal(
    mod.formatIssueLabel({ ...base, period: "total", periodFrom: null, periodTo: null }),
    "ALL TIME",
  );
  assert.match(
    mod.formatIssueLabel({ ...base, period: "month", periodFrom: "2026-04-01", periodTo: "2026-04-30" }),
    /APR 2026/,
  );
});
