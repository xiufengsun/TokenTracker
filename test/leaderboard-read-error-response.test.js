const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHmac, webcrypto } = require("node:crypto");
const { test } = require("node:test");
const { build } = require("esbuild");

const userId = "11111111-1111-4111-8111-111111111111";
const secret = "isolated-leaderboard-read-secret";
const privateDetail = "private-database-details\nCONTEXT: SELECT private_customer_payload FROM private_schema";

function query(result) {
  let chain;
  chain = new Proxy({}, { get(_, key) {
    if (key === "then") return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    if (key === "single" || key === "maybeSingle") return async () => result;
    return () => chain;
  } });
  return chain;
}

async function fixture(name, client) {
  const filename = path.resolve(__dirname, "../dashboard/edge-patches", name + ".ts");
  const out = await build({ entryPoints: [filename], bundle: true, write: false, format: "cjs",
    platform: "node", target: "node20", logLevel: "silent", plugins: [{ name: "fixture-sdk", setup(builder) {
      builder.onResolve({ filter: /^npm:@insforge\/sdk/ }, () => ({ path: "sdk", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: "export function createClient(){return globalThis.__fixtureClient}", loader: "js",
      }));
    } }] });
  const module = { exports: {} };
  const env = { JWT_SECRET: secret, INSFORGE_BASE_URL: "https://backend.test",
    INSFORGE_SERVICE_ROLE_KEY: "fixture-service", INSFORGE_ANON_KEY: "fixture-anon" };
  vm.runInNewContext(out.outputFiles[0].text, { module, exports: module.exports, __fixtureClient: client,
    Deno: { env: { get: name => env[name] } }, Request, Response, Headers, URL, TextEncoder, TextDecoder,
    crypto: webcrypto, atob, console: { log() {}, warn() {}, error() {} } });
  return module.exports.default;
}

function ownerHeaders() {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub: userId, role: "authenticated",
    exp: Date.now() / 1000 + 300 })).toString("base64url");
  const data = header + "." + claims;
  return { Authorization: "Bearer " + data + "." + createHmac("sha256", secret).update(data).digest("base64url") };
}

function profileClient(failure) {
  return { database: {
    from(table) {
      if (table === "tokentracker_devices") return query(failure === "device"
        ? { data: null, error: { message: privateDetail } } : { data: [{ id: userId }], error: null });
      return query({ data: { user_id: userId, rank: 1 }, error: null });
    },
    async rpc(name) {
      if (name === "user_badges_full") return failure === "badges"
        ? { data: null, error: { message: privateDetail } } : { data: [], error: null };
      if (name === "cloud_pro_badges") return { data: {}, error: null };
      if (failure === "unknown") throw { toString() { assert.fail("Unknown errors must not be serialized"); } };
      return { data: null, error: { message: privateDetail } };
    },
  } };
}

async function fixedFailure(response, expected) {
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  const body = await response.json();
  assert.deepEqual(body, { error: expected });
  assert.ok(!JSON.stringify(body).includes("private-database-details"));
}

test("public leaderboard query failures do not expose backend SQL details", async () => {
  const handler = await fixture("tokentracker-leaderboard", { database: {
    from: () => query({ data: null, error: { message: privateDetail } }),
  } });
  await fixedFailure(await handler(new Request("https://backend.test/leaderboard?period=week")),
    "Failed to fetch leaderboard");
});

for (const failure of ["device", "usage", "unknown"]) {
  test(`public profile ${failure} failures return a fixed error`, async () => {
    const handler = await fixture("tokentracker-leaderboard-profile", profileClient(failure));
    await fixedFailure(await handler(new Request("https://backend.test/profile?user_id=" + userId)),
      "Failed to fetch profile");
  });
}

test("owner-only badge failures do not expose backend details", async () => {
  const handler = await fixture("tokentracker-leaderboard-profile", profileClient("badges"));
  await fixedFailure(await handler(new Request("https://backend.test/profile?view=badges&user_id=" + userId,
    { headers: ownerHeaders() })), "Failed to fetch badges");
});

test("unauthenticated badges remain forbidden before any database read", async () => {
  const handler = await fixture("tokentracker-leaderboard-profile", { database: {
    from() { assert.fail("Private badges must not read tables"); },
    rpc() { assert.fail("Private badges must not reach a database RPC"); },
  } });
  const response = await handler(new Request("https://backend.test/profile?view=badges&user_id=" + userId));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Forbidden" });
});

test("empty public leaderboard responses retain their success shape", async () => {
  const handler = await fixture("tokentracker-leaderboard", { database: {
    from: () => query({ data: [], error: null, count: 0 }),
    rpc() { assert.fail("Empty leaderboards need no badge query"); },
  } });
  const response = await handler(new Request("https://backend.test/leaderboard?period=week"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.entries, []);
  assert.equal(body.me, null);
  assert.equal(body.total_entries, 0);
});

test("verified owner badge responses keep unearned badge visibility", async () => {
  const client = profileClient();
  client.database.rpc = async (name, args) => {
    assert.equal(name, "user_badges_full");
    assert.equal(args.p_user_id, userId);
    assert.equal(args.p_include_unearned, true);
    return { data: [{ badge_id: "first-upload", earned: false }], error: null };
  };
  const handler = await fixture("tokentracker-leaderboard-profile", client);
  const response = await handler(new Request("https://backend.test/profile?view=badges&user_id=" + userId,
    { headers: ownerHeaders() }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { badges: [{ badge_id: "first-upload", earned: false }],
    badges_include_unearned: true });
});
