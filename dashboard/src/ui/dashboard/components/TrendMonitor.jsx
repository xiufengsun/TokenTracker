import React from "react";
import { motion, useReducedMotion } from "motion/react";
import { Maximize2 } from "lucide-react";
import { copy, getCopyLocale } from "../../../lib/copy";
import { cn } from "../../../lib/cn";
import { useCurrency } from "../../../hooks/useCurrency.js";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { formatUsdCurrency } from "../../../lib/format";
import {
  formatBucketRange,
  formatTickLabel,
  formatTrendRange,
  granularityFromPeriod,
} from "../../../lib/trend-stats";
import { TrendMonitorZoomModal } from "./TrendMonitorZoomModal";

function interpolateQuantile(sortedValues, ratio) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

export function getTrendMonitorScale(values, { clipOutliers = true } = {}) {
  const finiteValues = Array.isArray(values)
    ? values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
    : [];

  if (finiteValues.length === 0) {
    return {
      rawMax: 0,
      effectiveMax: 1,
      clippedValues: Array.isArray(values) ? values.map(() => 0) : [],
    };
  }

  const rawMax = finiteValues.at(-1) ?? 0;
  let effectiveMax = rawMax;

  if (clipOutliers && finiteValues.length >= 4) {
    const q1 = interpolateQuantile(finiteValues, 0.25);
    const q3 = interpolateQuantile(finiteValues, 0.75);
    const iqr = Math.max(q3 - q1, 0);
    const upperWhisker = q3 + iqr * 1.5;
    const hasOutlier = rawMax > upperWhisker;

    if (hasOutlier) {
      effectiveMax = Math.max(upperWhisker, q3, 1);
    }
  }

  return {
    rawMax,
    effectiveMax: Math.max(effectiveMax, 1),
    clippedValues: Array.isArray(values)
      ? values.map((value) => {
          if (!Number.isFinite(value) || value <= 0) return 0;
          return Math.min(value, Math.max(effectiveMax, 1));
        })
      : [],
  };
}

const STACK_COLORS = [
  "#f472b6", // 浅粉 (如儿子)
  "#38bdf8", // 天蓝 (如 OpenAI)
  "#34d399", // 绿色
  "#fbbf24", // 金黄
  "#a78bfa", // 浅紫
  "#fb7185", // 玫瑰红
  "#2dd4bf", // 青色
  "#f97316", // 橙色
  "#6366f1", // 靛蓝
  "#ec4899", // 洋红
  "#14b8a6", // 薄荷绿
  "#f59e0b", // 琥珀黄
];

const TOKEN_COLORS = {
  "Input": "#38bdf8",
  "Cached Input": "#14b8a6",
  "Output": "#a78bfa",
  "Reasoning Output": "#fb7185",
};

const MODEL_PROVIDER_COLORS = {
  codex: "#3b82f6",
  gpt: "#10b981",
  openai: "#10b981",
  
  claude: "#d97757",
  anthropic: "#d97757",
  
  gemini: "#2196f3",
  google: "#2196f3",
  
  kimi: "#a78bfa",
  moonshot: "#a78bfa",

  opencode: "#f59e0b",
  deepseek: "#f59e0b",
  
  droid: "#ef4444",
  
  kilo: "#facc15",
};

export function getModelColor(modelName) {
  const normalized = modelName.toLowerCase();
  for (const [key, color] of Object.entries(MODEL_PROVIDER_COLORS)) {
    if (normalized.includes(key)) {
      return color;
    }
  }

  let hash = 0;
  for (let i = 0; i < modelName.length; i++) {
    hash = modelName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % STACK_COLORS.length;
  return STACK_COLORS[index];
}

/**
 * Collapse model keys that differ only by whitespace or letter case.
 *
 * Usage APIs preserve the model spelling emitted by each tool. A single trend
 * bucket can therefore contain both `GPT-5.5` and `gpt-5.5`; treating object
 * keys as case-sensitive makes the tooltip render two segments for one model.
 * Keep the most-used spelling for display while summing every variant into one
 * stable segment.
 */
export function mergeModelSegments(models) {
  if (!models || typeof models !== "object") return [];
  const byKey = new Map();
  for (const [rawName, rawValue] of Object.entries(models)) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) continue;
    const name = String(rawName).trim() || "unknown";
    const key = name.toLowerCase();
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { name, value, displayWeight: value });
      continue;
    }
    current.value += value;
    if (value > current.displayWeight) {
      current.name = name;
      current.displayWeight = value;
    }
  }
  return Array.from(byKey.values())
    .map(({ name, value }) => ({ type: "model", name, value }))
    .sort((a, b) => b.value - a.value);
}

