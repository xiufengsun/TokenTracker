import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  emitCloudUsageSynced,
  getCloudSyncEnabled,
  getCloudUsageReady,
  setCloudSyncEnabled,
  setCloudUsageReady,
  syncCloudSyncPrefToLocalServer,
} from "./cloud-sync-prefs";

vi.mock("./local-api-auth", () => ({ getLocalApiAuthHeaders: async () => ({}) }));

const KEY_ENABLED = "tokentracker_cloud_sync_enabled";

describe("getCloudSyncEnabled default", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to disabled when the preference was never set", () => {
    expect(getCloudSyncEnabled()).toBe(false);
  });

  it.each(["", "garbage", "null", "false", "0"])("fails closed for %j", (value) => {
    localStorage.setItem(KEY_ENABLED, value);
    expect(getCloudSyncEnabled()).toBe(false);
  });

  it("fails closed when storage cannot be read", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    try {
      expect(getCloudSyncEnabled()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("respects an explicit opt-out", () => {
    localStorage.setItem(KEY_ENABLED, "0");
    expect(getCloudSyncEnabled()).toBe(false);
  });

  it("keeps an explicit opt-in", () => {
    localStorage.setItem(KEY_ENABLED, "1");
    expect(getCloudSyncEnabled()).toBe(true);
  });

  it("keeps the legacy explicit true opt-in", () => {
    localStorage.setItem(KEY_ENABLED, "true");
    expect(getCloudSyncEnabled()).toBe(true);
  });
});

describe("cloud usage readiness", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to not ready until the first upload completes", () => {
    expect(getCloudUsageReady()).toBe(false);
  });

  it("persists readiness when cloud upload completes", () => {
    emitCloudUsageSynced();
    expect(getCloudUsageReady()).toBe(true);
  });

  it("clears readiness when cloud sync is disabled", () => {
    setCloudUsageReady(true);
    setCloudSyncEnabled(false);
    expect(getCloudUsageReady()).toBe(false);
  });
});

it("keeps a delayed opt-in mirror ahead of a later opt-out", async () => {
  await syncCloudSyncPrefToLocalServer();
  let completeFirst!: () => void;
  const first = new Promise<void>((resolve) => { completeFirst = resolve; });
  const mirrored: boolean[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    mirrored.push(JSON.parse(init.body).enabled);
    if (mirrored.length === 1) await first;
    return { ok: true };
  }));
  try {
    setCloudSyncEnabled(true);
    await vi.waitFor(() => expect(mirrored).toEqual([true]));
    setCloudSyncEnabled(false);
    await Promise.resolve();
    expect(mirrored).toEqual([true]);
    completeFirst();
    await syncCloudSyncPrefToLocalServer();
    expect(mirrored).toEqual([true, false, false]);
    expect(getCloudSyncEnabled()).toBe(false);
  } finally {
    completeFirst();
    vi.unstubAllGlobals();
  }
});

it("a hung mirror times out so a later opt-out can be persisted", async () => {
  await syncCloudSyncPrefToLocalServer();
  vi.useFakeTimers();
  const mirrored: boolean[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    mirrored.push(JSON.parse(init.body).enabled);
    if (mirrored.length === 1) {
      await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return { ok: true };
  }));
  try {
    setCloudSyncEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    setCloudSyncEnabled(false);
    await vi.advanceTimersByTimeAsync(5000);
    await syncCloudSyncPrefToLocalServer();
    expect(mirrored).toEqual([true, false, false]);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
