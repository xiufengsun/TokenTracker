import React, { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Download, Monitor } from "lucide-react";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { Select } from "../ui/components";
import { isNativeEmbed, nativeAction } from "../lib/native-bridge.js";
import { useNativeSettings } from "../hooks/use-native-settings.js";
import {
  FALLBACK_MENU_BAR_ITEMS,
  MENU_BAR_NONE_ID,
  normalizeMenuBarItems,
} from "../lib/menu-bar-display.js";
import { ToggleSwitch } from "../components/settings/Controls.jsx";
import { FadeIn, StaggerContainer, StaggerItem } from "../ui/foundation/FadeIn.jsx";

/* ---------- SVG widget illustrations ----------
 * Hand-drawn previews of the real macOS widgets. Pure SVG so they stay
 * crisp at any scale and don't require shipping PNGs.
 *
 * Example values and model IDs stay literal, while user-facing labels use
 * copy.csv so the preview follows the dashboard locale.
 */

const WIDGET_W = 264;
const WIDGET_H = 124;
const ROUNDED_FONT = "ui-rounded, -apple-system, system-ui";

// Model accent palette — mirrors WidgetTheme.modelDot in
// TokenTrackerBar/TokenTrackerWidget/Views/WidgetTheme.swift
const MODEL_COLORS = ["#5A8CF2", "#9973E6", "#4DB8A6", "#E68C59"];

// Source accent palette — mirrors WidgetTheme.sourceColor (SwiftUI system
// colors, approximated in hex to match rendered appearance)
const SOURCE_COLORS = {
  claude: "#C77DFF", // SwiftUI .purple
  codex: "#34C759",  // SwiftUI .green
  cursor: "#FFCC00", // SwiftUI .yellow
  gemini: "#0A84FF", // SwiftUI .blue
};

// Limit bar fill — mirrors WidgetTheme.limitBarColor
function limitBarFill(fraction) {
  if (fraction >= 0.9) return "#E64D4D"; // red
  if (fraction >= 0.7) return "#D9A633"; // amber
  return "#33B866";                      // green
}

/**
 * PreviewShell — renders a widget tile at the real macOS systemMedium
 * aspect ratio (~2.13:1). `size="lg"` is the hero (up to 560px wide),
 * `size="sm"` is a secondary catalog tile (up to 264px wide). Both scale
 * down responsively on narrow viewports using CSS aspect-ratio.
 *
 * `rounded-[22/32px]` is an intentional deviation from the design system's
 * token radii: it mimics the macOS continuous-corner widget radius so the
 * preview reads as an Apple widget rather than a generic card.
 */
