"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, beforeEach, afterEach } = require("node:test");

const { createPendingUploadReader, mergeAccountPayload } = require("../src/lib/account-pending-overlay");

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pending-overlay-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function row(model, hourStart, totalTokens, extra = {}) {
  return {
    source: "claude", model, hour_start: hourStart,
    input_tokens: totalTokens, output_tokens: 0, cached_input_tokens: 0,
    cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
    total_tokens: totalTokens, conversation_count: 1, ...extra,
  };
}

// Writes `uploaded` rows, records the upload cursor after them, then appends `pending`.
function writeQueue(uploaded, pending, { tail = "" } = {}) {
  const queuePath = path.join(dir, "queue.jsonl");
  const prefix = uploaded.map((r) => JSON.stringify(r) + "\n").join("");
  fs.writeFileSync(queuePath, prefix + pending.map((r) => JSON.stringify(r) + "\n").join("") + tail);
  writeState({ offset: Buffer.byteLength(prefix) });
  return queuePath;
}

// A drain that reached the end of the queue records its cursor as the cloud baseline.
function writeState({ offset, baseline = offset, ...extra }) {
  const state = { offset, ...extra };
  if (baseline !== null) state.cloudBaselineOffset = baseline;
  fs.writeFileSync(path.join(dir, "queue.state.json"), JSON.stringify(state));
}

async function readDelta(reader, queuePath) {
  return (await reader.read(queuePath)).delta;
}

test("reader returns only rows changed since the upload, paired with their uploaded version", async () => {
  const queuePath = writeQueue(
    [row("a", "2026-11-17T10:00:00.000Z", 10), row("b", "2026-11-18T07:30:00.000Z", 5)],
    [
      row("b", "2026-11-18T07:30:00.000Z", 40),
      row("c", "2026-11-18T08:00:00.000Z", 7),
      row("a", "2026-11-17T10:00:00.000Z", 10), // rewritten unchanged: cancels out
    ],
    { tail: JSON.stringify(row("d", "2026-11-18T08:30:00.000Z", 99)).slice(0, 20) },
  );
  const delta = await readDelta(createPendingUploadReader(), queuePath);
  assert.deepEqual(delta.after.map((r) => [r.model, r.total_tokens]), [["b", 40], ["c", 7]]);
  assert.deepEqual(delta.before.map((r) => [r.model, r.total_tokens]), [["b", 5]]);
});

test("reader mirrors the upload row shape: normalized identity, no backend provenance", async () => {
  const queuePath = writeQueue([], [
    { ...row(" m ", "2026-11-18T08:00:00.000Z", 3), source: " Claude ", backend_usage: [{ backend: "custom", total_tokens: 3 }] },
  ]);
  const delta = await readDelta(createPendingUploadReader(), queuePath);
  assert.equal(delta.after[0].source, "claude");
  assert.equal(delta.after[0].model, "m");
  assert.equal("backend_usage" in delta.after[0], false);
});

test("reader picks up appended rows and resets after the next upload", async () => {
  const queuePath = writeQueue([row("a", "2026-11-18T07:00:00.000Z", 1)], [row("a", "2026-11-18T07:00:00.000Z", 2)]);
  const reader = createPendingUploadReader();
  assert.deepEqual((await readDelta(reader, queuePath)).after.map((r) => r.total_tokens), [2]);

  fs.appendFileSync(queuePath, JSON.stringify(row("a", "2026-11-18T07:00:00.000Z", 6)) + "\n");
  assert.deepEqual((await readDelta(reader, queuePath)).after.map((r) => r.total_tokens), [6]);

  writeState({ offset: fs.statSync(queuePath).size });
  assert.equal(await readDelta(reader, queuePath), null);
});

test("reader adds nothing without an upload cursor", async () => {
  const queuePath = writeQueue([], [row("a", "2026-11-18T07:00:00.000Z", 1)]);
  fs.rmSync(path.join(dir, "queue.state.json"));
  assert.deepEqual(await createPendingUploadReader().read(queuePath), { key: "", baselineKnown: false, uploading: false, delta: null });
});

