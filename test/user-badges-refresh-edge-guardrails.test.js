const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const http = require("node:http");
const { once } = require("node:events");
const { transformSync } = require("esbuild");

const edgePath = path.join(
  __dirname,
  "..",
  "dashboard",
  "edge-patches",
  "tokentracker-user-badges-refresh.ts",
);
const edge = fs.readFileSync(edgePath, "utf8");
const codeBody = edge.replace(/^\/\*[\s\S]*?\*\//, "");

test("user-badges refresh edge requires privileged auth before database access", () => {
  assert.match(codeBody, /authorizePrivileged/);
  assert.match(codeBody, /LEADERBOARD_REFRESH_SECRET/);
  assert.match(codeBody, /x-refresh-secret/);
  assert.match(codeBody, /INSFORGE_SERVICE_ROLE_KEY/);
  assert.match(
    codeBody,
    /if \(!authorizePrivileged\(req\)\) return json\(\{ error: "Unauthorized" \}, 401\)/,
  );
  const authCheck = codeBody.indexOf("authorizePrivileged(req)");
  const rpcCall = codeBody.indexOf("await fetch(");
  assert.notEqual(authCheck, -1);
  assert.notEqual(rpcCall, -1);
  assert.ok(authCheck < rpcCall, "auth gate must precede user_badges_refresh RPC");
});

test("refresh bypasses the backend 10s RPC proxy without unrestricted SQL or SDK", () => {
  assert.doesNotMatch(codeBody, /createClient|database\.rpc\(|\/rawsql\/unrestricted/);
  assert.match(codeBody, /\/api\/database\/advance\/rawsql/);
  assert.match(codeBody, /SELECT public\.user_badges_refresh\(\) AS result/);
});

test("user-badges refresh edge rejects non-POST and has no signed-in write path", () => {
  assert.match(codeBody, /req\.method !== "POST"/);
  assert.doesNotMatch(codeBody, /verifiedClaimsFromJwt/);
  assert.doesNotMatch(codeBody, /RefreshAuthorization/);
});

const compiled = transformSync(edge, { loader: "ts", format: "cjs", target: "node20" }).code;
function fixture({ env = {}, request = async () => Response.json({ rows: [{ result: "36000" }] }), timeout } = {}) {
  const settings = { INSFORGE_BASE_URL: "https://backend.test/", INSFORGE_SERVICE_ROLE_KEY: "test-service",
    LEADERBOARD_REFRESH_SECRET: "test-refresh", ...env };
  const calls = [], logs = [], budgets = [];
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Request, Response, TextEncoder, Date,
    Deno: { env: { get: name => settings[name] } },
    AbortSignal: { timeout(ms) { budgets.push(ms); return timeout ? timeout(ms) : AbortSignal.timeout(ms); } },
    fetch: async (...args) => { calls.push(args); return request(...args); },
    console: { log: entry => logs.push(JSON.parse(entry)) },
  });
  return { handler: module.exports.default, calls, logs, budgets };
}
function invoke(f, headers = { "x-refresh-secret": "test-refresh" }, method = "POST", body) {
  return f.handler(new Request("https://edge.test/refresh?query=DROP%20TABLE", { method, headers, body }));
}

test("anonymous, signed-in, wrong-secret and malformed bearer callers cannot write", async () => {
  for (const headers of [{}, { Authorization: "Bearer signed-in-user" }, { "x-refresh-secret": "wrong" },
    { apikey: "test-service" }, { Authorization: "test-service" }]) {
    const f = fixture();
    assert.equal((await invoke(f, headers)).status, 401);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ env: { LEADERBOARD_REFRESH_SECRET: undefined, INSFORGE_SERVICE_ROLE_KEY: undefined } });
  assert.equal((await invoke(f)).status, 401);
  assert.equal(f.calls.length, 0);
});

