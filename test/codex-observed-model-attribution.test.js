const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const runtime = process.env.TOKENTRACKER_TEST_RUNTIME || path.join(__dirname, "..");
const { parseRolloutIncremental } = require(path.join(runtime, "src/lib/rollout"));
const { openCursorStore } = require(path.join(runtime, "src/lib/cursor-store"));
const usage = n => ({ input_tokens: n, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: n });
const event = (second, last, total) => ({ type: "event_msg", timestamp: `2026-07-01T00:00:${String(second).padStart(2, "0")}.000Z`, payload: { type: "token_count", info: { last_token_usage: usage(last), total_token_usage: usage(total) } } });
const context = model => ({ type: "turn_context", payload: { model, current_date: "2026-07-01" } });
const line = x => JSON.stringify(x) + "\n";
async function rows(queue) {
  const latest = new Map();
  for (const value of (await fs.readFile(queue, "utf8")).trim().split("\n")) {
    const row = JSON.parse(value);
    latest.set(row.model, row.total_tokens);
  }
  return Object.fromEntries([...latest].sort());
}

test("observed attribution retains unknown across model switches, restart, and inode rescan", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-observed-repair-"));
  try {
    const file = path.join(dir, "rollout-2026-07-01T00-00-00-11111111-1111-4111-8111-111111111111.jsonl");
    const queuePath = path.join(dir, "queue.jsonl");
    await fs.writeFile(file, [event(1, 10, 10), context("model-a"), event(2, 20, 30)].map(line).join(""));
    let cursors = { hourly: { version: 3, buckets: {}, groupQueued: {}, modelAttributionPolicy: { codex: "observed" } } };
    const run = () => parseRolloutIncremental({ rolloutFiles: [file], cursors, queuePath, invalidRecordPolicy: "throw" });
    await run();
    assert.deepEqual(await rows(queuePath), { "model-a": 20, unknown: 10 });
    assert.deepEqual(cursors.hourly.modelAttributionPolicy, { codex: "observed" });
    const first = await fs.readFile(queuePath, "utf8");
    assert.equal((await run()).eventsAggregated, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), first);
    const store = await openCursorStore({ trackerDir: path.join(dir, "store"), forceV2: true, codexRoots: [dir] });
    await store.commit(cursors);
    const restarted = await openCursorStore({ trackerDir: path.join(dir, "store"), forceV2: true, codexRoots: [dir] });
    await restarted.materializeAllCodexState();
    cursors = restarted.cursors;
    await fs.appendFile(file, [context("model-b"), event(3, 30, 60)].map(line).join(""));
    await run();
    assert.deepEqual(await rows(queuePath), { "model-a": 20, "model-b": 30, unknown: 10 });
    const stable = await fs.readFile(queuePath, "utf8");
    const replacement = file + ".replacement";
    await fs.copyFile(file, replacement);
    await fs.rename(replacement, file);
    assert.equal((await run()).eventsAggregated, 0);
    assert.equal((await run()).eventsAggregated, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), stable);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("existing attribution policy is unchanged when observed mode is not enabled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-default-attribution-"));
  try {
    const file = path.join(dir, "rollout-2026-07-01T00-00-00-22222222-2222-4222-8222-222222222222.jsonl");
    const queuePath = path.join(dir, "queue.jsonl");
    await fs.writeFile(file, [event(1, 10, 10), context("model-a"), event(2, 20, 30)].map(line).join(""));
    await parseRolloutIncremental({ rolloutFiles: [file], cursors: {}, queuePath });
    assert.deepEqual(await rows(queuePath), { "model-a": 30 });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("switching a previously aligned group to observed retracts the stale dominant row once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-observed-transition-"));
  try {
    const file = path.join(dir, "rollout-2026-07-01T00-00-00-33333333-3333-4333-8333-333333333333.jsonl");
    const queuePath = path.join(dir, "queue.jsonl");
    await fs.writeFile(file, [event(1, 10, 10), context("model-b"), event(2, 20, 30)].map(line).join(""));
    const cursors = { hourly: { version: 3, buckets: {}, groupQueued: {} } };
    await parseRolloutIncremental({ rolloutFiles: [file], cursors, queuePath });
    assert.deepEqual(await rows(queuePath), { "model-b": 30 });
    // Simulate the alignment state a default-policy group can persist (every-code
    // aligns its unknown bucket to the nearest codex dominant): the unknown tokens
    // were emitted under model-a, which has no bucket of its own in this group.
    const unknownKey = Object.keys(cursors.hourly.buckets).find(key => key.split("|")[1] === "unknown");
    cursors.hourly.buckets[unknownKey].alignedModel = "model-a";
    cursors.hourly.modelAttributionPolicy = { codex: "observed" };
    await fs.appendFile(file, [context("model-b"), event(3, 30, 60)].map(line).join(""));
    await parseRolloutIncremental({ rolloutFiles: [file], cursors, queuePath });
    // The stale model-a row is zeroed, unknown reclaims its tokens, model-b is
    // re-emitted with its own accumulated totals (20 + the new 30), keeping the
    // session total at 60.
    assert.deepEqual(await rows(queuePath), { "model-a": 0, "model-b": 50, unknown: 10 });
    assert.equal(cursors.hourly.buckets[unknownKey].alignedModel, null);
    const corrected = await fs.readFile(queuePath, "utf8");
    await parseRolloutIncremental({ rolloutFiles: [file], cursors, queuePath });
    assert.equal(await fs.readFile(queuePath, "utf8"), corrected);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
