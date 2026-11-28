"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createLocalApiHandler } = require("../src/lib/local-api");
const { fetchCustomCreditLimits, saveConfig, readCreditLimitsConfig } = require("../src/lib/custom-credits");
const { getUsageLimits, resetUsageLimitsCache, USAGE_LIMITS_PROVIDER_IDS } = require("../src/lib/usage-limits");

const config = { gatewayBaseUrl: "https://gateway.example/api/v1/", apiKey: "test-key-one", dailyCreditLimit: 150 };
const slots = ["primary_window", "secondary_window", "tertiary_window"];

function tempDir(t) {
  const trackerDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-custom-credit-"));
  t.after(() => fs.rmSync(trackerDir, { recursive: true, force: true }));
  return trackerDir;
}

const nowMs = Date.parse("2024-02-29T15:59:00Z"); // Thursday in the billing time zone.

test("reports three UTC+8 calendar periods, measured zero, explicit caps, and overage", async (t) => {
  const trackerDir = tempDir(t);
  saveConfig({ trackerDir }, { ...config, weeklyCreditLimit: 800, displayName: "Team" });
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer test-key-one");
    if (new URL(url).pathname.endsWith("/daily-credit")) return new Response(null, { status: 404 });
    assert.equal(new URL(url).pathname, "/api/v1/usage/by-model");
    const window = new URL(url).searchParams.get("window");
    calls.push(window);
    const data = { today: [], week: [{ credit: 300 }, { credit: 500.25 }], month: [{ credit: 2900 }] }[window];
    return Response.json({ window, data });
  };
  resetUsageLimitsCache();
  t.after(() => resetUsageLimitsCache());
  const hidden = USAGE_LIMITS_PROVIDER_IDS.filter((id) => id !== "customCredits");
  const { customCredits } = await getUsageLimits({
    trackerDir, home: trackerDir, hiddenProviders: hidden, nowMs, fetchImpl,
  });
  assert.deepEqual(calls.sort(), ["month", "today", "week"]);
  assert.equal(customCredits.plan_label, "Team");
  assert.deepEqual(slots.map((s) => customCredits[s].reset_at), [
    "2024-02-29T16:00:00.000Z", "2024-03-03T16:00:00.000Z", "2024-02-29T16:00:00.000Z",
  ]);
  assert.deepEqual(slots.map((s) => customCredits[s].limit_window_seconds), [1, 7, 29].map((d) => 86400 * d));
  assert.deepEqual(slots.map((s) => customCredits[s].limit_credits), [150, 800, 4350]);
  assert.deepEqual(slots.map((s) => customCredits[s].derived_limit), [false, false, true]);
  assert.deepEqual(slots.map((s) => customCredits[s].used_credits), [0, 800.25, 2900]);
  assert.equal(customCredits.secondary_window.used_percent, 100);
  assert.equal(customCredits.secondary_window.remaining_credits, 0);
  assert.deepEqual(customCredits.daily_history, [{ date: "2024-02-29", source: "reported", used_credits: 0 }]);

  calls.length = 0;
  const hiddenRead = await getUsageLimits({ trackerDir, home: trackerDir, hiddenProviders: [...hidden, "customCredits"], fetchImpl });
  assert.deepEqual(hiddenRead.customCredits, { configured: false });
  assert.deepEqual(calls, []);
});

test("keeps other windows on partial data, rejects missing prices, invalid totals and wrong window replies", async (t) => {
  const trackerDir = tempDir(t);
  saveConfig({ trackerDir }, config);
  const fetchImpl = async (url) => {
    const window = new URL(url).searchParams.get("window");
    if (window === "today") return Response.json({ window, data: [{ credit: null, total_tokens: 0 }, { credit: 1 }] });
    if (window === "week") return Response.json({ window, data: [{ credit: 12 }, { credit: null, total_tokens: 1 }] });
    return new Response(null, { status: 503 });
  };
  const result = await fetchCustomCreditLimits({ trackerDir, nowMs, fetchImpl });
  assert.equal(result.primary_window.used_credits, 1);
  assert.equal(result.secondary_window, null);
  assert.equal(result.tertiary_window, null);
  assert.equal(result.error, null);
  for (const body of [
    { window: "unknown", data: [] }, { window: "today", data: null },
    { window: "today", data: [{}] }, { window: "today", data: [{ credit: -2 }] },
    { window: "today", data: [], mock: true },
  ]) {
    const failed = await fetchCustomCreditLimits({ trackerDir, nowMs, fetchImpl: async () => Response.json(body) });
    slots.forEach((slot) => assert.equal(failed[slot], null));
    assert.ok(failed.error);
    assert.deepEqual(failed.daily_history, []);
  }
});

