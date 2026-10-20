import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAccessTokenReady, resolveAuthAccessToken } from "../lib/auth-token";
import { isMockEnabled } from "../lib/mock-data";
import { getTimeZoneCacheKey } from "../lib/timezone";
import { fetchCloudUsageModelBreakdown, getUsageModelBreakdown } from "../lib/api";
import { useLatestRequestGuard } from "./use-latest-request-guard";

export function useUsageModelBreakdown({
  baseUrl,
  accessToken,
  guestAllowed = false,
  from,
  to,
  cacheKey,
  timeZone,
  tzOffsetMinutes,
  accountView = false,
  accountAccessToken = null,
  accountRevision = 0,
  accountViewResolving = false,
  deviceId = null,
}: any = {}) {
  const useCloud = Boolean(accountView && accountAccessToken);
  const scopeKey = useCloud ? "cloud" : "local";
  const [breakdown, setBreakdown] = useState<any | null>(null);
  const [source, setSource] = useState<string>("edge");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mockEnabled = isMockEnabled();
  const tokenReady = isAccessTokenReady(accessToken);
  const cacheAllowed = !guestAllowed;

  const storageKey = useMemo(() => {
    if (!cacheKey) return null;
    const host = safeHost(baseUrl) || "default";
    const tzKey = getTimeZoneCacheKey({ timeZone, offsetMinutes: tzOffsetMinutes });
    return `tokentracker.modelBreakdown.${cacheKey}.${scopeKey}.${host}.${from}.${to}.${tzKey}.${deviceId || "all"}${useCloud || !accountRevision ? "" : `.r${accountRevision}`}`;
  }, [baseUrl, cacheKey, deviceId, from, scopeKey, timeZone, to, tzOffsetMinutes, useCloud, accountRevision]);

  const readCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.breakdown) return null;
      return parsed;
    } catch (_e) {
      return null;
    }
  }, [storageKey]);

  const writeCache = useCallback(
    (payload: any) => {
      if (!storageKey || typeof window === "undefined") return;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch (_e) {
        // ignore write errors
      }
    },
    [storageKey],
  );

  const clearCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch (_e) {
      // ignore remove errors
    }
  }, [storageKey]);

  const isLocalMode = typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  const beginRequest = useLatestRequestGuard([
    baseUrl,
    from,
    to,
    scopeKey,
    accessToken,
    accountAccessToken,
    accountRevision,
    deviceId,
    timeZone,
    tzOffsetMinutes,
    // Keep auth and scope gates in the request identity so an old provider
    // response cannot repopulate the card after a view transition.
    guestAllowed,
    mockEnabled,
    cacheAllowed,
    accountViewResolving,
    tokenReady,
    isLocalMode,
  ]);

  // Wipe state when the scope flips so the prior buckets don't render
  // while the new fetch is in flight.
  const lastScopeRef = useRef(scopeKey);
  useEffect(() => {
    if (lastScopeRef.current === scopeKey) return;
    lastScopeRef.current = scopeKey;
    setBreakdown(null);
    setSource("edge");
    setError(null);
    setLoading(true);
  }, [scopeKey]);

  const refresh = useCallback(async () => {
    const isCurrent = beginRequest();
    const resolvedToken = await resolveAuthAccessToken(accessToken);
    const cloudToken = useCloud ? await resolveAuthAccessToken(accountAccessToken) : null;
    if (!isCurrent()) return;
    if (!resolvedToken && !mockEnabled && !isLocalMode && !useCloud) return;
    if (useCloud && !cloudToken) {
      setError("Your session expired. Please sign in again to view account data.");
      setLoading(false);
      return;
    }
    const tokenForFetch = useCloud ? cloudToken : resolvedToken;
    const breakdownFetcher = useCloud ? fetchCloudUsageModelBreakdown : getUsageModelBreakdown;
    setLoading(true);
    setError(null);
    try {
      const res = await breakdownFetcher({
        baseUrl,
        accessToken: tokenForFetch,
        from,
        to,
        device: deviceId,
        timeZone,
        tzOffsetMinutes,
      });
      if (!isCurrent()) return;
      setBreakdown(res || null);
      setSource("edge");
      if (res && cacheAllowed) {
        writeCache({ breakdown: res, fetchedAt: new Date().toISOString() });
      } else if (!cacheAllowed) {
        clearCache();
      }
    } catch (e) {
      if (!isCurrent()) return;
      if (cacheAllowed) {
        const cached = readCache();
        if (cached?.breakdown) {
          setBreakdown(cached.breakdown);
          setSource("cache");
          setError(null);
        } else {
          setBreakdown(null);
          setSource("edge");
          const err = e as any;
          setError(err?.message || String(err));
        }
      } else {
        setBreakdown(null);
        setSource("edge");
        const err = e as any;
        setError(err?.message || String(err));
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [
    accessToken,
    baseUrl,
    from,
    mockEnabled,
    guestAllowed,
    cacheAllowed,
    readCache,
    timeZone,
    to,
    tokenReady,
    tzOffsetMinutes,
    clearCache,
    writeCache,
    isLocalMode,
    useCloud,
    accountAccessToken,
    accountRevision,
    deviceId,
    beginRequest,
  ]);

  useEffect(() => {
    if (accountViewResolving) {
      setLoading(true);
      return;
    }
    if (!tokenReady && !guestAllowed && !mockEnabled && !isLocalMode && !useCloud) {
      setBreakdown(null);
      setSource("edge");
      setError(null);
      setLoading(false);
      return;
    }
    if (!cacheAllowed) {
      clearCache();
      setBreakdown(null);
      setSource("edge");
      setError(null);
    } else {
      const cached = readCache();
      if (cached?.breakdown) {
        setBreakdown(cached.breakdown);
        setSource("cache");
        setError(null);
      } else {
        // Provider cards must never keep the previous range's breakdown.
        setBreakdown(null);
        setSource("edge");
        setError(null);
      }
    }
    setLoading(true);
    refresh();
  }, [
    accessToken,
    mockEnabled,
    readCache,
    refresh,
    tokenReady,
    guestAllowed,
    cacheAllowed,
    clearCache,
    isLocalMode,
    accountViewResolving,
  ]);

  const normalizedSource = mockEnabled ? "mock" : source;

  return {
    breakdown,
    source: normalizedSource,
    loading,
    error,
    refresh,
  };
}

function safeHost(baseUrl: any) {
  try {
    const url = new URL(baseUrl);
    return url.host;
  } catch (_e) {
    return null;
  }
}
