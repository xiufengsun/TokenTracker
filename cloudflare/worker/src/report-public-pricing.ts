import {coveredRowCost,isFreeGrok} from "./report-cost-provenance";
import {
  MODEL_PRICING,
  IFLYTEK_MAAS_MODEL_PRICING,
  ZERO_PRICING,
  normalizeIFlytekMaasModel,
} from "./report-pricing";
import type { UsageRow } from "./report-usage";

// Production public leaderboard and profile share this pricing version. The
// account reports use newer rates. Keep historical public cost calculations stable.
const PUBLIC_MODEL_PRICING = { ...MODEL_PRICING };
for (const model of [
  "claude-fable-5-2",
  "claude-fable-5.2",
  "anthropic/claude-fable-5.2",
  "anthropic/claude-fable-5.2-20261109",
  "anthropic/claude-fable-5-2",
  "claude-fable-5-2-fast",
  "claude-fable-5.2-fast",
  "claude-opus-4-5",
  "claude-haiku-5-5",
  "claude-haiku-5.5",
  "gpt-5.3-codex-spark",
  "gpt-6.1-terra",
  "gpt-6-luna",
  "gemini-3.5-flash",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "kimi-k3.1-pro",
  "kimi-k3.1-pro-highspeed",
  "k3.1-pro",
  "k3.1pro",
  "k3.1-pro-highspeed",
  "k3.1pro-highspeed",
  "grok-4.7",
  "grok-4.7-build-fast",
  "qwen3.8-max",
  "qwen3.8-max-0902",
  "qwen3.8-max-2026-09-02",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor",
  "muse-spark-1.3-contributor",
])
  delete PUBLIC_MODEL_PRICING[model];
