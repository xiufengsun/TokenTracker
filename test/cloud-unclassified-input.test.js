"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const root = path.join(__dirname, "..");
const readEdge = (name) => fs.readFileSync(path.join(root, "dashboard/edge-patches", `tokentracker-${name}.ts`), "utf8");

function loadEdge(name, client = {}, extra = "", env = {}) {
  let source = readEdge(name).replace(/import \{ createClient \} from "npm:@insforge\/sdk";/, "const createClient = () => globalThis.client;") + extra;
  const access = fs.readFileSync(path.join(root, "dashboard/edge-patches/cloud/access.ts"), "utf8")
    .replace(/^import type .*;$/m, "").replaceAll("export ", "");
  source = source.replace(/^import \{[^}]+\} from "\.\/cloud\/access.ts";$/m, access);
  source = source.replace(/^import \{ readProBadges \} from "\.\/cloud\/pro.ts";$/m,
    fs.readFileSync(path.join(root, "dashboard/edge-patches/cloud/pro.ts"), "utf8").replaceAll("export ", ""));
  const context = { module: { exports: {} }, client, console, Request, Response, Headers, URL, TextEncoder,
    crypto: require("node:crypto").webcrypto, atob, btoa,
    Deno: { env: { get: (key) => ({ INSFORGE_BASE_URL: "https://test.invalid", INSFORGE_SERVICE_ROLE_KEY: "test", TOKENTRACKER_ACCOUNTING_V3_READY: "1", ...env })[key] } } };
  vm.runInNewContext(transformSync(source, { loader: "ts", format: "cjs" }).code, context);
  return context.module.exports;
}
const complete = { bucket: "2026-09-12", source: "vscode-copilot", model: "gpt-5.4", input_tokens: 100,
  output_tokens: 20, cached_input_tokens: 30, cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
  total_tokens: 150, conversations: 1 };
const partial = { ...complete, input_tokens: 0, unclassified_input_tokens: 100, total_tokens: 150 };

for (const name of ["account-summary", "account-daily", "leaderboard-refresh", "leaderboard-profile"]) {
  test(`${name}: unknown input is excluded from the known subtotal`, () => {
    const api = loadEdge(name, {}, "\nexport { computeRowCost, costFields };");
    const known = api.computeRowCost(partial);
    assert.ok(known > 0);
    assert.ok(known < api.computeRowCost(complete));
    assert.equal(api.costFields(known, 100).total_cost_usd, null);
    assert.equal(api.costFields(known, 100).known_cost_usd, known);
    assert.equal(api.costFields(known, 100).cost_status, "partial");
    assert.equal(api.costFields(known, 0).total_cost_usd, known);
    assert.equal(api.computeRowCost({ ...partial, source: "grok", total_cost_usd: 999 }),
      api.computeRowCost({ ...partial, source: "grok" }));
    assert.equal(api.computeRowCost({ ...complete, source: "grok", total_cost_usd: 999 }), 999);
  });
}

