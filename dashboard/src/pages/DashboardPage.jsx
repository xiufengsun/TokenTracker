import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccountView } from "../contexts/AccountViewContext.jsx";
import { useActivityHeatmap } from "../hooks/use-activity-heatmap.js";
import { useDashboardCardOrder } from "../hooks/use-dashboard-card-order.js";
import { useProjectUsageSummary } from "../hooks/use-project-usage-summary";
import { useTrendData } from "../hooks/use-trend-data.js";
import { useUsageData } from "../hooks/use-usage-data.js";
import { useUsageLimits } from "../hooks/use-usage-limits.js";
import { useUsageModelBreakdown } from "../hooks/use-usage-model-breakdown.js";
import {
  isAccessTokenReady,
  normalizeAccessToken,
  resolveAuthAccessToken,
} from "../lib/auth-token";
import { copy } from "../lib/copy";
import { useLocale } from "../hooks/useLocale.js";
import { useCurrency } from "../hooks/useCurrency.js";
import { useTokenFormat } from "../hooks/useTokenFormat.js";
import { TOKEN_FORMAT_MODES } from "../lib/token-format.js";
import { getDetailsSortColumns, sortDailyRows } from "../lib/daily";
import { getRangeForPeriod } from "../lib/date-range";
import { DETAILS_PAGE_SIZE, paginateRows, trimLeadingZeroMonths } from "../lib/details";
import {
  formatUsdCurrency,
  toDisplayNumber,
  toFiniteNumber,
} from "../lib/format";
import { shouldShowInstallCard } from "../lib/install-status";
import { getMockNow, isMockEnabled } from "../lib/mock-data";
import { publishUsageLimitsPreloadState } from "../lib/dashboard-preload.js";
import { startLocalUsageAutoRefresh } from "../lib/local-usage-auto-refresh";
import { buildDailyBreakdownRange, selectDailyBreakdownRows } from "../lib/daily-breakdown";
import { buildFleetData, buildTopModels, resolveDisplayTokens } from "../lib/model-breakdown";
import { safeWriteClipboard } from "../lib/safe-browser";
import { isScreenshotModeEnabled } from "../lib/screenshot-mode";
import {
  formatTimeZoneLabel,
  formatTimeZoneShortLabel,
  getBrowserTimeZone,
  getBrowserTimeZoneOffsetMinutes,
  getLocalDayKey,
} from "../lib/timezone";
import {
  getUserStatus,
  invalidateAccountResponseCache,
  invalidateSessionInsightsCache,
  triggerLocalSync,
  renameAccountDevice,
} from "../lib/api";
import { ActivityHeatmap } from "../ui/dashboard/components/ActivityHeatmap.jsx";
import { DashboardView } from "../ui/dashboard/views/DashboardView.jsx";
import { useAccountDevices } from "../hooks/use-account-devices.js";
import { DeviceUsageCard } from "../ui/dashboard/components/DeviceUsageCard.jsx";
import { formatDeviceLabel } from "../lib/device-label.js";
import { CLOUD_USAGE_SYNCED_EVENT, getCurrentDeviceId } from "../lib/cloud-sync-prefs";
import { ShareModal } from "../ui/share/ShareModal";
import { useShareCardData } from "../ui/share/use-share-card-data";
import { runSingleFlight } from "../lib/single-flight";
import {
  LOCAL_DASHBOARD_REFRESH_OPTIONS,
  refreshDashboardAggregates,
} from "../lib/dashboard-refresh";

const PERIODS = ["day", "week", "month", "total", "custom"];
const DETAILS_DATE_KEYS = new Set(["day", "hour", "month"]);
const DETAILS_PAGED_PERIODS = new Set(["day", "total", "custom"]);

// Default Overview card order — each column is dragged/persisted independently.
const LEFT_CARD_ORDER_DEFAULTS = [
  "islandOnboarding",
  "macAppBanner",
  "statsPanel",
  "widgetOnboarding",
  "installCopy",
  "activityHeatmap",
  "deviceUsage",
  "trendMonitor",
  "qualityPerDollar",
  "sessionInsights",
];
const RIGHT_CARD_ORDER_DEFAULTS = ["usageOverview", "dataDetails"];

function hasUsageValue(value, level) {
  if (typeof level === "number" && level > 0) return true;
  if (typeof value === "bigint") return value > 0n;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (/^[0-9]+$/.test(trimmed)) {
      try {
        return BigInt(trimmed) > 0n;
      } catch (_e) {
        return false;
      }
    }
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) && numeric > 0;
  }
  return false;
}

function getBillableTotal(row) {
  if (!row) return null;
  return resolveDisplayTokens(row, null);
}

function getHeatmapValue(cell) {
  if (!cell) return null;
  return cell?.billable_total_tokens ?? cell?.value ?? cell?.total_tokens;
}

function isProductionHost(hostname) {
  if (!hostname) return false;
  return hostname === "www.tokentracker.cc" || hostname === "tokentracker.cc";
}

function isForceInstallEnabled() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const raw = String(params.get("force_install") || "").toLowerCase();
  if (raw !== "1" && raw !== "true") return false;
  return !isProductionHost(window.location.hostname);
}

