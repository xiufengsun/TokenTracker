"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { summarize } = require("../scripts/check-insforge-usage.cjs");
const GIB = 1024 ** 3;
const cycles = { current: { start_date: "2026-09-18", end_date: "2026-10-17" } };
const usage = (bytes, date = "2026-10-04T02:00:00Z") => ({
  organization: { price_plan: "pro" },
  usage_summary: { egress_bytes: bytes, function_calls: 100001 },
  _meta: { requested_at: date },
});

test("official two-day counter delta drives the forecast, without short-window extrapolation", () => {
  const prior = summarize(usage(253.39 * GIB, "2026-10-02T02:00:00Z"), cycles);
  const report = summarize(usage(265.39 * GIB), cycles, [prior]);
  assert.equal(report.measuredGiBPerDay, 6);
  assert.equal(report.hasTwoDayWindow, true);
  assert.ok(report.alerts.includes("egress_over_quota"));
  assert.ok(report.projectedCycleEndGiB > 265.39);
  assert.ok(!report.alerts.includes("egress_above_optimization_target"));
  assert.equal(report.estimatedFunctionOverageUSD, 0.00001);
});

test("a cycle reset and same-day samples cannot produce a misleading daily rate", () => {
  const old = summarize(usage(240 * GIB, "2026-10-03T02:00:00Z"), cycles);
  assert.equal(summarize(usage(245 * GIB, "2026-10-03T03:00:00Z"), cycles, [old]).measuredGiBPerDay, null);
  assert.equal(summarize(usage(245 * GIB), cycles, [{ ...old, cycle: "old" }]).measuredGiBPerDay, null);
  const reset = summarize(usage(2 * GIB), cycles, [old]);
  assert.equal(reset.measuredGiBPerDay, null);
  assert.ok(reset.alerts.includes("usage_counter_rebased"));
});

test("missing billing data never becomes zero usage or a verified result", () => {
  assert.throws(() => summarize({ error: "expired" }, cycles));
  assert.throws(() => summarize(usage(0), {}));
  assert.throws(() => summarize(usage(0, "2026-10-18T02:00:00Z"), cycles));
});
