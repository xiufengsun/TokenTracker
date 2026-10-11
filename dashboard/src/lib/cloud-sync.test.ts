import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCloudDeviceSession, getCloudUsageReady, getStoredDeviceSession, setCloudUsageReady, setStoredDeviceSession, setCloudSyncEnabled, setLastCloudSyncTs, getLastCloudSyncTs } from "./cloud-sync-prefs";
import { runCloudUsageSyncIfDue, runCloudUsageSyncNow } from "./cloud-sync";
vi.mock("./insforge-config", () => ({ getInsforgeRemoteUrl: () => "https://cloud.example" }));
vi.mock("./local-api-auth", () => ({ getLocalApiAuthHeaders: async () => ({ "x-tokentracker-local-auth": "local-token" }) }));
const ownerJwt = (owner: string, nonce = 1) => `e30.${btoa(JSON.stringify({ sub: owner, nonce }))}.sig`;
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
const issued = (id = "local-session") => response({ session_id: id, device_id: "device-id", created_at: new Date().toISOString() });
function setupFetch(syncResult: unknown = { ok: true, uploaded: true }) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/functions/tokentracker-cloud-sync-pref") return response({ ok: true });
    if (url === "/functions/tokentracker-cloud-session") return JSON.parse(String(init?.body)).clear ? response({ ok: true }) : issued();
    if (url === "/functions/tokentracker-local-sync") return response(syncResult);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
function uploads(mock: ReturnType<typeof vi.fn>) { return mock.mock.calls.filter(([url]) => url === "/functions/tokentracker-local-sync"); }
function bridges(mock: ReturnType<typeof vi.fn>) { return mock.mock.calls.filter(([url, init]) => url === "/functions/tokentracker-cloud-session" && !JSON.parse(String(init?.body)).clear); }
function uploadBody(mock: ReturnType<typeof vi.fn>) { return JSON.parse(String(uploads(mock)[0]?.[1]?.body)); }
beforeEach(() => { vi.unstubAllGlobals(); localStorage.clear(); localStorage.setItem("tokentracker_cloud_sync_enabled", "1"); clearCloudDeviceSession(); });

