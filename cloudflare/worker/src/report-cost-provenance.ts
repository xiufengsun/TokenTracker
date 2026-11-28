// The upload validator and cost calculation use the source Cloud cost coverage v1 contract.
export const COST_TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;
const UPLOAD_ORIGINS = [
  "grok_ticks",
  "grok_usd",
  "grok_allocated",
  "cursor_csv_cost",
  "cursor_total_cents",
];
export const COST_ORIGINS = [...UPLOAD_ORIGINS, "legacy_grok_total_cost_usd"];
type Tokens = Record<(typeof COST_TOKEN_FIELDS)[number], number>;
type CostRow = {
  source?: string;
  model?: string;
  bucket?: string;
  user_id?: string;
  pricing_tier?: string;
  total_cost_usd?: unknown;
  cost_provenance?: CloudCostProvenance;
} & Partial<Record<(typeof COST_TOKEN_FIELDS)[number], unknown>>;
export type CloudCostProvenance = {
  version: 1;
  reported_usd: number;
  covered_tokens: Tokens;
  has_reported: boolean;
  has_missing: boolean;
  has_allocated: boolean;
  origins: string[];
};
const failure = () =>
  new Error("Cost provenance inventory unavailable; retry after data refresh");
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isAmount = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= Number.MAX_SAFE_INTEGER;
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
export const isCostProvenanceModel = (row: CostRow) =>
  row.source === "grok" ||
  (row.source === "cursor" && /^grok-bot-/i.test(row.model || ""));
export function isFreeGrok(row: CostRow): boolean {
  const model = String(row.model || "").toLowerCase();
  return (
    row.source === "grok" &&
    (model.includes("build-free") ||
      model.includes("free-tier") ||
      model.endsWith("-free"))
  );
}

// Strict, bounded allowlist: never persist arbitrary nested event objects.
export function uploadCostCoverage(
  value: unknown,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure();
  const v = value as Record<string, unknown>;
  if (
    !hasExactKeys(v, [
      "version",
      "reported_usd",
      "reported_events",
      "missing_events",
      "allocated_events",
      "origins",
      "unreported_tokens",
    ]) ||
    v.version !== 1 ||
    !isCostProvenanceModel(row as CostRow) ||
    !isAmount(v.reported_usd) ||
    !isCount(v.reported_events) ||
    !isCount(v.missing_events) ||
    !isCount(v.allocated_events) ||
    v.allocated_events > v.reported_events ||
    (v.reported_events === 0 && v.reported_usd !== 0) ||
    (v.allocated_events > 0 &&
      !(Array.isArray(v.origins) && v.origins.includes("grok_allocated"))) ||
    !Array.isArray(v.origins) ||
    v.origins.length > UPLOAD_ORIGINS.length ||
    new Set(v.origins).size !== v.origins.length ||
    (v.reported_events > 0 && v.origins.length === 0) ||
    v.origins.some(
      (origin) =>
        typeof origin !== "string" ||
        !UPLOAD_ORIGINS.includes(origin) ||
        !origin.startsWith(row.source === "cursor" ? "cursor_" : "grok_"),
    ) ||
    !v.unreported_tokens ||
    typeof v.unreported_tokens !== "object" ||
    Array.isArray(v.unreported_tokens)
  )
    throw failure();
  const uncovered = v.unreported_tokens as Record<string, unknown>;
  if (!hasExactKeys(uncovered, COST_TOKEN_FIELDS)) throw failure();
  for (const key of COST_TOKEN_FIELDS) {
    const n = uncovered[key],
      total = row[key] ?? 0;
    if (
      !isCount(n) ||
      !isCount(total) ||
      n > total ||
      (v.missing_events === 0 && n !== 0) ||
      (v.reported_events === 0 && n !== total)
    )
      throw failure();
  }
  const usd = row.total_cost_usd ?? 0;
  if (!isAmount(usd) || Math.abs(usd - v.reported_usd) > 1e-8) throw failure();
  return {
    version: 1,
    reported_usd: v.reported_usd,
    reported_events: v.reported_events,
    missing_events: v.missing_events,
    allocated_events: v.allocated_events,
    origins: [...v.origins],
    unreported_tokens: { ...uncovered },
  };
}

export function coveredRowCost<T extends CostRow>(
  row: T,
  estimate: (row: T) => number,
): number | undefined {
  const provenance = row.cost_provenance;
  if (!provenance)
    return row.source === "cursor" && /^grok-bot-/i.test(row.model || "")
      ? 0
      : undefined;
  const uncovered = {
    ...row,
    cost_provenance: undefined,
    total_cost_usd: undefined,
  } as T;
  for (const field of COST_TOKEN_FIELDS)
    uncovered[field] = Math.max(
      0,
      Number(row[field] || 0) - provenance.covered_tokens[field],
    );
  return provenance.reported_usd + estimate(uncovered);
}
export function cloudCostSource(row: CostRow, priced: boolean): string {
  if (isFreeGrok(row)) return "model_pricing";
  const p = row.cost_provenance;
  if (p?.has_reported)
    return p.has_missing
      ? "mixed"
      : p.has_allocated
        ? "allocated"
        : "provider_reported";
  return priced ? "model_pricing" : "unpriced";
}

