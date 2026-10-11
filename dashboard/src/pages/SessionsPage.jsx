import React, { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { Calendar, ChevronRight, Copy, Info, Loader2, RefreshCw, Search, X as XIcon } from "lucide-react";
import { Input, Select } from "../ui/components";
import { Tooltip } from "@base-ui/react/tooltip";
import { SearchableSelect } from "../ui/components/SearchableSelect.jsx";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { HoverTooltip } from "../ui/components/HoverTooltip.jsx";
import { showToast } from "../ui/components/Toast.jsx";
import { LocalOnlyNotice } from "../components/LocalOnlyNotice.jsx";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { getSessions } from "../lib/sessions-api";
import { formatDuration, formatWhen } from "../lib/session-format";
import { formatCompactNumber, formatUsdCurrency } from "../lib/format";
import { useCurrency } from "../hooks/useCurrency";
import { useLocale } from "../hooks/useLocale";
import { isLocalDashboardHost } from "../lib/host-mode";
import { isMockEnabled } from "../lib/mock-data";
import { groupSessions, overlapsSessionDates, parseSessionFilters, scopeSessionsToRange, sessionDayKey, sessionModels, sortSessions, summarizeSessions } from "../lib/sessions-insights";
import { SessionDetailModal } from "../ui/dashboard/components/SessionDetailModal.jsx";
import { SessionPerformance } from "../ui/dashboard/components/SessionPerformance.jsx";
import "./sessions-layout.css";

const IS_LOCAL_HOST = isLocalDashboardHost();

// Stable empty array so the memos below don't recompute on every render while
// there is no data yet.
const NO_SESSIONS = [];

// How many rows to put in the DOM at once. The whole (already fetched) list is
// filtered in memory; only the rendered slice grows as the user scrolls, so a
// few thousand sessions stay responsive without a virtualization dependency.
const PAGE_SIZE = 100;

const SOURCE_FILTERS = [
  { id: "all", label: () => copy("usage.filter.source_all") },
  { id: "claude", label: () => "Claude Code" },
  { id: "codex", label: () => "Codex" },
  { id: "grok", label: () => "Grok" },
];

const DATE_RANGES = [
  { id: "all", days: 0, label: () => copy("sessions.filter.range_label_all") },
  { id: "7d", days: 7, label: () => copy("sessions.filter.range_7d") },
  { id: "30d", days: 30, label: () => copy("sessions.filter.range_30d") },
  { id: "90d", days: 90, label: () => copy("sessions.filter.range_90d") },
];

// Earliest timestamp a range chip admits, as epoch ms in the *viewer's* time
// zone. The whole list is fetched once and filtered here, so the range chips
// never re-query: switching them is instant and cannot drop rows the way a
// server-side day-string comparison did (a UTC-sliced day boundary put a
// UTC+8 user's early-morning sessions on the wrong calendar day).
function rangeStartMs(rangeId) {
  const days = DATE_RANGES.find((range) => range.id === rangeId)?.days || 0;
  if (!days) return 0;
  const start = new Date();
  // Inclusive range: "7d" is today plus the previous six local calendar days.
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

// A session counts as inside the window when it *overlaps* it: one that started
// earlier but ran into the window is still relevant, and it is also the row
// sorted to the top (the list is ordered by ended_at).
function overlapsRange(session, startMs) {
  if (!startMs) return true;
  const ended = Date.parse(session.ended_at || session.started_at || "");
  return Number.isFinite(ended) ? ended >= startMs : true;
}

// Date groups key on when a session ended, but the row shows when it started.
// Drop the date only when both fall on the same local day, so a session that
// ran past midnight still says which day it began.
function startsOnGroupDay(session) {
  const started = Date.parse(session.started_at || "");
  return !Number.isFinite(started) || sessionDayKey({ started_at: session.started_at }) === sessionDayKey(session);
}

function modelUsageLabel(session) {
  const rows = sessionModels(session);
  if (rows.length === 1) return rows[0].model || copy("sessions.model.unknown");
  return rows
    .map((row) => `${row.model} ${formatCompactNumber(Number(row.total_tokens || 0))}`)
    .join(" · ");
}

async function copyToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // Fallback for insecure contexts / older browsers.
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  return ok;
}

function SessionSummaryHelp() {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  return (
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger delay={150} closeDelay={100} closeOnClick={false}
        onClick={() => setOpen(true)} aria-label={copy("sessions.summary.scope_help")}
        aria-describedby={open ? descriptionId : undefined}
        className="sessions-summary-help relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-white before:absolute before:-inset-2 before:content-['']">
        <Info className="h-3.5 w-3.5" aria-hidden />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="bottom" align="end" sideOffset={12} className="z-[60]">
          <Tooltip.Popup id={descriptionId} role="tooltip" className="max-w-xs rounded-lg border border-oai-gray-200 bg-white p-4 text-sm leading-6 text-oai-gray-700 outline-none dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-gray-200">
            {copy("sessions.summary.scope")}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const SessionRow = React.memo(function SessionRow({
  session,
  locale,
  nested = false,
  timeOnly = false,
  childCount = 0,
  expanded = false,
  onToggle,
  onDetail,
}) {
  const { currency, rate } = useCurrency();
  const provider = String(session.source || "").toUpperCase();
  const duration = formatDuration(session.duration_ms);
  const command = session.resume_command;
  const projectLabel = session.project_key || copy("sessions.project.unknown");
  const isSubagent = nested || session.thread_kind === "subagent";
  const title = isSubagent
    ? (session.agent_nickname || session.agent_role || session.title || projectLabel)
    : (session.title || projectLabel);
  const costBadge = session.usage_is_incomplete
    ? copy("sessions.badge.partial_usage")
    : session.cost_is_partial ? copy("sessions.badge.partial_cost") : null;
  // The resume command only works from the session's own directory, so the full
  // local path has to stay reachable. Hover reveals it, click copies it — that
  // keeps a long absolute path out of every row while still being one click
  // away from `cd`.
  const pathTooltip = session.project_ref
    ? `${session.project_ref}\n${copy("sessions.project.copy_hint")}`
    : undefined;

  const handleCopyPath = async () => {
    if (!session.project_ref) return;
    try {
      const ok = await copyToClipboard(session.project_ref);
      if (ok) showToast({ title: copy("sessions.project.copied") });
      else showToast({ title: copy("sessions.project.copy_failed") });
    } catch {
      showToast({ title: copy("sessions.project.copy_failed") });
    }
  };

  // The hover wrapper must NOT carry `truncate`: that sets overflow:hidden,
  // which clips the tooltip (it is absolutely positioned above the label).
  // Wrapper owns `group relative`; the inner button owns the truncation.
  const projectLabelNode = (extraClass) => (
    <span className="group relative inline-flex min-w-0 max-w-full">
      <HoverTooltip text={pathTooltip} placement="bottom" />
      <button
        type="button"
        onClick={handleCopyPath}
        aria-label={copy("sessions.project.copy_aria", { project: projectLabel })}
        className={cn(
          "max-w-full truncate rounded text-left underline decoration-dotted decoration-oai-gray-300 underline-offset-4 hover:decoration-oai-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:decoration-oai-gray-600 dark:hover:decoration-oai-gray-400",
          extraClass,
        )}
      >
        {projectLabel}
      </button>
    </span>
  );

  const handleCopy = async () => {
    if (!command) return;
    try {
      // The insecure-context fallback reports failure by returning false
      // instead of throwing, so the return value decides the toast — otherwise
      // we claim success with an empty clipboard.
      const ok = await copyToClipboard(command);
      // Literal copy() keys so the copy-registry validator can see both.
      if (ok) showToast({ title: copy("sessions.resume.copied") });
      else showToast({ title: copy("sessions.resume.copy_failed") });
    } catch {
      showToast({ title: copy("sessions.resume.copy_failed") });
    }
  };

  return (
    <li className={cn("sessions-row sessions-row-grid py-3", nested && "sessions-row-nested")}>
      <div className="sessions-row-identity min-w-0">
        <span className="sessions-row-provider inline-flex items-center justify-center text-oai-gray-600 dark:text-oai-gray-300" aria-hidden="true">
          <ProviderIcon provider={provider} size={nested ? 16 : 18} />
        </span>
        <div className="contents">
          <button
            type="button"
            onClick={() => onDetail(session)}
            aria-label={copy("sessions.detail.open_aria", { title })}
            title={title}
            className="sessions-row-title block min-h-9 min-w-0 max-w-full truncate rounded text-left text-sm font-medium text-oai-black underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:text-white md:min-h-5"
          >
            {title}
          </button>
          <div className="sessions-row-meta flex min-w-0 flex-wrap items-center gap-y-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            <span className="sessions-meta-item min-w-0 max-w-full">{session.project_ref ? projectLabelNode("min-h-6 inline-flex items-center md:min-h-0") : <span className="truncate">{projectLabel}</span>}</span>
            <span className="sessions-meta-item min-w-0 max-w-full truncate" title={modelUsageLabel(session)}>{modelUsageLabel(session)}</span>
            <span className="sessions-meta-item tabular-nums">{formatWhen(session.started_at, locale, { timeOnly: timeOnly && startsOnGroupDay(session) })}</span>
            {duration ? <span className="sessions-meta-item tabular-nums">{duration}</span> : null}
            {Number.isFinite(session.session_store_bytes) ? (
              <span className="sessions-meta-item tabular-nums" title={copy("sessions.storage.tooltip", {
                metric: copy(session.session_store_metric === "allocated" ? "sessions.storage.allocated" : "sessions.storage.logical"),
                ratio: Math.round(session.bytes_per_1k_tokens || 0).toLocaleString(locale),
              })}>
                {copy("sessions.storage.label", { size: `${(session.session_store_bytes / 1024 / 1024).toLocaleString(locale, { maximumFractionDigits: 2 })} MB` })}
              </span>
            ) : null}
            {isSubagent ? <span className="sessions-meta-item">{copy("sessions.badge.subagent")}{session.agent_role ? ` · ${session.agent_role}` : ""}</span> : null}
            {session.first_pass ? <span className="sessions-meta-item text-emerald-700 dark:text-emerald-300">{copy("sessions.badge.first_pass")}</span> : null}
            {costBadge ? <span className="sessions-meta-item text-amber-700 dark:text-amber-300">{costBadge}</span> : null}
            {session.cost_source === "provider_reported" ? <span className="sessions-meta-item">{copy("sessions.badge.reported_cost")}</span> : null}
            {childCount ? (
              <button
                type="button"
                onClick={() => onToggle(session.session_hash)}
                aria-expanded={expanded}
                className="-mx-1.5 inline-flex min-h-8 items-center md:-my-1 md:ml-2 md:mr-0 gap-0.5 rounded px-1.5 font-medium text-oai-gray-700 hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:text-oai-gray-200 dark:hover:bg-oai-gray-800 dark:hover:text-white md:min-h-6"
              >
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} aria-hidden />
                {expanded ? copy("sessions.thread.collapse", { count: childCount }) : copy("sessions.thread.expand", { count: childCount })}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <dl className="sessions-row-metrics">
        <div className="sessions-row-value">
          <dt className="text-xs text-oai-gray-600 dark:text-oai-gray-300 md:sr-only">{copy("sessions.col.tokens")}</dt>
          <dd
            title={Number(session.subagent_total_tokens) ? copy("sessions.thread.tokens_summary", { own: formatCompactNumber(session.own_total_tokens), subagents: formatCompactNumber(session.subagent_total_tokens), combined: formatCompactNumber(session.combined_total_tokens) }) : undefined}
            className="mt-1 text-sm tabular-nums text-oai-black dark:text-white md:mt-0"
          >
            {formatCompactNumber(session.total_tokens)}
            {Number(session.subagent_total_tokens) ? <span className="mt-0.5 block text-xs text-oai-gray-500 dark:text-oai-gray-400">Σ {formatCompactNumber(session.combined_total_tokens)}</span> : null}
          </dd>
        </div>
        <div className="sessions-row-value">
          <dt className="text-xs text-oai-gray-600 dark:text-oai-gray-300 md:sr-only">{copy("sessions.col.cost")}</dt>
          <dd className="mt-1 text-sm tabular-nums text-oai-black dark:text-white md:mt-0" title={session.cost_is_partial ? copy("sessions.cost.partial_title") : undefined}>
            {session.cost_is_partial ? "≥" : ""}{formatUsdCurrency(session.cost_usd, { currency, rate })}
          </dd>
        </div>
        <div className="sessions-row-value">
          <dt className="text-xs text-oai-gray-600 dark:text-oai-gray-300 md:sr-only">{copy("sessions.col.speed")}</dt>
          <dd className="mt-1 min-h-5 text-sm tabular-nums text-oai-gray-600 dark:text-oai-gray-300 md:mt-0"><SessionPerformance performance={session.performance} /></dd>
        </div>
      </dl>
      <button
        type="button"
        onClick={handleCopy}
        disabled={!command}
        title={command || copy("sessions.resume.unavailable")}
        aria-label={command ? copy("sessions.resume.copy_aria", { command }) : copy("sessions.resume.unavailable")}
        className="sessions-row-action inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-oai-gray-500 transition hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:cursor-not-allowed dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white md:h-8 md:w-8"
      >
        <Copy className="h-4 w-4" aria-hidden />
      </button>
    </li>
  );
});

function ThreadModelUsage({ sessions, selectedModel, onSelect }) {
  const { groups, totalTokens } = useMemo(() => {
    const byModel = new Map();
    let total = 0;
    for (const session of sessions) {
      for (const usage of sessionModels(session)) {
        const model = usage.model || copy("sessions.model.unknown");
        const tokens = Number(usage.total_tokens || 0);
        const current = byModel.get(model) || { model, count: 0, tokens: 0 };
        current.count += 1;
        current.tokens += tokens;
        total += tokens;
        byModel.set(model, current);
      }
    }
    return {
      groups: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
      totalTokens: total,
    };
  }, [sessions]);

  function buttonClass(active) {
    return cn(
      "min-h-10 rounded-md border px-2.5 text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 md:min-h-7",
      active
        ? "border-oai-brand-500 bg-oai-brand-50 text-oai-brand-700 dark:bg-oai-brand-500/10 dark:text-oai-brand-300"
        : "border-oai-gray-200 text-oai-gray-600 hover:bg-oai-gray-100 dark:border-oai-gray-700 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800",
    );
  }

  return (
    <li className="sessions-thread-models py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("sessions.thread.model_usage")}
        </span>
        <button
          type="button"
          aria-pressed={selectedModel === "all"}
          onClick={() => onSelect("all")}
          className={buttonClass(selectedModel === "all")}
        >
          {copy("sessions.thread.model_all", {
            count: sessions.length,
            tokens: formatCompactNumber(totalTokens),
          })}
        </button>
        {groups.map((group) => (
          <button
            key={group.model}
            type="button"
            aria-pressed={selectedModel === group.model}
            onClick={() => onSelect(group.model)}
            className={buttonClass(selectedModel === group.model)}
          >
            {copy("sessions.thread.model_item", {
              model: group.model,
              count: group.count,
              tokens: formatCompactNumber(group.tokens),
            })}
          </button>
        ))}
      </div>
    </li>
  );
}

export function SessionsPage() {
  const [initialFilters] = useState(() => parseSessionFilters(window.location.search));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sourceFilter, setSourceFilter] = useState(initialFilters.source);
  const [modelFilter, setModelFilter] = useState(initialFilters.model);
  const [rangeFilter, setRangeFilter] = useState(initialFilters.from || initialFilters.to ? "custom" : "all");
  const [customFrom, setCustomFrom] = useState(initialFilters.from);
  const [customTo, setCustomTo] = useState(initialFilters.to);
  const [projectFilter, setProjectFilter] = useState("all");
  const [groupMode, setGroupMode] = useState("time");
  const [sortMode, setSortMode] = useState("recent");
  const [detailSession, setDetailSession] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedThreads, setExpandedThreads] = useState(() => new Set());
  const [threadModelFilters, setThreadModelFilters] = useState(() => new Map());
  const requestIdRef = useRef(0);
  const { resolvedLocale } = useLocale();
  const { currency, rate } = useCurrency();

  // Fetch the whole list once. The payload contains only session metadata
  // over loopback, and the server builds every session regardless of the date
  // range anyway, so a server-side window would cost a round trip without
  // saving any work — and it would make the source/project/search filters mean
  // "within the fetched page" instead of "within your sessions".
  const load = useCallback(async (refresh = false) => {
    const requestId = ++requestIdRef.current;
    if (refresh) setRefreshing(true);
    else setIsLoading(true);
    setError(null);
    try {
      const result = await getSessions({ refresh });
      // A cold scan can take several seconds; never let an older response
      // overwrite a newer one.
      if (requestId === requestIdRef.current) setData(result);
    } catch (err) {
      if (requestId === requestIdRef.current) setError(err?.message || String(err));
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (IS_LOCAL_HOST || isMockEnabled()) void load(false);
    else setIsLoading(false);
  }, [load]);

  const allSessions = data?.sessions || NO_SESSIONS;
  // Distinct project names present in the loaded sessions, for the project
  // filter dropdown. Keyed by project_key (what the row filter matches on).
  const projectOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    for (const row of allSessions) {
      const key = row.project_key;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      options.push({ value: key, label: key });
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
  }, [allSessions]);
  const modelOptions = useMemo(() => {
    const models = new Set();
    for (const session of allSessions) {
      for (const usage of sessionModels(session)) {
        if (usage.model) models.add(usage.model);
      }
    }
    return [...models].sort().map((model) => ({ value: model, label: model }));
  }, [allSessions]);

  // Typing stays responsive on long lists: the filter runs against a deferred
  // copy of the query, so keystrokes paint before the list re-filters.
  const deferredQuery = useDeferredValue(searchQuery);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const startMs = rangeStartMs(rangeFilter);
    let fromMs = startMs, toMs = Infinity;
    if (rangeFilter === "custom") {
      fromMs = customFrom ? new Date(`${customFrom}T00:00:00`).getTime() : 0;
      toMs = customTo ? new Date(`${customTo}T23:59:59.999`).getTime() : Infinity;
      if (fromMs > toMs) {
        fromMs = new Date(`${customTo}T00:00:00`).getTime();
        toMs = new Date(`${customFrom}T23:59:59.999`).getTime();
      }
    }
    return scopeSessionsToRange(allSessions, fromMs, toMs).filter((row) => {
      if (sourceFilter !== "all" && row.source !== sourceFilter) return false;
      if (projectFilter !== "all" && row.project_key !== projectFilter) return false;
      if (modelFilter !== "all" && !sessionModels(row).some((usage) => usage.model === modelFilter)) return false;
      if (rangeFilter === "custom") {
        if (!overlapsSessionDates(row, customFrom, customTo)) return false;
      } else if (!overlapsRange(row, startMs)) return false;
      if (!q) return true;
      const models = sessionModels(row).map((usage) => usage.model).join(" ");
      const haystack = `${row.title || ""} ${row.project_key || ""} ${models} ${row.agent_nickname || ""} ${row.agent_role || ""} ${row.project_ref || ""} ${row.session_id || ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [allSessions, sourceFilter, projectFilter, modelFilter, rangeFilter, customFrom, customTo, deferredQuery]);

  const summary = useMemo(() => summarizeSessions(filtered), [filtered]);

  const grouped = useMemo(() => {
    const visibleHashes = new Set(filtered.map((row) => row.session_hash));
    const childrenByRoot = new Map();
    const roots = [];

    for (const row of sortSessions(filtered, sortMode)) {
      const rootHash = row.root_session_hash || row.parent_session_hash;
      if (row.parent_session_hash && rootHash && visibleHashes.has(rootHash)) {
        const children = childrenByRoot.get(rootHash) || [];
        children.push(row);
        childrenByRoot.set(rootHash, children);
      } else {
        // A child whose parent is outside the active search/filter remains
        // visible as a standalone result instead of disappearing.
        roots.push(row);
      }
    }

    return {
      roots,
      childrenByRoot,
      foldedCount: filtered.length - roots.length,
    };
  }, [filtered, sortMode]);

  const anyFilter = sourceFilter !== "all" || modelFilter !== "all" || rangeFilter !== "all" || projectFilter !== "all" || searchQuery.trim() !== "";

  // Restart the rendered window whenever the result set changes, so a narrower
  // filter doesn't leave the user scrolled into a stale slice.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setExpandedThreads(new Set());
    setThreadModelFilters(new Map());
  }, [sourceFilter, projectFilter, modelFilter, rangeFilter, customFrom, customTo, deferredQuery, sortMode, groupMode, allSessions]);

  const visible = useMemo(() => grouped.roots.slice(0, visibleCount), [grouped.roots, visibleCount]);
  const visibleGroups = useMemo(() => groupSessions(visible, groupMode), [visible, groupMode]);
  const detailSubagents = useMemo(() => detailSession
    ? allSessions.filter((session) => session.session_hash !== detailSession.session_hash
      && (session.root_session_hash === detailSession.session_hash || session.parent_session_hash === detailSession.session_hash))
    : NO_SESSIONS, [allSessions, detailSession]);
  const closeDetail = useCallback(() => setDetailSession(null), []);
  const setDateRange = useCallback((range) => {
    setRangeFilter(range);
    if (range !== "custom") {
      setCustomFrom("");
      setCustomTo("");
    }
  }, []);
  const clearFilters = useCallback(() => {
    setSourceFilter("all");
    setModelFilter("all");
    setProjectFilter("all");
    setSearchQuery("");
    setDateRange("all");
  }, [setDateRange]);
  const hasMore = grouped.roots.length > visible.length;
  const showMore = useCallback(() => setVisibleCount((n) => n + PAGE_SIZE), []);
  const toggleThread = useCallback((sessionHash) => {
    setExpandedThreads((current) => {
      const next = new Set(current);
      if (next.has(sessionHash)) next.delete(sessionHash);
      else next.add(sessionHash);
      return next;
    });
  }, []);
  const setThreadModel = useCallback((sessionHash, model) => {
    setThreadModelFilters((current) => {
      const next = new Map(current);
      if (model === "all") next.delete(sessionHash);
      else next.set(sessionHash, model);
      return next;
    });
  }, []);

  // Auto-extend the window when the sentinel below the list scrolls into view.
  // The button inside it stays functional (and keyboard-reachable) when
  // IntersectionObserver is unavailable.
  const sentinelRef = useRef(null);
  useEffect(() => {
    if (!hasMore || typeof IntersectionObserver === "undefined") return undefined;
    const node = sentinelRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore();
      },
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, showMore]);

  const sourceOptions = useMemo(
    () => SOURCE_FILTERS.map((option) => ({ value: option.id, label: option.label() })),
    [resolvedLocale],
  );
  const rangeOptions = useMemo(
    () => [
      ...DATE_RANGES.map((option) => ({ value: option.id, label: option.label() })),
      { value: "custom", label: copy("sessions.filter.range_custom") },
    ],
    [resolvedLocale],
  );
  const groupOptions = useMemo(
    () => [{ value: "time", label: copy("sessions.group.time") }, { value: "project", label: copy("sessions.group.project") }],
    [resolvedLocale],
  );
  const sortOptions = useMemo(
    () => [{ value: "recent", label: copy("sessions.sort.recent") }, { value: "cost", label: copy("sessions.sort.cost") }, { value: "tokens", label: copy("sessions.sort.tokens") }],
    [resolvedLocale],
  );

  const truncated = Number(data?.session_count) > Number(data?.returned_count);

  // Sessions read local Claude/Codex/Grok logs from the machine running the CLI;
  // there is no cloud source. On the deployed web app, surface the local-only
  // notice instead of an empty list.
  if (!IS_LOCAL_HOST && !isMockEnabled()) {
    return (
      <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
        <LocalOnlyNotice />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          {/* A plain div, not a header element: the macOS app injects
              `.native-app header { padding-top: 36px }`, which pushed this
              title below every other page's. */}
          <div className="mb-8 flex flex-row items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="mb-3 text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">{copy("nav.sessions")}</h1>
              <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400 sm:text-base">{copy("sessions.page.summary")}</p>
            </div>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing || isLoading}
              aria-label={copy("sessions.page.refresh")}
              title={copy("sessions.page.refresh")}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-oai-gray-200 text-oai-gray-600 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50 dark:border-oai-gray-800 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white"
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden />
            </button>
          </div>

          <div className="mb-6 space-y-3">
            <div className="sessions-toolbar">
            <div className="sessions-toolbar-search relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-500 dark:text-oai-gray-400" aria-hidden />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && searchQuery) { event.preventDefault(); setSearchQuery(""); }
                }}
                aria-label={copy("sessions.action.search_aria")}
                placeholder={copy("sessions.search.placeholder")}
                className="h-11 pl-10 pr-12 text-sm !bg-white dark:!bg-oai-gray-900 !border-oai-gray-200 placeholder:!text-oai-gray-500 dark:!border-oai-gray-800 dark:placeholder:!text-oai-gray-400 sm:h-9 [&::-webkit-search-cancel-button]:appearance-none"
              />
              {searchQuery ? (
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setSearchQuery("")} aria-label={copy("sessions.action.search_clear")} className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-md text-oai-gray-600 hover:bg-oai-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800 sm:h-9 sm:w-9">
                  <XIcon className="h-4 w-4" aria-hidden />
                </button>
              ) : null}
            </div>
              <Select ariaLabel={copy("sessions.filter.source_aria")} options={sourceOptions} value={sourceFilter} onValueChange={setSourceFilter} className="sessions-filter-trigger h-11 min-w-0 px-3 text-sm sm:h-9" matchTriggerWidth />
              <Select ariaLabel={copy("sessions.filter.range_aria")} options={rangeOptions} value={rangeFilter} onValueChange={setDateRange} leadingIcon={<Calendar className="h-3.5 w-3.5 shrink-0 text-oai-gray-500 dark:text-oai-gray-400" aria-hidden />} className="sessions-filter-trigger h-11 min-w-0 px-3 text-sm sm:h-9" matchTriggerWidth />
              <SearchableSelect options={projectOptions} value={projectFilter} onChange={setProjectFilter} allLabel={copy("sessions.filter.project_all")} searchPlaceholder={copy("sessions.filter.project_search")} emptyLabel={copy("sessions.filter.project_empty")} ariaLabel={copy("sessions.filter.project_aria")} className="sessions-filter-trigger !h-11 !w-full !max-w-none !px-3 !text-sm !font-normal sm:!h-9 !bg-white !text-oai-black dark:!bg-oai-gray-900 dark:!text-white [&>svg]:!text-oai-gray-500 dark:[&>svg]:!text-oai-gray-400" />
              <SearchableSelect options={modelOptions} value={modelFilter} onChange={setModelFilter} allLabel={copy("sessions.filter.model_all")} searchPlaceholder={copy("sessions.filter.model_search")} emptyLabel={copy("sessions.filter.model_empty")} ariaLabel={copy("sessions.filter.model_aria")} className="sessions-filter-trigger sessions-model-filter !h-11 !w-full !max-w-none !px-3 !text-sm !font-normal sm:!h-9 !bg-white !text-oai-black dark:!bg-oai-gray-900 dark:!text-white [&>svg]:!text-oai-gray-500 dark:[&>svg]:!text-oai-gray-400" />
            </div>
            {rangeFilter === "custom" ? (
              <div className="grid max-w-lg grid-cols-2 gap-3">
                <label className="min-w-0 text-xs text-oai-gray-600 dark:text-oai-gray-300">
                  <span className="mb-1 block">{copy("sessions.filter.from")}</span>
                  <input type="date" aria-label={copy("sessions.filter.from")} value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} className="h-11 w-full min-w-0 rounded-md border border-oai-gray-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 sm:h-10" />
                </label>
                <label className="min-w-0 text-xs text-oai-gray-600 dark:text-oai-gray-300">
                  <span className="mb-1 block">{copy("sessions.filter.to")}</span>
                  <input type="date" aria-label={copy("sessions.filter.to")} value={customTo} onChange={(event) => setCustomTo(event.target.value)} className="h-11 w-full min-w-0 rounded-md border border-oai-gray-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-oai-brand-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 sm:h-10" />
                </label>
              </div>
            ) : null}
          </div>

          {!isLoading && data ? (
            <section className="mb-6 flex items-start gap-3 rounded-lg border border-oai-gray-200 px-4 py-3 dark:border-oai-gray-800">
              <dl className="sessions-kpis grid min-w-0 flex-1 grid-cols-2 gap-y-3 sm:grid-cols-4">
                <div><dt className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("sessions.summary.count")}</dt><dd className="mt-1 text-lg font-medium tabular-nums">{formatCompactNumber(summary.count)}</dd></div>
                <div><dt className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("sessions.col.tokens")}</dt><dd className="mt-1 text-lg font-medium tabular-nums">{formatCompactNumber(summary.tokens)}</dd></div>
                <div><dt className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("sessions.col.cost")}</dt><dd className="mt-1 text-lg font-medium tabular-nums">{summary.costIsPartial ? "≥" : ""}{formatUsdCurrency(summary.cost, { currency, rate })}</dd></div>
                <div>
                  <dt className="flex items-center gap-1.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">
                    <span>{copy("sessions.summary.speed")}</span>
                    <SessionSummaryHelp />
                  </dt>
                  <dd className="mt-1 text-lg font-medium tabular-nums"><SessionPerformance performance={summary.performance} />{summary.performance.estimated_tokens_per_second == null ? "—" : null}</dd>
                </div>
              </dl>
            </section>
          ) : null}

          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 text-xs tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
              <span>
                {grouped.foldedCount > 0 ? copy("sessions.thread.result_count", { roots: grouped.roots.length, subagents: grouped.foldedCount }) : copy("sessions.filter.result_count", { filtered: filtered.length, total: allSessions.length })}
              </span>
              {anyFilter ? <button type="button" onClick={clearFilters} className="inline-flex min-h-10 items-center rounded text-oai-gray-700 underline decoration-oai-gray-300 underline-offset-4 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:text-oai-gray-200 dark:decoration-oai-gray-600 dark:hover:text-white sm:min-h-0">{copy("sessions.filter.clear")}</button> : null}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Select ariaLabel={copy("sessions.group.aria")} options={groupOptions} value={groupMode} onValueChange={setGroupMode} className="sessions-filter-trigger h-11 min-w-0 max-w-40 px-2.5 text-xs sm:h-8" />
              <Select ariaLabel={copy("sessions.sort.aria")} options={sortOptions} value={sortMode} onValueChange={setSortMode} className="sessions-filter-trigger h-11 min-w-0 max-w-44 px-2.5 text-xs sm:h-8" align="end" />
            </div>
          </div>

          {truncated ? (
            <p className="mb-4 text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {copy("sessions.truncated", { shown: data.returned_count, total: data.session_count })}
            </p>
          ) : null}

          {error && !data ? (
            <div className="rounded-xl border border-dashed border-red-300 py-16 text-center dark:border-red-500/40">
              <p className="text-sm font-medium text-oai-black dark:text-white">{copy("sessions.error.title")}</p>
              <p className="mt-1 text-sm text-oai-gray-500 dark:text-oai-gray-400">{error}</p>
              <button
                type="button"
                onClick={() => void load(false)}
                className="mt-4 inline-flex h-11 items-center rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:text-oai-gray-200 dark:hover:bg-oai-gray-800 dark:hover:text-white"
              >
                {copy("sessions.error.retry")}
              </button>
            </div>
          ) : isLoading ? (
            <div className="flex items-center gap-2 py-16 text-sm text-oai-gray-500 dark:text-oai-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {copy("sessions.loading")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-oai-gray-200 py-16 text-center dark:border-oai-gray-800">
              <p className="text-sm font-medium text-oai-black dark:text-white">
                {anyFilter ? copy("sessions.empty.filtered_title") : copy("sessions.empty.title")}
              </p>
              <p className="mt-1 text-sm text-oai-gray-500 dark:text-oai-gray-400">
                {anyFilter ? copy("sessions.empty.filtered_body") : copy("sessions.empty.body")}
              </p>
            </div>
          ) : (
            <>
              {error ? (
                <p className="mb-4 text-sm text-red-500 dark:text-red-400">{copy("shared.error.prefix", { error })}</p>
              ) : null}
              <div className="sessions-row-grid sessions-list-header border-b border-oai-gray-200 py-2 text-xs text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400" aria-hidden>
                <span>{copy("sessions.col.session")}</span>
                <span className="text-right">{copy("sessions.col.tokens")}</span>
                <span className="text-right">{copy("sessions.col.cost")}</span>
                <span className="text-right">{copy("sessions.col.speed")}</span>
                <span className="sr-only">{copy("sessions.col.actions")}</span>
              </div>
              <ul className="divide-y divide-oai-gray-200 dark:divide-oai-gray-800">
                {visibleGroups.map((group) => (
                  <React.Fragment key={group.key}>
                    <li className="pb-2 pt-5">
                      <h2 className="break-words text-xs font-medium text-oai-gray-900 dark:text-oai-gray-100">
                        {groupMode === "project"
                          ? group.key || copy("sessions.project.unknown")
                          : group.key
                            ? new Date(`${group.key}T12:00:00`).toLocaleDateString(resolvedLocale || undefined, { year: "numeric", month: "short", day: "numeric" })
                            : copy("sessions.group.unknown_date")}
                      </h2>
                    </li>
                    {group.sessions.map((session) => {
                  const children = grouped.childrenByRoot.get(session.session_hash) || [];
                  const expanded = expandedThreads.has(session.session_hash);
                  const selectedModel = threadModelFilters.get(session.session_hash) || "all";
                  const visibleChildren = selectedModel === "all"
                    ? children
                    : children.filter(function matchesSelectedModel(child) {
                        return sessionModels(child).some((usage) => usage.model === selectedModel);
                      });

                  return (
                    <React.Fragment key={session.session_hash}>
                      <SessionRow
                        session={session}
                        locale={resolvedLocale}
                        timeOnly={groupMode === "time"}
                        childCount={children.length}
                        expanded={expanded}
                        onToggle={toggleThread}
                        onDetail={setDetailSession}
                      />
                      {expanded && children.length ? (
                        <ThreadModelUsage
                          sessions={children}
                          selectedModel={selectedModel}
                          onSelect={(model) => setThreadModel(session.session_hash, model)}
                        />
                      ) : null}
                      {expanded
                        ? visibleChildren.map((child) => (
                            <SessionRow
                              key={child.session_hash}
                              session={child}
                              locale={resolvedLocale}
                              nested
                              timeOnly={groupMode === "time"}
                              onDetail={setDetailSession}
                            />
                          ))
                        : null}
                    </React.Fragment>
                  );
                })}
                  </React.Fragment>
                ))}
              </ul>
              {hasMore ? (
                <div ref={sentinelRef} className="flex justify-center pt-6">
                  <button
                    type="button"
                    onClick={showMore}
                    className="inline-flex h-11 items-center rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-600 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                  >
                    {copy("sessions.action.load_more")}
                  </button>
                </div>
              ) : null}
            </>
          )}

          <p className="mt-8 max-w-3xl text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-300">
            {copy("sessions.privacy")}
          </p>
        </div>
      </main>
      {detailSession ? <SessionDetailModal session={detailSession} subagents={detailSubagents} onClose={closeDetail} /> : null}
    </div>
  );
}
