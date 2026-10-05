import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_LEADERBOARD_REFRESHED_EVENT,
  clearCloudDeviceSession,
  getCloudUsageReady,
  setCloudUsageReady,
} from "./cloud-sync-prefs";
import { runCloudUsageSyncIfDue, runCloudUsageSyncNow } from "./cloud-sync";

vi.mock("./insforge-config", () => ({
  getInsforgeAnonKey: () => "anon-key",
  getInsforgeRemoteUrl: () => "https://cloud.example",
}));

vi.mock("./local-api-auth", () => ({
  getLocalApiAuthHeaders: async () => ({ "x-tokentracker-local-auth": "local-token" }),
}));

function okJson(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
  } as Response;
}

function installFetchMock(options: { leaderboardOk?: boolean } = {}) {
  const leaderboardOk = options.leaderboardOk ?? true;
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/functions/tokentracker-cloud-sync-pref") return okJson({ ok: true });
    if (url === "/functions/tokentracker-machine-id") {
      return okJson({ machineId: "machine-abcdef12", deviceName: "office-win" });
    }
    if (url === "https://cloud.example/functions/tokentracker-device-token-issue") {
      return okJson({
        token: "device-token",
        device_id: "device-id",
        created_at: new Date().toISOString(),
      });
    }
    if (url === "/functions/tokentracker-local-sync") {
      return okJson({ ok: true });
    }
    if (url === "https://cloud.example/functions/tokentracker-leaderboard-refresh") {
      return {
        ok: leaderboardOk,
        status: leaderboardOk ? 200 : 403,
        json: async () => ({ ok: leaderboardOk }),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function getLocalSyncBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url]) => url === "/functions/tokentracker-local-sync");
  expect(call).toBeTruthy();
  const init = call?.[1] as RequestInit | undefined;
  expect(init?.method).toBe("POST");
  return JSON.parse(String(init?.body));
}

function installLocalStorageMock() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  });
}

describe("cloud usage sync", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installLocalStorageMock();
    localStorage.setItem("tokentracker_cloud_sync_enabled", "1");
    clearCloudDeviceSession();
  });

  it("sends drain for manual sync", async () => {
    const fetchMock = installFetchMock();
    const onSynced = vi.fn();
    window.addEventListener("tt.cloudUsageSynced", onSynced);

    await runCloudUsageSyncNow(async () => "access-token");

    expect(getLocalSyncBody(fetchMock)).toMatchObject({
      deviceToken: "device-token",
      drain: true,
      insforgeBaseUrl: "https://cloud.example",
    });
    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.find(([url]) => url === "https://cloud.example/functions/tokentracker-leaderboard-refresh")?.[1])
      .toMatchObject({ cache: "no-store" });
    window.removeEventListener("tt.cloudUsageSynced", onSynced);
  });

  it("sends the local system name separately from the stable machine id", async () => {
    const fetchMock = installFetchMock();

    await runCloudUsageSyncNow(async () => "access-token");

    const issueCall = fetchMock.mock.calls.find(([url]) => url === "https://cloud.example/functions/tokentracker-device-token-issue");
    expect(issueCall).toBeTruthy();
    const issueBody = JSON.parse(String((issueCall?.[1] as RequestInit | undefined)?.body));
    expect(issueBody).toMatchObject({
      device_name: "office-win",
      machine_id: "machine-abcdef12",
    });
  });

  it("drains the full queue before the first scheduled cloud view becomes ready", async () => {
    const fetchMock = installFetchMock();
    const onSynced = vi.fn();
    const onLeaderboardRefresh = vi.fn();
    window.addEventListener("tt.cloudUsageSynced", onSynced);
    window.addEventListener(CLOUD_LEADERBOARD_REFRESHED_EVENT, onLeaderboardRefresh);

    await runCloudUsageSyncIfDue(async () => "access-token");

    expect(getLocalSyncBody(fetchMock)).toEqual({
      deviceToken: "device-token",
      drain: true,
      insforgeBaseUrl: "https://cloud.example",
    });
    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(onLeaderboardRefresh).toHaveBeenCalledTimes(1);
    expect(getCloudUsageReady()).toBe(true);
    window.removeEventListener("tt.cloudUsageSynced", onSynced);
    window.removeEventListener(CLOUD_LEADERBOARD_REFRESHED_EVENT, onLeaderboardRefresh);
  });

  it("does not announce a leaderboard refresh when the refresh endpoint fails", async () => {
    installFetchMock({ leaderboardOk: false });
    const onLeaderboardRefresh = vi.fn();
    window.addEventListener(CLOUD_LEADERBOARD_REFRESHED_EVENT, onLeaderboardRefresh);

    await runCloudUsageSyncNow(async () => "access-token");

    expect(onLeaderboardRefresh).not.toHaveBeenCalled();
    window.removeEventListener(CLOUD_LEADERBOARD_REFRESHED_EVENT, onLeaderboardRefresh);
  });

  it("keeps scheduled sync lightweight after cloud usage is ready", async () => {
    setCloudUsageReady(true);
    const fetchMock = installFetchMock();

    await runCloudUsageSyncIfDue(async () => "access-token");

    expect(getLocalSyncBody(fetchMock)).toEqual({
      deviceToken: "device-token",
      insforgeBaseUrl: "https://cloud.example",
    });
  });
});

function ownerJwt(owner: string, nonce = 1) {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256" })}.${encode({ sub: owner, nonce })}.signature`;
}

