"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHmac, webcrypto } = require("node:crypto");
const { test } = require("node:test");
const { transformSync } = require("esbuild");

const edgeDir = path.join(__dirname, "..", "dashboard", "edge-patches");
const now = Date.parse("2026-10-03T03:00:00Z");
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}

const names = {
  source_names: [null, "", "codex", "deepseek", "lmstudio", "workbuddy", "unsloth", "pi-copilot"],
  model_names: [null, "", "gpt-6.1-sol", "deepseek-v4-pro", "local/x", "auto", '日本語"', "unpriced/local"],
  pricing_tiers: [null, "", "off_peak", "peak"],
};
const costDims = [
  [null, null, null, "9007199254740993", 2, "3", 0, 0],
  ["", "", "", 1, 2, 3, "0", 0],
  ["codex", "gpt-6.1-sol", "", "1000000", 100000, 3000, 0, 100],
  ["deepseek", "deepseek-v4-pro", "peak", 1000000, 200000, 300000, 0, 0],
  ["deepseek", "deepseek-v4-pro", "off_peak", 1000000, 200000, 300000, 0, 0],
  ["lmstudio", "local/x", null, 10000, 10000, 0, 0, 0],
  ["workbuddy", "auto", null, 123, 45, 67, 0, 0],
  ["unsloth", "unpriced/local", null, 12, 3, 0, 0, 0],
  ["pi-copilot", '日本語"', null, 500, 100, 0, 0, 0],
  ["codex", '日本語"', null, 0, 0, 0, 0, 0],
];
const packedCostDims = [
  [0, 0, 0, "9007199254740993", 2, "3"],
  [1, 1, 1, 1, 2, 3, "0"],
  [2, 2, 1, "1000000", 100000, 3000, 0, 100],
  [3, 3, 3, 1000000, 200000, 300000],
  [3, 3, 2, 1000000, 200000, 300000],
  [4, 4, 0, 10000, 10000],
  [5, 5, 0, 123, 45, 67],
  [6, 7, 0, 12, 3],
  [7, 6, 0, 500, 100],
  [2, 6, 0],
];
const totalKeys = ["total_tokens", "input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "reasoning_output_tokens", "conversation_count", "active_days"];
const totalValues = ["9007199254740993", "1000000", 200000, "3000", 0, "0", 18, 4];
const fixture = {
  summary: {
    old: {
      cost_dims: costDims,
      day_rollup: [["2026-09-30", "9007199254740993", "11"], ["2026-10-01", 120, 2], ["2026-10-02", "340", 3], ["2026-10-03", 0, "0"]],
      range_totals: Object.fromEntries(totalKeys.map((key, index) => [key, totalValues[index]])),
    },
    wire: { ...names, cost_dims: packedCostDims, day_start: "2026-09-30", day_rollup: [[0, "9007199254740993", "11"], [1, 120, 2], [2, "340", 3], [3, 0, "0"]], range_totals: totalValues },
  },
  "model-breakdown": {
    old: costDims.map((row) => [...row.slice(0, 3), "1000000", ...row.slice(3)]),
    wire: { ...names, dims: packedCostDims.map((row) => [...row.slice(0, 3), "1000000", ...row.slice(3)]) },
  },
};

function loadEdge(endpoint, data, { legacy = false, mutation } = {}) {
  let source = fs.readFileSync(path.join(edgeDir, `tokentracker-account-${endpoint}.ts`), "utf8");
  source = source.replace('import { createClient } from "npm:@insforge/sdk";', "const createClient = __createClient;");
  const rpc = endpoint.replaceAll("-", "_");
  const decoder = endpoint === "summary" ? "decodeSummaryWire" : "decodeModelBreakdownWire";
  if (legacy) {
    // Only bypass transport decoding. The unchanged auth, price, timezone,
    // device and output paths run against the previous RPC's original values.
    source = source.replace(`client.database.rpc("account_${rpc}_wire",`, `client.database.rpc("account_${rpc}_compact",`);
    source = source.replace(`const ${endpoint === "summary" ? "value" : "dims"} = ${decoder}(data);`, `const ${endpoint === "summary" ? "value" : "dims"} = data;`);
  }
  if (mutation) source = mutation(source);
  source += `\nexport { ${decoder} as decode };`;
  const code = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" }).code;
  const calls = [];
  const context = {
    module: { exports: {} }, exports: {}, Request, Response, URL, Headers, Date: FixedDate,
    TextEncoder, TextDecoder, Uint8Array, atob, crypto: webcrypto,
    Deno: { env: { get: (name) => ({ INSFORGE_BASE_URL: "https://test.invalid", INSFORGE_SERVICE_ROLE_KEY: "test-service-role", JWT_SECRET: "test-jwt-secret" })[name] } },
    __createClient: () => ({ database: { rpc: async (name, args) => { calls.push({ name, args }); return { data, error: null }; } } }),
  };
  context.exports = context.module.exports;
  vm.runInNewContext(code, context);
  return { ...context.module.exports, calls };
}

function authorization() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "HS256", typ: "JWT" });
  const body = encode({ sub: "00000000-0000-4000-8000-000000000001", exp: now / 1000 + 60 });
  const unsigned = `${head}.${body}`;
  return `Bearer ${unsigned}.${createHmac("sha256", "test-jwt-secret").update(unsigned).digest("base64url")}`;
}
const plain = (value) => JSON.parse(JSON.stringify(value));

