import { toFiniteNumber } from "./format";

type AnyRecord = Record<string, any>;

function normalizeModelId(value: any) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function resolveModelId(model: any) {
  const id = normalizeModelId(model?.model_id);
  if (id) return id;
  return null;
}

function resolveModelName(model: any, fallback: any) {
  if (model?.model) return String(model.model);
  return fallback;
}

function buildBareModelNameIndex(models: any[]) {
  const bareNames = new Map();
  const weights = new Map();
  for (const model of models) {
    const name = typeof model?.name === "string" ? model.name.trim() : "";
    const key = normalizeModelId(name);
    if (!key || key.includes("/")) continue;
    const weight = Math.max(0, toFiniteNumber(model?.weight) ?? 0);
    if (!bareNames.has(key) || weight >= (weights.get(key) || 0)) {
      bareNames.set(key, name);
      weights.set(key, weight);
    }
  }
  return bareNames;
}

function resolveAggregateModelIdentity(name: string, bareNames: Map<string, string>) {
  const normalized = normalizeModelId(name);
  if (!normalized) return null;
  const slash = normalized.lastIndexOf("/");
  if (slash > 0) {
    const suffix = normalized.slice(slash + 1);
    if (bareNames.has(suffix)) {
      return { key: suffix, name: bareNames.get(suffix) };
    }
  }
  return { key: normalized, name };
}

export function resolveDisplayTokens(totals: any, fallback = 0) {
  const billableTokens = toFiniteNumber(totals?.billable_total_tokens);
  const totalTokens = toFiniteNumber(totals?.total_tokens);
  if (billableTokens != null && billableTokens > 0) return billableTokens;
  if (totalTokens != null && totalTokens > 0) return totalTokens;
  return billableTokens ?? totalTokens ?? fallback;
}

// Deprecated source names folded into their canonical spelling at display
// time. "deepseek" was the first dsh-integration source name; it was renamed
// to "dsh", but a cloud upload from before the rename still carries the old
// name. Folding it back keeps one "DeepSeek Harness" provider instead of two
// ("DEEPSEEK" + "DeepSeek Harness"). This only changes presentation; the
// underlying cloud rows are not rewritten.
const SOURCE_ALIASES: Record<string, string> = {
  deepseek: "dsh",
};

function canonicalSource(source: any): string {
  const raw = typeof source === "string" ? source : "";
  return SOURCE_ALIASES[raw] || raw;
}

const TOKEN_TOTAL_KEYS = [
  "total_tokens",
  "billable_total_tokens",
  "input_tokens",
  "unclassified_input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_output_tokens",
];

function addTotalsInto(target: any, add: any) {
  if (add?.cost_status === "partial" || Number(add?.unclassified_input_tokens) > 0) target.cost_status = "partial";
  for (const key of TOKEN_TOTAL_KEYS) {
    target[key] = (Number(target[key]) || 0) + (Number(add?.[key]) || 0);
  }
  target.total_cost_usd = String(
    Number(target.total_cost_usd || 0) + Number(add?.total_cost_usd || 0),
  );
}

function emptyTotals() {
  return {
    total_tokens: 0,
    billable_total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_cost_usd: "0",
  };
}

// Merge API sources whose canonical name collides after alias resolution
// (e.g. a stale "deepseek" plus the current "dsh"), summing totals and
// combining per-model rows keyed by model id.
function mergeSourcesByAlias(sources: any[]) {
  const bySource = new Map();
  for (const entry of sources || []) {
    const source = canonicalSource(entry?.source);
    if (!source) continue;
    let merged = bySource.get(source);
    if (!merged) {
      merged = { source, source_scope: entry?.source_scope, totals: emptyTotals(), models: new Map() };
      bySource.set(source, merged);
    }
    addTotalsInto(merged.totals, entry?.totals);
    for (const model of Array.isArray(entry?.models) ? entry.models : []) {
      const id = model?.model_id || model?.model || "";
      if (!id) continue;
      let modelRow = merged.models.get(id);
      if (!modelRow) {
        modelRow = { model: model?.model || id, model_id: id, totals: emptyTotals() };
        merged.models.set(id, modelRow);
      }
      addTotalsInto(modelRow.totals, model?.totals);
    }
  }
  return Array.from(bySource.values()).map((s) => ({
    ...s,
    models: Array.from(s.models.values()),
  }));
}

