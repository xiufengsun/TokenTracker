"use strict";

// drainQueueToCloud records when the cloud holds exactly the queue rows before
// the upload cursor (`cloudBaselineOffset === offset`) and when a request is in
// flight (`uploadingSince`). The account view only adds the rows past the
// cursor to the cloud aggregate under that baseline (account-pending-overlay).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { drainQueueToCloud } = require("../src/commands/sync");

function setup(t, rowCount, initialState) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-baseline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, "queue.jsonl");
  const queueStatePath = path.join(dir, "queue.state.json");
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    source: "claude", model: "m", hour_start: new Date(Date.UTC(2026, 10, 18, 0, 30 * i)).toISOString(),
    input_tokens: 10, output_tokens: 0, total_tokens: 10,
  }));
  fs.writeFileSync(queuePath, rows.map((r) => JSON.stringify(r) + "\n").join(""));
  if (initialState) fs.writeFileSync(queueStatePath, JSON.stringify(initialState));
  const readState = () => JSON.parse(fs.readFileSync(queueStatePath, "utf8"));
  const size = fs.statSync(queuePath).size;
  const drain = (opts = {}) => drainQueueToCloud({
    baseUrl: "https://t.example", deviceToken: "tok", queuePath, queueStatePath, maxBatches: 5, batchSize: 2, ...opts,
  });
  return { queuePath, queueStatePath, readState, size, drain };
}

function mockIngest(t, respond = () => ({ ok: true, status: 200 })) {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const response = respond(seen.length, body);
    seen.push(body);
    return {
      ok: response.ok, status: response.status, headers: { get: () => null },
      text: async () => JSON.stringify(response.ok ? { inserted: body.hourly.length, skipped: 0 } : { error: "x" }),
    };
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return seen;
}

test("a drain that reaches the end of the queue records the cloud baseline", async (t) => {
  const { readState, size, drain } = setup(t, 3);
  const during = [];
  mockIngest(t, () => { during.push(readState()); return { ok: true, status: 200 }; });
  await drain();
  assert.ok(during.every((state) => typeof state.uploadingSince === "string"), "every request is marked in flight");
  const state = readState();
  assert.equal(state.offset, size);
  assert.equal(state.cloudBaselineOffset, size);
  assert.equal("uploadingSince" in state, false);
});

test("a partial drain from an unknown baseline records none; the next full drain does", async (t) => {
  const { readState, size, drain } = setup(t, 5, { offset: 0 });
  mockIngest(t);
  await drain({ maxBatches: 1 });
  assert.equal("cloudBaselineOffset" in readState(), false);
  await drain();
  assert.equal(readState().cloudBaselineOffset, size);
});

test("with a known baseline every committed batch moves it with the cursor", async (t) => {
  const { readState, drain } = setup(t, 5, { offset: 0, cloudBaselineOffset: 0 });
  mockIngest(t);
  await drain({ maxBatches: 1 });
  const state = readState();
  assert.ok(state.offset > 0);
  assert.equal(state.cloudBaselineOffset, state.offset);
});

test("an ambiguous failure forgets the baseline; a rejection keeps it", async (t) => {
  const { readState, queueStatePath, drain } = setup(t, 3, { offset: 0, cloudBaselineOffset: 0 });
  let status = 503;
  mockIngest(t, () => ({ ok: false, status }));
  await assert.rejects(drain(), (err) => err.status === 503);
  assert.deepEqual([readState().offset, "cloudBaselineOffset" in readState(), "uploadingSince" in readState()], [0, false, false]);

  fs.writeFileSync(queueStatePath, JSON.stringify({ offset: 0, cloudBaselineOffset: 0 }));
  status = 429;
  await assert.rejects(drain(), (err) => err.status === 429);
  assert.equal(readState().cloudBaselineOffset, 0);
  assert.equal("uploadingSince" in readState(), false);
});

test("an in-flight marker left by a sync that died mid-request voids the baseline", async (t) => {
  const { readState, size, drain } = setup(t, 5, {
    offset: 0, cloudBaselineOffset: 0, uploadingSince: "2026-11-18T08:00:00.000Z",
  });
  mockIngest(t);
  await drain({ maxBatches: 1 });
  assert.equal("cloudBaselineOffset" in readState(), false);
  await drain();
  assert.equal(readState().cloudBaselineOffset, size);
});

test("a queue that is already fully uploaded establishes the baseline without a request", async (t) => {
  const { readState, queueStatePath, size, drain } = setup(t, 2);
  fs.writeFileSync(queueStatePath, JSON.stringify({ offset: size }));
  const seen = mockIngest(t);
  await drain();
  assert.equal(seen.length, 0);
  assert.equal(readState().cloudBaselineOffset, size);
});
