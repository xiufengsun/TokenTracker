import { Dialog } from "@base-ui/react/dialog";
import { X, ArrowUpRight, Check, Link2, Code2 } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { copy } from "../../lib/copy";
import { formatCompactNumber, formatUsdCurrency } from "../../lib/format";
import { formatProviderDisplayName } from "../../lib/provider-display";
import { useCurrency } from "../../hooks/useCurrency.js";
import { useTokenFormat } from "../../hooks/useTokenFormat.js";
import { TOKEN_FORMAT_MODES } from "../../lib/token-format.js";
import { getLeaderboardProfile } from "../../lib/api";
import { resolveAuthAccessTokenWithRetry } from "../../lib/auth-token";
import { buildActivityHeatmap } from "../../lib/activity-heatmap";
import { LeaderboardAvatar } from "../LeaderboardAvatar.jsx";
import { ProviderIcon } from "../../ui/dashboard/components/ProviderIcon.jsx";
import { ActivityHeatmap } from "../../ui/dashboard/components/ActivityHeatmap.jsx";
import { cn } from "../../lib/cn";
import { isNativeApp } from "../../lib/native-bridge.js";
import { LikeButton } from "../../ui/dashboard/components/LikeButton.jsx";
import { getInsforgeRemoteUrl } from "../../lib/insforge-config";
import { safeWriteClipboard } from "../../lib/safe-browser";
import { getBrowserTimeZone, getBrowserTimeZoneOffsetMinutes } from "../../lib/timezone";
import { useInsforgeAuth } from "../../contexts/InsforgeAuthContext.jsx";
import { AchievementsSection } from "../../ui/achievements/AchievementsSection.jsx";
import { AvatarWithBadge } from "../../ui/achievements/AvatarWithBadge.jsx";
import { BadgeStrip } from "../../ui/achievements/BadgeStrip.jsx";
import { highestBadge } from "../../ui/achievements/badge-catalog";
import { TokenFormatModeOverride } from "../../ui/foundation/TokenFormatProvider.jsx";

// Lazy: the 3D coin + dialog code ships only when a badge is clicked.
const BadgeDetailModal = React.lazy(() => import("../../ui/achievements/BadgeDetailModal.jsx"));

function formatCost(value, currency, rate) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n > 0 && n < 0.01) {
    const symbol = currency === "USD" ? "$" : "";
    return `<${symbol}0.01`;
  }
  return formatUsdCurrency(n, { decimals: 2, currency, rate });
}

/**
 * Compact cost for the stat strip: stays exact under $1000 (so "$94.83" reads
 * naturally), then collapses to K/M/B so a million-dollar total doesn't blow
 * out the 4-column grid alongside a 3-character token count like "56.4B".
 */
function formatCostCompact(value, currency, rate) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return formatCost(n, currency, rate);
  const converted = currency === "USD" ? n : n * (rate || 1);
  const symbol = currency === "USD" ? "$" : "";
  return `${symbol}${formatCompactNumber(converted, { decimals: 1 })}`;
}

/**
 * Adapt the edge function's daily series ({date, total_tokens}[]) into the
 * shape consumed by the dashboard heatmap and trend components. Heatmap
 * goes through `buildActivityHeatmap` (same path the main dashboard uses);
 * TrendMonitor consumes the rows directly via `day` + `total_tokens`.
 */
function buildHeatmapForModal(daily) {
  const arr = Array.isArray(daily) ? daily : [];
  if (arr.length === 0) return null;
  // Forward `models` so the heatmap's hover tooltip can render the per-day
  // model breakdown (same as the main dashboard heatmap).
  const dailyRows = arr.map((d) => ({
    day: d.date,
    total_tokens: d.total_tokens,
    models: d.models || null,
  }));
  const lastDate = arr[arr.length - 1]?.date;
  return buildActivityHeatmap({ dailyRows, weeks: 52, to: lastDate });
}

