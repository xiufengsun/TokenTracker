import { createClient } from "@insforge/sdk";
import { functionUrlFor } from "./function-url";
import { CLOUDFLARE_API_URL, isOfficialBackend, OFFICIAL_INSFORGE_URL, validateInsforgeDeployment } from "./insforge-deployment-config.mjs";

/**
 * Production InsForge cloud — hardcoded fallback so deployments that don't
 * inject `VITE_INSFORGE_*` at build time (notably the Vercel build for
 * tokentracker.cc) still reach the cloud. Without this, `getInsforgeRemoteUrl`
 * returns "" and every cloud call (leaderboard list, profile modal, OAuth
 * login) silently fails on the public site.
 *
 * Both values are public by design: the anon key is a JWT (role=anon) meant to
 * ship in the browser bundle and also appears in `.github/workflows/*.yml`.
 * (Previously this mistakenly hardcoded the full-access `ik_*` API key, which
 * has admin access and must never reach the frontend.) Explicit env vars still win.
 */
const PROD_INSFORGE_BASE_URL = OFFICIAL_INSFORGE_URL;
const PROD_INSFORGE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDU5NDd9.T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY";

export const INSFORGE_INSTANCE_CHANGED_EVENT = "tt.insforgeInstanceChanged";
const INSTANCE_STORAGE_KEY = "tt.insforge.instance";
type RuntimeConfiguration = {
  baseUrl?: string; anonKey?: string; dashboardUrl?: string; configurationError?: string;
  sessionMigration?: boolean;
  cloudflareReads?: boolean;
};
declare global {
  interface Window { __TOKENTRACKER_RUNTIME_CONFIG__?: RuntimeConfiguration; }
}

function localHost() {
  return typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname);
}
export function getInsforgeConfiguration() {
  const runtime = typeof window === "undefined" ? undefined : window.__TOKENTRACKER_RUNTIME_CONFIG__;
  if (runtime !== undefined) {
    if (!runtime || runtime.configurationError || !runtime.baseUrl) {
      return { baseUrl: "", anonKey: "", errorCode: "runtime_configuration_error", sessionMigration: false, source: "runtime" as const };
    }
    const resolved = validateInsforgeDeployment({ baseUrl: runtime.baseUrl, anonKey: runtime.anonKey,
      strictPair: true, defaultBaseUrl: PROD_INSFORGE_BASE_URL, defaultAnonKey: PROD_INSFORGE_ANON_KEY });
    return { ...resolved, sessionMigration: runtime.sessionMigration === true, source: "runtime" as const };
  }
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  const resolved = validateInsforgeDeployment({
    baseUrl: env?.VITE_INSFORGE_BASE_URL || env?.VITE_TOKENTRACKER_BACKEND_BASE_URL,
    anonKey: env?.VITE_INSFORGE_ANON_KEY || env?.VITE_TOKENTRACKER_BACKEND_ANON_KEY,
    defaultBaseUrl: PROD_INSFORGE_BASE_URL, defaultAnonKey: PROD_INSFORGE_ANON_KEY,
  });
  return { ...resolved, sessionMigration: env?.VITE_TOKENTRACKER_SESSION_MIGRATION === "1", source: "build" as const };
}
export function getInsforgeConfigurationError(): string | null {
  return getInsforgeConfiguration().errorCode;
}
export function getInsforgeRemoteUrl(): string { return getInsforgeConfiguration().baseUrl; }
export function getInsforgeAnonKey(): string { return getInsforgeConfiguration().anonKey; }
export function isCloudInsforgeConfigured(): boolean { return !getInsforgeConfigurationError(); }
export function getInsforgeInstanceFingerprint(): string {
  return getInsforgeConfiguration().baseUrl;
}
export function isOfficialInsforgeInstance(): boolean {
  return isOfficialBackend(getInsforgeConfiguration().baseUrl);
}
export function getInsforgeConnectionHost(): string | null {
  const config = getInsforgeConfiguration();
  if (config.errorCode || isOfficialBackend(config.baseUrl)) return null;
  return new URL(config.baseUrl).host;
}

let insforgeClientSingleton: ReturnType<typeof createClient> | null = null;
let clientIdentity = "";
let restoreBlocked = false;

// The SDK's current session is in memory; PKCE and legacy auth keys belong
// to its own namespace. Provider preferences and local usage are untouched.
function clearSdkBrowserStorage() {
  if (typeof window === "undefined") return;
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[name];
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
      for (const key of keys) {
        if (key && (/^insforge(?:[_:.-]|$)/i.test(key) || key === "tt.cloud.return")) storage.removeItem(key);
      }
    } catch { /* A disabled store cannot retain SDK PKCE for this session. */ }
  }
}
export function resetInsforgeClientForInstanceChange() {
  (insforgeClientSingleton as any)?.tokenManager?.clearSession?.();
  insforgeClientSingleton = null;
  clientIdentity = "";
  restoreBlocked = true;
  clearSdkBrowserStorage();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(INSFORGE_INSTANCE_CHANGED_EVENT));
}
export function shouldRestoreInsforgeSession(): boolean { return !restoreBlocked; }
export function allowInsforgeSessionRestore(): void { restoreBlocked = false; }
export function isCurrentInsforgeClient(client: unknown): boolean {
  const config = getInsforgeConfiguration();
  return !config.errorCode && client === insforgeClientSingleton && clientIdentity === `${config.baseUrl}\0${config.anonKey}`;
}

