import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { Select } from "../ui/components";
import { motion } from "motion/react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { useLoginModal } from "../contexts/LoginModalContext.jsx";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { isAccessTokenReady, resolveAuthAccessTokenWithRetry } from "../lib/auth-token";
import { copy, getCopyLocale } from "../lib/copy";
import { formatCompactNumber } from "../lib/format";
import { cn } from "../lib/cn";
import { useCurrency } from "../hooks/useCurrency.js";
import { useTokenFormat } from "../hooks/useTokenFormat.js";
import { CURRENCY_USD, getCurrencySymbol } from "../lib/currency";
import {
  buildPageItems,
  clampInt,
  getPaginationFlags,
  pageContainingRank,
  prependMeRowToPage,
} from "../lib/leaderboard-ui";
import { getLeaderboardBaseUrl } from "../lib/config";
import { getDashboardEntryPath } from "../lib/host-mode";
import { isMockEnabled } from "../lib/mock-data";
import {
  getLeaderboard,
} from "../lib/api";
import {
  getLeaderboardPreloadContextKey,
  publishLeaderboardPreloadState,
  readLeaderboardPreloadState,
} from "../lib/dashboard-preload.js";
import {
  CLOUD_LEADERBOARD_REFRESHED_EVENT,
  getCloudSyncEnabled,
  setCloudSyncEnabled,
} from "../lib/cloud-sync-prefs";
import { runCloudUsageSyncNow } from "../lib/cloud-sync";
import { LeaderboardAvatar } from "../components/LeaderboardAvatar.jsx";
import { LeaderboardProviderColumnHeader } from "../components/LeaderboardProviderColumnHeader.jsx";
import { BadgeMini } from "../ui/achievements/BadgeMini.jsx";

const LeaderboardProfileModal = lazy(() =>
  import("../components/leaderboard/LeaderboardProfileModal.jsx").then((m) => ({
    default: m.LeaderboardProfileModal,
  })),
);
const CommunityStatsModal = lazy(() =>
  import("../components/leaderboard/CommunityStatsModal.jsx").then((m) => ({
    default: m.CommunityStatsModal,
  })),
);
import { LeaderboardSkeleton } from "../components/LeaderboardSkeleton.jsx";
import { SortableColumnHeader } from "../components/SortableColumnHeader.jsx";
import { useColumnOrder } from "../hooks/use-column-order.js";
import { LeaderboardMeChip } from "../components/LeaderboardSummaryCard.jsx";
import { useCommunityStats } from "../hooks/use-community-stats.js";
import {
  LB_STICKY_TH_RANK,
  LB_STICKY_TH_USER,
  LEADERBOARD_TOKEN_COLUMNS,
  lbStickyTdRank,
  lbStickyTdUser,
} from "../lib/leaderboard-columns.js";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_STORAGE_KEY = "tokentracker:leaderboard:pageSize";

function readStoredPageSize() {
  if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
  try {
    const raw = window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
    const n = Number(raw);
    if (PAGE_SIZE_OPTIONS.includes(n)) return n;
  } catch {
    // ignore storage errors (private mode, disabled, etc.)
  }
  return DEFAULT_PAGE_SIZE;
}

function formatCost(value, currency, rate) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const symbol = getCurrencySymbol(currency);
  const converted = currency === CURRENCY_USD ? n : n * rate;
  if (converted >= 1000) return `${symbol}${Math.round(converted).toLocaleString()}`;
  if (converted >= 10) return `${symbol}${Math.round(converted)}`;
  return `${symbol}${converted.toFixed(2)}`;
}

function formatLeaderboardUpdatedAt(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const locale = getCopyLocale();
  return {
    dateTime: date.toISOString(),
    display: new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
    exact: new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "long",
    }).format(date),
  };
}

function TotalTokens({ value }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  return <span title={formatTokensTooltip(value)}>{formatTokens(value)}</span>;
}

function CommunityStatsChip({ communityStats, onClick }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  if (communityStats.status !== "ready") return null;

  return (
    <button 
      type="button"
      onClick={onClick}
      className="inline-flex min-w-0 max-w-full flex-1 items-center gap-1.5 whitespace-nowrap rounded-xl border border-oai-gray-200 bg-oai-gray-50/50 px-2.5 py-2 text-xs text-oai-gray-500 backdrop-blur-md transition-all duration-300 hover:border-oai-brand-400 hover:bg-oai-brand-50/40 active:scale-[0.97] dark:border-oai-gray-800 dark:bg-white/[0.02] dark:text-oai-gray-400 dark:hover:border-oai-brand-500/80 dark:hover:bg-oai-brand-950/20 sm:h-9 sm:flex-none sm:gap-2.5 sm:rounded-full sm:px-3.5 sm:py-0"
      title={copy("leaderboard.community.view_stats")}
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/80 opacity-75 duration-1000" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
      
      <span className="flex items-center gap-1">
        <span className="font-semibold text-oai-black dark:text-white tabular-nums">
          <span title={formatTokensTooltip(communityStats.tokenFloor)}>
            {formatTokens(communityStats.tokenFloor)}
          </span>
        </span>
        <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-500">
          {copy("leaderboard.community.tokens_chip")}
        </span>
      </span>

      <span className="text-oai-gray-200 dark:text-oai-gray-800 select-none">·</span>

      <span className="flex items-center gap-1">
        <span className="font-semibold text-oai-black dark:text-white tabular-nums">
          <span className="sm:hidden">{formatCompactNumber(communityStats.totalEntries)}</span>
          <span className="hidden sm:inline">{(Number(communityStats.totalEntries) || 0).toLocaleString("en-US")}</span>
        </span>
        <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-500">
          {copy("leaderboard.community.devs_chip")}
        </span>
      </span>
    </button>
  );
}

