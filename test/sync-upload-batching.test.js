/**
 * Production-path batching regression for account_session_state uploads.
 *
 * Real chain under test (only the network boundary is mocked):
 *
 *   queue.jsonl -> readQueueBatch() -> drainQueueToCloud() -> fetch(ingest)
 *
 * The ingest edge (dashboard/edge-patches/tokentracker-ingest.ts) rejects a
 * request with > 500 account_session_states (HTTP 400) and > 500 hourly
 * buckets. Before this regression, session-state records did NOT count
 * toward readQueueBatch's per-batch record cap, so a states-heavy queue
 * (e.g. a fresh device's first 30-day TRAE sync) produced ONE oversized
 * request; the 400 left the queue offset untouched, and every retry re-read
 * the identical oversized batch - a PERMANENT upload failure.
 *
 * These tests enforce the fixed contract instead:
 *   - every request carries <= 500 states (with the default batchSize of
 *     200, batching follows the existing design: <= 200 records per batch),
 *   - batching makes bounded forward progress and loses nothing,
 *   - nextOffset only crosses records actually included in the request,
 *   - a states-only batch uploads normally,
 *   - an HTTP failure freezes the offset at the failed batch; a retry
 *     resumes from exactly there (no skip, no permanent 400),
 *   - observations stay canonical per request (no duplicate session ids in
 *     one request), keeping cloud LWW replay idempotent.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readQueueBatch, drainQueueToCloud } = require("../src/commands/sync");

const INGEST_STATE_LIMIT = 500; // edge contract: account_session_states.length <= 500
const BATCH_SIZE = 200; // production default (cmdSync autoUploadDecision.batchSize)

function tempQueue(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, queuePath: path.join(dir, "queue.jsonl"), queueStatePath: path.join(dir, "queue-state.json") };
}

function stateRecord(sessionId, { model = "model-a", bucketStart = "2027-01-10T10:00:00.000Z", input = 100, verifiedAt = "2027-01-15T00:00:00.000Z" } = {}) {
  return {
    kind: "account_session_state",
    source: "trae-cn",
    session_id: sessionId,
    model,
    bucket_start: bucketStart,
    input_tokens: input,
    output_tokens: 10,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: input + 10,
    snapshot_verified_at: verifiedAt,
  };
}

function bucketRow(hourStart, total = 50) {
  return { source: "trae-cn", model: "model-a", hour_start: hourStart, total_tokens: total, input_tokens: total, output_tokens: 0 };
}

/**
 * Mock ingest that mirrors the REAL edge contract (payload caps + response
 * shape). Records every request's buckets/states for assertions.
 */
function installIngestMock({ failFirstNBatches = 0 } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  let failuresLeft = failFirstNBatches;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const buckets = Array.isArray(body.hourly) ? body.hourly : [];
    const states = Array.isArray(body.account_session_states) ? body.account_session_states : [];
    if (buckets.length > 500 || states.length > INGEST_STATE_LIMIT) {
      calls.push({ buckets, states, rejected: true });
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify({ error: "Too many buckets or account session states" })),
      };
    }
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      calls.push({ buckets, states, failed: true });
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify({ error: "transient" })),
      };
    }
    calls.push({ buckets, states });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ inserted: buckets.length + states.length, skipped: 0 })),
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

function writeQueue(queuePath, records) {
  fs.writeFileSync(queuePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

for (const statesOnly of [false, true]) {
  test(`partial-accounting negotiation retains queue on old cloud and respects cancellation (${statesOnly ? "states" : "buckets"})`, async t => {
    const { dir, queuePath, queueStatePath } = tempQueue("tokentracker-capabilities-");
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const base = statesOnly ? stateRecord("partial") : bucketRow("2027-01-10T10:00:00Z");
    writeQueue(queuePath, [{ ...base, unclassified_input_tokens: 50, total_tokens: base.total_tokens + 50 }]);
    const calls = [];
    let version = 2, allowed = true, cancelOnProbe = false;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === "GET") {
        assert.ok(init.signal, "capability probe has the same upload deadline");
        if (cancelOnProbe) allowed = false;
        return Response.json({ accounting_version: version });
      }
      return Response.json({ inserted: 1 });
    });
    const drain = () => drainQueueToCloud({ baseUrl: "https://example.test", deviceToken: "fixture", queuePath, queueStatePath, canUpload: () => allowed });
    await assert.rejects(drain(), /usage remains queued locally/);
    assert.equal(fs.existsSync(queueStatePath), false);
    assert.equal(calls.filter(c => c.init.method === "POST").length, 0);
    version = 3; cancelOnProbe = true;
    await drain();
    assert.equal(fs.existsSync(queueStatePath), false, "switching off after a probe cannot acknowledge rows");
    assert.equal(calls.filter(c => c.init.method === "POST").length, 0);
    cancelOnProbe = false; allowed = true;
    await drain();
    assert.equal(JSON.parse(fs.readFileSync(queueStatePath, "utf8")).offset, fs.statSync(queuePath).size);
    const post = calls.find(c => c.init.method === "POST");
    assert.ok(post.init.signal);
    assert.ok(JSON.parse(post.init.body).upload_id);
    const body = JSON.parse(post.init.body);
    assert.equal((statesOnly ? body.account_session_states : body.hourly)[0].unclassified_input_tokens, 50);
  });
}

