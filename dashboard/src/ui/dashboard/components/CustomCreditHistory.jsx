import React from "react";
import { copy, getCopyLocale } from "../../../lib/copy";

/** Keep calendar gaps visible when a gateway only reports some of the days. */
export function CustomCreditHistory({ entries, limit }) {
  if (!entries?.length) return null;
  const days = new Map(entries.map((entry) => [entry.date, entry]));
  const keys = [...days.keys()].sort();
  const end = Date.parse(keys.at(-1) + "T00:00:00Z");
  const start = Math.max(Date.parse(keys[0] + "T00:00:00Z"), end - 30 * 86400000);
  const hasLimit = Number.isFinite(limit) && limit > 0;
  const max = Math.max(1, limit || 0, ...entries.map((entry) => entry.used_credits));
  const formatter = new Intl.NumberFormat(getCopyLocale(), { maximumFractionDigits: 2 });
  const columns = [];
  for (let time = start; time <= end; time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10);
    const day = days.get(date);
    const amount = day ? formatter.format(day.used_credits) : "";
    const detail = day?.partial ? copy("limits.customCredits.partialDay", { amount })
      : !day ? copy("limits.status.no_data")
      : day.source === "estimated" ? copy("limits.customCredits.estimated", { amount })
      : copy("limits.customCredits.reported", { amount });
    columns.push(<div key={date} role="img" aria-label={`${date} · ${detail}`} title={`${date} · ${detail}`}
      className="relative flex h-full min-w-0 flex-1 items-end">
      {day && <span className={`w-full min-h-px rounded-t-sm ${day.source === "estimated" ? "bg-sky-300 dark:bg-sky-700" : "bg-sky-600 dark:bg-sky-400"}`}
        style={{ height: `${day.used_credits / max * 100}%` }} />}
    </div>);
  }
  return (
    <figure className="mt-2 space-y-1">
      <figcaption className="text-xs font-medium">{copy("limits.customCredits.history")}</figcaption>
      <div className="relative flex h-16 items-end gap-1 border-b border-oai-gray-200 dark:border-oai-gray-700">
        {columns}
        {hasLimit && <span aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-dashed border-amber-500"
          style={{ bottom: `${limit / max * 100}%` }} />}
      </div>
      <div className="flex justify-between text-[10px] tabular-nums text-oai-gray-500">
        <span>{new Date(start).toISOString().slice(5, 10)}</span><span>{keys.at(-1).slice(5)}</span>
      </div>
      <p className="text-[11px] text-oai-gray-500">{copy("limits.customCredits.legend")}{hasLimit && " " + copy("limits.customCredits.reference", { amount: formatter.format(limit) })}</p>
    </figure>
  );
}
