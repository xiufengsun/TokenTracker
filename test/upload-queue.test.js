"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const http = require("node:http");
const { compactPendingQueue } = require("../src/lib/upload-queue");
const { readQueueBatch, drainQueueToCloud } = require("../src/commands/sync");
const { upsertAccountSessionStates } = require("../src/lib/account-usage-dedup");

const row = (id, total) => ({ source: "claude", model: `模型-${id}`, hour_start: "2026-10-12T00:00:00Z", input_tokens: total, total_tokens: total });
const session = (total) => ({ kind: "account_session_state", source: "trae-cn", session_id: "会话", model: "model-a", bucket_start: "2026-10-12T00:00:00Z", input_tokens: total, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: total, snapshot_verified_at: new Date(Date.parse("2026-10-12T00:00:00Z") + (100 - total) * 1000).toISOString() });
const encode = (record) => `${JSON.stringify(record)}\n`;

async function fixture(t, raw) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-upload-queue-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, "queue.jsonl");
  const queueStatePath = path.join(dir, "queue.state.json");
  await fs.writeFile(queuePath, raw);
  return { queuePath, queueStatePath };
}

test("pending compaction preserves uploaded UTF8 bytes and LWW downward/zero snapshots", async (t) => {
  const prefix = encode(row("已上传", 100));
  const retained = [row("b", 30), row("a", 0), session(0)];
  const raw = prefix + [row("a", 100), session(80), row("a", 40), session(40), ...retained].map(encode).join("");
  const x = await fixture(t, raw);
  const state = JSON.stringify({ offset: Buffer.byteLength(prefix), note: "keep", updatedAt: "old" });
  await fs.writeFile(x.queueStatePath, state);
  // POSIX readers keep the original inode; Windows requires closing readers
  // before replacing a file. Prefix and offset checks run on both platforms.
  const oldReader = process.platform === "win32" ? null : await fs.open(x.queuePath, "r");
  if (oldReader) t.after(() => oldReader.close());
  const result = await compactPendingQueue({ ...x, offset: Buffer.byteLength(prefix), minPendingBytes: 0 });
  assert.equal(result.removedRecords, 4);
  assert.equal(await fs.readFile(x.queuePath, "utf8"), prefix + retained.map(encode).join(""));
  if (oldReader) {
    assert.equal(await oldReader.readFile("utf8"), raw);
    await oldReader.close();
  }
  assert.equal(await fs.readFile(x.queueStatePath, "utf8"), state);
  assert.equal((await compactPendingQueue({ ...x, offset: Buffer.byteLength(prefix), minPendingBytes: 0 })).compacted, false);
  const batch = await readQueueBatch(x.queuePath, Buffer.byteLength(prefix), 200);
  assert.equal(batch.nextOffset, (await fs.stat(x.queuePath)).size);
  assert.deepEqual(batch.buckets.map((value) => value.total_tokens), [30, 0]);
  assert.equal(batch.sessionStates[0].total_tokens, 0);
  assert.equal(batch.sessionStates[0].snapshot_verified_at, session(0).snapshot_verified_at);
});

test("compaction closes its input handle before replacing the original queue", async (t) => {
  const x = await fixture(t, encode(row("a", 100)) + encode(row("a", 0)));
  const realOpen = fs.open;
  const realRename = fs.rename;
  let inputOpen = false;
  fs.open = async (file, flags, ...args) => {
    const handle = await realOpen(file, flags, ...args);
    if (file === x.queuePath && flags === "r") {
      inputOpen = true;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); inputOpen = false; };
    }
    return handle;
  };
  fs.rename = async (from, to) => {
    assert.equal(inputOpen, false, "an open input handle blocks Windows replacement");
    return realRename(from, to);
  };
  try {
    assert.equal((await compactPendingQueue({ ...x, minPendingBytes: 0 })).compacted, true);
    assert.equal(await fs.readFile(x.queuePath, "utf8"), encode(row("a", 0)));
  } finally { fs.open = realOpen; fs.rename = realRename; }
});

test("unknown, invalid, watermark, CRLF and incomplete tail records survive byte-for-byte", async (t) => {
  const unknown = encode({ ...row("a", 40), kind: "future_control" });
  const invalid = "{invalid}\r\n";
  const watermark = encode({ kind: "account_sync_watermark", source: "trae-cn" });
  const incomplete = JSON.stringify(row("a", 10));
  const x = await fixture(t, encode(row("a", 100)) + unknown + invalid + watermark + encode(row("a", 0)).replace(/\n$/, "\r\n") + incomplete);
  await compactPendingQueue({ ...x, minPendingBytes: 0 });
  const expected = unknown + invalid + watermark + encode(row("a", 0)).replace(/\n$/, "\r\n") + incomplete;
  assert.equal(await fs.readFile(x.queuePath, "utf8"), expected);
  const batch = await readQueueBatch(x.queuePath, 0, 200);
  assert.equal(batch.buckets[0].total_tokens, 0);
  assert.equal(batch.nextOffset, Buffer.byteLength(expected) - Buffer.byteLength(incomplete));
  await fs.appendFile(x.queuePath, "\n");
  const completed = await readQueueBatch(x.queuePath, batch.nextOffset, 200);
  assert.equal(completed.buckets[0].total_tokens, 10);
  assert.equal(completed.nextOffset, (await fs.stat(x.queuePath)).size);
});