test("history prefers reported days and weights each estimated input, cache and output component independently", async (t) => {
  const trackerDir = tempDir(t);
  saveConfig({ trackerDir }, config);
  const sample = (date, req_tokens, cached_tokens, rsp_tokens) => ({ date, req_tokens, cached_tokens, rsp_tokens });
  const weekly = {
    credit: 110, credit_breakdown: { input: 40, cached: 10, output: 60 },
    daily: [
      sample("2024-02-26", 4, 0, 0), sample("2024-02-27", 2, 2, 1),
      sample("2024-02-28", 0, 0, 1), sample("2024-02-29", 0, 0, 0),
    ],
  };
  const monthly = { credit: 200, daily: [
    { date: "2024-02-26", credit: 39 }, { date: "2024-02-28", credit: null }, { date: "2024-02-29", credit: 2 },
  ] };
  const fetchImpl = async (url) => {
    const window = new URL(url).searchParams.get("window");
    if (!window) return new Response(null, { status: 404 });
    const data = window === "today" ? [{ credit: 4 }] : [window === "week" ? weekly : monthly];
    return Response.json({ window, data });
  };
  const result = await fetchCustomCreditLimits({ trackerDir, nowMs, fetchImpl });
  assert.deepEqual(result.daily_history, [
    { date: "2024-02-26", used_credits: 39, source: "reported" },
    { date: "2024-02-27", used_credits: 40, source: "estimated" },
    { date: "2024-02-28", used_credits: 30, source: "estimated" },
    { date: "2024-02-29", used_credits: 4, source: "reported" },
  ]);
  assert.equal(result.secondary_window.derived_limit, true);
  assert.equal(result.secondary_window.limit_credits, 1050);
  weekly.daily.pop();
  const incomplete = await fetchCustomCreditLimits({ trackerDir, nowMs, fetchImpl });
  assert.deepEqual(incomplete.daily_history.map((row) => row.date), ["2024-02-26", "2024-02-29"]);
});

test("recovers a failed daily quota from complete billed model-days and rejects partial or estimated data", async (t) => {
  const trackerDir = tempDir(t);
  saveConfig({ trackerDir }, config);
  let reports = [
    { credit: 20, daily: [{ date: "2024-02-29", credit: 3 }] },
    { credit: 15, daily: [{ date: "2024-02-29", credit: 1.25 }] },
  ];
  const fetchImpl = async (url) => {
    const window = new URL(url).searchParams.get("window");
    if (window === "today") return new Response(null, { status: 500 });
    if (window) return Response.json({ window, data: reports });
    return Response.json({ data: [{ date: "2024-02-29", credit: 4.25 }] });
  };
  const read = () => fetchCustomCreditLimits({ trackerDir, nowMs, fetchImpl });
  const complete = await read();
  assert.equal(complete.primary_window.used_credits, 4.25);
  assert.equal(complete.primary_window.limit_credits, 150);
  assert.equal(complete.primary_window.reset_at, "2024-02-29T16:00:00.000Z");
  reports[1].daily = [];
  assert.equal((await read()).primary_window, null);
  reports[1].daily = [{ date: "2024-02-29", credit: null, total_tokens: 1 }];
  assert.equal((await read()).primary_window, null);
  reports = [{
    credit: 8, credit_breakdown: { input: 8, cached: 0, output: 0 },
    daily: ["26", "27", "28", "29"].map((date) => ({
      date: "2024-02-" + date, req_tokens: 1, cached_tokens: 0, rsp_tokens: 0,
    })),
  }];
  assert.equal((await read()).primary_window, null);
});

test("prefers billed cross-month history, distinguishes unknown from zero and flags known unpriced traffic", async (t) => {
  const trackerDir = tempDir(t);
  saveConfig({ trackerDir }, config);
  const fetchImpl = async (url) => {
    const query = new URL(url);
    if (query.pathname.endsWith("/daily-credit")) {
      assert.equal(query.searchParams.get("days"), "31");
      return Response.json({ data: [
        { date: "2024-01-31", credit: 19 }, { date: "2024-02-01", credit: 0 },
        { date: "2024-02-28", credit: null }, { date: "2024-02-29", credit: 4.75 },
      ] });
    }
    const window = query.searchParams.get("window");
    const data = window === "today" ? [{ credit: null, total_tokens: 5 }] : [
      { credit: 20, daily: [{ date: "2024-02-28", credit: 5 }, { date: "2024-02-29", credit: null, total_tokens: 1 }] },
    ];
    return Response.json({ window, data });
  };
  const result = await fetchCustomCreditLimits({ trackerDir, nowMs, fetchImpl });
  assert.deepEqual(result.daily_history, [
    { date: "2024-01-31", used_credits: 19, source: "reported" },
    { date: "2024-02-01", used_credits: 0, source: "reported" },
    { date: "2024-02-29", used_credits: 4.75, source: "reported", partial: true },
  ]);
  slots.forEach((slot) => assert.equal(result[slot], null));
});

