const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");
const sessionAnalytics = require("../src/lib/session-analytics");

async function callEndpoint(handler, endpoint) {
  const url = new URL(`http://localhost${endpoint}`);
  const chunks = [];
  const req = { method: "GET", url: url.pathname + url.search, headers: { host: "localhost" } };
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(statusCode) { this.statusCode = statusCode; },
    write(chunk) { chunks.push(chunk); },
    end(body) { if (body) chunks.push(body); },
  };
  assert.equal(await handler(req, res, url), true);
  assert.equal(res.statusCode, 200);
  return JSON.parse(chunks.join(""));
}

test("sessions response cache expires instead of pinning an empty result", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-sessions-response-cache-"));
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  await fs.promises.mkdir(trackerDir, { recursive: true });
  await fs.promises.writeFile(path.join(trackerDir, "session.queue.jsonl"), "");
  const originalHome = os.homedir;
  const originalBuild = sessionAnalytics.buildSessionAnalytics;
  const originalNow = Date.now;
  let buildCalls = 0;
  os.homedir = () => tmp;
  sessionAnalytics.buildSessionAnalytics = async () => {
    buildCalls += 1;
    return [];
  };
  try {
    const handler = createLocalApiHandler({ queuePath: path.join(tmp, "queue.jsonl") });
    const endpoint = "/functions/tokentracker-sessions?from=&to=&tz=UTC";
    await callEndpoint(handler, endpoint);
    await callEndpoint(handler, endpoint);
    assert.equal(buildCalls, 1, "warm response should reuse the cache");
    const start = Date.now();
    Date.now = () => start + 61_000;
    await callEndpoint(handler, endpoint);
    assert.equal(buildCalls, 2, "expired response should rebuild");
    Date.now = originalNow;
    await callEndpoint(handler, `${endpoint}&refresh=1`);
    assert.equal(buildCalls, 3, "refresh should bypass the cache");
  } finally {
    os.homedir = originalHome;
    sessionAnalytics.buildSessionAnalytics = originalBuild;
    Date.now = originalNow;
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("refresh caches the response after creating the sidecar", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-sessions-refresh-cache-"));
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  await fs.promises.mkdir(trackerDir, { recursive: true });
  const originalHome = os.homedir;
  const originalBuild = sessionAnalytics.buildSessionAnalytics;
  let buildCalls = 0;
  os.homedir = () => tmp;
  sessionAnalytics.buildSessionAnalytics = async () => {
    buildCalls += 1;
    if (buildCalls === 1) {
      await fs.promises.writeFile(path.join(trackerDir, "session.queue.jsonl"), "");
    }
    return [];
  };
  try {
    const handler = createLocalApiHandler({ queuePath: path.join(tmp, "queue.jsonl") });
    const endpoint = "/functions/tokentracker-sessions?from=&to=&tz=UTC";
    await callEndpoint(handler, `${endpoint}&refresh=1`);
    await callEndpoint(handler, endpoint);
    assert.equal(buildCalls, 1, "a post-build sidecar key should populate the cache");
  } finally {
    os.homedir = originalHome;
    sessionAnalytics.buildSessionAnalytics = originalBuild;
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("include_buckets is part of the response cache key and omits usage buckets", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-sessions-buckets-cache-"));
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  await fs.promises.mkdir(trackerDir, { recursive: true });
  await fs.promises.writeFile(path.join(trackerDir, "session.queue.jsonl"), "");
  const originalHome = os.homedir;
  const originalBuild = sessionAnalytics.buildSessionAnalytics;
  let buildCalls = 0;
  const row = {
    session_hash: "bucket-row",
    session_id: "bucket-row-id",
    source: "claude",
    project_key: "project",
    project_ref: "/project",
    model: "model",
    started_at: "2026-07-18T01:00:00Z",
    ended_at: "2026-07-18T02:00:00Z",
    tokens: { input_tokens: 3, total_tokens: 3 },
    total_tokens: 3,
    cost_usd: 0,
    model_usage: [{ model: "model", input_tokens: 3, total_tokens: 3, cost_usd: 0 }],
    usage_buckets: [{ timestamp: "2026-07-18T01:10:00Z", model: "model", input_tokens: 3, total_tokens: 3, cost_usd: 0 }],
  };
  os.homedir = () => tmp;
  sessionAnalytics.buildSessionAnalytics = async () => {
    buildCalls += 1;
    return [row];
  };
  try {
    const handler = createLocalApiHandler({ queuePath: path.join(tmp, "queue.jsonl") });
    const endpoint = "/functions/tokentracker-sessions?from=2026-07-18&to=2026-07-18&tz=UTC";
    const full = await callEndpoint(handler, endpoint);
    assert.equal(full.sessions[0].usage_buckets.length, 1);
    const summary = await callEndpoint(handler, `${endpoint}&include_buckets=0`);
    assert.equal(Object.hasOwn(summary.sessions[0], "usage_buckets"), false);
    const summaryAgain = await callEndpoint(handler, `${endpoint}&include_buckets=0`);
    assert.equal(Object.hasOwn(summaryAgain.sessions[0], "usage_buckets"), false);
    assert.equal(buildCalls, 2, "the bucket-less response should have its own cache entry");
  } finally {
    os.homedir = originalHome;
    sessionAnalytics.buildSessionAnalytics = originalBuild;
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("include_model_detail is part of the response cache key and projects model rows", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-sessions-model-detail-"));
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  await fs.promises.mkdir(trackerDir, { recursive: true });
  await fs.promises.writeFile(path.join(trackerDir, "session.queue.jsonl"), "");
  const originalHome = os.homedir;
  const originalBuild = sessionAnalytics.buildSessionAnalytics;
  let buildCalls = 0;
  const row = {
    session_hash: "dense-row",
    session_id: "dense-row-id",
    source: "claude",
    project_key: "project",
    project_ref: "/project",
    model: "model",
    started_at: "2026-07-18T01:00:00Z",
    ended_at: "2026-07-18T02:00:00Z",
    tokens: { input_tokens: 3, total_tokens: 3 },
    total_tokens: 3,
    cost_usd: 0,
    model_usage: [{
      model: "model",
      total_tokens: 3,
      cost_usd: 0,
      performance: { estimated_tokens_per_second: 1 },
      pricing: { status: "priced", input: 1, output: 2, cache_read: 0, cache_write: 0, source: "curated" },
      input_tokens: 3,
      output_tokens: 0,
      usage_events: 1,
    }],
  };
  os.homedir = () => tmp;
  sessionAnalytics.buildSessionAnalytics = async () => {
    buildCalls += 1;
    return [row];
  };
  try {
    const handler = createLocalApiHandler({ queuePath: path.join(tmp, "queue.jsonl") });
    const endpoint = "/functions/tokentracker-sessions?from=2026-07-18&to=2026-07-18&tz=UTC&include_buckets=0";
    const full = await callEndpoint(handler, endpoint);
    assert.equal(full.sessions[0].model_usage[0].input_tokens, 3);
    const slim = await callEndpoint(handler, `${endpoint}&include_model_detail=0`);
    const slimKeys = Object.keys(slim.sessions[0].model_usage[0]).sort();
    // The list keeps exactly the fields the page renders and drops the rest.
    assert.deepEqual(slimKeys, ["cost_usd", "model", "performance", "pricing", "total_tokens"]);
    assert.equal(slim.sessions[0].input_tokens, 3, "session-level counters stay for the detail modal");
    const slimAgain = await callEndpoint(handler, `${endpoint}&include_model_detail=0`);
    assert.deepEqual(Object.keys(slimAgain.sessions[0].model_usage[0]).sort(), slimKeys);
    assert.equal(buildCalls, 2, "the projected response should have its own cache entry");
  } finally {
    os.homedir = originalHome;
    sessionAnalytics.buildSessionAnalytics = originalBuild;
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});