test("default threshold and invalid mid-line offset leave the queue untouched", async (t) => {
  const raw = encode(row("a", 100)) + encode(row("a", 0));
  const x = await fixture(t, raw);
  assert.equal((await compactPendingQueue(x)).compacted, false);
  assert.equal((await compactPendingQueue({ ...x, offset: 5, minPendingBytes: 0 })).compacted, false);
  assert.equal(await fs.readFile(x.queuePath, "utf8"), raw);
});

test("invalid UTF8, invalid dates and invalid session identities cannot be compacted away", async (t) => {
  const invalidUtf8 = Buffer.concat([Buffer.from('{"model":"'), Buffer.from([0xff]), Buffer.from('","hour_start":"2026-10-12T00:00:00Z"}\n')]);
  const invalidDate = encode({ ...row("bad", 1), hour_start: "bad-date" });
  const invalidSession = encode({ ...session(10), source: " " });
  const preserved = Buffer.concat([invalidUtf8, invalidUtf8, Buffer.from(invalidDate.repeat(2) + invalidSession.repeat(2))]);
  const x = await fixture(t, Buffer.concat([Buffer.from(encode(row("a", 100))), preserved, Buffer.from(encode(row("a", 0)))]));
  assert.equal((await compactPendingQueue({ ...x, minPendingBytes: 0 })).removedRecords, 1);
  assert.deepEqual(await fs.readFile(x.queuePath), Buffer.concat([preserved, Buffer.from(encode(row("a", 0)))]));
});

test("failed replacement leaves the original queue and offset available for retry", async (t) => {
  const raw = encode(row("a", 100)) + encode(row("a", 0));
  const x = await fixture(t, raw);
  await fs.writeFile(x.queueStatePath, '{"offset":0,"note":"original"}');
  const realRename = fs.rename;
  fs.rename = async () => { throw new Error("rename unavailable"); };
  try {
    await assert.rejects(compactPendingQueue({ ...x, minPendingBytes: 0 }), /rename unavailable/);
  } finally {
    fs.rename = realRename;
  }
  assert.equal(await fs.readFile(x.queuePath, "utf8"), raw);
  assert.equal(await fs.readFile(x.queueStatePath, "utf8"), '{"offset":0,"note":"original"}');
  assert.deepEqual((await fs.readdir(path.dirname(x.queuePath))).sort(), ["queue.jsonl", "queue.state.json"]);
  assert.equal((await compactPendingQueue({ ...x, minPendingBytes: 0 })).compacted, true);
});

test("replacement ENOENT remains an error after the input handle closes", async (t) => {
  const raw = encode(row("a", 100)) + encode(row("a", 0));
  const x = await fixture(t, raw);
  const realRename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error("replacement missing"), { code: "ENOENT" }); };
  try {
    await assert.rejects(compactPendingQueue({ ...x, minPendingBytes: 0 }), { code: "ENOENT" });
  } finally {
    fs.rename = realRename;
  }
  assert.equal(await fs.readFile(x.queuePath, "utf8"), raw);
  assert.deepEqual(await fs.readdir(path.dirname(x.queuePath)), ["queue.jsonl"]);
});

test("compaction preserves existing permissions under a restrictive umask", { skip: process.platform === "win32" }, async (t) => {
  const x = await fixture(t, encode(row("a", 100)) + encode(row("a", 0)));
  await fs.chmod(x.queuePath, 0o640);
  const prior = process.umask(0o077);
  try {
    await compactPendingQueue({ ...x, minPendingBytes: 0 });
  } finally { process.umask(prior); }
  assert.equal((await fs.stat(x.queuePath)).mode & 0o777, 0o640);
});

