import React, { useEffect, useState } from "react";
import { copy } from "../lib/copy";
import { LIMIT_DISPLAY_MODES } from "../hooks/use-limits-display-prefs.js";

export function accountQuotaWindows(provider, limits) {
  if (!limits || limits.status !== "ok" && !limits.stale) return [];
  if (provider === "claude") return [
    { key: "session", label: copy("accounts.quota.session"), ...limits.five_hour },
    { key: "weekly", label: copy("accounts.quota.weekly"), ...limits.seven_day },
    ...(limits.seven_day_opus ? [{ key: "opus", label: "Opus", ...limits.seven_day_opus }] : []),
    ...(limits.weekly_scoped || []).map((window, index) => ({ key: `model-${index}`, ...window })),
  ].filter((window) => Number.isFinite(window.utilization)).map((window) => ({ ...window, used: window.utilization }));
  return [limits.primary_window, limits.secondary_window].filter(Boolean).filter((window) => Number.isFinite(window.used_percent)).map((window, index) => ({
    ...window, key: String(index), used: window.used_percent,
    label: copy(window.limit_window_seconds >= 604800 ? "accounts.quota.weekly" : window.limit_window_seconds === 18000 ? "accounts.quota.session" : "accounts.quota.period"),
  }));
}

export function AccountQuotaSummary({ provider, limits, displayMode = LIMIT_DISPLAY_MODES.USED }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
  const windows = accountQuotaWindows(provider, limits);
  const showRemaining = displayMode === LIMIT_DISPLAY_MODES.REMAINING;
  const percentageKey = showRemaining ? "accounts.quota.left" : "accounts.quota.consumed";
  if (!windows.length) return null;
  return <div className="space-y-5" aria-label={copy(showRemaining ? "accounts.quota.remaining" : "accounts.quota.used")}>
    {windows.map((window) => {
      const remaining = Math.max(0, Math.min(100, 100 - window.used));
      const displayed = showRemaining ? remaining : 100 - remaining;
      const valueText = copy(percentageKey, { value: new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(displayed) });
      const reset = window.resets_at ?? window.reset_at;
      const resetAt = typeof reset === "number" ? reset * 1000 : Date.parse(reset);
      const expired = Number.isFinite(resetAt) && resetAt <= now;
      const stale = Boolean(limits.stale) || expired;
      return <div key={window.key} className="min-w-0">
        <div className="mb-2 flex items-baseline justify-between gap-4"><p className="truncate text-sm text-oai-gray-600 dark:text-oai-gray-400">{window.label}</p><p className="shrink-0 text-sm font-semibold tabular-nums">{expired ? copy("accounts.quota.updating") : valueText}</p></div>
        <div role="progressbar" aria-label={window.label} {...(expired ? {} : { "aria-valuenow": displayed, "aria-valuemin": 0, "aria-valuemax": 100 })} aria-valuetext={stale ? copy("accounts.quota.cached") : valueText} className="h-1.5 overflow-hidden rounded-full bg-oai-gray-100 dark:bg-oai-gray-800">
          <div className={`h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none ${stale ? "bg-oai-gray-400" : remaining <= 10 ? "bg-red-500" : remaining <= 25 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${expired ? 0 : displayed}%` }} />
        </div>
        {Number.isFinite(resetAt) && <p className="mt-2 text-xs text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.quota.reset", { date: new Date(resetAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) })}</p>}
      </div>;
    })}
  </div>;
}
