import type { createClient } from "npm:@insforge/sdk";

export const COST_TOKEN_FIELDS = ["input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens"] as const;
const UPLOAD_ORIGINS = ["grok_ticks", "grok_usd", "grok_allocated", "cursor_csv_cost", "cursor_total_cents"];
const CLOUD_ORIGINS = new Set([...UPLOAD_ORIGINS, "legacy_grok_total_cost_usd"]);
type Tokens = Record<typeof COST_TOKEN_FIELDS[number], number>;
type CostRow = { source?: string; model?: string; bucket?: string; user_id?: string; pricing_tier?: string;
  total_cost_usd?: unknown; cost_provenance?: CloudCostProvenance } & Partial<Record<typeof COST_TOKEN_FIELDS[number], unknown>>;
export type CloudCostProvenance = { version: 1; reported_usd: number; covered_tokens: Tokens;
  has_reported: boolean; has_missing: boolean; has_allocated: boolean; origins: string[] };
const failure = () => new Error("Cost provenance inventory unavailable; retry after data refresh");
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isAmount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
export const isCostProvenanceModel = (row: CostRow) => row.source === "grok" || (row.source === "cursor" && /^grok-bot-/i.test(row.model || ""));
export function isFreeGrok(row: CostRow): boolean {
  const model = String(row.model || "").toLowerCase();
  return row.source === "grok" && (model.includes("build-free") || model.includes("free-tier") || model.endsWith("-free"));
}

// Strict, bounded allowlist: never persist arbitrary nested event objects.
export function uploadCostCoverage(value: unknown, row: Record<string, unknown>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
  const v = value as Record<string, unknown>;
  if (!hasExactKeys(v, ["version", "reported_usd", "reported_events", "missing_events", "allocated_events", "origins", "unreported_tokens"])
    || v.version !== 1 || !isCostProvenanceModel(row as CostRow) || !isAmount(v.reported_usd)
    || !isCount(v.reported_events) || !isCount(v.missing_events) || !isCount(v.allocated_events)
    || v.allocated_events > v.reported_events || (v.reported_events === 0 && v.reported_usd !== 0)
    || (v.allocated_events > 0 && !(Array.isArray(v.origins) && v.origins.includes("grok_allocated")))
    || !Array.isArray(v.origins) || v.origins.length > UPLOAD_ORIGINS.length || new Set(v.origins).size !== v.origins.length
    || (v.reported_events > 0 && v.origins.length === 0)
    || v.origins.some(origin => typeof origin !== "string" || !UPLOAD_ORIGINS.includes(origin)
      || !origin.startsWith(row.source === "cursor" ? "cursor_" : "grok_"))
    || !v.unreported_tokens || typeof v.unreported_tokens !== "object" || Array.isArray(v.unreported_tokens)) throw failure();
  const uncovered = v.unreported_tokens as Record<string, unknown>;
  if (!hasExactKeys(uncovered, COST_TOKEN_FIELDS)) throw failure();
  for (const key of COST_TOKEN_FIELDS) {
    const n = uncovered[key], total = row[key] ?? 0;
    if (!isCount(n) || !isCount(total) || n > total || (v.missing_events === 0 && n !== 0)
      || (v.reported_events === 0 && n !== total)) throw failure();
  }
  const usd = row.total_cost_usd ?? 0;
  if (!isAmount(usd) || Math.abs(usd - v.reported_usd) > 1e-8) throw failure();
  return { version: 1, reported_usd: v.reported_usd, reported_events: v.reported_events, missing_events: v.missing_events,
    allocated_events: v.allocated_events, origins: [...v.origins], unreported_tokens: { ...uncovered } };
}