function PreviewShell({ size = "sm", children }) {
  const isHero = size === "lg";
  const maxWidth = isHero ? 560 : 264;
  const radius = isHero ? 32 : 22;
  return (
    <div
      className={cn(
        "flex w-full items-center justify-center rounded-xl bg-oai-gray-100 dark:bg-oai-gray-950/60",
        isHero ? "py-10 sm:py-14 px-6" : "py-6 px-4",
      )}
    >
      <div
        className="overflow-hidden bg-white dark:bg-oai-gray-800 shadow-oai-md dark:shadow-[0_2px_4px_rgba(0,0,0,0.4),0_8px_24px_rgba(0,0,0,0.5)]"
        style={{
          width: "100%",
          maxWidth,
          aspectRatio: `${WIDGET_W} / ${WIDGET_H}`,
          borderRadius: radius,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function SummaryWidgetPreview({ size = "sm" }) {
  // Sparkline curve — extended flat at both ends so it spans the full tile
  // width (x=0 → x=264) instead of leaving visible gaps at the widget edges.
  const sparklinePath =
    "M0,104 L14,104 C26,98 34,100 44,96 S58,88 68,92 80,100 90,94 102,80 112,82 126,92 136,88 150,74 162,76 178,88 188,86 204,72 216,74 236,84 250,80 L264,80";
  // Closed area: follow the curve then drop to the baseline and back.
  const areaPath = `${sparklinePath} L264,124 L0,124 Z`;
  const gradientId = `sparkArea-${size}`;
  return (
    <PreviewShell size={size}>
      <svg viewBox="0 0 264 124" className="h-full w-full" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0A84FF" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#0A84FF" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Today column */}
        <text x="14" y="20" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="700" letterSpacing="0.6">{copy("widgets.preview.today")}</text>
        <text x="14" y="46" className="fill-oai-black dark:fill-white" fontSize="22" fontWeight="700" fontFamily={ROUNDED_FONT}>203.2M</text>
        <text x="14" y="60" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="500" fontFamily={ROUNDED_FONT}>$129.56 ±0%</text>
        {/* Seven-day column */}
        <text x="134" y="20" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="700" letterSpacing="0.6">{copy("widgets.preview.seven_days")}</text>
        <text x="134" y="46" className="fill-oai-black dark:fill-white" fontSize="22" fontWeight="700" fontFamily={ROUNDED_FONT}>880.9M</text>
        <text x="134" y="60" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="500" fontFamily={ROUNDED_FONT}>$673.61</text>
        {/* Area fill under the curve */}
        <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
        {/* Sparkline stroke on top */}
        <path d={sparklinePath} fill="none" stroke="#0A84FF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </PreviewShell>
  );
}

// Deterministic heatmap cells — 26 weeks × 7 days, matching Swift
// HeatmapWidget.weeks for systemMedium. Uses a sin-hash (GLSL classic)
// because modular PRNG on small seed ranges produces a visible "letter"
// pattern. Computed once at module load.
const HEATMAP_CELLS = (() => {
  const weeks = 26;
  const days = 7;
  const cells = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < days; d++) {
      const n = Math.sin((w + 1) * 12.9898 + (d + 1) * 78.233 + 17) * 43758.5453;
      const v = Math.floor(Math.abs(n - Math.floor(n)) * 100);
      cells.push({ w, d, v });
    }
  }
  return cells;
})();

// Mirrors WidgetTheme.heatmapLevels — gray base + four steps of accent blue.
// Empty cells snap to oai-gray-200 / -800 (design tokens); blue stays as
// the macOS system accent, matching SwiftUI's Color.accentColor.
function heatmapFill(v, dark) {
  if (v < 18) return dark ? "#262626" /* oai-gray-800 */ : "#e5e5e5" /* oai-gray-200 */;
  if (v < 38) return "rgba(10, 132, 255, 0.28)";
  if (v < 58) return "rgba(10, 132, 255, 0.50)";
  if (v < 80) return "rgba(10, 132, 255, 0.75)";
  return "#0A84FF";
}

function HeatmapWidgetPreview() {
  // 264×124 tile: cellW 7.5, cellH 8, gap 1.2
  //   grid width  = 26*7.5 + 25*1.2 = 225   → left margin (264-225)/2 = 19.5
  //   grid height = 7*8   + 6*1.2  = 63.2  → top margin 10
  //   footer baseline at y=102 → ~22px clear above the bottom edge
  const cellW = 7.5;
  const cellH = 8;
  const gap = 1.2;
  const gridX = 19.5;
  const gridY = 10;
  return (
    <PreviewShell>
      <svg viewBox="0 0 264 124" className="h-full w-full" aria-hidden="true">
        <g transform={`translate(${gridX}, ${gridY})`} className="hidden dark:inline">
          {HEATMAP_CELLS.map((c) => (
            <rect key={`d-${c.w}-${c.d}`} x={c.w * (cellW + gap)} y={c.d * (cellH + gap)} width={cellW} height={cellH} rx="1.3" fill={heatmapFill(c.v, true)} />
          ))}
        </g>
        <g transform={`translate(${gridX}, ${gridY})`} className="dark:hidden">
          {HEATMAP_CELLS.map((c) => (
            <rect key={`l-${c.w}-${c.d}`} x={c.w * (cellW + gap)} y={c.d * (cellH + gap)} width={cellW} height={cellH} rx="1.3" fill={heatmapFill(c.v, false)} />
          ))}
        </g>
        <text x={gridX} y="102" className="fill-oai-black dark:fill-white" fontSize="10" fontWeight="700" fontFamily={ROUNDED_FONT}>10.3B</text>
        <text x={gridX + 30} y="102" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="9" fontWeight="500">
          {copy("widgets.preview.heatmap_summary", { days: 202 })}
        </text>
      </svg>
    </PreviewShell>
  );
}

function TopModelsWidgetPreview() {
  // Four rows mirroring ModelBar in TopModelsWidget.swift. Bar fill matches
  // the dot color (not a neutral track) — this is intentional per Swift.
  const models = [
    { name: "claude-opus-4-6",            value: "586.4M", pct: 59 },
    { name: "claude-sonnet-4-5-20250929", value: "218.7M", pct: 22 },
    { name: "gpt-5.4",                    value: "80.6M",  pct: 8 },
    { name: "composer-2-fast",            value: "52.1M",  pct: 5 },
  ];
  const rowGap = 22;
  // Vertically centered: content spans ~78px in a 124px tile.
  const rowStart = 28;
  const trackX = 14;
  const trackW = 236;
  return (
    <PreviewShell>
      <svg viewBox="0 0 264 124" className="h-full w-full" aria-hidden="true">
        {models.map((m, i) => {
          const y = rowStart + i * rowGap;
          const color = MODEL_COLORS[i % MODEL_COLORS.length];
          return (
            <g key={m.name}>
              <circle cx="18" cy={y - 3} r="2.5" fill={color} />
              <text x="26" y={y} className="fill-oai-black dark:fill-white" fontSize="9" fontWeight="500">{m.name}</text>
              <text x="218" y={y} textAnchor="end" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="9" fontWeight="600" fontFamily={ROUNDED_FONT}>{m.value}</text>
              <text x="250" y={y} textAnchor="end" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="600" fontFamily={ROUNDED_FONT}>{m.pct}%</text>
              <rect x={trackX} y={y + 4} width={trackW} height="2.8" rx="1.4" className="fill-oai-gray-200 dark:fill-oai-gray-700" />
              <rect x={trackX} y={y + 4} width={Math.max(trackW * (m.pct / 100), 4)} height="2.8" rx="1.4" fill={color} />
            </g>
          );
        })}
      </svg>
    </PreviewShell>
  );
}

function UsageLimitsWidgetPreview() {
  // Four rows mirroring LimitRow in UsageLimitsWidget.swift. Bullet color
  // follows the provider source; bar fill follows limitBarColor(fraction).
  const rows = [
    { label: `${copy("limits.provider.claude")} · ${copy("limits.label.claude_7d")}`, source: "claude", reset: copy("widgets.preview.reset_days", { days: 1 }), pct: 61 },
    { label: `${copy("limits.provider.claude")} · ${copy("limits.label.claude_5h")}`, source: "claude", reset: copy("widgets.preview.reset_hours_minutes", { hours: 4, minutes: 28 }), pct: 4 },
    { label: copy("limits.provider.cursor"), source: "cursor", reset: copy("widgets.preview.reset_days", { days: 25 }), pct: 51 },
    { label: `${copy("limits.provider.codex")} · ${copy("limits.label.codex_7d")}`, source: "codex", reset: copy("widgets.preview.reset_days", { days: 1 }), pct: 32 },
  ];
  const rowGap = 22;
  const rowStart = 28;
  const trackX = 14;
  const trackW = 236;
  return (
    <PreviewShell>
      <svg viewBox="0 0 264 124" className="h-full w-full" aria-hidden="true">
        {rows.map((r, i) => {
          const y = rowStart + i * rowGap;
          const dot = SOURCE_COLORS[r.source];
          const fill = limitBarFill(r.pct / 100);
          return (
            <g key={r.label}>
              <circle cx="18" cy={y - 3} r="2.5" fill={dot} />
              <text x="26" y={y} className="fill-oai-black dark:fill-white" fontSize="9" fontWeight="500">{r.label}</text>
              <text x="218" y={y} textAnchor="end" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="500" fontFamily={ROUNDED_FONT}>{r.reset}</text>
              <text x="250" y={y} textAnchor="end" className="fill-oai-black dark:fill-white" fontSize="9" fontWeight="700" fontFamily={ROUNDED_FONT}>{r.pct}%</text>
              <rect x={trackX} y={y + 4} width={trackW} height="2.8" rx="1.4" className="fill-oai-gray-200 dark:fill-oai-gray-700" />
              <rect x={trackX} y={y + 4} width={Math.max(trackW * (r.pct / 100), 4)} height="2.8" rx="1.4" fill={fill} />
            </g>
          );
        })}
      </svg>
    </PreviewShell>
  );
}

/* ---------- Menu bar display configurator ---------- */

function previewValueFor(item) {
  switch (item.category) {
    case "none":
      return "";
    case "cost":
      return "$8.42";
    case "limits":
      return "62%";
    default:
      return item.id === "last7dTokens" ? "1.8B" : "203M";
  }
}

function metricLabel(id, fallback) {
  switch (id) {
    case MENU_BAR_NONE_ID:
      return copy("menubar.metric.none");
    case "todayTokens":
      return copy("menubar.metric.today_tokens");
    case "todayCost":
      return copy("menubar.metric.today_cost");
    case "last7dTokens":
      return copy("menubar.metric.last_7d_tokens");
    case "totalTokens":
      return copy("menubar.metric.total_tokens");
    case "totalCost":
      return copy("menubar.metric.total_cost");
    case "claude5h":
      return copy("menubar.metric.claude_5h");
    case "claude7d":
      return copy("menubar.metric.claude_7d");
    case "codex5h":
      return copy("menubar.metric.codex_5h");
    case "codex7d":
      return copy("menubar.metric.codex_7d");
    case "codexCredits":
      return copy("menubar.metric.codex_credits");
    case "codexSpark5h":
      return copy("menubar.metric.codex_spark_5h");
    case "codexSpark7d":
      return copy("menubar.metric.codex_spark_7d");
    case "antigravityArgonWeekly":
      return copy("menubar.metric.antigravity_argon_weekly");
    default:
      return fallback;
  }
}

function fillTwoSlots(ids, availableItems) {
  const allowed = new Set(availableItems.map((item) => item.id));
  // "none" is positional and may repeat — keep it as-is in either slot.
  const filled = ids.filter((id) => id === MENU_BAR_NONE_ID || allowed.has(id));
  for (const item of availableItems) {
    if (filled.length >= 2) break;
    if (item.id === MENU_BAR_NONE_ID) continue;
    if (!filled.includes(item.id)) filled.push(item.id);
  }
  return filled.slice(0, 2);
}

/**
 * Compact menu-bar segment mock — sized to the same proportions as a real
 * macOS status item so the preview reads as "this is what your menu bar
 * will look like" rather than "this is a control surface".
 *
 * Dark pill on a neutral wallpaper-style backdrop. When `showStats` is off,
 * only the icon is shown (matches the native fallback behavior).
 */
function MenuBarPreview({ slotConfigs, showStats }) {
  return (
    <div className="flex justify-center rounded-xl bg-gradient-to-b from-oai-gray-100 to-oai-gray-200 px-6 py-8 dark:from-oai-gray-950/80 dark:to-oai-gray-900/80">
      <div
        className="inline-flex items-stretch rounded-md shadow-[0_1px_3px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:ring-white/10 px-3"
        style={{ background: "linear-gradient(180deg, #2c2c2e 0%, #1c1c1e 100%)" }}
      >
        {/* Icon column: asymmetric padding (more left, less right) brings the
            character close to the first metric since there's no separator
            between them. Character is sized to read like a real macOS
            menu-bar glyph rather than a hero illustration. */}
        <div className="flex items-center pl-2 pr-1 py-2.5">
          <img
            src="/clawd/mini/idle-tight.svg"
            alt=""
            aria-hidden="true"
            className="block shrink-0"
            style={{ height: 22, width: "auto" }}
            draggable="false"
          />
        </div>
        {showStats
          ? slotConfigs
              .filter(({ item }) => item?.category !== "none")
              .map(({ slot, item }, idx) => (
              <React.Fragment key={slot}>
                {idx > 0 ? (
                  <span className="my-1 w-px bg-white/20" aria-hidden="true" />
                ) : null}
                <div className={cn(
                  "flex min-w-[52px] flex-col items-center justify-center py-1.5",
                  // First metric column hugs closer to the icon (no separator
                  // there); subsequent columns get even padding around the divider.
                  idx === 0 ? "pl-1 pr-2" : "px-2",
                )}>
                  <span className="text-[13px] font-semibold leading-none tabular-nums text-white">
                    {item?.previewValue || "--"}
                  </span>
                  <span className="mt-[2px] text-[6px] font-semibold uppercase leading-none text-white/75">
                    {item?.shortLabel || copy("widgets.preview.metric")}
                  </span>
                </div>
              </React.Fragment>
            ))
          : null}
      </div>
    </div>
  );
}

function MenuBarSlotSelect({ slot, value, options, disabled, onChange }) {
  const slotLabel = slot === 0 ? copy("menubar.slot.primary") : copy("menubar.slot.secondary");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-oai-gray-500 dark:text-oai-gray-400">
        {slotLabel}
      </span>
      <Select
        value={value}
        disabled={disabled}
        ariaLabel={slotLabel}
        onValueChange={(next) => onChange(slot, next)}
        options={options.map((option) => ({ value: option.id, label: option.displayLabel }))}
        matchTriggerWidth
        className="w-full px-3 py-2 text-sm font-medium"
      />
    </div>
  );
}

