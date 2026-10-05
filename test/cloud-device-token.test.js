"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createCloudDeviceTokenStore } = require("../src/lib/cloud-device-token");

const binding = { userId: "account-a", baseUrl: "https://backend.test", machineId: "machine-a" };

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-device-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "cloud-device-token.json") };
}

test("disk reuse requires the exact owner, API base and machine identity", async (t) => {
  const { dir, file } = await fixture(t);
  assert.equal(createCloudDeviceTokenStore(file).set(binding, "device-a"), true);
  const store = createCloudDeviceTokenStore(file);
  assert.equal(store.get({ ...binding, baseUrl: `${binding.baseUrl}/` }), null);
  assert.equal(store.get({ ...binding, machineId: "machine-b" }), null);
  assert.equal(store.get(binding), "device-a");
  store.invalidate("unrelated-token");
  store.clear({ ...binding, userId: "account-b" });
  assert.equal(store.get(binding), "device-a");
  assert.deepEqual(await fs.readdir(dir), [path.basename(file)]);
  assert.equal(store.get({ ...binding, userId: "account-b" }), null);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("cache read repairs private permissions and matching revocation removes the file", async (t) => {
  const { file } = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ version: 1, ...binding, token: "device-a" }), { mode: 0o644 });
  const store = createCloudDeviceTokenStore(file);
  assert.equal(store.get(binding), "device-a");
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  store.invalidate("device-a");
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("malformed or unbound disk credentials are never reused", async (t) => {
  const { file } = await fixture(t);
  for (const data of ["{", JSON.stringify({ version: 1, token: "unbound-token" })]) {
    await fs.writeFile(file, data);
    assert.equal(createCloudDeviceTokenStore(file).get(binding), null);
  }
});

test("a symlink cache is rejected without reading or chmodding its target", { skip: process.platform === "win32" }, async (t) => {
  const { dir, file } = await fixture(t);
  const target = path.join(dir, "another-owner.json");
  await fs.writeFile(target, JSON.stringify({ version: 1, ...binding, token: "other-token" }), { mode: 0o644 });
  await fs.symlink(target, file);
  assert.equal(createCloudDeviceTokenStore(file).get(binding), null);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
});
