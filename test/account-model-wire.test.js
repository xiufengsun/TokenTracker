"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHmac, webcrypto } = require("node:crypto");
const { test } = require("node:test");
const { transformSync } = require("esbuild");

const edgeDir = path.join(__dirname, "..", "dashboard", "edge-patches");
const fixture = {
  heatmap: {
    old: JSON.parse('[["2026-09-18","9007199254740993",{"__proto__":"3","日本語\\\"":"9007199254740993","":0}],["2026-09-19",0,null],["2026-09-20",0,{}]]'),
    wire: {
      model_names: ["", "__proto__", '日本語"'],
      days: [["2026-09-18", "9007199254740993", [1, "3", 2, "9007199254740993", 0, 0]], ["2026-09-19", 0, null], ["2026-09-20", 0, []]],
    },
  },
  daily: {
    old: {
      days: [["2026-09-18", "9007199254740993", "11", 2, 3, "4", 5, 6, { "gpt-6-sol": "9007199254740993", unknown: 0 }], ["2026-09-19", 0, 0, 0, 0, 0, 0, 0, null], ["2026-09-20", 0, 0, 0, 0, 0, 0, 0, {}]],
      cost_dims: [["2026-09-18", null, null, null, "9007199254740993", 2, "3", 4, 5], ["2026-09-18", "", "", "", 1, 2, 3, 4, 5], ["2026-09-18", "codex", "gpt-6-sol", "", "11", 2, 3, "4", 5], ["2026-09-18", "lmstudio", "local/x", null, 10000, 10000, 0, 0, 0], ["2026-09-18", "workbuddy", "auto", null, 123, 45, 67, 0, 0]],
    },
    wire: {
      model_names: [null, "", "gpt-6-sol", "unknown", "local/x", "auto"],
      source_names: [null, "", "codex", "lmstudio", "workbuddy"],
      pricing_tiers: [null, ""],
      days: [["2026-09-18", "9007199254740993", "11", 2, 3, "4", 5, 6, [2, "9007199254740993", 3, 0]], ["2026-09-19", 0, 0, 0, 0, 0, 0, 0, null], ["2026-09-20", 0, 0, 0, 0, 0, 0, 0, 0, []]],
      cost_dims: [["2026-09-18", 0, 0, 0, "9007199254740993", 2, "3", 4, 5], ["2026-09-18", 1, 1, 1, 1, 2, 3, 4, 5], ["2026-09-18", 2, 2, 1, "11", 2, 3, "4", 5], ["2026-09-18", 3, 4, 0, 10000, 10000, 0, 0, 0], ["2026-09-18", 4, 5, 0, 123, 45, 67, 0, 0]],
    },
  },
};

