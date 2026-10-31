import { copy } from "../../../lib/copy";

/** Window + optional extra metadata for UsageLimitsPanel (no JSX — keeps hardcode scan clean). */

// Qoder reports an empty 0/0 bucket for a plan-less account or a missing
// add-on pack. The row carries no quota to read and would render as a full
// bar in remaining mode, so it is dropped like a missing window (the panel
// already shows its no-data state when every row drops out).
function dropEmptyQoderWindow(window) {
  if (!window) return null;
  return Number(window.limit_credits) === 0 ? null : window;
}

export const PROVIDER_LIMIT_SPECS = {
  claude: {
    windows(data) {
      // Model-scoped weekly windows (e.g. Fable) are dynamic: the label comes from
      // the API's `scope.model.display_name`, so `label` is set instead of `labelKey`.
      const scoped = Array.isArray(data.weekly_scoped)
        ? data.weekly_scoped.map((w) => ({
            key: `scoped-${w.label}`,
            label: w.label,
            window: w,
            pctField: "utilization",
            resetField: "resets_at",
            windowSeconds: 7 * 86400,
          }))
        : [];
      return [
        { key: "5h", labelKey: "limits.label.claude_5h", window: data.five_hour, pctField: "utilization", resetField: "resets_at", windowSeconds: 5 * 3600 },
        { key: "7d", labelKey: "limits.label.claude_7d", window: data.seven_day, pctField: "utilization", resetField: "resets_at", windowSeconds: 7 * 86400 },
        { key: "opus", labelKey: "limits.label.claude_opus", window: data.seven_day_opus, pctField: "utilization", resetField: "resets_at", windowSeconds: 7 * 86400 },
        ...scoped,
      ];
    },
  },
  codex: {
    extra: "codex_meta",
    windows(data) {
      return [
        { key: "5h", labelKey: "limits.label.codex_5h", window: data.primary_window, windowSecondsField: "limit_window_seconds" },
        { key: "7d", labelKey: "limits.label.codex_7d", window: data.secondary_window, windowSecondsField: "limit_window_seconds" },
        { key: "credits", labelKey: "limits.label.codex_credits", window: data.credit_window },
        { key: "spark-5h", labelKey: "limits.label.codex_spark_5h", window: data.spark_primary_window, windowSecondsField: "limit_window_seconds" },
        { key: "spark-7d", labelKey: "limits.label.codex_spark_7d", window: data.spark_secondary_window, windowSecondsField: "limit_window_seconds" },
      ];
    },
  },
  cursor: {
    windows(data) {
      return [
        {
          key: "plan",
          labelKey: "limits.label.cursor_plan",
          window: data.primary_window,
          windowSecondsField: "limit_window_seconds",
        },
        {
          key: "auto",
          labelKey: "limits.label.cursor_auto",
          window: data.secondary_window,
          windowSecondsField: "limit_window_seconds",
        },
        {
          key: "api",
          labelKey: "limits.label.cursor_api",
          window: data.tertiary_window,
          windowSecondsField: "limit_window_seconds",
        },
        {
          key: "grok-bot",
          labelKey: "limits.label.cursor_grok_bot",
          window: data.quaternary_window,
          windowSecondsField: "limit_window_seconds",
        },
      ];
    },
  },
  gemini: {
    windows(data) {
      return [
        { key: "pro", labelKey: "limits.label.gemini_pro", window: data.primary_window },
        { key: "flash", labelKey: "limits.label.gemini_flash", window: data.secondary_window },
        { key: "lite", labelKey: "limits.label.gemini_lite", window: data.tertiary_window },
      ];
    },
  },
  kimi: {
    extra: "kimi_parallel",
    windows(data) {
      return [
        { key: "weekly", labelKey: "limits.label.kimi_weekly", window: data.primary_window, windowSeconds: 7 * 86400 },
        { key: "5h", labelKey: "limits.label.kimi_5h", window: data.secondary_window, windowSeconds: 5 * 3600 },
        { key: "total", labelKey: "limits.label.kimi_total", window: data.tertiary_window },
      ];
    },
  },
  kiro: {
    extra: "kiro_credits",
    windows(data) {
      return [
        { key: "month", labelKey: "limits.label.kiro_month", window: data.primary_window },
        { key: "bonus", labelKey: "limits.label.kiro_bonus", window: data.secondary_window },
      ];
    },
  },
  grok: {
    // Grok unified billing is weekly for SuperGrok / free-tier accounts and
    // monthly for legacy credit counters. period_type comes from the billing
    // API (USAGE_PERIOD_TYPE_WEEKLY / MONTHLY) via grok-limits.js.
    // Products are shares of that same pool, not separate quotas, so they ride
    // on the pool row as `segments` instead of rows that read as independent
    // 100% quotas. The headline follows used/remaining. The stack itself is
    // drawn only in used mode, where the slices add up to that headline.
    windows(data) {
      const period = typeof data.period_type === "string" ? data.period_type : null;
      const primaryLabelKey =
        period === "weekly"
          ? "limits.label.grok_week"
          : period === "daily"
            ? "limits.label.grok_day"
            : "limits.label.grok_month";
      const windowSeconds =
        period === "weekly" ? 7 * 86400 : period === "daily" ? 86400 : undefined;
      return [
        {
          key: period === "weekly" ? "week" : period === "daily" ? "day" : "month",
          labelKey: primaryLabelKey,
          window: data.primary_window,
          windowSeconds,
          productPool: true,
          segments: grokProductSegments(data),
        },
        { key: "ondemand", labelKey: "limits.label.grok_ondemand", window: data.secondary_window },
      ];
    },
  },
  antigravity: {
    /** Limit rows for Antigravity, ordered Gm 5h → Gm 7d → Cl 5h → Cl 7d with server-supplied window durations. */
    windows(data) {
      return [
        { key: "gemini-5h", labelKey: "limits.label.antigravity_gemini_5h", window: data.quaternary_window, windowSecondsField: "limit_window_seconds" },
        { key: "gemini-weekly", labelKey: "limits.label.antigravity_gemini_weekly", window: data.tertiary_window, windowSecondsField: "limit_window_seconds" },
        { key: "claude-5h", labelKey: "limits.label.antigravity_claude_5h", window: data.secondary_window, windowSecondsField: "limit_window_seconds" },
        { key: "claude-weekly", labelKey: "limits.label.antigravity_claude_weekly", window: data.primary_window, windowSecondsField: "limit_window_seconds" },
      ];
    },
  },
  copilot: {
    extra: "copilot_otel",
    windows(data) {
      return [
        { key: "premium", labelKey: "limits.label.copilot_premium", window: data.primary_window },
        { key: "chat", labelKey: "limits.label.copilot_chat", window: data.secondary_window },
      ];
    },
  },
  zcode: {
    extra: "zcode_reset_bank",
    /** Limit rows for ZCode: fixed coding-plan windows, or one row per labelled start-plan bucket. */
    windows(data) {
      // Coding plans expose 5h / weekly / tools windows (ZCode 3.3.x).
      // Start plans list one row per balance bucket; the label comes from the API
      // (model name, plus the promotion name for one-time grants), so `label` is set.
      if (data.plan_kind === "coding-plan") {
        return [
          { key: "5h", labelKey: "limits.label.zcode_5h", window: data.primary_window },
          { key: "weekly", labelKey: "limits.label.zcode_weekly", window: data.secondary_window },
          { key: "tools", labelKey: "limits.label.zcode_tools", window: data.tertiary_window },
        ];
      }
      const labeled = Array.isArray(data.buckets) ? data.buckets.filter((b) => b?.label && b.window) : [];
      if (labeled.length) {
        return labeled.map((b, i) => ({
          key: `bucket-${b.entitlement_id || i}`,
          label: b.label,
          window: b.window,
          ...(b.period === "one_time" ? { timeKind: "expiry" } : {}),
        }));
      }
      // Payloads from older servers carry no bucket labels.
      return [
        { key: "glm52", labelKey: "limits.label.zcode_glm52", window: data.primary_window },
        { key: "glm5t", labelKey: "limits.label.zcode_glm5t", window: data.secondary_window },
      ];
    },
  },
  opencodeGo: {
    // OpenCode Go: $12/5h + $30/week + $60/month rolling windows. Window
    // lengths are server-defined (no client-trusted window length to pace
    // against), so we leave `windowSeconds` unset — paceForSpec reads
    // `expectedPercent` and skips the projection copy.
    windows(data) {
      return [
        { key: "5h", labelKey: "limits.label.opencode_go_5h", window: data.primary_window },
        { key: "weekly", labelKey: "limits.label.opencode_go_weekly", window: data.secondary_window },
        { key: "monthly", labelKey: "limits.label.opencode_go_monthly", window: data.tertiary_window },
      ];
    },
  },
  qoder: {
    windows(data) {
      return [
        { key: "credits", labelKey: "limits.label.qoder_credits", window: dropEmptyQoderWindow(data.primary_window) },
        { key: "addon", labelKey: "limits.label.qoder_addon_credits", window: dropEmptyQoderWindow(data.tertiary_window) },
        {
          key: "ultimate",
          labelKey: "limits.label.qoder_ultimate",
          window: data.secondary_window,
          timeKind: "expiry",
        },
      ];
    },
  },
  qoderCn: {
    windows(data) {
      return [
        { key: "credits", labelKey: "limits.label.qoder_cn_credits", window: dropEmptyQoderWindow(data.primary_window) },
        { key: "addon", labelKey: "limits.label.qoder_cn_addon_credits", window: dropEmptyQoderWindow(data.tertiary_window) },
        {
          key: "ultimate",
          labelKey: "limits.label.qoder_cn_ultimate",
          window: data.secondary_window,
          timeKind: "expiry",
        },
      ];
    },
  },
  codingPlan: {
    // Volcano Ark Coding Plan quota refreshes on three windows: a rolling
    // 5-hour (session), a weekly, and a monthly one. Percentages come straight
    // from arkcli's usage plan payload; no client-side pacing data.
    windows(data) {
      return [
        { key: "5h", labelKey: "limits.label.ark_coding_plan_5h", window: data.primary_window },
        { key: "weekly", labelKey: "limits.label.ark_coding_plan_weekly", window: data.secondary_window },
        { key: "monthly", labelKey: "limits.label.ark_coding_plan_monthly", window: data.tertiary_window },
      ];
    },
  },
  commandCode: {
    // CommandCode subscription: 5h + weekly rolling windows over included
    // monthly credits. Server-defined caps (client-trusted used% only), so no
    // windowSeconds-based pacing projection — mirrors opencodeGo.
    windows(data) {
      return [
        { key: "5h", labelKey: "limits.label.command_code_5h", window: data.primary_window },
        { key: "weekly", labelKey: "limits.label.command_code_weekly", window: data.secondary_window },
      ];
    },
  },
  agentPlan: {
    // Volcano Ark Agent Plan quota refreshes on three windows: a rolling
    // 5-hour (5h), a weekly, and a monthly one. Percentages come straight
    // from arkcli's usage plan payload; no client-side pacing data.
    windows(data) {
      return [
        { key: "5h", labelKey: "limits.label.ark_agent_plan_5h", window: data.primary_window },
        { key: "weekly", labelKey: "limits.label.ark_agent_plan_weekly", window: data.secondary_window },
        { key: "monthly", labelKey: "limits.label.ark_agent_plan_monthly", window: data.tertiary_window },
      ];
    },
  },
  devin: {
    // Devin subscription quota: fixed daily + weekly windows straight from the
    // official GetPlanStatus RPC. The server supplies each window's reset time
    // and length (86400/604800), so pacing uses `limit_window_seconds`.
    windows(data) {
      return [
        { key: "daily", labelKey: "limits.label.devin_daily", window: data.primary_window, windowSecondsField: "limit_window_seconds" },
        { key: "weekly", labelKey: "limits.label.devin_weekly", window: data.secondary_window, windowSecondsField: "limit_window_seconds" },
      ];
    },
  },
  workbuddy: {
    // One row per signed-in edition, mirroring the desktop app's split: the
    // subscription plan's base credits on the plan cycle, plus one pooled
    // resource-package window for every non-plan credit group (gift, top-up,
    // platform rewards). An empty 0/0 pool yields no window and drops out.
    windows(data) {
      return [
        { key: "plan", labelKey: "limits.label.workbuddy_plan", window: data.primary_window, creditPrecision: 2, showCreditDetail: true },
        { key: "addon", labelKey: "limits.label.workbuddy_addon", window: data.secondary_window, creditPrecision: 2, showCreditDetail: true },
      ];
    },
  },
  // WorkBuddy AI publishes the same two-window shape as the China edition.
  workbuddyAi: {
    windows(data) {
      return PROVIDER_LIMIT_SPECS.workbuddy.windows(data);
    },
  },
};

