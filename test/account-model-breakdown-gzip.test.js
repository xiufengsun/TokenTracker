const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const { createHmac, webcrypto } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const { test } = require("node:test");
const { build } = require("esbuild");

const filename = path.resolve(__dirname, "../dashboard/edge-patches/tokentracker-account-model-breakdown.ts");
const secret = "isolated-model-response-secret";
const userId = "11111111-1111-4111-8111-111111111111";
function authorization() {
  const head = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ sub: userId, role: "authenticated", exp: Date.now() / 1000 + 300 })).toString("base64url");
  return "Bearer " + head + "." + body + "." + createHmac("sha256", secret).update(head + "." + body).digest("base64url");
}

async function fixture(options = {}) {
  const { bypass = false } = options;
  const compression = Object.hasOwn(options, "compression") ? options.compression : CompressionStream;
  let source = fs.readFileSync(filename, "utf8");
  if (bypass) source = source.replace("return encodeJsonResponse(req, await handleAccountRequest(req));", "return handleAccountRequest(req);");
  source += "\nexport { encodeJsonResponse, acceptsGzip };";
  const output = await build({ stdin: { contents: source, resolveDir: path.dirname(filename), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", target: "node20", logLevel: "silent",
    plugins: [{ name: "response-fixture-sdk", setup(builder) {
      builder.onResolve({ filter: /^npm:@insforge\/sdk/ }, () => ({ path: "sdk", namespace: "response-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "response-fixture" }, () => ({ contents: "export function createClient(){return __fixtureClient}", loader: "js" }));
    } }] });
  const models = Array.from({ length: 80 }, (_, i) => "unpriced-model-" + i);
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, Request, Response, Headers, URL,
    TextEncoder, TextDecoder, Uint8Array, CompressionStream: compression, crypto: webcrypto, atob,
    Deno: { env: { get: name => ({ JWT_SECRET: secret, INSFORGE_BASE_URL: "https://fixture.invalid", INSFORGE_SERVICE_ROLE_KEY: "fixture-admin" })[name] } },
    __fixtureClient: { database: { rpc: async name => {
      if (name === "cloud_account_access") return { data: { ok: true, available_from: null }, error: null };
      assert.equal(name, "account_model_breakdown_wire");
      if (options.error) return { data: null, error: { message: options.error } };
      return { data: { source_names: ["codex"], model_names: models, pricing_tiers: [""],
        dims: models.map((_, i) => [0, i, 0, 300, 100, 200, 0, 0, 0]) }, error: null };
    } } } });
  vm.runInContext(output.outputFiles[0].text, context);
  return module.exports;
}

function rawRequest(origin, encoding) {
  return new Promise((resolve, reject) => {
    http.get(origin + "/?from=2026-10-01&to=2026-10-10", { headers: { Authorization: authorization(), "Accept-Encoding": encoding } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
      response.on("error", reject);
    }).on("error", reject);
  });
}

test("actual model handler preserves JSON and emits negotiated gzip through loopback HTTP", async t => {
  const handler = (await fixture()).default;
  const server = http.createServer(async (req, res) => {
    try {
      const response = await handler(new Request("http://127.0.0.1" + req.url, { headers: req.headers }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = "http://127.0.0.1:" + server.address().port;
  const identity = await rawRequest(origin, "identity");
  const gzip = await rawRequest(origin, "gzip");
  assert.equal(identity.status, 200);
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.ok(identity.bytes.length > 1024);
  assert.equal(gzip.status, 200);
  assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.equal(gzip.bytes[0], 0x1f);
  assert.equal(gzip.bytes[1], 0x8b);
  assert.equal(Number(gzip.headers["content-length"]), gzip.bytes.length);
  assert.ok(gzip.bytes.length < identity.bytes.length);
  assert.deepEqual(JSON.parse(gunzipSync(gzip.bytes)), JSON.parse(identity.bytes));
  assert.match(gzip.headers.vary, /Accept-Encoding/i);
  const refused = await rawRequest(origin, "gzip;q=0, *;q=1");
  assert.equal(refused.headers["content-encoding"], undefined);
  assert.deepEqual(refused.bytes, identity.bytes);
  const mutant = (await fixture({ bypass: true })).default;
  const lost = await mutant(new Request(origin + "/?from=2026-10-01&to=2026-10-10", { headers: { Authorization: authorization(), "Accept-Encoding": "gzip" } }));
  assert.equal(lost.headers.get("Content-Encoding"), null, "dropping the response wrapper must be observable");
});

test("response negotiation preserves errors, small bodies, no-transform and unavailable compression", async () => {
  const edge = await fixture();
  const request = new Request("https://fixture.invalid/", { headers: { "Accept-Encoding": "gzip" } });
  for (const response of [Response.json({ error: "Unauthorized" }, { status: 401 }),
    Response.json({ ok: true }), Response.json({ value: "x".repeat(2000) }, { headers: { "Cache-Control": "no-transform" } })]) {
    const result = await edge.encodeJsonResponse(request, response);
    assert.equal(result.headers.get("Content-Encoding"), null);
    assert.equal(result.status, response.status);
    await result.arrayBuffer();
  }
  const unavailable = await fixture({ compression: undefined });
  const result = await unavailable.encodeJsonResponse(request, Response.json({ value: "x".repeat(2000) }));
  assert.equal(result.headers.get("Content-Encoding"), null);
  assert.equal((await result.json()).value.length, 2000);
  assert.equal(edge.acceptsGzip("gzip;q=0.5, identity;q=1"), false);
  assert.equal(edge.acceptsGzip("gzip;q=invalid"), false);
});

test("model aggregation failure does not return internal SQL details", async () => {
  const detail = "private-model-query-details\nSELECT protected_user_id FROM private_table";
  const handler = (await fixture({ error: detail })).default;
  const response = await handler(new Request("https://fixture.invalid/?from=2026-10-01&to=2026-10-10", {
    headers: { Authorization: authorization(), "Accept-Encoding": "gzip" },
  }));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Failed to fetch model breakdown" });
});