function MenuBarToggleRow({ label, hint, checked, disabled, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-oai-black dark:text-white">{label}</p>
        {hint ? (
          <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">{hint}</p>
        ) : null}
      </div>
      <ToggleSwitch checked={checked} disabled={disabled} onChange={onChange} ariaLabel={label} />
    </div>
  );
}

function MenuBarSelectRow({ label, hint, value, options, disabled, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-oai-black dark:text-white">{label}</p>
        {hint ? (
          <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">{hint}</p>
        ) : null}
      </div>
      <Select
        value={value}
        disabled={disabled}
        ariaLabel={label}
        onValueChange={onChange}
        options={options}
        className="shrink-0 px-3 py-2 text-sm font-medium"
      />
    </div>
  );
}

function MenuBarDisplayCard() {
  const { available, settings, setSetting } = useNativeSettings();

  const availableItems = useMemo(() => {
    const nativeItems = Array.isArray(settings?.menuBarAvailableItems)
      ? settings.menuBarAvailableItems
      : FALLBACK_MENU_BAR_ITEMS;
    return nativeItems.map((item) => ({
      ...item,
      displayLabel: metricLabel(item.id, item.label),
      shortLabel: item.id === "antigravityArgonWeekly" ? copy("menubar.metric.antigravity_argon_weekly_short") : item.shortLabel,
      previewValue: previewValueFor(item),
    }));
  }, [settings?.menuBarAvailableItems]);

  const maxItems = Number(settings?.menuBarMaxItems) || 2;
  const selectedIds = useMemo(
    () => normalizeMenuBarItems(settings?.menuBarItems, availableItems, maxItems),
    [availableItems, maxItems, settings?.menuBarItems],
  );
  const slotIds = useMemo(() => fillTwoSlots(selectedIds, availableItems), [availableItems, selectedIds]);
  const showStats = settings?.showStats !== false;

  const saveSelection = (ids) => {
    setSetting("menuBarItems", normalizeMenuBarItems(ids, availableItems, maxItems));
  };

  const changeSlot = (slot, id) => {
    const next = [...slotIds];
    const otherSlot = slot === 0 ? 1 : 0;
    // Both slots may be "none"; only real metrics must stay distinct.
    if (id !== MENU_BAR_NONE_ID && next[otherSlot] === id) return;
    next[slot] = id;
    saveSelection(next);
  };

  const slotConfigs = [0, 1].map((slot) => {
    const currentValue = slotIds[slot] || availableItems[slot]?.id || "";
    const otherSlot = slot === 0 ? 1 : 0;
    const otherValue = slotIds[otherSlot];
    const options = availableItems.filter(
      (candidate) =>
        candidate.id === MENU_BAR_NONE_ID ||
        candidate.id === currentValue ||
        candidate.id !== otherValue,
    );
    const item = availableItems.find((candidate) => candidate.id === currentValue);
    return { slot, currentValue, options, item };
  });

  const iconStyles = ["clawd", "bot", "cat", "pet", "static"];
  const iconStyle = iconStyles.includes(settings?.menuBarIconStyle)
    ? settings.menuBarIconStyle
    : "clawd";
  const toastOnReset = settings?.toastOnReset !== false;
  const confettiOnReset = settings?.confettiOnReset !== false;

  return (
    <article className="rounded-xl border border-oai-gray-200 bg-white p-5 transition-colors duration-200 dark:border-oai-gray-800 dark:bg-oai-gray-900 sm:p-6">
      <MenuBarPreview slotConfigs={slotConfigs} showStats={showStats} />

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
        {slotConfigs.map(({ slot, currentValue, options }) => (
          <MenuBarSlotSelect
            key={slot}
            slot={slot}
            value={currentValue}
            options={options}
            disabled={!available || !showStats}
            onChange={changeSlot}
          />
        ))}
      </div>

      <div className="mt-5 divide-y divide-oai-gray-100 border-t border-oai-gray-100 dark:divide-oai-gray-800 dark:border-oai-gray-800">
        <MenuBarToggleRow
          label={copy("settings.menubar.showStats")}
          hint={available ? copy("settings.menubar.showStatsHint") : copy("menubar.native_only")}
          checked={showStats}
          disabled={!available}
          onChange={() => setSetting("showStats", !showStats)}
        />
        <MenuBarSelectRow
          label={copy("settings.menubar.iconStyle")}
          hint={copy("settings.menubar.iconStyleHint")}
          value={iconStyle}
          disabled={!available}
          options={[
            { value: "clawd", label: copy("settings.menubar.iconStyle.clawd") },
            { value: "bot", label: copy("settings.menubar.iconStyle.bot") },
            { value: "cat", label: copy("settings.menubar.iconStyle.cat") },
            { value: "pet", label: copy("settings.menubar.iconStyle.pet") },
            { value: "static", label: copy("settings.menubar.iconStyle.static") },
          ]}
          onChange={(next) => setSetting("menuBarIconStyle", next)}
        />
        <MenuBarToggleRow
          label={copy("settings.menubar.toastOnReset")}
          hint={copy("settings.menubar.toastOnResetHint")}
          checked={toastOnReset}
          disabled={!available}
          onChange={() => setSetting("toastOnReset", !toastOnReset)}
        />
        <MenuBarToggleRow
          label={copy("settings.menubar.confettiOnReset")}
          hint={copy("settings.menubar.confettiOnResetHint")}
          checked={confettiOnReset}
          disabled={!available}
          onChange={() => setSetting("confettiOnReset", !confettiOnReset)}
        />
      </div>
    </article>
  );
}

