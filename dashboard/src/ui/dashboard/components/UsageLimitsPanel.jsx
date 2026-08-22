import React, { useLayoutEffect, useRef, useState } from "react";
import { Card } from "../../components";
import { FadeIn } from "../../foundation/FadeIn.jsx";
import { copy, getCopyLocale } from "../../../lib/copy";
import { LIMIT_DISPLAY_MODES } from "../../../hooks/use-limits-display-prefs.js";
import {
  LIMIT_PROVIDER_IDS,
  limitProviderIconKey,
  limitProviderName,
} from "../../../lib/limits-providers.js";
import { computePace, resetToMs, resolveWindowSeconds } from "../../../lib/limit-pace.js";
import { ProviderIcon } from "./ProviderIcon.jsx";
import { buildResetBankRows } from "./usage-limits-reset-bank.js";
import { PROVIDER_LIMIT_SPECS } from "./usage-limits-provider-specs.js";
import { HoverTooltip } from "../../components/HoverTooltip.jsx";

const LIMITS_PROVIDER_ICON_CLASS = "shrink-0 text-oai-black dark:text-oai-white";

function formatReset(isoOrUnix) {
  const ts = resetToMs(isoOrUnix);
  if (!Number.isFinite(ts)) return null;
  const diff = ts - Date.now();
  if (diff <= 0) return copy("shared.time.now");
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * In "used" mode a high percentage is bad (lots of quota burned).
 * In "remaining" mode a high percentage is good (lots of quota left), so the
 * red/amber thresholds are mirrored: low remaining = red.
 */
function barColor(displayPct, mode) {
  const pct = mode === LIMIT_DISPLAY_MODES.REMAINING ? 100 - displayPct : displayPct;
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function readWindowPct(window, field = "used_percent") {
  if (!window) return null;
  if (field === "utilization") return window.utilization;
  return window.used_percent;
}

function readWindowReset(window, field = "reset_at") {
  if (!window) return null;
  if (field === "resets_at") return window.resets_at;
  return window.reset_at;
}

function formatPercentValue(value) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  const rounded = Math.round(pct);
  if (pct > 0 && rounded === 0) return copy("limits.bar.sub_one_percent");
  return String(rounded);
}

function formatCreditAmount(
  value,
  { useGrouping = true, maximumFractionDigits } = {},
) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits:
      maximumFractionDigits ?? (n >= 100 ? 0 : 2),
    useGrouping,
  }).format(n);
}

function buildQuotaDetail(window) {
  if (!window || typeof window !== "object") return null;
  if (!(Number(window.limit_credits) > 0)) return null;
  const formatOptions = { useGrouping: window.unit !== "calls" };
  const used = formatCreditAmount(window.used_credits, formatOptions);
  const limit = formatCreditAmount(window.limit_credits, formatOptions);
  const remaining = formatCreditAmount(window.remaining_credits, formatOptions);
  if (!used || !limit || !remaining) return null;
  const key = window.unit === "calls"
    ? "limits.qoder_calls.detail"
    : "limits.codex_credits.detail";
  return copy(key, { used, limit, remaining });
}

/** Pace + projection for one window spec, in the active display mode. */
function paceForSpec(spec, mode) {
  return computePace({
    usedPercent: readWindowPct(spec.window, spec.pctField),
    windowSeconds: resolveWindowSeconds(spec, spec.window),
    resetMs: resetToMs(readWindowReset(spec.window, spec.resetField)),
    mode,
  });
}

