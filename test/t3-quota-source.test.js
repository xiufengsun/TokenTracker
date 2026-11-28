const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { test } = require("node:test");
const { createLocalApiHandler } = require("../src/lib/local-api");
const { buildT3QuotaResponse } = require("../src/lib/t3-quota-source");
const { resolveKimiProfile } = require("../src/lib/kimi-profile");
const { resetUsageLimitsCache } = require("../src/lib/usage-limits");

test("quota v1 projects only fresh windows and preserves a measured zero", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  const kimi = {
    configured: true,
    provenance: { captured_at: new Date(now).toISOString() },
    primary_window: { used_percent: 0, reset_at: "2026-11-28T12:00:00Z" },
    secondary_window: { used_percent: 82, reset_at: "2026-11-27T11:00:00Z" },
    tertiary_window: { used_percent: null },
  };
  assert.deepEqual(buildT3QuotaResponse(kimi, "work-kimi", now), {
    version: 1,
    accounts: [{
      id: "kimi", label: "Kimi Coding (Token Tracker)", providerInstanceId: "work-kimi",
      windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 0, resetsAt: "2026-11-28T12:00:00.000Z" }],
    }],
  });
  assert.equal(buildT3QuotaResponse({ ...kimi, stale: true }, null, now), null);
  assert.equal(buildT3QuotaResponse(kimi, null, now + 181_000), null);
});

test("the loopback API requires opt-in and reads only Kimi with a scoped bearer", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-quota-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => root);
  const token = randomBytes(32).toString("hex");
  const vars = {
    TOKENTRACKER_T3_QUOTA_TOKEN: token,
    TOKENTRACKER_T3_QUOTA_INSTANCE: "work-kimi",
    KIMI_HOME: root,
    KIMI_CODE_BASE_URL: "https://api.kimi.com/coding/v1",
    KIMI_CODE_OAUTH_HOST: "https://auth.kimi.com",
  };
  const options = { queuePath: path.join(root, "queue.jsonl"), trackerDataDir: root };
  const original = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.TOKENTRACKER_T3_QUOTA_TOKEN;
  let handler = createLocalApiHandler(options);
  Object.assign(process.env, vars);
  const { credsPath } = resolveKimiProfile({ home: root, env: process.env });
  await fs.mkdir(path.dirname(credsPath), { recursive: true });
  await fs.writeFile(credsPath, JSON.stringify({ access_token: "fixture" }));
  await fs.writeFile(path.join(root, "config.toml"), "");
  const actualFetch = globalThis.fetch;
  const calls = [];
  let timesOut = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    if (timesOut) throw new Error("Provider request timed out");
    return Response.json({ usage: { limit: 100, used: 72 } });
  });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://127.0.0.1")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/functions/tokentracker-t3-quota`;
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await actualFetch(url, { headers })).status, 404);
  handler = createLocalApiHandler(options);
  assert.equal((await actualFetch(url, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await actualFetch(url, { headers, method: "POST" })).status, 405);
  assert.deepEqual(calls, []);
  const response = await actualFetch(url, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const report = await response.json();
  assert.equal(report.accounts[0].providerInstanceId, "work-kimi");
  assert.equal(report.accounts[0].windows[0].usedPercent, 72);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/api\.kimi\.(com|ai)\//);
  resetUsageLimitsCache();
  timesOut = true;
  const unavailable = await actualFetch(url, { headers });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "Fresh Kimi quota unavailable" });
});