function getBarSegments(row) {
  if (!row) return [];
  const segments = [];

  // 1. 如果有 models，且 models 相加大于 0，则按模型拆分
  if (row.models && typeof row.models === "object") {
    segments.push(...mergeModelSegments(row.models));
  }

  // 2. 如果没有 models，或者 models 分量之和为 0，我们尝试按 Token 类型拆分
  if (segments.length === 0) {
    const tokenTypes = [
      { name: "Input", key: "input_tokens" },
      { name: "Cached Input", key: "cached_input_tokens" },
      { name: "Output", key: "output_tokens" },
      { name: "Reasoning Output", key: "reasoning_output_tokens" },
    ];
    for (const type of tokenTypes) {
      const val = Number(row[type.key]);
      if (Number.isFinite(val) && val > 0) {
        segments.push({
          type: "token_type",
          name: type.name,
          value: val,
        });
      }
    }
  }

  // 按用量降序排列，以使得较大的段沉入底部渲染，小分量在上。
  return segments.sort((a, b) => b.value - a.value);
}

// Bar kinds:
//   - "real":      row carries a positive observed value; render stacked segments.
//   - "real_zero": row is observed but value is 0 (truly idle period); render a flat baseline.
//   - "predicted": row is `future`; render interpolated/extrapolated height as a faint preview.
//   - "unsynced":  row is `missing`; render interpolated/extrapolated height as a faint preview.
function getBarKind(row, value) {
  if (row?.future) return "predicted";
  if (row?.missing) return "unsynced";
  if (value > 0) return "real";
  return "real_zero";
}

const PREVIEW_OPACITY = 0.35;
const BASELINE_HEIGHT_PX = 2;
const PREVIEW_MIN_HEIGHT_PX = 4;