function createHostedSessionBridge(isActive: () => boolean, done: () => void): typeof fetch {
  let pending = true;
  let inFlight: Promise<Response | null> | null = null;
  let activeExchange: AbortController | null = null;
  const finish = (cancel = true) => {
    pending = false;
    if (cancel) activeExchange?.abort();
    if (isActive()) done();
  };

  async function exchange() {
    const controller = activeExchange = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const { signal } = controller;
    try {
      // Use the original issuer's browser flow so its HttpOnly cookie and CSRF
      // rotation stay with the same SDK and origin.
      const legacy = createClient({
        baseUrl: PROD_INSFORGE_BASE_URL,
        anonKey: PROD_INSFORGE_ANON_KEY,
        auth: { detectOAuthCallback: false },
        fetch: (input, init) => fetch(input, { ...init, signal, redirect: "error" }),
      });
      const { data, error } = await legacy.auth.refreshSession();
      if (error || !data?.accessToken || !pending || !isActive()) return null;
      const result = await fetch(`${CLOUDFLARE_API_URL}/api/auth/session-migrate`, {
        method: "POST", credentials: "include", redirect: "error", cache: "no-store", signal,
        headers: { Authorization: `Bearer ${data.accessToken}`, "Content-Type": "application/json" },
        body: "{}",
      });
      if (!result.ok || !pending || !isActive()) return null;
      finish(false);
      return result;
    } catch {
      // Keep the original session available for a later retry.
      return null;
    } finally {
      clearTimeout(timer);
      activeExchange = null;
    }
  }

  return async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), CLOUDFLARE_API_URL);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const authPost = method === "POST" && url.origin === CLOUDFLARE_API_URL;
    const refresh = authPost && url.pathname === "/api/auth/refresh" && !url.search;
    if (authPost && url.pathname === "/api/auth/logout") {
      finish();
    }
    const response = await fetch(input, init);
    if (authPost && response.ok && (refresh || ["/api/auth/sessions", "/api/auth/oauth/exchange"].includes(url.pathname))) {
      finish();
    }
    if (!refresh || !pending || !isActive() || ![401, 403].includes(response.status)) return response;
    const attempt = inFlight ??= exchange();
    const result = await attempt;
    if (inFlight === attempt) inFlight = null;
    return result?.clone() ?? response;
  };
}

export function getOrCreateInsforgeClient(): ReturnType<typeof createClient> | null {
  const config = getInsforgeConfiguration();
  if (config.errorCode) {
    if (insforgeClientSingleton) resetInsforgeClientForInstanceChange();
    return null;
  }
  const identity = `${config.baseUrl}\0${config.anonKey}`;
  if (insforgeClientSingleton && clientIdentity === identity) return insforgeClientSingleton;
  let previousBase = "";
  try { previousBase = localStorage.getItem(INSTANCE_STORAGE_KEY) || ""; } catch { /* No persisted instance. */ }
  const changed = Boolean((clientIdentity && clientIdentity !== identity) ||
    (previousBase && previousBase !== config.baseUrl) || (!previousBase && config.baseUrl !== PROD_INSFORGE_BASE_URL));
  const sessionMigration = config.sessionMigration === true && config.baseUrl === CLOUDFLARE_API_URL
    && (!previousBase || isOfficialBackend(previousBase));
  if (changed && !sessionMigration) resetInsforgeClientForInstanceChange();
  if (sessionMigration) allowInsforgeSessionRestore();
  const rememberInstance = () => {
    try { localStorage.setItem(INSTANCE_STORAGE_KEY, config.baseUrl); } catch { /* Session cookie stays usable. */ }
  };
  const hasLegacySession = previousBase === PROD_INSFORGE_BASE_URL
    || (!previousBase && typeof document !== "undefined" && /(?:^|;\s*)insforge_csrf_token=/.test(document.cookie));
  const hostedExchange = sessionMigration && hasLegacySession
    && typeof window !== "undefined" && window.location.origin === "https://www.tokentracker.cc";
  if (!hostedExchange) rememberInstance();
  const expectedBase = config.baseUrl;
  const markLocalProxy = config.source === "runtime" && localHost();
  insforgeClientSingleton = createClient({
    baseUrl: localHost() ? window.location.origin : config.baseUrl,
    functionsUrl: functionUrlFor(config.baseUrl, "").replace(/\/$/, ""),
    anonKey: config.anonKey,
    auth: { detectOAuthCallback: !changed || sessionMigration },
    ...(markLocalProxy ? { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, window.location.origin);
      if (url.origin !== window.location.origin) return fetch(input, init);
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      headers.set("x-tokentracker-instance", expectedBase);
      return fetch(input, { ...init, headers });
    } } : hostedExchange ? { fetch: createHostedSessionBridge(
      () => clientIdentity === identity && getInsforgeRemoteUrl() === CLOUDFLARE_API_URL,
      rememberInstance,
    ) } : {}),
  });
  clientIdentity = identity;
  return insforgeClientSingleton;
}
