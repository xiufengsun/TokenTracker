"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWorkbuddyBroker } = require("./helpers/workbuddy-ipc");
const { readWorkbuddyIpcDiscovery, openWorkbuddyIpc } = require("../src/lib/workbuddy-ipc");
const { fetchWorkbuddyLimits, fetchWorkbuddyAiLimits } = require("../src/lib/workbuddy-limits");
const { getUsageLimits, resetUsageLimitsCache } = require("./helpers/usage-limits");

const PLAN = "TCACA_code_008_cfWoLwvjU4";
const REWARD = "TCACA_code_007_nzdH5h4Nl0";

test("missing provider homes have no local IPC discovery", () => {
  assert.equal(readWorkbuddyIpcDiscovery(null), null);
  assert.equal(readWorkbuddyIpcDiscovery(undefined), null);
});

function quotaResponse(apiPath) {
  if (apiPath.endsWith("summary")) return { code: 0, data: {
    SubscriptionPackageName: "体验版",
    Packages: [
      { PackageCode: PLAN, CycleTotalCapacity: 500, CycleRemainCapacity: 247.07, CycleUsedCapacity: 252.93 },
      { PackageCode: REWARD, CycleTotalCapacity: 1500, CycleRemainCapacity: 1500, CycleUsedCapacity: 0 },
    ],
  } };
  return { code: 0, data: { Accounts: apiPath.includes("-free-") ? [{
    PackageCode: PLAN, PackageName: "CodeBuddy个人体验版", CycleCapacitySizePrecise: 500,
    CycleCapacityRemainPrecise: 247.07, CycleEndTime: "2026-10-31 23:59:59",
  }] : [], TotalCount: apiPath.includes("-free-") ? 1 : 0 } };
}

test("encrypted desktop sessions use authenticated IPC and merge quota with the cycle end", async (t) => {
  const broker = await createWorkbuddyBroker(t, { fragment: true, respond: quotaResponse });
  const authPath = path.join(broker.root, "auth.info");
  fs.writeFileSync(authPath, JSON.stringify({ auth: {
    domain: "www.workbuddy.cn", accessToken: { $wbEncrypted: 1, envelope: "not-readable" },
  } }));
  const result = await fetchWorkbuddyLimits({
    workbuddyHome: broker.home, env: { HOME: broker.root, WORKBUDDY_ACCESS_TOKEN: "legacy-unused" },
    authFiles: [authPath], fetchImpl: () => { throw new Error("Direct network access must not be used."); },
  });
  assert.equal(result.source, "ipc");
  assert.equal(result.plan_label, "Free");
  assert.equal(result.primary_window.used_percent, 50.586);
  assert.equal(result.primary_window.reset_at, new Date("2026-10-31T23:59:59").toISOString());
  assert.equal(broker.requests.length, 3);
  assert.ok(broker.requests.every(({ path: apiPath }) => apiPath.startsWith("/billing/meter/")));
  assert.ok(broker.requests.slice(1).every(({ body }) => body.PackageCodes.includes(PLAN) && !body.PackageCodes.includes(REWARD)));
  assert.ok(!JSON.stringify(broker.packets).includes(broker.ticket));
  assert.ok(!JSON.stringify(broker.packets).includes("legacy-unused"));
});

test("international quota uses only its own proxy and preserves a native English name", async (t) => {
  const cn = await createWorkbuddyBroker(t, { respond: quotaResponse });
  const ai = await createWorkbuddyBroker(t, {
    origin: "https://www.workbuddy.ai",
    respond: (apiPath) => {
      const response = quotaResponse(apiPath);
      if (apiPath.endsWith("summary")) response.data.SubscriptionPackageName = "Pro-Trial";
      return response;
    },
  });
  const result = await fetchWorkbuddyAiLimits({
    env: { HOME: cn.root, WORKBUDDY_HOME: cn.home, WORKBUDDY_AI_HOME: ai.home },
  });
  assert.equal(result.source, "ipc");
  assert.equal(result.plan_label, "Pro-Trial");
  assert.equal(ai.requests.length, 3);
  assert.equal(cn.packets.length, 0);
});

test("the limits aggregation retains Free and cancels IPC when the provider budget expires", async (t) => {
  const broker = await createWorkbuddyBroker(t, { respond: quotaResponse });
  const options = {
    home: broker.root, env: { HOME: broker.root, WORKBUDDY_HOME: broker.home },
    trackerDir: path.join(broker.root, "tracker"), providerTimeoutMs: 1000,
    securityRunner: () => ({ status: 1, stdout: "" }),
    commandRunner: () => ({ status: 1, stdout: "" }),
    fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) }),
  };
  resetUsageLimitsCache();
  t.after(() => resetUsageLimitsCache());
  const result = await getUsageLimits(options);
  assert.equal(result.workbuddy.plan_label, "Free");
  assert.equal(result.workbuddy.source, "ipc");
  // Each edition is its own aggregation entry now; the AI edition has no
  // broker here, so it publishes the bare unconfigured shape (plus the
  // aggregation's shared provenance block).
  assert.equal(result.workbuddyAi.configured, false);
  assert.equal(result.workbuddyAi.primary_window, undefined);
  assert.equal(result.workbuddy.primary_window.limit_credits, 500);

  const stalled = await createWorkbuddyBroker(t, { stallRequest: true });
  resetUsageLimitsCache();
  const timeout = await getUsageLimits({ ...options,
    env: { HOME: broker.root, WORKBUDDY_HOME: stalled.home }, providerTimeoutMs: 60,
  });
  assert.match(timeout.workbuddy.error, /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stalled.sockets.size, 0);
});