// Memoized so hover state in the parent (tooltip) doesn't re-render every
// bar on each mouseenter/mouseleave — props are all stable across hovers.
const TrendBar = React.memo(function TrendBar({
  value,
  displayValue,
  scale,
  index,
  row,
  totalBars,
  onMouseEnter,
  onMouseLeave,
}) {
  const shouldReduceMotion = useReducedMotion();
  const kind = getBarKind(row, value);
  const isPreview = kind === "predicted" || kind === "unsynced";

  const heightPercent = scale.effectiveMax > 0 ? (displayValue / scale.effectiveMax) * 100 : 0;

  let barHeight;
  let minHeight;
  if (kind === "real") {
    barHeight = `${Math.max(heightPercent, 2)}%`;
    minHeight = `${PREVIEW_MIN_HEIGHT_PX}px`;
  } else if (isPreview && heightPercent > 0) {
    barHeight = `${heightPercent}%`;
    minHeight = `${PREVIEW_MIN_HEIGHT_PX}px`;
  } else {
    // real_zero, or preview with no neighbours to extrapolate from.
    barHeight = `${BASELINE_HEIGHT_PX}px`;
    minHeight = `${BASELINE_HEIGHT_PX}px`;
  }

  const segments = kind === "real" ? getBarSegments(row) : [];
  const totalSegmentsValue = segments.reduce((sum, s) => sum + s.value, 0);
  const renderFlat = kind !== "real" || totalSegmentsValue <= 0;

  return (
    <motion.div
      className="group relative flex-1 self-stretch"
      initial={{ opacity: 0, scaleY: 0 }}
      animate={{ opacity: 1, scaleY: 1 }}
      transition={{
        duration: shouldReduceMotion ? 0 : 0.3,
        delay: shouldReduceMotion ? 0 : 0.4 + index * 0.008,
        ease: [0.16, 1, 0.3, 1],
      }}
      style={{ originY: 1 }}
      onMouseEnter={(e) => onMouseEnter(e, row, value, segments, kind, displayValue)}
      onMouseLeave={onMouseLeave}
    >
      {/* 纵向整列 Hover 引导条 */}
      <div className="absolute inset-x-0 top-0 bottom-0 bg-oai-gray-100/70 dark:bg-white/[0.08] opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none" />

      <div
        className="absolute inset-x-0 bottom-0 flex flex-col-reverse justify-start overflow-hidden cursor-pointer transition-all duration-200"
        style={{
          height: barHeight,
          minHeight,
        }}
      >
        {renderFlat ? (
          /* 占位/预测/真实零：单色背景条 */
          <div
            data-trend-bar="true"
            data-trend-kind={kind}
            className={cn(
              "h-full w-full group-hover:brightness-110 transition-all",
              kind === "real" ? "" : "bg-oai-gray-100 dark:bg-oai-gray-800",
            )}
            style={{
              opacity: isPreview ? PREVIEW_OPACITY : 1,
              background: kind === "real" ? "#10b981" : undefined,
            }}
          />
        ) : (
          /* 堆叠拼接，自底向上绘制 */
          segments.map((seg, sIdx) => {
            const segColor =
              seg.type === "token_type" ? TOKEN_COLORS[seg.name] : getModelColor(seg.name);
            const segHeight = `${(seg.value / totalSegmentsValue) * 100}%`;
            return (
              <div
                key={sIdx}
                data-trend-bar={sIdx === 0 ? "true" : undefined}
                className="w-full group-hover:brightness-110 transition-all"
                style={{
                  height: segHeight,
                  background: segColor,
                }}
              />
            );
          })
        )}
      </div>
    </motion.div>
  );
});

// Extract numeric tokens from a row, or null if the row carries no observation
// (missing/future, no field, or non-finite). Real zeros stay as `0` — they are
// observations, not gaps, and must NOT be interpolated over.
function readRowValue(row) {
  if (row?.missing || row?.future) return null;
  const raw = row?.billable_total_tokens ?? row?.total_tokens ?? row?.value;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Predicted-bar curve tuning. We extrapolate at the mean of observed values
// and apply a mild decay across distance to suggest uncertainty without
// burying the bars. The nearest neighbour is intentionally NOT mixed in:
// the last real bar is often a partial current hour that would otherwise
// drag every future-hour prediction down for the rest of the day.
const EXTRAPOLATION_DECAY_PER_STEP = 0.98;

// Pure helper exported for unit testing. Returns one estimated value per index:
// observed values pass through unchanged; null gaps are linearly interpolated
// when bracketed by observations, and extrapolated at the mean of observed
// values with a mild distance-based decay when only one side has data.
// All-null input returns all zeros.
export function computeInterpolatedSeries(rawValues) {
  if (!Array.isArray(rawValues)) return [];
  const out = new Array(rawValues.length);
  for (let i = 0; i < rawValues.length; i++) {
    if (rawValues[i] !== null) {
      out[i] = rawValues[i];
      continue;
    }

    let leftVal = null;
    let leftIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (rawValues[j] !== null) {
        leftVal = rawValues[j];
        leftIdx = j;
        break;
      }
    }

    let rightVal = null;
    let rightIdx = -1;
    for (let j = i + 1; j < rawValues.length; j++) {
      if (rawValues[j] !== null) {
        rightVal = rawValues[j];
        rightIdx = j;
        break;
      }
    }

    if (leftVal !== null && rightVal !== null) {
      const ratio = (i - leftIdx) / (rightIdx - leftIdx);
      out[i] = leftVal + (rightVal - leftVal) * ratio;
    } else if (leftVal !== null) {
      let sum = 0;
      let count = 0;
      for (let j = 0; j <= leftIdx; j++) {
        if (rawValues[j] !== null) {
          sum += rawValues[j];
          count += 1;
        }
      }
      const base = count > 0 ? sum / count : leftVal;
      out[i] = base * Math.pow(EXTRAPOLATION_DECAY_PER_STEP, i - leftIdx);
    } else if (rightVal !== null) {
      let sum = 0;
      let count = 0;
      for (let j = rightIdx; j < rawValues.length; j++) {
        if (rawValues[j] !== null) {
          sum += rawValues[j];
          count += 1;
        }
      }
      const base = count > 0 ? sum / count : rightVal;
      out[i] = base * Math.pow(EXTRAPOLATION_DECAY_PER_STEP, rightIdx - i);
    } else {
      out[i] = 0;
    }
  }
  return out;
}