test("OPTIONS and non-POST requests never reach the database", async () => {
  const f = fixture();
  for (const [method, status] of [["OPTIONS", 204], ["GET", 405], ["PUT", 405], ["DELETE", 405]]) {
    const response = await invoke(f, undefined, method);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  }
  assert.equal(f.calls.length, 0);
});

test("both privileged paths send only the server credential and fixed SQL with a 110s abort signal", async () => {
  for (const headers of [{ "x-refresh-secret": "test-refresh", Authorization: "Bearer caller", apikey: "untrusted" },
    { Authorization: "bEaReR test-service", "x-api-key": "untrusted" }]) {
    const f = fixture();
    const response = await invoke(f, headers, "POST", '{"query":"DROP TABLE tokentracker_user_badges"}');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.result, 36000);
    assert.ok(body.ms >= 0);
    assert.equal(f.calls.length, 1);
    const [url, options] = f.calls[0];
    assert.equal(url, "https://backend.test/api/database/advance/rawsql");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.deepEqual({ ...options.headers }, { Authorization: "Bearer test-service", "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(options.body), { query: "SELECT public.user_badges_refresh() AS result" });
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(f.budgets, [110_000]);
    assert.deepEqual(f.logs.map(l => l.event), ["start", "ok"]);
  }
});

test("missing server configuration fails closed before fetch", async () => {
  for (const key of ["INSFORGE_BASE_URL", "INSFORGE_SERVICE_ROLE_KEY"]) {
    const f = fixture({ env: { [key]: undefined } });
    assert.equal((await invoke(f)).status, 500);
    assert.equal(f.calls.length, 0);
  }
});

test("a zero-row claim skip remains a valid result", async () => {
  const f = fixture({ request: async () => Response.json({ rows: [{ result: "0" }] }) });
  assert.equal((await (await invoke(f)).json()).result, 0);
});

test("HTTP, network and malformed success responses fail without leaking details or retrying", async () => {
  const privateDetail = "test-service private SQL or stack";
  const failures = [
    async () => new Response(privateDetail, { status: 500 }),
    async () => new Response("<html>Bad gateway</html>", { status: 502 }),
    async () => { throw new Error(privateDetail); },
    async () => new Response("not JSON"),
    ...[null, {}, { rows: [] }, { rows: [{ result: null }] }, { rows: [{ result: "" }] },
      { rows: [{ result: -1 }] }, { rows: [{ result: "9007199254740993" }] },
      { rows: [{ result: "12garbage" }] }, { rows: [{ result: 1 }, { result: 2 }] }]
      .map(payload => async () => Response.json(payload)),
  ];
  for (const request of failures) {
    const f = fixture({ request });
    const response = await invoke(f);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, error: "user_badges_refresh failed" });
    assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(f.logs).includes(privateDetail));
    assert.equal(f.logs.at(-1).event, "error");
  }
});

test("abort while fetching headers or consuming the body returns a bounded 504", async () => {
  for (const duringBody of [false, true]) {
    const controller = new AbortController();
    const f = fixture({ timeout: () => controller.signal, request: async () => {
      const fail = () => { controller.abort(); throw new Error("private transport failure"); };
      return duringBody ? { ok: true, json: fail } : fail();
    } });
    const response = await invoke(f);
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { ok: false, error: "user_badges_refresh timed out" });
    assert.equal(f.calls.length, 1);
  }
});

test("a real HTTP response beyond ten seconds completes successfully", { timeout: 20_000 }, async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/api/database/advance/rawsql");
    assert.equal(req.headers.authorization, "Bearer test-service");
    setTimeout(() => { res.setHeader("Content-Type", "application/json"); res.end('{"rows":[{"result":"36000"}]}'); }, 10_100);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const f = fixture({ env: { INSFORGE_BASE_URL: `http://127.0.0.1:${server.address().port}` }, request: fetch });
  const response = await invoke(f);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result, 36000);
  assert.ok(body.ms >= 10_000);
});
