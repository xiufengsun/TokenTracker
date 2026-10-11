"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRAMAuthBroker, REALM } = require("../TokenTrackerBar/scripts/native-qa-auth.cjs");
const USER = "00000000-0000-4000-8000-000000000001";
const ORDER = "00000000-0000-4000-8000-000000000003";
const gatewayHeaders = { "X-TokenTracker-Sandbox-Realm": REALM, "X-TokenTracker-Billing-Environment": "sandbox" };
const session = token => Response.json({ user: { id: USER }, accessToken: token, csrfToken: "unit-only-csrf" }, {
  headers: { "Set-Cookie": "insforge_refresh_token=unit-only-refresh; HttpOnly; Secure; Path=/api/auth" }
});
const identity = () => Response.json({ user_id: USER, realm: REALM, environment: "sandbox", authenticated: true }, { headers: gatewayHeaders });
const login = broker => broker.request("/api/auth/sessions", {
  method: "POST", body: JSON.stringify({ email: "unit@example.test", password: "unit-only-password" })
});

test("native QA broker preserves standard password/CSRF auth while keeping refresh credentials in RAM", async () => {
  const seen = [];
  const broker = createRAMAuthBroker({ allowedUserIDs: [USER], fetchImpl: async (target, init) => {
    seen.push({ url: String(target), headers: new Headers(init.headers), body: init.body });
    return String(target).includes("mode=identity") ? identity() : session("unit-access");
  } });
  const logged = await login(broker);
  assert.equal(logged.status, 200);
  const result = await logged.json();
  assert.equal(result.accessToken, "unit-access"); assert.equal(result.user.id, USER);
  assert.ok(!JSON.stringify(result).includes("unit-only-refresh"));
  const refreshed = await broker.request("/api/auth/refresh", { method: "POST", headers: { "X-CSRF-Token": result.csrfToken } });
  assert.equal(refreshed.status, 200);
  const upstream = seen.find(value => value.url.endsWith("/api/auth/refresh"));
  assert.equal(upstream.headers.get("Cookie"), "insforge_refresh_token=unit-only-refresh");
  assert.equal(upstream.headers.get("X-CSRF-Token"), "unit-only-csrf");
  assert.equal(logged.headers.get("Set-Cookie"), null);
});

test("an in-flight refresh cannot restore an actor cleared after the request began", async () => {
  let release; let began;
  const started = new Promise(resolve => { began = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const broker = createRAMAuthBroker({ allowedUserIDs: [USER], fetchImpl: async target => {
    if (String(target).includes("mode=identity")) return identity();
    if (String(target).endsWith("/api/auth/refresh")) { began(); return paused; }
    return session("unit-before");
  } });
  assert.equal((await login(broker)).status, 200);
  const pending = broker.request("/api/auth/refresh", { method: "POST", headers: { "X-CSRF-Token": "unit-only-csrf" } });
  await started; broker.clear(); assert.equal(broker.accessToken(), null);
  release(session("unit-stale-after-clear"));
  const result = await pending;
  assert.equal(result.status, 403); assert.equal(broker.accessToken(), null);
});

test("owned-order verification uses the real public membership/environment envelope and current actor", async () => {
  const broker = createRAMAuthBroker({ allowedUserIDs: [USER], fetchImpl: async target => {
    const url = new URL(target);
    if (url.searchParams.get("mode") === "identity") return identity();
    if (url.searchParams.get("action") === "order") return Response.json({
      order: { id: ORDER, status: "paid", payment_state: "partially_refunded" }, membership: { environment: "sandbox" }
    }, { headers: gatewayHeaders });
    return session("unit-access");
  } });
  assert.equal((await login(broker)).status, 200);
  const value = await broker.ownedOrder(ORDER);
  assert.equal(value.userID, USER); assert.equal(value.order.id, ORDER);
  assert.equal(value.order.environment, undefined);
});

test("actual broker-issued tokens survive same-actor rotation but are discarded on logout/clear", async () => {
  let generation = 0;
  const broker = createRAMAuthBroker({ allowedUserIDs: [USER], fetchImpl: async target =>
    String(target).includes("mode=identity") ? identity() : session("unit-issued-" + ++generation) });
  assert.equal((await login(broker)).status, 200);
  const epoch = broker.sessionEpoch();
  const previous = broker.accessToken();
  await broker.request("/api/auth/refresh", { method: "POST", headers: { "X-CSRF-Token": "unit-only-csrf" } });
  assert.equal(broker.sessionEpoch(), epoch);
  assert.ok(broker.acceptsAccessToken(previous)); assert.ok(broker.acceptsAccessToken(broker.accessToken()));
  assert.equal(broker.acceptsAccessToken("unissued-same-sub-token"), false);
  broker.clear(); assert.equal(broker.acceptsAccessToken(previous), false);
});

test("real-refresh bootstrap calls the actual mobile contract without exporting its refresh token", async () => {
  const seed = "unit-only-real-refresh-contract-".repeat(2);
  const seen = [];
  const broker = createRAMAuthBroker({ allowedUserIDs: [USER], fetchImpl: async (target, init) => {
    if (String(target).includes("mode=identity")) return identity();
    seen.push({ url: String(target), body: JSON.parse(init.body) });
    return Response.json({ user: { id: USER }, accessToken: "unit-mobile-access", refreshToken: seed + "-rotated" });
  } });
  const seeded = await broker.bootstrapRealRefresh(seed);
  assert.equal(seeded.status, 200);
  assert.ok(!JSON.stringify(await seeded.json()).includes(seed));
  assert.ok(seen[0].url.endsWith("/api/auth/refresh?client_type=mobile"));
  assert.equal(seen[0].body.refresh_token, seed);
  const renewed = await broker.request("/api/auth/refresh", { method: "POST" });
  assert.equal(renewed.status, 200);
  assert.equal(seen[1].body.refresh_token, seed + "-rotated");
});

test("user-only auth responses retain their producing actor/epoch before a later sign-in", async () => {
  const PEER = "00000000-0000-4000-8000-000000000002";
  let count = 0;
  const broker = createRAMAuthBroker({ allowedUserIDs: [USER, PEER], fetchImpl: async (target, init) => {
    if (String(target).endsWith("/api/auth/sessions/current")) return Response.json({ user: { id: USER } });
    if (String(target).includes("mode=identity")) return Response.json({ user_id: new Headers(init.headers).get("Authorization").includes("peer") ? PEER : USER,
      realm: REALM, environment: "sandbox", authenticated: true }, { headers: gatewayHeaders });
    count++;
    return Response.json({ user: { id: count === 1 ? USER : PEER }, accessToken: count === 1 ? "unit-access" : "unit-peer", csrfToken: "unit-only-csrf" },
      { headers: { "Set-Cookie": "insforge_refresh_token=unit-only-rotate; HttpOnly" } });
  } });
  await login(broker);
  const source = await broker.request("/api/auth/sessions/current", { method: "GET" });
  const stampedEpoch = Number(source.headers.get("X-Native-QA-Auth-Epoch"));
  await login(broker);
  assert.equal(source.headers.get("X-Native-QA-Actor"), USER);
  assert.equal((await source.json()).user.id, USER);
  assert.equal(broker.actorID(), PEER);
  assert.notEqual(broker.sessionEpoch(), stampedEpoch);
});
