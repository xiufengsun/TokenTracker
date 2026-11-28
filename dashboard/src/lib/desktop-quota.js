import { PROVIDER_LIMIT_SPECS } from "../ui/dashboard/components/usage-limits-provider-specs.js";
import { computePace, resetToMs, resolveWindowSeconds } from "./limit-pace.js";

/** Use the dashboard's window definitions; never turn missing usage into zero. */
export function desktopQuotaRows(snapshot) {
  const rows = [];
  for (const [provider, spec] of Object.entries(PROVIDER_LIMIT_SPECS)) {
    const data = snapshot?.[provider];
    if (data?.configured !== true) continue;
    for (const window of spec.windows(data)) {
      const raw = window.window?.[window.pctField || "used_percent"];
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      rows.push({
        id: `${provider}:${window.key}`, provider,
        labelKey: window.labelKey, label: window.label,
        periodSeconds: resolveWindowSeconds(window, window.window),
        periodKey: window.key,
        remaining: 100 - Math.max(0, Math.min(100, raw)),
        resetMs: resetToMs(window.window?.[window.resetField || "reset_at"]),
        stale: Boolean(data.error || data.stale || data.cached || data.provenance?.stale),
      });
    }
  }
  return rows;
}

export function quotaRunout(row, now) {
  if (row.stale || row.remaining <= 0) return null;
  const pace = computePace({
    windowSeconds: row.periodSeconds, resetMs: row.resetMs, now, usedPercent: 100 - row.remaining,
  });
  return pace.paceOver ? pace.runsOutEta : null;
}

export function selectQuotaRows(rows, selected, now = Date.now(), snapshotStale = false) {
  const pinned = selected.map(id => rows.find(row => row.id === id)).filter(Boolean);
  if (selected.length) return pinned;
  const priority = (row) => {
    if (snapshotStale || row.stale || row.resetMs <= now) return 0;
    if (row.remaining <= 10) return 2;
    return quotaRunout(row, now) ? 1 : 0;
  };
  // Providers with an explicit default keep their own window selection.
  const byProvider = new Map();
  for (const row of rows) {
    const preferred = PROVIDER_LIMIT_SPECS[row.provider]?.defaultQuotaKey;
    const current = byProvider.get(row.provider);
    const candidate = { row, priority: priority(row) };
    if (!current || (preferred
      ? row.id === `${row.provider}:${preferred}`
      : candidate.priority > current.priority)) {
      byProvider.set(row.provider, candidate);
    }
  }
  const candidates = [...byProvider.values()];
  const chosen = new Set([...candidates].sort((a, b) => b.priority - a.priority).slice(0, 2));
  // Keep provider positions stable while the same two providers are selected.
  return candidates.filter((candidate) => chosen.has(candidate)).map(({ row }) => row);
}

/** A provider failure must not erase its last known windows or look like a reset. */
export function mergeQuotaSnapshot(previous, incoming) {
  if (!incoming) return previous;
  const result = { ...incoming };
  for (const provider of Object.keys(PROVIDER_LIMIT_SPECS)) {
    const data = incoming[provider];
    if (data?.configured === true && data.error && previous?.[provider]?.configured === true)
      result[provider] = { ...previous[provider], error: data.error, stale: true };
  }
  return result;
}

/** Normalize plain time windows only; preserve model and credit labels. */
export function quotaPeriodLabel(row, locale = "en") {
  if (row.label || !/^(5h|7d|week|weekly|day|month)$/.test(row.periodKey || "")) return null;
  const seconds = row.periodSeconds;
  const unit = seconds ? (seconds % 86400 === 0 ? "day" : "hour") : row.periodKey === "month" ? "month" : null;
  if (!unit) return null;
  const value = seconds ? seconds / (unit === "day" ? 86400 : 3600) : 1;
  return new Intl.NumberFormat(locale || "en", { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 1 }).format(value);
}

/** Countdown is derived only from the provider reset timestamp, never its period. */
export function quotaResetCountdown(resetMs, now, locale = "en") {
  if (!Number.isFinite(resetMs) || resetMs <= now) return null;
  const minutes = Math.ceil((resetMs - now) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const units = days ? [[days, "day"], [hours, "hour"]] : hours ? [[hours, "hour"], [minutes % 60, "minute"]] : [[minutes, "minute"]];
  return units.filter(([value]) => value > 0).map(([value, unit]) => new Intl.NumberFormat(locale || "en", { style: "unit", unit, unitDisplay: "short" }).format(value)).join(" ");
}