describe("cloud device session ownership", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installLocalStorageMock();
    localStorage.setItem("tokentracker_cloud_sync_enabled", "1");
    clearCloudDeviceSession();
  });

  it("drops delayed issuance after sign-out and issues the new owner's token", async () => {
    let accessToken = ownerJwt("user-a");
    let release!: (value: Response) => void;
    let started!: () => void;
    const issued = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const postTokens: string[] = [];
    let issues = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/functions/tokentracker-machine-id") return okJson({ machineId: "machine-12345678" });
      if (url.endsWith("tokentracker-device-token-issue")) {
        issues += 1;
        if (issues === 1) { started(); return pending; }
        return okJson({ token: "token-b", device_id: "device-b", created_at: new Date().toISOString() });
      }
      if (url === "/functions/tokentracker-local-sync") {
        postTokens.push(JSON.parse(String(init?.body)).deviceToken);
        return okJson({ ok: true });
      }
      return okJson({ ok: true });
    }));
    const old = runCloudUsageSyncNow(async () => accessToken);
    await issued;
    clearCloudDeviceSession();
    accessToken = ownerJwt("user-b");
    release(okJson({ token: "token-a", device_id: "device-a", created_at: new Date().toISOString() }));
    await old;
    expect(postTokens).toEqual([]);
    await runCloudUsageSyncNow(async () => accessToken);
    expect(issues).toBe(2);
    expect(postTokens).toEqual(["token-b"]);
  });

  it("shares issuance for concurrent sync requests of one owner and epoch", async () => {
    const fetchMock = installFetchMock();
    await Promise.all([
      runCloudUsageSyncNow(async () => ownerJwt("user-a")),
      runCloudUsageSyncNow(async () => ownerJwt("user-a")),
    ]);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("tokentracker-device-token-issue"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/functions/tokentracker-local-sync")).toHaveLength(2);
  });

  it("keeps the device credential when an access token rotates for the same owner", async () => {
    const fetchMock = installFetchMock();
    let accessToken = ownerJwt("user-a");
    await runCloudUsageSyncNow(async () => accessToken);
    accessToken = ownerJwt("user-a", 2);
    await runCloudUsageSyncNow(async () => accessToken);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("tokentracker-device-token-issue"))).toHaveLength(1);
  });

  it("turning cloud sync off cancels pending issuance before any upload", async () => {
    const { setCloudSyncEnabled, getStoredDeviceSession } = await import("./cloud-sync-prefs");
    let release!: (value: Response) => void;
    let started!: () => void;
    const issued = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/functions/tokentracker-machine-id") return okJson({ machineId: "machine-12345678" });
      if (url.endsWith("tokentracker-device-token-issue")) { started(); return pending; }
      return okJson({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const old = runCloudUsageSyncNow(async () => ownerJwt("user-a"));
    await issued;
    setCloudSyncEnabled(false);
    release(okJson({ token: "token-a", device_id: "device-a", created_at: new Date().toISOString() }));
    await old;
    expect(fetchMock.mock.calls.filter(([url]) => url === "/functions/tokentracker-local-sync")).toHaveLength(0);
    expect(getStoredDeviceSession()).toBeNull();
  });

  for (const code of ["CLOUD_UPLOAD_FAILED", "SYNC_BUSY", "SYNC_UPLOAD_BACKOFF", "CLOUD_UPLOAD_FORBIDDEN"]) {
    it(`retains an existing credential on ${code}`, async () => {
      const { setStoredDeviceSession, getStoredDeviceSession } = await import("./cloud-sync-prefs");
      setStoredDeviceSession({ token: "previous-valid-token", deviceId: "device-a", issuedAt: new Date().toISOString(), ownerId: "user-a" });
      const fetchMock = vi.fn(async (_url: string) => ({ ok: false, status: code === "CLOUD_UPLOAD_FORBIDDEN" ? 403 : 503, json: async () => ({ error: "temporary or policy failure", code }) }) as Response);
      vi.stubGlobal("fetch", fetchMock);
      await expect(runCloudUsageSyncNow(async () => ownerJwt("user-a"))).rejects.toMatchObject({ code });
      expect(fetchMock.mock.calls.filter(([url]) => url === "/functions/tokentracker-local-sync")).toHaveLength(1);
      expect(getStoredDeviceSession()?.token).toBe("previous-valid-token");
    });
  }

  it("reissues only an explicitly rejected device credential", async () => {
    const { setStoredDeviceSession } = await import("./cloud-sync-prefs");
    setStoredDeviceSession({ token: "revoked-token", deviceId: "device-a", issuedAt: new Date().toISOString(), ownerId: "user-a" });
    const posted: string[] = [];
    let issues = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/functions/tokentracker-machine-id") return okJson({ machineId: "machine-12345678" });
      if (url.endsWith("tokentracker-device-token-issue")) {
        issues += 1;
        return okJson({ token: "fresh-token", device_id: "device-a", created_at: new Date().toISOString() });
      }
      if (url === "/functions/tokentracker-local-sync") {
        const token = JSON.parse(String(init?.body)).deviceToken;
        posted.push(token);
        if (token === "revoked-token") return { ok: false, status: 401, json: async () => ({ error: "Unauthorized", code: "CLOUD_DEVICE_TOKEN_REJECTED" }) } as Response;
      }
      return okJson({ ok: true });
    }));
    await runCloudUsageSyncNow(async () => ownerJwt("user-a"));
    expect(issues).toBe(1);
    expect(posted).toEqual(["revoked-token", "fresh-token"]);
  });
});
