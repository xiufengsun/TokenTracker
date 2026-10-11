import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  allowInsforgeSessionRestore,
  getInsforgeConfigurationError,
  getInsforgeConnectionHost,
  getOrCreateInsforgeClient,
  INSFORGE_INSTANCE_CHANGED_EVENT,
  isCloudInsforgeConfigured,
  isCurrentInsforgeClient,
  isOfficialInsforgeInstance,
  shouldRestoreInsforgeSession,
} from "../lib/insforge-config";
import { clearCloudDeviceSession, setCloudUsageReady } from "../lib/cloud-sync-prefs";
import { isLikelyExpiredAccessToken } from "../lib/auth-token";
import { getPublicVisibility, invalidateAccountResponseCache } from "../lib/api";
import { clearLocalApiAuthToken } from "../lib/local-api-auth";
import { copy } from "../lib/copy";
import { getNativeOAuthBridge, isNativeApp, isNativeEmbed, isNativeLinuxApp, isNativeWindowsApp } from "../lib/native-bridge.js";
import { restoreInsforgeUser } from "../lib/insforge-session-recovery.mjs";
import { clearCloudPromptBackendState, cloudPromptOwnerFromToken } from "../lib/cloud-prompt-policy.js";

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
    const changed = () => {
      setUser(null);
      setClient(null);
      setLoading(false);
      invalidateAccountResponseCache();
      clearCloudDeviceSession();
      clearLocalApiAuthToken();
      clearCloudPromptBackendState();
    };
    window.addEventListener(INSFORGE_INSTANCE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(INSFORGE_INSTANCE_CHANGED_EVENT, changed);
  }, []);

  useEffect(() => {
    invalidateAccountResponseCache();
  }, [user?.id]);

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
    if (!shouldRestoreInsforgeSession()) {
      setUser(null);
      setLoading(false);
      return;
    }
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
    if (!client || !isCurrentInsforgeClient(client)) return;
    try {
      let { data, error } = await client.auth.getCurrentUser();
      if (!error && !data?.user) {
        await new Promise((r) => setTimeout(r, 150));
        const again = await client.auth.getCurrentUser();
        data = again.data;
        error = again.error;
      }
      if (error) {
        if (isCurrentInsforgeClient(client)) setUser(null);
        return;
      }
      if (isCurrentInsforgeClient(client)) setUser(data?.user ?? null);
    } catch {
      if (isCurrentInsforgeClient(client)) setUser(null);
    }
  }, [client]);

  const signInWithOAuth = useCallback(
    async (provider, redirectToOverride) => {
      if (!client || !isCurrentInsforgeClient(client)) return { error: new Error(copy("instance.configuration.changed")) };
      const nativeBridge = getNativeOAuthBridge();
      if (typeof nativeBridge?.postMessage !== "function"
        && (isNativeApp() || isNativeEmbed() || isNativeWindowsApp() || isNativeLinuxApp())) {
        return { error: new Error(copy("login.oauth.desktop_start_failed")) };
      }
      if (nativeBridge) {
        // The native receiver returns the code to this WebView's current local
        // origin. PKCE stays here; self-hosted codes never visit a hosted relay.
        const result = await client.auth.signInWithOAuth({
          provider,
          redirectTo: "tokentracker://auth/callback",
          // @ts-expect-error - skipBrowserRedirect is supported but not in types
          skipBrowserRedirect: true,
        });
        if (!isCurrentInsforgeClient(client)) {
          return { error: new Error(copy("instance.configuration.changed")) };
        }
        if (result.data?.url) {
          try {
            // Linux's Tauri command rejects when the system browser can't be opened.
            await nativeBridge.postMessage(result.data.url);
          } catch (err) {
            return { error: err instanceof Error ? err : new Error(String(err)) };
          }
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
      if (!client || !isCurrentInsforgeClient(client)) return { data: null, error: new Error(copy("instance.configuration.changed")) };
      const { data, error } = await client.auth.signInWithPassword(request);
      if (!isCurrentInsforgeClient(client)) return { data: null, error: new Error(copy("instance.configuration.changed")) };
      if (data?.user) { allowInsforgeSessionRestore(); setUser(data.user); }
      return { data, error };
    },
    [client],
  );

  const signUp = useCallback(
    async (request) => {
      if (!client || !isCurrentInsforgeClient(client)) return { data: null, error: new Error(copy("instance.configuration.changed")) };
      const { data, error } = await client.auth.signUp(request);
      if (!isCurrentInsforgeClient(client)) return { data: null, error: new Error(copy("instance.configuration.changed")) };
      if (data?.user && data?.accessToken) { allowInsforgeSessionRestore(); setUser(data.user); }
      return { data, error };
    },
    [client],
  );

  const sendResetPasswordEmail = useCallback(
    async (request) => {
      if (!client || !isCurrentInsforgeClient(client)) return { data: null, error: new Error(copy("instance.configuration.changed")) };
      return client.auth.sendResetPasswordEmail(request);
    },
    [client],
  );

  const exchangeResetPasswordToken = useCallback(
    async (request) => {
      if (!client || !isCurrentInsforgeClient(client)) return { data: null, error: new Error(copy("instance.configuration.changed")) };
      return client.auth.exchangeResetPasswordToken(request);
    },
    [client],
  );

  const resetPassword = useCallback(
    async (request) => {
      if (!client || !isCurrentInsforgeClient(client)) return { data: null, error: new Error(copy("instance.configuration.changed")) };
      return client.auth.resetPassword(request);
    },
    [client],
  );

  const getPublicAuthConfig = useCallback(async () => {
    if (!client || !isCurrentInsforgeClient(client)) return { data: null, error: new Error(copy("instance.configuration.changed")) };
    return client.auth.getPublicAuthConfig();
  }, [client]);

  const signOut = useCallback(async () => {
    if (!client) return;
    invalidateAccountResponseCache();
    await client.auth.signOut();
    clearCloudDeviceSession();
    // Sign-out clears session readiness, while the explicit sync preference
    // survives for the next login. Local views stay immediate without a session.
    setCloudUsageReady(false);
    // Refresh same-tab account scope after clearing readiness. This does not
    // change or mirror the saved preference.
    window.dispatchEvent(new Event("tt.cloudSyncChanged"));
    clearLocalApiAuthToken();
    setUser(null);
  }, [client]);

  const getAccessToken = useCallback(async () => {
    if (!client || !isCurrentInsforgeClient(client)) return null;
    const token = await resolveInsforgeClientAccessToken(client);
    if (!isCurrentInsforgeClient(client)) return null;
    if (user?.id && cloudPromptOwnerFromToken(token) !== user.id) return null;
    return token;
  }, [client, user?.id]);

  // Unified display name: cloud custom name > OAuth provider name.
  // Fetched once when user signs in; updated via refreshDisplayName().
  const [cloudDisplayName, setCloudDisplayName] = useState(null);
  const [displayNameResolved, setDisplayNameResolved] = useState(false);
  const authDisplayName = useMemo(() => pickDisplayNameFromUser(user), [user]);

  useEffect(() => {
    if (!user || !client || !isOfficialInsforgeInstance()) {
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
        configurationError: getInsforgeConfigurationError(),
        connectionHost: getInsforgeConnectionHost(),
        client: null,
        user: null,
        signedIn: false,
        loading: isCloudInsforgeConfigured() && loading,
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
      configurationError: null,
      connectionHost: getInsforgeConnectionHost(),
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
