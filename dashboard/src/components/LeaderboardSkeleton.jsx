import React from "react";
import { LeaderboardTableScroll } from "./LeaderboardTableScroll.jsx";
import { cn } from "../lib/cn";
import {
  LB_STICKY_TH_RANK,
  LB_STICKY_TH_USER,
  LEADERBOARD_TOKEN_COLUMNS,
  lbStickyTdRank,
  lbStickyTdUser,
} from "../lib/leaderboard-columns.js";

function Bone({ className }) {
  return (
    <div
      className={cn(
        "rounded bg-oai-gray-200/70 dark:bg-oai-gray-800/70 animate-pulse",
        className,
      )}
    />
  );
}

function SkeletonRow({ index }) {
  // First 3 rows slightly wider to mimic top-ranked users with longer names/numbers
  const nameW = index < 3 ? "w-24" : index < 8 ? "w-20" : "w-16";
  const totalW = index < 3 ? "w-16" : "w-12";
  const cellW = index < 5 ? "w-14" : "w-10";

  return (
    <tr className="group">
      {/* Rank */}
      <td
        className={cn(
          lbStickyTdRank(false),
          "!group-hover:bg-transparent",
        )}
      >
        <Bone className="h-4 w-6" />
      </td>
      {/* User: avatar + name */}
      <td
        className={cn(
          lbStickyTdUser(false),
          "!group-hover:bg-transparent",
        )}
      >
        <div className="flex items-center gap-4">
          <Bone className="h-8 w-8 min-w-8 rounded-full" />
          <Bone className={cn("h-4", nameW)} />
        </div>
      </td>
      {/* Total */}
      <td className="px-4 py-4 bg-white dark:bg-oai-gray-950">
        <Bone className={cn("h-4", totalW)} />
      </td>
      {/* Cost */}
      <td className="px-4 py-4 bg-white dark:bg-oai-gray-950">
        <Bone className="h-4 w-12" />
      </td>
      {/* Provider columns */}
      {LEADERBOARD_TOKEN_COLUMNS.map((col) => (
        <td key={col.key} className="px-4 py-4 bg-white dark:bg-oai-gray-950">
          <Bone className={cn("h-4", cellW)} />
        </td>
      ))}
    </tr>
  );
}

function MobileSkeletonRow({ index }) {
  const nameW = index < 3 ? "w-24" : index < 8 ? "w-20" : "w-16";
  const pillCount = index % 3 === 0 ? 3 : index % 3 === 1 ? 2 : 1;
  return (
    <div className="mx-0 my-1 rounded-xl bg-white dark:bg-oai-gray-950 border border-oai-gray-100 dark:border-oai-gray-800/60 px-3.5 py-3 shadow-sm">
      <div className="flex items-center gap-2.5">
        <Bone className="h-4 w-3 shrink-0 rounded" />
        <Bone className="h-9 w-9 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <Bone className={cn("h-4", nameW)} />
          <Bone className="mt-2 h-3.5 w-20" />
        </div>
        <div className="shrink-0 text-right">
          <Bone className="ml-auto h-3 w-8" />
          <Bone className="mt-1.5 ml-auto h-4 w-14" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-oai-gray-100 pt-2.5 dark:border-oai-gray-800/70">
        {Array.from({ length: pillCount }, (_, i) => (
          <Bone key={i} className="h-5 w-12 rounded-full" />
        ))}
      </div>
    </div>
  );
}

/**
 * Skeleton loader that mirrors the leaderboard table structure.
 * Renders `rows` shimmer rows with the same sticky columns and cell layout.
 */
export function LeaderboardSkeleton({ rows = 10 }) {
  return (
    <>
    <LeaderboardTableScroll>
      <table className="min-w-max w-full text-left text-sm">
        <thead className="border-b border-oai-gray-200 dark:border-oai-gray-800">
          <tr>
            <th
              className={cn(
                LB_STICKY_TH_RANK,
                "font-medium text-oai-gray-500 dark:text-oai-gray-400",
              )}
            >
              <Bone className="h-3.5 w-6" />
            </th>
            <th
              className={cn(
                LB_STICKY_TH_USER,
                "font-medium text-oai-gray-500 dark:text-oai-gray-400",
              )}
            >
              <Bone className="h-3.5 w-12" />
            </th>
            <th className="px-4 py-4">
              <Bone className="h-3.5 w-10" />
            </th>
            <th className="px-4 py-4">
              <Bone className="h-3.5 w-14" />
            </th>
            {LEADERBOARD_TOKEN_COLUMNS.map((col) => (
              <th key={col.key} className="px-4 py-4">
                <Bone className="h-3.5 w-12" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800/50">
          {Array.from({ length: rows }, (_, i) => (
            <SkeletonRow key={i} index={i} />
          ))}
        </tbody>
      </table>
    </LeaderboardTableScroll>
    <div className="flex flex-col py-1 sm:hidden">
      {Array.from({ length: rows }, (_, i) => (
        <MobileSkeletonRow key={i} index={i} />
      ))}
    </div>
    </>
  );
}