test("1200 states-only queue: bounded batches, every request <= 500, nothing lost, no permanent 400", async (t) => {
  const { dir, queuePath, queueStatePath } = tempQueue("tokentracker-batching-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const total = 1200;
  writeQueue(queuePath, Array.from({ length: total }, (_, i) => stateRecord(`s-${i}`)));

  const ingest = installIngestMock();
  t.after(() => ingest.restore());

  // Production drain defaults: maxBatches=5 per invocation, batchSize=200.
  let drained = 0;
  let guard = 0;
  while (drained < total && guard < 20) {
    const result = await drainQueueToCloud({ baseUrl: "https://t.example", deviceToken: "tok", queuePath, queueStatePath, maxBatches: 5, batchSize: BATCH_SIZE });
    const state = JSON.parse(fs.readFileSync(queueStatePath, "utf8"));
    drained = state.offset >= fs.statSync(queuePath).size ? total : drained + result.inserted + result.skipped;
    guard += 1;
    if (result.batches === 0) break;
  }

  // No request ever exceeded the ingest cap...
  assert.ok(ingest.calls.length > 0, "requests were made");
  for (const call of ingest.calls) {
    assert.ok(!call.rejected, `request rejected by ingest cap (states=${call.states.length})`);
    assert.ok(call.states.length <= INGEST_STATE_LIMIT, `states per request <= ${INGEST_STATE_LIMIT}`);
    assert.ok(call.buckets.length <= 500, "buckets per request <= 500");
  }
  // ...all 1200 distinct sessions were delivered exactly once...
  const delivered = ingest.calls.flatMap((c) => c.states.map((s) => s.session_id));
  assert.equal(delivered.length, total, "no loss, no duplicate delivery");
  assert.equal(new Set(delivered).size, total, "every session delivered exactly once");
  // ...no request duplicated a session id (canonical per request)...
  for (const call of ingest.calls) {
    assert.equal(new Set(call.states.map((s) => s.session_id)).size, call.states.length, "one observation per session per request");
  }
  // ...and the drain made bounded forward progress to the end of the queue.
  const finalState = JSON.parse(fs.readFileSync(queueStatePath, "utf8"));
  assert.ok(finalState.offset >= fs.statSync(queuePath).size, "offset reached the end of the queue");
});

test("states-only batch uploads normally (no bucket rows required)", async (t) => {
  const { dir, queuePath, queueStatePath } = tempQueue("tokentracker-states-only-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeQueue(queuePath, Array.from({ length: 10 }, (_, i) => stateRecord(`s-${i}`)));

  const ingest = installIngestMock();
  t.after(() => ingest.restore());

  const result = await drainQueueToCloud({ baseUrl: "https://t.example", deviceToken: "tok", queuePath, queueStatePath, maxBatches: 5, batchSize: BATCH_SIZE });
  assert.ok(result.batches >= 1, "states-only queue still uploads");
  assert.equal(ingest.calls.filter((c) => !c.failed && !c.rejected).length, 1);
  assert.equal(ingest.calls[0].buckets.length, 0, "no bucket rows in a states-only queue");
  assert.equal(ingest.calls[0].states.length, 10);
});

test("mid-drain HTTP failure: offset freezes at the failed batch, retry resumes exactly there", async (t) => {
  const { dir, queuePath, queueStatePath } = tempQueue("tokentracker-recover-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const total = 450; // 3 batches of 200/200/50 at batchSize=200
  const records = Array.from({ length: total }, (_, i) => stateRecord(`s-${i}`));
  writeQueue(queuePath, records);
  // Cumulative byte offset after the first N records (file bytes, incl. \n).
  const offsetAfter = (n) => records.slice(0, n).reduce((acc, r) => acc + JSON.stringify(r).length + 1, 0);

  // First drain: batch 1 succeeds, batch 2 fails (503), drain aborts.
  // Custom mock: only the SECOND request fails.
  const realFetch = globalThis.fetch;
  const calls = [];
  let requestIndex = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const states = Array.isArray(body.account_session_states) ? body.account_session_states : [];
    const buckets = Array.isArray(body.hourly) ? body.hourly : [];
    requestIndex += 1;
    const fail = requestIndex === 2; // first batch OK, second batch fails
    calls.push({ buckets, states, failed: fail });
    if (fail) {
      return { ok: false, status: 503, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({ error: "transient" })) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({ inserted: states.length, skipped: 0 })) };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await assert.rejects(
    () => drainQueueToCloud({ baseUrl: "https://t.example", deviceToken: "tok", queuePath, queueStatePath, maxBatches: 5, batchSize: BATCH_SIZE }),
    (err) => err.status === 503,
  );
  // Exactly one batch landed; the offset crossed ONLY that batch's records.
  assert.equal(calls.filter((c) => !c.failed).length, 1);
  const stateAfterFailure = JSON.parse(fs.readFileSync(queueStatePath, "utf8"));
  assert.equal(stateAfterFailure.offset, offsetAfter(200), "offset crossed exactly the first batch's 200 records");

  // Retry: everything from the failed batch onward now succeeds.
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const states = Array.isArray(body.account_session_states) ? body.account_session_states : [];
    calls.push({ buckets: [], states });
    return { ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({ inserted: states.length, skipped: 0 })) };
  };
  await drainQueueToCloud({ baseUrl: "https://t.example", deviceToken: "tok", queuePath, queueStatePath, maxBatches: 5, batchSize: BATCH_SIZE });

  const successful = calls.filter((c) => !c.failed);
  const delivered = successful.flatMap((c) => c.states.map((s) => s.session_id));
  assert.equal(new Set(delivered).size, total, "every session eventually delivered exactly once across the failure boundary");
  assert.equal(delivered.length, total, "no loss and no duplicate delivery");
  const finalState = JSON.parse(fs.readFileSync(queueStatePath, "utf8"));
  assert.ok(finalState.offset >= fs.statSync(queuePath).size, "retry drains to the end");
});