function loadEdge(endpoint, data, legacy = false) {
  let source = fs.readFileSync(path.join(edgeDir, `tokentracker-account-${endpoint}.ts`), "utf8");
  source = source.replace('import { createClient } from "npm:@insforge/sdk";', "const createClient = __createClient;");
  if (legacy) {
    // Bypass only the new transport decoder; exercise the same unchanged
    // auth, filtering, pricing and dense/compact response code with old data.
    source = source.replace(`client.database.rpc("account_${endpoint}_wire",`, `client.database.rpc("account_${endpoint}_compact",`);
    if (endpoint === "heatmap") source = source.replace("const days = decodeHeatmapWire(data);", "const days = data;");
    else source = source.replace("const value = decodeDailyWire(data);", "const value = data;");
  }
  const decoder = endpoint === "heatmap" ? "decodeHeatmapWire" : "decodeDailyWire";
  source += `\nexport { ${decoder} as decode };`;
  const code = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" }).code;
  const calls = [];
  const context = {
    module: { exports: {} }, exports: {}, Request, Response, URL, Headers,
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
  const body = encode({ sub: "00000000-0000-4000-8000-000000000001", exp: Math.floor(Date.now() / 1000) + 60 });
  const unsigned = `${head}.${body}`;
  return `Bearer ${unsigned}.${createHmac("sha256", "test-jwt-secret").update(unsigned).digest("base64url")}`;
}

for (const endpoint of ["heatmap", "daily"]) {
  test(`${endpoint} dictionary decoding preserves types, nulls, empty names and row order`, () => {
    const edge = loadEdge(endpoint, fixture[endpoint].wire);
    const decoded = edge.decode(fixture[endpoint].wire);
    assert.deepEqual(JSON.parse(JSON.stringify(decoded)), fixture[endpoint].old);
    if (endpoint === "heatmap") {
      assert.ok(Object.hasOwn(decoded[0][2], "__proto__"));
      assert.equal(decoded[0][1], "9007199254740993");
    } else {
      assert.equal(decoded.cost_dims[0][1], null);
      assert.equal(decoded.cost_dims[1][1], "");
      assert.equal(decoded.cost_dims[0][4], "9007199254740993");
    }
  });

  test(`${endpoint} empty dictionaries preserve the previous empty result`, () => {
    const edge = loadEdge(endpoint, null);
    const wire = { model_names: [], source_names: [], pricing_tiers: [], days: [], cost_dims: [] };
    assert.deepEqual(JSON.parse(JSON.stringify(edge.decode(wire))), endpoint === "heatmap" ? [] : { days: [], cost_dims: [] });
  });

  test(`${endpoint} returns the same complete JSON response and RPC arguments after transport decoding`, async () => {
    const edge = loadEdge(endpoint, fixture[endpoint].wire);
    const legacy = loadEdge(endpoint, fixture[endpoint].old, true);
    const params = endpoint === "heatmap"
      ? "weeks=2&to=2026-09-30&tz=Asia%2FSingapore&tz_offset_minutes=480"
      : "from=2026-09-18&to=2026-09-30&tz=Asia%2FSingapore&tz_offset_minutes=480";
    for (const suffix of endpoint === "heatmap" ? ["", "&format=compact&week_starts_on=mon"] : [""]) {
      const req = new Request(`https://test.invalid/?${params}${suffix}`, { headers: { Authorization: authorization() } });
      const [response, previous] = await Promise.all([edge.default(req), legacy.default(req)]);
      assert.equal(response.status, 200);
      assert.equal(response.status, previous.status);
      assert.deepEqual([...response.headers], [...previous.headers]);
      assert.equal(await response.text(), await previous.text());
    }
    assert.equal(edge.calls.length, 1, "the existing in-process cache still avoids a second RPC");
    assert.equal(edge.calls[0].name, `account_${endpoint}_wire`);
    assert.equal(legacy.calls[0].name, `account_${endpoint}_compact`);
    assert.deepEqual(JSON.parse(JSON.stringify(edge.calls[0].args)), JSON.parse(JSON.stringify(legacy.calls[0].args)));
  });

  test(`${endpoint} rejects unauthenticated reads before calling its wire RPC`, async () => {
    const edge = loadEdge(endpoint, fixture[endpoint].wire);
    const response = await edge.default(new Request("https://test.invalid/?from=2026-09-18&to=2026-09-30"));
    assert.equal(response.status, 401);
    assert.equal(edge.calls.length, 0);
  });
}

test("the migration adds only invoker wrappers restricted to the existing edge role", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "20261002090000_compact-account-model-wire.sql"), "utf8");
  assert.equal(sql.match(/CREATE OR REPLACE FUNCTION/g).length, 2);
  assert.equal(sql.match(/SECURITY INVOKER/g).length, 2);
  assert.doesNotMatch(sql, /SECURITY DEFINER|ALTER TABLE|DROP\s|CREATE OR REPLACE FUNCTION public\.account_(heatmap|daily)_compact\(/);
  for (const endpoint of ["heatmap", "daily"]) {
    assert.match(sql, new RegExp(`SELECT public\\.account_${endpoint}_compact\\(p_user_id, p_device_id, p_from, p_to, p_tz, p_offset_min, p_range_from, p_range_to\\) AS j`));
    assert.match(sql, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.account_${endpoint}_wire[^;]+FROM PUBLIC, anon, authenticated;`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.account_${endpoint}_wire[^;]+TO project_admin;`));
  }
});
