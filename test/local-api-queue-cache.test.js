const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");
const pricing = require("../src/lib/pricing");

function queueRow(totalTokens, { source = "codex", model = "gpt-5.5" } = {}) {
  return {
    source,
    model,
    hour_start: "2026-07-17T02:00:00.000Z",
    input_tokens: totalTokens - 10,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
    billable_total_tokens: totalTokens,
    conversation_count: 1,
  };
}

async function callEndpoint(handler, endpoint) {
  const url = new URL(`http://localhost${endpoint}`);
  const chunks = [];
  const req = {
    method: "GET",
    url: url.pathname + url.search,
    headers: { host: "localhost" },
  };
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    write(chunk) {
      chunks.push(chunk);
    },
    end(body) {
      if (body) chunks.push(body);
    },
  };
  assert.equal(await handler(req, res, url), true);
  assert.equal(res.statusCode, 200);
  return JSON.parse(chunks.join(""));
}

test("local usage endpoints reuse one parsed queue until the file changes", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-queue-cache-"));
  const queuePath = path.join(tmp, "queue.jsonl");
  const queueContents = `${JSON.stringify(queueRow(100))}\n`.repeat(20);
  await fs.promises.writeFile(queuePath, queueContents);
  const handler = createLocalApiHandler({ queuePath });

  const originalReadSync = fs.readSync;
  let queueBytes = 0;
  fs.readSync = function countedReadSync(fd, buffer, offset, length, position) {
    const bytesRead = originalReadSync.call(fs, fd, buffer, offset, length, position);
    queueBytes += bytesRead;
    return bytesRead;
  };

  try {
    const summary = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-07-17&to=2026-07-17&tz=UTC",
    );
    const daily = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-daily?from=2026-07-17&to=2026-07-17&tz=UTC",
    );
    assert.equal(summary.totals.total_tokens, 100);
    assert.equal(daily.data[0].total_tokens, 100);
    const coldReadBytes = queueBytes;
    await callEndpoint(handler, "/functions/tokentracker-usage-summary?tz=UTC");
    assert.equal(queueBytes, coldReadBytes, "unchanged snapshots do not reread queue bytes");

    // Appending invalidates the signature.
    // The refresh reads just the new tail instead of the whole file.
    const appendedLine = `${JSON.stringify(queueRow(250))}\n`;
    await fs.promises.appendFile(queuePath, appendedLine);
    const refreshed = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-07-17&to=2026-07-17&tz=UTC",
    );
    assert.equal(refreshed.totals.total_tokens, 250);
    assert.equal(queueBytes - coldReadBytes, Buffer.byteLength(appendedLine), "append reads only the new tail");
  } finally {
    fs.readSync = originalReadSync;
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("cached day aggregation preserves IANA time-zone day boundaries", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-day-cache-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const rows = [
      { ...queueRow(100), hour_start: "2026-03-08T07:30:00.000Z" },
      { ...queueRow(200), hour_start: "2026-03-08T10:30:00.000Z" },
    ];
    await fs.promises.writeFile(queuePath, `${rows.map(JSON.stringify).join("\n")}\n`);
    const handler = createLocalApiHandler({ queuePath });

    const march7 = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-03-07&to=2026-03-07&tz=America%2FLos_Angeles",
    );
    const march8 = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-03-08&to=2026-03-08&tz=America%2FLos_Angeles",
    );
    assert.equal(march7.totals.total_tokens, 100);
    assert.equal(march8.totals.total_tokens, 200);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("pricing revision invalidates cached daily cost without rereading the queue", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-pricing-revision-cache-"));
  const queuePath = path.join(tmp, "queue.jsonl");
  const cachePath = path.join(tmp, "pricing.json");
  const row = {
    ...queueRow(1_000_000, { source: "revision-source", model: "revision-only-model" }),
    input_tokens: 1_000_000,
    output_tokens: 0,
  };
  await fs.promises.writeFile(queuePath, `${JSON.stringify(row)}\n`);
  const handler = createLocalApiHandler({ queuePath });
  pricing.resetPricingForTests();

  try {
    const before = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-07-17&to=2026-07-17&tz=UTC",
    );
    assert.equal(Number(before.totals.total_cost_usd), 0);

    await pricing.ensurePricingLoaded({
      cachePath,
      fetchImpl: async () => ({
        "revision-only-model": {
          input_cost_per_token: 2e-6,
          output_cost_per_token: 0,
        },
      }),
    });

    const after = await callEndpoint(
      handler,
      "/functions/tokentracker-usage-summary?from=2026-07-17&to=2026-07-17&tz=UTC",
    );
    assert.equal(Number(after.totals.total_cost_usd), 2);
  } finally {
    pricing.resetPricingForTests();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("large daily aggregations share work and allow HTTP requests while computing", async (t) => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-daily-responsive-"));
  t.after(() => fs.promises.rm(tmp, { recursive: true, force: true }));
  const queuePath = path.join(tmp, "queue.jsonl");
  const rows = Array.from({ length: 24_000 }, (_, i) => ({
    ...queueRow(100),
    hour_start: new Date(Date.parse("2026-07-17T00:00:00Z") - i * 1_800_000).toISOString(),
  }));
  await fs.promises.writeFile(queuePath, rows.map(JSON.stringify).join("\n") + "\n");
  const handler = createLocalApiHandler({ queuePath, trackerDataDir: tmp });
  // Warm queue bytes, but leave Shanghai's daily aggregation cold.
  await callEndpoint(handler, "/functions/tokentracker-usage-summary?from=2000-01-01&to=2099-12-31&tz=UTC");
  const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  let processed = 0;
  t.mock.method(Intl.DateTimeFormat.prototype, "formatToParts", function (...args) {
    processed++;
    return formatToParts.apply(this, args);
  });
  const http = require("node:http");
  const server = http.createServer((req, res) => res.end("healthy"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const range = "from=2000-01-01&to=2099-12-31&tz=Asia%2FShanghai";
  let completed = false;
  const summary = callEndpoint(handler, `/functions/tokentracker-usage-summary?${range}`).then((result) => { completed = true; return result; });
  while (!processed) await new Promise((resolve) => setImmediate(resolve));
  const daily = callEndpoint(handler, `/functions/tokentracker-usage-daily?${range}`);
  assert.equal(await fetch(`http://127.0.0.1:${server.address().port}`).then((res) => res.text()), "healthy");
  assert.equal(completed, false, "HTTP responds during aggregation, after rows have started processing");
  const [result, dailyResult] = await Promise.all([summary, daily]);
  assert.equal(result.totals.total_tokens, 2_400_000);
  assert.equal(dailyResult.data.reduce((sum, row) => sum + row.total_tokens, 0), 2_400_000);
  assert.ok(processed < 24_100, "concurrent endpoints share the same daily aggregation");
});

test("a pricing refresh during cooperative aggregation cannot publish mixed revisions", async (t) => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-daily-price-race-"));
  t.after(() => fs.promises.rm(tmp, { recursive: true, force: true }));
  const queuePath = path.join(tmp, "queue.jsonl");
  const rows = Array.from({ length: 2_000 }, (_, i) => ({
    ...queueRow(1_000_000, { source: "revision-source", model: "aggregation-revision-only-model" }),
    input_tokens: 1_000_000, output_tokens: 0,
    hour_start: new Date(Date.parse("2026-07-17T00:00:00Z") - i * 1_800_000).toISOString(),
  }));
  await fs.promises.writeFile(queuePath, rows.map(JSON.stringify).join("\n") + "\n");
  pricing.resetPricingForTests();
  t.after(() => pricing.resetPricingForTests());
  let refresh;
  const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  t.mock.method(Intl.DateTimeFormat.prototype, "formatToParts", function (...args) {
    refresh ||= pricing.ensurePricingLoaded({
      cachePath: path.join(tmp, "pricing.json"),
      fetchImpl: async () => ({ "aggregation-revision-only-model": { input_cost_per_token: 2e-6, output_cost_per_token: 0 } }),
    });
    return formatToParts.apply(this, args);
  });
  // Disk completion can legitimately arrive after the entire aggregation on
  // Windows. Gate the first aggregation yield on the refresh so this test
  // deterministically exercises a revision change DURING the calculation.
  const timers = require("node:timers/promises");
  const yieldToRequests = timers.setImmediate;
  t.mock.method(timers, "setImmediate", async (...args) => {
    if (refresh) await refresh;
    return yieldToRequests(...args);
  });
  // The local API captures its yield function at module load; isolate this
  // factory without replacing the module used by the other tests in this file.
  const modulePath = require.resolve("../src/lib/local-api");
  const originalModule = require.cache[modulePath];
  let isolatedFactory;
  try {
    delete require.cache[modulePath];
    isolatedFactory = require(modulePath).createLocalApiHandler;
  } finally {
    require.cache[modulePath] = originalModule;
  }
  const handler = isolatedFactory({ queuePath, trackerDataDir: tmp });
  const result = await callEndpoint(handler, "/functions/tokentracker-usage-summary?from=2000-01-01&to=2099-12-31&tz=UTC");
  await refresh;
  assert.equal(Number(result.totals.total_cost_usd), 4_000);
});