/* ---------- Header CTA — adaptive by platform ----------
 * native  → inside the menu bar app's WKWebView (bridge currently available)
 * mac-web → browser on macOS (can download the native app)
 * other   → non-macOS browser (widgets unsupported)
 *
 * NOTE: we use `isNativeEmbed()` here (checks `window.webkit.messageHandlers
 * .nativeBridge` directly) instead of `isNativeApp()` (which reads a sticky
 * localStorage flag). The sticky flag persists after the native app launched
 * the dashboard once, so later opening `localhost:5173` in a regular browser
 * would incorrectly report native mode — clicks would then fire a bridge
 * message into the void. isNativeEmbed is the honest "right now" test.
 */
function useClientPlatform() {
  const [platform, setPlatform] = useState("loading");
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isNativeEmbed()) {
      setPlatform("native");
      return;
    }
    const ua = (navigator.userAgent || "").toLowerCase();
    const isMac = /mac/.test(ua) && !/iphone|ipad/.test(ua);
    setPlatform(isMac ? "mac-web" : "other");
  }, []);
  return platform;
}

function HeaderCta() {
  const platform = useClientPlatform();

  // Reserve space so the layout doesn't jump once detection resolves.
  if (platform === "loading") {
    return <div className="h-10 w-40" aria-hidden="true" />;
  }

  if (platform === "native") {
    return (
      <button
        type="button"
        onClick={() => nativeAction("openWidgetGallery")}
        className="inline-flex h-10 items-center gap-2 rounded-lg bg-oai-black px-4 text-sm font-medium text-white transition-colors hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:bg-white dark:text-oai-black dark:hover:bg-oai-gray-200"
      >
        {copy("widgets.cta.open_gallery")}
        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  if (platform === "mac-web") {
    return (
      <a
        href="https://github.com/xiufengsun/TokenTracker/releases/latest"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-10 items-center gap-2 rounded-lg bg-oai-black px-4 text-sm font-medium text-white no-underline transition-colors hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:bg-white dark:text-oai-black dark:hover:bg-oai-gray-200"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        {copy("widgets.cta.download")}
      </a>
    );
  }

  // Non-macOS — widgets aren't available, tell the user gently.
  return (
    <span className="inline-flex h-10 items-center gap-2 rounded-lg border border-oai-gray-200 bg-oai-gray-50 px-4 text-sm font-medium text-oai-gray-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-400">
      <Monitor className="h-4 w-4" aria-hidden="true" />
      {copy("widgets.cta.macos_only")}
    </span>
  );
}

/* ---------- Secondary catalog data ---------- */

const SECONDARY_WIDGETS = [
  { id: "summary",  Preview: SummaryWidgetPreview,      nameKey: "widgets.summary.name",   descKey: "widgets.summary.description" },
  { id: "heatmap",   Preview: HeatmapWidgetPreview,    nameKey: "widgets.heatmap.name",   descKey: "widgets.heatmap.description" },
  { id: "topModels", Preview: TopModelsWidgetPreview,  nameKey: "widgets.topModels.name", descKey: "widgets.topModels.description" },
  { id: "limits",    Preview: UsageLimitsWidgetPreview, nameKey: "widgets.limits.name",   descKey: "widgets.limits.description" },
];

function WidgetCatalogCard({ Preview, nameKey, descKey }) {
  return (
    <article className="flex h-full flex-col rounded-xl border border-oai-gray-200 bg-white p-4 transition-colors duration-200 dark:border-oai-gray-800 dark:bg-oai-gray-900 sm:p-5">
      <Preview />
      <div className="mt-4">
        <h3 className="text-[15px] font-semibold text-oai-black dark:text-white">
          {copy(nameKey)}
        </h3>
        <p className="mt-1.5 text-sm leading-relaxed text-oai-gray-500 dark:text-oai-gray-400">
          {copy(descKey)}
        </p>
      </div>
    </article>
  );
}

/* ---------- Page ---------- */

function SectionTitle({ titleKey }) {
  return (
    <h2 className="mb-4 text-xl font-semibold tracking-tight text-oai-black dark:text-white sm:mb-5 sm:text-2xl">
      {copy(titleKey)}
    </h2>
  );
}

export function WidgetsPage() {
  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          {/* Page header — H1 + adaptive CTA. No page subtitle (the two H2
              sections speak for themselves; subtitles only added title noise). */}
          <FadeIn y={12}>
            <header className="mb-10 flex items-start justify-between gap-4 sm:mb-12">
              <h1 className="text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">
                {copy("widgets.page.title")}
              </h1>
              <div className="shrink-0">
                <HeaderCta />
              </div>
            </header>
          </FadeIn>

          {/* Menu Bar — own section, dedicated card */}
          <FadeIn y={12} delay={0.06}>
            <section aria-label={copy("widgets.menubar.section.title")} className="mb-12 sm:mb-14">
              <SectionTitle titleKey="widgets.menubar.section.title" />
              <MenuBarDisplayCard />
            </section>
          </FadeIn>

          {/* Desktop Widgets gallery */}
          <section aria-label={copy("widgets.gallery.section.title")}>
            <SectionTitle titleKey="widgets.gallery.section.title" />
            <StaggerContainer staggerDelay={0.08} initialDelay={0.04}>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-5">
                {SECONDARY_WIDGETS.map(({ id, Preview, nameKey, descKey }) => (
                  <StaggerItem key={id}>
                    <WidgetCatalogCard Preview={Preview} nameKey={nameKey} descKey={descKey} />
                  </StaggerItem>
                ))}
              </div>
            </StaggerContainer>
          </section>
        </div>
      </main>
    </div>
  );
}
