const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createAccount, bindIdentity } = require("../src/lib/subscription-accounts");
const { quotaAvailability, runAccountPool } = require("../src/lib/subscription-account-pool");

async function pool(t) {
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-account-pool-"));
  t.after(() => fs.rm(trackerDir, { recursive: true, force: true }));
  for (const label of ["A", "B", "C"]) {
    const a = await createAccount({ trackerDir, provider: "codex", label });
    await bindIdentity({ trackerDir, id: a.id, identity: { key: label } });
  }
  const report = () => {};
  return { trackerDir, provider: "codex", report };
}

test("quota availability rejects stale/unknown windows and waits for every exhausted window", () => {
  const now = Date.now();
  assert.equal(quotaAvailability("codex", { status: "ok" }).state, "unknown");
  assert.equal(quotaAvailability("codex", { status: "ok", stale: true, primary_window: { used_percent: 0 } }).state, "unknown");
  assert.equal(quotaAvailability("claude", { status: "ok", five_hour: { utilization: 20, resets_at: new Date(now - 1).toISOString() } }, now).state, "unknown");
  const result = quotaAvailability("codex", { status: "ok", primary_window: { used_percent: 100, reset_at: 4000000000 }, secondary_window: { used_percent: 100, reset_at: 4000100000 } });
  assert.equal(result.state, "exhausted"); assert.equal(result.resetAt, 4000100000000);
});

test("a three-account pool skips exhaustion and moves on only after verified exhaustion", async (t) => {
  const f = await pool(t);
  const checks = new Map(), launches = [];
  const ids = new Map();
  const probe = async ({ account }) => {
    ids.set(account.id, account.label);
    const count = (checks.get(account.label) || 0) + 1; checks.set(account.label, count);
    return { state: account.label === "A" || (account.label === "B" && count > 1) ? "exhausted" : "available" };
  };
  const result = await runAccountPool({ ...f, probe, launch: async ({ id }) => { launches.push(ids.get(id)); return ids.get(id) === "B" ? 1 : 0; } });
  assert.equal(result, 0); assert.deepEqual(launches, ["B", "C"]);
});

for (const status of [0, 130, 143]) {
  test(`exit ${status} stops rotation without probing or launching another account`, async (t) => {
    const f = await pool(t); let launches = 0, probes = 0;
    const result = await runAccountPool({ ...f, probe: async () => { probes++; return { state: "available" }; }, launch: async () => { launches++; return status; } });
    assert.equal(result, status); assert.equal(launches, 1); assert.equal(probes, 1);
  });
}

test("generic CLI errors and unavailable post-exit quota never cause a switch", async (t) => {
  const f = await pool(t); let launches = 0;
  const result = await runAccountPool({ ...f, probe: async () => ({ state: launches ? "unknown" : "available" }), launch: async () => { launches++; return 2; } });
  assert.equal(result, 2); assert.equal(launches, 1);
});

test("unknown or exhausted pools launch nothing and do not loop", async (t) => {
  const f = await pool(t); let probes = 0;
  const result = await runAccountPool({ ...f, probe: async () => { probes++; return { state: "unknown" }; }, launch: async () => { throw new Error("must not run"); } });
  assert.equal(result, 1); assert.equal(probes, 3);
});

test("next-launch-only mode stops after its chosen account exits", async (t) => {
  const f = await pool(t); let probes = 0;
  const result = await runAccountPool({ ...f, nextLaunchOnly: true, probe: async () => { probes++; return { state: "available" }; }, launch: async () => 1 });
  assert.equal(result, 1); assert.equal(probes, 1);
});