const shimmerStyle = `
  @keyframes tt-shimmer {
    100% { transform: translateX(100%); }
  }
  .tt-shimmer-bar {
    position: relative;
    overflow: hidden;
  }
  .tt-shimmer-bar::after {
    position: absolute;
    top: 0; right: 0; bottom: 0; left: 0;
    transform: translateX(-100%);
    background-image: linear-gradient(
      90deg,
      rgba(0, 0, 0, 0) 0%,
      rgba(0, 0, 0, 0.02) 20%,
      rgba(0, 0, 0, 0.06) 60%,
      rgba(0, 0, 0, 0) 100%
    );
    animation: tt-shimmer 1.6s infinite;
    content: '';
  }
  .dark .tt-shimmer-bar::after {
    background-image: linear-gradient(
      90deg,
      rgba(255, 255, 255, 0) 0%,
      rgba(255, 255, 255, 0.02) 20%,
      rgba(255, 255, 255, 0.06) 60%,
      rgba(255, 255, 255, 0) 100%
    );
  }
`;

/**
 * Skeleton that mirrors the real profile layout (header → stat strip →
 * fact list → heatmap → provider list). Same heights as the loaded view
 * to avoid layout shift on resolve.
 */
export function ProfileSkeleton({ variant = "modal" }) {
  const bar = "rounded bg-oai-gray-200/50 dark:bg-oai-gray-800/40 tt-shimmer-bar";
  const isPage = variant === "page";
  return (
    <div>
      <style dangerouslySetInnerHTML={{ __html: shimmerStyle }} />
      {isPage ? (
        <div className="flex items-start gap-5 px-6 sm:px-8 pt-8 pb-7 animate-fade-in">
          <div className="h-[68px] w-[68px] rounded-full bg-oai-gray-200/50 dark:bg-oai-gray-800/40 tt-shimmer-bar shrink-0" />
          <div className="flex-1 min-w-0 flex items-start justify-between gap-4 pt-0.5">
            <div className="min-w-0 space-y-2.5">
              <div className={cn(bar, "h-7 w-48")} />
              <div className={cn(bar, "h-3.5 w-32")} />
            </div>
            <div className="shrink-0 space-y-1.5 flex flex-col items-end">
              <div className={cn(bar, "h-2.5 w-8")} />
              <div className={cn(bar, "h-7 w-12")} />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-4 px-6 pt-6 pb-5 border-b border-oai-gray-200/80 dark:border-oai-gray-800/60 animate-fade-in">
          <div className="h-14 w-14 rounded-full bg-oai-gray-200/50 dark:bg-oai-gray-800/40 tt-shimmer-bar shrink-0" />
          <div className="flex-1 min-w-0 space-y-2 pt-1">
            <div className={cn(bar, "h-4 w-40")} />
            <div className={cn(bar, "h-3 w-56")} />
          </div>
          <div className={cn(bar, "h-4 w-4 shrink-0 mt-1")} />
        </div>
      )}
      <div
        className={cn(
          "space-y-6",
          isPage
            ? "px-6 sm:px-8 pt-6 pb-8 border-t border-oai-gray-200/80 dark:border-oai-gray-800/60"
            : "px-6 py-5",
        )}
      >
        <div className="grid grid-cols-4 gap-x-6 gap-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <div className={cn(bar, "h-6 w-20")} />
              <div className={cn(bar, "mt-2 h-3 w-14")} />
            </div>
          ))}
        </div>
        <div className="space-y-3 border-t border-oai-gray-200/70 dark:border-oai-gray-800/60 pt-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className={cn(bar, "h-3 w-24")} />
              <div className={cn(bar, "h-3 w-44")} />
            </div>
          ))}
        </div>
        <div className="border-t border-oai-gray-200/70 dark:border-oai-gray-800/60 pt-5">
          <div className={cn(bar, "h-3 w-44 mb-4")} />
          <div className="grid grid-cols-[repeat(52,1fr)] gap-[2px]">
            {Array.from({ length: 7 * 52 }).map((_, i) => (
              <div key={i} className="aspect-square rounded-[2px] bg-oai-gray-200/40 dark:bg-oai-gray-800/30 tt-shimmer-bar" />
            ))}
          </div>
        </div>
        <div className="border-t border-oai-gray-200/70 dark:border-oai-gray-800/60 pt-5">
          <div className={cn(bar, "h-3 w-28 mb-3")} />
          <div className="space-y-2.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className={cn(bar, "h-4 w-4")} />
                <div className={cn(bar, "h-3 w-16")} />
                <div className={cn(bar, "h-[3px] flex-1")} />
                <div className={cn(bar, "h-3 w-12")} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function extractGithubHandle(url) {
  if (!url) return null;
  const m = String(url).match(/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})/i);
  return m ? m[1] : null;
}

