const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { functionUrlFor, fetchFunctionResponse } = require("../src/lib/function-url");
const { fetchAccountFunction } = require("../src/lib/cloud-account");

const api = "https://srctyff5.us-east.insforge.app";
const direct = "https://srctyff5.function2.insforge.app";

test("only the verified production API sends functions to the direct deployment", () => {
  assert.equal(functionUrlFor(api, "tokentracker-ingest"), `${direct}/tokentracker-ingest`);
  assert.equal(functionUrlFor(`${api}/`, "tokentracker-account-summary"), `${direct}/tokentracker-account-summary`);
  for (const custom of [
    "http://localhost:7130", "https://custom.example/api", "https://other123.us-east.insforge.app",
    "https://srctyff5.us-east.insforge.app.evil.example", `${api}:443`, `${api}/custom`,
    "http://srctyff5.us-east.insforge.app", "https://user@srctyff5.us-east.insforge.app",
  ]) {
    assert.equal(functionUrlFor(custom, "tokentracker-ingest"), `${custom}/functions/tokentracker-ingest`);
  }
});

test("browser and CLI route derivation agree for production and custom backends", () => {
  const source = fs.readFileSync(path.join(__dirname, "../dashboard/src/lib/function-url.ts"), "utf8");
  const code = source.slice(0, source.indexOf("export async function fetchFunctionResponse"))
    .replace("export function", "function").replace("baseUrl: string, slug: string", "baseUrl, slug");
  const browserUrlFor = vm.runInNewContext(`${code}\nfunctionUrlFor;`);
  for (const base of [api, `${api}/`, "http://localhost:7130", "https://custom.example/api", "https://other123.us-east.insforge.app", `${api}/other`, `${api}.evil.example`, "https://user@srctyff5.us-east.insforge.app"]) {
    assert.equal(browserUrlFor(base, "tokentracker-ingest"), functionUrlFor(base, "tokentracker-ingest"));
  }
});

test("a direct GET 404 falls back once with the same query and authentication", async () => {
  const calls = [];
  const init = { method: "GET", headers: { Authorization: "Bearer fixture", apikey: "public" } };
  const res = await fetchFunctionResponse(`${direct}/tokentracker-account-summary?from=2026-10-01&to=2026-10-02`, init,
    async (url, options) => { calls.push([url, options]); return { status: calls.length === 1 ? 404 : 200 }; });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map(([url]) => url), [
    `${direct}/tokentracker-account-summary?from=2026-10-01&to=2026-10-02`,
    `${api}/functions/tokentracker-account-summary?from=2026-10-01&to=2026-10-02`,
  ]);
  assert.equal(calls[0][1], init);
  assert.equal(calls[1][1], init);
});

test("POST failures never replay a mutation, and failed GETs do not conceal auth or server errors", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    for (const status of [404, 401, 429, 500, 502]) {
      let calls = 0;
      await fetchFunctionResponse(`${direct}/tokentracker-ingest`, { method }, async () => { calls++; return { status }; });
      assert.equal(calls, 1, `${method} ${status} must not be retried`);
    }
  }
  for (const status of [401, 403, 429, 500, 502]) {
    let calls = 0;
    await fetchFunctionResponse(`${direct}/tokentracker-account-summary`, {}, async () => { calls++; return { status }; });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(fetchFunctionResponse(`${direct}/tokentracker-ingest`, { method: "POST" }, async () => { calls++; throw new Error("timeout"); }), /timeout/);
  assert.equal(calls, 1);
});

test("a custom backend never falls back to production", async () => {
  const calls = [];
  await fetchFunctionResponse("https://custom.example/functions/one", {}, async (url) => { calls.push(url); return { status: 404 }; });
  assert.deepEqual(calls, ["https://custom.example/functions/one"]);
});

test("cloud account reads retain all parameters and credentials on the direct URL", async () => {
  let observed;
  const result = await fetchAccountFunction({
    baseUrl: api, anonKey: "public", accessToken: "fixture-token", slug: "tokentracker-account-summary",
    searchParams: new URLSearchParams("from=2026-10-01&to=2026-10-02&tz=Asia%2FSingapore&device_id=sample&account=1&refresh=1"),
    fetchImpl: async (url, init) => { observed = { url: new URL(url), init }; return { status: 200, ok: true, json: async () => ({ totals: { total_tokens: 7 } }) }; },
  });
  assert.equal(observed.url.origin, direct);
  assert.equal(observed.url.pathname, "/tokentracker-account-summary");
  assert.equal(observed.url.searchParams.get("tz"), "Asia/Singapore");
  assert.equal(observed.url.searchParams.get("device_id"), "sample");
  assert.equal(observed.url.searchParams.has("refresh"), false);
  assert.equal(observed.init.headers.Authorization, "Bearer fixture-token");
  assert.deepEqual(result, { totals: { total_tokens: 7 } });
});