export function DashboardPage({
  baseUrl,
  auth,
  signedIn,
  sessionSoftExpired,
  signOut,
  publicMode = false,
  publicToken = null,
  signInUrl = "/sign-in",
  signUpUrl = "/sign-up",
  onMainContentVisible,
}) {
  const { resolvedLocale } = useLocale();
  const { currency, rate } = useCurrency();
  const { mode: tokenFormatMode, setMode: setTokenFormatMode, formatTokens, formatTokensTooltip } = useTokenFormat();
  const [costModalOpen, setCostModalOpen] = useState(false);
  const [linkCode, setLinkCode] = useState(null);
  const [linkCodeExpiresAt, setLinkCodeExpiresAt] = useState(null);
  const [linkCodeLoading, setLinkCodeLoading] = useState(false);
  const [linkCodeError, setLinkCodeError] = useState(null);
  const [linkCodeExpiryTick, setLinkCodeExpiryTick] = useState(0);
  const [linkCodeRefreshToken, setLinkCodeRefreshToken] = useState(0);
  const [userStatus, setUserStatus] = useState(null);
  const screenshotMode = useMemo(() => {
    if (typeof window === "undefined") return false;
    return isScreenshotModeEnabled(window.location.search);
  }, []);
  const forceInstall = useMemo(() => isForceInstallEnabled(), []);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const identityScrambleDurationMs = 2200;
  const [coreIndexCollapsed, setCoreIndexCollapsed] = useState(true);
  const [installCopied, setInstallCopied] = useState(false);
  const [sessionExpiredCopied, setSessionExpiredCopied] = useState(false);
  const [manualSyncLoading, setManualSyncLoading] = useState(false);
  const [dashboardContentShown, setDashboardContentShown] = useState(false);
  const mainContentVisibleNotifiedRef = useRef(false);
  const mockEnabled = isMockEnabled();
  const authTokenAllowed = signedIn && !sessionSoftExpired;
  const authAccessToken = useMemo(() => {
    if (!authTokenAllowed) return null;
    if (typeof auth === "function") return auth;
    if (typeof auth === "string") return auth;
    if (auth && typeof auth === "object") return auth;
    return null;
  }, [auth, authTokenAllowed]);
  const effectiveAuthToken = authTokenAllowed ? authAccessToken : null;
  const accessToken = publicMode ? normalizeAccessToken(publicToken) : effectiveAuthToken;
  const accessEnabled = signedIn || mockEnabled || publicMode;
  const authTokenReady = authTokenAllowed && isAccessTokenReady(effectiveAuthToken);
  const guestAllowed = signedIn && sessionSoftExpired && !publicMode;

  // Cloud (cross-device account view) — driven by Settings → Cloud sync toggle
  // on localhost, mandatory on public hosts (www.tokentracker.cc et al.).
  // publicMode (shared link) opts out of account view entirely.
  const {
    accountView: accountViewBase,
    revision: accountRevision,
    resolving: accountResolvingBase,
  } = useAccountView();
  const accountView = accountViewBase && !publicMode;
  const accountAccessToken = accountView ? effectiveAuthToken : null;
  // While the resolved scope is still unknown (auth loading + cloud likely),
  // hooks hold a loading state instead of painting local data that would be
  // wiped on the flip to cloud (the local→cloud "double flash").
  const accountViewResolving = accountResolvingBase && !publicMode;


  useEffect(() => {
    if (!signedIn || mockEnabled) {
      setLinkCode(null);
      setLinkCodeExpiresAt(null);
      setLinkCodeLoading(false);
      setLinkCodeError(null);
      return;
    }
    if (publicMode) return;
    if (!authTokenReady) {
      setLinkCode(null);
      setLinkCodeExpiresAt(null);
      setLinkCodeLoading(false);
      setLinkCodeError(null);
      return;
    }
    let active = true;
    const resetLinkCode = () => {
      setLinkCode(null);
      setLinkCodeExpiresAt(null);
      setLinkCodeLoading(false);
      setLinkCodeError(null);
    };
    setLinkCodeLoading(true);
    setLinkCodeError(null);
    (async () => {
      let resolvedToken = null;
      try {
        resolvedToken = await resolveAuthAccessToken(effectiveAuthToken);
      } catch (_err) {
        resolvedToken = null;
      }
      if (!active) return;
      if (!resolvedToken) {
        resetLinkCode();
        return;
      }
      try {
        const data = { link_code: null, expires_at: null };
        if (!active) return;
        setLinkCode(typeof data?.link_code === "string" ? data.link_code : null);
        setLinkCodeExpiresAt(typeof data?.expires_at === "string" ? data.expires_at : null);
      } catch (err) {
        if (!active) return;
        setLinkCode(null);
        setLinkCodeExpiresAt(null);
        setLinkCodeError(err?.message || "Failed to load link code");
      } finally {
        if (!active) return;
        setLinkCodeLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    baseUrl,
    mockEnabled,
    signedIn,
    publicMode,
    authTokenReady,
    effectiveAuthToken,
    linkCodeRefreshToken,
  ]);

  // 本地模式判断
  const isLocalMode = typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  useEffect(() => {
    // 本地模式：跳过登录检查，直接获取 userStatus
    if (!isLocalMode && (!signedIn || mockEnabled || publicMode)) {
      setUserStatus(null);
      return;
    }
    if (!isLocalMode && !authTokenReady) {
      setUserStatus(null);
      return;
    }
    let active = true;
    (async () => {
      let resolvedToken = null;
      try {
        resolvedToken = await resolveAuthAccessToken(effectiveAuthToken);
      } catch (_err) {
        resolvedToken = null;
      }
      if (!active) return;
      // 本地模式允许空 token
      if (!resolvedToken && !isLocalMode) {
        setUserStatus(null);
        return;
      }
      try {
        const data = await getUserStatus({
          baseUrl,
          accessToken: resolvedToken,
        });
        if (!active) return;
        setUserStatus(data && typeof data === "object" ? data : null);
      } catch (_err) {
        if (!active) return;
        setUserStatus(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [authTokenReady, baseUrl, effectiveAuthToken, mockEnabled, publicMode, signedIn]);

  const linkCodeExpired = useMemo(() => {
    if (!linkCodeExpiresAt) return false;
    const ts = Date.parse(linkCodeExpiresAt);
    if (!Number.isFinite(ts)) return false;
    const now = linkCodeExpiryTick || Date.now();
    return ts <= now;
  }, [linkCodeExpiresAt, linkCodeExpiryTick]);

  useEffect(() => {
    if (!signedIn || mockEnabled || publicMode) return;
    if (!linkCodeExpiresAt || !linkCodeExpired) return;
    if (linkCodeLoading) return;
    setLinkCode(null);
    setLinkCodeExpiresAt(null);
    setLinkCodeError(null);
    setLinkCodeRefreshToken((value) => value + 1);
  }, [linkCodeExpired, linkCodeExpiresAt, linkCodeLoading, mockEnabled, signedIn]);

  useEffect(() => {
    if (!linkCodeExpiresAt || publicMode) return;
    const ts = Date.parse(linkCodeExpiresAt);
    if (!Number.isFinite(ts)) return;
    const now = Date.now();
    setLinkCodeExpiryTick(now);
    if (ts <= now) return;
    const timeoutId = window.setTimeout(() => setLinkCodeExpiryTick(Date.now()), ts - now);
    const handleVisibilityChange = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      setLinkCodeExpiryTick(Date.now());
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    window.addEventListener("focus", handleVisibilityChange);
    return () => {
      window.clearTimeout(timeoutId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      window.removeEventListener("focus", handleVisibilityChange);
    };
  }, [linkCodeExpiresAt]);

  const timeZone = useMemo(() => getBrowserTimeZone(), []);
  const tzOffsetMinutes = useMemo(() => getBrowserTimeZoneOffsetMinutes(), []);
  const mockNow = useMemo(() => getMockNow(), []);
  const cacheKey = publicMode ? null : auth?.userId || auth?.email || "default";
  const [selectedPeriod, setSelectedPeriod] = useState("month");
  const [customFrom, setCustomFrom] = useState(null);
  const [customTo, setCustomTo] = useState(null);
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const period = screenshotMode ? "total" : selectedPeriod;
  const range = useMemo(() => {
    if (period === "custom" && customFrom && customTo) {
      return { from: customFrom, to: customTo };
    }
    return getRangeForPeriod(period, {
      timeZone,
      offsetMinutes: tzOffsetMinutes,
      now: mockNow,
    });
  }, [mockNow, period, timeZone, tzOffsetMinutes, customFrom, customTo]);
  const from = range.from;
  const to = range.to;

  const [selectedDevice, setSelectedDevice] = useState(null);
  const [currentDeviceId, setCurrentDeviceId] = useState(() => getCurrentDeviceId());
  useEffect(() => {
    const refreshCurrentDevice = () => setCurrentDeviceId(getCurrentDeviceId());
    window.addEventListener(CLOUD_USAGE_SYNCED_EVENT, refreshCurrentDevice);
    window.addEventListener("storage", refreshCurrentDevice);
    return () => {
      window.removeEventListener(CLOUD_USAGE_SYNCED_EVENT, refreshCurrentDevice);
      window.removeEventListener("storage", refreshCurrentDevice);
    };
  }, []);
  const { devices: accountDevices, accountSources: accountDeviceSources, refresh: refreshAccountDevices } = useAccountDevices({
    from,
    to,
    timeZone,
    tzOffsetMinutes,
    accountView,
    accountAccessToken,
    accountRevision,
  });
  // Only devices with usage in the selected range are shown anywhere — a
  // zero-usage registration (typically a stale fingerprint-drift duplicate) is
  // noise in both the filter dropdown and the breakdown card.
  const activeDevices = useMemo(
    () => accountDevices
      .filter((d) => (Number(d.total_tokens) || 0) > 0)
      .map((d) => ({ ...d, isCurrent: d.id === currentDeviceId })),
    [accountDevices, currentDeviceId],
  );
  const accountSourceRows = useMemo(
    () => accountDeviceSources.filter((s) => (Number(s.total_tokens) || 0) > 0),
    [accountDeviceSources],
  );
  // Dropdown filter: choosing between devices needs 2+ of them.
  const showDeviceFilter = accountView && activeDevices.length >= 2;
  // Breakdown card: needs 2+ rows; account-level sources count as rows.
  const showDeviceCard = accountView && activeDevices.length + accountSourceRows.length >= 2;
  // Reset the filter when no selector is visible, or when the selected device
  // disappears (revoked / idle in the new range / not in the latest list).
  useEffect(() => {
    if (!showDeviceFilter && !showDeviceCard) {
      if (selectedDevice !== null) setSelectedDevice(null);
      return;
    }
    if (selectedDevice && !activeDevices.some((d) => d.id === selectedDevice)) {
      setSelectedDevice(null);
    }
  }, [showDeviceFilter, showDeviceCard, activeDevices, selectedDevice]);

  const deviceOptions = useMemo(() => {
    if (!showDeviceFilter) return [];
    return [
      { value: "", label: copy("dashboard.device_filter.all") },
      ...activeDevices.map((d) => {
        const deviceLabel = formatDeviceLabel(d) || copy("dashboard.device_card.unnamed");
        const currentSuffix = d.isCurrent ? ` (${copy("dashboard.device_card.current")})` : "";
        return { value: d.id, label: `${deviceLabel}${currentSuffix}` };
      }),
    ];
  }, [showDeviceFilter, activeDevices, resolvedLocale]);

  const deviceUsageBlock = showDeviceCard ? (
    <DeviceUsageCard
      devices={activeDevices}
      accountSources={accountSourceRows}
      currentDeviceId={currentDeviceId}
      selectedDeviceId={selectedDevice || ""}
      onSelectDevice={(id) => setSelectedDevice(id || null)}
      onRenameDevice={async (id, name) => {
        const token = await resolveAuthAccessToken(accountAccessToken);
        await renameAccountDevice({ deviceId: id, name, accessToken: token });
        await refreshAccountDevices();
      }}
    />
  ) : null;

  const timeZoneLabel = useMemo(
    () => formatTimeZoneLabel({ timeZone, offsetMinutes: tzOffsetMinutes }),
    [timeZone, tzOffsetMinutes],
  );
  const timeZoneShortLabel = useMemo(
    () => formatTimeZoneShortLabel({ timeZone, offsetMinutes: tzOffsetMinutes }),
    [timeZone, tzOffsetMinutes],
  );
  const timeZoneRangeLabel = useMemo(
    () => `Local time (${timeZoneShortLabel})`,
    [timeZoneShortLabel],
  );
  const trendTimeZone = timeZone;
  const trendTzOffsetMinutes = tzOffsetMinutes;
  const trendTimeZoneLabel = timeZoneLabel;
  const todayKey = useMemo(
    () =>
      getLocalDayKey({
        timeZone,
        offsetMinutes: tzOffsetMinutes,
        date: mockNow || new Date(),
      }),
    [mockNow, timeZone, tzOffsetMinutes],
  );
  const dailyBreakdownRange = useMemo(() => {
    return buildDailyBreakdownRange({
      period,
      selectedFrom: from,
      selectedTo: to,
      todayKey,
    });
  }, [from, period, to, todayKey]);

  const {
    daily,
    summary,
    rolling,
    source: usageSource,
    loading: usageLoading,
    error: usageError,
    refresh: refreshUsage,
  } = useUsageData({
    baseUrl,
    accessToken,
    guestAllowed,
    from,
    to,
    includeDaily: period !== "total",
    cacheKey,
    timeZone,
    tzOffsetMinutes,
    now: mockNow,
    accountView,
    accountAccessToken,
    accountRevision,
    accountViewResolving,
    deviceId: selectedDevice,
  });
  const {
    daily: dailyBreakdownDaily,
    loading: dailyBreakdownLoading,
    refresh: refreshDailyBreakdown,
  } = useUsageData({
    baseUrl,
    accessToken,
    guestAllowed,
    from: dailyBreakdownRange.from,
    to: dailyBreakdownRange.to,
    includeDaily: true,
    // This card only renders daily rows. Avoid a second account-summary scan
    // whose totals/rolling payload was fetched and then discarded.
    includeSummary: false,
    cacheKey: cacheKey ? `${cacheKey}.daily-breakdown` : "daily-breakdown",
    timeZone,
    tzOffsetMinutes,
    now: mockNow,
    accountView,
    accountAccessToken,
    accountRevision,
    accountViewResolving,
    // Keep the daily breakdown aligned with the selected device used by the
    // main usage/detail cards. Without this, choosing a device only filtered
    // some cards while the daily table continued to show account-wide rows.
    deviceId: selectedDevice,
  });

  const {
    breakdown: modelBreakdown,
    loading: modelBreakdownLoading,
    refresh: refreshModelBreakdown,
  } = useUsageModelBreakdown({
    baseUrl,
    accessToken,
    guestAllowed,
    from,
    to,
    cacheKey,
    timeZone,
    tzOffsetMinutes,
    accountView,
    accountAccessToken,
    accountRevision,
    accountViewResolving,
    deviceId: selectedDevice,
  });

  const [projectUsageLimit, setProjectUsageLimit] = useState(3);
  const {
    entries: projectUsageEntries,
    loading: projectUsageLoading,
    refresh: refreshProjectUsage,
  } = useProjectUsageSummary({
    baseUrl,
    accessToken,
    from,
    to,
    timeZone,
    tzOffsetMinutes,
  });

  const shareDailyToTrend = period === "week" || period === "month";
  const useDailyTrend = period === "week" || period === "month";
  const visibleDaily = useMemo(() => {
    return daily.filter((row) => {
      if (row?.future) return false;
      if (!row?.day || !todayKey) return true;
      return String(row.day) <= String(todayKey);
    });
  }, [daily, todayKey]);
  const {
    rows: trendRows,
    from: trendFrom,
    to: trendTo,
    loading: trendLoading,
    refresh: refreshTrend,
  } = useTrendData({
    baseUrl,
    accessToken,
    guestAllowed,
    period,
    from,
    to,
    months: 24,
    cacheKey,
    timeZone: trendTimeZone,
    tzOffsetMinutes: trendTzOffsetMinutes,
    now: mockNow,
    sharedRows: shareDailyToTrend ? daily : null,
    sharedRange: shareDailyToTrend ? { from, to } : null,
    accountView,
    accountAccessToken,
    accountRevision,
    accountViewResolving,
    deviceId: selectedDevice,
  });

  // Stable useTrendData config handed to the zoom modal so it can hold its OWN
  // data instance for granularity drill-down (30min/Day/Month) without mutating
  // the dashboard's period/range state.
  const trendZoomConfig = useMemo(
    () => ({
      baseUrl,
      accessToken,
      guestAllowed,
      cacheKey,
      timeZone: trendTimeZone,
      tzOffsetMinutes: trendTzOffsetMinutes,
      now: mockNow,
      // Carry the account (cross-device cloud) scope into the zoom modal so its
      // granularity drill-down reads the SAME source as the main trend chart —
      // otherwise the zoom silently shows local/default-scope data in account view.
      accountView,
      accountAccessToken,
      accountRevision,
      accountViewResolving,
    }),
    [
      baseUrl, accessToken, guestAllowed, cacheKey, trendTimeZone, trendTzOffsetMinutes, mockNow,
      accountView, accountAccessToken, accountRevision, accountViewResolving,
    ],
  );

  const {
    daily: heatmapDaily,
    heatmap,
    loading: heatmapLoading,
    refresh: refreshHeatmap,
  } = useActivityHeatmap({
    baseUrl,
    accessToken,
    guestAllowed,
    weeks: 52,
    cacheKey,
    timeZone,
    tzOffsetMinutes,
    now: mockNow,
    accountView,
    accountAccessToken,
    accountRevision,
    accountViewResolving,
    deviceId: selectedDevice,
  });

  const {
    data: usageLimits,
    refresh: refreshUsageLimits,
  } = useUsageLimits();

  useEffect(() => {
    if (usageLimits && typeof usageLimits === "object") {
      publishUsageLimitsPreloadState(usageLimits);
    }
  }, [usageLimits]);

  const detailsDateKey = useMemo(() => {
    if (period === "day") return "hour";
    if (period === "total") return "month";
    return "day";
  }, [period]);
  const detailsColumns = useMemo(() => getDetailsSortColumns(detailsDateKey), [detailsDateKey]);
  const dailyBreakdownDateKey = "day";
  const dailyBreakdownColumns = useMemo(() => getDetailsSortColumns(dailyBreakdownDateKey), []);
  const [sort, setSort] = useState(() => ({ key: "day", dir: "desc" }));
  useEffect(() => {
    setSort((prev) => {
      if (!DETAILS_DATE_KEYS.has(prev.key)) return prev;
      if (prev.key === detailsDateKey) return prev;
      return { key: detailsDateKey, dir: prev.dir };
    });
  }, [detailsDateKey]);
  const effectiveSort = useMemo(() => {
    if (DETAILS_DATE_KEYS.has(sort.key) && sort.key !== detailsDateKey) {
      return { ...sort, key: detailsDateKey };
    }
    return sort;
  }, [detailsDateKey, sort]);
  const detailsRows = useMemo(() => {
    if (period === "day") {
      return Array.isArray(trendRows) ? trendRows.filter((row) => row?.hour && !row?.future) : [];
    }
    if (period === "total") {
      const rows = Array.isArray(trendRows)
        ? trendRows.filter((row) => row?.month && !row?.future)
        : [];
      return trimLeadingZeroMonths(rows);
    }
    // 对于 week/month/all/today 等，优先使用 visibleDaily
    // 如果数据为空或全是 missing，回退到最近30天的 daily 数据
    const rows = visibleDaily;
    const hasActualData = rows.some((row) => !row?.missing && !row?.future);
    if (!hasActualData && daily.length > 0) {
      // 取最近30天有数据的记录
      return daily
        .filter((row) => !row?.future)
        .slice(-30)
        .filter((row) => row?.day);
    }
    return rows;
  }, [period, trendRows, visibleDaily, daily]);
  const sortedDetails = useMemo(
    () => sortDailyRows(detailsRows, effectiveSort),
    [detailsRows, effectiveSort],
  );
  const hasDetailsActual = useMemo(
    () => detailsRows.some((row) => !row?.missing && !row?.future),
    [detailsRows],
  );
  const detailsPageCount = useMemo(() => {
    if (!DETAILS_PAGED_PERIODS.has(period)) return 1;
    const count = Math.ceil(sortedDetails.length / DETAILS_PAGE_SIZE);
    return count > 0 ? count : 1;
  }, [period, sortedDetails.length]);
  const [detailsPage, setDetailsPage] = useState(0);
  useEffect(() => {
    if (!DETAILS_PAGED_PERIODS.has(period)) {
      setDetailsPage(0);
      return;
    }
    setDetailsPage((prev) => Math.min(prev, detailsPageCount - 1));
  }, [detailsPageCount, period]);
  useEffect(() => {
    if (!DETAILS_PAGED_PERIODS.has(period)) return;
    setDetailsPage(0);
  }, [period, sort.dir, sort.key]);
  const pagedDetails = useMemo(() => {
    if (!DETAILS_PAGED_PERIODS.has(period)) return sortedDetails;
    return paginateRows(sortedDetails, detailsPage, DETAILS_PAGE_SIZE);
  }, [detailsPage, period, sortedDetails]);

  // Regular periods show the last 30 calendar days. Total view uses the
  // selected history range and keeps the latest 30 observed days, so an idle
  // account does not look erased behind a screenful of missing rows.
  const dailyBreakdownRows = useMemo(() => {
    return selectDailyBreakdownRows(dailyBreakdownDaily, { period });
  }, [dailyBreakdownDaily, period]);
  const dailyBreakdownSort = useMemo(() => {
    if (DETAILS_DATE_KEYS.has(sort.key)) {
      return { ...sort, key: dailyBreakdownDateKey };
    }
    return sort;
  }, [sort]);
  const sortedDailyBreakdownRows = useMemo(
    () => sortDailyRows(dailyBreakdownRows, dailyBreakdownSort),
    [dailyBreakdownRows, dailyBreakdownSort],
  );
  const trendRowsForDisplay = useMemo(() => {
    if (useDailyTrend) return daily;
    if (period === "day") {
      return Array.isArray(trendRows) ? trendRows.filter((row) => row?.hour) : [];
    }
    return trendRows;
  }, [daily, period, trendRows, useDailyTrend]);
  const trendFromForDisplay = useDailyTrend ? from : trendFrom;
  const trendToForDisplay = useDailyTrend ? to : trendTo;

  function renderDetailCell(row, key) {
    if (row?.future) return "—";
    if (row?.missing) return copy("shared.status.unsynced");
    if (key.endsWith("_tokens")) {
      const value = key === "total_tokens" ? getBillableTotal(row) : row?.[key];
      return (
        <span title={formatTokensTooltip(value)}>
          {formatTokens(value)}
        </span>
      );
    }
    return toDisplayNumber(row?.[key]);
  }

  function renderDetailDate(row) {
    const raw = row?.[detailsDateKey];
    if (raw == null) return "";
    const value = String(raw);
    if (detailsDateKey === "hour") {
      const [datePart, timePart] = value.split("T");
      if (datePart && timePart) {
        return `${datePart} ${timePart.slice(0, 5)}`;
      }
    }
    return value;
  }

  function renderDailyBreakdownDate(row) {
    const raw = row?.[dailyBreakdownDateKey];
    return raw == null ? "" : String(raw);
  }

  function toggleSort(key) {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      return { key, dir: "desc" };
    });
  }

  function ariaSortFor(key) {
    if (effectiveSort.key !== key) return "none";
    return effectiveSort.dir === "asc" ? "ascending" : "descending";
  }

  function sortIconFor(key) {
    if (effectiveSort.key !== key) return "";
    return effectiveSort.dir === "asc" ? "▲" : "▼";
  }

  function dailyAriaSortFor(key) {
    if (dailyBreakdownSort.key !== key) return "none";
    return dailyBreakdownSort.dir === "asc" ? "ascending" : "descending";
  }

  function dailySortIconFor(key) {
    if (dailyBreakdownSort.key !== key) return "";
    return dailyBreakdownSort.dir === "asc" ? "▲" : "▼";
  }

  const activeDays = useMemo(() => {
    // 本地模式下跳过登录检查
    if (!signedIn && !mockEnabled && !publicMode && !isLocalMode) return 0;
    const serverActive = Number(heatmap?.active_days);
    if (Number.isFinite(serverActive)) return serverActive;

    let count = 0;
    const seen = new Set();
    const considerDay = (day, value, level) => {
      if (typeof day !== "string" || !day) return;
      if (seen.has(day)) return;
      if (!hasUsageValue(value, level)) return;
      seen.add(day);
      count += 1;
    };

    if (Array.isArray(heatmapDaily)) {
      for (const row of heatmapDaily) {
        considerDay(row?.day, getBillableTotal(row));
      }
    }

    const weeks = Array.isArray(heatmap?.weeks) ? heatmap.weeks : [];
    for (const week of weeks) {
      for (const cell of Array.isArray(week) ? week : []) {
        const value = getHeatmapValue(cell);
        considerDay(cell?.day, value, cell?.level);
      }
    }

    return count;
  }, [signedIn, mockEnabled, heatmap?.active_days, heatmap?.weeks, heatmapDaily]);

  const [prevPeriod, setPrevPeriod] = useState("month");
  const handlePeriodChange = useCallback((p) => {
    if (p === "custom") {
      setPrevPeriod((prev) => (prev === "custom" ? "month" : prev));
      setSelectedPeriod((cur) => {
        // If already have custom dates, switch to custom immediately
        if (customFrom && customTo) return "custom";
        return cur;
      });
      setCustomRangeOpen(true);
    } else {
      setSelectedPeriod(p);
      setPrevPeriod(p);
      setCustomRangeOpen(false);
    }
  }, [customFrom, customTo]);

  const handleCustomRangeApply = useCallback((fromDate, toDate) => {
    setCustomFrom(fromDate);
    setCustomTo(toDate);
    setSelectedPeriod("custom");
    setCustomRangeOpen(false);
  }, []);

  const handleCustomRangeOpenChange = useCallback((open) => {
    setCustomRangeOpen(open);
    // If popover closed without applying and no custom dates exist, revert
    if (!open && selectedPeriod === "custom" && !customFrom) {
      setSelectedPeriod(prevPeriod);
    }
  }, [selectedPeriod, customFrom, prevPeriod]);

  // Refreshes can originate from the manual button, a visibility event, and
  // the local queue watcher at nearly the same time.  Keep one in-flight
  // aggregate per dashboard context so those triggers do not fan out into
  // six duplicate endpoint requests (and invalidate each other's responses).
  const usageStatsFlightRef = useRef(null);
  const refreshContextKey = useMemo(
    () => [
      baseUrl || "",
      cacheKey || "",
      accountView ? "cloud" : "local",
      accountRevision ?? "",
      period || "",
      from || "",
      to || "",
      todayKey || "",
      selectedDevice || "all",
      timeZone || "",
      tzOffsetMinutes ?? "",
    ].join("\u001f"),
    [
      accountRevision,
      accountView,
      baseUrl,
      cacheKey,
      from,
      period,
      selectedDevice,
      timeZone,
      todayKey,
      to,
      tzOffsetMinutes,
    ],
  );

  const refreshUsageStats = useCallback(async () => {
    return runSingleFlight(usageStatsFlightRef, refreshContextKey, async () => {
      if (accountView) invalidateAccountResponseCache();
      if (!accountView) invalidateSessionInsightsCache();
      await Promise.all([
        refreshUsage(),
        refreshHeatmap(),
        refreshTrend(),
        refreshModelBreakdown(),
        refreshProjectUsage(),
        refreshDailyBreakdown(),
      ]);
    });
  }, [
    accountView,
    refreshDailyBreakdown,
    refreshHeatmap,
    refreshModelBreakdown,
    refreshProjectUsage,
    refreshTrend,
    refreshUsage,
    refreshContextKey,
  ]);

  const refreshAllFlightRef = useRef(null);
  const refreshAll = useCallback(async () => {
    return runSingleFlight(refreshAllFlightRef, refreshContextKey, async () => {
      await refreshDashboardAggregates({
        refreshUsageStats,
        refreshUsageLimits,
      });
    });
  }, [refreshContextKey, refreshUsageLimits, refreshUsageStats]);

  // Hold the latest aggregate refresher in a ref so the mount / auto-refresh
  // effects below can call it WITHOUT listing it as a dependency.
  // `refreshUsageStats` changes identity whenever any child refresh callback
  // does — notably `refreshTrend`, whose identity flips on every new `daily`
  // array reference. If the effects depended on it, the local-reload effect
  // would re-fire a full refresh on every render, and each refresh mints a new
  // `daily`, closing an infinite usage-refresh loop (#360).
  const refreshUsageStatsRef = useRef(refreshUsageStats);
  useEffect(() => {
    refreshUsageStatsRef.current = refreshUsageStats;
  }, [refreshUsageStats]);

  // The DMG starts its embedded server with --no-sync, so a page reload used
  // to fetch the same stale queue again. Refresh all local log/database sources
  // (Claude, Gemini, OpenCode, Codex, etc.) without doing cloud upload, Cursor
  // network access, or deep Codex archive work, then re-read local aggregates.
  // Keep the promise in a ref so React Strict Mode can reattach to the first
  // request instead of starting a duplicate sync.
  const localReloadSyncPromiseRef = useRef(null);
  useEffect(() => {
    if (!isLocalMode || mockEnabled || accountView) return undefined;
    if (!localReloadSyncPromiseRef.current) {
      localReloadSyncPromiseRef.current = triggerLocalSync({
        auto: true,
        background: true,
        allLocalSources: true,
      });
    }
    let active = true;
    localReloadSyncPromiseRef.current
      .then(() => {
        if (active) return refreshUsageStatsRef.current();
        return undefined;
      })
      .catch((error) => {
        if (active) console.warn("[DashboardPage] Reload sync failed:", error);
      });
    return () => {
      active = false;
    };
  }, [isLocalMode, mockEnabled, accountView]);

  // Provider hooks update the queue quickly, while the native server also
  // performs a once-per-minute all-source fallback scan. Re-read the local
  // aggregates while this dashboard remains visible so those queue updates
  // appear without requiring a click or a page reload.
  useEffect(() => {
    if (!isLocalMode || mockEnabled || accountView) return undefined;
    const autoRefresh = startLocalUsageAutoRefresh({
      refresh: () => refreshUsageStatsRef.current(),
      onError: (error) =>
        console.warn("[DashboardPage] Automatic usage refresh failed:", error),
    });
    return () => autoRefresh.stop();
  }, [isLocalMode, mockEnabled, accountView]);

  const handleUsageRefresh = useCallback(async () => {
    setManualSyncLoading(true);
    try {
      if (isLocalMode) {
        await triggerLocalSync(LOCAL_DASHBOARD_REFRESH_OPTIONS);
      }
      await refreshAll();
    } catch (error) {
      console.error("[DashboardPage] Refresh failed:", error);
    } finally {
      setManualSyncLoading(false);
    }
  }, [isLocalMode, refreshAll]);

  const usageLoadingState =
    manualSyncLoading ||
    usageLoading ||
    dailyBreakdownLoading ||
    heatmapLoading ||
    trendLoading ||
    modelBreakdownLoading ||
    projectUsageLoading;
  // Show the dashboard skeleton only on the *initial* cloud (account-view)
  // load — while auth/cloud is resolving, or while the first account fetch is
  // in flight and no detail rows exist yet. A later refresh keeps the rendered
  // data (no skeleton, no flash); local mode loads fast and is left untouched.
  const initialDashboardLoading =
    !dashboardContentShown &&
    (accountViewResolving ||
      (accountView && usageLoadingState && !hasDetailsActual));
  const usageSourceLabel = useMemo(
    () =>
      copy("shared.data_source", {
        source: String(usageSource || "edge").toUpperCase(),
      }),
    [usageSource, resolvedLocale],
  );
  const identityRawName = useMemo(() => {
    if (typeof auth?.name !== "string") return "";
    return auth.name.trim();
  }, [auth?.name]);
  const publicIdentityName = "";

  const identityLabel = useMemo(() => {
    if (!identityRawName || identityRawName.includes("@")) {
      return copy("dashboard.identity.fallback");
    }
    return identityRawName;
  }, [identityRawName]);

  const identityHandle = useMemo(() => {
    return identityLabel.replace(/[^a-zA-Z0-9._-]/g, "_");
  }, [identityLabel]);

  const identityDisplayName = useMemo(() => {
    if (publicMode) {
      return publicIdentityName || copy("dashboard.identity.fallback");
    }
    return identityHandle;
  }, [identityHandle, publicIdentityName, publicMode]);
  const identityStartDate = useMemo(() => {
    let earliest = null;

    const considerDay = (day) => {
      if (typeof day !== "string" || !day) return;
      if (!earliest || day < earliest) earliest = day;
    };

    if (Array.isArray(heatmapDaily)) {
      for (const row of heatmapDaily) {
        if (!row?.day) continue;
        if (!hasUsageValue(getBillableTotal(row))) continue;
        considerDay(row.day);
      }
    }

    const weeks = Array.isArray(heatmap?.weeks) ? heatmap.weeks : [];
    for (const week of weeks) {
      for (const cell of Array.isArray(week) ? week : []) {
        if (!cell?.day) continue;
        const value = getHeatmapValue(cell);
        const level = cell?.level;
        if (!hasUsageValue(value, level)) continue;
        considerDay(cell.day);
      }
    }

    return earliest;
  }, [heatmap?.weeks, heatmapDaily]);
  const identitySubscriptions = useMemo(() => {
    if (publicMode) return [];
    const rows = Array.isArray(userStatus?.subscriptions?.items)
      ? userStatus.subscriptions.items
      : [];
    const normalized = rows
      .map((row) => {
        const tool = typeof row?.tool === "string" ? row.tool.trim() : "";
        const planTypeRaw =
          typeof row?.plan_type === "string"
            ? row.plan_type
            : typeof row?.planType === "string"
              ? row.planType
              : "";
        const planType = planTypeRaw.trim();
        if (!tool || !planType) return null;
        return {
          tool,
          planType,
          provider: typeof row?.provider === "string" ? row.provider.trim() : "",
          product: typeof row?.product === "string" ? row.product.trim() : "",
          rateLimitTier:
            typeof row?.rate_limit_tier === "string"
              ? row.rate_limit_tier.trim()
              : typeof row?.rateLimitTier === "string"
                ? row.rateLimitTier.trim()
                : "",
        };
      })
      .filter(Boolean);
    return normalized.slice(0, 6);
  }, [publicMode, userStatus]);

  const activityHeatmapBlock = (
    <ActivityHeatmap
      heatmap={heatmap}
      timeZoneLabel={timeZoneLabel}
      timeZoneShortLabel={timeZoneShortLabel}
      hideLegend={screenshotMode}
      defaultToLatestMonth={screenshotMode}
    />
  );

  const rangeLabel = useMemo(() => {
    return `${from}..${to}`;
  }, [from, period, to]);

  const summaryLabel = copy("usage.summary.total");
  const hasSummary = summary != null;
  const summaryTotalTokens = hasSummary ? getBillableTotal(summary) : 0;
  const summaryValue = formatTokens(summaryTotalTokens);
  const toggleSummaryFormat = useCallback(() => {
    setTokenFormatMode(
      tokenFormatMode === TOKEN_FORMAT_MODES.COMPACT
        ? TOKEN_FORMAT_MODES.FULL
        : TOKEN_FORMAT_MODES.COMPACT,
    );
  }, [setTokenFormatMode, tokenFormatMode]);

  const coreIndexCollapseLabel = copy("dashboard.core_index.collapse_label");
  const coreIndexExpandLabel = copy("dashboard.core_index.expand_label");
  const coreIndexCollapseAria = copy("dashboard.core_index.collapse_aria");
  const coreIndexExpandAria = copy("dashboard.core_index.expand_aria");
  const allowBreakdownToggle = !screenshotMode;
  const placeholderShort = copy("shared.placeholder.short");
  const agentSummary = useMemo(() => {
    const sources = Array.isArray(modelBreakdown?.sources) ? modelBreakdown.sources : [];
    let topSource = null;
    let topSourceTokens = 0;

    for (const source of sources) {
      const tokens = resolveDisplayTokens(source?.totals);
      if (!Number.isFinite(tokens) || tokens <= 0) continue;
      if (tokens > topSourceTokens) {
        topSourceTokens = tokens;
        topSource = source;
      }
    }

    let agentName = placeholderShort;
    let modelName = placeholderShort;
    let modelPercent = "0.0";

    if (topSource && topSourceTokens > 0) {
      agentName = topSource?.source ? String(topSource.source).toUpperCase() : placeholderShort;
      const models = Array.isArray(topSource?.models) ? topSource.models : [];
      let topModelTokens = 0;
      for (const model of models) {
        const tokens = resolveDisplayTokens(model?.totals);
        if (!Number.isFinite(tokens) || tokens <= 0) continue;
        if (tokens > topModelTokens) {
          topModelTokens = tokens;
          modelName = model?.model ? String(model.model) : placeholderShort;
        }
      }
      if (topModelTokens > 0) {
        modelPercent = ((topModelTokens / topSourceTokens) * 100).toFixed(1);
      }
    }

    return { agentName, modelName, modelPercent };
  }, [modelBreakdown, placeholderShort]);
  const displayTotalTokens = toDisplayNumber(summaryTotalTokens);
  const twitterTotalTokens = displayTotalTokens === "-" ? placeholderShort : displayTotalTokens;
  const screenshotTwitterText = copy("dashboard.screenshot.twitter_text", {
    total_tokens: twitterTotalTokens,
    agent_name: agentSummary.agentName,
    model_name: agentSummary.modelName,
    model_percent: agentSummary.modelPercent,
  });
  const periodsForDisplay = useMemo(() => (screenshotMode ? [] : PERIODS), [screenshotMode]);

  const metricsRows = useMemo(
    () => [
      {
        label: copy("usage.metric.total"),
        value: hasSummary ? formatTokens(summaryTotalTokens) : "—",
        title: hasSummary ? formatTokensTooltip(summaryTotalTokens) : undefined,
        valueClassName: "text-white",
      },
      {
        label: copy("usage.metric.input"),
        value: hasSummary ? formatTokens(summary?.input_tokens) : "—",
        title: hasSummary ? formatTokensTooltip(summary?.input_tokens) : undefined,
      },
      ...(Number(summary?.unclassified_input_tokens) > 0 ? [{
        label: copy("usage.metric.unclassified_input"),
        value: formatTokens(summary.unclassified_input_tokens),
        title: formatTokensTooltip(summary.unclassified_input_tokens),
      }] : []),
      {
        label: copy("usage.metric.output"),
        value: hasSummary ? formatTokens(summary?.output_tokens) : "—",
        title: hasSummary ? formatTokensTooltip(summary?.output_tokens) : undefined,
      },
      {
        label: copy("usage.metric.cached_input"),
        value: hasSummary ? formatTokens(summary?.cached_input_tokens) : "—",
        title: hasSummary ? formatTokensTooltip(summary?.cached_input_tokens) : undefined,
      },
      {
        label: copy("usage.metric.reasoning_output"),
        value: hasSummary ? formatTokens(summary?.reasoning_output_tokens) : "—",
        title: hasSummary ? formatTokensTooltip(summary?.reasoning_output_tokens) : undefined,
      },
    ],
    [
      summary?.cached_input_tokens,
      summary?.input_tokens,
      summary?.unclassified_input_tokens,
      summary?.output_tokens,
      summary?.reasoning_output_tokens,
      summaryTotalTokens,
      hasSummary,
      formatTokens,
      formatTokensTooltip,
    ],
  );

  const summaryCostValue = useMemo(
    () => summary?.cost_status === "partial" ? copy("usage.cost.partial") : formatUsdCurrency(summary?.total_cost_usd, { currency, rate }),
    [summary?.total_cost_usd, summary?.cost_status, currency, rate],
  );
  const summaryConversationsValue = useMemo(
    () => summary?.conversation_count ?? null,
    [summary?.conversation_count],
  );

  const fleetData = useMemo(
    () => buildFleetData(modelBreakdown, { copyFn: copy }),
    [modelBreakdown],
  );
  const topModels = useMemo(
    () => buildTopModels(modelBreakdown, { limit: 3, copyFn: copy }),
    [modelBreakdown],
  );

  const shareCardData = useShareCardData({
    enabled: shareModalOpen,
    handle: identityDisplayName,
    startDate: identityStartDate,
    activeDays,
    summary,
    topModels,
    period,
    periodFrom: from,
    periodTo: to,
    heatmap,
    accessToken: typeof accessToken === "string" ? accessToken : null,
    userId: auth?.userId || null,
    currency,
    exchangeRate: rate,
  });
  const openShareModal = useCallback(() => setShareModalOpen(true), []);
  const closeShareModal = useCallback(() => setShareModalOpen(false), []);

  const openCostModal = useCallback(() => setCostModalOpen(true), []);
  const closeCostModal = useCallback(() => setCostModalOpen(false), []);
  const costInfoEnabled = summaryCostValue && summaryCostValue !== "-" && fleetData.length > 0;

  const installInitCmdBase = copy("dashboard.install.cmd.init");
  const resolvedLinkCode = !linkCodeExpired ? linkCode : null;
  const installInitCmdCopy = resolvedLinkCode
    ? copy("dashboard.install.cmd.init_link_code", {
        link_code: resolvedLinkCode,
      })
    : installInitCmdBase;
  const installInitCmdDisplay = installInitCmdBase;
  const installSyncCmd = copy("dashboard.install.cmd.sync");
  const installCopyLabel = resolvedLinkCode
    ? copy("dashboard.install.copy")
    : copy("dashboard.install.copy_base");
  const installCopiedLabel = copy("dashboard.install.copied");
  const sessionExpiredCopyLabel = copy("dashboard.session_expired.copy_label");
  const sessionExpiredCopiedLabel = copy("dashboard.session_expired.copied");
  const hasActiveDeviceToken = Boolean(
    userStatus?.install?.has_active_device_token ?? userStatus?.install?.hasActiveDeviceToken,
  );
  const shouldShowInstall = shouldShowInstallCard({
    publicMode,
    screenshotMode,
    forceInstall,
    accessEnabled,
    heatmapLoading,
    activeDays,
    hasActiveDeviceToken,
  });
  const installPrompt = copy("dashboard.install.prompt");

  const handleCopyInstall = useCallback(async () => {
    if (!installInitCmdCopy) return;
    const didCopy = await safeWriteClipboard(installInitCmdCopy);
    if (!didCopy) return;
    setInstallCopied(true);
    window.setTimeout(() => setInstallCopied(false), 2000);
  }, [installInitCmdCopy]);

  const handleCopySessionExpired = useCallback(async () => {
    if (!installInitCmdBase) return;
    const didCopy = await safeWriteClipboard(installInitCmdBase);
    if (!didCopy) return;
    setSessionExpiredCopied(true);
    window.setTimeout(() => setSessionExpiredCopied(false), 2000);
  }, [installInitCmdBase]);

  const dailyEmptyTemplate = useMemo(
    () => copy("dashboard.daily.empty", { cmd: "{{cmd}}" }),
    [resolvedLocale],
  );
  const [dailyEmptyPrefix, dailyEmptySuffix] = useMemo(() => {
    const parts = dailyEmptyTemplate.split("{{cmd}}");
    if (parts.length === 1) return [dailyEmptyTemplate, ""];
    return [parts[0], parts.slice(1).join("{{cmd}}")];
  }, [dailyEmptyTemplate]);

  // Header 和 Footer 已简化，不显示登录/GitHub等
  const headerStatus = null;
  const headerRight = null;
  const footerLeftContent = null;

  const showExpiredGate = sessionSoftExpired && !publicMode;
  // 使用上面定义的 isLocalMode
  const requireAuthGate = !signedIn && !mockEnabled && !sessionSoftExpired && !isLocalMode;
  const showAuthGate = requireAuthGate && !publicMode;

  useEffect(() => {
    if (showExpiredGate || showAuthGate || initialDashboardLoading) return;
    setDashboardContentShown(true);
  }, [initialDashboardLoading, showAuthGate, showExpiredGate]);

  const dashboardCardOrder = useDashboardCardOrder(
    LEFT_CARD_ORDER_DEFAULTS,
    RIGHT_CARD_ORDER_DEFAULTS,
  );

  useEffect(() => {
    if (mainContentVisibleNotifiedRef.current) return;
    if (showExpiredGate || showAuthGate) return;
    if (usageLoadingState) return;
    mainContentVisibleNotifiedRef.current = true;
    onMainContentVisible?.();
  }, [onMainContentVisible, showAuthGate, showExpiredGate, usageLoadingState]);

  return (
    <>
    <DashboardView
      copy={copy}
      onOpenShare={openShareModal}
      screenshotMode={screenshotMode}
      showExpiredGate={showExpiredGate}
      showAuthGate={showAuthGate}
      identityDisplayName={identityDisplayName}
      identityStartDate={identityStartDate}
      activeDays={activeDays}
      identitySubscriptions={identitySubscriptions}
      identityScrambleDurationMs={identityScrambleDurationMs}
      projectUsageEntries={projectUsageEntries}
      projectUsageLimit={projectUsageLimit}
      setProjectUsageLimit={setProjectUsageLimit}
      projectDetailQuery={{ from, to, timeZone, tzOffsetMinutes }}
      topModels={topModels}
      signedIn={signedIn}
      publicMode={publicMode}
      isLocalMode={isLocalMode}
      shouldShowInstall={shouldShowInstall}
      installPrompt={installPrompt}
      handleCopyInstall={handleCopyInstall}
      installCopied={installCopied}
      installCopiedLabel={installCopiedLabel}
      installCopyLabel={installCopyLabel}
      installInitCmdDisplay={installInitCmdDisplay}
      linkCodeLoading={linkCodeLoading}
      linkCodeError={linkCodeError}
      trendRowsForDisplay={trendRowsForDisplay}
      trendFromForDisplay={trendFromForDisplay}
      trendToForDisplay={trendToForDisplay}
      trendZoomConfig={trendZoomConfig}
      usageFrom={from}
      usageTo={to}
      period={period}
      trendTimeZoneLabel={trendTimeZoneLabel}
      activityHeatmapBlock={activityHeatmapBlock}
      periodsForDisplay={periodsForDisplay}
      setSelectedPeriod={handlePeriodChange}
      customFrom={customFrom}
      customTo={customTo}
      onCustomRangeApply={handleCustomRangeApply}
      customRangeOpen={customRangeOpen}
      onCustomRangeOpenChange={handleCustomRangeOpenChange}
      metricsRows={metricsRows}
      summaryLabel={summaryLabel}
      summaryValue={summaryValue}
      hasSummary={hasSummary}
      summaryLoading={usageLoading}
      providersLoading={modelBreakdownLoading}
      summaryFullValue={displayTotalTokens}
      onToggleSummaryFormat={toggleSummaryFormat}
      summaryTotalTokensRaw={toFiniteNumber(summaryTotalTokens) || 0}
      summaryCostValue={summaryCostValue}
      summaryConversationsValue={summaryConversationsValue}
      rollingUsage={rolling}
      costInfoEnabled={costInfoEnabled}
      openCostModal={openCostModal}
      allowBreakdownToggle={allowBreakdownToggle}
      coreIndexCollapsed={coreIndexCollapsed}
      setCoreIndexCollapsed={setCoreIndexCollapsed}
      coreIndexCollapseLabel={coreIndexCollapseLabel}
      coreIndexExpandLabel={coreIndexExpandLabel}
      coreIndexCollapseAria={coreIndexCollapseAria}
      coreIndexExpandAria={coreIndexExpandAria}
      refreshAll={handleUsageRefresh}
      usageLoadingState={usageLoadingState}
      announceUsageLoading={manualSyncLoading}
      initialDashboardLoading={initialDashboardLoading}
      usageError={usageError}
      rangeLabel={rangeLabel}
      timeZoneRangeLabel={timeZoneRangeLabel}
      usageSourceLabel={usageSourceLabel}
      fleetData={fleetData}
      hasDetailsActual={hasDetailsActual}
      dailyEmptyPrefix={dailyEmptyPrefix}
      installSyncCmd={installSyncCmd}
      dailyEmptySuffix={dailyEmptySuffix}
      detailsColumns={detailsColumns}
      ariaSortFor={ariaSortFor}
      toggleSort={toggleSort}
      sortIconFor={sortIconFor}
      pagedDetails={pagedDetails}
      dailyBreakdownRows={sortedDailyBreakdownRows}
      dailyBreakdownColumns={dailyBreakdownColumns}
      dailyBreakdownAriaSortFor={dailyAriaSortFor}
      dailyBreakdownSortIconFor={dailySortIconFor}
      dailyBreakdownDateKey={dailyBreakdownDateKey}
      detailsDateKey={detailsDateKey}
      renderDetailDate={renderDetailDate}
      renderDailyBreakdownDate={renderDailyBreakdownDate}
      renderDetailCell={renderDetailCell}
      DETAILS_PAGED_PERIODS={DETAILS_PAGED_PERIODS}
      detailsPageCount={detailsPageCount}
      detailsPage={detailsPage}
      setDetailsPage={setDetailsPage}
      costModalOpen={costModalOpen}
      closeCostModal={closeCostModal}
      deviceOptions={deviceOptions}
      selectedDevice={selectedDevice || ""}
      onDeviceChange={(v) => setSelectedDevice(v || null)}
      deviceUsageBlock={deviceUsageBlock}
      leftCardOrder={dashboardCardOrder.left.order}
      onLeftReorder={dashboardCardOrder.left.reorder}
      rightCardOrder={dashboardCardOrder.right.order}
      onRightReorder={dashboardCardOrder.right.reorder}
    />
    <ShareModal
      open={shareModalOpen}
      onClose={closeShareModal}
      data={shareCardData}
      twitterText={screenshotTwitterText}
    />
    </>
  );
}