for (const endpoint of ["summary", "model-breakdown"]) {
  test(`${endpoint} wire restores types, null/empty dimensions, row order and trailing zeros`, () => {
    const edge = loadEdge(endpoint, null);
    assert.deepEqual(plain(edge.decode(fixture[endpoint].wire)), fixture[endpoint].old);
    assert.deepEqual(plain(edge.decode(fixture[endpoint].old)), fixture[endpoint].old,
      "adaptive legacy fallback must not change any field");
    const mutant = loadEdge(endpoint, null, {
      mutation: (source) => source.replace("index < row.length ? row[index] : 0", "index < row.length ? Number(row[index]) : 0"),
    });
    assert.notDeepEqual(plain(mutant.decode(fixture[endpoint].wire)), fixture[endpoint].old,
      "the precision/type fixture must detect accidental numeric coercion");
    const withNull = plain(fixture[endpoint].wire);
    const expected = plain(fixture[endpoint].old);
    const rows = endpoint === "summary" ? withNull.cost_dims : withNull.dims;
    const oldRows = endpoint === "summary" ? expected.cost_dims : expected;
    rows[0][4] = null;
    oldRows[0][4] = null;
    assert.deepEqual(plain(edge.decode(withNull)), expected, "explicit null slots must not become an omitted zero");
  });

  test(`${endpoint} produces identical full HTTP JSON and request scope after transport decoding`, async () => {
    // The legacy breakdown price matcher requires a non-null source. Keep the
    // nullable-dimension transport check above, and use supported price rows.
    const payload = endpoint === "model-breakdown"
      ? { old: fixture[endpoint].old.slice(1), wire: { ...fixture[endpoint].wire, dims: fixture[endpoint].wire.dims.slice(1) } }
      : fixture[endpoint];
    for (const [zone, offset, device] of [
      ["Asia/Singapore", 480, null],
      ["America/Los_Angeles", -420, "00000000-0000-4000-8000-000000000002"],
      ["", -480, "not-a-device"],
    ]) {
      const edge = loadEdge(endpoint, payload.wire);
      const legacy = loadEdge(endpoint, payload.old, { legacy: true });
      const params = new URLSearchParams({ from: "2020-01-01", to: "2026-10-03", tz: zone, tz_offset_minutes: String(offset) });
      if (device) params.set("device_id", device);
      const req = new Request(`https://test.invalid/?${params}`, { headers: { Authorization: authorization() } });
      const [response, previous] = await Promise.all([edge.default(req), legacy.default(req)]);
      assert.equal(response.status, 200);
      assert.equal(response.status, previous.status);
      assert.deepEqual([...response.headers], [...previous.headers]);
      const result = await response.text();
      assert.equal(result, await previous.text());
      assert.equal(edge.calls[0].name, `account_${endpoint.replaceAll("-", "_")}_wire`);
      assert.deepEqual(plain(edge.calls[0].args), plain(legacy.calls[0].args));
      assert.equal(edge.calls[0].args.p_device_id, device === "not-a-device" ? null : device);
      assert.equal(edge.calls[0].args.p_range_from, "2023-10-04", "the existing 1095-day limit stays in effect");
      assert.equal(edge.calls[0].args.p_tz, zone || null);
      if (endpoint === "summary") {
        const body = JSON.parse(result);
        assert.equal(body.rolling.last_7d.to, zone === "Asia/Singapore" ? "2026-10-03" : "2026-10-02");
        assert.ok(body.rolling.last_7d.active_days > 0);
      } else {
        const body = JSON.parse(result);
        const free = body.sources.find((source) => source.source === "lmstudio");
        assert.equal(free.totals.total_cost_usd, "0.000000");
        const peak = body.sources.find((source) => source.source === "deepseek");
        assert.equal(peak.models.length, 1, "pricing tiers still fold into a single display model");
        assert.ok(Number(peak.totals.total_cost_usd) > 0);
      }
      await edge.default(req);
      assert.equal(edge.calls.length, 1, "the existing 30s cache remains intact");
    }
  });

  test(`${endpoint} empty results and adaptive legacy fallback preserve the full response`, async () => {
    const empty = endpoint === "summary"
      ? { cost_dims: [], day_rollup: [], range_totals: Object.fromEntries(totalKeys.map((key) => [key, 0])) }
      : [];
    const emptyWire = endpoint === "summary"
      ? { source_names: [], model_names: [], pricing_tiers: [], cost_dims: [], day_start: null, day_rollup: [], range_totals: totalKeys.map(() => 0) }
      : { source_names: [], model_names: [], pricing_tiers: [], dims: [] };
    for (const data of [empty, emptyWire]) {
      const edge = loadEdge(endpoint, data);
      const legacy = loadEdge(endpoint, empty, { legacy: true });
      assert.deepEqual(plain(edge.decode(data)), empty);
      const req = new Request("https://test.invalid/?from=2026-10-03&to=2026-10-03", { headers: { Authorization: authorization() } });
      const response = await edge.default(req);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), await (await legacy.default(req)).text());
    }
  });

  test(`${endpoint} rejects unauthenticated and forged JWT reads before its wire RPC`, async () => {
    const edge = loadEdge(endpoint, fixture[endpoint].wire);
    for (const header of [undefined, `${authorization().slice(0, -4)}xxxx`]) {
      const req = new Request("https://test.invalid/?from=2026-10-03&to=2026-10-03", { headers: header ? { Authorization: header } : {} });
      assert.equal((await edge.default(req)).status, 401);
    }
    assert.equal(edge.calls.length, 0);
  });
}

