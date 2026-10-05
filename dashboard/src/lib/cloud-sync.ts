import { getInsforgeAnonKey, getInsforgeRemoteUrl } from "./insforge-config";
import { functionUrlFor, fetchFunctionResponse } from "./function-url";
import {
  clearCloudDeviceSession,
  emitCloudUsageSynced,
  getCloudUsageReady,
  getCloudSyncEnabled,
  syncCloudSyncPrefToLocalServer,
  getCloudDeviceSessionGeneration,
  getLastCloudSyncTs,
  getStoredDeviceSession,
  emitCloudLeaderboardRefreshed,
  setLastCloudSyncTs,
  setStoredDeviceSession,
  type CloudDeviceSession,
} from "./cloud-sync-prefs";
import { getLocalApiAuthHeaders } from "./local-api-auth";

const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEVICE_TOKEN_ROTATE_AFTER_MS = 12 * 60 * 60 * 1000;
const deviceIssuanceInFlight = new Map<string, Promise<CloudDeviceSession | null>>();

function accessTokenOwner(accessToken: string): string {
  try {
    const payload = JSON.parse(atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof payload.sub === "string" && payload.sub) return payload.sub;
  } catch { /* opaque legacy tokens remain isolated from other credentials */ }
  return `token:${accessToken}`;
}

function isRemoteHttpBase(baseUrl: string): boolean {
  return typeof baseUrl === "string" && /^https?:\/\//i.test(baseUrl.trim());
}

function shouldRotateStoredDeviceSession(
  session: CloudDeviceSession | null,
  nowMs = Date.now(),
): boolean {
  if (!session?.token || !session?.deviceId || !session?.issuedAt) return true;
  const issuedAtMs = Date.parse(session.issuedAt);
  if (!Number.isFinite(issuedAtMs)) return true;
  return issuedAtMs + DEVICE_TOKEN_ROTATE_AFTER_MS <= nowMs;
}

