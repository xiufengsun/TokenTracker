"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseRolloutIncremental } = require("../src/lib/rollout");
const { parseCodexRolloutFile } = require("../src/lib/codex-rollout-parser");
const { createLocalApiHandler } = require("../src/lib/local-api");
const { repairCodexRescanInflation } = require("../src/commands/sync");
const { loadDashboardModule } = require("./helpers/load-dashboard-module");

const DAY = "2026-10-05";
const HOUR = `${DAY}T10:00:00.000Z`;
const usage = n => ({ input_tokens: n, cached_input_tokens: n / 2, output_tokens: n / 10,
  reasoning_output_tokens: n / 20, total_tokens: n + n / 10 });
const context = model => ({ timestamp: HOUR, type: "turn_context", payload: { model, current_date: DAY } });
const event = (n, total = n, second = 1) => ({ timestamp: `${DAY}T10:00:${String(second).padStart(2, "0")}.000Z`,
  type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(n), total_token_usage: usage(total) } } });
const lines = records => records.map(record => JSON.stringify(record) + "\n").join("");
async function latest(queuePath) {
  const rows = new Map();
  for (const row of (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse)) {
    rows.set(row.model, row);
  }
  return rows;
}
async function dailyModels(queuePath) {
  const url = new URL(`http://localhost/functions/tokentracker-usage-model-breakdown?from=${DAY}&to=${DAY}&tz=UTC&source=codex`);
  let body;
  const res = { statusCode: 200, setHeader() {}, writeHead(code) { this.statusCode = code; }, end(value) { body = JSON.parse(value); } };
  await createLocalApiHandler({ queuePath })({ method: "GET", headers: {}, url: url.pathname + url.search }, res, url);
  assert.equal(res.statusCode, 200);
  const { buildFleetData, buildAllModels } = await loadDashboardModule("dashboard/src/lib/model-breakdown.ts");
  const fleet = buildFleetData(body).filter(row => row.source === "codex");
  assert.equal(fleet.length, 1);
  return { fleet: fleet[0], models: buildAllModels(fleet) };
}