// This side wire is additive: old compact/token RPCs are not repacked or guessed.
// Its basis must exactly match the recipient inventory before any subtraction.
export async function attachCloudCostProvenance<T extends object>(
  client: ReturnType<typeof createClient>, rows: T[], args: Record<string, unknown>, allowPartial = false,
): Promise<(T & { cost_provenance?: CloudCostProvenance })[]> {
  const relevant = rows.filter(r => isCostProvenanceModel(r as CostRow));
  if (!relevant.length) return rows;
  const parameters = { p_user_id: null, p_device_id: null, p_trunc: "all", p_tz: null, p_offset_min: null,
    p_user_from: null, p_user_to: null, p_range_from: null, p_range_to: null, ...args };
  const result = await Promise.resolve(client.database.rpc("usage_cost_provenance_v1", parameters)).catch(() => null);
  const data = result?.data;
  if (!result || result.error || !data || data.version !== 1 || !Array.isArray(data.rows)) {
    if (!allowPartial) throw failure();
    console.warn("Account cost inventory unavailable");
    return rows;
  }
  const includeUser = parameters.p_user_id == null;
  const keyOf = (r: CostRow) => JSON.stringify([includeUser ? r.user_id : "", r.bucket || "", r.source, r.model, r.pricing_tier || "peak"]);
  const inventory = new Map<string, CostRow>();
  const duplicateKeys = new Set<string>();
  for (const r of relevant) {
    const key = keyOf(r as CostRow);
    if (inventory.has(key)) duplicateKeys.add(key);
    inventory.set(key, r as CostRow);
  }
  const evidence = new Map<string, CloudCostProvenance>();
  const seen = new Set<string>();
  function invalid() {
    if (!allowPartial) throw failure();
  }
  for (const raw of data.rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid();
      continue;
    }
    const key = keyOf(raw), row = inventory.get(key);
    if (seen.has(key)) {
      invalid();
      evidence.delete(key);
      continue;
    }
    seen.add(key);
    if (!row || duplicateKeys.has(key) || (parameters.p_user_id != null && raw.user_id !== parameters.p_user_id)
      || raw.ambiguous !== false || !isAmount(raw.reported_usd) || !raw.basis || !raw.covered_tokens
      || ![raw.has_reported, raw.has_missing, raw.has_allocated].every(v => typeof v === "boolean")
      || (!raw.has_reported && (raw.reported_usd !== 0 || raw.has_allocated))
      || !Array.isArray(raw.origins) || raw.origins.some(v => !CLOUD_ORIGINS.has(v))) {
      invalid();
      continue;
    }
    const covered = {} as Tokens;
    const matchesBasis = COST_TOKEN_FIELDS.every(field => {
      const total = row[field] ?? 0;
      const n = raw.covered_tokens[field];
      if ((typeof total === "string" && !total.trim()) || !isCount(Number(total)) || !isCount(raw.basis[field])
        || Number(total) !== raw.basis[field] || !isCount(n) || n > Number(total)
        || (!raw.has_reported && n !== 0) || (!raw.has_missing && n !== Number(total))) return false;
      covered[field] = n;
      return true;
    });
    if (!matchesBasis) {
      invalid();
      continue;
    }
    evidence.set(key, { version: 1, reported_usd: raw.reported_usd, covered_tokens: covered,
      has_reported: raw.has_reported, has_missing: raw.has_missing, has_allocated: raw.has_allocated, origins: [...new Set<string>(raw.origins)] });
  }
  if (evidence.size !== relevant.length || seen.size !== evidence.size) {
    invalid();
    console.warn("Account cost inventory differs from token totals");
  }
  return rows.map(row => {
    const cost = evidence.get(keyOf(row as CostRow));
    return cost ? { ...row, cost_provenance: cost } : row;
  });
}

export function coveredRowCost<T extends CostRow>(row: T, estimate: (row: T) => number): number | undefined {
  const provenance = row.cost_provenance;
  if (!provenance) return row.source === "cursor" && /^grok-bot-/i.test(row.model || "") ? 0 : undefined;
  const uncovered = { ...row, cost_provenance: undefined, total_cost_usd: undefined } as T;
  for (const field of COST_TOKEN_FIELDS) uncovered[field] = Math.max(0, Number(row[field] || 0) - provenance.covered_tokens[field]);
  return provenance.reported_usd + estimate(uncovered);
}
export function cloudCostSource(row: CostRow, priced: boolean): string {
  if (isFreeGrok(row)) return "model_pricing";
  const p = row.cost_provenance;
  if (p?.has_reported) return p.has_missing ? "mixed" : p.has_allocated ? "allocated" : "provider_reported";
  return priced ? "model_pricing" : "unpriced";
}