function LeaderboardTokenCells({ entry, isMe, orderedColumns }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const numCls = isMe
    ? "text-oai-gray-700 dark:text-oai-gray-300"
    : "text-oai-gray-500 dark:text-oai-gray-400";
  const cellBg = isMe
    ? "bg-oai-brand-50 dark:bg-oai-brand-900/10"
    : "bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900";
  return orderedColumns.map((col) => (
    <td
      key={col.key}
      data-column-key={col.key}
      title={formatTokensTooltip(entry?.[col.key])}
      className={cn("hidden sm:table-cell px-3 sm:px-4 py-4 whitespace-nowrap text-right tabular-nums", numCls, cellBg)}
    >
      {formatTokens(entry?.[col.key])}
    </td>
  ));
}

function providerNameFromColumn(column) {
  if (column?.key === "gpt_tokens") return "CODEX";
  if (column?.key === "claude_tokens") return "CLAUDE";
  const fileName = column?.icon?.split("/").pop() || "";
  return fileName.replace(/\.svg$/i, "").toUpperCase() || "OTHER";
}

const RANK_MEDAL_GLOW = {
  1: "ring-2 ring-amber-400 dark:ring-amber-500/80 shadow-[0_0_8px_rgba(245,158,11,0.25)]",
  2: "ring-2 ring-slate-350 dark:ring-slate-450 shadow-[0_0_8px_rgba(148,163,184,0.2)]",
  3: "ring-2 ring-orange-400 dark:ring-orange-500/70 shadow-[0_0_8px_rgba(249,115,22,0.25)]",
};

function MobileRankCell({ rank, placeholder }) {
  if (rank === 1) {
    return (
      <span className="text-base font-extrabold italic text-amber-500 dark:text-amber-400 tracking-tighter">
        1
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span className="text-base font-extrabold italic text-slate-400 dark:text-slate-350 tracking-tighter">
        2
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span className="text-base font-extrabold italic text-orange-500 dark:text-orange-400 tracking-tighter">
        3
      </span>
    );
  }
  return (
    <span className="text-[13px] font-bold tabular-nums text-oai-gray-400 dark:text-oai-gray-500">
      {rank == null ? placeholder : `#${rank}`}
    </span>
  );
}

