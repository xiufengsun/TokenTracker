import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getOrCreateInsforgeClient, isCloudInsforgeConfigured } from "../lib/insforge-config";
import { clearCloudDeviceSession, setCloudSyncEnabled } from "../lib/cloud-sync-prefs";
import { isLikelyExpiredAccessToken } from "../lib/auth-token";
import { getPublicVisibility } from "../lib/api";
import { clearLocalApiAuthToken, getLocalApiAuthHeaders } from "../lib/local-api-auth";
import { getNativeOAuthBridge, isNativeLinuxApp, isNativeWindowsApp } from "../lib/native-bridge.js";
import { restoreInsforgeUser } from "../lib/insforge-session-recovery.mjs";

const InsforgeAuthContext = createContext(null);

/** Pick a human-readable name from the InsForge user object (OAuth metadata). */
function pickDisplayNameFromUser(user) {
  if (!user || typeof user !== "object") return "";
  const meta = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const prof = user.profile && typeof user.profile === "object" ? user.profile : {};
  const n = meta.full_name || meta.name || prof.name || meta.user_name || meta.preferred_username;
  if (typeof n === "string" && n.trim()) return n.trim();
  if (typeof user.email === "string" && user.email.includes("@")) {
    return user.email.split("@")[0].trim() || user.email.trim();
  }
  return typeof user.email === "string" ? user.email.trim() : "";
}

/** 从 refresh 响应体取 token（SDK 可能只写 http 头、或字段名/嵌套与 saveSession 不一致） */
function accessTokenFromRefreshPayload(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const session = d.session && typeof d.session === "object" ? /** @type {Record<string, unknown>} */ (d.session) : null;
  const raw =
    (typeof d.accessToken === "string" && d.accessToken) ||
    (typeof d.access_token === "string" && d.access_token) ||
    (session && typeof session.accessToken === "string" && session.accessToken) ||
    (session && typeof session.access_token === "string" && session.access_token) ||
    null;
  return raw && raw.length > 0 ? raw : null;
}

export async function resolveInsforgeClientAccessToken(client, options = {}) {
  if (!client) return null;
  const skewMs = Math.max(0, Math.floor(Number(options.skewMs) || 60_000));
  const tm = /** @type {any} */ (client).tokenManager;
  const readToken = () => tm?.getAccessToken?.() ?? tm?.getSession?.()?.accessToken ?? null;
  const firstUsableToken = (...candidates) =>
    candidates.find((candidate) => candidate && !isLikelyExpiredAccessToken(candidate, skewMs)) ?? null;

  let token = readToken();
  if (!token || isLikelyExpiredAccessToken(token, skewMs)) {
    const { data } = await client.auth.refreshSession();
    // Some SDK/storage combinations expose the old token from tokenManager for
    // a short window after refreshSession resolves. Do not let that stale JWT
    // mask the fresh token returned in the refresh payload.
    const refreshedPayloadToken = accessTokenFromRefreshPayload(data);
    token = firstUsableToken(readToken(), refreshedPayloadToken);
    if (!token && typeof client.auth.getCurrentUser === "function") {
      try {
        await client.auth.getCurrentUser();
        token = firstUsableToken(readToken(), refreshedPayloadToken);
      } catch {
        /* ignore */
      }
    }
  }

  return token || null;
}