test("local checkpoint failure remains an error when the request deadline has expired", async (t) => {
  const x = await fixture(t, encode(row("a", 100)));
  await fs.writeFile(x.queueStatePath, '{"offset":0}');
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ inserted: 1, next_allowed_at: "2026-10-13T00:00:00Z" }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const realFetch = global.fetch;
  const realRename = fs.rename;
  let signal;
  global.fetch = (input, options) => { signal = options.signal; return realFetch(input, options); };
  fs.rename = async (from, to) => {
    if (to !== x.queueStatePath) return realRename(from, to);
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    throw Object.assign(new Error("checkpoint denied"), { code: "EACCES" });
  };
  try {
    await assert.rejects(drainQueueToCloud({ ...x, baseUrl: `http://127.0.0.1:${server.address().port}`,
      deviceToken: "fixture", maxDurationMs: 2000 }), error => {
      assert.equal(error.code, "EACCES");
      assert.equal(error.uploadResult.batches, 1);
      return true;
    });
    assert.equal(JSON.parse(await fs.readFile(x.queueStatePath, "utf8")).offset, 0);
  } finally { global.fetch = realFetch; fs.rename = realRename; }
});

test("an oversized line crossing read chunks keeps its exact bytes", async (t) => {
  const bigRow = { ...row("a", 10), fixture: "中文".repeat(40_000) };
  const x = await fixture(t, encode(row("a", 100)) + encode(bigRow));
  assert.equal((await compactPendingQueue({ ...x, minPendingBytes: 0 })).removedRecords, 1);
  assert.equal(await fs.readFile(x.queuePath, "utf8"), encode(bigRow));
});

test("drain time budget aborts a stalled request and preserves previous successful offset/cooldown", async (t) => {
  const x = await fixture(t, [row("a", 100), row("b", 50)].map(encode).join(""));
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  let requests = 0;
  global.fetch = async (_url, options) => {
    requests += 1;
    if (requests === 1) return { ok: true, text: async () => JSON.stringify({ inserted: 1, next_allowed_at: "2026-10-12T01:00:00Z" }) };
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };
  // AbortSignal.timeout does not keep Node alive by itself.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const started = Date.now();
  const result = await drainQueueToCloud({ ...x, baseUrl: "https://fixture.test", deviceToken: "fixture", maxBatches: 100, batchSize: 1, maxDurationMs: 2000 });
  assert.equal(result.batches, 1);
  assert.equal(result.cloudAccess.next_allowed_at, "2026-10-12T01:00:00Z");
  assert.equal(JSON.parse(await fs.readFile(x.queueStatePath, "utf8")).offset, Buffer.byteLength(encode(row("a", 100))));
  assert.equal(requests, 2);
  assert.ok(Date.now() - started < 10_000);
});

test("community window stops at ten batches and a partial HTTP failure carries prior cloud access", async (t) => {
  const x = await fixture(t, Array.from({ length: 20 }, (_, i) => encode(row(String(i), 1))).join(""));
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: true, text: async () => JSON.stringify({ inserted: 1, upload_scope: "community" }) }; };
  const result = await drainQueueToCloud({ ...x, baseUrl: "https://fixture.test", deviceToken: "fixture", maxBatches: 100, batchSize: 1 });
  assert.equal(result.batches, 10);
  assert.equal(calls, 10);
  calls = 0;
  global.fetch = async () => {
    calls += 1;
    return calls === 1
      ? { ok: true, text: async () => JSON.stringify({ inserted: 1, next_allowed_at: "2026-10-12T01:00:00Z" }) }
      : { ok: false, status: 503, text: async () => '{"code":"fixture_failure"}' };
  };
  await assert.rejects(drainQueueToCloud({ ...x, baseUrl: "https://fixture.test", deviceToken: "fixture", maxBatches: 100, batchSize: 1 }), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.uploadResult.batches, 1);
    assert.equal(error.uploadResult.cloudAccess.next_allowed_at, "2026-10-12T01:00:00Z");
    return true;
  });
});

test("real HTTP response-body stall obeys the drain deadline without advancing the stalled batch", async (t) => {
  const x = await fixture(t, [row("a", 100), row("b", 50)].map(encode).join(""));
  let calls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      calls += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      if (calls === 1) response.end(JSON.stringify({ inserted: 1, next_allowed_at: "2026-10-12T01:00:00Z" }));
      else response.write('{"inserted":');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const started = Date.now();
  const result = await drainQueueToCloud({ ...x, baseUrl: `http://127.0.0.1:${server.address().port}`, deviceToken: "fixture", maxBatches: 100, batchSize: 1, maxDurationMs: 3000 });
  assert.equal(calls, 2);
  assert.equal(result.batches, 1);
  assert.equal(result.cloudAccess.next_allowed_at, "2026-10-12T01:00:00Z");
  assert.equal(JSON.parse(await fs.readFile(x.queueStatePath, "utf8")).offset, Buffer.byteLength(encode(row("a", 100))));
  assert.ok(Date.now() - started < 10_000);
});