function MobileGithubBadge({ githubUrl }) {
  return (
    <a
      href={githubUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      aria-label="GitHub profile"
      className="absolute bottom-0 right-0 translate-x-1 translate-y-1 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-white dark:bg-oai-gray-950 text-oai-black dark:text-oai-gray-100 shadow border border-oai-gray-100 dark:border-oai-gray-800 transition-transform active:scale-110"
    >
      <ProviderIcon provider="GITHUB" size={11} />
    </a>
  );
}

function MobileProviderStats({ entry, orderedColumns }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const activeColumns = orderedColumns.filter((column) => {
    const value = Number(entry?.[column.key]);
    return Number.isFinite(value) && value > 0;
  });

  if (activeColumns.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-2 border-t border-oai-gray-100/70 pt-3 dark:border-oai-gray-800/60">
      {activeColumns.map((column) => {
        const label = copy(column.copyKey);
        return (
          <span
            key={column.key}
            title={label}
            aria-label={`${label}: ${formatTokensTooltip(entry?.[column.key])}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-oai-gray-50/80 dark:bg-oai-gray-900/60 px-2 py-0.5 border border-oai-gray-100/80 dark:border-oai-gray-800/40 text-[10px] font-medium text-oai-gray-600 dark:text-oai-gray-300 transition-colors"
          >
            <ProviderIcon
              provider={providerNameFromColumn(column)}
              size={12}
              className="shrink-0 opacity-90"
            />
            <span className="tabular-nums">{formatTokens(entry?.[column.key])}</span>
          </span>
        );
      })}
    </div>
  );
}

function MobileLeaderboardRow({
  entry,
  entryIdx,
  name,
  meLabel,
  currency,
  rate,
  orderedColumns,
  placeholder,
  onOpenProfile,
}) {
  if (entry?.is_ellipsis) {
    return (
      <div
        key={`mobile-ellipsis-${entryIdx}`}
        aria-hidden="true"
        className="px-4 py-2 text-center text-xs tracking-[0.4em] text-oai-gray-400 dark:text-oai-gray-600"
      >
        ···
      </div>
    );
  }

  const isMe = Boolean(entry?.is_me);
  const isAnon = !isMe && isAnonymousName(entry?.display_name);
  const profileUserId = typeof entry?.user_id === "string" ? entry.user_id : null;
  const rowClickable = Boolean(profileUserId);
  const rowName = isMe ? meLabel : name;
  const handleRowKey = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenProfile(profileUserId);
    }
  };

  return (
    <div
      key={`mobile-row-${entry?.rank}-${rowName}`}
      role={rowClickable ? "button" : undefined}
      tabIndex={rowClickable ? 0 : undefined}
      onClick={rowClickable ? () => onOpenProfile(profileUserId) : undefined}
      onKeyDown={rowClickable ? handleRowKey : undefined}
      aria-label={rowClickable ? copy("leaderboard.profile_modal.row_aria", { name: rowName }) : undefined}
      className={cn(
        "relative mx-0 my-1 rounded-xl px-3.5 py-3 transition-all duration-200 border shadow-sm select-none",
        isMe
          ? "bg-gradient-to-br from-oai-brand-50/70 via-oai-brand-50/20 to-transparent dark:from-oai-brand-950/20 dark:via-oai-brand-950/5 dark:to-transparent border-oai-brand-200/60 dark:border-oai-brand-500/25"
          : isAnon
            ? "bg-white/90 dark:bg-oai-gray-950/90 border-oai-gray-100/70 dark:border-oai-gray-800/40"
            : "bg-white dark:bg-oai-gray-950 border-oai-gray-100 dark:border-oai-gray-800/60",
        rowClickable && "cursor-pointer hover:border-oai-gray-200 dark:hover:border-oai-gray-700/80 active:scale-[0.985] active:bg-oai-gray-50/60 dark:active:bg-oai-gray-900/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-oai-brand-500/60",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex w-5 shrink-0 items-center justify-center">
          <MobileRankCell rank={entry?.rank} placeholder={placeholder} />
        </span>
        <span className="relative inline-flex shrink-0">
          <span
            className={cn(
              "inline-flex rounded-full p-0.5 transition-all duration-300",
              RANK_MEDAL_GLOW[entry?.rank] || "ring-1 ring-oai-gray-200 dark:ring-oai-gray-800/80",
              isAnon && "opacity-60 grayscale-[15%]"
            )}
          >
            <LeaderboardAvatar
              size="md"
              avatarUrl={entry?.avatar_url}
              displayName={rowName}
              seed={leaderboardAvatarSeed(entry, rowName)}
            />
          </span>
          {entry?.github_url && <MobileGithubBadge githubUrl={entry.github_url} />}
        </span>
        <div className="min-w-0 flex-1 pl-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={cn(
              "min-w-0 truncate text-sm tracking-tight",
              isMe ? "font-semibold text-oai-black dark:text-oai-white" : isAnon ? "font-normal text-oai-gray-400 dark:text-oai-gray-500" : "font-medium text-oai-gray-800 dark:text-oai-gray-200",
            )}>
              {rowName}
            </span>
            <BadgeMini badges={entry?.badges} className="shrink-0 scale-95" />
          </div>
          <div className="mt-1 text-[11px] text-oai-gray-400 dark:text-oai-gray-500">
            <span>{copy("leaderboard.column.est_cost")}</span>
            <span className={cn("ml-1 tabular-nums font-medium", isAnon ? "text-oai-gray-400/80 dark:text-oai-gray-500/80" : "text-oai-gray-600 dark:text-oai-gray-300")}>
              {entry?.cost_status === "partial" ? copy("usage.cost.partial") : formatCost(entry?.estimated_cost_usd, currency, rate)}
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-oai-gray-400 dark:text-oai-gray-500">
            {copy("leaderboard.column.total")}
          </div>
          <div className={cn(
            "mt-0.5 text-sm font-semibold tabular-nums tracking-tight",
            isMe ? "text-oai-black dark:text-oai-white" : isAnon ? "text-oai-gray-400 dark:text-oai-gray-500" : "text-oai-gray-800 dark:text-oai-gray-200",
          )}>
            <TotalTokens value={entry?.total_tokens} />
          </div>
        </div>
      </div>
      <MobileProviderStats entry={entry} orderedColumns={orderedColumns} />
    </div>
  );
}

const RANK_MEDAL = {
  1: { text: "text-amber-600 dark:text-amber-400", badge: "bg-amber-50 dark:bg-amber-900/20" },
  2: { text: "text-gray-500 dark:text-gray-300", badge: "bg-gray-50 dark:bg-gray-800/40" },
  3: { text: "text-orange-700 dark:text-orange-400", badge: "bg-orange-50 dark:bg-orange-900/20" },
};

function RankCell({ rank, placeholder }) {
  const medal = RANK_MEDAL[rank];
  if (medal) {
    return (
      <span className={cn("inline-flex items-center justify-center h-7 w-7 rounded-full text-xs font-bold", medal.text, medal.badge)}>
        {rank}
      </span>
    );
  }
  return <span className="inline-flex items-center justify-center h-7 w-7 text-sm">{rank ?? placeholder}</span>;
}

function normalizePeriod(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "week") return v;
  if (v === "month") return v;
  if (v === "total") return v;
  return null;
}

function normalizeLeaderboardError(err) {
  if (!err) return copy("shared.error.prefix", { error: copy("leaderboard.error.unknown") });
  const msg = err?.message || String(err);
  const safe = String(msg || "").trim() || copy("leaderboard.error.unknown");
  return copy("shared.error.prefix", { error: safe });
}

function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function isAnonymousName(value) {
  const normalized = normalizeName(value);
  if (!normalized) return true;
  return normalized.toLowerCase() === "anonymous";
}

function leaderboardAvatarSeed(entry, displayName) {
  const id = typeof entry?.user_id === "string" ? entry.user_id.trim() : "";
  if (id) return id;
  return `${entry?.rank ?? ""}:${displayName}`;
}

function GithubLinkWithTooltip({ githubUrl }) {
  return (
    <span className="absolute left-1/2 top-full -translate-x-1/2 -translate-y-1/2 inline-flex group/gh">
      <a
        href={githubUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        aria-label={copy("leaderboard.github.aria")}
        className="flex h-4 w-4 items-center justify-center rounded-full bg-white dark:bg-oai-gray-950 text-oai-black dark:text-oai-gray-100 transition-transform hover:scale-110"
      >
        <ProviderIcon provider="GITHUB" size={14} />
      </a>
      <span
        role="tooltip"
        className="invisible opacity-0 group-hover/gh:visible group-hover/gh:opacity-100 absolute left-0 bottom-full mb-2 whitespace-nowrap rounded-md bg-oai-black dark:bg-oai-gray-700 px-2.5 py-1.5 text-[11px] leading-relaxed text-white shadow-lg transition-opacity duration-150 z-50 before:content-[''] before:absolute before:inset-x-0 before:top-full before:h-2.5"
      >
        <span className="block">{copy("leaderboard.github.tooltipAction")}</span>
        <span className="block text-oai-gray-300 dark:text-oai-gray-400">
          {copy("leaderboard.github.tooltipPrefix")}{" "}
          <Link
            to="/settings"
            onClick={(e) => e.stopPropagation()}
            className="text-white underline underline-offset-2 decoration-oai-gray-400 hover:text-oai-brand-300 hover:decoration-oai-brand-300"
          >
            {copy("leaderboard.github.tooltipSettingsLink")}
          </Link>{" "}
          {copy("leaderboard.github.tooltipSuffix")}
        </span>
      </span>
    </span>
  );
}

export function LeaderboardPage({
  auth,
  signedIn,
  sessionSoftExpired,
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { openLoginModal } = useLoginModal();
  const { signedIn: cloudSignedIn, loading: authLoading, user: cloudUser } = useInsforgeAuth();
  const { currency, rate } = useCurrency();
  const leaderboardBaseUrl = useMemo(() => getLeaderboardBaseUrl(), []);
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
  const authTokenReady = authTokenAllowed && isAccessTokenReady(effectiveAuthToken);

  const placeholder = copy("shared.placeholder.short");

  const defaultColumnKeys = useMemo(
    () => LEADERBOARD_TOKEN_COLUMNS.map((c) => c.key),
    [],
  );
  const { order: columnOrder, reorder: reorderColumns } = useColumnOrder(defaultColumnKeys);
  const columnsByKey = useMemo(() => {
    const map = new Map();
    for (const c of LEADERBOARD_TOKEN_COLUMNS) map.set(c.key, c);
    return map;
  }, []);
  const orderedColumns = useMemo(
    () => columnOrder.map((k) => columnsByKey.get(k)).filter(Boolean),
    [columnOrder, columnsByKey],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = useCallback(
    (event) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      reorderColumns(String(active.id), String(over.id));
    },
    [reorderColumns],
  );

  const [listPage, setListPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(readStoredPageSize);
  const [modalUserId, setModalUserId] = useState(null);
  const [isStatsModalOpen, setIsStatsModalOpen] = useState(false);
  const openProfileModal = useCallback((userId) => {
    if (typeof userId === "string" && userId.trim()) setModalUserId(userId.trim());
  }, []);
  const closeProfileModal = useCallback(() => setModalUserId(null), []);

  const setPageSize = useCallback((next) => {
    const normalized = PAGE_SIZE_OPTIONS.includes(next) ? next : DEFAULT_PAGE_SIZE;
    setPageSizeState(normalized);
    setListPage(1);
    try {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(normalized));
    } catch {
      // ignore
    }
  }, []);
  const [listReloadToken, setListReloadToken] = useState(0);

  const [cloudSyncOn, setCloudSyncOn] = useState(() => getCloudSyncEnabled());
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleLeaderboardRefresh = () => {
      setListReloadToken((value) => value + 1);
    };
    window.addEventListener(CLOUD_LEADERBOARD_REFRESHED_EVENT, handleLeaderboardRefresh);
    return () => {
      window.removeEventListener(CLOUD_LEADERBOARD_REFRESHED_EVENT, handleLeaderboardRefresh);
    };
  }, []);

  const period = useMemo(() => {
    const params = new URLSearchParams(location?.search || "");
    return normalizePeriod(params.get("period")) || "total";
  }, [location?.search]);

  const handlePeriodChange = (nextPeriod) => {
    const normalized = normalizePeriod(nextPeriod);
    if (!normalized) return;
    if (normalized === period) return;
    const params = new URLSearchParams(location?.search || "");
    params.set("period", normalized);
    setListPage(1);
    navigate(`${location?.pathname || "/leaderboard"}?${params.toString()}`, { replace: true });
  };

  useEffect(() => {
    if (authLoading) return;
    if (mockEnabled) return;
    if (!cloudSignedIn) {
      openLoginModal();
    }
  }, [cloudSignedIn, authLoading, mockEnabled, openLoginModal]);

  useEffect(() => {
    setListPage(1);
  }, [period]);

  const listOffset = useMemo(() => {
    const safePage = clampInt(listPage, { min: 1, max: 1_000_000, fallback: 1 });
    return (safePage - 1) * pageSize;
  }, [listPage, pageSize]);
  const leaderboardAccessMode = useMemo(() => {
    if (mockEnabled) return "mock";
    if (authLoading) return "unavailable";
    if (cloudSignedIn) return "cloud";
    if (signedIn) return "local";
    if (leaderboardBaseUrl) return "public";
    return "unavailable";
  }, [authLoading, cloudSignedIn, leaderboardBaseUrl, mockEnabled, signedIn]);

  const leaderboardPreloadContextKey = useMemo(
    () =>
      getLeaderboardPreloadContextKey({
        accessMode: leaderboardAccessMode,
        baseUrl: leaderboardBaseUrl,
        mockEnabled,
        userId: cloudUser?.id || null,
        period,
        pageSize,
        offset: listOffset,
      }),
    [cloudUser?.id, leaderboardAccessMode, leaderboardBaseUrl, listOffset, mockEnabled, pageSize, period],
  );

  const [listState, setListState] = useState(() => {
    const preloadedState = readLeaderboardPreloadState(leaderboardPreloadContextKey);
    if (preloadedState) {
      return {
        loading: false,
        error: null,
        data: preloadedState.data,
        contextKey: leaderboardPreloadContextKey,
      };
    }
    return {
      loading: false,
      error: null,
      data: null,
      contextKey: null,
    };
  });

  useEffect(() => {
    if ((!leaderboardBaseUrl && !mockEnabled) || (!mockEnabled && leaderboardAccessMode === "unavailable")) {
      setListState({ loading: false, error: null, data: null, contextKey: null });
      return;
    }
    const cachedState = readLeaderboardPreloadState(leaderboardPreloadContextKey);
    let active = true;
    if (cachedState) {
      setListState({
        loading: false,
        error: null,
        data: cachedState.data,
        contextKey: leaderboardPreloadContextKey,
      });
    } else {
      setListState({
        loading: true,
        error: null,
        data: null,
        contextKey: null,
      });
    }
    (async () => {
      const data = await getLeaderboard({
        baseUrl: leaderboardBaseUrl,
        userId: cloudUser?.id || null,
        period,
        limit: pageSize,
        offset: listOffset,
      });
      if (!active) return;
      publishLeaderboardPreloadState(data, {
        activeContextKey: leaderboardPreloadContextKey,
        contextKey: leaderboardPreloadContextKey,
        source: listReloadToken > 0 ? "manual-refresh" : "page-load",
      });
      setListState({
        loading: false,
        error: null,
        data,
        contextKey: leaderboardPreloadContextKey,
      });
    })().catch((err) => {
      if (!active) return;
      const error = normalizeLeaderboardError(err);
      setListState((prev) => {
        if (prev.contextKey === leaderboardPreloadContextKey) {
          return { ...prev, loading: false, error };
        }
        return { loading: false, error, data: null, contextKey: leaderboardPreloadContextKey };
      });
    });
    return () => {
      active = false;
    };
  }, [
    leaderboardBaseUrl,
    leaderboardAccessMode,
    cloudUser?.id,
    leaderboardPreloadContextKey,
    listOffset,
    listReloadToken,
    mockEnabled,
    period,
    pageSize,
  ]);

  const renderCachedState = useMemo(() => {
    if (listState.contextKey === leaderboardPreloadContextKey) return null;
    return readLeaderboardPreloadState(leaderboardPreloadContextKey);
  }, [leaderboardPreloadContextKey, listState.contextKey]);
  const currentListState = useMemo(() => {
    if (listState.contextKey === leaderboardPreloadContextKey) return listState;
    if (renderCachedState) {
      return {
        loading: false,
        error: null,
        data: renderCachedState.data,
        contextKey: leaderboardPreloadContextKey,
      };
    }
    return {
      loading: Boolean(leaderboardBaseUrl || mockEnabled) && leaderboardAccessMode !== "unavailable",
      error: null,
      data: null,
      contextKey: leaderboardPreloadContextKey,
    };
  }, [
    leaderboardAccessMode,
    leaderboardBaseUrl,
    leaderboardPreloadContextKey,
    listState,
    mockEnabled,
    renderCachedState,
  ]);
  const listData = currentListState.data;

  const totalPages = listData?.total_pages ?? null;
  const totalEntries = listData?.total_entries ?? 0;
  const currentPage = listData?.page ?? listPage;
  const pageItems = useMemo(() => {
    return buildPageItems(currentPage, totalPages);
  }, [currentPage, totalPages]);

  const from = listData?.from || null;
  const to = listData?.to || null;
  const generatedAt = listData?.generated_at || null;
  const generatedAtTime = formatLeaderboardUpdatedAt(generatedAt);

  const communityStats = useCommunityStats();
  const me = listData?.me || null;
  const meLabel = copy("leaderboard.me_label");
  const anonLabel = copy("leaderboard.anon_label");
  const weekLabel = copy("leaderboard.period.week");
  const monthLabel = copy("leaderboard.period.month");
  const totalLabel = copy("leaderboard.period.total");
  const periodLabel = period === "month" ? monthLabel : period === "total" ? totalLabel : weekLabel;

  const displayEntries = useMemo(() => {
    const rows = Array.isArray(listData?.entries) ? listData.entries : [];
    return prependMeRowToPage({ entries: rows, me, meLabel });
  }, [listData?.entries, me, meLabel]);

  const myPage = useMemo(
    () => pageContainingRank(me?.rank, pageSize),
    [me?.rank, pageSize],
  );
  const onMyPage = myPage != null && myPage === currentPage;
  const handleJumpToMe = useCallback(() => {
    if (myPage != null) setListPage(myPage);
  }, [myPage]);

  const handleEnableSync = async () => {
    setSyncing(true);
    try {
      setCloudSyncEnabled(true);
      setCloudSyncOn(true);
      await runCloudUsageSyncNow(() => resolveAuthAccessTokenWithRetry(effectiveAuthToken));
    } catch (e) {
      console.warn("[tokentracker] sync:", e);
    } finally {
      setSyncing(false);
    }
  };

  const { canPrev, canNext } = getPaginationFlags({ page: currentPage, totalPages });

  const hasEntries = Array.isArray(displayEntries) && displayEntries.length !== 0;
  let listBody = null;
  if (currentListState.loading && !hasEntries) {
    listBody = <LeaderboardSkeleton rows={pageSize} />;
  } else if (currentListState.error && !hasEntries) {
    listBody = (
      <div className="px-6 py-12 text-center">
        <p className="text-sm text-red-500 dark:text-red-400">{currentListState.error}</p>
      </div>
    );
  } else if (hasEntries) {
    listBody = (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={handleDragEnd}
      >
      <div className="hidden w-full overflow-x-auto sm:block">
        <table className="min-w-full w-full text-left text-sm sm:min-w-max">
          <thead className="border-b border-oai-gray-200 dark:border-oai-gray-800">
            <tr>
              <th className={cn(LB_STICKY_TH_RANK, "text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500")}>
                {copy("leaderboard.column.rank")}
              </th>
              <th className={cn(LB_STICKY_TH_USER, "text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500")}>
                {copy("leaderboard.column.user")}
              </th>
              <th className="px-3 sm:px-4 py-4 text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500 whitespace-nowrap text-right align-middle">
                {copy("leaderboard.column.total")}
              </th>
              <th className="hidden sm:table-cell px-3 sm:px-4 py-4 text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500 whitespace-nowrap text-right align-middle" title="Based on estimated API pricing, not actual billing">
                {copy("leaderboard.column.est_cost")}
              </th>
              <SortableContext items={columnOrder} strategy={horizontalListSortingStrategy}>
                {orderedColumns.map((col) => (
                  <SortableColumnHeader
                    key={col.key}
                    id={col.key}
                    thClassName="hidden sm:table-cell px-3 sm:px-4 py-4 text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500 whitespace-nowrap align-middle"
                  >
                    <LeaderboardProviderColumnHeader iconSrc={col.icon} label={copy(col.copyKey)} />
                  </SortableColumnHeader>
                ))}
              </SortableContext>
            </tr>
          </thead>
          <tbody className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800/50">
            {displayEntries.map((entry, entryIdx) => {
              if (entry?.is_ellipsis) {
                const colSpan = 4 + orderedColumns.length;
                return (
                  <tr key={`ellipsis-${entryIdx}`} aria-hidden="true">
                    <td
                      colSpan={colSpan}
                      className="px-4 py-2 text-center text-oai-gray-400 dark:text-oai-gray-600 bg-white dark:bg-oai-gray-950 select-none tracking-[0.4em] text-xs"
                    >
                      ···
                    </td>
                  </tr>
                );
              }
              const isMe = Boolean(entry?.is_me);
              const profileUserId = typeof entry?.user_id === "string" ? entry.user_id : null;
              const rawName = normalizeName(entry?.display_name);
              const entryName = isAnonymousName(rawName) ? anonLabel : rawName;
              const name = isMe ? meLabel : entryName;
              const rowClickable = Boolean(profileUserId);
              const handleRowOpen = rowClickable ? () => openProfileModal(profileUserId) : undefined;
              const handleRowKey = rowClickable
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openProfileModal(profileUserId);
                    }
                  }
                : undefined;
              const rowInteractiveProps = rowClickable
                ? {
                    role: "button",
                    tabIndex: 0,
                    onClick: handleRowOpen,
                    onKeyDown: handleRowKey,
                    "aria-label": copy("leaderboard.profile_modal.row_aria", { name }),
                  }
                : {};

              if (isMe) {
                const isPinned = Boolean(entry?.is_pinned);
                return (
                  <tr
                    key={`row-${entry?.rank}-${name}${isPinned ? "-pin" : ""}`}
                    {...rowInteractiveProps}
                    className={cn(
                      "bg-oai-brand-50 dark:bg-oai-brand-900/10 transition-colors",
                      isPinned
                        ? "border-t border-b border-oai-brand-300/40 dark:border-oai-brand-500/20"
                        : "border-y border-oai-brand-300/40 dark:border-oai-brand-500/30",
                      rowClickable && "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500/60",
                    )}
                  >
                    <td
                      className={cn(
                        lbStickyTdRank(true),
                        "font-semibold text-oai-brand-600 dark:text-oai-brand-400",
                        isPinned && "before:absolute before:left-0 before:top-[15%] before:h-[70%] before:w-[3px] before:rounded-r before:bg-oai-brand-500 dark:before:bg-oai-brand-400"
                      )}
                    >
                      <RankCell rank={entry?.rank} placeholder={placeholder} />
                    </td>
                    <td className={lbStickyTdUser(true)}>
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "relative inline-flex shrink-0 rounded-full p-[2px]",
                            entry?.github_url && "gh-avatar-frame",
                          )}
                        >
                          <span
                            className={cn(
                              "inline-flex rounded-full p-px",
                              entry?.github_url && "bg-white dark:bg-oai-gray-950",
                            )}
                          >
                            <LeaderboardAvatar
                              avatarUrl={entry?.avatar_url}
                              displayName={name}
                              seed={leaderboardAvatarSeed(entry, name)}
                            />
                          </span>
                          {entry?.github_url && <GithubLinkWithTooltip githubUrl={entry.github_url} />}
                        </span>
                        <span className="truncate font-semibold text-oai-black dark:text-oai-white">{name}</span>
                        <BadgeMini badges={entry?.badges} className="hidden sm:inline-flex" />
                      </div>
                    </td>
                    <td className="px-3 sm:px-4 py-4 font-medium text-oai-black dark:text-oai-white whitespace-nowrap text-right tabular-nums bg-oai-brand-50 dark:bg-oai-brand-900/10">
                      <TotalTokens value={entry?.total_tokens} />
                    </td>
                    <td className="hidden sm:table-cell px-3 sm:px-4 py-4 font-medium text-oai-brand-600 dark:text-oai-brand-400 whitespace-nowrap text-right tabular-nums bg-oai-brand-50 dark:bg-oai-brand-900/10" title="Based on estimated API pricing, not actual billing">
                      {entry?.cost_status === "partial" ? copy("usage.cost.partial") : formatCost(entry?.estimated_cost_usd, currency, rate)}
                    </td>
                    <LeaderboardTokenCells entry={entry} isMe orderedColumns={orderedColumns} />
                  </tr>
                );
              }

              return (
                <tr
                  key={`row-${entry?.rank}-${name}`}
                  {...rowInteractiveProps}
                  className={cn(
                    "group transition-colors",
                    rowClickable && "cursor-pointer hover:bg-oai-gray-50 dark:hover:bg-oai-gray-900/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500/60",
                  )}
                >
                  <td className={cn(lbStickyTdRank(false), "font-medium text-oai-gray-500 dark:text-oai-gray-400")}>
                    <RankCell rank={entry?.rank} placeholder={placeholder} />
                  </td>
                  <td className={lbStickyTdUser(false)}>
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          "relative inline-flex shrink-0 rounded-full p-[2px]",
                          entry?.github_url && "gh-avatar-frame",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-flex rounded-full p-px",
                            entry?.github_url && "bg-white dark:bg-oai-gray-950",
                          )}
                        >
                          <LeaderboardAvatar
                            avatarUrl={entry?.avatar_url}
                            displayName={name}
                            seed={leaderboardAvatarSeed(entry, name)}
                          />
                        </span>
                        {entry?.github_url && <GithubLinkWithTooltip githubUrl={entry.github_url} />}
                      </span>
                      <span className="truncate font-medium text-oai-gray-800 dark:text-oai-gray-200">{name}</span>
                      <BadgeMini badges={entry?.badges} className="hidden sm:inline-flex" />
                    </div>
                  </td>
                  <td className="px-3 sm:px-4 py-4 font-semibold text-oai-gray-800 dark:text-oai-gray-200 whitespace-nowrap text-right tabular-nums bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900/60">
                    <TotalTokens value={entry?.total_tokens} />
                  </td>
                  <td className="hidden sm:table-cell px-3 sm:px-4 py-4 text-oai-gray-500 dark:text-oai-gray-400 whitespace-nowrap text-right tabular-nums bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900/60" title="Based on estimated API pricing, not actual billing">
                    {entry?.cost_status === "partial" ? copy("usage.cost.partial") : formatCost(entry?.estimated_cost_usd, currency, rate)}
                  </td>
                  <LeaderboardTokenCells entry={entry} isMe={false} orderedColumns={orderedColumns} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col py-1.5 sm:hidden">
        {displayEntries.map((entry, entryIdx) => {
          const rawName = normalizeName(entry?.display_name);
          const entryName = isAnonymousName(rawName) ? anonLabel : rawName;
          return (
            <MobileLeaderboardRow
              key={`mobile-${entry?.rank ?? "ellipsis"}-${entryIdx}`}
              entry={entry}
              entryIdx={entryIdx}
              name={entry?.is_me ? meLabel : entryName}
              meLabel={meLabel}
              currency={currency}
              rate={rate}
              orderedColumns={orderedColumns}
              placeholder={placeholder}
              onOpenProfile={openProfileModal}
            />
          );
        })}
      </div>
      </DndContext>
    );
  } else {
    listBody = (
      <div className="px-6 py-12 text-center">
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("leaderboard.empty")}</p>
      </div>
    );
  }

  let pageButtons = null;
  if (typeof totalPages === "number") {
    pageButtons = pageItems.map((p, idx) => {
      if (p == null) {
        return (
          <span
            key={`ellipsis-${idx}`}
            className="px-2 text-oai-gray-400 dark:text-oai-gray-500"
          >
            {copy("leaderboard.pagination.ellipsis")}
          </span>
        );
      }
      return (
        <button
          key={`page-${p}`}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md text-sm font-medium transition-colors",
            p === currentPage
              ? "bg-oai-gray-200 dark:bg-oai-gray-800 text-oai-black dark:text-white"
              : "text-oai-gray-500 dark:text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white"
          )}
          onClick={() => setListPage(p)}
          disabled={currentListState.loading}
        >
          {String(p)}
        </button>
      );
    });
  } else {
    pageButtons = (
      <span className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
        {copy("leaderboard.pagination.page_unknown", { page: String(currentPage) })}
      </span>
    );
  }

  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3.5 sm:mb-8 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
            <h1 className="col-start-1 row-start-1 min-w-0 whitespace-nowrap text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:col-span-2 sm:row-start-1 sm:text-4xl">
              {copy("leaderboard.title")}
            </h1>
            <p className="col-span-2 row-start-2 hidden text-sm text-oai-gray-500 dark:text-oai-gray-400 sm:block sm:row-start-2 sm:text-base">
              {period === "total"
                ? copy("leaderboard.range.total")
                : from && to
                  ? copy("leaderboard.range", { period: periodLabel, from, to })
                  : copy("leaderboard.range_loading", { period: periodLabel })}
              {generatedAtTime && (
                <time
                  dateTime={generatedAtTime.dateTime}
                  title={copy("leaderboard.generated_at", { ts: generatedAtTime.exact })}
                  className="ml-2 hidden border-l border-oai-gray-200 pl-2 text-xs text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400 sm:inline-block"
                >
                  {copy("leaderboard.generated_at", { ts: generatedAtTime.display })}
                </time>
              )}
            </p>
            <div className="col-start-2 row-start-1 inline-flex h-9 shrink-0 items-center rounded-full border border-oai-gray-200 p-1 dark:border-oai-gray-800 sm:col-start-1 sm:row-start-3 sm:justify-self-start">
              {["week", "month", "total"].map((p) => {
                const isActive = period === p;
                return (
                  <button
                    key={p}
                    onClick={() => handlePeriodChange(p)}
                    disabled={currentListState.loading}
                    className={cn(
                      "px-3 sm:px-4 h-7 text-sm font-medium rounded-full flex items-center justify-center transition-colors relative",
                      isActive
                        ? "text-oai-black dark:text-white"
                        : "text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-800 dark:hover:text-oai-gray-200"
                    )}
                  >
                    <span className="relative z-10">
                      {p === "week" ? weekLabel : p === "month" ? monthLabel : totalLabel}
                    </span>
                    {isActive && (
                      <motion.div
                        layoutId="leaderboard-period-active-bg"
                        className="absolute inset-0 bg-oai-gray-200 dark:bg-oai-gray-800 rounded-full z-0"
                        transition={{ type: "spring", stiffness: 380, damping: 30 }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="col-span-2 row-start-2 mb-0 flex w-full min-w-0 items-center justify-between sm:justify-end gap-2.5 sm:col-span-1 sm:col-start-2 sm:row-start-3 sm:mb-0 sm:w-auto sm:shrink-0">
            <CommunityStatsChip
              communityStats={communityStats}
              onClick={() => setIsStatsModalOpen(true)}
            />
            <LeaderboardMeChip
              me={me}
              totalEntries={totalEntries}
              meLabel={meLabel}
              onOpenProfile={me?.user_id ? () => openProfileModal(me.user_id) : undefined}
              onJumpToMe={handleJumpToMe}
              canJump={myPage != null && !onMyPage && !currentListState.loading}
              className="shrink-0"
            />
            </div>
          </div>

          {!signedIn && (
            <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-sm">
              <p className="text-oai-gray-500 dark:text-oai-gray-400">{copy("leaderboard.signin_prompt")}</p>
              <button
                onClick={openLoginModal}
                className="shrink-0 whitespace-nowrap self-start sm:self-auto px-3 py-1.5 text-sm font-medium text-oai-gray-600 dark:text-oai-gray-300 border border-oai-gray-300 dark:border-oai-gray-700 rounded-md hover:text-oai-black dark:hover:text-white hover:border-oai-gray-400 dark:hover:border-oai-gray-600 transition-colors"
              >
                {copy("leaderboard.signin_button")}
              </button>
            </div>
          )}

          {authTokenAllowed && authTokenReady && !cloudSyncOn && (
            <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-sm">
              <p className="text-oai-gray-500 dark:text-oai-gray-400">{copy("leaderboard.sync_prompt")}</p>
              <button
                onClick={handleEnableSync}
                disabled={syncing}
                className="shrink-0 whitespace-nowrap self-start sm:self-auto px-3 py-1.5 text-sm font-medium text-oai-gray-600 dark:text-oai-gray-300 border border-oai-gray-300 dark:border-oai-gray-700 rounded-md hover:text-oai-black dark:hover:text-white hover:border-oai-gray-400 dark:hover:border-oai-gray-600 disabled:opacity-50 transition-colors"
              >
                {syncing ? copy("leaderboard.sync_button.busy") : copy("leaderboard.sync_button.idle")}
              </button>
            </div>
          )}

          <div className="sm:rounded-xl sm:border sm:border-oai-gray-200 sm:dark:border-oai-gray-800 sm:overflow-hidden border-none bg-transparent">
            {currentListState.error && hasEntries ? (
              <div className="border-b border-oai-gray-200 dark:border-oai-gray-800 px-6 py-3">
                <p className="text-sm text-red-500 dark:text-red-400">{currentListState.error}</p>
              </div>
            ) : null}
            {listBody}

            <div className="flex flex-col gap-3 sm:border-t border-oai-gray-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-end sm:gap-x-4 sm:px-6 dark:border-oai-gray-800 border-none mt-2.5 sm:mt-0">
              <div className="flex items-center justify-between gap-2 text-sm text-oai-gray-500 dark:text-oai-gray-400 sm:justify-start">
                <label htmlFor="leaderboard-page-size" className="whitespace-nowrap">
                  {copy("leaderboard.pagination.page_size_label")}
                </label>
                <Select
                  id="leaderboard-page-size"
                  value={pageSize}
                  onValueChange={(value) => setPageSize(Number(value))}
                  disabled={currentListState.loading}
                  ariaLabel={copy("leaderboard.pagination.page_size_label")}
                  options={PAGE_SIZE_OPTIONS.map((n) => ({ value: n, label: String(n) }))}
                  align="end"
                  className="px-3 py-1 text-oai-gray-700 dark:text-oai-gray-300"
                />
              </div>
              <div className="hidden h-5 w-px bg-oai-gray-200 dark:bg-oai-gray-800 sm:block" aria-hidden="true" />
              <div className="flex w-full items-center justify-between sm:w-auto sm:justify-end gap-1.5">
                <button
                  className={cn(
                    "whitespace-nowrap rounded-xl border border-oai-gray-100 bg-oai-gray-50/50 px-3.5 py-2 text-xs font-medium text-oai-gray-500 dark:border-oai-gray-800/80 dark:bg-white/[0.01] dark:text-oai-gray-400 transition-all duration-200 active:scale-[0.97] sm:rounded-md sm:border-0 sm:bg-transparent sm:px-3 sm:py-1.5 sm:text-sm sm:font-medium sm:active:scale-100",
                    canPrev && !currentListState.loading
                      ? "hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white"
                      : "opacity-50 cursor-not-allowed"
                  )}
                  onClick={() => setListPage((p) => Math.max(1, p - 1))}
                  disabled={!canPrev || currentListState.loading}
                >
                  {copy("leaderboard.pagination.prev")}
                </button>
                
                <span className="text-xs font-semibold tabular-nums text-oai-gray-500 dark:text-oai-gray-455 px-2 sm:hidden">
                  {currentPage} / {totalPages || "?"}
                </span>

                <div className="hidden sm:flex items-center gap-1">{pageButtons}</div>
                
                <button
                  className={cn(
                    "whitespace-nowrap rounded-xl border border-oai-gray-100 bg-oai-gray-50/50 px-3.5 py-2 text-xs font-medium text-oai-gray-500 dark:border-oai-gray-800/80 dark:bg-white/[0.01] dark:text-oai-gray-400 transition-all duration-200 active:scale-[0.97] sm:rounded-md sm:border-0 sm:bg-transparent sm:px-3 sm:py-1.5 sm:text-sm sm:font-medium sm:active:scale-100",
                    canNext && !currentListState.loading
                      ? "hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white"
                      : "opacity-50 cursor-not-allowed"
                  )}
                  onClick={() => setListPage((p) => p + 1)}
                  disabled={!canNext || currentListState.loading}
                >
                  {copy("leaderboard.pagination.next")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-oai-gray-200 dark:border-oai-gray-900 py-8 transition-colors duration-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 sm:px-6 text-sm text-oai-gray-400 dark:text-oai-gray-500">
          <p>{copy("landing.v2.footer.line")}</p>
          <a
            href="https://github.com/xiufengsun/TokenTracker"
            className="text-oai-gray-400 dark:text-oai-gray-500 hover:text-oai-black dark:hover:text-white transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy("landing.v2.nav.github")}
          </a>
        </div>
      </footer>

      <Suspense fallback={null}>
        <LeaderboardProfileModal
          isOpen={Boolean(modalUserId)}
          userId={modalUserId}
          period={period}
          accessToken={effectiveAuthToken}
          onClose={closeProfileModal}
        />
        <CommunityStatsModal
          isOpen={isStatsModalOpen}
          onClose={() => setIsStatsModalOpen(false)}
          communityStats={communityStats}
        />
      </Suspense>
    </div>
  );
}
