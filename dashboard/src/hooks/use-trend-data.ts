import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAccessTokenReady, resolveAuthAccessToken } from "../lib/auth-token";
import { formatDateLocal, formatDateUTC } from "../lib/date-range";
import { isMockEnabled } from "../lib/mock-data";
import { getLocalDayKey, getTimeZoneCacheKey } from "../lib/timezone";
import {
  fetchCloudUsageDaily,
  fetchCloudUsageHourly,
  fetchCloudUsageMonthly,
  getUsageDaily,
  getUsageHourly,
  getUsageMonthly,
} from "../lib/api";
import { useLatestRequestGuard } from "./use-latest-request-guard";
import { touchLocalStorageCacheKey } from "../lib/local-storage-lru";

const DEFAULT_MONTHS = 24;
type AnyRecord = Record<string, any>;

// Same bounded-LRU scheme as use-usage-data (keys embed range/tz/device).
const TREND_CACHE_INDEX_KEY = "tokentracker.trend-cache-index";
const TREND_CACHE_MAX_ENTRIES = 24;

export function useTrendData({
  baseUrl,
  accessToken,
  guestAllowed = false,
  period,
  from,
  to,
  months = DEFAULT_MONTHS,
  cacheKey,
  timeZone,
  tzOffsetMinutes,
  now,
  sharedRows,
  sharedRange,
  accountView = false,
  accountAccessToken = null,
  accountRevision = 0,
  accountViewResolving = false,
  deviceId = null,
}: any = {}) {
  const useCloud = Boolean(accountView && accountAccessToken);
  const scopeKey = useCloud ? "cloud" : "local";
  const [rows, setRows] = useState<any[]>([]);
  const [range, setRange] = useState<{ from?: any; to?: any }>(() => ({ from, to }));
  const [source, setSource] = useState<string>("edge");
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mockEnabled = isMockEnabled();
  const tokenReady = isAccessTokenReady(accessToken);
  const cacheAllowed = !guestAllowed && !mockEnabled;
  const sharedEnabled = Array.isArray(sharedRows);
  const sharedFrom = sharedRange?.from || from;
  const sharedTo = sharedRange?.to || to;

  // Read shared rows through a ref inside `refresh` so the callback identity
  // does NOT change on every new `sharedRows` reference (DashboardPage passes
  // its `daily` array here, which is re-created on every fetch). Keeping
  // `refresh` stable is what stops the aggregate refresher upstream from
  // churning identity and driving an infinite usage-refresh loop (#360). The
  // request guard and the mount effect below still react to shared changes.
  const sharedStateRef = useRef({ sharedEnabled, sharedRows, sharedFrom, sharedTo });
  sharedStateRef.current = { sharedEnabled, sharedRows, sharedFrom, sharedTo };

  const mode = useMemo(() => {
    if (period === "day") return "hourly";
    if (period === "total") return "monthly";
    return "daily";
  }, [period]);

  const storageKey = (() => {
    if (!cacheKey) return null;
    const host = safeHost(baseUrl) || "default";
    const tzKey = getTimeZoneCacheKey({ timeZone, offsetMinutes: tzOffsetMinutes });
    const deviceScope = deviceId || "all";
    if (mode === "hourly") {
      const dayKey = to || from || "day";
      return `tokentracker.trend.${cacheKey}.${scopeKey}.${host}.hourly.${dayKey}.${tzKey}.${deviceScope}`;
    }
    if (mode === "monthly") {
      const toKey = to || "today";
      return `tokentracker.trend.${cacheKey}.${scopeKey}.${host}.monthly.${months}.${toKey}.${tzKey}.${deviceScope}`;
    }
    const rangeKey = `${from || ""}.${to || ""}`;
    return `tokentracker.trend.${cacheKey}.${scopeKey}.${host}.daily.${rangeKey}.${tzKey}.${deviceScope}`;
  })();

  const readCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.rows)) return null;
      touchLocalStorageCacheKey(TREND_CACHE_INDEX_KEY, storageKey, TREND_CACHE_MAX_ENTRIES);
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
        touchLocalStorageCacheKey(TREND_CACHE_INDEX_KEY, storageKey, TREND_CACHE_MAX_ENTRIES);
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
    mode,
    from,
    to,
    months,
    scopeKey,
    accessToken,
    accountAccessToken,
    accountRevision,
    deviceId,
    timeZone,
    tzOffsetMinutes,
    sharedEnabled,
    sharedRows,
    sharedFrom,
    sharedTo,
    // Rendering gates are part of the request context. A response started
    // for the local/authenticated view must not commit after the dashboard
    // switches to guest, mock, or a still-resolving cloud scope.
    guestAllowed,
    mockEnabled,
    cacheAllowed,
    accountViewResolving,
    tokenReady,
    isLocalMode,
  ]);

  // Wipe state when the scope flips so the previously-rendered local data
  // doesn't visually persist while the cloud fetch is in flight (and vice
  // versa). Covers all three trend grains (daily/hourly/monthly) since rows
  // is the shared buffer for whichever mode is active.
  const lastScopeRef = useRef(scopeKey);
  useEffect(() => {
    if (lastScopeRef.current === scopeKey) return;
    lastScopeRef.current = scopeKey;
    setRows([]);
    setRange({ from, to });
    setSource("edge");
    setFetchedAt(null);
    setError(null);
    setLoading(true);
  }, [scopeKey]);

  const refresh = useCallback(async () => {
    const isCurrent = beginRequest();
    const {
      sharedEnabled: sharedEnabledNow,
      sharedRows: sharedRowsNow,
      sharedFrom: sharedFromNow,
      sharedTo: sharedToNow,
    } = sharedStateRef.current;
    if (sharedEnabledNow) {
      setRows(Array.isArray(sharedRowsNow) ? sharedRowsNow : []);
      setRange({ from: sharedFromNow, to: sharedToNow });
      setSource("shared");
      setFetchedAt(null);
      setLoading(false);
      setError(null);
      return;
    }
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
    const hourlyFetcher = useCloud ? fetchCloudUsageHourly : getUsageHourly;
    const monthlyFetcher = useCloud ? fetchCloudUsageMonthly : getUsageMonthly;
    const dailyFetcher = useCloud ? fetchCloudUsageDaily : getUsageDaily;
    setLoading(true);
    setError(null);
    try {
      let response;
      if (mode === "hourly") {
        const day = to || from;
        response = await hourlyFetcher({
          baseUrl,
          accessToken: tokenForFetch,
          day,
          device: deviceId,
          timeZone,
          tzOffsetMinutes,
        });
      } else if (mode === "monthly") {
        response = await monthlyFetcher({
          baseUrl,
          accessToken: tokenForFetch,
          months,
          to,
          device: deviceId,
          timeZone,
          tzOffsetMinutes,
        });
      } else {
        response = await dailyFetcher({
          baseUrl,
          accessToken: tokenForFetch,
          from,
          to,
          device: deviceId,
          timeZone,
          tzOffsetMinutes,
        });
      }

      let nextFrom = response?.from || from || response?.day || null;
      const nextTo = response?.to || to || response?.day || null;
      if (mode === "monthly" && !nextFrom) {
        nextFrom = monthlyRangeStart(nextTo, months);
      }
      let nextRows = Array.isArray(response?.data) ? response.data : [];
      if (mode === "daily") {
        nextRows = fillDailyGaps(nextRows, nextFrom || from, nextTo || to, {
          timeZone,
          offsetMinutes: tzOffsetMinutes,
          now,
        });
      } else if (mode === "hourly") {
        nextRows = fillHourlyGaps(nextRows, nextFrom || from || response?.day, {
          timeZone,
          offsetMinutes: tzOffsetMinutes,
          now,
        });
        nextRows = markHourlyFuture(nextRows, {
          timeZone,
          offsetMinutes: tzOffsetMinutes,
          now,
        });
      } else if (mode === "monthly") {
        nextRows = fillMonthlyGaps(nextRows, nextFrom || from, nextTo || to, {
          timeZone,
          offsetMinutes: tzOffsetMinutes,
          now,
        });
      }
      const nowIso = new Date().toISOString();

      if (!isCurrent()) return;

      setRows(nextRows);
      setRange({ from: nextFrom, to: nextTo });
      setSource("edge");
      setFetchedAt(nowIso);

      if (cacheAllowed) {
        writeCache({
          rows: nextRows,
          from: nextFrom,
          to: nextTo,
          mode,
          fetchedAt: nowIso,
        });
      } else {
        clearCache();
      }
    } catch (e) {
      if (!isCurrent()) return;
      if (cacheAllowed) {
        const cached = readCache();
        if (cached?.rows) {
          let filledRows =
            mode === "daily"
              ? fillDailyGaps(cached.rows || [], cached.from || from, cached.to || to, {
                  timeZone,
                  offsetMinutes: tzOffsetMinutes,
                  now,
                })
              : mode === "hourly"
                ? fillHourlyGaps(cached.rows || [], cached.from || from || cached.day || to, {
                    timeZone,
                    offsetMinutes: tzOffsetMinutes,
                    now,
                  })
                : Array.isArray(cached.rows)
                  ? cached.rows
                  : [];
          if (mode === "hourly") {
            filledRows = markHourlyFuture(filledRows, {
              timeZone,
              offsetMinutes: tzOffsetMinutes,
              now,
            });
          } else if (mode === "monthly") {
            filledRows = fillMonthlyGaps(filledRows, cached.from || from || monthlyRangeStart(cached.to || to, months), cached.to || to, {
              timeZone,
              offsetMinutes: tzOffsetMinutes,
              now,
            });
          }
          setRows(filledRows);
          setRange({
            from: cached.from || from || (mode === "monthly" ? monthlyRangeStart(cached.to || to, months) : from),
            to: cached.to || to,
          });
          setSource("cache");
          setFetchedAt(cached.fetchedAt || null);
          setError(null);
        } else {
          setRows([]);
          setRange({ from, to });
          setSource("edge");
          setFetchedAt(null);
          const err = e as any;
          setError(err?.message || String(err));
        }
      } else {
        setRows([]);
        setRange({ from, to });
        setSource("edge");
        setFetchedAt(null);
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
    mode,
    months,
    readCache,
    tokenReady,
    timeZone,
    to,
    tzOffsetMinutes,
    now,
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
      // Auth still resolving, cloud likely — hold loading instead of painting
      // local (or shared-local) data that the cloud flip would wipe.
      setLoading(true);
      return;
    }
    if (sharedEnabled) {
      setRows(Array.isArray(sharedRows) ? sharedRows : []);
      setRange({ from: sharedFrom, to: sharedTo });
      setSource("shared");
      setFetchedAt(null);
      setLoading(false);
      setError(null);
      return;
    }
    if (!tokenReady && !guestAllowed && !mockEnabled && !isLocalMode && !useCloud) {
      setRows([]);
      setRange({ from, to });
      setError(null);
      setLoading(false);
      setSource("edge");
      setFetchedAt(null);
      return;
    }
    if (!cacheAllowed) {
      clearCache();
      setRows([]);
      setRange({ from, to });
      setError(null);
      setSource("edge");
      setFetchedAt(null);
    } else {
      const cached = readCache();
      if (cached?.rows) {
        let filledRows =
          mode === "daily"
            ? fillDailyGaps(cached.rows || [], cached.from || from, cached.to || to, {
                timeZone,
                offsetMinutes: tzOffsetMinutes,
                now,
              })
            : mode === "hourly"
              ? fillHourlyGaps(cached.rows || [], cached.from || from || cached.day || to, {
                  timeZone,
                  offsetMinutes: tzOffsetMinutes,
                  now,
                })
              : Array.isArray(cached.rows)
                ? cached.rows
                : [];
        if (mode === "hourly") {
          filledRows = markHourlyFuture(filledRows, {
            timeZone,
            offsetMinutes: tzOffsetMinutes,
            now,
          });
        } else if (mode === "monthly") {
          filledRows = fillMonthlyGaps(filledRows, cached.from || from || monthlyRangeStart(cached.to || to, months), cached.to || to, {
            timeZone,
            offsetMinutes: tzOffsetMinutes,
            now,
          });
        }
        setRows(filledRows);
        setRange({
          from: cached.from || from || (mode === "monthly" ? monthlyRangeStart(cached.to || to, months) : from),
          to: cached.to || to,
        });
        setSource("cache");
        setFetchedAt(cached.fetchedAt || null);
        setError(null);
      } else {
        // Do not carry rows from another period into the newly-selected tab.
        setRows([]);
        setRange({ from, to });
        setSource("edge");
        setFetchedAt(null);
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
    sharedEnabled,
    sharedFrom,
    sharedRows,
    sharedTo,
    tokenReady,
    guestAllowed,
    cacheAllowed,
    clearCache,
    isLocalMode,
    accountViewResolving,
  ]);

  const normalizedSource = mockEnabled ? "mock" : source;

  return {
    rows,
    from: range.from || from,
    to: range.to || to,
    source: normalizedSource,
    fetchedAt,
    loading,
    error,
    refresh,
  };
}

function safeHost(baseUrl: any) {
  try {
    const u = new URL(baseUrl);
    return u.host;
  } catch (_e) {
    return null;
  }
}

function parseUtcDate(yyyyMmDd: any) {
  if (!yyyyMmDd) return null;
  const raw = String(yyyyMmDd).trim();
  const parts = raw.split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]) - 1;
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }
  const dt = new Date(Date.UTC(y, m, d));
  if (!Number.isFinite(dt.getTime())) return null;
  return formatDateUTC(dt) === raw ? dt : null;
}

