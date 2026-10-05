#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const GIB = 1024 ** 3;
const DAY_MS = 86400_000;

function summarize(usage, cycles, history = []) {
  const totals = usage.usage_summary;
  const current = cycles.current;
  const checkedAt = usage._meta?.requested_at;
  if (usage.organization?.price_plan !== "pro" || !current?.start_date ||
      !current?.end_date || !Number.isFinite(Date.parse(checkedAt)) ||
      !Number.isFinite(totals?.egress_bytes) || totals.egress_bytes < 0) {
    throw new Error("Official Pro usage or billing cycle is unavailable");
  }
  const cycle = `${current.start_date}/${current.end_date}`;
  const now = Date.parse(checkedAt);
  const cycleStart = Date.parse(`${current.start_date}T00:00:00Z`);
  const cycleEnd = Date.parse(`${current.end_date}T00:00:00Z`) + DAY_MS;
  if (!Number.isFinite(cycleStart) || !Number.isFinite(cycleEnd) || now < cycleStart || now >= cycleEnd) {
    throw new Error("Usage timestamp is outside the reported billing cycle");
  }
  const prior = history.filter((sample) => sample.cycle === cycle &&
    Number.isFinite(sample.egressBytes) && now - Date.parse(sample.checkedAt) >= DAY_MS)
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
  const elapsedDays = prior ? (now - Date.parse(prior.checkedAt)) / DAY_MS : null;
  const delta = prior ? totals.egress_bytes - prior.egressBytes : null;
  const rateGiB = delta !== null && delta >= 0 ? delta / GIB / elapsedDays : null;
  const projectedGiB = rateGiB === null ? null : totals.egress_bytes / GIB +
    rateGiB * Math.max(0, cycleEnd - now) / DAY_MS;
  const alerts = [];
  if (totals.egress_bytes > 250 * GIB) alerts.push("egress_over_quota");
  if (projectedGiB !== null && projectedGiB > 250) alerts.push("projected_egress_over_quota");
  if (rateGiB !== null && rateGiB > 7) alerts.push("egress_above_optimization_target");
  if (delta !== null && delta < 0) alerts.push("usage_counter_rebased");
  if (Number.isFinite(totals.database_bytes) && totals.database_bytes > 8 * GIB)
    alerts.push("database_over_quota");
  if (Number.isFinite(totals.storage_bytes) && totals.storage_bytes > 100 * GIB)
    alerts.push("storage_over_quota");
  if (Number.isFinite(totals.function_calls) && totals.function_calls > 100000)
    alerts.push("function_calls_over_quota");
  return {
    checkedAt, cycle, cycleStart: current.start_date, cycleEnd: current.end_date,
    source: "InsForge CLI official organization usage", unit: "GiB (UI labels GB)",
    egressBytes: totals.egress_bytes, egressGiB: totals.egress_bytes / GIB,
    egressQuotaGiB: 250, overageGiB: Math.max(0, totals.egress_bytes / GIB - 250),
    databaseGiB: Number.isFinite(totals.database_bytes) ? totals.database_bytes / GIB : null,
    storageGiB: Number.isFinite(totals.storage_bytes) ? totals.storage_bytes / GIB : null,
    functionCalls: Number.isFinite(totals.function_calls) ? totals.function_calls : null,
    estimatedFunctionOverageUSD: Number.isFinite(totals.function_calls)
      ? Math.max(0, totals.function_calls - 100000) * 0.01 / 1000 : null,
    rateWindowStart: prior?.checkedAt ?? null, rateWindowDays: elapsedDays,
    measuredGiBPerDay: rateGiB, projectedCycleEndGiB: projectedGiB,
    optimizationTargetGiBPerDay: 7,
    hasTwoDayWindow: elapsedDays !== null && elapsedDays >= 2,
    alerts,
  };
}

async function cli(args) {
  const { stdout } = await run("npx", ["@insforge/cli", ...args, "--json"], {
    cwd: path.resolve(__dirname, ".."), timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  if (result.error) throw new Error(result.code || "InsForge CLI returned an error");
  return result;
}

async function main() {
  const statePath = path.join(os.homedir(), ".tokentracker", "ops", "insforge-usage.jsonl");
  const history = fs.existsSync(statePath)
    ? fs.readFileSync(statePath, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
  // Both commands can renew the same persisted OAuth session.
  const usage = await cli(["usage"]);
  const cycles = await cli(["billing", "cycles"]);
  const report = summarize(usage, cycles, history);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.appendFileSync(statePath, JSON.stringify(report) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

module.exports = { summarize };
if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ status: "unverified", error: error.message }));
  process.exitCode = 1;
});
