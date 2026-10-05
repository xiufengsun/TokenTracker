const assert = require("node:assert/strict");
const { test } = require("node:test");

function createStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

async function loadModuleWithStorage(storage) {
  globalThis.localStorage = storage;
  return import("../dashboard/src/lib/cloud-sync-prefs.ts");
}

test("cloud device session stays in memory and clears legacy localStorage", async () => {
  const legacyKey = "tokentracker_cloud_device_session_v1";
  const deviceIdKey = "tokentracker_cloud_device_id_v1";
  const storage = createStorage({
    [deviceIdKey]: "persisted-device-id",
    [legacyKey]: JSON.stringify({
      token: "persisted-token",
      deviceId: "persisted-device",
      issuedAt: "2026-04-20T00:00:00.000Z",
    }),
  });
  const previous = globalThis.localStorage;

  try {
    const mod = await loadModuleWithStorage(storage);

    assert.equal(mod.getStoredDeviceSession(), null);
    assert.equal(storage.getItem(legacyKey), null);
    assert.equal(mod.getCurrentDeviceId(), "persisted-device-id");

    const session = {
      token: "memory-token",
      deviceId: "memory-device",
      issuedAt: "2026-04-20T01:00:00.000Z",
    };

    mod.setStoredDeviceSession(session);
    assert.deepEqual(mod.getStoredDeviceSession(), { ...session, generation: mod.getCloudDeviceSessionGeneration() });
    assert.equal(storage.getItem(legacyKey), null);
    assert.equal(storage.getItem(deviceIdKey), "memory-device");
    assert.equal(mod.getCurrentDeviceId(), "memory-device");
    assert.equal(String(storage.getItem(deviceIdKey)).includes("memory-token"), false);

    mod.clearCloudDeviceSession();
    assert.equal(mod.getStoredDeviceSession(), null);
    assert.equal(mod.getCurrentDeviceId(), "");
    assert.equal(storage.getItem(deviceIdKey), null);
  } finally {
    globalThis.localStorage = previous;
  }
});