// Called with an eligible input CTE named "base". Evidence and token totals use the same
// snapshot and winning machine observation. Trae session states carry no provider USD.
export const relevantCostSql =
  "(source='grok' OR (source='cursor' AND lower(model) GLOB 'grok-bot-*'))";
const legacy =
  "(source='grok' AND cost_coverage IS NULL AND CAST(total_cost_usd AS REAL)>0)";
const hasReport =
  "(coalesce(json_extract(cost_coverage,'$.reported_events'),0)>0 OR " +
  legacy +
  ")";
const uncovered = (field: string) =>
  "coalesce(json_extract(cost_coverage,'$.unreported_tokens." + field + "'),0)";
const reported =
  "coalesce(json_extract(cost_coverage,'$.reported_usd'),CAST(total_cost_usd AS REAL))";
const evidenceFingerprint =
  "CASE WHEN " +
  hasReport +
  " THEN json_array(CAST(" +
  reported +
  " AS REAL)," +
  COST_TOKEN_FIELDS.map(uncovered).join(",") +
  ") END";
export function rankedCostRows() {
  const partition =
    "PARTITION BY user_id,cluster,hour_start,source,model ORDER BY total_tokens DESC,updated_at DESC";
  return `ranked_cost AS (
    SELECT *,row_number() OVER (${partition},${hasReport} DESC,(cost_coverage IS NOT NULL) DESC,device_id) AS place,
      min(${evidenceFingerprint}) OVER tied AS least_report,max(${evidenceFingerprint}) OVER tied AS greatest_report,
      min(json_array(${COST_TOKEN_FIELDS})) OVER tied AS min_basis,max(json_array(${COST_TOKEN_FIELDS})) OVER tied AS max_basis
    FROM base WHERE ${relevantCostSql} WINDOW tied AS (${partition} RANGE BETWEEN CURRENT ROW AND CURRENT ROW)
  ), ranked_plain AS (
    SELECT *,row_number() OVER (${partition}) AS place FROM base WHERE NOT ${relevantCostSql}
  ), picked AS (
    SELECT *,least_report IS NOT greatest_report OR (least_report IS NOT NULL AND min_basis<>max_basis) AS cost_conflict
    FROM ranked_cost WHERE place=1
    UNION ALL SELECT *,NULL,NULL,NULL,NULL,0 FROM ranked_plain WHERE place=1
  )`;
}
export function costGroupJson() {
  const covered = COST_TOKEN_FIELDS.map(
    (
      k,
    ) => `'${k}',sum(CASE WHEN cost_coverage IS NOT NULL THEN ${k}-${uncovered(k)}
    WHEN ${legacy} THEN ${k} ELSE 0 END)`,
  ).join(",");
  // All six fixed origins fit into a single integer in the aggregate. Expand only when needed by a caller.
  const origins = COST_ORIGINS.map((name, i) =>
    i === 5
      ? `32*max(${legacy})`
      : `${2 ** i}*max(coalesce(instr(json_extract(cost_coverage,'$.origins'),'"${name}"'),0)>0)`,
  ).join("+");
  return `CASE WHEN ${relevantCostSql} THEN json_object('version',1,'ambiguous',max(cost_conflict),
    'reported_usd', sum(CASE WHEN ${hasReport} THEN ${reported} ELSE 0 END),
    'covered_tokens',json_object(${covered}),'has_reported',max(${hasReport}),
    'has_missing',max(CASE WHEN cost_coverage IS NULL THEN NOT ${legacy} ELSE json_extract(cost_coverage,'$.missing_events')>0 END),
    'has_allocated',max(coalesce(json_extract(cost_coverage,'$.allocated_events'),0)>0), 'origin_bits',${origins}) END`;
}

export function parseCostGroup(raw: string): CloudCostProvenance {
  const data = JSON.parse(raw);
  if (data.ambiguous || !isAmount(data.reported_usd)) throw failure();
  for (const k of COST_TOKEN_FIELDS)
    if (!isCount(data.covered_tokens[k])) throw failure();
  return {
    version: 1,
    reported_usd: data.reported_usd,
    covered_tokens: data.covered_tokens,
    has_reported: Boolean(data.has_reported),
    has_missing: Boolean(data.has_missing),
    has_allocated: Boolean(data.has_allocated),
    origins: COST_ORIGINS.filter((_, i) => data.origin_bits & (1 << i)),
  };
}