function formatExactReset(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat(getCopyLocale(), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

/**
 * Hover detail for one window row: pace verdict + the exact local reset time
 * (the bar itself only shows a compact relative countdown). Credits rows also
 * get the raw used/limit/remaining amounts. Lines joined with \n — the
 * Tooltip renders whitespace-pre-line.
 */
function buildWindowHoverDetail(spec, pace, mode) {
  const lines = [explainLineFor(spec, pace, mode)];
  const resetMs = resetToMs(readWindowReset(spec.window, spec.resetField));
  const exact = formatExactReset(resetMs);
  if (exact) {
    lines.push(copy(spec.timeKind === "expiry" ? "limits.hover.expires_at" : "limits.hover.resets_at", { time: exact }));
  }
  const quota = buildQuotaDetail(spec.window);
  if (quota) lines.push(quota);
  return lines.join("\n");
}

// Shared with the session browser; see ui/components/HoverTooltip.jsx.
const Tooltip = HoverTooltip;

function LimitBar({ label, pct, reset, mode = LIMIT_DISPLAY_MODES.USED, pacePercent = null, paceOver = false, title = null }) {
  const rawUsed = Math.max(0, Math.min(100, Number(pct) || 0));
  const displayPct = mode === LIMIT_DISPLAY_MODES.REMAINING ? 100 - rawUsed : rawUsed;
  const rounded = Math.round(displayPct);
  // Sub-1% still matters (e.g. team pool); keep bar/text from collapsing to 0%.
  const widthPct = displayPct > 0 && rounded === 0 ? Math.max(displayPct, 0.35) : displayPct;
  let labelPct = String(rounded);
  if (displayPct > 0 && rounded === 0) {
    labelPct = copy("limits.bar.sub_one_percent");
  }
  const paceX = pacePercent == null ? null : Math.max(0, Math.min(100, pacePercent));
  return (
    <div className="group relative flex items-center gap-2">
      <Tooltip text={title} />
      <span
        data-limit-label=""
        className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 shrink-0 whitespace-nowrap"
        style={{ width: "var(--tt-limits-label-w)" }}
      >
        {label}
      </span>
      <div className="relative flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1.5 overflow-hidden">
        <div
          className={`${barColor(displayPct, mode)} rounded-full h-full transition-[width] duration-500 ease-out`}
          style={{ width: `${widthPct}%`, minWidth: displayPct > 0 ? "3px" : 0 }}
        />
        {paceX != null && (
          <>
            {/* Notch: a slice of bare track that "cuts" the fill, so the mark reads
                as a marker and stays visible even over a same-colored fill. */}
            <div
              className="absolute top-0 h-full bg-oai-gray-100 dark:bg-oai-gray-700/50"
              style={{ left: `calc(${paceX}% - 3px)`, width: "6px" }}
            />
            <div
              className={`absolute top-0 h-full ${paceOver ? "bg-red-500" : "bg-emerald-500"}`}
              style={{ left: `calc(${paceX}% - 1px)`, width: "2px" }}
            />
          </>
        )}
      </div>
      <span className="text-[11px] tabular-nums text-oai-gray-500 dark:text-oai-gray-400 w-9 text-right shrink-0 whitespace-nowrap">
        {labelPct}%
      </span>
      {reset && (
        <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-500 w-6 text-right shrink-0">{reset}</span>
      )}
    </div>
  );
}

/**
 * One window's explanation line. Adds only what the bar doesn't already show:
 * pace status + a current-rate projection. Used %, reset time live on the bar.
 */
function explainLineFor(spec, pace, mode) {
  const label = spec.label ?? copy(spec.labelKey);
  const remaining = mode === LIMIT_DISPLAY_MODES.REMAINING;
  // In remaining mode every percentage flips to "how much is left".
  const projection = (usedPct) => (remaining ? 100 - usedPct : usedPct);
  // No trusted window length (monthly / billing cycle): just the usage.
  if (pace.expectedPercent == null) {
    const used = Math.max(0, Math.min(100, Number(readWindowPct(spec.window, spec.pctField)) || 0));
    const usedLabel = formatPercentValue(projection(used));
    return remaining
      ? copy("limits.explain.remaining", { label, used: usedLabel })
      : copy("limits.explain.used", { label, used: usedLabel });
  }
  if (pace.paceOver) {
    if (pace.runsOutEta) return copy("limits.explain.ahead_eta", { label, eta: pace.runsOutEta });
    const pct = formatPercentValue(projection(pace.projectedEnd ?? 100));
    return copy(remaining ? "limits.explain.ahead_pct_remaining" : "limits.explain.ahead_pct", { label, pct });
  }
  const used = Math.max(0, Math.min(100, Number(readWindowPct(spec.window, spec.pctField)) || 0));
  const pct = formatPercentValue(projection(pace.projectedEnd ?? used));
  return copy(remaining ? "limits.explain.on_track_remaining" : "limits.explain.on_track", { label, pct });
}

function rowHasPaceMarker({ pace }) {
  return pace.pacePercent != null;
}

function LimitDetail({ rows, mode }) {
  if (rows.length === 0) return null;
  const remaining = mode === LIMIT_DISPLAY_MODES.REMAINING;
  const hasPaceMarker = rows.some(rowHasPaceMarker);
  // No own background or extra horizontal padding: it sits on the expanded
  // group's tint and lines up flush-left with the bars above.
  return (
    <div className="mt-1 flex flex-col gap-1">
      {rows.map(({ spec, pace }) => {
        const exact = formatExactReset(resetToMs(readWindowReset(spec.window, spec.resetField)));
        return (
          <div key={spec.key} className="text-[11px] leading-snug text-oai-gray-600 dark:text-oai-gray-300">
            {explainLineFor(spec, pace, mode)}
            {exact ? (
              <span className="text-oai-gray-400 dark:text-oai-gray-500">
                {" · "}
                {copy(spec.timeKind === "expiry" ? "limits.hover.expires_at" : "limits.hover.resets_at", { time: exact })}
              </span>
            ) : null}
          </div>
        );
      })}
      {hasPaceMarker ? (
        <div className="mt-1 pt-1.5 border-t border-oai-gray-200/70 dark:border-oai-gray-700/50 text-[10.5px] leading-snug text-oai-gray-400 dark:text-oai-gray-500">
          {copy(remaining ? "limits.explain.body_remaining" : "limits.explain.body")}
        </div>
      ) : null}
    </div>
  );
}

function ago(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return null;
  const m = Math.floor(diff / 60000);
  if (m < 1) return copy("shared.time.now");
  if (m < 60) return copy("shared.time.m_ago", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return copy("shared.time.h_ago", { n: h });
  const d = Math.floor(h / 24);
  return copy("shared.time.d_ago", { n: d });
}

const STATUS_BADGE_TONES = {
  live: {
    surface: "bg-oai-gray-50 dark:bg-oai-gray-800 border-oai-gray-200/60 dark:border-oai-gray-700/60 text-oai-gray-500 dark:text-oai-gray-400",
    dot: "bg-emerald-500",
    pulse: "bg-emerald-400",
  },
  stale: {
    surface: "bg-oai-gray-50 dark:bg-oai-gray-800 border-oai-gray-200/60 dark:border-oai-gray-700/60 text-oai-gray-500 dark:text-oai-gray-400",
    dot: "bg-amber-500",
    pulse: "bg-amber-400",
  },
  cached: {
    surface: "bg-oai-gray-50 dark:bg-oai-gray-800 border-oai-gray-200/60 dark:border-oai-gray-700/60 text-oai-gray-500 dark:text-oai-gray-400",
    dot: "bg-amber-500",
    pulse: "bg-amber-400",
  },
};

// CLI to run when a provider's stored OAuth token has expired
// (`auth_action_required: "reauth"` on the provider payload).
const REAUTH_CLI_COMMANDS = {
  claude: "claude",
  codex: "codex",
};

function StatusBadge({ label, age = null, tone = "live", tooltip = null }) {
  const colors = STATUS_BADGE_TONES[tone] || STATUS_BADGE_TONES.live;
  const shouldPulse = tone === "live";
  return (
    <div className="relative inline-flex items-center group cursor-help ml-1" onClick={(e) => e.stopPropagation()}>
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wider border leading-normal ${colors.surface}`}>
        {shouldPulse ? (
          <span className="relative flex h-1.5 w-1.5">
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${colors.pulse} opacity-75`} />
            <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${colors.dot}`} />
          </span>
        ) : (
          <span className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} />
        )}
        {label}{age ? <>&nbsp;·&nbsp;{age}</> : null}
      </span>
      {tooltip ? (
        <span className="pointer-events-none absolute left-1/2 bottom-full z-20 mb-2 -translate-x-1/2 w-48 rounded-md bg-oai-gray-900 dark:bg-oai-gray-800 px-2.5 py-1.5 text-[10px] font-normal text-white text-center opacity-0 scale-95 translate-y-1 group-hover:opacity-100 group-hover:scale-100 group-hover:translate-y-0 transition-all duration-200 cubic-bezier(0.16, 1, 0.3, 1) leading-normal shadow-lg origin-bottom border border-oai-gray-800 dark:border-oai-gray-700">
          {tooltip}
          <span className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-oai-gray-900 dark:border-t-oai-gray-800" />
        </span>
      ) : null}
    </div>
  );
}

function ToolGroup({ name, providerId, children, expandable = false, expanded = false, onToggle, badge = null }) {
  const providerKey = limitProviderIconKey(providerId);
  const header = (
    <div className="flex items-center gap-1.5">
      {providerKey ? (
        <ProviderIcon provider={providerKey} size={14} className={LIMITS_PROVIDER_ICON_CLASS} />
      ) : null}
      <span className="text-sm font-medium text-oai-black dark:text-oai-white">{name}</span>
      {badge}
    </div>
  );

  if (!expandable) {
    return (
      <div className="flex flex-col gap-1.5">
        {header}
        {children}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle?.();
        }
      }}
      className="flex flex-col gap-1.5 -mx-1.5 px-1.5 py-1 rounded-lg cursor-pointer transition-colors hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/40 aria-expanded:bg-oai-gray-50 dark:aria-expanded:bg-oai-gray-800/40"
    >
      {header}
      {children}
    </div>
  );
}

const DEFAULT_ORDER = LIMIT_PROVIDER_IDS;

function StatusLine({ children, tone = "neutral" }) {
  const color =
    tone === "error"
      ? "text-red-600 dark:text-red-400"
      : "text-oai-gray-500 dark:text-oai-gray-400";
  return <div className={`text-[11px] leading-snug ${color}`}>{children}</div>;
}

function LimitWindowSection({ rows, mode, extra = null }) {
  const showEmpty = rows.length === 0 && !extra;
  return (
    <>
      {rows.map(({ spec, pace }) => (
        <LimitBar
          key={spec.key}
          label={spec.label ?? copy(spec.labelKey)}
          pct={readWindowPct(spec.window, spec.pctField)}
          reset={formatReset(readWindowReset(spec.window, spec.resetField))}
          mode={mode}
          pacePercent={pace.pacePercent}
          paceOver={pace.paceOver}
          title={buildWindowHoverDetail(spec, pace, mode)}
        />
      ))}
      {showEmpty ? <StatusLine>{copy("limits.status.no_data")}</StatusLine> : null}
      {extra}
    </>
  );
}

function resetBankHoverDetail(row) {
  if (!Number.isFinite(row.expiresMs)) return null;
  const days = Math.floor((row.expiresMs - Date.now()) / 86400000);
  if (days < 0) return null;
  if (days === 0) return copy("limits.reset_bank.hover_detail_today", { date: row.expiresAt });
  return copy("limits.reset_bank.hover_detail", { date: row.expiresAt, days });
}

function ResetBankRow({ row }) {
  const widthPct = Math.max(0, Math.min(100, Number(row.percent) || 0));
  return (
    <div className="group relative flex items-center gap-2" data-reset-bank-row="">
      <Tooltip text={resetBankHoverDetail(row)} />
      <span
        data-limit-label=""
        className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 shrink-0 whitespace-nowrap"
        style={{ width: "var(--tt-limits-label-w)" }}
      >
        {row.label}
      </span>
      <div className="relative flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1.5 overflow-hidden">
        <div
          className="bg-oai-gray-400 dark:bg-oai-gray-500 rounded-full h-full transition-[width] duration-500 ease-out"
          style={{ width: `${widthPct}%`, minWidth: widthPct > 0 ? "3px" : 0 }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-oai-gray-400 dark:text-oai-gray-500 w-[4.25rem] text-right shrink-0 whitespace-nowrap">
        {row.expiresAt}
      </span>
    </div>
  );
}

function ResetBankSection({ model }) {
  const passiveText = model.kind === "count_only"
    ? copy("limits.codex_reset_bank.count_only", { count: model.availableCount })
    : null;

  return (
    <div className="mt-1 flex flex-col gap-1" data-reset-bank-section={model.kind}>
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-oai-gray-400 dark:text-oai-gray-500">
        {copy("limits.codex_reset_bank.title")}
      </div>
      {passiveText ? (
        <div className="text-[11px] leading-snug text-oai-gray-500 dark:text-oai-gray-400">{passiveText}</div>
      ) : (
        model.rows.map((row) => <ResetBankRow key={row.key} row={row} />)
      )}
    </div>
  );
}

function renderProviderExtra(kind, data) {
  if (kind === "codex_meta") {
    // Credit amounts show on hover (LimitBar's title) instead of an
    // always-visible line, matching the compact menu-bar popover.
    const resetModel = buildResetBankRows(data.reset_credits);
    return resetModel ? <ResetBankSection model={resetModel} /> : null;
  }
  if (kind === "kimi_parallel" && data.parallel_limit) {
    return <StatusLine>{copy("limits.label.kimi_parallel", { count: data.parallel_limit })}</StatusLine>;
  }
  if (
    kind === "kiro_credits" &&
    Number.isFinite(Number(data.tracked_credits)) &&
    Number(data.tracked_credit_records) > 0
  ) {
    const credits = formatCreditAmount(data.tracked_credits, {
      maximumFractionDigits: 2,
    });
    return (
      <StatusLine>
        {copy("limits.label.kiro_tracked_credits", {
          credits,
          count: Number(data.tracked_credit_records),
        })}
      </StatusLine>
    );
  }
  if (kind === "copilot_otel" && !data.otel_has_files && !data.otel_enabled) {
    return <CopilotOtelHint defaultDir={data.otel_default_dir} />;
  }
  return null;
}

function renderConfiguredProvider(id, data, title, mode, expanded, onToggle, badge = null) {
  const spec = PROVIDER_LIMIT_SPECS[id];
  if (!spec) return null;
  // Pace is computed once per window here and shared by the bar + the detail.
  const rows = spec
    .windows(data)
    .filter((s) => s.window)
    .map((s) => ({ spec: s, pace: paceForSpec(s, mode) }));
  const extra = renderProviderExtra(spec.extra, data);
  return (
    <ToolGroup key={id} name={title} providerId={id} expandable={rows.length > 0} expanded={expanded} onToggle={onToggle} badge={badge}>
      <LimitWindowSection mode={mode} rows={rows} extra={extra} />
      {expanded ? <LimitDetail rows={rows} mode={mode} /> : null}
    </ToolGroup>
  );
}

function renderProviderGroup(id, data, mode, expanded, onToggle) {
  if (!PROVIDER_LIMIT_SPECS[id]) return null;
  if (!data?.configured) {
    return (
      <ToolGroup key={id} name={limitProviderName(id)} providerId={id}>
        <StatusLine>{copy("limits.status.not_connected")}</StatusLine>
        {id === "opencodeGo" ? <OpenCodeGoSetupHint /> : null}
        {id === "codingPlan" ? <ArkCodingPlanSetupHint /> : null}
      </ToolGroup>
    );
  }
  if (id === "opencodeGo" && data.subscription_status === "inactive") {
    return (
      <ToolGroup key={id} name={limitProviderName(id)} providerId={id}>
        <StatusLine>{copy("limits.opencodeGo.status.inactive")}</StatusLine>
      </ToolGroup>
    );
  }
  if (data.error) {
    return (
      <ToolGroup key={id} name={limitProviderName(id)} providerId={id}>
        <StatusLine tone="error">{copy("shared.error.prefix", { error: data.error })}</StatusLine>
        {id === "kiro"
          ? renderProviderExtra(PROVIDER_LIMIT_SPECS.kiro.extra, data)
          : null}
        {id === "opencodeGo" ? <OpenCodeGoSetupHint /> : null}
        {id === "codingPlan" ? <ArkCodingPlanSetupHint /> : null}
      </ToolGroup>
    );
  }

  const baseName = limitProviderName(id);
  const title = data.plan_label ? `${baseName} ${data.plan_label}` : baseName;
  let badge = null;
  if (id === "antigravity") {
    if (data.cached) {
      const suffix = ago(data.cached_at);
      badge = <StatusBadge label={copy("limits.label.antigravity_cached")} age={suffix} tone="cached" tooltip={copy("limits.tooltip.antigravity_cached")} />;
    } else {
      badge = <StatusBadge label={copy("limits.label.antigravity_live")} tone="live" tooltip={copy("limits.tooltip.antigravity_live")} />;
    }
  }
  if ((id === "qoder" || id === "qoderCn" || id === "codingPlan") && data.cached) {
    badge = (
      <StatusBadge
        label={copy("limits.label.antigravity_cached")}
        age={ago(data.cached_at)}
        tone="cached"
        tooltip={copy("limits.tooltip.qoder_cached")}
      />
    );
  }
  // An expired sign-in means every live fetch fails the same way and the bars
  // silently freeze on the cached snapshot (issue 330) — more actionable than
  // the generic stale badge below, so it takes precedence.
  if (!badge && data.auth_action_required === "reauth") {
    const command = REAUTH_CLI_COMMANDS[id];
    badge = (
      <StatusBadge
        label={copy("limits.reauth.badge")}
        age={ago(data.cached_at)}
        tone="stale"
        tooltip={command ? copy("limits.reauth.tooltip", { command }) : null}
      />
    );
  }
  const provenance = data.provenance;
  // Fresh data is the norm — flagging it on every provider would fill the
  // panel with a dozen permanently pulsing "Live" badges. Surface provenance
  // only on the exception: data served from a cache that has gone stale.
  // Provider-specific badges (currently Antigravity's cached/live state)
  // already communicate freshness; don't render the same state twice.
  if (provenance?.stale && !badge) {
    badge = <StatusBadge
      label={copy("limits.provenance.stale")}
      age={ago(provenance.captured_at)}
      tone="stale"
      tooltip={copy("limits.provenance.tooltip", { source: provenance.source, confidence: provenance.confidence })}
    />;
  }
  return renderConfiguredProvider(id, data, title, mode, expanded, onToggle, badge);
}

function CopilotOtelHint({ defaultDir }) {
  const [copied, setCopied] = useState(false);
  const dir = defaultDir || "$HOME/.copilot/otel";
  const snippet = [
    "export COPILOT_OTEL_ENABLED=true",
    "export COPILOT_OTEL_EXPORTER_TYPE=file",
    `export COPILOT_OTEL_FILE_EXPORTER_PATH="${dir}/copilot-otel-$(date +%Y%m%d).jsonl"`,
  ].join("\n");

  const onCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (_e) {
      // Clipboard can be unavailable in embedded or restricted contexts.
    }
  };

  return (
    <div className="mt-1 rounded-md border border-amber-300/60 dark:border-amber-700/40 bg-amber-50/50 dark:bg-amber-900/10 px-2.5 py-2 text-[11px] text-oai-gray-600 dark:text-oai-gray-300">
      <div className="font-medium text-oai-gray-700 dark:text-oai-gray-200">{copy("limits.copilot.otelHint.title")}</div>
      <div className="mt-0.5 leading-snug">{copy("limits.copilot.otelHint.body")}</div>
      <pre className="mt-1.5 overflow-x-auto rounded bg-oai-gray-100 dark:bg-oai-gray-900/60 px-2 py-1.5 font-mono text-[10.5px] leading-tight whitespace-pre">{snippet}</pre>
      <button
        type="button"
        onClick={onCopy}
        className="mt-1 inline-flex items-center gap-1 rounded border border-oai-gray-300 dark:border-oai-gray-700 px-1.5 py-0.5 text-[10.5px] text-oai-gray-700 dark:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors"
      >
        {copied ? copy("limits.copilot.otelHint.copied") : copy("limits.copilot.otelHint.copy")}
      </button>
    </div>
  );
}

function HintStep({ n, children }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-oai-brand/15 text-[9px] font-semibold text-oai-brand">
        {n}
      </span>
      <div className="min-w-0 flex-1 leading-snug">{children}</div>
    </li>
  );
}

function ExternalArrow() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 2.75h4.75V7.5M9.25 2.75 3 9" />
    </svg>
  );
}

// OpenCode Go limits come from OpenCode's official authenticated usage API
// (GET /zen/go/v1/usage, Bearer OPENCODE_GO_API_KEY) once the user subscribes.
// The macOS/Windows apps have no settings field for it yet, so this inline
// guide shows up wherever OpenCode Go is enabled but unconfigured (or errored):
// sign in, create an API key in the console, paste it into a copyable command.
// No credential ever passes through TokenTracker itself.
function OpenCodeGoSetupHint() {
  const [copied, setCopied] = useState(false);
  const snippet = [
    "read -r -s OPENCODE_GO_API_KEY",
    "export OPENCODE_GO_API_KEY",
    'launchctl setenv OPENCODE_GO_API_KEY "$OPENCODE_GO_API_KEY"',
  ].join("\n");

  const onCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (_e) {
      // Clipboard can be unavailable in embedded or restricted contexts.
    }
  };

  return (
    <div className="mt-1.5 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700/60 bg-oai-gray-50/50 dark:bg-oai-gray-900/20 p-3 text-[11px] text-oai-gray-600 dark:text-oai-gray-300">
      <div className="text-[12px] font-semibold text-oai-gray-800 dark:text-oai-gray-100">{copy("limits.opencodeGo.setupHint.title")}</div>
      <div className="mt-0.5 leading-snug text-oai-gray-500 dark:text-oai-gray-400">{copy("limits.opencodeGo.setupHint.subtitle")}</div>

      <ol className="mt-2.5 space-y-2.5">
        <HintStep n="1">
          <div>{copy("limits.opencodeGo.setupHint.step1")}</div>
          <a
            href="https://opencode.ai"
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-1 inline-flex items-center gap-1 rounded-md bg-oai-brand/10 px-2 py-1 font-medium text-oai-brand hover:bg-oai-brand/15 transition-colors"
          >
            {copy("limits.opencodeGo.setupHint.cta")}
            <ExternalArrow />
          </a>
        </HintStep>
        <HintStep n="2">
          <div>{copy("limits.opencodeGo.setupHint.step2")}</div>
        </HintStep>
        <HintStep n="3">
          <div className="flex items-center gap-2">
            <span>{copy("limits.opencodeGo.setupHint.step3")}</span>
            <button
              type="button"
              onClick={onCopy}
              className="shrink-0 rounded-md border border-oai-gray-300 dark:border-oai-gray-700 px-2 py-0.5 text-[10.5px] text-oai-gray-700 dark:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors"
            >
              {copied ? copy("limits.opencodeGo.setupHint.copied") : copy("limits.opencodeGo.setupHint.copy")}
            </button>
          </div>
          <pre className="mt-1.5 overflow-x-auto rounded-md bg-oai-gray-100 dark:bg-oai-gray-900/60 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre">{snippet}</pre>
          <div className="mt-1 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">{copy("limits.opencodeGo.setupHint.note_app")}</div>
        </HintStep>
      </ol>
    </div>
  );
}

// Ark Coding Plan (火山方舟) quota comes from the official Ark CLI (arkcli)
// running on this machine — there is no public quota endpoint, so the CLI is
// feature-detected at fetch time. When it is missing (or not signed in) the
// provider reports `configured: false` and this inline guide shows how to
// enable it, mirroring the OpenCode Go flow.
function ArkCodingPlanSetupHint() {
  const [copied, setCopied] = useState(false);
  const snippet = [
    "npm install -g @volcengine/ark-cli",
    "arkcli auth login volc-sso   # browser SSO (recommended)",
    "arkcli auth status           # verify the session",
  ].join("\n");

  const onCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (_e) {
      // Clipboard can be unavailable in embedded or restricted contexts.
    }
  };

  return (
    <div className="mt-1.5 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700/60 bg-oai-gray-50/50 dark:bg-oai-gray-900/20 p-3 text-[11px] text-oai-gray-600 dark:text-oai-gray-300">
      <div className="text-[12px] font-semibold text-oai-gray-800 dark:text-oai-gray-100">{copy("limits.codingPlan.setupHint.title")}</div>
      <div className="mt-0.5 leading-snug text-oai-gray-500 dark:text-oai-gray-400">{copy("limits.codingPlan.setupHint.subtitle")}</div>

      <ol className="mt-2.5 space-y-2.5">
        <HintStep n="1">
          <div>{copy("limits.codingPlan.setupHint.step1")}</div>
          <a
            href="https://www.volcengine.com/docs/82379/2536875"
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-1 inline-flex items-center gap-1 rounded-md bg-oai-brand/10 px-2 py-1 font-medium text-oai-brand hover:bg-oai-brand/15 transition-colors"
          >
            {copy("limits.codingPlan.setupHint.cta")}
            <ExternalArrow />
          </a>
        </HintStep>
        <HintStep n="2">
          <div>{copy("limits.codingPlan.setupHint.step2")}</div>
          <div className="mt-0.5 text-oai-gray-500 dark:text-oai-gray-400">{copy("limits.codingPlan.setupHint.step2_remote")}</div>
        </HintStep>
        <HintStep n="3">
          <div className="flex items-center gap-2">
            <span>{copy("limits.codingPlan.setupHint.step3")}</span>
            <button
              type="button"
              onClick={onCopy}
              className="shrink-0 rounded-md border border-oai-gray-300 dark:border-oai-gray-700 px-2 py-0.5 text-[10.5px] text-oai-gray-700 dark:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors"
            >
              {copied ? copy("limits.codingPlan.setupHint.copied") : copy("limits.codingPlan.setupHint.copy")}
            </button>
          </div>
          <pre className="mt-1.5 overflow-x-auto rounded-md bg-oai-gray-100 dark:bg-oai-gray-900/60 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre">{snippet}</pre>
          <div className="mt-1 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">{copy("limits.codingPlan.setupHint.note_app")}</div>
        </HintStep>
      </ol>
    </div>
  );
}

/**
 * Width of the widest rendered row label, so every label column matches it.
 * Mirrors the macOS popover behavior: bars stay aligned without reserving
 * space for labels that aren't on screen, and longer labels (Spark,
 * localized strings) still fit without truncation.
 */
function useWidestLabelWidth(containerRef) {
  const [labelWidth, setLabelWidth] = useState(0);
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const labels = root.querySelectorAll("[data-limit-label]");
    let max = 0;
    let ctx = null;
    if (labels.length > 0) {
      try {
        ctx = document.createElement("canvas").getContext("2d");
      } catch (_e) {
        ctx = null;
      }
    }
    if (ctx) {
      const style = window.getComputedStyle(labels[0]);
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      for (const el of labels) {
        max = Math.max(max, ctx.measureText(el.textContent).width);
      }
    }
    const next = Math.ceil(max);
    setLabelWidth((prev) => (prev === next ? prev : next));
  });
  return labelWidth;
}

export function UsageLimitsPanel({ claude, codex, cursor, gemini, kimi, kiro, grok, antigravity, copilot, zcode, opencodeGo, qoder, qoderCn, codingPlan, order, visibility, displayMode }) {
  const dataById = { claude, codex, cursor, gemini, kimi, kiro, grok, antigravity, copilot, zcode, opencodeGo, qoder, qoderCn, codingPlan };
  const containerRef = useRef(null);
  const labelWidth = useWidestLabelWidth(containerRef);
  const [expandedId, setExpandedId] = useState(null);
  const effectiveOrder = Array.isArray(order) && order.length > 0 ? order : DEFAULT_ORDER;
  const effectiveMode = displayMode === LIMIT_DISPLAY_MODES.REMAINING
    ? LIMIT_DISPLAY_MODES.REMAINING
    : LIMIT_DISPLAY_MODES.USED;
  const modeLabel = effectiveMode === LIMIT_DISPLAY_MODES.REMAINING
    ? copy("limits.settings.display_mode_remaining")
    : copy("limits.settings.display_mode_used");

  const groups = effectiveOrder
    .filter((id) => !visibility || visibility[id] !== false)
    .map((id) =>
      renderProviderGroup(
        id,
        dataById[id],
        effectiveMode,
        expandedId === id,
        () => setExpandedId((prev) => (prev === id ? null : id)),
      ),
    )
    .filter(Boolean);

  return (
    <FadeIn delay={0.15}>
      <Card>
        <div
          ref={containerRef}
          className="flex flex-col gap-3"
          style={labelWidth > 0 ? { "--tt-limits-label-w": `${labelWidth}px` } : undefined}
        >
          <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
            {copy("limits.panel.title")}{copy("limits.panel.mode_separator")}{modeLabel}
          </h3>
          {groups.length > 0 ? groups : <StatusLine>{copy("limits.status.all_hidden")}</StatusLine>}
        </div>
      </Card>
    </FadeIn>
  );
}