export function buildFleetData(modelBreakdown: any, { copyFn }: AnyRecord = {}) {
  const safeCopy = typeof copyFn === "function" ? copyFn : (key: string) => key;
  const sources: any[] = mergeSourcesByAlias(
    Array.isArray(modelBreakdown?.sources) ? modelBreakdown.sources : [],
  );
  const normalizedSources = sources
    .map((entry: any) => {
      const totalTokens = resolveDisplayTokens(entry?.totals);
      const totalCost = toFiniteNumber(entry?.totals?.total_cost_usd) ?? 0;
      return {
        source: entry?.source,
        totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
        totalCost: Number.isFinite(totalCost) ? totalCost : 0,
        costPartial: entry?.totals?.cost_status === "partial",
        inputTokens: Math.max(0, toFiniteNumber(entry?.totals?.input_tokens) ?? 0),
        cacheRead: Math.max(0, toFiniteNumber(entry?.totals?.cached_input_tokens) ?? 0),
        cacheCreate: Math.max(0, toFiniteNumber(entry?.totals?.cache_creation_input_tokens) ?? 0),
        models: Array.isArray(entry?.models) ? entry.models : [],
      };
    })
    .filter((entry) => entry.totalTokens > 0);

  if (!normalizedSources.length) return [];

  const grandTotal = normalizedSources.reduce((acc, entry) => acc + entry.totalTokens, 0);
  const pricingMode =
    typeof modelBreakdown?.pricing?.pricing_mode === "string"
      ? modelBreakdown.pricing.pricing_mode.toUpperCase()
      : null;

  return normalizedSources
    .slice()
    .sort((a: any, b: any) => b.totalTokens - a.totalTokens)
    .map((entry: any) => {
      const label = entry.source
        ? String(entry.source).toUpperCase()
        : safeCopy("shared.placeholder.short");
      const totalPercentRaw = grandTotal > 0 ? (entry.totalTokens / grandTotal) * 100 : 0;
      const totalPercent = Number.isFinite(totalPercentRaw) ? totalPercentRaw.toFixed(2) : "0.00";
      const models = entry.models
        .map((model: any) => {
          const modelTokens = resolveDisplayTokens(model?.totals);
          if (!Number.isFinite(modelTokens) || modelTokens <= 0) return null;
          const share =
            entry.totalTokens > 0 ? Math.round((modelTokens / entry.totalTokens) * 1000) / 10 : 0;
          const name = resolveModelName(model, safeCopy("shared.placeholder.short"));
          const id = resolveModelId(model);
          const explicitModelCost = toFiniteNumber(model?.totals?.total_cost_usd);
          const modelCost =
            explicitModelCost != null
              ? explicitModelCost
              : entry.totalCost > 0 && entry.totalTokens > 0
                ? (modelTokens / entry.totalTokens) * entry.totalCost
                : null;
          const costPartial = model?.totals?.cost_status === "partial";
          return { id, name, share, usage: modelTokens, cost: costPartial ? null : modelCost, ...(costPartial ? {costPartial: true} : {}) };
        })
        .filter(Boolean);
      // Input-side cache hit rate = cache reads / all input-side tokens
      // (non-cached input + cache reads + cache writes). cached_input_tokens are
      // reads, cache_creation_input_tokens are writes. null when the source does
      // no caching at all (e.g. Gemini/Antigravity report neither) so the UI omits
      // the line instead of showing a meaningless 0%.
      const cacheInputTokens = entry.inputTokens + entry.cacheRead + entry.cacheCreate;
      const hasCacheActivity = entry.cacheRead + entry.cacheCreate > 0;
      const cacheHitRate =
        !entry.costPartial && hasCacheActivity && cacheInputTokens > 0
          ? Math.round((entry.cacheRead / cacheInputTokens) * 100)
          : null;
      return {
        source: entry.source,
        label,
        totalPercent: String(totalPercent),
        totalPercentValue: totalPercentRaw,
        usd: entry.costPartial ? null : entry.totalCost,
        ...(entry.costPartial ? {costPartial: true} : {}),
        usage: entry.totalTokens,
        cacheHitRate,
        cacheReusedTokens: entry.cacheRead,
        cacheInputTokens,
        models,
      };
    });
}

/**
 * Flatten the provider-oriented fleet data into one personal model ranking.
 * The same model name can be emitted by several tools, so names are matched
 * case-insensitively and their token/cost totals are combined before ranking.
 */
