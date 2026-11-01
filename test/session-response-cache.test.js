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