function addUtcDays(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

const HOURLY_ZERO_FIELDS = [
  "total_tokens",
  "billable_total_tokens",
  "input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "conversation_count",
];

function fillDailyGaps(
  rows: any[],
  from: any,
  to: any,
  { timeZone, offsetMinutes, now }: any = {},
) {
  const start = parseUtcDate(from);
  const end = parseUtcDate(to);
  if (!start || !end || end < start) return Array.isArray(rows) ? rows : [];

  const baseDate = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const todayKey = getLocalDayKey({ timeZone, offsetMinutes, date: baseDate });
  const today = parseUtcDate(todayKey);
  const todayTime = today ? today.getTime() : baseDate.getTime();

  const byDay = new Map();
  for (const row of rows || []) {
    if (row?.day) byDay.set(row.day, row);
  }

  const filled = [];
  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
    const day = formatDateUTC(cursor);
    const existing = byDay.get(day);
    const isFuture = cursor.getTime() > todayTime;
    if (existing) {
      filled.push({ ...existing, missing: false, future: isFuture });
      continue;
    }
    filled.push({
      day,
      total_tokens: null,
      billable_total_tokens: null,
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      missing: !isFuture,
      future: isFuture,
    });
  }

  return filled;
}

function buildHourlyGapRow(hour: string, isFuture: boolean) {
  const value = isFuture ? null : 0;
  return {
    hour,
    total_tokens: value,
    billable_total_tokens: value,
    input_tokens: value,
    cached_input_tokens: value,
    cache_creation_input_tokens: value,
    output_tokens: value,
    reasoning_output_tokens: value,
    conversation_count: value,
    missing: false,
    future: isFuture,
  };
}