test("summary calendar offsets restore leap days, DST boundaries and a year boundary without timezone arithmetic", () => {
  const edge = loadEdge("summary", null);
  const wire = { ...fixture.summary.wire, day_start: "2024-02-28", day_rollup: [0, 1, 2, 11, 12, 307, 308].map((offset) => [offset, "1", 0]) };
  assert.deepEqual(plain(edge.decode(wire).day_rollup),
    ["2024-02-28", "2024-02-29", "2024-03-01", "2024-03-10", "2024-03-11", "2024-12-31", "2025-01-01"].map((day) => [day, "1", 0]));
});

test("summary/model wire migration only adds invoker wrappers with exact compact delegation and adaptive size choice", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "20261003093000_compact-account-summary-model-wire.sql"), "utf8");
  assert.equal(sql.match(/CREATE OR REPLACE FUNCTION/g).length, 2);
  assert.equal(sql.match(/SECURITY INVOKER/g).length, 2);
  assert.equal(sql.match(/octet_length\(wire::text\) < octet_length\(raw\.j::text\)/g).length, 2);
  assert.equal(sql.match(/last_value\.value <> '0'::jsonb/g).length, 2);
  assert.doesNotMatch(sql, /SECURITY DEFINER|ALTER TABLE|DROP\s|CREATE OR REPLACE FUNCTION public\.account_(summary|model_breakdown)_compact\(/);
  assert.doesNotMatch(sql, /FROM public\.tokentracker_hourly|account_usage_grouped_cached\(/);
  for (const endpoint of ["summary", "model_breakdown"]) {
    assert.match(sql, new RegExp(`SELECT public\\.account_${endpoint}_compact\\(p_user_id, p_device_id, p_from, p_to, p_tz, p_offset_min, p_range_from, p_range_to\\) AS j`));
    assert.match(sql, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.account_${endpoint}_wire[^;]+FROM PUBLIC, anon, authenticated;`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.account_${endpoint}_wire[^;]+TO project_admin;`));
  }
});
