import React from "react";
import { ArrowRight } from "lucide-react";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { LeaderboardAvatar } from "./LeaderboardAvatar.jsx";

// "Top n%" only reads as an achievement in the upper half of the board —
// "Top 90%" is just a slower way of saying "bottom 10%". Past this cutoff
// the chip shows the plain rank with no percentile badge.
const PERCENTILE_BADGE_MAX = 50;

function computePercentile(rank, total) {
  const r = Number(rank);
  const t = Number(total);
  if (!Number.isFinite(r) || r < 1) return null;
  if (!Number.isFinite(t) || t < 1) return null;
  return Math.min(100, Math.max(1, Math.ceil((r / t) * 100)));
}

function trimName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isAnon(value) {
  const v = trimName(value);
  if (!v) return true;
  return v.toLowerCase() === "anonymous";
}

/**
 * Compact identity pill that lives in the page header next to the period
 * toggle. Click → jumps to the user's row when not already on that page.
 */
export function LeaderboardMeChip({
  me,
  totalEntries,
  meLabel,
  onOpenProfile,
  onJumpToMe,
  canJump,
  className,
}) {
  const rank = me && typeof me.rank === "number" ? me.rank : null;
  if (!rank) return null;

  const total = Number(totalEntries) || 0;
  const percentile = computePercentile(rank, total);

  const rawName = trimName(me?.display_name);
  const headlineName = !rawName || isAnon(rawName) ? meLabel || "You" : rawName;
  const avatarSeed = me?.user_id || headlineName;

  // Click opens the user's own profile modal (where the embeddable badge lives).
  // Falls back to the legacy jump-to-row when no profile handler is available.
  const handleClick = onOpenProfile || (canJump ? onJumpToMe : null);
  const interactive = typeof handleClick === "function";
  const Tag = interactive ? "button" : "div";
  const interactiveProps = interactive
    ? {
        type: "button",
        onClick: handleClick,
        "aria-label": copy(
          onOpenProfile
            ? "leaderboard.summary.view_profile"
            : "leaderboard.summary.jump_to_me",
        ),
      }
    : {};

  return (
    <Tag
      {...interactiveProps}
      className={cn(
        "group inline-flex h-9 items-center gap-2.5 rounded-full border pl-1 pr-3.5 transition-all duration-300 select-none",
        interactive
          ? "border-oai-gray-200 hover:border-oai-gray-400 dark:border-oai-gray-800 dark:hover:border-oai-gray-500/80 bg-oai-gray-50/50 dark:bg-white/[0.02] backdrop-blur-md hover:bg-oai-gray-100/40 dark:hover:bg-oai-gray-900/20 active:scale-[0.97] dark:ring-1 dark:ring-white/[0.04] dark:hover:ring-white/[0.08]"
          : "border-oai-gray-100 dark:border-oai-gray-800/60 bg-oai-gray-50/20 dark:bg-white/[0.01] backdrop-blur-sm dark:ring-1 dark:ring-white/[0.02]",
        className,
      )}
    >
      <LeaderboardAvatar
        size="sm"
        avatarUrl={me?.avatar_url}
        displayName={headlineName}
        seed={avatarSeed}
        proActive={me?.pro_active === true}
      />
      <span className="hidden sm:inline max-w-[120px] truncate text-xs font-semibold text-oai-black dark:text-oai-gray-200 group-hover:text-oai-gray-800 dark:group-hover:text-oai-gray-100 transition-colors">
        {headlineName}
      </span>
      {me?.pro_active === true && (
        <span className="leaderboard-pro-badge" role="img" aria-label={copy("leaderboard.pro.badge_aria")} aria-description={copy("leaderboard.pro.tooltip")}>
          {copy("leaderboard.pro.badge")}
        </span>
      )}
      <span className="text-xs font-bold tabular-nums text-oai-gray-800 dark:text-white">
        #{rank.toLocaleString()}
      </span>
      {percentile != null && percentile <= PERCENTILE_BADGE_MAX && (
        <span
          className="hidden sm:inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-extrabold tracking-wider tabular-nums uppercase transition-colors duration-300 ring-1 bg-oai-gray-100 text-oai-gray-700 dark:bg-oai-gray-800 dark:text-oai-gray-300 ring-oai-gray-300/30 dark:ring-oai-gray-600/30"
        >
          {copy("leaderboard.summary.percentile", { p: String(percentile) })}
        </span>
      )}
      {interactive ? (
        <ArrowRight
          aria-hidden
          className="size-3 text-oai-gray-400 transition-all duration-300 group-hover:text-oai-gray-600 dark:text-oai-gray-500 group-hover:translate-x-0.5 group-hover:scale-110"
        />
      ) : (
        <span
          className="relative flex h-1.5 w-1.5 shrink-0 items-center justify-center ml-1"
          title="You are here"
        >
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-oai-gray-400 opacity-75 duration-1000"></span>
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-oai-gray-400 dark:bg-oai-gray-500"></span>
        </span>
      )}
    </Tag>
  );
}