function isSyntheticNullHourlyGap(row: any) {
  if (!row || typeof row !== "object") return false;
  const models = row.models;
  if (models && typeof models === "object" && Object.keys(models).length > 0) return false;
  return HOURLY_ZERO_FIELDS.every((field) => row[field] == null);
}

function normalizeExistingHourlyRow(row: any, hour: string, isFuture: boolean) {
  const normalized = { ...row, hour, missing: false, future: isFuture };
  if (!isFuture && isSyntheticNullHourlyGap(row)) {
    for (const field of HOURLY_ZERO_FIELDS) {
      normalized[field] = 0;
    }
  }
  return normalized;
}

function buildFixedHourlySlotLabels(dayKey: string, stepMinutes: number) {
  const totalSlots = stepMinutes === 30 ? 48 : 24;
  const labels = [];
  for (let slot = 0; slot < totalSlots; slot++) {
    const hour = Math.floor((slot * stepMinutes) / 60);
    const minute = (slot * stepMinutes) % 60;
    labels.push(
      `${dayKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
    );
  }
  return labels;
}

function buildHourlySlotLabels(
  dayKey: string,
  stepMinutes: number,
  { timeZone, offsetMinutes }: any = {},
) {
  const fixedLabels = buildFixedHourlySlotLabels(dayKey, stepMinutes);
  if (!timeZone || typeof Intl === "undefined" || !Intl.DateTimeFormat) {
    return fixedLabels;
  }

  const day = parseUtcDate(dayKey);
  if (!day) return fixedLabels;
  const targetDayNum =
    day.getUTCFullYear() * 10000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate();
  const startMs = day.getTime() - 36 * 60 * 60 * 1000;
  const endMs = addUtcDays(day, 2).getTime() + 36 * 60 * 60 * 1000;
  const labels = [];
  const seen = new Set();
  for (let ts = startMs; ts <= endMs; ts += 30 * 60 * 1000) {
    const parts = getNowParts({ timeZone, offsetMinutes, now: new Date(ts) });
    if (!parts || parts.dayNum !== targetDayNum) continue;
    if (stepMinutes === 60 && parts.minute !== 0) continue;
    if (stepMinutes === 30 && parts.minute !== 0 && parts.minute !== 30) continue;
    const label =
      `${dayKey}T${String(parts.hour).padStart(2, "0")}:` +
      `${String(parts.minute).padStart(2, "0")}:00`;
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels.length > 0 ? labels : fixedLabels;
}

function fillHourlyGaps(
  rows: any[],
  dayKey: string,
  { timeZone, offsetMinutes, now }: any = {},
): any[] {
  if (!dayKey) return Array.isArray(rows) ? rows : [];
  const normalizedDay = dayKey.trim().slice(0, 10); // YYYY-MM-DD
  const nowParts = getNowParts({ timeZone, offsetMinutes, now });
  const defaultDayNum = nowParts ? nowParts.dayNum : undefined;

  // Detect granularity (hourly or half-hourly)
  let hasHalfHour = false;
  for (const row of rows || []) {
    const label = row?.hour || row?.label || "";
    const parsed = parseHourLabel(label, defaultDayNum);
    if (parsed && parsed.slot % 2 !== 0) {
      hasHalfHour = true;
      break;
    }
  }

  const stepMinutes = hasHalfHour ? 30 : 60;

  const bySlot = new Map<number, any>();
  for (const row of rows || []) {
    const label = row?.hour || row?.label || "";
    const parsed = parseHourLabel(label, defaultDayNum);
    if (parsed) {
      bySlot.set(parsed.slot, row);
    }
  }

  const filled = [];
  const slotLabels = buildHourlySlotLabels(normalizedDay, stepMinutes, {
    timeZone,
    offsetMinutes,
  });

  for (let slot = 0; slot < slotLabels.length; slot++) {
    const hourLabel = slotLabels[slot];
    const parsedLabel = parseHourLabel(hourLabel, defaultDayNum);
    const lookupSlot = parsedLabel ? parsedLabel.slot : hasHalfHour ? slot : slot * 2;
    const existing = bySlot.get(lookupSlot);

    let isFuture = false;
    if (nowParts) {
      const dayNum = nowParts.year * 10000 + nowParts.month * 100 + nowParts.day;
      const parsedDayNum = parsedLabel?.dayNum ?? Number(normalizedDay.replace(/-/g, ""));
      if (parsedDayNum > dayNum) {
        isFuture = true;
      } else if (parsedDayNum === dayNum) {
        const currentSlot = nowParts.hour * 2 + (nowParts.minute >= 30 ? 1 : 0);
        isFuture = lookupSlot > currentSlot;
      }
    }

    if (existing) {
      filled.push(normalizeExistingHourlyRow(existing, hourLabel, isFuture));
    } else {
      filled.push(buildHourlyGapRow(hourLabel, isFuture));
    }
  }

  return filled;
}

function markHourlyFuture(rows: any[], { timeZone, offsetMinutes, now }: any = {}) {
  if (!Array.isArray(rows)) return [];
  const nowParts = getNowParts({ timeZone, offsetMinutes, now });
  if (!nowParts) return rows;

  return rows.map((row) => {
    const label = row?.hour || row?.label || "";
    const parsed = parseHourLabel(label, nowParts.dayNum);
    if (!parsed) {
      return { ...row, future: false };
    }
    const isFuture =
      (parsed.dayNum !== null && parsed.dayNum > nowParts.dayNum) ||
      ((parsed.dayNum === null || parsed.dayNum === nowParts.dayNum) && parsed.slot > nowParts.slot);
    return { ...row, future: !!isFuture };
  });
}

function monthlyRangeStart(to: any, months: number) {
  const end = parseMonthLabel(String(to || "").slice(0, 7));
  if (!end) return null;
  return formatDateUTC(new Date(Date.UTC(end.year, end.month - months, 1)));
}

function fillMonthlyGaps(rows: any[], from: any, to: any, context: any = {}) {
  const start = parseMonthLabel(String(from || "").slice(0, 7));
  const end = parseMonthLabel(String(to || "").slice(0, 7));
  if (!start || !end) return Array.isArray(rows) ? rows : [];
  const startMonth = start.year * 12 + start.month - 1;
  const endMonth = end.year * 12 + end.month - 1;
  if (endMonth < startMonth) return Array.isArray(rows) ? rows : [];
  const nowParts = getNowParts(context);
  const currentMonth = nowParts.year * 12 + nowParts.month - 1;
  const byMonth = new Map((rows || []).map((row) => [row?.month, row]));
  const filled = [];
  for (let cursor = startMonth; cursor <= endMonth; cursor++) {
    const month = `${Math.floor(cursor / 12)}-${String(cursor % 12 + 1).padStart(2, "0")}`;
    const future = cursor > currentMonth;
    const existing = byMonth.get(month);
    if (existing && !(existing.future && existing.total_tokens == null)) {
      filled.push({ ...existing, missing: false, future });
    } else {
      const value = future ? null : 0;
      filled.push({
        month,
        total_tokens: value,
        billable_total_tokens: value,
        input_tokens: value,
        cached_input_tokens: value,
        cache_creation_input_tokens: value,
        output_tokens: value,
        reasoning_output_tokens: value,
        conversation_count: value,
        missing: false,
        future,
      });
    }
  }
  return filled;
}

function getNowParts({ timeZone, offsetMinutes, now }: any = {}) {
  const baseDate = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const parts = formatter.formatToParts(baseDate);
      const values = parts.reduce((acc: AnyRecord, part: any) => {
        if (part.type && part.value) acc[part.type] = part.value;
        return acc;
      }, {} as AnyRecord);
      const year = Number(values.year);
      const month = Number(values.month);
      const day = Number(values.day);
      const hour = Number(values.hour);
      const minute = Number(values.minute);
      if (
        Number.isFinite(year) &&
        Number.isFinite(month) &&
        Number.isFinite(day) &&
        Number.isFinite(hour) &&
        Number.isFinite(minute)
      ) {
        const slot = hour * 2 + (minute >= 30 ? 1 : 0);
        return {
          year,
          month,
          day,
          hour,
          minute,
          dayNum: year * 10000 + month * 100 + day,
          slot,
        };
      }
    } catch (_e) {
      // fallback below
    }
  }

  if (Number.isFinite(offsetMinutes)) {
    const shifted = new Date(baseDate.getTime() + offsetMinutes * 60 * 1000);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth() + 1;
    const day = shifted.getUTCDate();
    const hour = shifted.getUTCHours();
    const minute = shifted.getUTCMinutes();
    const slot = hour * 2 + (minute >= 30 ? 1 : 0);
    return {
      year,
      month,
      day,
      hour,
      minute,
      dayNum: year * 10000 + month * 100 + day,
      slot,
    };
  }

  const year = baseDate.getFullYear();
  const month = baseDate.getMonth() + 1;
  const day = baseDate.getDate();
  const hour = baseDate.getHours();
  const minute = baseDate.getMinutes();
  const slot = hour * 2 + (minute >= 30 ? 1 : 0);
  return {
    year,
    month,
    day,
    hour,
    minute,
    dayNum: year * 10000 + month * 100 + day,
    slot,
  };
}

function parseHourLabel(label: any, defaultDayNum?: number) {
  if (!label) return null;
  const raw = String(label).trim();
  if (raw.includes("T")) {
    const [datePart, timePart] = raw.split("T");
    if (!datePart || !timePart) return null;
    const dateParts = datePart.split("-");
    if (dateParts.length !== 3) return null;
    const year = Number(dateParts[0]);
    const month = Number(dateParts[1]);
    const day = Number(dateParts[2]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }
    const timeParts = timePart.split(":");
    const hour = Number(timeParts[0]);
    const minute = Number(timeParts[1]);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    const slot = hour * 2 + (minute >= 30 ? 1 : 0);
    return {
      dayNum: year * 10000 + month * 100 + day,
      slot,
    };
  } else {
    // Check if it's pure hour digits (e.g. "01", "1") or time digits (e.g. "01:00")
    let hour = NaN;
    let minute = 0;
    if (/^\d{1,2}$/.test(raw)) {
      hour = Number(raw);
    } else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
      const parts = raw.split(":");
      hour = Number(parts[0]);
      minute = Number(parts[1]);
    }
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    const slot = hour * 2 + (minute >= 30 ? 1 : 0);
    return {
      dayNum: defaultDayNum || null,
      slot,
    };
  }
}

function parseMonthLabel(label: any) {
  if (!label) return null;
  const raw = String(label).trim();
  const parts = raw.split("-");
  if (parts.length !== 2) return null;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  return { year, month };
}
