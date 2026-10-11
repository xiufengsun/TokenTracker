"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const repoRoot = path.resolve(__dirname, "../..");
const { createNativeQAServer } = require("../../TokenTrackerBar/scripts/native-qa-server.cjs");
const rawFetch = fetch;
const rawHttpRequest = require("node:http").request;
const USER = "00000000-0000-4000-8000-000000000001";
const PEER = "00000000-0000-4000-8000-000000000002";
const ORDER = "00000000-0000-4000-8000-000000000003";
const REALM = "tokentracker-native-sandbox-v1";
const upstreamCalls = [];
const publicProfile = { schemaVersion: 1, realm: REALM, environment: "sandbox",
  backendBaseUrl: "https://srctyff5.us-east.insforge.app",
  gatewayUrl: "https://srctyff5.function2.insforge.app/tokentracker-native-sandbox-gateway",
  protocol: "tokentracker-qa", returnPath: "/billing/checkout", returnSiteOrigin: "https://srctyff5.insforge.site",
  auth: { issuerUnchanged: true, brokerRequired: true } };
const gatewayHeaders = { "X-TokenTracker-Sandbox-Realm": REALM, "X-TokenTracker-Billing-Environment": "sandbox" };
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-qa-core-fixture-")));
const packageRoot = path.join(fixture, "package");
fs.mkdirSync(packageRoot);
// Node 22 fs.cpSync aborts on this Windows checkout's Unicode path. Copy the
// same regular files explicitly, without importing links outside the fixture.
function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Fixture source must not contain links: ${entry.name}`);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}
copyTree(path.join(repoRoot, "src"), path.join(packageRoot, "src"));
// The fixture must work after npm ci without a prebuilt macOS app bundle.
// Preserve the lockfile's production dependency layout, including nested deps.
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
for (const [relative, dependency] of Object.entries(lock.packages)) {
  if (!relative.startsWith("node_modules/") || dependency.dev === true) continue;
  const source = path.join(repoRoot, relative);
  if (!fs.existsSync(source)) {
    assert.ok(dependency.optional, `Missing installed production dependency: ${relative}`);
    continue;
  }
  copyTree(source, path.join(packageRoot, relative));
}
fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(packageRoot, "package.json"));
fs.mkdirSync(path.join(packageRoot, "dashboard/dist"), { recursive: true });
fs.writeFileSync(path.join(packageRoot, "dashboard/dist/index.html"), "<!doctype html><html><body><div id='root'></div></body></html>");
fs.writeFileSync(path.join(packageRoot, "dashboard/dist/pricing.html"), "<h1>Owned fixture</h1>");
let native;
let pausedOrder = null;
const upstream = async (target, options = {}) => {
  const url = new URL(target);
  if (url.hostname === "127.0.0.1") return rawFetch(target, options);
  upstreamCalls.push({ path: url.pathname, method: options.method || "GET", action: url.searchParams.get("action") });
  if (url.searchParams.get("mode") === "identity") return Response.json({ user_id: new Headers(options.headers).get("Authorization").includes("peer") ? PEER : USER,
    realm: REALM, environment: "sandbox", authenticated: true }, { headers: gatewayHeaders });
  if (url.pathname === "/api/auth/refresh" && url.searchParams.get("client_type") === "mobile") {
    assert.equal(JSON.parse(options.body).refresh_token, "unit-server-only-refresh-".repeat(2));
    return Response.json({ user: { id: USER }, accessToken: "unit-seeded-access", refreshToken: "unit-rotated-only-refresh-".repeat(2) });
  }
  if (url.pathname === "/api/auth/sessions") {
    const peer = JSON.parse(options.body).email.includes("peer");
    return Response.json({ user: { id: peer ? PEER : USER }, accessToken: peer ? "unit-peer" : "unit-access", csrfToken: "unit-csrf" },
      { headers: { "Set-Cookie": "insforge_refresh_token=unit-refresh; HttpOnly" } });
  }
  if (url.searchParams.get("action") === "order") {
    if (pausedOrder) { pausedOrder.began(); await pausedOrder.wait; }
    return Response.json({ order: { id: ORDER, status: "paid" }, membership: { environment: "sandbox" } }, { headers: gatewayHeaders });
  }
  if (url.searchParams.get("action") === "catalog") return Response.json({ environment: "sandbox", policy: { phase: "preview" } }, { headers: gatewayHeaders });
  throw Error("fixture_upstream_unknown_route");
};

(async () => {
  native = await createNativeQAServer({ packageRoot, repoRoot, allowedUserIDs: [USER, PEER], ownedOrderIDs: [ORDER], publicProfile, fetchImpl: upstream });
  const profile = JSON.parse(fs.readFileSync(native.profilePath, "utf8"));
  const headers = { "X-TokenTracker-QA-Challenge": profile.serverChallenge };
  const send = (route, init = {}) => rawFetch(native.origin + route, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  assert.notEqual(new URL(native.origin).port, "7680");
  assert.equal((await send("/__native-qa/identity")).status, 200);
  assert.equal((await rawFetch(native.origin + "/")).status, 403);
  const index = await send("/"); assert.equal(index.status, 200); assert.ok(index.headers.get("Content-Security-Policy").includes("connect-src 'self'"));
  assert.equal((await send("/", { headers: { Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await send("/", { headers: { Referer: "https://foreign.example/page" } })).status, 403);
  assert.equal((await send("/", { headers: { "X-Forwarded-Host": "foreign.example" } })).status, 403);
  const seedOptions = { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: "unit-server-only-refresh-".repeat(2) }) };
  assert.equal((await send("/__native-qa/bootstrap-refresh", { ...seedOptions, headers: { ...seedOptions.headers, Origin: native.origin } })).status, 403);
  assert.equal((await send("/__native-qa/bootstrap-refresh", { ...seedOptions, headers: { ...seedOptions.headers, "Sec-Fetch-Site": "same-origin" } })).status, 403);
  const seedWithMetadata = metadata => new Promise((resolve, reject) => {
    const request = rawHttpRequest(native.origin + "/__native-qa/bootstrap-refresh", { method: "POST",
      headers: { ...headers, ...seedOptions.headers, ...metadata } }, response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject); request.end(seedOptions.body);
  });
  for (const metadata of [{ "Sec-Fetch-Mode": "navigate" }, { "Sec-Fetch-Dest": "empty" },
    { "Sec-Fetch-User": "?1" }, { "Sec-Fetch-Unknown": "fixture" }]) {
    assert.equal(await seedWithMetadata(metadata), 403);
  }
  const seeded = await send("/__native-qa/bootstrap-refresh", seedOptions);
  assert.equal(seeded.status, 200); assert.equal((await seeded.json()).authenticated, true);
  assert.equal((await send("/__native-qa/bootstrap-refresh", seedOptions)).status, 403);
  const transport = request => send("/__native-qa/transport", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  const logged = await transport({ url: publicProfile.backendBaseUrl + "/api/auth/sessions", method: "POST", headers: {},
    body: JSON.stringify({ email: "unit@example.test", password: "unit-only-password" }) });
  assert.equal(logged.status, 200); const session = await logged.json(); assert.ok(!JSON.stringify(session).includes("unit-refresh"));
  const before = upstreamCalls.length;
  for (const base of [native.origin + "/functions/", native.origin + "/api/functions/", publicProfile.backendBaseUrl + "/functions/", "https://srctyff5.function2.insforge.app/"]) {
    assert.equal((await transport({ url: base + "tokentracker-billing?action=account", method: "GET", headers: { Authorization: "Bearer peer-unissued" }, body: null })).status, 403);
    assert.equal((await transport({ url: base + "tokentracker-billing?action=checkout", method: "POST", headers: { Authorization: "Bearer unit-access" }, body: "{}" })).status, 403);
    assert.equal((await transport({ url: base + "tokentracker-device-token-issue?action=reconcile", method: "POST", headers: { Authorization: "Bearer unit-access" }, body: JSON.stringify({ id: ORDER }) })).status, 403);
  }
  assert.equal(upstreamCalls.length, before);
  const owned = await send("/__native-qa/validate-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order: ORDER, realm: REALM }) });
  assert.equal(owned.status, 200); const proof = await owned.json(); assert.equal(proof.actor, USER);
  const confirm = () => send("/__native-qa/validate-actor", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor: proof.actor, actorEpoch: proof.actorEpoch, realm: REALM }) });
  assert.equal((await confirm()).status, 200);
  const local = await transport({ url: native.origin + "/functions/tokentracker-user-status", method: "GET", headers: {}, body: null });
  assert.equal(local.status, 200); const status = await local.json(); assert.ok(status && typeof status === "object");
  assert.equal((await send("/functions/tokentracker-local-sync", { method: "POST" })).status, 503);
  assert.equal((await send("/functions/tokentracker-usage-limits")).status, 503);
  let began; let release;
  const started = new Promise(resolve => { began = resolve; });
  pausedOrder = { began, wait: new Promise(resolve => { release = resolve; }) };
  const delayed = transport({ url: publicProfile.backendBaseUrl + "/functions/tokentracker-billing?action=order&id=" + ORDER,
    method: "GET", headers: { Authorization: "Bearer unit-access" }, body: null });
  await started;
  const switched = await transport({ url: publicProfile.backendBaseUrl + "/api/auth/sessions", method: "POST", headers: {},
    body: JSON.stringify({ email: "unit-peer@example.test", password: "unit-only-password" }) });
  assert.equal(switched.status, 200);
  assert.equal((await confirm()).status, 403);
  release(); const late = await delayed;
  assert.equal(late.status, 403); assert.equal((await late.json()).error, "native_qa_session_changed");
  assert.throws(() => fs.readFileSync(path.join(fixture, "outside-no-read")), /native_qa_file_access_rejected/);
  assert.throws(() => require("node:child_process").spawn("native-qa-never-run"), /native_qa_process_launch_rejected/);
  assert.throws(() => globalThis.fetch(native.origin), /native_qa_core_network_rejected/);
  assert.throws(() => require("node:http").request(native.origin), /native_qa_core_network_rejected/);
  await native.close();
  process.stdout.write(JSON.stringify({ localHTTPChecks: 16, bootstrapHTTPChecks: 8, nodeFetchBootstrapAccepted: true, browserAndRepeatedBootstrapRejected: true, bodyReadFromOriginalCore: true, remoteRequests: "fixture-only",
    personalFileReads: 0, processLaunches: 0, guiLaunched: false, counters: native.counters, cleanup: [fixture, native.runDirectory] }) + "\n");
})().catch(async error => {
  process.stderr.write(error.message + "\n");
  if (native) await native.close();
  process.exitCode = 1;
});