describe("Cloud local bridge", () => {
  it("mirrors the saved opt-in before creating a local session or uploading", async () => {
    const mock = setupFetch();
    await runCloudUsageSyncNow(async () => ownerJwt("user-a"));
    expect(mock.mock.calls[0][0]).toBe("/functions/tokentracker-cloud-sync-pref");
    expect(JSON.parse(String(mock.mock.calls[0][1]?.body))).toMatchObject({ enabled: true });
    expect(bridges(mock)).toHaveLength(1);
    expect(uploads(mock)).toHaveLength(1);
  });
  it.each(["0", null])("does not create a session or upload without explicit opt-in %s", async (preference) => {
    if (preference === null) localStorage.removeItem("tokentracker_cloud_sync_enabled");
    else localStorage.setItem("tokentracker_cloud_sync_enabled", preference);
    const mock = setupFetch();
    await runCloudUsageSyncNow(async () => ownerJwt("user-a"));
    await runCloudUsageSyncIfDue(async () => ownerJwt("user-a"));
    expect(bridges(mock)).toHaveLength(0);
    expect(uploads(mock)).toHaveLength(0);
  });
  it("proves the current JWT through the local bridge and posts only its owned session handle", async () => {
    const mock = setupFetch();
    await runCloudUsageSyncNow(async () => ownerJwt("user-a"));
    expect(bridges(mock)).toHaveLength(1);
    expect(bridges(mock)[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${ownerJwt("user-a")}`, "x-tokentracker-local-auth": "local-token" });
    expect(JSON.parse(String(bridges(mock)[0][1]?.body))).toEqual({ expectedOwnerId: "user-a", insforgeBaseUrl: "https://cloud.example" });
    expect(uploadBody(mock)).toEqual({ cloudSessionId: "local-session", expectedOwnerId: "user-a", insforgeBaseUrl: "https://cloud.example", drain: true, recheckCloudAccess: true });
    expect(uploadBody(mock).deviceToken).toBeUndefined();
    expect(getCloudUsageReady()).toBe(true);
    expect(mock.mock.calls.some(([url]) => String(url).includes("leaderboard-refresh"))).toBe(false);
  });
  it("drains the first automatic upload and marks later uploads as automatic", async () => {
    const mock = setupFetch();
    await runCloudUsageSyncIfDue(async () => ownerJwt("user-a"));
    expect(uploadBody(mock)).toMatchObject({ drain: true, auto: true });
    expect(uploadBody(mock).recheckCloudAccess).toBeUndefined();
    setLastCloudSyncTs(0);
    await runCloudUsageSyncIfDue(async () => ownerJwt("user-a"));
    expect(JSON.parse(String(uploads(mock)[1][1]?.body))).toEqual({ cloudSessionId: "local-session", expectedOwnerId: "user-a", insforgeBaseUrl: "https://cloud.example", auto: true });
  });
  it("suppresses automatic uploads for fifteen minutes while manual sync may recheck", async () => {
    const mock = setupFetch();
    await runCloudUsageSyncIfDue(async () => ownerJwt("user-a"));
    await runCloudUsageSyncIfDue(async () => ownerJwt("user-a"));
    expect(uploads(mock)).toHaveLength(1);
    await runCloudUsageSyncNow(async () => ownerJwt("user-a"));
    expect(uploads(mock)).toHaveLength(2);
  });
  it("honors the server's longer deadline and does not announce success for an unchanged queue", async () => {
    const mock = setupFetch({ ok: true, uploaded: false, pending: true, next_allowed_at: new Date(Date.now() + 86400_000).toISOString() });
    const onSynced = vi.fn(); window.addEventListener("tt.cloudUsageSynced", onSynced);
    await runCloudUsageSyncIfDue(async () => ownerJwt("user-a"));
    await runCloudUsageSyncIfDue(async () => ownerJwt("user-a"));
    expect(uploads(mock)).toHaveLength(1); expect(onSynced).not.toHaveBeenCalled(); expect(getCloudUsageReady()).toBe(false);
    window.removeEventListener("tt.cloudUsageSynced", onSynced);
  });
  it("keeps a daily denial deadline even before the first upload is ready", async () => {
    const mock = vi.fn(async (url: string) => url.endsWith("cloud-session") ? issued() : response({ code: "cloud_sync_throttled", next_allowed_at: new Date(Date.now() + 86400_000).toISOString() }, 429));
    vi.stubGlobal("fetch", mock);
    await expect(runCloudUsageSyncIfDue(async () => ownerJwt("user-a"))).rejects.toMatchObject({ status: 429, code: "cloud_sync_throttled" });
    await runCloudUsageSyncIfDue(async () => ownerJwt("user-a")); expect(uploads(mock)).toHaveLength(1);
  });
  it("shares owner proof for concurrent requests and retains it through JWT rotation", async () => {
    const mock = setupFetch();
    await Promise.all([runCloudUsageSyncNow(async () => ownerJwt("user-a")), runCloudUsageSyncNow(async () => ownerJwt("user-a"))]);
    expect(bridges(mock)).toHaveLength(1);
    await runCloudUsageSyncNow(async () => ownerJwt("user-a", 2)); expect(bridges(mock)).toHaveLength(1);
  });
  it("drops a delayed bridge after logout without posting the old account handle", async () => {
    let token = ownerJwt("user-a"); let release!: (r: Response) => void; let started!: () => void;
    const seen = new Promise<void>(r => { started = r; }); const pending = new Promise<Response>(r => { release = r; }); let count = 0;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("cloud-session")) { if (JSON.parse(String(init?.body)).clear) return response({ ok: true }); count += 1; if (count === 1) { started(); return pending; } return issued("session-b"); }
      return response({ ok: true, uploaded: true });
    }); vi.stubGlobal("fetch", mock);
    const old = runCloudUsageSyncNow(async () => token); await seen; clearCloudDeviceSession(); token = ownerJwt("user-b"); release(issued("session-a")); await old;
    expect(uploads(mock)).toHaveLength(0); await runCloudUsageSyncNow(async () => token);
    expect(uploadBody(mock).cloudSessionId).toBe("session-b"); expect(getStoredDeviceSession()?.ownerId).toBe("user-b");
  });
  it("cloud sync off cancels pending owner proof before any upload", async () => {
    let release!: (r: Response) => void; let started!: () => void; const seen = new Promise<void>(r => { started = r; }); const pending = new Promise<Response>(r => { release = r; });
    const mock = vi.fn(async (url: string) => { if (url.endsWith("cloud-session")) { started(); return pending; } return response({ ok: true }); }); vi.stubGlobal("fetch", mock);
    const old = runCloudUsageSyncNow(async () => ownerJwt("user-a")); await seen; setCloudSyncEnabled(false); release(issued()); await old;
    expect(uploads(mock)).toHaveLength(0); expect(getStoredDeviceSession()).toBeNull();
  });
  for (const code of ["CLOUD_UPLOAD_FAILED", "SYNC_BUSY", "SYNC_UPLOAD_BACKOFF", "CLOUD_UPLOAD_FORBIDDEN", "cloud_machine_paused", "cloud_membership_required"]) {
    it(`keeps the account binding and local readiness on ${code}`, async () => {
      setStoredDeviceSession({ localSessionId: "existing-handle", deviceId: "device-id", issuedAt: new Date().toISOString(), ownerId: "user-a" }); setCloudUsageReady(true);
      const mock = vi.fn(async () => response({ error: "temporary or policy failure", code }, 403)); vi.stubGlobal("fetch", mock);
      await expect(runCloudUsageSyncNow(async () => ownerJwt("user-a"))).rejects.toMatchObject({ code });
      expect(getStoredDeviceSession()?.localSessionId).toBe("existing-handle"); expect(getCloudUsageReady()).toBe(true); expect(bridges(mock)).toHaveLength(0);
    });
  }
  it("proves ownership again after the server invalidates a stale handle", async () => {
    setStoredDeviceSession({ localSessionId: "stale-handle", deviceId: "device-id", issuedAt: new Date().toISOString(), ownerId: "user-a" });
    const mock = vi.fn(async (url: string, init?: RequestInit) => { if (url.endsWith("cloud-session")) return issued("fresh-handle"); const body = JSON.parse(String(init?.body)); return body.cloudSessionId === "stale-handle" ? response({ code: "auth_session_changed" }, 409) : response({ ok: true, uploaded: true }); }); vi.stubGlobal("fetch", mock);
    await runCloudUsageSyncNow(async () => ownerJwt("user-a")); expect(bridges(mock)).toHaveLength(1);
    expect(uploads(mock).map(call => JSON.parse(String(call[1]?.body)).cloudSessionId)).toEqual(["stale-handle", "fresh-handle"]);
  });
  it("malformed JWTs cannot fall back to another local account", async () => { const mock = setupFetch(); await runCloudUsageSyncNow(async () => "not-a-jwt"); expect(bridges(mock)).toHaveLength(0); expect(uploads(mock)).toHaveLength(0); });
  it("an empty successful manual drain cannot announce initial Cloud readiness", async () => {
    const mock = setupFetch({ ok: true, uploaded: false, pending: false });
    const onSynced = vi.fn(); window.addEventListener("tt.cloudUsageSynced", onSynced);
    await runCloudUsageSyncNow(async () => ownerJwt("user-a"));
    expect(uploads(mock)).toHaveLength(1); expect(getCloudUsageReady()).toBe(false);
    expect(onSynced).not.toHaveBeenCalled(); expect(getLastCloudSyncTs()).toBe(0);
    window.removeEventListener("tt.cloudUsageSynced", onSynced);
  });

});