export function InsforgeAuthProvider({ children }) {
  const [client, setClient] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isCloudInsforgeConfigured()) {
      setClient(null);
      setUser(null);
      setLoading(false);
      return;
    }
    setClient(getOrCreateInsforgeClient());
  }, []);

  useEffect(() => {
    if (!client) return;
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const { data, error } = await restoreInsforgeUser(client.auth, { isActive: () => active });
        if (!active) return;
        if (error) {
          setUser(null);
          return;
        }
        setUser(data?.user ?? null);
      } catch {
        if (active) setUser(null);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const refreshUser = useCallback(async () => {
    if (!client) return;
    try {
      let { data, error } = await client.auth.getCurrentUser();
      if (!error && !data?.user) {
        await new Promise((r) => setTimeout(r, 150));
        const again = await client.auth.getCurrentUser();
        data = again.data;
        error = again.error;
      }
      if (error) {
        setUser(null);
        return;
      }
      setUser(data?.user ?? null);
    } catch {
      setUser(null);
    }
  }, [client]);

  const signInWithOAuth = useCallback(
    async (provider, redirectToOverride) => {
      if (!client) return { error: new Error("InsForge client not configured") };
      const nativeBridge = getNativeOAuthBridge();
      if (nativeBridge) {
        // Native desktop app (macOS WKWebView / Windows WebView2 / Linux Tauri):
        // open the system browser for OAuth. PKCE must be initialized in the same
        // context that handles the callback. The callback MUST land on /auth/callback
        // — only that page relays the code back into the app via tokentracker://.
        //
        // A caller can compute its redirect before the Windows nativeOAuth shim
        // appears, which sends the browser to "/" and the login never completes.
        // Pin /auth/callback for Windows and Linux and ignore redirectToOverride.
        // macOS already passes /auth/callback, so its override is left intact.
        const redirectTo = isNativeWindowsApp() || isNativeLinuxApp()
          ? `${window.location.origin}/auth/callback`
          : typeof redirectToOverride === "string" && redirectToOverride.trim()
            ? redirectToOverride.trim()
            : `${window.location.origin}/auth/callback`;
        const result = await client.auth.signInWithOAuth({
          provider,
          redirectTo,
          // @ts-expect-error - skipBrowserRedirect is supported but not in types
          skipBrowserRedirect: true,
        });
        if (result.data?.url) {
          // Tell the local server that the next /auth/callback is a native app flow.
          // The callback page (in system browser) checks this flag to relay code back to app.
          try {
            const authHeaders = await getLocalApiAuthHeaders();
            await fetch("/api/auth-bridge/verifier", {
              method: "PUT",
              headers: { "Content-Type": "application/json", ...authHeaders },
              body: JSON.stringify({ native: true }),
            });
          } catch {
            // Best effort: native OAuth can still continue without the bridge marker.
          }
          nativeBridge.postMessage(result.data.url);
        }
        return result;
      }
      const redirectTo =
        typeof redirectToOverride === "string" && redirectToOverride.trim()
          ? redirectToOverride.trim()
          : typeof window !== "undefined"
            ? `${window.location.origin}/dashboard`
            : undefined;
      const result = await client.auth.signInWithOAuth({
        provider,
        redirectTo,
      });
      return result;
    },
    [client],
  );

  const signInWithPassword = useCallback(
    async (request) => {
      if (!client) return { data: null, error: new Error("InsForge client not configured") };
      const { data, error } = await client.auth.signInWithPassword(request);
      if (data?.user) setUser(data.user);
      return { data, error };
    },
    [client],
  );

  const signUp = useCallback(
    async (request) => {
      if (!client) return { data: null, error: new Error("InsForge client not configured") };
      const { data, error } = await client.auth.signUp(request);
      if (data?.user && data?.accessToken) setUser(data.user);
      return { data, error };
    },
    [client],
  );

  const sendResetPasswordEmail = useCallback(
    async (request) => {
      if (!client) return { data: null, error: new Error("InsForge client not configured") };
      return client.auth.sendResetPasswordEmail(request);
    },
    [client],
  );

  const exchangeResetPasswordToken = useCallback(
    async (request) => {
      if (!client) return { data: null, error: new Error("InsForge client not configured") };
      return client.auth.exchangeResetPasswordToken(request);
    },
    [client],
  );

  const resetPassword = useCallback(
    async (request) => {
      if (!client) return { data: null, error: new Error("InsForge client not configured") };
      return client.auth.resetPassword(request);
    },
    [client],
  );

  const getPublicAuthConfig = useCallback(async () => {
    if (!client) return { data: null, error: new Error("InsForge client not configured") };
    return client.auth.getPublicAuthConfig();
  }, [client]);

  const signOut = useCallback(async () => {
    if (!client) return;
    await client.auth.signOut();
    clearCloudDeviceSession();
    // Cloud sync requires an authenticated session, so disable it on sign-out.
    // This also keeps signed-out dashboard loads instant: AccountViewContext's
    // `resolving` gate only engages when cloud is the likely scope
    // (expectCloud = authEnabled && (!localHost || cloudSyncOn)); leaving a
    // stale cloudSyncOn=true would briefly gate a logged-out user behind the
    // auth-loading window instead of painting local data immediately.
    setCloudSyncEnabled(false);
    clearLocalApiAuthToken();
    setUser(null);
  }, [client]);

  const getAccessToken = useCallback(async () => {
    return resolveInsforgeClientAccessToken(client);
  }, [client]);

  // Unified display name: cloud custom name > OAuth provider name.
  // Fetched once when user signs in; updated via refreshDisplayName().
  const [cloudDisplayName, setCloudDisplayName] = useState(null);
  const [displayNameResolved, setDisplayNameResolved] = useState(false);
  const authDisplayName = useMemo(() => pickDisplayNameFromUser(user), [user]);

  useEffect(() => {
    if (!user || !client) {
      setCloudDisplayName(null);
      setDisplayNameResolved(false);
      return;
    }
    let active = true;
    (async () => {
      try {
        const token = await resolveInsforgeClientAccessToken(client);
        if (!active || !token) { if (active) setDisplayNameResolved(true); return; }
        const data = await getPublicVisibility({ accessToken: token });
        if (active && data?.display_name) setCloudDisplayName(data.display_name);
      } catch { /* ignore */ }
      if (active) setDisplayNameResolved(true);
    })();
    return () => { active = false; };
  }, [user, client]);

  // Don't flash the OAuth name before cloud name resolves
  const displayName = displayNameResolved
    ? (cloudDisplayName || authDisplayName)
    : "";

  const refreshDisplayName = useCallback(async () => {
    if (!client) return;
    try {
      const token = await resolveInsforgeClientAccessToken(client);
      if (!token) return;
      const data = await getPublicVisibility({ accessToken: token });
      if (data?.display_name) setCloudDisplayName(data.display_name);
    } catch { /* ignore */ }
  }, [client]);

  const value = useMemo(() => {
    if (!isCloudInsforgeConfigured() || !client) {
      return {
        enabled: false,
        client: null,
        user: null,
        signedIn: false,
        loading: false,
        displayName: "",
        refreshUser: async () => {},
        refreshDisplayName: async () => {},
        signInWithOAuth: async () => ({ error: new Error("InsForge not configured") }),
        signInWithPassword: async () => ({ data: null, error: new Error("InsForge not configured") }),
        signUp: async () => ({ data: null, error: new Error("InsForge not configured") }),
        sendResetPasswordEmail: async () => ({ data: null, error: new Error("InsForge not configured") }),
        exchangeResetPasswordToken: async () => ({ data: null, error: new Error("InsForge not configured") }),
        resetPassword: async () => ({ data: null, error: new Error("InsForge not configured") }),
        getPublicAuthConfig: async () => ({ data: null, error: new Error("InsForge not configured") }),
        signOut: async () => {},
        getAccessToken: async () => null,
      };
    }
    return {
      enabled: true,
      client,
      user,
      signedIn: Boolean(user),
      loading,
      displayName,
      refreshUser,
      refreshDisplayName,
      signInWithOAuth,
      signInWithPassword,
      signUp,
      sendResetPasswordEmail,
      exchangeResetPasswordToken,
      resetPassword,
      getPublicAuthConfig,
      signOut,
      getAccessToken,
    };
  }, [
    client,
    user,
    loading,
    displayName,
    refreshUser,
    refreshDisplayName,
    signInWithOAuth,
    signInWithPassword,
    signUp,
    sendResetPasswordEmail,
    exchangeResetPasswordToken,
    resetPassword,
    getPublicAuthConfig,
    signOut,
    getAccessToken,
  ]);

  return <InsforgeAuthContext.Provider value={value}>{children}</InsforgeAuthContext.Provider>;
}

export function useInsforgeAuth() {
  return useContext(InsforgeAuthContext);
}