test("assigns a process-local cache revision even when a key rotates back to an earlier value", (t) => {
  const options = { trackerDir: tempDir(t) };
  saveConfig(options, config);
  const before = readCreditLimitsConfig(options).revision;
  assert.equal(readCreditLimitsConfig(options).revision, before);
  saveConfig(options, { ...config, apiKey: "test-key-two" });
  const after = readCreditLimitsConfig(options).revision;
  assert.notEqual(after, before);
  saveConfig(options, config);
  const restored = readCreditLimitsConfig(options).revision;
  assert.notEqual(restored, before);
  assert.notEqual(restored, after);
});

test("an account change bypasses old cached and in-flight custom data even from another process", async (t) => {
  const trackerDir = tempDir(t);
  resetUsageLimitsCache();
  t.after(() => resetUsageLimitsCache());
  saveConfig({ trackerDir }, config);
  let finishOld, oldRequest;
  const waiting = new Promise((resolve) => { finishOld = resolve; });
  const started = new Promise((resolve) => { oldRequest = resolve; });
  const options = {
    trackerDir, home: trackerDir, nowMs, hiddenProviders: USAGE_LIMITS_PROVIDER_IDS.filter((id) => id !== "customCredits"),
    async fetchImpl(url, init) {
      const old = init.headers.Authorization.endsWith(config.apiKey);
      if (old) { oldRequest(); await waiting; }
      const window = new URL(url).searchParams.get("window");
      if (window) return Response.json({ window, data: [{ credit: old ? 11 : 12 }] });
      return Response.json({ data: [{ date: "2024-02-29", credit: old ? 11 : 12 }] });
    },
  };
  const oldFetch = getUsageLimits(options);
  await started;
  saveConfig({ trackerDir }, { ...config, apiKey: "second-account-key" });
  try {
    assert.equal((await getUsageLimits(options)).customCredits.daily_history[0].used_credits, 12);
  } finally { finishOld(); }
  assert.equal((await oldFetch).customCredits.daily_history[0].used_credits, 11);
  assert.equal((await getUsageLimits(options)).customCredits.daily_history[0].used_credits, 12);
  assert.deepEqual((await getUsageLimits({ ...options, allowCustomCredits: false, fetchImpl: assert.fail })).customCredits, { configured: false });
});

test("local-auth settings hide the key, bind retained secrets to the full base URL, and disconnect", async (t) => {
  const trackerDir = tempDir(t);
  const handler = createLocalApiHandler({ trackerDataDir: trackerDir, queuePath: path.join(trackerDir, "queue.jsonl") });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://localhost")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const token = (await (await fetch(base + "/api/local-auth")).json()).token;
  const endpoint = base + "/functions/tokentracker-custom-credits-config";
  const call = (method, input, headers = {}) => fetch(endpoint, {
    method, headers: { "x-tokentracker-local-auth": token, ...headers }, body: input ? JSON.stringify(input) : null,
  });
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await fetch(endpoint, { method })).status, 401);
  assert.equal((await call("PUT", config, { origin: "https://elsewhere.example" })).status, 401);
  assert.equal((await call("GET").then((res) => res.json())).hasApiKey, false);
  assert.deepEqual(await fetchCustomCreditLimits({ trackerDir, fetchImpl: assert.fail }), { configured: false });
  const saved = await call("PUT", config);
  assert.equal(saved.status, 200);
  const publicSettings = await saved.json();
  assert.equal(publicSettings.hasApiKey, true);
  assert.equal(publicSettings.gatewayBaseUrl, "https://gateway.example/api");
  assert.ok(!JSON.stringify(publicSettings).includes(config.apiKey));
  const file = path.join(trackerDir, "custom-credits.json");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await call("PUT", { ...publicSettings, weeklyCreditLimit: 500 })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(file)).apiKey, config.apiKey);
  const newHost = "https://other.example";
  assert.equal((await call("PUT", { ...publicSettings, gatewayBaseUrl: newHost })).status, 400);
  assert.equal((await call("PUT", { ...publicSettings, gatewayBaseUrl: newHost, apiKey: "new-key-value" })).status, 200);
  for (const gatewayBaseUrl of ["http://nonlocal.example", "https://example.org?secret=value", "file:///tmp/usage", "https://user@host.test"]) {
    assert.equal((await call("PUT", { ...config, gatewayBaseUrl })).status, 400);
  }
  assert.deepEqual(await call("GET").then((r) => r.json()), { ...publicSettings, gatewayBaseUrl: newHost });
  assert.equal((await call("DELETE")).status, 200);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await fetchCustomCreditLimits({ trackerDir, fetchImpl: assert.fail }), { configured: false });
});