function SectionLabel({ children }) {
  return (
    <h3 className="text-[11px] uppercase tracking-[0.08em] text-oai-gray-500 dark:text-oai-gray-400 mb-3">
      {children}
    </h3>
  );
}

/** Stat number stacked over caption label. */
function Stat({ value, label, title }) {
  return (
    <div>
      <div
        title={title}
        className="text-2xl font-black tabular-nums tracking-tight leading-none text-oai-black dark:text-white"
        style={{ 
          fontFamily: '"DIN Alternate-Bold", "DIN Alternate", "DIN Condensed-Bold", "Impact", -apple-system, sans-serif',
          fontWeight: 900 
        }}
      >
        {value}
      </div>
      <div className="mt-1.5 text-[11px] text-oai-gray-500 dark:text-oai-gray-400">{label}</div>
    </div>
  );
}

/** Label/value row used in the inline fact list (streak, best day, top model). */
function FactRow({ label, children }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <dt className="shrink-0 w-28 whitespace-nowrap text-oai-gray-500 dark:text-oai-gray-400">{label}</dt>
      <dd className="min-w-0 flex-1 text-oai-gray-900 dark:text-oai-gray-100 tabular-nums truncate flex items-baseline gap-2 flex-wrap">
        {children}
      </dd>
    </div>
  );
}

function Header({ user, onClose }) {
  const handle = extractGithubHandle(user?.github_url);
  return (
    <div className="flex items-center gap-4 px-6 pt-6 pb-5 border-b border-oai-gray-200/80 dark:border-oai-gray-800/60">
      <LeaderboardAvatar
        avatarUrl={user?.avatar_url}
        displayName={user?.display_name || ""}
        seed={user?.user_id || user?.display_name}
        size="lg"
        className="shrink-0 ring-1 ring-oai-gray-200 dark:ring-oai-gray-800"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-semibold text-oai-black dark:text-white">
            {user?.display_name || "—"}
          </h2>
          {user?.rank ? (
            <span className={cn(
              "shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-bold font-mono uppercase tracking-wider border shadow-sm",
              user.rank === 1 && "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400 dark:bg-amber-400/10",
              user.rank === 2 && "bg-slate-500/10 text-slate-600 border-slate-500/20 dark:text-slate-400 dark:bg-slate-400/10",
              user.rank === 3 && "bg-orange-500/10 text-orange-700 border-orange-500/20 dark:text-orange-400 dark:bg-orange-400/10",
              user.rank > 3 && "bg-oai-gray-100 dark:bg-oai-gray-900/60 text-oai-gray-500 dark:text-oai-gray-400 border-oai-gray-200/60 dark:border-oai-gray-800"
            )}>
              {copy("leaderboard.profile_modal.rank", { rank: user.rank })}
            </span>
          ) : null}
        </div>
        {handle && (
          <a
            href={user.github_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-[12px] text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-800 dark:hover:text-oai-gray-200 transition-colors"
          >
            <ProviderIcon provider="GITHUB" size={11} />
            <span>@{handle}</span>
          </a>
        )}
      </div>
      {user?.user_id && (
        <div className="shrink-0 flex items-center justify-center">
          <LikeButton userId={user.user_id} />
        </div>
      )}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 -mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-md text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-900 dark:hover:text-white hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/50 transition-colors group"
          aria-label={copy("leaderboard.profile_modal.close")}
        >
          <X size={16} strokeWidth={2} aria-hidden className="transition-transform duration-200 group-hover:rotate-90 group-active:scale-90" />
        </button>
      )}
    </div>
  );
}