test("an edition mismatch is rejected before opening its proxy", async (t) => {
  const broker = await createWorkbuddyBroker(t);
  await assert.rejects(fetchWorkbuddyAiLimits({ workbuddyHome: broker.home, env: { HOME: broker.root } }), /does not match this edition/);
  assert.equal(broker.packets.length, 0);
});

test("wrong server proofs cannot authenticate or issue billing calls", async (t) => {
  const broker = await createWorkbuddyBroker(t, { badProof: true });
  await assert.rejects(fetchWorkbuddyLimits({ workbuddyHome: broker.home }), /authentication or protocol failed/);
  assert.deepEqual(broker.packets.map((p) => p.type), ["session_hello"]);
  assert.equal(broker.requests.length, 0);
});

test("timeouts and caller cancellation destroy the connection", async (t) => {
  const broker = await createWorkbuddyBroker(t, { stallRequest: true });
  await assert.rejects(fetchWorkbuddyLimits({ workbuddyHome: broker.home, timeoutMs: 60 }), /timed out/);
  const controller = new AbortController();
  const request = fetchWorkbuddyLimits({ workbuddyHome: broker.home, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(request, /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(broker.sockets.size, 0);
});

test("an already aborted request never opens a socket", async (t) => {
  const broker = await createWorkbuddyBroker(t);
  await assert.rejects(fetchWorkbuddyLimits({ workbuddyHome: broker.home, signal: AbortSignal.abort() }), /cancelled/);
  assert.equal(broker.packets.length, 0);
});

test("a closed socket rejects an outstanding quota request promptly", async (t) => {
  const broker = await createWorkbuddyBroker(t, { closeRequest: true });
  await assert.rejects(fetchWorkbuddyLimits({ workbuddyHome: broker.home }), /Start WorkBuddy and sign in/);
});

test("billing auth failures and malformed responses remain sanitized", async (t) => {
  for (const options of [
    { status: 401 },
    { rpcError: "secret-ticket-and-auth-body" },
    { rawBody: "secret-ticket-and-auth-body" },
  ]) {
    const broker = await createWorkbuddyBroker(t, options);
    await assert.rejects(fetchWorkbuddyLimits({ workbuddyHome: broker.home }), (error) => {
      assert.doesNotMatch(error.message, /secret-ticket|auth-body/);
      if (options.status === 401) assert.equal(error.code, "AUTH_EXPIRED");
      return true;
    });
  }
});

test("package business errors do not produce a partial successful quota", async (t) => {
  const broker = await createWorkbuddyBroker(t, { respond: (apiPath) =>
    apiPath.includes("-free-") ? { code: 10001, msg: "private-error" } : quotaResponse(apiPath) });
  await assert.rejects(fetchWorkbuddyLimits({ workbuddyHome: broker.home }), /quota request was rejected/);
});

test("the local connection exposes only the three read-only billing operations", async (t) => {
  const broker = await createWorkbuddyBroker(t);
  const client = await openWorkbuddyIpc({ discovery: readWorkbuddyIpcDiscovery(broker.home) });
  try {
    await assert.rejects(client.postBilling("/billing/meter/daily-checkin", {}), /Unsupported/);
    assert.equal(broker.requests.length, 0);
  } finally { client.close(); }
});

test("discovery parse failures cannot leak ticket contents", async (t) => {
  const broker = await createWorkbuddyBroker(t);
  fs.writeFileSync(broker.discoveryPath, '{"ticket":"secret-ticket" INVALID}');
  assert.throws(() => readWorkbuddyIpcDiscovery(broker.home), (error) => {
    assert.doesNotMatch(error.message, /secret-ticket/);
    return true;
  });
});

test("discovery files must be private regular files on Unix", { skip: process.platform === "win32" }, async (t) => {
  const broker = await createWorkbuddyBroker(t);
  fs.chmodSync(broker.discoveryPath, 0o644);
  assert.throws(() => readWorkbuddyIpcDiscovery(broker.home), /connection information is unavailable/);
  fs.chmodSync(broker.discoveryPath, 0o600);
  const original = broker.discoveryPath + ".original";
  fs.renameSync(broker.discoveryPath, original);
  fs.symlinkSync(original, broker.discoveryPath);
  assert.throws(() => readWorkbuddyIpcDiscovery(broker.home), /connection information is unavailable/);
});