for (const name of ["account-summary", "account-daily", "account-model-breakdown", "account-hourly", "account-monthly"]) {
  test(`${name}: mixed RPC rows retain the disjoint column in the response`, async () => {
    const rows = [complete, partial].map(r => ({ ...r, bucket: name === "account-hourly" ? "2026-09-12T01:00:00" : name === "account-monthly" ? "2026-09" : r.bucket }));
    const sums = key => rows.reduce((n, row) => n + Number(row[key] || 0), 0);
    const modelDim = [partial.source, partial.model, "peak", sums("total_tokens"), sums("input_tokens"), sums("output_tokens"), sums("cached_input_tokens"), 0, 0, sums("unclassified_input_tokens")];
    const data = name === "account-summary" ? {
      cost_dims: [modelDim.slice(0, 3).concat(modelDim.slice(4, 9))],
      day_rollup: [[complete.bucket, sums("total_tokens"), 2]],
      range_totals: { total_tokens: sums("total_tokens"), input_tokens: sums("input_tokens"), output_tokens: sums("output_tokens"), cached_input_tokens: sums("cached_input_tokens"), unclassified_input_tokens: 100, active_days: 1, conversation_count: 2 },
    } : name === "account-daily" ? {
      model_names: [partial.model], source_names: [partial.source], pricing_tiers: ["peak"],
      days: [[complete.bucket, sums("total_tokens"), sums("input_tokens"), sums("output_tokens"), sums("cached_input_tokens"), 0, 0, 2, [0, sums("total_tokens")], 100]],
      cost_dims: [[complete.bucket, 0, 0, 0, sums("input_tokens"), sums("output_tokens"), sums("cached_input_tokens"), 0, 0]],
    } : name === "account-model-breakdown" ? [modelDim] : rows;
    const client = { database: { rpc: async (rpc) => ({ data: rpc === "cloud_account_access" ? { ok: true } : data, error: null }) } };
    const api = loadEdge(name, client, '\nverifiedUserIdFromJwt = async () => "user";');
    const query = name === "account-hourly"
      ? "day=2026-09-12&tz=UTC"
      : "from=2026-09-12&to=2026-09-12&tz=UTC";
    const response = await api.default(new Request(`https://test/?${query}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const totals = name === "account-model-breakdown" ? body.sources[0].totals : body.totals || body.data[0];
    assert.equal(totals.unclassified_input_tokens, 100);
    assert.equal(totals.input_tokens, 100);
    if (!["account-hourly", "account-monthly"].includes(name)) {
      assert.equal(totals.total_cost_usd, null);
      assert.equal(totals.cost_status, "partial");
      assert.ok(Number(totals.known_cost_usd) > 0);
    }
    if (body.sources) assert.equal(body.sources[0].models[0].totals.cost_status, "partial");
  });
}

test("ingestion accepts old rows, rejects malformed unknown counts, and keeps whole-row MAX dedup", async () => {
  let written;
  const client = { database: { rpc: async (name, args) => {
    if (name === "tokentracker_accounting_capabilities") return { data: { accounting_version: 3, unclassified_input_tokens: true } };
    assert.equal(name, "cloud_ingest_usage");
    written = args.p_rows;
    return { data: { ok: true, inserted: written.length }, error: null };
  }, from: (table) => {
    const query = { select: () => query, eq: () => query, is: () => query, limit: () => query,
      maybeSingle: async () => ({ data: table === "tokentracker_device_tokens" ? { user_id: "u", device_id: "d" } : null }),
      upsert: async rows => { written = rows; return {}; } };
    return query;
  } } };
  const api = loadEdge("ingest", client);
  const send = buckets => api.default(new Request("https://test", { method: "POST", headers: { Authorization: "Bearer test" }, body: JSON.stringify({ buckets }) }));
  assert.equal((await send([{ ...complete, hour_start: "2026-09-12T01:00:00Z" }])).status, 200);
  assert.equal(written[0].unclassified_input_tokens, 0);
  assert.equal((await send([{ ...partial, total_tokens: 200 }, complete])).status, 200);
  assert.equal(written.length, 1);
  assert.equal(written[0].unclassified_input_tokens, 100);
  assert.equal(written[0].total_cost_usd, null);
  for (const value of [-1, 0.5, "10", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await send([{ ...partial, unclassified_input_tokens: value }])).status, 400);
  }
});

test("ingestion advertises the accounting contract before accepting partial rows", async () => {
  const api = loadEdge("ingest", { database: { rpc: async () => ({ data: { accounting_version: 3, unclassified_input_tokens: true } }) } });
  const response = await api.default(new Request("https://test/?capabilities=1"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    accounting_version: 3,
    unclassified_input_tokens: true,
  });
});

test("ingestion fails closed for an old or unavailable database, including clients that skip negotiation", async () => {
  let writes = 0;
  const client = { database: {
    rpc: async name => {
      if (name === "tokentracker_accounting_capabilities") return { error: { message: "missing migration" } };
      writes++; return { data: { ok: true } };
    },
    from: () => {
      const q = { select: () => q, eq: () => q, is: () => q, maybeSingle: async () => ({ data: { user_id: "u", device_id: "d" } }) };
      return q;
    },
  } };
  const api = loadEdge("ingest", client);
  const caps = await api.default(new Request("https://test/?capabilities=1"));
  assert.deepEqual(await caps.json(), { accounting_version: 2, unclassified_input_tokens: false });
  const response = await api.default(new Request("https://test/", { method: "POST", headers: { Authorization: "Bearer test" }, body: JSON.stringify({ hourly: [partial] }) }));
  assert.equal(response.status, 503);
  assert.equal(writes, 0);
});

for (const ready of [undefined, "0", "true"]) {
  test(`migration alone cannot enable v3; gate=${String(ready)} preserves complete uploads and rejects partial admission`, async () => {
    let writes = 0, probes = 0;
    const client = { database: {
      rpc: async (name, args) => {
        if (name === "tokentracker_accounting_capabilities") {
          probes++;
          return { data: { accounting_version: 3, unclassified_input_tokens: true } };
        }
        assert.equal(name, "cloud_ingest_usage");
        writes++;
        assert.equal(args.p_rows[0].unclassified_input_tokens, 0);
        return { data: { ok: true, inserted: 1 } };
      },
      from: () => {
        const q = { select: () => q, eq: () => q, is: () => q, maybeSingle: async () => ({ data: { user_id: "u", device_id: "d" } }) };
        return q;
      },
    } };
    const api = loadEdge("ingest", client, "", { TOKENTRACKER_ACCOUNTING_V3_READY: ready });
    const caps = await api.default(new Request("https://test/?capabilities=1"));
    assert.deepEqual(await caps.json(), { accounting_version: 2, unclassified_input_tokens: false });
    const send = rows => api.default(new Request("https://test/", { method: "POST", headers: { Authorization: "Bearer test" }, body: JSON.stringify({ hourly: rows }) }));
    assert.equal((await send([complete])).status, 200);
    assert.equal(writes, 1, "normal complete traffic still reaches the real transaction boundary");
    assert.equal((await send([partial])).status, 503);
    assert.equal((await send([complete, { ...partial, model: "other-model" }])).status, 503);
    assert.equal(writes, 1, "a mixed batch must never partially commit without an acknowledgement contract");
    assert.equal(probes, 0, "the disabled gate does not mistake a migrated schema for deployed consumers");
  });
}

// Current-main PostgreSQL, wire and archive regressions run unconditionally
// in cloud-unclassified-integration.test.js (no external database or secrets).