function getModelPricing(model: string, source = "") {
  if (!model) return ZERO_PRICING;
  if (
    source.toLowerCase() === "workbuddy-ai" &&
    model.trim().toLowerCase() === "auto"
  )
    return ZERO_PRICING;
  if (source.toLowerCase() === "acode") {
    const normalized = normalizeIFlytekMaasModel(model);
    if (normalized === "auto" || normalized.endsWith("-auto"))
      return ZERO_PRICING;
    const iFlytekMaasPricing = IFLYTEK_MAAS_MODEL_PRICING[normalized];
    if (iFlytekMaasPricing) return iFlytekMaasPricing;
  }
  const exact = PUBLIC_MODEL_PRICING[model];
  if (exact) return exact;
  const lower = model.toLowerCase();
  if (/(?:^|[-/:_\s.(])(?:batch|flex)(?:$|[-/:_\s.)])/.test(lower)) return ZERO_PRICING;
  if (source === "cline" && lower.endsWith(":free")) return ZERO_PRICING;
  if (lower.includes("cline-free/") || lower.includes("cline-pass/"))
    return ZERO_PRICING;
  const gpt62 = lower.trim().match(/gpt-6[.-]2(?:-(.*))?$/);
  if (gpt62) {
    const known =
      /^(astra-law|astra|sol)(?:-?(?:low|medium|high|xhigh|max)(?:-fast)?|-fast)?$/.exec(
        gpt62[1] || "",
      );
    return known ? PUBLIC_MODEL_PRICING[`gpt-6.2-${known[1]}`] : ZERO_PRICING;
  }
  if (/(?:^|\/)claude-mythos-(?:latest|preview)(?:$|[^a-z0-9])/.test(lower))
    return ZERO_PRICING;
  const mythosKey = lower.replace(/[^a-z0-9./]+/g, "-");
  if (/mythos-5[.-]2-fast(?:$|[^0-9])/.test(mythosKey))
    return PUBLIC_MODEL_PRICING["claude-mythos-5-2-fast"];
  if (/mythos-5[.-]2(?:$|[^0-9])/.test(mythosKey))
    return PUBLIC_MODEL_PRICING["claude-mythos-5-2"];
  if (/mythos-5[.-]1(?:$|[^0-9])/.test(mythosKey))
    return PUBLIC_MODEL_PRICING["claude-mythos-5-1"];
  if (/mythos-5(?:$|[^0-9.-])/.test(mythosKey))
    return PUBLIC_MODEL_PRICING["claude-mythos-5"];
  if (lower.includes("fable")) return PUBLIC_MODEL_PRICING["claude-fable-5"];
  if (/opus-5[.-]5(?:$|[^0-9.])/.test(lower))
    return PUBLIC_MODEL_PRICING["claude-opus-5-5"];
  if (/sonnet-5[.-]5(?:$|[^0-9.])/.test(lower))
    return PUBLIC_MODEL_PRICING["claude-sonnet-5-5"];
  if (/sonnet-5(?:$|[^0-9.-])/.test(lower))
    return PUBLIC_MODEL_PRICING["claude-sonnet-5"];
  if (lower.includes("opus-5-fast"))
    return PUBLIC_MODEL_PRICING["claude-opus-5-fast"];
  if (lower.includes("opus-5")) return PUBLIC_MODEL_PRICING["claude-opus-5"];
  if (lower.includes("opus")) return PUBLIC_MODEL_PRICING["claude-opus-4-6"];
  if (lower.includes("haiku"))
    return PUBLIC_MODEL_PRICING["claude-haiku-4-5-20251001"];
  if (lower.includes("sonnet"))
    return PUBLIC_MODEL_PRICING["claude-sonnet-4-6"];
  if (lower.includes("gpt-6-astra")) return PUBLIC_MODEL_PRICING["gpt-6-astra"];
  if (lower.includes("gpt-6-sol")) return PUBLIC_MODEL_PRICING["gpt-6-sol"];
  if (lower.includes("gpt-6.1-sol")) return PUBLIC_MODEL_PRICING["gpt-6.1-sol"];
  if (lower.includes("gpt-5.6-sol")) return PUBLIC_MODEL_PRICING["gpt-5.6-sol"];
  if (lower.includes("gpt-5.6-terra"))
    return PUBLIC_MODEL_PRICING["gpt-5.6-terra"];
  if (lower.includes("gpt-5.6-luna"))
    return PUBLIC_MODEL_PRICING["gpt-5.6-luna"];
  if (lower.includes("gpt-5.6")) return PUBLIC_MODEL_PRICING["gpt-5.6-sol"];
  if (lower.includes("gpt-5.4-pro")) return PUBLIC_MODEL_PRICING["gpt-5.4-pro"];
  if (lower.includes("gpt-5.4")) return PUBLIC_MODEL_PRICING["gpt-5.4"];
  if (lower.includes("gpt-5.5")) return PUBLIC_MODEL_PRICING["gpt-5.5"];
  if (lower.includes("gpt-5-mini")) return PUBLIC_MODEL_PRICING["gpt-5-mini"];
  if (lower.includes("gpt-5.3")) return PUBLIC_MODEL_PRICING["gpt-5.3-codex"];
  if (lower.includes("gpt-5.2")) return PUBLIC_MODEL_PRICING["gpt-5.2"];
  if (lower.includes("gpt-5.1-codex-mini"))
    return PUBLIC_MODEL_PRICING["gpt-5.1-codex-mini"];
  if (lower.includes("gpt-5.1")) return PUBLIC_MODEL_PRICING["gpt-5.1-codex"];
  if (lower.includes("gpt-5")) return PUBLIC_MODEL_PRICING["gpt-5"];
  if (lower.includes("gemini-4-argon") || lower.includes("gemini-4.argon"))
    return PUBLIC_MODEL_PRICING["gemini-4-argon"];
  const gemini4 = lower
    .trim()
    .match(
      /(?:^|\/)gemini-4[.-](carbon|hydrogen|neon)(?:-(?:minimal|low|medium|high|xhigh))?$/,
    );
  if (gemini4) return PUBLIC_MODEL_PRICING[`gemini-4-${gemini4[1]}`];
  if (
    /(?:^|\/)muse-wonder-1[.-]0(?:-(?:minimal|low|medium|high|xhigh|extra-high|max))?$/.test(
      lower,
    )
  )
    return PUBLIC_MODEL_PRICING["muse-wonder-1.0"];

  if (lower.includes("gemini-3") && lower.includes("pro"))
    return PUBLIC_MODEL_PRICING["gemini-3-pro-preview"];
  if (lower.includes("gemini-3"))
    return PUBLIC_MODEL_PRICING["gemini-3-flash-preview"];
  if (lower.includes("gemini-2.5"))
    return PUBLIC_MODEL_PRICING["gemini-2.5-pro"];
  if (lower.includes("minimax-m3")) return PUBLIC_MODEL_PRICING["minimax-m3"];
  if (lower.includes("minimax-m2.7-highspeed"))
    return PUBLIC_MODEL_PRICING["MiniMax-M2.7-highspeed"];
  if (lower.includes("minimax-m2.7"))
    return PUBLIC_MODEL_PRICING["MiniMax-M2.7"];
  if (lower.includes("deepseek-v4.1-flash"))
    return PUBLIC_MODEL_PRICING["deepseek-v4.1-flash"];
  if (lower.includes("deepseek-flash"))
    return PUBLIC_MODEL_PRICING["deepseek-flash"];
  if (lower.includes("deepseek-v4-flash"))
    return PUBLIC_MODEL_PRICING["deepseek-v4-flash"];
  if (lower.includes("deepseek-v4-pro"))
    return PUBLIC_MODEL_PRICING["deepseek-v4-pro"];
  if (lower.includes("deepseek-reasoner"))
    return PUBLIC_MODEL_PRICING["deepseek-reasoner"];
  if (lower.includes("deepseek-chat"))
    return PUBLIC_MODEL_PRICING["deepseek-chat"];
  if (lower.includes("grok-4.7") && lower.includes("fast"))
    return PUBLIC_MODEL_PRICING["cursor-grok-4.7-fast"];
  if (lower.includes("grok-4.7"))
    return PUBLIC_MODEL_PRICING["cursor-grok-4.7"];
  if (lower.includes("grok-4.6") && lower.includes("fast"))
    return PUBLIC_MODEL_PRICING["cursor-grok-4.6-fast"];
  if (lower.includes("grok-4.6"))
    return PUBLIC_MODEL_PRICING["cursor-grok-4.6"];
  if (lower.includes("grok-4.5") && lower.includes("fast"))
    return PUBLIC_MODEL_PRICING["cursor-grok-4.5-fast"];
  if (lower.includes("grok-4.5"))
    return PUBLIC_MODEL_PRICING["cursor-grok-4.5"];
  if (lower.includes("grok-build")) return PUBLIC_MODEL_PRICING["grok-build"];
  if (lower.includes("grok-4-fast")) return PUBLIC_MODEL_PRICING["grok-4-fast"];
  if (lower.includes("grok-4-1-fast"))
    return PUBLIC_MODEL_PRICING["grok-4-1-fast-non-reasoning"];
  if (lower.includes("grok-4")) return PUBLIC_MODEL_PRICING["grok-4"];
  if (lower.includes("kimi-k3")) return PUBLIC_MODEL_PRICING["kimi-k3"];
  if (lower === "k3" || lower.endsWith("/k3"))
    return PUBLIC_MODEL_PRICING["kimi-k3"];
  if (lower.includes("kimi-k2.7-code"))
    return PUBLIC_MODEL_PRICING["kimi-k2.7-code"];
  if (lower.includes("kimi-k2.6")) return PUBLIC_MODEL_PRICING["kimi-k2.6"];
  if (lower.includes("kimi")) return PUBLIC_MODEL_PRICING["kimi-k2.5"];
  if (lower.includes("mimo-v2-pro-free"))
    return PUBLIC_MODEL_PRICING["mimo-v2-pro-free"];
  if (lower.includes("mimo-v2.5-pro"))
    return PUBLIC_MODEL_PRICING["mimo-v2.5-pro"];
  if (lower.includes("mimo-v2.5")) return PUBLIC_MODEL_PRICING["mimo-v2.5"];
  if (lower.includes("mimo-v2-flash"))
    return PUBLIC_MODEL_PRICING["mimo-v2-flash"];
  if (lower.includes("glm-4.5-airx"))
    return PUBLIC_MODEL_PRICING["glm-4.5-airx"];
  if (lower.includes("glm-4.5-air")) return PUBLIC_MODEL_PRICING["glm-4.5-air"];
  if (lower.includes("glm-4.5-x")) return PUBLIC_MODEL_PRICING["glm-4.5-x"];
  if (lower.includes("glm-4.5-flash"))
    return PUBLIC_MODEL_PRICING["glm-4.5-flash"];
  if (lower.includes("glm-4.5")) return PUBLIC_MODEL_PRICING["glm-4.5"];
  if (lower.includes("glm-4.7-flashx"))
    return PUBLIC_MODEL_PRICING["glm-4.7-flashx"];
  if (lower.includes("glm-4.7-flash"))
    return PUBLIC_MODEL_PRICING["glm-4.7-flash"];
  if (lower.includes("glm-4.7")) return PUBLIC_MODEL_PRICING["glm-4.7"];
  if (lower.includes("glm-4.6")) return PUBLIC_MODEL_PRICING["glm-4.6"];
  if (lower.includes("glm-5.3-flash"))
    return PUBLIC_MODEL_PRICING["glm-5.3-flash"];
  if (lower.includes("glm-5.3")) return PUBLIC_MODEL_PRICING["glm-5.3"];
  if (lower.includes("glm-5-turbo")) return PUBLIC_MODEL_PRICING["glm-5-turbo"];
  if (lower.includes("glm-5.2")) return PUBLIC_MODEL_PRICING["glm-5.2"];
  if (lower.includes("glm-5.1")) return PUBLIC_MODEL_PRICING["glm-5.1"];
  if (lower.includes("glm-5")) return PUBLIC_MODEL_PRICING["glm-5"];
  if (lower.includes("kiro")) return PUBLIC_MODEL_PRICING["kiro-cli-agent"];
  if (lower.includes("hy3")) return PUBLIC_MODEL_PRICING["hy3-preview-agent"];
  if (/(?:^|\/)qwen3[.-]8-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(lower.trim()))
    return PUBLIC_MODEL_PRICING["qwen3.8-flash"];
  if (/(?:^|\/)qwen4-max(?:-\d{4}-\d{2}-\d{2})?$/.test(lower.trim()))
    return PUBLIC_MODEL_PRICING["qwen4-max"];
  if (lower.includes("hy4")) return PUBLIC_MODEL_PRICING["hy4-preview"];
  if (lower.includes("composer-2.5") && lower.includes("fast"))
    return PUBLIC_MODEL_PRICING["composer-2.5-fast"];
  if (lower.includes("composer-2.5"))
    return PUBLIC_MODEL_PRICING["composer-2.5"];
  if (lower.includes("composer-2-fast"))
    return PUBLIC_MODEL_PRICING["composer-2-fast"];
  if (lower.includes("composer-2")) return PUBLIC_MODEL_PRICING["composer-2"];
  if (lower.includes("composer-1.5"))
    return PUBLIC_MODEL_PRICING["composer-1.5"];
  if (lower.includes("composer")) return PUBLIC_MODEL_PRICING["composer-1"];
  if (lower.includes("fugu")) return PUBLIC_MODEL_PRICING["sakana/fugu-ultra"];
  if (lower.includes("longcat")) return PUBLIC_MODEL_PRICING["longcat-2.0"];
  if (lower.includes("step-3.7-flash"))
    return PUBLIC_MODEL_PRICING["step-3.7-flash"];
  if (lower.includes("step-3.5-flash"))
    return PUBLIC_MODEL_PRICING["step-3.5-flash"];
  if (lower.includes("stepfun")) return PUBLIC_MODEL_PRICING["step-3.7-flash"];
  if (lower === "auto") return PUBLIC_MODEL_PRICING["composer-1"];
  return ZERO_PRICING;
}
function getRowPricing(row: {
  model?: string;
  source?: string;
  pricing_tier?: string;
  hour_start?: string;
}) {
  const pricing = getModelPricing(row.model || "", row.source);
  if ((row.source || "").toLowerCase() === "acode") return pricing;
  const lower = String(row.model || "").toLowerCase();
  if (
    !lower.includes("deepseek-v4-flash") &&
    !lower.includes("deepseek-v4.1-flash") &&
    !lower.includes("deepseek-flash") &&
    !lower.includes("deepseek-v4-pro")
  )
    return pricing;
  let offPeak = row.pricing_tier === "off_peak";
  if (!row.pricing_tier && row.hour_start) {
    const timestamp = Date.parse(row.hour_start);
    if (Number.isFinite(timestamp)) {
      const hour = new Date(timestamp).getUTCHours();
      offPeak = !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
      if (timestamp >= Date.UTC(2026, 7, 22, 16, 0, 0)) {
        const beijingDay = new Date(timestamp + 8 * 60 * 60 * 1e3).getUTCDay();
        if (beijingDay === 0 || beijingDay === 6) offPeak = true;
      }
    }
  }
  if (!offPeak) return pricing;
  return {
    input: pricing.input * 0.5,
    output: pricing.output * 0.5,
    cache_read: pricing.cache_read * 0.5,
    cache_write: (pricing.cache_write || 0) * 0.5,
  };
}
export function publicRowCost(row: UsageRow) {
  if (isFreeGrok(row)) return 0;
  if (row.cost_provenance) return coveredRowCost(row, publicRowCost)!;
  if (row.source === "cursor" && /^grok-bot-/i.test(row.model)) return 0;
  if (row.source === "lmstudio") return 0;
  if (row.source === "pi-github-copilot" || row.source === "pi-copilot")
    return 0;
  const reportedCost = Number(row.total_cost_usd);
  if (
    (row.source === "grok" || row.source === "cline") &&
    Number.isFinite(reportedCost) &&
    reportedCost > 0
  )
    return reportedCost;
  const rawModel = String(row.model || "").trim();
  const unslothUnpriced =
    row.source === "unsloth" && /^(local|unpriced)\//i.test(rawModel);
  const modelForPricing = unslothUnpriced
    ? "__tokentracker_unpriced_unsloth_model__"
    : row.source === "workbuddy" && rawModel.toLowerCase() === "auto"
      ? "hy3-preview-agent"
      : rawModel;
  const p = getRowPricing({ ...row, model: modelForPricing });
  const reasoningIncludedInOutput =
    row.source === "codex" ||
    row.source === "acode" ||
    row.source === "every-code" ||
    row.source === "cline" ||
    row.source === "omo";
  const reasoningCost = reasoningIncludedInOutput
    ? 0
    : (row.reasoning_output_tokens || 0) * (p.output || 0);
  return (
    ((row.input_tokens || 0) * (p.input || 0) +
      (row.output_tokens || 0) * (p.output || 0) +
      (row.cached_input_tokens || 0) * (p.cache_read || 0) +
      (row.cache_creation_input_tokens || 0) * (p.cache_write || 0) +
      reasoningCost) /
    1e6
  );
}
