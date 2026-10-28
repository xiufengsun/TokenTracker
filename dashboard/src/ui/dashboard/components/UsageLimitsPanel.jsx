import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertCircle, ChevronDown, Gift, Clock as ClockIcon, Infinity as InfinityIcon } from "lucide-react";
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
import { cycleView, countdownText, remainingLabel } from "../../../lib/subscription-display.js";
import { saveProviderApiKey } from "../../../lib/api";

const LIMITS_PROVIDER_ICON_CLASS = "shrink-0 text-oai-black dark:text-oai-white";

const PROVIDER_KEY_ENV = {
  opencodeGo: "OPENCODE_GO_API_KEY",
  commandCode: "COMMAND_CODE_API_KEY",
};

const PROVIDER_KEY_STORE_ID = {
  opencodeGo: "opencode-go",
  commandCode: "command-code",
};

function commandCodeSetupPlatform() {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  return /Windows/i.test(ua) ? "windows" : /Linux/i.test(ua) ? "linux" : "macos";
}

function commandCodeLoginSnippet() {
  return commandCodeSetupPlatform() === "windows"
    ? copy("limits.commandCode.setupHint.snippet_login_windows")
    : copy("limits.commandCode.setupHint.snippet_login");
}

// `devin auth login` is registry-owned (limits.devin.setupHint.snippet_login)
// so the setup guide and the reauth tooltip share one source of truth.
function devinLoginSnippet() {
  return copy("limits.devin.setupHint.snippet_login");
}

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