test("the upload window has a hard 100-batch cap even when a caller requests more", async (t) => {
  const x = await fixture(t, Array.from({ length: 101 }, (_, i) => encode(row(String(i), 1))).join(""));
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: true, text: async () => '{"inserted":1,"upload_scope":"cloud"}' }; };
  const result = await drainQueueToCloud({ ...x, baseUrl: "https://fixture.test", deviceToken: "fixture", maxBatches: 1000, batchSize: 1 });
  assert.equal(result.batches, 100);
  assert.equal(calls, 100);
  assert.ok(JSON.parse(await fs.readFile(x.queueStatePath, "utf8")).offset < (await fs.stat(x.queuePath)).size);
});

test("ignored complete tail records advance locally while an incomplete tail remains retryable", async (t) => {
  const ignored = '{bad-json}\n' + encode({ kind: "account_sync_watermark" }) + encode({ kind: "future_control" });
  const incomplete = '{"hour_start":"';
  const raw = encode(row("a", 100)) + ignored + incomplete;
  const x = await fixture(t, raw);
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: true, text: async () => '{"inserted":1}' }; };
  const drain = () => drainQueueToCloud({ ...x, baseUrl: "https://fixture.test", deviceToken: "fixture", batchSize: 1 });
  assert.equal((await drain()).batches, 1);
  assert.equal(JSON.parse(await fs.readFile(x.queueStatePath, "utf8")).offset, Buffer.byteLength(raw) - Buffer.byteLength(incomplete));
  assert.equal((await drain()).batches, 0);
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(x.queuePath, "utf8"), raw, "ignored and incomplete records remain on disk");
});

test("session truth survives compaction and batch boundaries with older/equal/invalid stamps and zero corrections", async (t) => {
  const fresh = { ...session(60), snapshot_verified_at: "2026-10-12T01:00:00Z" };
  const older = { ...session(100), snapshot_verified_at: "2026-10-12T00:59:00Z" };
  const equal = { ...session(100), snapshot_verified_at: fresh.snapshot_verified_at };
  const corrected = { ...session(0), model: "model-b", bucket_start: "2026-10-12T00:30:00Z", snapshot_verified_at: "2026-10-12T01:01:00Z" };
  const invalidStamp = { ...session(100), snapshot_verified_at: "invalid" };
  const missingStamp = { ...session(100) }; delete missingStamp.snapshot_verified_at;
  const invalidModel = { ...session(100), model: "", snapshot_verified_at: "2026-10-12T01:02:00Z" };
  const cases = [
    { states: [fresh, older], expected: fresh },
    { states: [fresh, equal], expected: fresh },
    { states: [fresh, corrected], expected: corrected },
    { states: [fresh, invalidStamp], expected: fresh },
    { states: [missingStamp, fresh], expected: fresh },
    { states: [invalidModel, fresh], expected: fresh },
  ];
  for (const { states, expected } of cases) {
    for (const batchSize of [1, 200]) {
      for (const compact of [false, true]) {
        const records = [states[0], ...Array.from({ length: 199 }, () => row("duplicate-gap", 1)), states[1]];
        const x = await fixture(t, records.map(encode).join(""));
        if (compact) {
          await compactPendingQueue({ ...x, minPendingBytes: 0 });
          const raw = await fs.readFile(x.queuePath, "utf8");
          for (const state of states) {
            if (!Number.isFinite(Date.parse(state.snapshot_verified_at)) || !state.model) assert.ok(raw.includes(encode(state)), "invalid original control record remains on disk");
          }
        }
        const table = new Map();
        let offset = 0;
        const size = (await fs.stat(x.queuePath)).size;
        while (offset < size) {
          const batch = await readQueueBatch(x.queuePath, offset, batchSize);
          upsertAccountSessionStates(table, batch.sessionStates);
          assert.ok(batch.nextOffset > offset);
          offset = batch.nextOffset;
        }
        assert.equal(table.size, 1);
        const state = [...table.values()][0];
        assert.equal(state.total_tokens, expected.total_tokens, `tokens with batchSize=${batchSize} compact=${compact}`);
        assert.equal(state.model, expected.model);
        assert.equal(state.bucket_start, expected.bucket_start);
        assert.equal(state.snapshot_verified_at, expected.snapshot_verified_at);
      }
    }
  }
});

test("cloud upload omits local backend origins without changing logical usage", async (t) => {
  const usage = { ...row("logical-model", 100), backend_usage: [
    { backend: "custom", backend_origin: "https://private-gateway.example", input_tokens: 100, total_tokens: 100 },
  ] };
  const x = await fixture(t, encode(usage));
  const batch = await readQueueBatch(x.queuePath, 0, 200);
  assert.deepEqual(batch.buckets, [row("logical-model", 100)]);
  assert.deepEqual(JSON.parse((await fs.readFile(x.queuePath, "utf8")).trim()), usage);
});