test("reader adds nothing until a full drain has established the cloud baseline", async () => {
  const queuePath = writeQueue([row("a", "2026-11-18T07:00:00.000Z", 1)], [row("a", "2026-11-18T07:00:00.000Z", 2)]);
  const offset = fs.statSync(queuePath).size - Buffer.byteLength(JSON.stringify(row("a", "2026-11-18T07:00:00.000Z", 2)) + "\n");
  const reader = createPendingUploadReader();

  // Cursor written by a pre-baseline release or reset by a repair: the cloud
  // may hold more (or less) than the prefix, so nothing is added.
  writeState({ offset, baseline: null });
  assert.equal(await readDelta(reader, queuePath), null);
  writeState({ offset, baseline: offset - 1 });
  assert.equal(await readDelta(reader, queuePath), null);

  writeState({ offset });
  assert.deepEqual((await readDelta(reader, queuePath)).after.map((r) => r.total_tokens), [2]);
});

test("reader adds nothing while an upload is in flight or after one died mid-request", async () => {
  const queuePath = writeQueue([], [row("a", "2026-11-18T07:00:00.000Z", 1)]);
  const reader = createPendingUploadReader();
  writeState({ offset: 0, uploadingSince: new Date().toISOString() });
  const inFlight = await reader.read(queuePath);
  assert.equal(inFlight.delta, null);
  assert.equal(inFlight.uploading, true);

  writeState({ offset: 0, uploadingSince: new Date(Date.now() - 60 * 60_000).toISOString() });
  const stale = await reader.read(queuePath);
  assert.deepEqual([stale.uploading, stale.baselineKnown, stale.delta], [false, false, null]);
  assert.notEqual(stale.key, inFlight.key, "every marker transition changes the state key");
});

test("reader skips account-level sources and drops provider-reported cost", async () => {
  const queuePath = writeQueue([], [
    { ...row("auto", "2026-11-18T07:00:00.000Z", 5), source: "cursor" },
    { ...row("grok-4", "2026-11-18T07:00:00.000Z", 9), source: "grok", total_cost_usd: 4.2 },
  ]);
  const delta = await readDelta(createPendingUploadReader(), queuePath);
  assert.deepEqual(delta.after.map((r) => r.source), ["grok"]);
  assert.equal("total_cost_usd" in delta.after[0], false);
});

test("daily merge adds the delta to existing days and inserts days the cloud lacks", () => {
  const cloud = { from: "2026-11-17", to: "2026-11-18", data: [
    { day: "2026-11-17", total_tokens: 100, billable_total_tokens: 100, total_cost_usd: 1, conversation_count: 2, models: { a: 100 } },
  ] };
  const plus = { data: [
    { day: "2026-11-17", total_tokens: 30, billable_total_tokens: 30, total_cost_usd: 0.3, conversation_count: 1, models: { a: 30 } },
    { day: "2026-11-18", total_tokens: 50, billable_total_tokens: 50, total_cost_usd: 0.5, conversation_count: 1, models: { b: 50 } },
  ] };
  const minus = { data: [
    { day: "2026-11-17", total_tokens: 10, billable_total_tokens: 10, total_cost_usd: 0.1, conversation_count: 1, models: { a: 10 } },
  ] };
  const merged = mergeAccountPayload("tokentracker-usage-daily", cloud, plus, minus);
  assert.deepEqual(merged.data.map((d) => [d.day, d.total_tokens, d.models]), [
    ["2026-11-17", 120, { a: 120 }],
    ["2026-11-18", 50, { b: 50 }],
  ]);
  assert.ok(Math.abs(merged.data[0].total_cost_usd - 1.2) < 1e-9);
  assert.equal(cloud.data.length, 1, "the cloud payload (a shared cache entry) is not mutated");
  assert.equal(cloud.data[0].total_tokens, 100);
});