export function buildAllModels(fleetData: any) {
  const providers: any[] = Array.isArray(fleetData) ? fleetData : [];
  const byModel = new Map();
  const modelRows = [];

  for (const provider of providers) {
    const models: any[] = Array.isArray(provider?.models) ? provider.models : [];
    for (const model of models) {
      const usage = toFiniteNumber(model?.usage);
      if (usage == null || usage <= 0) continue;
      const name = typeof model?.name === "string" && model.name.trim()
        ? model.name.trim()
        : typeof model?.id === "string" && model.id.trim()
          ? model.id.trim()
          : null;
      if (!name) continue;
      modelRows.push({ model, name, usage });
    }
  }

  const bareNames = buildBareModelNameIndex(
    modelRows.map((row) => ({ name: row.name, weight: row.usage })),
  );

  for (const { model, name, usage } of modelRows) {
    const identity = resolveAggregateModelIdentity(name, bareNames);
    if (!identity) continue;
    const { key } = identity;
    const current = byModel.get(key) || {
      id: key,
      name: identity.name,
      usage: 0,
      cost: 0,
      hasCost: false,
      nameWeight: 0,
    };
    current.usage += usage;
    current.costPartial = current.costPartial || model.costPartial;
    const cost = toFiniteNumber(model?.cost);
    if (cost != null) {
      current.cost += cost;
      current.hasCost = true;
    }
    // Preserve the spelling from the source that contributes the most.
    if (bareNames.has(key)) {
      current.name = bareNames.get(key);
    } else if (usage >= current.nameWeight) {
      current.name = name;
      current.nameWeight = usage;
    }
    byModel.set(key, current);
  }

  const totalUsage = Array.from(byModel.values())
    .reduce((sum, model) => sum + model.usage, 0);

  return Array.from(byModel.values())
    .map((model) => ({
      id: model.id,
      name: model.name,
      usage: model.usage,
      cost: model.costPartial ? null : model.hasCost ? model.cost : null,
      ...(model.costPartial ? {costPartial: true} : {}),
      share: totalUsage > 0
        ? Math.round((model.usage / totalUsage) * 1000) / 10
        : 0,
    }))
    .sort((a, b) => {
      if (b.usage !== a.usage) return b.usage - a.usage;
      return String(a.name).localeCompare(String(b.name));
    });
}

export function buildTopModels(modelBreakdown: any, { limit = 3, copyFn }: AnyRecord = {}) {
  const safeCopy = typeof copyFn === "function" ? copyFn : (key: string) => key;
  const sources: any[] = Array.isArray(modelBreakdown?.sources) ? modelBreakdown.sources : [];
  if (!sources.length) return [];

  const totalsByKey = new Map();
  const nameByKey = new Map();
  const nameWeight = new Map();
  const modelRows = [];
  let totalTokensAll = 0;

  for (const source of sources) {
    const models: any[] = Array.isArray(source?.models) ? source.models : [];
    for (const model of models) {
      const tokens = resolveDisplayTokens(model?.totals);
      if (!Number.isFinite(tokens) || tokens <= 0) continue;
      totalTokensAll += tokens;
      const name = resolveModelName(model, safeCopy("shared.placeholder.short"));
      modelRows.push({ name, tokens });
    }
  }

  const bareNames = buildBareModelNameIndex(
    modelRows.map((row) => ({ name: row.name, weight: row.tokens })),
  );
  for (const { name, tokens } of modelRows) {
      const identity = resolveAggregateModelIdentity(name, bareNames);
      if (!identity) continue;
      const { key } = identity;
      totalsByKey.set(key, (totalsByKey.get(key) || 0) + tokens);
      if (bareNames.has(key)) {
        nameByKey.set(key, bareNames.get(key));
      } else if (tokens >= (nameWeight.get(key) || 0)) {
        nameWeight.set(key, tokens);
        nameByKey.set(key, name);
      }
  }

  if (!totalsByKey.size) return [];

  const knownTotal = Array.from(totalsByKey.values()).reduce((acc, value) => acc + value, 0);
  const totalTokens = totalTokensAll > 0 ? totalTokensAll : knownTotal;

  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 3;
  return Array.from(totalsByKey.entries())
    .map(([key, tokens]) => {
      const percent = totalTokens > 0 ? ((tokens / totalTokens) * 100).toFixed(1) : "0.0";
      return {
        id: key,
        name: nameByKey.get(key) || safeCopy("shared.placeholder.short"),
        tokens,
        percent: String(percent),
      };
    })
    .sort((a, b) => {
      if (b.tokens !== a.tokens) return b.tokens - a.tokens;
      return String(a.name).localeCompare(String(b.name));
    })
    .slice(0, normalizedLimit);
}
