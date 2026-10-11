import { createClient } from "@insforge/sdk";
import { functionUrlFor } from "./function-url";
import { validateInsforgeDeployment } from "./insforge-deployment-config.mjs";

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
const PROD_INSFORGE_BASE_URL = "https://srctyff5.us-east.insforge.app";
const PROD_INSFORGE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDU5NDd9.T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY";

export const INSFORGE_INSTANCE_CHANGED_EVENT = "tt.insforgeInstanceChanged";
const INSTANCE_STORAGE_KEY = "tt.insforge.instance";
type RuntimeConfiguration = {
  baseUrl?: string; anonKey?: string; dashboardUrl?: string; configurationError?: string;
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
      return { baseUrl: "", anonKey: "", errorCode: "runtime_configuration_error", source: "runtime" as const };
    }
    return { ...validateInsforgeDeployment({ baseUrl: runtime.baseUrl, anonKey: runtime.anonKey,
      strictPair: true, defaultBaseUrl: PROD_INSFORGE_BASE_URL, defaultAnonKey: PROD_INSFORGE_ANON_KEY }), source: "runtime" as const };
  }
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  return { ...validateInsforgeDeployment({
    baseUrl: env?.VITE_INSFORGE_BASE_URL || env?.VITE_TOKENTRACKER_BACKEND_BASE_URL,
    anonKey: env?.VITE_INSFORGE_ANON_KEY || env?.VITE_TOKENTRACKER_BACKEND_ANON_KEY,
    defaultBaseUrl: PROD_INSFORGE_BASE_URL, defaultAnonKey: PROD_INSFORGE_ANON_KEY,
  }), source: "build" as const };
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
  return getInsforgeConfiguration().baseUrl === PROD_INSFORGE_BASE_URL;
}
export function getInsforgeConnectionHost(): string | null {
  const config = getInsforgeConfiguration();
  if (config.errorCode || config.baseUrl === PROD_INSFORGE_BASE_URL) return null;
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
  if (changed) resetInsforgeClientForInstanceChange();
  try { localStorage.setItem(INSTANCE_STORAGE_KEY, config.baseUrl); } catch { /* Restoration stays conservative. */ }
  const expectedBase = config.baseUrl;
  const markLocalProxy = config.source === "runtime" && localHost();
  insforgeClientSingleton = createClient({
    baseUrl: localHost() ? window.location.origin : config.baseUrl,
    functionsUrl: functionUrlFor(config.baseUrl, "").replace(/\/$/, ""),
    anonKey: config.anonKey,
    auth: { detectOAuthCallback: !changed },
    ...(markLocalProxy ? { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, window.location.origin);
      if (url.origin !== window.location.origin) return fetch(input, init);
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      headers.set("x-tokentracker-instance", expectedBase);
      return fetch(input, { ...init, headers });
    } } : {}),
  });
  clientIdentity = identity;
  return insforgeClientSingleton;
}