async function triggerLeaderboardRefresh(
  accessToken: string,
  source: "cloud-sync-auto" | "cloud-sync-now",
): Promise<boolean> {
  const baseUrl = getInsforgeRemoteUrl();
  if (!isRemoteHttpBase(baseUrl) || !accessToken) return false;
  const root = baseUrl.replace(/\/$/, "");
  const anon = getInsforgeAnonKey();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  if (anon) headers.apikey = anon;
  // Per-sync refresh is week-only. Month/Total scan tens of thousands of
  // hourly rows each call and burn InsForge Egress (~5 MB per full refresh
  // every 5 min per active user blew through the 5 GB plan). Server-side
  // schedules own the slower-moving month/total snapshots.
  try {
    const response = await fetchFunctionResponse(functionUrlFor(root, "tokentracker-leaderboard-refresh"), {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ period: "week", source }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the stable per-MACHINE id and human-readable system name served by
 * the local CLI (/functions/tokentracker-machine-id, persisted in
 * ~/.tokentracker/.../config.json).
 *
 * Returns null when the local server is unreachable. There is deliberately NO
 * per-browser fallback id anymore: a fallback identity minted a brand-new
 * cloud device for the same physical machine (the cached 12h session then
 * uploaded history under it — the cross-device double-count incident of
 * 2026-06). Upload itself needs the local server anyway
 * (postLocalUsageSync), so when the machine id is unavailable we skip token
 * issuance for this cycle and retry on the next one.
 */
async function resolveMachineIdentity(): Promise<{ machineId: string; deviceName: string | null } | null> {
  try {
    const res = await fetch("/functions/tokentracker-machine-id", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { machineId?: string; deviceName?: string | null } | null;
      const machineId = typeof data?.machineId === "string" ? data.machineId.trim() : null;
      const deviceName = typeof data?.deviceName === "string" && data.deviceName.trim()
        ? data.deviceName.trim().slice(0, 128)
        : null;
      if (machineId && machineId.length >= 8) return { machineId, deviceName };
    }
  } catch {
    /* local server unreachable */
  }
  return null;
}

/**
 * 用当前登录 JWT 向 InsForge 签发 device token，供本地 `tokentracker sync` 上传到云端。
 */
async function issueDeviceTokenForCloud(accessToken: string): Promise<CloudDeviceSession | null> {
  const baseUrl = getInsforgeRemoteUrl();
  if (!isRemoteHttpBase(baseUrl) || !accessToken) return null;
  const root = baseUrl.replace(/\/$/, "");
  const anon = getInsforgeAnonKey();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  if (anon) headers.apikey = anon;
  const platform =
    typeof navigator !== "undefined" && typeof navigator.platform === "string"
      ? navigator.platform
      : "web";
  const identity = await resolveMachineIdentity();
  if (!identity) return null;
  const { machineId } = identity;
  const deviceName = identity.deviceName || `Token Tracker (dashboard) #${machineId.slice(0, 8)}`;
  // 云端 slug 为 tokentracker-device-token-issue（历史文档里的 vibeusage-* 在本项目未部署）
  const res = await fetchFunctionResponse(functionUrlFor(root, "tokentracker-device-token-issue"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      device_name: deviceName,
      platform,
      machine_id: machineId,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    token?: string;
    device_id?: string;
    created_at?: string;
  } | null;
  const token = typeof data?.token === "string" ? data.token : null;
  const deviceId = typeof data?.device_id === "string" ? data.device_id : null;
  if (!token || !deviceId) return null;
  const session: CloudDeviceSession = {
    token,
    deviceId,
    issuedAt: typeof data?.created_at === "string" ? data.created_at : new Date().toISOString(),
  };
  return session;
}

/**
 * 触发本地 CLI `sync`（经 dev server / tokentracker serve），可选覆盖 device token 与云端 baseUrl。
 */
async function postLocalUsageSync(options: {
  deviceToken: string;
  insforgeBaseUrl?: string;
  drain?: boolean;
  isCurrent: () => boolean;
}): Promise<{ ok?: boolean; code?: number; stdout?: string; stderr?: string } | null> {
  const { deviceToken, insforgeBaseUrl, drain } = options;
  const body: Record<string, string | boolean> = { deviceToken };
  if (drain === true) body.drain = true;
  const bu = insforgeBaseUrl || getInsforgeRemoteUrl();
  if (isRemoteHttpBase(bu)) body.insforgeBaseUrl = bu.trim();
  const authHeaders = await getLocalApiAuthHeaders();
  if (!options.isCurrent()) return null;

  const res = await fetch("/functions/tokentracker-local-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status, code: data.code ?? null });
  }
  return data as { ok?: boolean; code?: number; stdout?: string; stderr?: string };
}

async function resolveCloudDeviceSession(getAccessToken: () => Promise<string | null>, ownerId: string): Promise<CloudDeviceSession | null> {
  const accessToken = await getAccessToken();
  if (!getCloudSyncEnabled() || !accessToken || accessTokenOwner(accessToken) !== ownerId) return null;

  let current = getStoredDeviceSession();
  if (current && current.ownerId !== ownerId) {
    clearCloudDeviceSession();
    current = null;
  }
  const generation = getCloudDeviceSessionGeneration();
  if (current && !shouldRotateStoredDeviceSession(current)) {
    return current;
  }

  const key = `${getInsforgeRemoteUrl()}\0${ownerId}\0${generation}`;
  let pending = deviceIssuanceInFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const issued = await issueDeviceTokenForCloud(accessToken);
      if (!issued) return null;
      const latestAccessToken = await getAccessToken();
      if (!latestAccessToken || accessTokenOwner(latestAccessToken) !== ownerId) return null;
      const owned = { ...issued, ownerId, generation };
      return setStoredDeviceSession(owned, generation) ? owned : null;
    })();
    deviceIssuanceInFlight.set(key, pending);
  }
  try {
    return await pending;
  } finally {
    if (deviceIssuanceInFlight.get(key) === pending) deviceIssuanceInFlight.delete(key);
  }
}

async function syncCloudUsageWithRecovery(
  getAccessToken: () => Promise<string | null>,
  options: { drain?: boolean } = {},
): Promise<string | null> {
  let accessToken = await getAccessToken();
  if (!getCloudSyncEnabled() || !accessToken) return null;
  // Persist opt-in before the preference-aware CLI starts; toggles are ordered.
  await syncCloudSyncPrefToLocalServer();
  if (!getCloudSyncEnabled()) return null;
  const ownerId = accessTokenOwner(accessToken);

  let session = await resolveCloudDeviceSession(getAccessToken, ownerId);
  if (!session) return null;
  const isCurrent = () => session?.generation === getCloudDeviceSessionGeneration() &&
    getStoredDeviceSession()?.ownerId === ownerId && getCloudSyncEnabled();
  const currentAccessToken = async () => {
    const token = await getAccessToken();
    return token && accessTokenOwner(token) === ownerId && isCurrent() ? token : null;
  };

  try {
    accessToken = await currentAccessToken();
    if (!accessToken) return null;
    const result = await postLocalUsageSync({
      deviceToken: session.token,
      insforgeBaseUrl: getInsforgeRemoteUrl(),
      drain: options.drain === true,
      isCurrent,
    });
    if (!result || !await currentAccessToken()) return null;
    emitCloudUsageSynced();
    return accessToken;
  } catch (error) {
    if (!await currentAccessToken()) return null;
    if ((error as any)?.code !== "CLOUD_DEVICE_TOKEN_REJECTED") throw error;
    clearCloudDeviceSession();
    accessToken = await getAccessToken();
    if (!accessToken || accessTokenOwner(accessToken) !== ownerId) return null;
    session = await resolveCloudDeviceSession(getAccessToken, ownerId);
    if (!session) return null;
    const result = await postLocalUsageSync({
      deviceToken: session.token,
      insforgeBaseUrl: getInsforgeRemoteUrl(),
      drain: options.drain === true,
      isCurrent,
    });
    if (!result || !await currentAccessToken()) return null;
    emitCloudUsageSynced();
    return accessToken;
  }
}

/**
 * 若开启同步且具备条件：签发（或复用）device token 并运行本地 sync，将 queue 上传到云端。
 */
export async function runCloudUsageSyncIfDue(getAccessToken: () => Promise<string | null>): Promise<void> {
  const last = getLastCloudSyncTs();
  const cloudUsageReady = getCloudUsageReady();
  if (cloudUsageReady && Date.now() - last < MIN_SYNC_INTERVAL_MS) return;

  const accessToken = await syncCloudUsageWithRecovery(getAccessToken, {
    drain: !cloudUsageReady,
  });
  if (!accessToken) return;
  setLastCloudSyncTs(Date.now());
  if (await triggerLeaderboardRefresh(accessToken, "cloud-sync-auto")) {
    emitCloudLeaderboardRefreshed();
  }
}

/** 用户打开「同步到云端」后立即尝试一次（忽略节流） */
export async function runCloudUsageSyncNow(getAccessToken: () => Promise<string | null>): Promise<void> {
  const accessToken = await syncCloudUsageWithRecovery(getAccessToken, { drain: true });
  if (!accessToken) return;
  setLastCloudSyncTs(Date.now());
  if (await triggerLeaderboardRefresh(accessToken, "cloud-sync-now")) {
    emitCloudLeaderboardRefreshed();
  }
}
