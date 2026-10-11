const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { transformSync } = require("esbuild");

function fixture(client) {
  const source = fs.readFileSync(path.resolve(__dirname, "../dashboard/edge-patches/tokentracker-leaderboard-refresh.ts"), "utf8")
    .replace('import { createClient } from "npm:@insforge/sdk";', "const createClient = () => __fixtureClient;");
  const compiled = transformSync(source, { loader: "ts", format: "cjs", target: "node20" }).code;
  const module = { exports: {} };
  const env = { INSFORGE_BASE_URL: "https://backend.test", INSFORGE_SERVICE_ROLE_KEY: "fixture-service",
    LEADERBOARD_REFRESH_SECRET: "fixture-refresh", LEADERBOARD_BLOCKED_USER_IDS: "11111111-1111-4111-8111-111111111111" };
  const context = vm.createContext({ module, exports: module.exports, __fixtureClient: client,
    Deno: { env: { get: name => env[name] } }, Request, Response, URL, TextEncoder, TextDecoder, Error,
    crypto: require("node:crypto").webcrypto, atob, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(compiled, context);
  return module.exports.default;
}

for (const stage of ["anomaly-summary", "quarantine-audit", "scan-summary"]) {
  for (const kind of ["error", "unknown"]) {
    test(`${stage} failure returns a fixed error without serializing ${kind} details`, async () => {
      let stringified = false;
      const privateDetail = "private-database-details\nError: hidden-stack-at-private-file";
      const error = kind === "error" ? new Error(privateDetail) : { toString() { stringified = true; return privateDetail; } };
      const fail = () => { throw error; };
      const handler = fixture({ database: { from: fail, rpc: async name => {
        if (name === "detect_leaderboard_anomalies") return { data: [{}], error: null };
        return fail();
      } } });
      const scan = stage === "scan-summary";
      const request = new Request("https://backend.test/refresh" + (stage === "anomaly-summary" ? "?anomalies=1" : stage === "quarantine-audit" ? "?quarantine_audit=1" : ""),
        scan ? { method: "POST", headers: { "Content-Type": "application/json", "x-refresh-secret": "fixture-refresh" },
          body: JSON.stringify({ scan_anomalies: true }) } : {});
      const response = await handler(request);
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("Content-Type"), "application/json");
      const body = await response.json();
      assert.deepEqual(body, { error: stage === "anomaly-summary" ? "Failed to fetch anomaly queue summary"
        : stage === "quarantine-audit" ? "Failed to fetch quarantine audit" : "Failed to summarize anomaly scan" });
      assert.equal(stringified, false);
      assert.ok(!JSON.stringify(body).includes("private-database-details"));
    });
  }
}

test("error response hardening keeps unauthenticated refresh writes rejected before database access", async () => {
  const handler = fixture({ database: { from() { throw new Error("Unexpected read"); }, rpc() { throw new Error("Unexpected write"); } } });
  const response = await handler(new Request("https://backend.test/refresh", { method: "POST", body: "{}" }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});