test("mixed queue: buckets and states both count toward the batch cap; nextOffset crosses only included records", async (t) => {
  const { dir, queuePath, queueStatePath } = tempQueue("tokentracker-mixed-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 150 buckets then 100 states: with the cap counting BOTH record kinds,
  // the first batch must stop at 200 records total (150 buckets + 50
  // states), and the second batch carries the remaining 50 states.
  const records = [
    // Distinct half-hours: bucket rows are keyed by (source, model, hour)
    // and would otherwise legitimately dedup in place.
    ...Array.from({ length: 150 }, (_, i) =>
      bucketRow(new Date(Date.parse("2027-01-10T00:00:00.000Z") + i * 30 * 60 * 1000).toISOString()),
    ),
    ...Array.from({ length: 100 }, (_, i) => stateRecord(`s-${i}`)),
  ];
  writeQueue(queuePath, records);

  const first = await readQueueBatch(queuePath, 0, BATCH_SIZE);
  assert.equal(first.buckets.length, 150);
  assert.equal(first.sessionStates.length, 50, "states fill the remainder of the capped batch");
  assert.equal(first.sessionStates[0].session_id, "s-0");

  const second = await readQueueBatch(queuePath, first.nextOffset, BATCH_SIZE);
  assert.equal(second.buckets.length, 0);
  assert.equal(second.sessionStates.length, 50, "the tail states come back in the next batch");
  assert.equal(second.sessionStates[0].session_id, "s-50");
});

test("duplicate observations of one session: newer fetch stamp wins, never duplicated inside one request", async (t) => {
  const { dir, queuePath, queueStatePath } = tempQueue("tokentracker-dup-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const older = stateRecord("dup-1", { input: 100, verifiedAt: "2027-01-15T00:00:00.000Z" });
  const newer = stateRecord("dup-1", { input: 60, verifiedAt: "2027-01-16T00:00:00.000Z" });
  writeQueue(queuePath, [older, newer, stateRecord("other-1")]);

  const batch = await readQueueBatch(queuePath, 0, BATCH_SIZE);
  const ids = batch.sessionStates.map((s) => s.session_id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, "no duplicate session id inside one request");
  const dup = batch.sessionStates.find((s) => s.session_id === "dup-1");
  assert.equal(dup.input_tokens, 60, "the newer fetch stamp is the observation delivered");
});