function buildQuotaDetail(window, maximumFractionDigits) {
  if (!window || typeof window !== "object") return null;
  if (!(Number(window.limit_credits) > 0)) return null;
  const formatOptions = { useGrouping: window.unit !== "calls", maximumFractionDigits };
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
function paceForSpec(spec, mode, now) {
  return computePace({
    usedPercent: readWindowPct(spec.window, spec.pctField),
    windowSeconds: resolveWindowSeconds(spec, spec.window),
    resetMs: resetToMs(readWindowReset(spec.window, spec.resetField)),
    mode,
    now,
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
  const quota = buildQuotaDetail(spec.window, spec.creditPrecision);
  if (quota) lines.push(quota);
  return lines.join("\n");
}

// Shared with the session browser; see ui/components/HoverTooltip.jsx.
const Tooltip = HoverTooltip;

// Slices of a segmented pool bar share the pool's threshold hue and fade per
// product in API order, like grok.com's usage bar.
const SEGMENT_OPACITIES = [1, 0.65, 0.45, 0.3, 0.2];

function segmentOpacity(index) {
  return SEGMENT_OPACITIES[Math.min(index, SEGMENT_OPACITIES.length - 1)];
}

function PaceMarker({ paceX, paceOver }) {
  return (
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
  );
}

function LimitBar({ label, pct, reset, mode = LIMIT_DISPLAY_MODES.USED, pacePercent = null, paceOver = false, title = null, segments = null }) {
  const rawUsed = Math.max(0, Math.min(100, Number(pct) || 0));
  const displayPct = mode === LIMIT_DISPLAY_MODES.REMAINING ? 100 - rawUsed : rawUsed;
  const fillColor = barColor(displayPct, mode);
  const rounded = Math.round(displayPct);
  // Sub-1% still matters (e.g. team pool); keep bar/text from collapsing to 0%.
  const widthPct = displayPct > 0 && rounded === 0 ? Math.max(displayPct, 0.35) : displayPct;
  let labelPct = String(rounded);
  if (displayPct > 0 && rounded === 0) {
    labelPct = copy("limits.bar.sub_one_percent");
  }
  const paceX = pacePercent == null ? null : Math.max(0, Math.min(100, pacePercent));
  const segmentWeights = segments?.map((segment) => Math.max(0, Math.min(100, Number(segment.pct) || 0)));
  const segmentTotal = segmentWeights?.reduce((sum, pct) => { return sum + pct; }, 0) || 0;
  const unallocatedUsedWeight = segments ? Math.max(0, rawUsed - segmentTotal) : 0;
  const remainingWeight = Math.max(0, 100 - segmentTotal - unallocatedUsedWeight);
  return (
    <div className="group relative flex items-center gap-2">
      <Tooltip text={title} />
      <span
        data-limit-label=""
        className="text-xs sm:text-sm text-oai-gray-500 dark:text-oai-gray-400 shrink-0 whitespace-nowrap"
        style={{ width: "var(--tt-limits-label-w)" }}
      >
        {label}
      </span>
      {segments ? (
        <div data-limit-segments="" className="relative flex min-w-0 flex-1 h-1.5 overflow-hidden" style={{ gap: "min(2px, 1%)" }}>
          {segments.map((segment, index) => (
            <div
              key={segment.key}
              data-limit-segment={segment.key}
              className={`${fillColor} min-w-0 rounded-full h-full transition-[flex-grow] duration-500 ease-out`}
              style={{
                flex: `${segmentWeights[index]} 1 0px`,
                opacity: segmentOpacity(index),
              }}
            />
          ))}
          {unallocatedUsedWeight ? <div data-limit-unallocated-used="" className={`${fillColor} min-w-0 rounded-full h-full`} style={{ flex: `${unallocatedUsedWeight} 1 0px`, opacity: segmentOpacity(segments.length) }} /> : null}
          {remainingWeight ? <div data-limit-remainder="" className="min-w-0 rounded-full h-full bg-oai-gray-100 dark:bg-oai-gray-700/50" style={{ flex: `${remainingWeight} 1 0px` }} /> : null}
          {paceX != null && <PaceMarker paceX={paceX} paceOver={paceOver} />}
        </div>
      ) : (
        <div className="relative min-w-0 flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1.5 overflow-hidden">
          <div
            className={`${fillColor} rounded-full h-full transition-[width] duration-500 ease-out`}
            style={{ width: `${widthPct}%`, minWidth: displayPct > 0 ? "3px" : 0 }}
          />
          {paceX != null && <PaceMarker paceX={paceX} paceOver={paceOver} />}
        </div>
      )}
      <span className="text-xs sm:text-sm tabular-nums text-oai-gray-600 dark:text-oai-gray-300 w-11 text-right shrink-0 whitespace-nowrap">
        {labelPct}%
      </span>
      {reset && (
        <span className="text-xs tabular-nums text-oai-gray-400 dark:text-oai-gray-500 w-8 text-right shrink-0">{reset}</span>
      )}
    </div>
  );
}

/** Dot + name + share for each slice of a segmented bar, aligned under the bar. */
function LimitSegmentLegend({ segments, fillColor }) {
  return (
    <div
      data-limit-legend=""
      className="-mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] leading-snug"
      style={{ paddingLeft: "calc(var(--tt-limits-label-w, 0px) + 0.5rem)" }}
    >
      {segments.map((segment, index) => (
        <span key={segment.key} className="inline-flex items-center gap-1 whitespace-nowrap">
          <span
            aria-hidden
            className={`${fillColor} inline-block h-1.5 w-1.5 shrink-0 rounded-full`}
            style={{ opacity: segmentOpacity(index) }}
          />
          <span className="text-oai-gray-500 dark:text-oai-gray-400">{segment.label ?? copy(segment.labelKey)}</span>
          <span className="tabular-nums text-oai-gray-700 dark:text-oai-gray-200">{formatPercentValue(segment.pct)}%</span>
        </span>
      ))}
    </div>
  );
}

/**
 * One window's explanation line. Adds only what the bar doesn't already show:
 * pace status + a current-rate projection. Used %, reset time live on the bar.
 */
function explainLineFor(spec, pace, mode) {
  const label = spec.label ?? copy(spec.labelKey);
  // In remaining mode every percentage flips to "how much is left".
  const remaining = mode === LIMIT_DISPLAY_MODES.REMAINING;
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

/** The footnote explains the pace marker, so it follows the rows that draw one. */
function paceFootnoteRemaining(rows, mode) {
  return rows.some((row) => rowHasPaceMarker(row) && (row.mode ?? mode) === LIMIT_DISPLAY_MODES.REMAINING);
}

function LimitDetail({ rows, mode, now = Date.now() }) {
  if (rows.length === 0) return null;
  const remaining = paceFootnoteRemaining(rows, mode);
  const hasPaceMarker = rows.some(rowHasPaceMarker);
  // No own background or extra horizontal padding: it sits on the expanded
  // group's tint and lines up flush-left with the bars above.
  return (
    <div className="mt-1 flex flex-col gap-1">
      {rows.map(({ spec, pace, mode: rowMode = mode }) => {
        const exact = formatExactReset(resetToMs(readWindowReset(spec.window, spec.resetField)));
        return (
          <div key={spec.key} className="text-[11px] leading-snug text-oai-gray-600 dark:text-oai-gray-300">
            {explainLineFor(spec, pace, rowMode)}
            {exact ? (
              <span className="text-oai-gray-400 dark:text-oai-gray-500">
                {" · "}
                {copy(spec.timeKind === "expiry" ? "limits.hover.expires_at" : "limits.hover.resets_at", { time: exact })}
              </span>
            ) : null}
            {spec.showCreditDetail ? (
              <div>{buildQuotaDetail(spec.window, spec.creditPrecision)}</div>
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
// (`auth_action_required: "reauth"` on the provider payload). Claude and Codex
// reauth with the bare binary; Command Code reauths with `cmd login`, which is
// registry-owned (limits.commandCode.setupHint.snippet_login) so the tooltip
// and the setup guide stay in sync.
const REAUTH_CLI_COMMANDS = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
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

function ToolGroup({ name, providerId, children, expandable = false, expanded = false, onToggle, badge = null, rightAdornment = null, toggleOnHeader = false }) {
  const providerKey = limitProviderIconKey(providerId);
  const header = (
    <div className="flex min-w-0 items-center gap-3">
      {providerKey ? (
        <ProviderIcon provider={providerKey} size={22} className={LIMITS_PROVIDER_ICON_CLASS} />
      ) : null}
      <span className="text-base font-semibold text-oai-black dark:text-oai-white">{name}</span>
      {rightAdornment ? <span className="shrink-0">{rightAdornment}</span> : null}
      {badge}
    </div>
  );
  const cardClass = "rounded-xl border border-oai-gray-200 bg-white dark:border-oai-gray-800 dark:bg-oai-gray-900";
  const headerClass = "flex w-full items-center justify-between gap-3 border-b border-oai-gray-200 px-4 py-4 text-left dark:border-oai-gray-800 sm:px-5";
  const body = <div className="flex flex-col gap-2 px-4 py-4 sm:px-5">{children}</div>;

  if (!expandable) {
    return <div className={cardClass}><div className={headerClass}>{header}</div>{body}</div>;
  }

  if (toggleOnHeader) {
    return (
      <div className={cardClass}>
        <button type="button" aria-expanded={expanded} onClick={onToggle}
          className={`${headerClass} rounded-t-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500`}>
          {header}
          <ChevronDown size={16} aria-hidden className={`shrink-0 text-oai-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
        {body}
      </div>
    );
  }

  return (
    <div role="button" tabIndex={0} aria-expanded={expanded} onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle?.();
        }
      }}
      className={`${cardClass} cursor-pointer transition-colors hover:border-oai-gray-300 dark:hover:border-oai-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500`}>
      <div className={headerClass}>
        {header}
        <ChevronDown size={16} aria-hidden className={`shrink-0 text-oai-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </div>
      {body}
    </div>
  );
}

// Top-right auto-renew / stops-at-expiry badge. Distinct from the left-aligned
// data-status badge so antigravity/qoder cache state and subscription state can
// both show on the same row.
// Icon-only state badge: shape and color carry the state (infinity = keeps
// renewing, clock = ends at expiry), so the pill's text is no longer needed.
// The original wording stays available through the hover tooltip and
// aria-label, and the two shapes remain distinguishable without color.
function SubscriptionRightBadge({ subscription }) {
  const label = subscription.autoRenew
    ? copy("subscriptions.badge.auto_renew")
    : copy("subscriptions.badge.stops");
  const Icon = subscription.autoRenew ? InfinityIcon : ClockIcon;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex translate-y-px ${
        subscription.autoRenew
          ? "text-oai-brand-600 dark:text-oai-brand-400"
          : "text-blue-600 dark:text-blue-400"
      }`}
    >
      <Icon size={14} strokeWidth={2} aria-hidden />
    </span>
  );
}

// Inline subscription progress bar, rendered under the limit bars of a linked
// provider. Reuses the same label column width as the limit bars so their
// tracks line up, and mirrors the limit bar's pct + reset columns on the right.
// When displayMode is "remaining", the bar flips to show remaining cycle time
// (100 - elapsed), matching the limits panel's remaining mode.
function SubscriptionBar({ subscription, now, mode = LIMIT_DISPLAY_MODES.USED }) {
  const view = cycleView(subscription, now);
  if (!view) return null;
  const { endMs, expired } = view;
  const nearExpiry = !expired && endMs - now <= 3 * 86400000;
  const rawPct = expired ? 100 : view.progress * 100;
  const displayPct = mode === LIMIT_DISPLAY_MODES.REMAINING ? 100 - rawPct : rawPct;
  // Clamp and keep the bar visible for <1% remaining/used
  const renderWidth = expired ? 100 : Math.max(0, Math.min(100, displayPct));
  const rounded = Math.round(renderWidth);
  const labelPct =
    renderWidth > 0 && rounded === 0 ? copy("limits.bar.sub_one_percent") : `${rounded}%`;
  return (
    <div className="flex items-center gap-2">
      <span
        className="text-xs sm:text-sm text-oai-gray-500 dark:text-oai-gray-400 shrink-0 whitespace-nowrap"
        style={{ width: "var(--tt-limits-label-w)" }}
      >
        {copy("subscriptions.inline.label")}
      </span>
      <div className="relative min-w-0 flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1.5 overflow-hidden">
        <div
          className={`${
            expired ? "bg-red-500" : nearExpiry ? "bg-amber-500" : "bg-blue-500"
          } rounded-full h-full block motion-safe:transition-[width] motion-safe:duration-500 ease-out motion-reduce:transition-none`}
          style={{ width: `${renderWidth}%`, minWidth: renderWidth > 0 ? "3px" : 0 }}
        />
      </div>
      <span className="text-xs sm:text-sm tabular-nums text-oai-gray-600 dark:text-oai-gray-300 w-11 text-right shrink-0 whitespace-nowrap">
        {labelPct}
      </span>
      <span
        className={`text-xs tabular-nums shrink-0 whitespace-nowrap w-8 text-right ${
          expired ? "text-oai-error" : "text-oai-gray-400 dark:text-oai-gray-500"
        }`}
      >
        {remainingLabel(endMs, now)}
      </span>
    </div>
  );
}

function SubscriptionDetail({ subscription, now }) {
  const view = cycleView(subscription, now);
  if (!view) return null;
  const dateFormat = new Intl.DateTimeFormat(getCopyLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className="text-[11px] leading-snug text-oai-gray-500 dark:text-oai-gray-400">
      <span>{copy("subscriptions.inline.label")}</span>
      <span className="text-oai-gray-300 dark:text-oai-gray-600">：</span>
      <span>
        {subscription.autoRenew
          ? copy("subscriptions.label.renews_at")
          : copy("subscriptions.label.expires_at")}
      </span>
      <span> </span>
      <span className="font-mono tabular-nums">
        {dateFormat.format(new Date(view.endMs))}
      </span>
      <span className="text-oai-gray-300 dark:text-oai-gray-600"> · </span>
      <span className={view.expired ? "text-oai-error" : undefined}>
        {countdownText(view.endMs, now)}
      </span>
      <span className="text-oai-gray-300 dark:text-oai-gray-600"> · </span>
      <span>
        {subscription.autoRenew
          ? copy("subscriptions.status.auto_renew")
          : copy("subscriptions.status.manual")}
      </span>
    </div>
  );
}

const DEFAULT_ORDER = LIMIT_PROVIDER_IDS;

function StatusLine({ children, tone = "neutral" }) {
  if (tone === "error") {
    return (
      <div className="flex items-start gap-2 text-xs leading-relaxed text-oai-gray-600 dark:text-oai-gray-300">
        <AlertCircle size={15} aria-hidden className="mt-0.5 shrink-0 text-red-500 dark:text-red-400" />
        <span className="min-w-0 break-words">{children}</span>
      </div>
    );
  }
  return <div className="text-[11px] leading-snug text-oai-gray-500 dark:text-oai-gray-400">{children}</div>;
}

function LimitWindowSection({ rows, mode, extra = null, expanded = false }) {
  const showEmpty = rows.length === 0 && !extra;
  return (
    <>
      {rows.map(({ spec, pace, mode: rowMode = mode }) => {
        const pct = readWindowPct(spec.window, spec.pctField);
        // Product shares are detail. Collapsed shows the whole pool. Expanding
        // lists each share. The stacked bar is the used orientation only:
        // in remaining mode the fill is what's left, and the shares stay in
        // the legend because they are points of the amount used.
        const hasShareSegments = expanded && spec.productPool && Array.isArray(spec.segments) && spec.segments.length !== 0;
        const shareSegments = hasShareSegments ? spec.segments : null;
        const barSegments = shareSegments && rowMode !== LIMIT_DISPLAY_MODES.REMAINING ? shareSegments : null;
        return (
          <React.Fragment key={spec.key}>
            <LimitBar
              label={spec.label ?? copy(spec.labelKey)}
              pct={pct}
              reset={formatReset(readWindowReset(spec.window, spec.resetField))}
              mode={rowMode}
              segments={barSegments}
              pacePercent={pace.pacePercent}
              paceOver={pace.paceOver}
              title={buildWindowHoverDetail(spec, pace, rowMode)}
            />
            {shareSegments ? (
              <>
                <LimitSegmentLegend segments={shareSegments} fillColor={barColor(pct, LIMIT_DISPLAY_MODES.USED)} />
                {rowMode === LIMIT_DISPLAY_MODES.REMAINING ? (
                  <div
                    data-limit-share-note=""
                    className="-mt-0.5 text-[11px] leading-snug text-oai-gray-400 dark:text-oai-gray-500"
                    style={{ paddingLeft: "calc(var(--tt-limits-label-w, 0px) + 0.5rem)" }}
                  >
                    {copy("limits.grok.shares_are_used")}
                  </div>
                ) : null}
              </>
            ) : null}
          </React.Fragment>
        );
      })}
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
      <div className="relative min-w-0 flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1.5 overflow-hidden">
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

// Countdown bar scale per group (issue 888 R2): ZCode reset cards carry only
// expires_at (no grant time), so the bar shows "time until the earliest live
// card expires" against a fixed scale of one window per group — cards align to
// window boundaries, so the earliest card never exceeds it and anything beyond
// clips at 100%. A larger scale would pin bars near empty and read as false
// urgency. Keep in sync with the menu-bar popover (UsageLimitsView.swift
// zcodeFiveHourResetCountdownScale / zcodeWeeklyResetCountdownScale).
const ZCODE_RESET_COUNTDOWN_SCALES_MS = {
  five_hour: 5 * 3600 * 1000,
  weekly: 7 * 24 * 3600 * 1000,
};

function ZcodeResetBankSection({ data }) {
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const groups = [
    { key: "five_hour", label: copy("limits.label.zcode_5h") },
    { key: "weekly", label: copy("limits.label.zcode_weekly") },
  ].map((group) => {
    const cards = (data[group.key] || [])
      .filter((card) => Date.parse(card.expires_at) > now)
      .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
    // The inventory is issued in batches that share one expiry instant, so the
    // hover title collapses same-instant repeats into "time ×count" (issue 888).
    const batchCounts = new Map();
    for (const card of cards) {
      const ms = Date.parse(card.expires_at);
      batchCounts.set(ms, (batchCounts.get(ms) || 0) + 1);
    }
    const batches = [...batchCounts.entries()].sort((a, b) => a[0] - b[0]);
    const batchTitle = batches
      .map(([ms, n]) => (n > 1
        ? copy("limits.zcode.reset_bank.batch", { time: formatExactReset(ms), count: n })
        : formatExactReset(ms)))
      .join("\n");
    const scale = ZCODE_RESET_COUNTDOWN_SCALES_MS[group.key] || 0;
    const countdownPercent =
      cards.length && scale
        ? Math.max(0, Math.min(100, ((Date.parse(cards[0].expires_at) - now) / scale) * 100))
        : 0;
    return { ...group, cards, batchTitle, countdownPercent };
  });
  // A plain loop, not `reduce`: an unbraced arrow body would let the
  // ui-hardcode scanner's `>...<` regex read this line as raw JSX text.
  let totalLive = 0;
  const liveGroups = [];
  for (const group of groups) {
    totalLive += group.cards.length;
    if (group.cards.length) liveGroups.push(group);
  }
  // Mirror the Codex reset bank (`buildResetBankRows`): a clean zero inventory
  // renders nothing, and the expanded body drops zero-count window rows. A
  // fetch failure keeps the section up so the error cannot hide (issue 888).
  if (!totalLive && !data.error) return null;
  return (
    <div className="mt-2 border-t border-oai-gray-200/60 pt-2 dark:border-oai-gray-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
        onKeyDown={(event) => event.stopPropagation()}
        className="flex w-full items-center gap-1.5 rounded text-xs text-oai-gray-500 transition-colors hover:text-oai-gray-800 dark:text-oai-gray-400 dark:hover:text-oai-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
      >
        <ClockIcon size={13} aria-hidden />
        <span className="min-w-0 truncate">{copy("limits.zcode.reset_bank.title")}</span>
        {totalLive ? (
          <span className="rounded-full bg-oai-gray-100 px-2 py-0.5 text-[10px] tabular-nums text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300">
            {copy("limits.zcode.reset_bank.count", { count: totalLive })}
          </span>
        ) : null}
        <ChevronDown size={13} aria-hidden className={`ml-auto transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {/* A failed inventory fetch stays visible above the collapsible body even
          while the section is collapsed, so it cannot hide behind the toggle. */}
      {data.error ? (
        <StatusLine tone="error">{data.error}</StatusLine>
      ) : null}
      {open && !data.error ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {liveGroups.map((group) => (
            <div key={group.key} className="flex items-center gap-2 text-[11px]">
              <span
                data-limit-label=""
                className="shrink-0 whitespace-nowrap text-oai-gray-500 dark:text-oai-gray-400"
                style={{ width: "var(--tt-limits-label-w)" }}
              >
                {group.label}
              </span>
              <span className="rounded-full bg-oai-gray-100 px-2 py-0.5 tabular-nums text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300">
                {copy("limits.zcode.reset_bank.count", { count: group.cards.length })}
              </span>
              <div
                className="relative min-w-0 flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1.5 overflow-hidden"
                title={group.batchTitle}
              >
                <div
                  className="bg-oai-gray-400 dark:bg-oai-gray-500 rounded-full h-full transition-[width] duration-500 ease-out"
                  style={{ width: `${group.countdownPercent}%`, minWidth: group.countdownPercent > 0 ? "3px" : 0 }}
                />
              </div>
              {group.cards.length ? (
                <span
                  className="ml-auto shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums text-oai-gray-400 dark:text-oai-gray-500"
                  title={group.batchTitle}
                >
                  {copy("limits.zcode.reset_bank.earliest", { time: formatExactReset(Date.parse(group.cards[0].expires_at)) })}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function renderProviderExtra(kind, data) {
  if (kind === "zcode_reset_bank") {
    return data.reset_credits ? <ZcodeResetBankSection data={data.reset_credits} /> : null;
  }
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

function ZcodeStartPlanSection({ data, mode, now }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const labelWidth = useWidestLabelWidth(containerRef);
  const planNames = [...new Set((data.buckets || []).map((bucket) => bucket.plan_name).filter(Boolean))];
  const title = planNames.length ? planNames.join(" · ") : copy("limits.zcode.start_grants");
  const rows = PROVIDER_LIMIT_SPECS.zcode.windows(data)
    .filter((s) => s.window)
    .map((s) => ({ spec: s, pace: paceForSpec(s, mode, now) }));
  return (
    <div className="mt-2 border-t border-oai-gray-200/60 pt-2 dark:border-oai-gray-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
        onKeyDown={(event) => event.stopPropagation()}
        className="flex w-full items-center gap-1.5 rounded text-xs text-oai-gray-500 transition-colors hover:text-oai-gray-800 dark:text-oai-gray-400 dark:hover:text-oai-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
      >
        <Gift size={13} aria-hidden />
        <span className="min-w-0 truncate" title={title}>{title}</span>
        <ChevronDown size={13} aria-hidden className={`ml-auto transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          ref={containerRef}
          data-limit-label-group=""
          className="mt-2 flex flex-col gap-1.5"
          style={labelWidth > 0 ? { "--tt-limits-label-w": `${labelWidth}px` } : undefined}
        >
          {data.error ? (
            <StatusLine tone="error">{data.error}</StatusLine>
          ) : (
            <>
              <LimitWindowSection rows={rows} mode={mode} />
              <LimitDetail rows={rows} mode={mode} now={now} />
              {(data.buckets || []).filter((bucket) => Number.isFinite(bucket.remaining_units) && Number.isFinite(bucket.total_units)).map((bucket, index) => (
                <div key={bucket.entitlement_id || index} className="text-[10px] text-oai-gray-400 dark:text-oai-gray-500">
                  {copy("limits.zcode.grant_amount", {
                    remaining: bucket.remaining_units.toLocaleString(getCopyLocale()),
                    total: bucket.total_units.toLocaleString(getCopyLocale()),
                  })}
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function renderConfiguredProvider(id, data, title, mode, expanded, onToggle, badge = null, subscription = null, now = Date.now(), onKeySaved = null) {
  const spec = PROVIDER_LIMIT_SPECS[id];
  if (!spec) return null;
  // Pace is computed once per window here and shared by the bar + the detail.
  // Every window, including a segmented pool, follows the selected display mode.
  const rows = spec
    .windows(data)
    .filter((s) => s.window)
    .map((s) => ({ spec: s, mode, pace: paceForSpec(s, mode, now) }));
  const extra = renderProviderExtra(spec.extra, data);
  return (
    <ToolGroup
      key={id}
      name={title}
      providerId={id}
      expandable={rows.length > 0 || Boolean(subscription)}
      expanded={expanded}
      onToggle={onToggle}
      badge={badge}
      rightAdornment={subscription ? <SubscriptionRightBadge subscription={subscription} /> : null}
      toggleOnHeader={id === "zcode"}
    >
      <LimitWindowSection mode={mode} rows={rows} extra={extra} expanded={expanded} />
      {id === "opencodeGo" || id === "commandCode" ? (
        <EnvCredentialNotice providerId={id} data={data} onSaved={onKeySaved} />
      ) : null}
      {subscription ? <SubscriptionBar subscription={subscription} now={now} mode={mode} /> : null}
      {expanded ? <LimitDetail rows={rows} mode={mode} now={now} /> : null}
      {expanded && subscription ? (
        <SubscriptionDetail subscription={subscription} now={now} />
      ) : null}
      {id === "zcode" && data.start_plan?.configured ? (
        <ZcodeStartPlanSection data={data.start_plan} mode={mode} now={now} />
      ) : null}
    </ToolGroup>
  );
}

// Provider row for states without usable limit data (not connected, inactive,
// fetch error). A linked subscription still belongs to this row: it is
// user-entered data, so its badge/progress stay visible regardless of the
// tool's own configuration state.
function renderUnlinkedProvider(id, statusNodes, expanded, onToggle, subscription = null, now = Date.now(), mode = LIMIT_DISPLAY_MODES.USED) {
  const hasSubscription = Boolean(subscription);
  return (
    <ToolGroup
      key={id}
      name={limitProviderName(id)}
      providerId={id}
      expandable={hasSubscription}
      expanded={expanded}
      onToggle={onToggle}
      rightAdornment={hasSubscription ? <SubscriptionRightBadge subscription={subscription} /> : null}
    >
      {statusNodes}
      {hasSubscription ? <SubscriptionBar subscription={subscription} now={now} mode={mode} /> : null}
      {hasSubscription && expanded ? (
        <div className="mt-1">
          <SubscriptionDetail subscription={subscription} now={now} />
        </div>
      ) : null}
    </ToolGroup>
  );
}

function renderProviderGroup(id, data, mode, expanded, onToggle, subscription = null, now = Date.now(), onKeySaved = null) {
  if (!PROVIDER_LIMIT_SPECS[id]) return null;
  if (!data?.configured) {
    return renderUnlinkedProvider(
      id,
      <>
        <StatusLine>{copy("limits.status.not_connected")}</StatusLine>
        {id === "opencodeGo" ? <SetupHint title={copy("limits.opencodeGo.setupHint.title")}><OpenCodeGoSetupHint onSaved={onKeySaved} /></SetupHint> : null}
        {id === "commandCode" ? <SetupHint title={copy("limits.commandCode.setupHint.title")}><CommandCodeSetupHint onSaved={onKeySaved} /></SetupHint> : null}
        {id === "codingPlan" ? <SetupHint title={copy("limits.codingPlan.setupHint.title")}><ArkCodingPlanSetupHint /></SetupHint> : null}
        {id === "agentPlan" ? <SetupHint title={copy("limits.agentPlan.setupHint.title")}><ArkAgentPlanSetupHint /></SetupHint> : null}
        {id === "devin" ? <SetupHint title={copy("limits.devin.setupHint.title")}><DevinSetupHint /></SetupHint> : null}
      </>,
      expanded,
      onToggle,
      subscription,
      now,
      mode,
    );
  }
  if (id === "opencodeGo" && data.subscription_status === "inactive") {
    return renderUnlinkedProvider(
      id,
      <StatusLine>{copy("limits.opencodeGo.status.inactive")}</StatusLine>,
      expanded,
      onToggle,
      subscription,
      now,
      mode,
    );
  }
  if (data.error) {
    return renderUnlinkedProvider(
      id,
      <>
        <StatusLine tone="error">{data.error}</StatusLine>
        {id === "kiro"
          ? renderProviderExtra(PROVIDER_LIMIT_SPECS.kiro.extra, data)
          : null}
        {id === "opencodeGo" ? <SetupHint title={copy("limits.opencodeGo.setupHint.title")}><OpenCodeGoSetupHint onSaved={onKeySaved} /></SetupHint> : null}
        {id === "commandCode" ? <SetupHint title={copy("limits.commandCode.setupHint.title")}><CommandCodeSetupHint onSaved={onKeySaved} /></SetupHint> : null}
        {id === "codingPlan" ? <SetupHint title={copy("limits.codingPlan.setupHint.title")}><ArkCodingPlanSetupHint /></SetupHint> : null}
        {id === "agentPlan" ? <SetupHint title={copy("limits.agentPlan.setupHint.title")}><ArkAgentPlanSetupHint /></SetupHint> : null}
        {id === "devin" ? <SetupHint title={copy("limits.devin.setupHint.title")}><DevinSetupHint /></SetupHint> : null}
      </>,
      expanded,
      onToggle,
      subscription,
      now,
      mode,
    );
  }

  const baseName = limitProviderName(id);
  const title = data.plan_label ? `${baseName} ${data.plan_label}` : baseName;
  let badge = null;
  // Reauth is more actionable than a cached/live freshness badge: the bars
  // will not move again until the user signs in, even if a disk snapshot
  // is still visible.
  if (data.auth_action_required === "reauth") {
    const command =
      id === "commandCode"
        ? commandCodeLoginSnippet()
        : id === "devin"
          ? devinLoginSnippet()
          : REAUTH_CLI_COMMANDS[id];
    badge = (
      <StatusBadge
        label={copy("limits.reauth.badge")}
        age={ago(data.cached_at)}
        tone="stale"
        tooltip={command ? copy("limits.reauth.tooltip", { command }) : null}
      />
    );
  }
  if (!badge && id === "antigravity") {
    if (data.cached) {
      const suffix = ago(data.cached_at);
      badge = <StatusBadge label={copy("limits.label.antigravity_cached")} age={suffix} tone="cached" tooltip={copy("limits.tooltip.antigravity_cached")} />;
    } else {
      badge = <StatusBadge label={copy("limits.label.antigravity_live")} tone="live" tooltip={copy("limits.tooltip.antigravity_live")} />;
    }
  }
  if (!badge && (id === "qoder" || id === "qoderCn") && data.cached) {
    badge = (
      <StatusBadge
        label={copy("limits.label.antigravity_cached")}
        age={ago(data.cached_at)}
        tone="cached"
        tooltip={copy("limits.tooltip.qoder_cached")}
      />
    );
  }
  // Ark plans are refreshed by the local arkcli binary, not by launching an
  // app — a Qoder-specific tooltip would send users to the wrong tool.
  if (!badge && (id === "codingPlan" || id === "agentPlan") && data.cached) {
    badge = (
      <StatusBadge
        label={copy("limits.label.antigravity_cached")}
        age={ago(data.cached_at)}
        tone="cached"
        tooltip={copy("limits.tooltip.ark_cached")}
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
  return renderConfiguredProvider(
    id,
    data,
    title,
    mode,
    expanded,
    onToggle,
    badge,
    subscription,
    now,
    onKeySaved,
  );
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

// Saves the key through the loopback backend, which writes a 0600 file next to
// the queue. The key is never placed in the launch environment: on macOS a
// global `launchctl setenv` is visible to every launchd app (issue 837).
function ProviderKeyInput({ provider, onSaved }) {
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const value = apiKey.trim();
    if (!value || status === "saving") return;
    setStatus("saving");
    setError(false);
    try {
      await saveProviderApiKey(provider, value);
      setApiKey("");
      setStatus("saved");
      onSaved?.();
    } catch (_e) {
      setStatus("idle");
      setError(true);
    }
  };

  return (
    <form
      className="mt-1.5 space-y-1.5"
      onSubmit={onSubmit}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setStatus("idle");
            setError(false);
          }}
          placeholder={copy("limits.apiKey.placeholder")}
          aria-label={copy("limits.apiKey.placeholder")}
          autoComplete="new-password"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-oai-gray-300 bg-white px-2 py-1 font-mono text-[11px] text-oai-gray-800 outline-none focus:border-oai-brand dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-gray-100"
        />
        <button
          type="submit"
          disabled={!apiKey.trim() || status === "saving"}
          className="shrink-0 rounded-md bg-oai-brand/10 px-2 py-1 font-medium text-oai-brand hover:bg-oai-brand/15 disabled:opacity-50 transition-colors"
        >
          {status === "saving"
            ? copy("limits.apiKey.saving")
            : status === "saved"
              ? copy("limits.apiKey.saved")
              : copy("limits.apiKey.save")}
        </button>
      </div>
      <div className="text-[10px] text-oai-gray-400 dark:text-oai-gray-500">
        {error ? copy("limits.apiKey.save_failed") : copy("limits.apiKey.local_note")}
      </div>
    </form>
  );
}

// A key can still arrive through the process environment (wrapper scripts,
// headless installs). Show where it came from and how to stop exporting it
// globally, because the env value shadows any key saved in the panel.
function EnvCredentialNotice({ providerId, data, onSaved }) {
  if (data?.credential_source !== "env") return null;
  const envName = PROVIDER_KEY_ENV[providerId];
  const storeId = PROVIDER_KEY_STORE_ID[providerId];
  if (!envName || !storeId) return null;
  return (
    <div className="mt-1.5 rounded-md border border-amber-300/60 bg-amber-50/60 px-2 py-1.5 text-[10.5px] leading-snug text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      <div>{copy("limits.apiKey.env_note", { env: envName })}</div>
      <ProviderKeyInput provider={storeId} onSaved={onSaved} />
      {commandCodeSetupPlatform() === "macos" ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <code className="rounded bg-white/70 px-1 py-0.5 font-mono text-[10px] dark:bg-oai-gray-900/60">
            {copy("limits.apiKey.env_unset_command", { env: envName })}
          </code>
          <span>{copy("limits.apiKey.env_unset_note")}</span>
        </div>
      ) : null}
    </div>
  );
}

function SetupHint({ title, children }) {
  return (
    <div className="text-xs text-oai-gray-600 dark:text-oai-gray-300" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <div className="font-medium text-oai-gray-800 dark:text-oai-gray-100">{title}</div>
      {children}
    </div>
  );
}

// OpenCode Go limits come from OpenCode's official authenticated usage API
// (GET /zen/go/v1/usage, Bearer OPENCODE_GO_API_KEY) once the user subscribes.
// The key is entered here and stored by the backend in a 0600 file — never in
// the launch environment, whose global scope is what leaked it into other apps
// (issue 837). The panel only ever sends the key to the loopback backend.
function OpenCodeGoSetupHint({ onSaved }) {
  return (
    <div className="mt-3 text-[11px] text-oai-gray-600 dark:text-oai-gray-300">
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
          <div>{copy("limits.opencodeGo.setupHint.step3")}</div>
          <ProviderKeyInput provider="opencode-go" onSaved={onSaved} />
        </HintStep>
      </ol>
    </div>
  );
}

// Command Code subscription usage comes from the CLI's own alpha endpoints,
// authenticated exactly like the `cmd` CLI itself: the key entered here (or the
// `cmd login` session the CLI stores in ~/.commandcode/auth.json). TokenTracker
// never exposes the credential to the dashboard; the local backend sends it
// only to Command Code's API.
function CommandCodeSetupHint({ onSaved }) {
  // Command lines stay identical across locales; they are copy keys per the
  // repo i18n convention (review 594) so the setup guide and the reauth
  // tooltip share one source of truth for `cmd login`.
  const loginSnippet = commandCodeLoginSnippet();

  return (
    <div className="mt-3 text-[11px] text-oai-gray-600 dark:text-oai-gray-300">
      <div className="mt-0.5 leading-snug text-oai-gray-500 dark:text-oai-gray-400">
        {copy("limits.commandCode.setupHint.subtitle")}
      </div>

      <ol className="mt-2.5 space-y-2.5">
        <HintStep n="1">
          <div>{copy("limits.commandCode.setupHint.step1")}</div>
          <pre className="mt-1.5 overflow-x-auto rounded-md bg-oai-gray-100 dark:bg-oai-gray-900/60 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre">
            {loginSnippet}
          </pre>
        </HintStep>
        <HintStep n="2">
          <div>{copy("limits.commandCode.setupHint.step2")}</div>
          <ProviderKeyInput provider="command-code" onSaved={onSaved} />
        </HintStep>
      </ol>
    </div>
  );
}

// Devin quota is read through the Devin CLI's saved sign-in on this machine
// — the backend reuses the session token the CLI wrote to its credentials
// file, so all the row needs is the CLI installed and signed in once.
// TokenTracker only ever sends that token to Devin's official quota endpoint.
function DevinSetupHint() {
  const loginSnippet = devinLoginSnippet();

  return (
    <div className="mt-3 text-[11px] text-oai-gray-600 dark:text-oai-gray-300">
      <div className="mt-0.5 leading-snug text-oai-gray-500 dark:text-oai-gray-400">
        {copy("limits.devin.setupHint.subtitle")}
      </div>

      <ol className="mt-2.5 space-y-2.5">
        <HintStep n="1">
          <div>{copy("limits.devin.setupHint.step1")}</div>
          <pre className="mt-1.5 overflow-x-auto rounded-md bg-oai-gray-100 dark:bg-oai-gray-900/60 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre">
            {loginSnippet}
          </pre>
          <div className="mt-1 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">
            {copy("limits.devin.setupHint.note")}
          </div>
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
    <div className="mt-3 text-[11px] text-oai-gray-600 dark:text-oai-gray-300">
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

function ArkAgentPlanSetupHint() {
  const [copied, setCopied] = useState(false);
  // Command lines stay identical across locales; only the inline comments
  // localize. Kept as copy keys per the repo i18n convention (review 563).
  const snippet = [
    copy("limits.agentPlan.setupHint.snippet_install"),
    copy("limits.agentPlan.setupHint.snippet_login"),
    copy("limits.agentPlan.setupHint.snippet_status"),
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
    <div className="mt-3 text-[11px] text-oai-gray-600 dark:text-oai-gray-300">
      <div className="mt-0.5 leading-snug text-oai-gray-500 dark:text-oai-gray-400">{copy("limits.agentPlan.setupHint.subtitle")}</div>

      <ol className="mt-2.5 space-y-2.5">
        <HintStep n="1">
          <div>{copy("limits.agentPlan.setupHint.step1")}</div>
          <a
            href="https://www.volcengine.com/docs/82379/2536875"
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-1 inline-flex items-center gap-1 rounded-md bg-oai-brand/10 px-2 py-1 font-medium text-oai-brand hover:bg-oai-brand/15 transition-colors"
          >
            {copy("limits.agentPlan.setupHint.cta")}
            <ExternalArrow />
          </a>
        </HintStep>
        <HintStep n="2">
          <div>{copy("limits.agentPlan.setupHint.step2")}</div>
          <div className="mt-0.5 text-oai-gray-500 dark:text-oai-gray-400">{copy("limits.agentPlan.setupHint.step2_remote")}</div>
        </HintStep>
        <HintStep n="3">
          <div className="flex items-center gap-2">
            <span>{copy("limits.agentPlan.setupHint.step3")}</span>
            <button
              type="button"
              onClick={onCopy}
              className="shrink-0 rounded-md border border-oai-gray-300 dark:border-oai-gray-700 px-2 py-0.5 text-[10.5px] text-oai-gray-700 dark:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors"
            >
              {copied ? copy("limits.agentPlan.setupHint.copied") : copy("limits.agentPlan.setupHint.copy")}
            </button>
          </div>
          <pre className="mt-1.5 overflow-x-auto rounded-md bg-oai-gray-100 dark:bg-oai-gray-900/60 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre">{snippet}</pre>
          <div className="mt-1 text-[10px] text-oai-gray-400 dark:text-oai-gray-500">{copy("limits.agentPlan.setupHint.note_app")}</div>
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
    const labels = [...root.querySelectorAll("[data-limit-label]")]
      .filter((label) => label.closest("[data-limit-label-group]") === root);
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

export function UsageLimitsPanel({ claude, codex, cursor, gemini, kimi, kiro, grok, antigravity, copilot, zcode, opencodeGo, commandCode, qoder, qoderCn, codingPlan, agentPlan, devin, workbuddy, order, visibility, displayMode, subscriptions = [], showSubscriptions = true, onProviderKeySaved = null }) {
  const dataById = { claude, codex, cursor, gemini, kimi, kiro, grok, antigravity, copilot, zcode, opencodeGo, commandCode, qoder, qoderCn, codingPlan, agentPlan, devin, workbuddy };
  const containerRef = useRef(null);
  const labelWidth = useWidestLabelWidth(containerRef);
  const [expandedId, setExpandedId] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const effectiveOrder = [...new Set((Array.isArray(order) && order.length > 0 ? order : DEFAULT_ORDER)
    .map((id) => id === "workbuddyAi" ? "workbuddy" : id))];
  const effectiveMode = displayMode === LIMIT_DISPLAY_MODES.REMAINING
    ? LIMIT_DISPLAY_MODES.REMAINING
    : LIMIT_DISPLAY_MODES.USED;

  // Refresh countdowns/remaining labels once a minute without re-fetching.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  // One inline row per linked provider. Prefer the soonest still-active
  // record; only when every record for a provider is past its date does the
  // most recently expired one show (an expired history record must not mask a
  // live renewal). Extra records stay manageable in the settings popover.
  // When the user disables subscription display, skip the mapping entirely so
  // inline badges/bars/details all disappear.
  const subscriptionByProvider = new Map();
  if (showSubscriptions) {
    for (const subscription of subscriptions || []) {
      if (!subscription?.provider) continue;
      const endMs = new Date(subscription.nextBillingAt).getTime();
      if (!Number.isFinite(endMs)) continue;
      const existing = subscriptionByProvider.get(subscription.provider);
      if (!existing) {
        subscriptionByProvider.set(subscription.provider, subscription);
        continue;
      }
      const existingMs = new Date(existing.nextBillingAt).getTime();
      const upcoming = endMs > now;
      const existingUpcoming = existingMs > now;
      if (
        (upcoming && (!existingUpcoming || existingMs > endMs)) ||
        (!upcoming && !existingUpcoming && endMs > existingMs)
      ) {
        subscriptionByProvider.set(subscription.provider, subscription);
      }
    }
  }

  // Hiding a tool hides its limits row, but not a subscription the user
  // entered by hand — that data keeps its row regardless of visibility prefs.
  const groups = effectiveOrder
    .filter((id) => !visibility || visibility[id] !== false || subscriptionByProvider.has(id))
    .map((id) => {
      return renderProviderGroup(
        id,
        dataById[id],
        effectiveMode,
        expandedId === id,
        () => setExpandedId((prev) => (prev === id ? null : id)),
        subscriptionByProvider.get(id) || null,
        now,
        onProviderKeySaved,
      );
    })
    .filter(Boolean);

  return (
    <FadeIn delay={0.15}>
      <div
          ref={containerRef}
          data-limit-label-group=""
          className="flex flex-col gap-3"
          style={labelWidth > 0 ? { "--tt-limits-label-w": `${labelWidth}px` } : undefined}
        >
          {groups.length > 0 ? groups : <StatusLine>{copy("limits.status.all_hidden")}</StatusLine>}
      </div>
    </FadeIn>
  );
}
