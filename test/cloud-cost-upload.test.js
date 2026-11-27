"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { drainQueueToCloud } = require("../src/commands/sync");
const { eventCostCoverage } = require("../src/lib/cost-provenance");
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-cost-upload-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const r = { source: "cursor", model: "grok-bot-default", hour_start: "2026-11-23T00:00:00Z", input_tokens: 0,
    cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0,
    total_tokens: 0, conversation_count: 1, total_cost_usd: 0 };
  r.cost_coverage = eventCostCoverage(r, 0, "cursor_csv_cost");
  const queuePath = path.join(dir, "queue.jsonl"), queueStatePath = path.join(dir, "queue.state.json");
  await fs.writeFile(queuePath, JSON.stringify(r) + "\n");
  const original = global.fetch; t.after(() => { global.fetch = original; });
  const args = { queuePath, queueStatePath, baseUrl: "https://fixture.test", deviceToken: "fixture-only-device-token" };
  return { args, r, size: (await fs.stat(queuePath)).size, offset: async () => JSON.parse(await fs.readFile(queueStatePath, "utf8").catch(() => "{}" )).offset || 0 };
}
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) });

test("unsupported legacy ingest is probed without sending evidence or advancing the queue", async t => {
  const f = await fixture(t), calls = [];
  global.fetch = async (_url, opts) => { calls.push(JSON.parse(opts.body)); return response({ error: "No usage buckets provided" }, 400); };
  await assert.rejects(drainQueueToCloud(f.args), e => e.code === "CLOUD_COST_COVERAGE_UNSUPPORTED");
  assert.deepEqual(calls, [{ kind: "cost_capabilities" }]);
  assert.equal(await f.offset(), 0);
});
test("a claimed capability without write acknowledgement retains zero evidence for retry", async t => {
  const f = await fixture(t), calls = [];
  await fs.writeFile(f.args.queueStatePath, JSON.stringify({ offset: 0, cloudBaselineOffset: 0 }));
  global.fetch = async (_url, opts) => { const body = JSON.parse(opts.body); calls.push(body); return response(body.kind ? { cost_coverage_versions: [1] } : { inserted: 1 }); };
  await assert.rejects(drainQueueToCloud(f.args), e => e.code === "CLOUD_COST_COVERAGE_UNSUPPORTED");
  assert.equal(JSON.parse(await fs.readFile(f.args.queueStatePath, "utf8")).cloudBaselineOffset, undefined);
  assert.equal(calls[1].cost_coverage_version, 1);
  assert.equal(calls[1].hourly[0].cost_coverage.reported_events, 1);
  assert.equal(calls[1].hourly[0].cost_coverage.reported_usd, 0);
  assert.equal(await f.offset(), 0);
});
test("acknowledged v1 uploads retain explicit zero and advance only the successful batch", async t => {
  const f = await fixture(t);
  global.fetch = async (_url, opts) => response(JSON.parse(opts.body).kind ? { cost_coverage_versions: [1] } : { inserted: 1, cost_coverage_version: 1 });
  assert.equal((await drainQueueToCloud(f.args)).inserted, 1);
  assert.equal(await f.offset(), f.size);
});
test("switching off upload during the capability probe sends no usage", async t => {
  const f = await fixture(t); let enabled = true, calls = 0;
  global.fetch = async () => { calls++; enabled = false; return response({ cost_coverage_versions: [1] }); };
  assert.equal((await drainQueueToCloud({ ...f.args, canUpload: () => enabled })).batches, 0);
  assert.equal(calls, 1); assert.equal(await f.offset(), 0);
});