export function TrendMonitor({
  rows,
  from,
  to,
  period,
  timeZoneLabel,
  showTimeZoneLabel = true,
  className = "",
  // When `true`, the trend renders bare: no outer card chrome (rounded
  // border + bg + padding), no inner heading. Use this when the host
  // already provides a section wrapper (e.g. the leaderboard profile
  // modal). Default keeps the standalone dashboard appearance.
  embedded = false,
  // Tailwind height class for the bar row. The hardcoded h-40 is the small
  // dashboard card; the zoom modal passes a tall class (e.g. h-[60vh]) so the
  // bars actually grow thick and readable.
  chartHeightClass = "h-40",
  // When `true`, render zoom-only affordances: an X-axis time-tick row under
  // the bars and extra tooltip fields (precise time range, cost, conversations).
  // The small dashboard card leaves this false and is byte-for-byte unchanged.
  isZoom = false,
  // useTrendData config (baseUrl/accessToken/cacheKey/timeZone/...) passed
  // through so the zoom modal can hold its OWN data instance for granularity
  // drill-down without mutating the dashboard's state. Only used (and only
  // present) on the standalone card; null disables the maximize button.
  zoomConfig = null,
}) {
  const series = React.useMemo(
    () => (Array.isArray(rows) && rows.length ? rows : []),
    [rows],
  );
  const hasPredictions = React.useMemo(
    () => series.some((row) => row?.future),
    [series],
  );

  // rawValues: real observations (incl. 0) pass through; missing/future are null.
  // seriesValues: zero-padded view used for y-axis scaling so gaps don't skew the max.
  // interpolatedValues: per-index predicted height for missing/future gaps.
  const { rawValues, seriesValues, scale, interpolatedValues } = React.useMemo(() => {
    const raw = series.map(readRowValue);
    const padded = raw.map((v) => (v == null ? 0 : v));
    return {
      rawValues: raw,
      seriesValues: padded,
      scale: getTrendMonitorScale(padded, { clipOutliers: period !== "total" }),
      interpolatedValues: computeInterpolatedSeries(raw),
    };
  }, [series, period]);

  const { currency, rate } = useCurrency();
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const granularity = granularityFromPeriod(period);
  const locale = getCopyLocale();
  const rangeLabels = React.useMemo(
    () => formatTrendRange(from, to, granularity, locale),
    [from, granularity, locale, to],
  );

  const [hoveredBar, setHoveredBar] = React.useState(null);
  const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0, shiftX: 0, flipDown: false });
  const [isZoomOpen, setIsZoomOpen] = React.useState(false);
  const containerRef = React.useRef(null);
  const hideTimeoutRef = React.useRef(null);

  const handleBarMouseEnter = React.useCallback((e, row, value, segments, kind, displayValue) => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }

    const timeLabel = formatBucketRange(row, granularity, locale);
    setHoveredBar({
      row,
      value,
      segments,
      timeLabel,
      kind,
      displayValue,
    });

    // 优先寻找真实柱状图定位，以防外层 hover 容器导致 top 坐标上移
    // 注意：data-trend-bar="true" 绑定在子级 segment 上，它的 parentElement 才是整根柱子的实体容器包装 div
    const barEl = e.currentTarget.querySelector('[data-trend-bar="true"]');
    const rect = barEl && barEl.parentElement
      ? barEl.parentElement.getBoundingClientRect()
      : e.currentTarget.getBoundingClientRect();
    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const x = rect.left - containerRect.left + rect.width / 2;
    const y = rect.top - containerRect.top;

    // 自适应横向防溢出
    const halfWidth = 140;
    let shiftX = 0;
    if (x < halfWidth) {
      shiftX = halfWidth - x;
    } else if (x > containerRect.width - halfWidth) {
      shiftX = (containerRect.width - halfWidth) - x;
    }

    // Flip the tooltip below the bar when there isn't room above it. Tall zoom
    // bars sit near the top of the chart, so an upward tooltip would be clipped
    // by the chart container. `y` is the bar top relative to the container top.
    const estTooltipHeight =
      96 + (isZoom ? 22 : 0) + (segments.length ? Math.min(segments.length * 30 + 24, 174) : 0);
    const flipDown = y < estTooltipHeight + 12;

    setTooltipPos({ x, y, shiftX, flipDown });
  }, [isZoom, granularity, locale]);

  const handleBarMouseLeave = React.useCallback(() => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      setHoveredBar(null);
    }, 150);
  }, []);

  const handleTooltipMouseEnter = React.useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const handleTooltipMouseLeave = React.useCallback(() => {
    handleBarMouseLeave();
  }, [handleBarMouseLeave]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative",
        !embedded &&
          "rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-5",
        isZoom && "flex h-full flex-col",
        className,
      )}
    >
      {!embedded && (
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
              {copy("trend.monitor.label")}
            </h3>
            {showTimeZoneLabel && timeZoneLabel && (
              <p className="text-xs text-oai-gray-400 dark:text-oai-gray-400 mt-0.5">{timeZoneLabel}</p>
            )}
          </div>
          {zoomConfig && (
            <button
              type="button"
              onClick={() => setIsZoomOpen(true)}
              aria-label={copy("trend.zoom.open_aria")}
              title={copy("trend.zoom.open_aria")}
              className="shrink-0 p-1.5 rounded-md text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors"
            >
              <Maximize2 size={14} />
            </button>
          )}
        </div>
      )}
      <div className={cn("space-y-3", isZoom && "flex flex-1 flex-col min-h-0 !space-y-0 gap-3")}>
        <div className={cn("relative", isZoom && "flex-1 min-h-0")}>
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
            {[0, 25, 50, 75, 100].map((pct) => (
              <div
                key={pct}
                className="w-full border-t border-oai-gray-100 dark:border-oai-gray-800"
                style={{ top: `${100 - pct}%` }}
              />
            ))}
          </div>
          <div className={cn("flex items-end gap-0.5 relative z-0", chartHeightClass)}>
            {seriesValues.length > 0 ? (
              seriesValues.map((value, index) => {
                const row = series[index];
                const isGap = row?.missing || row?.future;
                // Real observations (incl. 0) use the y-clipped value so they
                // stay proportional to neighbours. Only true gaps fall back to
                // the predicted curve, clipped to the visible max.
                const displayValue = isGap
                  ? Math.min(interpolatedValues[index] ?? 0, scale.effectiveMax)
                  : scale.clippedValues[index] ?? 0;
                return (
                  <TrendBar
                    key={index}
                    value={value}
                    displayValue={displayValue}
                    scale={scale}
                    index={index}
                    row={row}
                    totalBars={seriesValues.length}
                    onMouseEnter={handleBarMouseEnter}
                    onMouseLeave={handleBarMouseLeave}
                  />
                );
              })
            ) : (
              <div className="flex-1 h-full flex items-center justify-center">
                <p className="text-sm text-oai-gray-400 dark:text-oai-gray-400">
                  {copy("trend.monitor.empty")}
                </p>
              </div>
            )}
          </div>
        </div>

        {isZoom && seriesValues.length > 0 && (
          <div className="flex gap-0.5 select-none">
            {series.map((row, index) => {
              const last = seriesValues.length - 1;
              const step = Math.max(1, Math.ceil(seriesValues.length / 8));
              const isTick = index % step === 0 || index === last;
              const justify =
                index === 0 ? "justify-start" : index === last ? "justify-end" : "justify-center";
              return (
                <div key={index} className={cn("flex-1 min-w-0 flex", justify)}>
                  {isTick && (
                    <span className="text-[9px] text-oai-gray-400 dark:text-oai-gray-500 whitespace-nowrap font-mono">
                      {formatTickLabel(row, granularity, locale)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {hasPredictions && (
          <div
            className="flex items-center justify-end gap-1.5 text-[10px] font-medium text-oai-gray-400 dark:text-oai-gray-500"
            data-trend-prediction-legend="true"
          >
            <span
              aria-hidden="true"
              className="h-2.5 w-3 rounded-[2px] bg-oai-gray-100 dark:bg-oai-gray-800 opacity-50"
            />
            <span>~ {copy("trend.monitor.predicted")}</span>
          </div>
        )}

        {rangeLabels && (
          <div className="flex justify-between text-xs text-oai-gray-500 dark:text-oai-gray-300 font-medium pt-2 border-t border-oai-gray-100 dark:border-oai-gray-800">
            <span>{rangeLabels.start}</span>
            <span>{rangeLabels.end}</span>
          </div>
        )}
      </div>

      {/* 2D 精致 Hover Tooltip */}
      {hoveredBar && (
        <div
          data-trend-tooltip="true"
          onMouseEnter={handleTooltipMouseEnter}
          onMouseLeave={handleTooltipMouseLeave}
          className="absolute z-[9999] w-0 h-0 transition-all duration-100 ease-out"
          style={{
            left: `${tooltipPos.x}px`,
            top: `${tooltipPos.y}px`,
          }}
        >
          {/* Tooltip 玻璃外框（底边固定在柱子上方） */}
          <div
            className={cn(
              "absolute left-0 backdrop-blur-md bg-white/95 dark:bg-oai-gray-900/95 border border-oai-gray-200/50 dark:border-oai-gray-800/50 shadow-xl rounded-xl p-3.5 max-w-[280px] min-w-[220px] flex flex-col gap-2 animate-in fade-in zoom-in-95 duration-100",
              tooltipPos.flipDown ? "top-[10px]" : "bottom-[10px]",
            )}
            style={{
              transform: `translateX(calc(-50% + ${tooltipPos.shiftX}px))`,
            }}
          >
            {/* 顶栏 */}
            <div className="flex items-center justify-between border-b border-oai-gray-100 dark:border-oai-gray-800/80 pb-1.5">
              <span className="text-[11px] font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                {hoveredBar.timeLabel}
              </span>
              {hoveredBar.kind === "predicted" && (
                <span className="text-[9px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500">
                  {copy("trend.monitor.predicted")}
                </span>
              )}
              {hoveredBar.kind === "unsynced" && (
                <span className="text-[9px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500">
                  {copy("trend.monitor.unsynced")}
                </span>
              )}
            </div>

            {/* 内容 */}
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-1">
                <span
                  title={formatTokensTooltip(hoveredBar.kind === "predicted" || hoveredBar.kind === "unsynced" ? hoveredBar.displayValue : hoveredBar.value)}
                  className="text-lg font-bold text-oai-gray-900 dark:text-white leading-none"
                >
                  {hoveredBar.kind === "predicted" || hoveredBar.kind === "unsynced"
                    ? `~${formatTokens(Math.round(hoveredBar.displayValue ?? 0))}`
                    : formatTokens(hoveredBar.value)}
                </span>
                <span className="text-[10px] text-oai-gray-400 uppercase tracking-wider font-semibold">
                  {copy("heatmap.unit.tokens")}
                </span>
              </div>

              {isZoom &&
                (hoveredBar.row?.total_cost_usd != null ||
                  Number(hoveredBar.row?.conversation_count) > 0) && (
                  <div className="flex items-center gap-3 text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
                    {hoveredBar.row?.total_cost_usd != null && (
                      <span>
                        <span className="font-semibold text-oai-gray-700 dark:text-oai-gray-200">
                          {formatUsdCurrency(hoveredBar.row.total_cost_usd, { currency, rate })}
                        </span>{" "}
                        {copy("trend.zoom.tooltip.cost")}
                      </span>
                    )}
                    {Number(hoveredBar.row?.conversation_count) > 0 && (
                      <span>
                        <span className="font-semibold text-oai-gray-700 dark:text-oai-gray-200">
                          {Number(hoveredBar.row.conversation_count).toLocaleString()}
                        </span>{" "}
                        {copy("trend.zoom.tooltip.conversations")}
                      </span>
                    )}
                  </div>
                )}

              {hoveredBar.segments && hoveredBar.segments.length > 0 ? (
                <div className="mt-1.5 border-t border-oai-gray-100 dark:border-oai-gray-800/60 pt-2 flex flex-col gap-1.5">
                  <div className="text-[10px] font-semibold text-oai-gray-400 dark:text-oai-gray-500 uppercase tracking-wider">
                    {hoveredBar.segments[0].type === "model"
                      ? copy("heatmap.tooltip.model_breakdown")
                      : copy("heatmap.tooltip.token_breakdown")}
                  </div>
                  <div className="flex flex-col gap-2 max-h-[150px] overflow-y-auto pr-1.5 oai-scrollbar">
                    {hoveredBar.segments.map(({ name, value: val, type }) => {
                      const total = hoveredBar.value || 1;
                      const pct = Math.round((val / total) * 100);
                      const color =
                        type === "token_type" ? TOKEN_COLORS[name] : getModelColor(name);
                      return (
                        <div key={name} className="flex flex-col gap-1">
                          <div className="flex items-center justify-between text-[11px] gap-3">
                            <span
                              className="font-medium text-oai-gray-750 dark:text-oai-gray-200 truncate max-w-[130px]"
                              title={name}
                            >
                              {name}
                            </span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span
                                title={formatTokensTooltip(val)}
                                className="font-mono text-oai-gray-900 dark:text-oai-gray-100 font-semibold"
                              >
                                {formatTokens(val)}
                              </span>
                              <span className="text-[9px] text-oai-gray-450 dark:text-oai-gray-500 min-w-[28px] text-right font-medium">
                                {pct}%
                              </span>
                            </div>
                          </div>
                          <div className="w-full h-1 bg-oai-gray-100 dark:bg-oai-gray-800/85 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: color,
                                boxShadow: `0 0 4px ${color}55`,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* 倒三角小尾巴 */}
          <div
            className={cn(
              "absolute left-0 -translate-x-1/2 w-2.5 h-2.5 rotate-45 bg-white dark:bg-oai-gray-900 border-oai-gray-200/50 dark:border-oai-gray-800/50 shadow-sm",
              tooltipPos.flipDown ? "top-[6px] border-l border-t" : "bottom-[6px] border-r border-b",
            )}
            style={tooltipPos.flipDown ? { marginTop: "1px" } : { marginBottom: "1px" }}
          />
        </div>
      )}

      {isZoomOpen && zoomConfig && (
        <TrendMonitorZoomModal
          zoomConfig={zoomConfig}
          period={period}
          from={from}
          to={to}
          timeZoneLabel={timeZoneLabel}
          onClose={() => setIsZoomOpen(false)}
          renderChart={(chartProps) => (
            <TrendMonitor embedded isZoom chartHeightClass="h-full" {...chartProps} />
          )}
        />
      )}
    </div>
  );
}