test("summary merge sums the daily delta over each of the cloud's own windows", () => {
  const cloud = {
    from: "2026-11-01", to: "2026-11-18", days: 17,
    totals: { total_tokens: 0, billable_total_tokens: 0, total_cost_usd: "0.000000", conversation_count: 1 },
    rolling: {
      last_7d: { from: "2026-11-12", to: "2026-11-18", active_days: 6, totals: { billable_total_tokens: 600, conversation_count: 6 } },
      last_30d: { from: "2026-10-20", to: "2026-11-18", active_days: 30, totals: { billable_total_tokens: 3000, conversation_count: 30 }, avg_per_active_day: 100 },
    },
  };
  const plus = { data: [
    { day: "2026-10-25", total_tokens: 5, billable_total_tokens: 5, total_cost_usd: "1.000000", conversation_count: 1 },
    { day: "2026-11-18", total_tokens: 70, billable_total_tokens: 70, total_cost_usd: "2.500000", conversation_count: 3 },
  ] };
  const merged = mergeAccountPayload("tokentracker-usage-summary", cloud, plus, null, {
    newlyActiveDays: (from, to) => ("2026-11-18" >= from && "2026-11-18" <= to ? 1 : 0),
  });
  assert.equal(merged.totals.total_tokens, 70, "the 10-25 day lies outside the summary range");
  assert.equal(merged.totals.total_cost_usd, "2.500000");
  assert.equal(merged.days, 18);
  assert.equal(merged.rolling.last_7d.totals.billable_total_tokens, 670);
  assert.equal(merged.rolling.last_7d.active_days, 7);
  assert.equal(merged.rolling.last_30d.totals.billable_total_tokens, 3075);
  assert.equal(merged.rolling.last_30d.active_days, 30, "clamped to the window");
  assert.equal(merged.rolling.last_30d.avg_per_active_day, Math.round(3075 / 30));
});

test("heatmap merge relevels cells and recounts active days", () => {
  const cloud = { active_days: 1, weeks: [[
    { day: "2026-11-17", total_tokens: 400, billable_total_tokens: 400, level: 4, models: { a: 400 } },
    { day: "2026-11-18", total_tokens: 0, billable_total_tokens: 0, level: 0, models: { unknown: 0 } },
  ]] };
  const plus = { data: [
    { day: "2026-11-18", total_tokens: 800, billable_total_tokens: 800, models: { b: 800 } },
    { day: "2026-11-19", total_tokens: 9, billable_total_tokens: 9, models: { b: 9 } }, // outside the grid
  ] };
  const merged = mergeAccountPayload("tokentracker-usage-heatmap", cloud, plus, { data: [] });
  const [yesterday, today] = merged.weeks[0];
  assert.deepEqual([today.total_tokens, today.level, today.models], [800, 4, { unknown: 0, b: 800 }]);
  assert.equal(yesterday.level, 2);
  assert.equal(merged.active_days, 2);
});

test("model breakdown merge inserts unseen models and keeps them sorted by tokens", () => {
  const cloud = { sources: [{ source: "claude", totals: { total_tokens: 10, total_cost_usd: "1.000000" }, models: [
    { model: "a", totals: { total_tokens: 10, total_cost_usd: "1.000000" } },
  ] }] };
  const plus = { sources: [{ source: "claude", totals: { total_tokens: 25, total_cost_usd: "3.000000" }, models: [
    { model: "b", pricing: { status: "priced" }, totals: { total_tokens: 25, total_cost_usd: "3.000000" } },
  ] }] };
  const merged = mergeAccountPayload("tokentracker-usage-model-breakdown", cloud, plus, { sources: [] });
  const claude = merged.sources[0];
  assert.equal(claude.totals.total_tokens, 35);
  assert.equal(claude.totals.total_cost_usd, "4.000000");
  assert.deepEqual(claude.models.map((m) => [m.model, m.totals.total_tokens]), [["b", 25], ["a", 10]]);
  assert.deepEqual(claude.models[0].pricing, { status: "priced" });
});
