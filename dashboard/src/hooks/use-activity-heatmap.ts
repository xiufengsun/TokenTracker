import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildActivityHeatmap,
  computeActiveStreakDays,
  getHeatmapRangeLocal,
} from "../lib/activity-heatmap";
import { isAccessTokenReady, resolveAuthAccessToken } from "../lib/auth-token";
import { isMockEnabled } from "../lib/mock-data";
import { getTimeZoneCacheKey } from "../lib/timezone";
import {
  fetchCloudUsageDaily,
  fetchCloudUsageHeatmap,
  getUsageDaily,
  getUsageHeatmap,
} from "../lib/api";
import { useLatestRequestGuard } from "./use-latest-request-guard";

export function useActivityHeatmap({
  baseUrl,
  accessToken,
  guestAllowed = false,
  weeks = 52,
  weekStartsOn = "sun",
  cacheKey,
  timeZone,
  tzOffsetMinutes,
  now,
  accountView = false,
  accountAccessToken = null,
  accountRevision = 0,
  accountViewResolving = false,
  deviceId = null,
}: any = {}) {
  const useCloud = Boolean(accountView && accountAccessToken);
  const scopeKey = useCloud ? "cloud" : "local";
  const range = useMemo(() => {
    return getHeatmapRangeLocal({ weeks, weekStartsOn, now });
  }, [now, weeks, weekStartsOn]);
  const [daily, setDaily] = useState<any[]>([]);
  const [heatmap, setHeatmap] = useState<any | null>(null);
  const [source, setSource] = useState("edge");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mockEnabled = isMockEnabled();
  const tokenReady = isAccessTokenReady(accessToken);
  const cacheAllowed = !guestAllowed;

  const isLocalMode = typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  // A manual refresh, visibility refresh, and a scope/range change can all
  // overlap.  Heatmap responses are often considerably slower than the other
  // usage endpoints; without a request guard, a late response from an older
  // range (or device) can overwrite the current grid and its loading state.
  // Keep the guard context aligned with every value used to build a request.
  const beginRequest = useLatestRequestGuard([
    baseUrl,
    range.from,
    range.to,
    weeks,
    weekStartsOn,
    scopeKey,
    accessToken,
    accountAccessToken,
    accountRevision,
    accountViewResolving,
    deviceId,
    timeZone,
    tzOffsetMinutes,
    // Include source/rendering gates in the request identity. This prevents
    // an old authenticated/local response from painting after a guest,
    // mock, or cloud-scope transition.
    guestAllowed,
    mockEnabled,
    cacheAllowed,
    tokenReady,
    isLocalMode,
  ]);

  const storageKey = useMemo(() => {
    if (!cacheKey) return null;
    const tzKey = getTimeZoneCacheKey({ timeZone, offsetMinutes: tzOffsetMinutes });
    return `tokentracker.heatmap.${cacheKey}.${scopeKey}.${weeks}.${weekStartsOn}.${tzKey}.${deviceId || "all"}${useCloud || !accountRevision ? "" : `.r${accountRevision}`}`;
  }, [cacheKey, deviceId, scopeKey, timeZone, tzOffsetMinutes, weeks, weekStartsOn, useCloud, accountRevision]);

  const readCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.heatmap) return null;
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
        // ignore write errors (quota/private mode)
      }
    },
    [storageKey],
  );

  const clearCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch (_e) {
      // ignore remove errors (quota/private mode)
    }
  }, [storageKey]);

  // Wipe state when the scope flips so cached local heatmap doesn't show
  // through while the cloud fetch is in flight (and vice versa). Both
  // heatmap and daily buffers feed the rendered grid, so both must clear.
  const lastScopeRef = useRef(scopeKey);
  useEffect(() => {
    if (lastScopeRef.current === scopeKey) return;
    lastScopeRef.current = scopeKey;
    setDaily([]);
    setHeatmap(null);
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
    const heatmapFetcher = useCloud ? fetchCloudUsageHeatmap : getUsageHeatmap;
    const dailyFetcher = useCloud ? fetchCloudUsageDaily : getUsageDaily;
    setLoading(true);
    setError(null);
    try {
      try {
        const res = await heatmapFetcher({
          baseUrl,
          accessToken: tokenForFetch,
          weeks,
          to: range.to,
          weekStartsOn,
          device: deviceId,
          timeZone,
          tzOffsetMinutes,
        });
        const weeksData = Array.isArray(res?.weeks) ? res.weeks : [];
        if (!isCurrent()) return;
        if (!weeksData.length && cacheAllowed) {
          const cached = readCache();
          if (cached?.heatmap) {
            if (!isCurrent()) return;
            setHeatmap(cached.heatmap);
            setDaily(cached.daily || []);
            setSource("cache");
            return;
          }
        }
        const hasLevels = weeksData.some((week: any) =>
          (Array.isArray(week) ? week : []).some(
            (cell: any) => cell && Number.isFinite(Number(cell.level)),
          ),
        );
        if (!hasLevels && weeksData.length) {
          const rows = [];
          for (const week of weeksData) {
            for (const cell of Array.isArray(week) ? week : []) {
              if (!cell?.day) continue;
              rows.push({
                day: cell.day,
                total_tokens: cell.total_tokens ?? cell.value ?? 0,
                billable_total_tokens:
                  cell.billable_total_tokens ?? cell.value ?? cell.total_tokens ?? 0,
              });
            }
          }
          const localHeatmap = buildActivityHeatmap({
            dailyRows: rows,
            weeks,
            to: res?.to || range.to,
            weekStartsOn,
          });
          if (!isCurrent()) return;
          setDaily(rows);
          setHeatmap({
            ...localHeatmap,
            week_starts_on: weekStartsOn,
            active_days: rows.filter(
              (r: any) => Number(r?.billable_total_tokens ?? r?.total_tokens) > 0,
            ).length,
            streak_days: computeActiveStreakDays({
              dailyRows: rows,
              to: res?.to || range.to,
            }),
          });
          setSource("client");
          if (cacheAllowed) {
            writeCache({
              heatmap: {
                ...localHeatmap,
                week_starts_on: weekStartsOn,
                active_days: rows.filter(
                  (r: any) => Number(r?.billable_total_tokens ?? r?.total_tokens) > 0,
                ).length,
                streak_days: computeActiveStreakDays({
                  dailyRows: rows,
                  to: res?.to || range.to,
                }),
              },
              daily: rows,
              fetchedAt: new Date().toISOString(),
            });
          } else {
            clearCache();
          }
          return;
        }

        if (!isCurrent()) return;
        setHeatmap(res || null);
        setDaily([]);
        setSource("edge");
        if (res && cacheAllowed) {
          writeCache({
            heatmap: res,
            daily: [],
            fetchedAt: new Date().toISOString(),
          });
        } else if (!cacheAllowed) {
          clearCache();
        }
        return;
      } catch (e) {
        const err = e as any;
        const status = err?.status ?? err?.statusCode;
        if (status === 401 || status === 403) throw e;
      }

      // A newer refresh may have superseded this request while the heatmap
      // endpoint was in flight.  Do not start the slower daily fallback for a
      // context that is no longer visible.
      if (!isCurrent()) return;

      const dailyRes = await dailyFetcher({
        baseUrl,
        accessToken: tokenForFetch,
        from: range.from,
        to: range.to,
        device: deviceId,
        timeZone,
        tzOffsetMinutes,
      });
      const rows = Array.isArray(dailyRes?.data) ? dailyRes.data : [];
      if (!isCurrent()) return;
      setDaily(rows);
      const localHeatmap = buildActivityHeatmap({
        dailyRows: rows,
        weeks,
        to: range.to,
        weekStartsOn,
      });
      if (!isCurrent()) return;
      setHeatmap({
        ...localHeatmap,
        week_starts_on: weekStartsOn,
        active_days: rows.filter(
          (r: any) => Number(r?.billable_total_tokens ?? r?.total_tokens) > 0,
        ).length,
        streak_days: computeActiveStreakDays({ dailyRows: rows, to: range.to }),
      });
      setSource("client");
      if (cacheAllowed) {
        writeCache({
          heatmap: {
            ...localHeatmap,
            week_starts_on: weekStartsOn,
            active_days: rows.filter(
              (r: any) => Number(r?.billable_total_tokens ?? r?.total_tokens) > 0,
            ).length,
            streak_days: computeActiveStreakDays({ dailyRows: rows, to: range.to }),
          },
          daily: rows,
          fetchedAt: new Date().toISOString(),
        });
      } else {
        clearCache();
      }
    } catch (e) {
      if (!isCurrent()) return;
      if (cacheAllowed) {
        const cached = readCache();
        if (cached?.heatmap) {
          if (!isCurrent()) return;
          setHeatmap(cached.heatmap);
          setDaily(cached.daily || []);
          setSource("cache");
          setError(null);
        } else {
          const err = e as any;
          setError(err?.message || String(err));
          setDaily([]);
          setHeatmap(null);
          setSource("edge");
        }
      } else {
        const err = e as any;
        setError(err?.message || String(err));
        setDaily([]);
        setHeatmap(null);
        setSource("edge");
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [
    accessToken,
    baseUrl,
    mockEnabled,
    guestAllowed,
    cacheAllowed,
    range.from,
    range.to,
    readCache,
    tokenReady,
    timeZone,
    tzOffsetMinutes,
    weekStartsOn,
    weeks,
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
      setDaily([]);
      setLoading(false);
      setError(null);
      setHeatmap(null);
      setSource("edge");
      return;
    }
    if (!cacheAllowed) {
      clearCache();
      setDaily([]);
      setError(null);
      setHeatmap(null);
      setSource("edge");
    } else {
      const cached = readCache();
      if (cached?.heatmap) {
        setHeatmap(cached.heatmap);
        setDaily(cached.daily || []);
        setSource("cache");
      }
    }
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

  const normalizedSource = mockEnabled ? "mock" : source === "client" ? "edge" : source;

  return { range, daily, heatmap, source: normalizedSource, loading, error, refresh };
}
