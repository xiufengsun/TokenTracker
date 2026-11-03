import React from "react";
import { copy } from "../../../lib/copy";
import { PROVIDER_RESETS_SOURCE_URL, RESET_TYPE_BANKED } from "../../../lib/provider-resets.js";

// Automatic (provider-wide) resets vs banked resets granted to redeem later.
// Kept off the emerald activity scale so a reset never reads as usage.
const RESET_STYLES = {
  regular: {
    swatch: "bg-blue-500 dark:bg-blue-400",
    badge: "bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-300 dark:border-blue-400/30",
  },
  banked: {
    swatch: "bg-amber-500 dark:bg-amber-400",
    badge: "bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-300 dark:border-amber-400/30",
  },
};
const BOTH_SWATCH =
  "bg-gradient-to-br from-50% to-50% from-blue-500 to-amber-500 dark:from-blue-400 dark:to-amber-400";

export function resetCellClassName(bucket) {
  if (!bucket) return null;
  const hasRegular = bucket.regular.length > 0;
  const hasBanked = bucket.banked.length > 0;
  if (hasRegular && hasBanked) return BOTH_SWATCH;
  if (hasBanked) return RESET_STYLES.banked.swatch;
  return hasRegular ? RESET_STYLES.regular.swatch : null;
}

function resetTypeLabel(type) {
  return type === RESET_TYPE_BANKED ? copy("heatmap.resets.type.banked") : copy("heatmap.resets.type.regular");
}

function ResetEventRow({ event }) {
  const style = RESET_STYLES[event.type] || RESET_STYLES.regular;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${style.badge}`}>
          {resetTypeLabel(event.type)}
        </span>
        {event.scope ? (
          <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-500 truncate" title={event.scope}>
            {event.scope}
          </span>
        ) : null}
      </div>
      {event.note ? (
        <p className="text-[11px] text-oai-gray-600 dark:text-oai-gray-300 leading-snug line-clamp-3">{event.note}</p>
      ) : null}
    </div>
  );
}

export function ResetTooltipBody({ day, bucket }) {
  const events = bucket ? [...bucket.banked, ...bucket.regular] : [];
  return (
    <>
      <div className="flex items-center justify-between border-b border-oai-gray-100 dark:border-oai-gray-800/80 pb-1.5">
        <span className="text-[11px] font-semibold text-oai-gray-500 dark:text-oai-gray-400">{day}</span>
      </div>
      {events.length === 0 ? (
        <p className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400">{copy("heatmap.resets.tooltip.none")}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {events.map((event) => (
            <ResetEventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </>
  );
}

export function ResetLegend({ emptyColor, loading, error }) {
  let status = null;
  if (loading) status = copy("heatmap.resets.loading");
  else if (error) status = copy("heatmap.resets.error");
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mt-3 text-[10px] text-oai-gray-400 dark:text-oai-gray-400">
      {status ? <span role="status">{status}</span> : null}
      <span className="flex items-center gap-1">
        <span className="rounded-[1px] w-2.5 h-2.5" style={{ background: emptyColor }} />
        {copy("heatmap.resets.legend.none")}
      </span>
      <span className="flex items-center gap-1">
        <span className={`rounded-[1px] w-2.5 h-2.5 ${RESET_STYLES.regular.swatch}`} />
        {copy("heatmap.resets.type.regular")}
      </span>
      <span className="flex items-center gap-1">
        <span className={`rounded-[1px] w-2.5 h-2.5 ${RESET_STYLES.banked.swatch}`} />
        {copy("heatmap.resets.type.banked")}
      </span>
      <a
        href={PROVIDER_RESETS_SOURCE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:text-oai-gray-600 dark:hover:text-oai-gray-200"
      >
        {copy("heatmap.resets.source")}
      </a>
    </div>
  );
}