for (const reverse of [false, true]) test(`#927 daily models retain orchestrator, child, snapshot, review and unknown (reverse=${reverse})`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-daily-"));
  try {
    const models = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-astra-2026-10-01", "codex-auto-review", null];
    const files = [];
    for (const [index, model] of models.entries()) {
      const file = path.join(dir, `rollout-${index}.jsonl`);
      const meta = { timestamp: HOUR, type: "session_meta", payload: { id: `session-${index}`,
        ...(index === 1 ? { source: { subagent: { thread_spawn: { parent_thread_id: "session-0", depth: 1 } } } } : {}) } };
      await fs.writeFile(file, lines([meta, ...(model ? [context(model)] : []), event((index + 1) * 100)]));
      files.push(file);
    }
    const queuePath = path.join(dir, "queue.jsonl");
    let cursors = {};
    const run = () => parseRolloutIncremental({ rolloutFiles: reverse ? [...files].reverse() : files, cursors, queuePath });
    await run();
    let queued = await latest(queuePath);
    assert.equal(queued.size, 5);
    for (const [index, model] of models.entries()) {
      const n = (index + 1) * 100;
      const row = queued.get(model || "unknown");
      assert.ok(row, model || "unknown");
      assert.equal(row.input_tokens, n / 2);
      assert.equal(row.cached_input_tokens, n / 2);
      assert.equal(row.output_tokens, n / 10);
      assert.equal(row.reasoning_output_tokens, n / 20);
      assert.equal(row.total_tokens, n + n / 10);
      const parsed = await parseCodexRolloutFile(files[index], { collectModelUsage: true });
      assert.equal(parsed.modelUsage[0].model, model || "unknown");
      assert.equal(parsed.modelUsage[0].total_tokens, row.total_tokens);
    }
    // Persisted cursors and a later parent turn must not inherit a child's model.
    cursors = JSON.parse(JSON.stringify(cursors));
    await fs.appendFile(files[0], lines([event(100, 200, 10)]));
    await run();
    queued = await latest(queuePath);
    assert.equal(queued.get("gpt-6-astra").total_tokens, 220);
    assert.equal(queued.get("gpt-6.1-sol").total_tokens, 220);
    const { fleet, models: displayed } = await dailyModels(queuePath);
    assert.equal(fleet.models.length, 5);
    assert.equal(displayed.length, 5);
    assert.deepEqual(new Set(displayed.map(row => row.name)), new Set(models.map(model => model || "unknown")));
    for (const model of fleet.models) {
      const row = queued.get(model.name);
      assert.equal(model.usage, row.total_tokens);
      assert.equal(model.tokens.input, row.input_tokens);
      assert.equal(model.tokens.cached, row.cached_input_tokens);
      assert.equal(model.tokens.output, row.output_tokens);
    }
    assert.equal(fleet.usage, 1760);
    const stable = await fs.readFile(queuePath, "utf8");
    assert.equal((await run()).eventsAggregated, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), stable);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

for (const version of [undefined, 3]) for (const legacy of [false, true]) test(`#927 repairs persisted ${legacy ? "collapsed legacy" : "dominant-model"} rows without replaying logs (version=${version})`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-model-repair-"));
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const totals = n => ({ input_tokens: n, output_tokens: 0, cached_input_tokens: 0,
      cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: n, billable_total_tokens: n, conversation_count: 1 });
    const stored = { "gpt-6-astra": 100, "gpt-6.1-sol": 200, ...(legacy ? {} : { unknown: 50 }) };
    const stale = legacy ? { unknown: 300 } : { "gpt-6-astra": 100, "gpt-6.1-sol": 250, unknown: 0 };
    await fs.writeFile(queuePath, lines(Object.entries(stale).map(([model, n]) => ({ source: "codex", model, hour_start: HOUR, ...totals(n) }))));
    let cursors = { hourly: { ...(version ? { version } : {}), buckets: Object.fromEntries(Object.entries(stored).map(([model, n]) =>
      [`codex|${model}|${HOUR}`, { totals: totals(n), queuedKey: "old-key" }])),
      groupQueued: legacy ? { [`codex|${HOUR}`]: "old-group-key" } : {} } };
    const run = () => parseRolloutIncremental({ rolloutFiles: [], cursors, queuePath });
    assert.equal((await run()).eventsAggregated, 0);
    const rows = await latest(queuePath);
    assert.equal(rows.get("gpt-6-astra").total_tokens, 100);
    assert.equal(rows.get("gpt-6.1-sol").total_tokens, 200);
    assert.equal(rows.get("unknown").total_tokens, legacy ? 0 : 50);
    assert.deepEqual(cursors.hourly.groupQueued, {});
    const { fleet } = await dailyModels(queuePath);
    assert.equal(fleet.usage, legacy ? 300 : 350);
    const stable = await fs.readFile(queuePath, "utf8");
    cursors = JSON.parse(JSON.stringify(cursors));
    assert.equal((await run()).bucketsQueued, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), stable);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("#927 upgrades already-produced unversioned model buckets without inflating the second sync", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-unversioned-models-"));
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursorPath = path.join(dir, "cursors.json");
    const totals = n => ({ input_tokens: n, output_tokens: 0, cached_input_tokens: 0,
      cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: n,
      billable_total_tokens: n, conversation_count: 1 });
    const stored = { "gpt-6-astra": 100, "gpt-6.1-sol": 200 };
    // Older repairs already wrote these model-aware buckets and queue rows,
    // but omitted hourly.version. Upgrade this saved state without rebuilding it.
    await fs.writeFile(cursorPath, JSON.stringify({ hourly: {
      buckets: Object.fromEntries(Object.entries(stored).map(([model, n]) =>
        [`codex|${model}|${HOUR}`, { totals: totals(n), queuedKey: "old-key" }])),
      groupQueued: {},
    } }));
    await fs.writeFile(queuePath, lines(Object.entries(stored).map(([model, n]) =>
      ({ source: "codex", model, hour_start: HOUR, ...totals(n) }))));
    let upgradedQueue;
    for (let sync = 0; sync < 2; sync++) {
      const cursors = JSON.parse(await fs.readFile(cursorPath, "utf8"));
      const result = await parseRolloutIncremental({ rolloutFiles: [], cursors, queuePath });
      assert.equal(result.eventsAggregated, 0);
      await fs.writeFile(cursorPath, JSON.stringify(cursors));
      assert.equal(cursors.hourly.version, 3);
      assert.deepEqual(Object.keys(cursors.hourly.buckets).sort(),
        Object.keys(stored).map(model => `codex|${model}|${HOUR}`).sort());
      const rows = await latest(queuePath);
      assert.equal(rows.size, 2);
      for (const [model, n] of Object.entries(stored)) {
        assert.equal(rows.get(model).total_tokens, n);
        assert.deepEqual(cursors.hourly.buckets[`codex|${model}|${HOUR}`].totals, totals(n));
      }
      const { fleet, models } = await dailyModels(queuePath);
      assert.equal(fleet.usage, 300);
      assert.deepEqual(models.map(row => row.name).sort(), Object.keys(stored).sort());
      const queue = await fs.readFile(queuePath, "utf8");
      if (sync === 0) upgradedQueue = queue;
      else {
        assert.equal(result.bucketsQueued, 0);
        assert.equal(queue, upgradedQueue);
      }
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("#927 Codex rebuild preserves the model bucket schema through the following sync", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-rebuild-models-"));
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const parent = path.join(dir, "rollout-parent.jsonl");
    const child = path.join(dir, "rollout-child.jsonl");
    await fs.writeFile(parent, lines([context("gpt-6-astra"), event(100)]));
    await fs.writeFile(child, lines([context("gpt-6.1-sol"), event(200)]));
    // Repair can run before the first parser normalization, leaving the live
    // hourly state unversioned even though the rebuilt buckets use v3 keys.
    let cursors = { hourly: { buckets: {}, groupQueued: {} } };
    const rolloutFiles = [parent, child];
    assert.equal(await repairCodexRescanInflation({ cursors, rolloutFiles, queuePath,
      queueStatePath: path.join(dir, "queue.state.json") }), true);
    assert.equal(cursors.hourly.version, 3);
    assert.deepEqual(cursors.hourly.modelAttributionPolicy, { codex: "observed" });
    const repaired = await fs.readFile(queuePath, "utf8");
    const run = () => parseRolloutIncremental({ rolloutFiles, cursors, queuePath });
    assert.equal((await run()).bucketsQueued, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), repaired);
    cursors = JSON.parse(JSON.stringify(cursors));
    await fs.appendFile(child, lines([event(100, 300, 10)]));
    await run();
    const rows = await latest(queuePath);
    assert.equal(rows.size, 2);
    assert.equal(rows.get("gpt-6-astra").total_tokens, 110);
    assert.equal(rows.get("gpt-6.1-sol").total_tokens, 330);
    assert.equal(Object.keys(cursors.hourly.buckets).some(key => key.includes("|unknown|")), false);
    assert.equal((await dailyModels(queuePath)).fleet.models.length, 2);
    const stable = await fs.readFile(queuePath, "utf8");
    assert.equal((await run()).bucketsQueued, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), stable);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