/**
 * Standalone-page hero. The modal `Header` anchors a close button on the right
 * edge; on the /u/:userId page there's no close button, so reusing it leaves
 * the right half empty and unbalanced. This hero is built for the page: a
 * larger avatar, the name as the page's primary heading, and the rank pushed
 * to the right edge as a deliberate counterweight.
 */
function PageHero({ user, topBadge }) {
  const handle = extractGithubHandle(user?.github_url);
  const rank = Number(user?.rank) || 0;
  const rankTone =
    rank === 1
      ? "text-amber-500 dark:text-amber-400"
      : rank === 2
        ? "text-slate-500 dark:text-slate-300"
        : rank === 3
          ? "text-orange-600 dark:text-orange-400"
          : "text-oai-gray-400 dark:text-oai-gray-500";
  return (
    <div className="flex items-center gap-5 px-6 sm:px-8 pt-8 pb-7">
      <AvatarWithBadge
        badge={topBadge}
        avatarUrl={user?.avatar_url}
        displayName={user?.display_name || ""}
        seed={user?.user_id || user?.display_name}
        size="xl"
        className="shrink-0 ring-1 ring-oai-gray-200 dark:ring-oai-gray-800 rounded-full"
      />
      <div className="min-w-0 flex-1 flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="truncate text-2xl sm:text-[28px] font-semibold tracking-tight leading-tight text-oai-black dark:text-white">
              {user?.display_name || "—"}
            </h1>
            {user?.user_id && <LikeButton userId={user.user_id} />}
          </div>
          {handle ? (
            <a
              href={user.github_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 text-sm text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-900 dark:hover:text-white transition-colors"
            >
              <ProviderIcon provider="GITHUB" size={13} />
              <span>@{handle}</span>
            </a>
          ) : null}
        </div>
        {rank ? (
          <div className="shrink-0 text-right leading-none">
            <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-oai-gray-400 dark:text-oai-gray-500">
              {copy("leaderboard.profile.hero.rank_label")}
            </div>
            <div className={cn("mt-1.5 text-3xl font-black tabular-nums tracking-tight", rankTone)}>
              {copy("leaderboard.profile_modal.rank", { rank })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProviderList({ data }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const arr = Array.isArray(data) ? data : [];
  if (arr.length === 0) {
    return (
      <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
        {copy("leaderboard.profile_modal.providers.none")}
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {arr.map((p) => {
        const pct = Math.max(0, Math.min(1, Number(p?.percent) || 0));
        return (
          <li key={p.source} className="flex items-center gap-3 text-xs">
            <span className="shrink-0 inline-flex items-center justify-center w-4 h-4">
              <ProviderIcon provider={String(p.source).toUpperCase()} size={14} />
            </span>
            <span className="w-20 shrink-0 text-oai-gray-700 dark:text-oai-gray-300">
              {formatProviderDisplayName(p.source)}
            </span>
            <span className="flex-1 h-[3px] rounded-full bg-oai-gray-200/60 dark:bg-oai-gray-800/80 overflow-hidden">
              <span
                className="block h-full bg-oai-brand-500 dark:bg-oai-brand-400"
                style={{ width: `${(pct * 100).toFixed(1)}%` }}
              />
            </span>
            <span title={formatTokensTooltip(p.total_tokens)} className="shrink-0 w-14 text-right tabular-nums text-oai-gray-700 dark:text-oai-gray-300">
              {formatTokens(p.total_tokens)}
            </span>
            <span className="shrink-0 w-10 text-right tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
              {(pct * 100).toFixed(0)}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Compact share chip for the profile footer — copies a string (profile URL, or
 * the embeddable README badge markdown) to the clipboard, flips to a green
 * "Copied" confirmation, then resets. Bordered so the share utilities read as a
 * distinct group from the plain "View full profile" navigation link beside it.
 */
function CopyAction({ icon: Icon, label, value }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    const ok = await safeWriteClipboard(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
        copied
          ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/[0.06]"
          : "border-oai-gray-200 dark:border-oai-gray-800 text-oai-gray-600 dark:text-oai-gray-300 hover:text-oai-gray-900 dark:hover:text-oai-gray-100 hover:border-oai-gray-300 dark:hover:border-oai-gray-700 hover:bg-oai-gray-50 dark:hover:bg-oai-gray-900/40",
      )}
    >
      {copied ? <Check size={13} strokeWidth={2} aria-hidden /> : <Icon size={13} strokeWidth={2} aria-hidden />}
      <span>{copied ? copy("leaderboard.profile_modal.badge.copied") : label}</span>
    </button>
  );
}

/**
 * Profile content shared by the leaderboard modal and the standalone
 * /u/:userId page. `onClose` is optional — when omitted (page mode) the
 * header renders without a close button.
 */
export function ProfileContent({ data, currency, rate, onClose, variant = "modal" }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const {
    user,
    totals,
    streak,
    best_day: bestDay,
    models,
    by_provider: byProvider,
    heatmap,
    period,
  } = data;
  const isPage = variant === "page";
  const heatmapData = useMemo(() => buildHeatmapForModal(heatmap), [heatmap]);
  const favoriteName = models?.favorite?.model_name;
  const modelCount = Number(models?.count) || 0;
  // Older edge deployments don't send `badges` — everything guards on this.
  const badges = Array.isArray(data.badges) ? data.badges : [];
  const [selectedBadge, setSelectedBadge] = useState(null);

  // Only the profile owner sees the embeddable badge (it belongs to them); the
  // leaderboard user_id matches the signed-in InsForge auth user id.
  const auth = useInsforgeAuth();
  const isOwnProfile = Boolean(auth?.user?.id && user?.user_id && auth.user.id === user.user_id);
  const profileUrl = user?.user_id ? `https://www.tokentracker.cc/u/${user.user_id}` : null;
  const badgeSnippet = user?.user_id
    ? `[![My AI coding usage](${getInsforgeRemoteUrl()}/functions/tokentracker-embed-svg?user_id=${user.user_id}&theme=dark)](${profileUrl}?ref=readme)`
    : null;

  return (
    <>
      {isPage ? <PageHero user={user} topBadge={highestBadge(badges)} /> : <Header user={user} onClose={onClose} />}
      <div
        className={cn(
          "space-y-6",
          isPage
            ? "px-6 sm:px-8 pt-6 pb-8 border-t border-oai-gray-200/80 dark:border-oai-gray-800/60"
            : "flex-1 min-h-0 overflow-y-auto oai-scrollbar px-6 py-5",
        )}
      >
        {/* Stat strip — flat row, no nested cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4">
          <Stat
            value={formatTokens(totals?.total_tokens)}
            title={formatTokensTooltip(totals?.total_tokens)}
            label={copy("leaderboard.profile_modal.stat.total_tokens")}
          />
          <Stat
            value={totals?.cost_status === "partial" ? copy("usage.cost.partial") : formatCostCompact(totals?.estimated_cost_usd, currency, rate)}
            label={copy("leaderboard.profile_modal.stat.total_cost")}
          />
          <Stat
            value={String(totals?.active_days ?? 0)}
            label={copy("leaderboard.profile_modal.stat.active_days")}
          />
          <Stat
            value={totals?.cost_status === "partial" ? copy("usage.cost.partial") : formatCostCompact(totals?.avg_per_day_usd, currency, rate)}
            label={copy("leaderboard.profile_modal.stat.avg_per_day")}
          />
        </div>

        {/* Fact list — streak, best day, top model. Three lines, no card. */}
        <dl className="space-y-2 border-t border-oai-gray-200/70 dark:border-oai-gray-800/60 pt-5">
          <FactRow label={copy("leaderboard.profile_modal.streak.current")}>
            <span className="font-mono text-xs tracking-tight bg-oai-gray-100/60 dark:bg-oai-gray-900/50 px-1.5 py-0.5 rounded border border-oai-gray-200/30 dark:border-oai-gray-800/30">
              {copy("leaderboard.profile_modal.streak.days", { count: streak?.current_days ?? 0 })}
            </span>
            <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400 font-mono">
              (max {streak?.longest_days ?? 0})
            </span>
          </FactRow>
          <FactRow label={copy("leaderboard.profile_modal.best_day.title")}>
            {bestDay ? (
              <>
                <span title={formatTokensTooltip(bestDay.total_tokens)} className="font-mono text-xs tracking-tight bg-oai-gray-100/60 dark:bg-oai-gray-900/50 px-1.5 py-0.5 rounded border border-oai-gray-200/30 dark:border-oai-gray-800/30">
                  {formatTokens(bestDay.total_tokens)}
                </span>
                <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400 font-mono">
                  on {bestDay.date}
                </span>
              </>
            ) : (
              <span className="text-xs text-oai-gray-400 dark:text-oai-gray-500 font-mono">
                {copy("leaderboard.profile_modal.best_day.none")}
              </span>
            )}
          </FactRow>
          <FactRow label={copy("leaderboard.profile_modal.models.favorite")}>
            {favoriteName ? (
              <>
                <span className="font-mono text-xs tracking-tight bg-oai-gray-100/60 dark:bg-oai-gray-900/50 px-1.5 py-0.5 rounded border border-oai-gray-200/30 dark:border-oai-gray-800/30 truncate max-w-[200px] inline-block align-bottom">
                  {favoriteName}
                </span>
                {modelCount > 1 && (
                  <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400 font-mono">
                    {copy("leaderboard.profile_modal.models.count", { count: modelCount })}
                  </span>
                )}
              </>
            ) : (
              <span className="text-xs text-oai-gray-400 dark:text-oai-gray-500 font-mono">
                {copy("leaderboard.profile_modal.models.none")}
              </span>
            )}
          </FactRow>
        </dl>

        {/* Achievements. The modal is space-constrained: one overlapping
            coin strip (click a coin for details). The standalone /u/ page has
            room for the full grid with names, tiers, and (own view) progress. */}
        {(isOwnProfile || badges.some((b) => (b?.tier || 0) >= 1)) && (
          <section className="border-t border-oai-gray-200/70 dark:border-oai-gray-800/60 pt-5">
            <SectionLabel>{copy("achievements.section.title")}</SectionLabel>
            {isPage ? (
              <AchievementsSection
                achievements={badges}
                isOwn={isOwnProfile && Boolean(data.badges_include_unearned)}
                scope="cloud"
                onSelect={setSelectedBadge}
              />
            ) : (
              <BadgeStrip
                badges={badges}
                isOwn={isOwnProfile && Boolean(data.badges_include_unearned)}
                onSelect={setSelectedBadge}
              />
            )}
          </section>
        )}

        {heatmapData && (
          <section className="border-t border-oai-gray-200/70 dark:border-oai-gray-800/60 pt-5">
            <SectionLabel>{copy("leaderboard.profile_modal.heatmap.title")}</SectionLabel>
            <div className="min-w-0">
              <ActivityHeatmap heatmap={heatmapData} hideLegend embedded />
            </div>
          </section>
        )}

        <section className="border-t border-oai-gray-200/70 dark:border-oai-gray-800/60 pt-5">
          <SectionLabel>{copy("leaderboard.profile_modal.providers.title")}</SectionLabel>
          <ProviderList data={byProvider} />
        </section>

        {/* Footer: navigation link (modal) on the left, grouped share chips
            (own profile) on the right. justify-between gives the row rhythm;
            in page mode only the chip group renders and sits left. */}
        {user?.user_id && (onClose || isOwnProfile) && (
          <div className="border-t border-oai-gray-200/70 dark:border-oai-gray-800/60 pt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            {onClose &&
              (isNativeApp() ? (
                <a
                  href={profileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onClose}
                  className="group inline-flex items-center gap-1 text-xs font-medium text-oai-gray-700 hover:text-oai-gray-950 dark:text-oai-gray-300 dark:hover:text-oai-white transition-colors"
                >
                  <span>{copy("leaderboard.profile_modal.view_full")}</span>
                  <ArrowUpRight size={13} strokeWidth={2} aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </a>
              ) : (
                <Link
                  to={`/u/${user.user_id}`}
                  onClick={onClose}
                  className="group inline-flex items-center gap-1 text-xs font-medium text-oai-gray-700 hover:text-oai-gray-950 dark:text-oai-gray-300 dark:hover:text-oai-white transition-colors"
                >
                  <span>{copy("leaderboard.profile_modal.view_full")}</span>
                  <ArrowUpRight size={13} strokeWidth={2} aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </Link>
              ))}
            {isOwnProfile && (
              <div className="flex items-center gap-2">
                <CopyAction icon={Link2} label={copy("leaderboard.profile_modal.badge.copy_url")} value={profileUrl} />
                <CopyAction icon={Code2} label={copy("leaderboard.profile_modal.badge.copy")} value={badgeSnippet} />
              </div>
            )}
          </div>
        )}
      </div>

      {selectedBadge && (
        <React.Suspense fallback={null}>
          <BadgeDetailModal badge={selectedBadge} onClose={() => setSelectedBadge(null)} />
        </React.Suspense>
      )}
    </>
  );
}

/**
 * Modal that opens when a leaderboard row is clicked. Fetches the detailed
 * per-user profile from the edge function and renders hero/stats/streak/
 * heatmap/trend/provider sections. See
 * `dashboard/edge-patches/tokentracker-leaderboard-profile.ts` for the
 * canonical response shape.
 */
/**
 * Fetch the detailed per-user profile. Shared by the modal (enabled while
 * open) and the standalone page (always enabled). Returns { loading, error,
 * data }; a 404 resolves to data:null (private / not-found, shown as empty).
 */
export function useLeaderboardProfileData({ userId, period, accessToken, enabled = true }) {
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const timeZone = useMemo(() => getBrowserTimeZone(), []);
  const tzOffsetMinutes = useMemo(() => getBrowserTimeZoneOffsetMinutes(), []);

  useEffect(() => {
    if (!enabled || !userId) return undefined;
    let active = true;
    setState({ loading: true, error: null, data: null });
    (async () => {
      try {
        const token = accessToken ? await resolveAuthAccessTokenWithRetry(accessToken) : null;
        if (!active) return;
        const data = await getLeaderboardProfile({
          accessToken: token,
          userId,
          period: period || "week",
          timeZone,
          tzOffsetMinutes,
        });
        if (!active) return;
        setState({ loading: false, error: null, data });
      } catch (err) {
        if (!active) return;
        if (err?.status === 404) {
          setState({ loading: false, error: null, data: null });
        } else {
          setState({ loading: false, error: err?.message || String(err), data: null });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [enabled, userId, period, accessToken, timeZone, tzOffsetMinutes]);

  return state;
}

export function LeaderboardProfileModal({ isOpen, onClose, userId, period, accessToken }) {
  const { currency, rate } = useCurrency();
  const state = useLeaderboardProfileData({ userId, period, accessToken, enabled: isOpen });

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="cost-modal-backdrop" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-4">
          <Dialog.Popup
            className={cn(
              "cost-modal-popup",
              "relative w-full max-w-[540px] max-h-[calc(100vh-2rem)] flex flex-col",
              "rounded-2xl bg-white dark:bg-oai-gray-950",
              "shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)] dark:shadow-[0_20px_60px_-10px_rgba(0,0,0,0.65)]",
              "ring-1 ring-oai-gray-200 dark:ring-oai-gray-800 overflow-hidden",
              "dark:border-t dark:border-white/[0.08]",
            )}
          >
            <Dialog.Title render={<h2 className="sr-only" />}>
              {state.data?.user?.display_name || copy("leaderboard.profile_modal.loading")}
            </Dialog.Title>

            {state.loading && <ProfileSkeleton />}
            {!state.loading && state.error && (
              <div className="flex-1 flex items-center justify-center min-h-[280px]">
                <p className="text-sm text-red-500 dark:text-red-400">
                  {copy("leaderboard.profile_modal.error")}
                </p>
              </div>
            )}
            {!state.loading && !state.error && !state.data && (
              <div className="flex-1 flex items-center justify-center min-h-[280px]">
                <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("leaderboard.profile_modal.empty")}
                </p>
              </div>
            )}
            {!state.loading && !state.error && state.data && (
              <TokenFormatModeOverride mode={TOKEN_FORMAT_MODES.COMPACT}>
                <ProfileContent data={state.data} currency={currency} rate={rate} onClose={onClose} />
              </TokenFormatModeOverride>
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