test("a canonical base ending in /v1 survives reads, budget edits and key rotation", async (t) => {
  const options = { trackerDir: tempDir(t) };
  const input = { ...config, gatewayBaseUrl: "https://gateway.example/api/v1/v1/" };
  const saved = saveConfig(options, input);
  assert.equal(saved.gatewayBaseUrl, "https://gateway.example/api/v1");
  assert.equal(readCreditLimitsConfig(options).gatewayBaseUrl, saved.gatewayBaseUrl);
  assert.deepEqual(saveConfig(options, { ...saved, weeklyCreditLimit: 1050 }), { ...saved, weeklyCreditLimit: 1050 });
  assert.equal(readCreditLimitsConfig(options).apiKey, input.apiKey);
  const rotated = saveConfig(options, { ...saved, apiKey: "rotated-test-key" });
  assert.equal(rotated.gatewayBaseUrl, saved.gatewayBaseUrl);
  assert.equal(readCreditLimitsConfig(options).apiKey, "rotated-test-key");
  assert.throws(() => saveConfig(options, { ...saved, gatewayBaseUrl: "https://gateway.example/other" }), /key is required/);
  const paths = [];
  await fetchCustomCreditLimits({ ...options, nowMs, fetchImpl: async (url) => {
    paths.push(new URL(url).pathname);
    const window = new URL(url).searchParams.get("window");
    return Response.json({ window, data: [] });
  } });
  assert.deepEqual(new Set(paths), new Set(["/api/v1/v1/usage/by-model", "/api/v1/v1/usage/daily-credit"]));
});

test("retries a UTC+8 month rollover in flight and uses the new day for history, resets and budgets", async (t) => {
  const trackerDir = tempDir(t);
  saveConfig({ trackerDir }, config);
  let clock = Date.parse("2024-02-29T15:59:59.999Z");
  t.mock.method(Date, "now", () => clock);
  let batches = 0;
  const fetchImpl = async (url) => {
    const window = new URL(url).searchParams.get("window");
    if (window === "today") batches++;
    if (!window) {
      clock = Date.parse("2024-02-29T16:00:00.001Z");
      return Response.json({ data: [] });
    }
    return Response.json({ window, data: [{ credit: batches === 1 ? 29 : 3 }] });
  };
  const result = await fetchCustomCreditLimits({ trackerDir, fetchImpl });
  assert.equal(batches, 2);
  assert.equal(result.tertiary_window.limit_credits, 150 * 31);
  assert.equal(result.primary_window.reset_at, "2024-03-01T16:00:00.000Z");
  assert.equal(result.tertiary_window.reset_at, "2024-03-31T16:00:00.000Z");
  assert.equal(result.daily_history_end, "2024-03-01");
  assert.deepEqual(result.daily_history, [{ date: "2024-03-01", used_credits: 3, source: "reported" }]);
});

test("a weekly-only plan requests only its configured window and reports complete coverage", async (t) => {
  const trackerDir = tempDir(t);
  saveConfig({ trackerDir }, { ...config, dailyCreditLimit: null, weeklyCreditLimit: 800 });
  const windows = [];
  const result = await fetchCustomCreditLimits({ trackerDir, nowMs, fetchImpl: async (url) => {
    const window = new URL(url).searchParams.get("window");
    if (window) windows.push(window);
    return Response.json({ window, data: [] });
  } });
  assert.deepEqual(windows, ["week"]);
  assert.equal(result.secondary_window.limit_credits, 800);
  assert.equal(result.partial, false);
  assert.equal(result.daily_history_end, "2024-02-29");
});

test("samples the gateway date after the aggregate's asynchronous credential phase", async (t) => {
  const trackerDir = tempDir(t);
  saveConfig({ trackerDir }, config);
  resetUsageLimitsCache();
  t.after(() => resetUsageLimitsCache());
  let clock = Date.parse("2024-02-29T15:59:59.999Z");
  t.mock.method(Date, "now", () => clock);
  const windows = [];
  const pending = getUsageLimits({
    trackerDir, home: trackerDir,
    hiddenProviders: USAGE_LIMITS_PROVIDER_IDS.filter((id) => id !== "customCredits"),
    fetchImpl: async (url) => {
      const window = new URL(url).searchParams.get("window");
      if (window) windows.push(window);
      return Response.json({ window, data: [] });
    },
  });
  assert.deepEqual(windows, []);
  clock = Date.parse("2024-02-29T16:00:00.001Z");
  const { customCredits } = await pending;
  assert.deepEqual(windows.sort(), ["month", "today", "week"]);
  assert.equal(customCredits.daily_history_end, "2024-03-01");
  assert.equal(customCredits.tertiary_window.limit_credits, 150 * 31);
});