const GROK_PRODUCT_LABEL_KEYS = {
  GrokBuild: "limits.label.grok_build",
  GrokBot: "limits.label.grok_bot",
  GrokChat: "limits.label.grok_chat",
  GrokImagine: "limits.label.grok_imagine",
  GrokVoice: "limits.label.grok_voice",
  Cursor: "limits.label.grok_cursor",
};

/**
 * Per-product slices of the pool bar, in API order. Known ids use copy keys; a
 * future product uses the server label. Null when there is nothing to split,
 * so the pool falls back to a plain bar.
 */
function grokProductSegments(data) {
  if (!Array.isArray(data?.products)) return null;
  const segments = [];
  for (const entry of data.products) {
    const product = typeof entry?.product === "string" ? entry.product : "";
    const pct = Number(entry?.window?.used_percent);
    if (!product || !(pct > 0)) continue;
    const labelKey = GROK_PRODUCT_LABEL_KEYS[product];
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!labelKey && !label) continue;
    segments.push({ key: product, ...(labelKey ? { labelKey } : { label }), pct });
  }
  return segments.length > 0 ? segments : null;
}

/** Static copy() anchors for validate:copy — labels resolve at runtime via spec.labelKey. */
export function usageLimitsLabelCopyAnchor() {
  return [
    copy("limits.label.claude_5h"),
    copy("limits.label.claude_7d"),
    copy("limits.label.claude_opus"),
    copy("limits.label.codex_5h"),
    copy("limits.label.codex_7d"),
    copy("limits.label.codex_credits"),
    copy("limits.label.codex_spark_5h"),
    copy("limits.label.codex_spark_7d"),
    copy("limits.codex_credits.detail"),
    copy("limits.codex_reset_bank.count_only"),
    copy("limits.label.cursor_plan"),
    copy("limits.label.cursor_auto"),
    copy("limits.label.cursor_api"),
    copy("limits.label.cursor_grok_bot"),
    copy("limits.label.gemini_pro"),
    copy("limits.label.gemini_flash"),
    copy("limits.label.gemini_lite"),
    copy("limits.label.kimi_weekly"),
    copy("limits.label.kimi_5h"),
    copy("limits.label.kimi_total"),
    copy("limits.label.kiro_month"),
    copy("limits.label.kiro_bonus"),
    copy("limits.label.grok_month"),
    copy("limits.label.grok_week"),
    copy("limits.label.grok_day"),
    copy("limits.label.grok_ondemand"),
    copy("limits.label.grok_build"),
    copy("limits.label.grok_bot"),
    copy("limits.label.grok_chat"),
    copy("limits.label.grok_imagine"),
    copy("limits.label.grok_voice"),
    copy("limits.label.grok_cursor"),
    copy("limits.label.antigravity_claude_weekly"),
    copy("limits.label.antigravity_claude_5h"),
    copy("limits.label.antigravity_gemini_weekly"),
    copy("limits.label.antigravity_gemini_5h"),
    copy("limits.label.copilot_premium"),
    copy("limits.label.copilot_chat"),
    copy("limits.label.zcode_glm52"),
    copy("limits.label.zcode_glm5t"),
    copy("limits.label.zcode_5h"),
    copy("limits.label.zcode_weekly"),
    copy("limits.label.zcode_tools"),
    copy("limits.label.opencode_go_5h"),
    copy("limits.label.opencode_go_weekly"),
    copy("limits.label.opencode_go_monthly"),
    copy("limits.label.qoder_credits"),
    copy("limits.label.qoder_ultimate"),
    copy("limits.label.qoder_cn_credits"),
    copy("limits.label.qoder_cn_addon_credits"),
    copy("limits.label.qoder_cn_ultimate"),
    copy("limits.label.command_code_5h"),
    copy("limits.label.command_code_weekly"),
    copy("limits.label.ark_coding_plan_5h"),
    copy("limits.label.ark_coding_plan_weekly"),
    copy("limits.label.ark_coding_plan_monthly"),
    copy("limits.label.ark_agent_plan_5h"),
    copy("limits.label.ark_agent_plan_weekly"),
    copy("limits.label.ark_agent_plan_monthly"),
    copy("limits.label.devin_daily"),
    copy("limits.label.devin_weekly"),
    copy("limits.label.workbuddy_plan"),
    copy("limits.label.workbuddy_addon"),
  ];
}
