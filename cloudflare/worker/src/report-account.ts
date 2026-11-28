import { cloudCostSource } from "./report-cost-provenance";
import {
  accountUsage,
  DAY,
  quantities,
  reportClock,
  shiftDay,
} from "./report-usage";
import type { Clock, UsageRow } from "./report-usage";
import { computeRowCost, getUsageModelPricing } from "./report-pricing";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Cache-Control": "private, no-store",
};
export const reportJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: cors });
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const deviceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReportMembership {
  status: string;
  phase: string;
  can_read_cloud: boolean;
}
function historyStart(membership: ReportMembership, hourly: boolean) {
  if (membership.phase !== "active" || membership.status === "self_hosted")
    return null;
  const now = new Date();
  if (hourly) return shiftDay(isoDay(now), -89);
  // Postgres interval subtraction clamps leap-day to the last day of February.
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 1),
  );
  const monthEnd = new Date(
    Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth() + 1, 0),
  );
  monthStart.setUTCDate(Math.min(now.getUTCDate(), monthEnd.getUTCDate()));
  return isoDay(monthStart);
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
    conversation_count: 0,
  };
}
function addTotals(totals: ReturnType<typeof emptyTotals>, row: UsageRow) {
  for (const key of quantities) {
    if (key === "conversations") totals.conversation_count += row.conversations;
    else totals[key] += row[key];
  }
  totals.billable_total_tokens += row.total_tokens;
}
function bucketData(rows: UsageRow[], cost: boolean) {
  type Totals = ReturnType<typeof emptyTotals> & {
    models: Record<string, number>;
    total_cost_usd?: number;
  };
  const buckets = new Map<string, Totals>();
  for (const row of rows) {
    let b = buckets.get(row.bucket);
    if (!b) {
      b = { ...emptyTotals(), models: Object.create(null) };
      if (cost) b.total_cost_usd = 0;
      buckets.set(row.bucket, b);
    }
    addTotals(b, row);
    if (cost) b.total_cost_usd = (b.total_cost_usd ?? 0) + computeRowCost(row);
    const model = row.model || "unknown";
    b.models[model] = (b.models[model] || 0) + row.total_tokens;
  }
  return buckets;
}

function breakdown(rows: UsageRow[], from: string, to: string) {
  type Model = {
    model: string;
    cost: number;
    costSource?: string;
    allocated?: boolean;
    totals: ReturnType<typeof emptyTotals>;
  };
  type Source = {
    source: string;
    totals: ReturnType<typeof emptyTotals>;
    models: Map<string, Model>;
  };
  const sources = new Map<string, Source>();
  for (const row of rows) {
    const source = row.source || "unknown",
      model = row.model?.trim() || "unknown";
    let s = sources.get(source);
    if (!s) {
      s = { source, totals: emptyTotals(), models: new Map() };
      sources.set(source, s);
    }
    let m = s.models.get(model);
    if (!m) {
      m = { model, cost: 0, totals: emptyTotals() };
      s.models.set(model, m);
    }
    addTotals(s.totals, row);
    addTotals(m.totals, row);
    m.cost += computeRowCost(row);
    const sourceOfCost = cloudCostSource(
      row,
      getUsageModelPricing(model, source).status === "priced",
    );
    m.costSource =
      m.costSource && m.costSource !== sourceOfCost ? "mixed" : sourceOfCost;
    m.allocated ||= Boolean(row.cost_provenance?.has_allocated);
  }
  const result = [...sources.values()]
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
    .map((s) => {
      const models = [...s.models.values()]
        .sort(
          (a, b) =>
            b.totals.total_tokens - a.totals.total_tokens ||
            (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
        )
        .map((m) => ({
          model: m.model,
          model_id: m.model,
          pricing: getUsageModelPricing(m.model, s.source),
          cost_source: m.costSource || "model_pricing",
          ...(m.allocated ? { has_allocated_cost: true } : {}),
          totals: { ...m.totals, total_cost_usd: m.cost.toFixed(6) },
        }));
      const cost = models.reduce(
        (sum, m) => sum + Number(m.totals.total_cost_usd),
        0,
      );
      return {
        source: s.source,
        totals: { ...s.totals, total_cost_usd: cost.toFixed(6) },
        models,
      };
    });
  return {
    from,
    to,
    days: 0,
    sources: result,
    pricing: {
      model: "per-model",
      pricing_mode: "per_token_type",
      source: "litellm",
      effective_from: isoDay(new Date()),
    },
  };
}

function summary(
  rows: UsageRow[],
  rolling: UsageRow[],
  from: string,
  to: string,
  today: string,
) {
  let cost = 0;
  const totals = emptyTotals();
  const days = new Set<string>();
  for (const row of rows) {
    days.add(row.bucket);
    addTotals(totals, row);
    cost += computeRowCost(row);
  }
  const roll = (n: number) => {
    const start = shiftDay(today, 1 - n);
    let tokens = 0,
      conversations = 0;
    const active = new Set<string>();
    for (const row of rolling)
      if (row.bucket >= start && row.bucket <= today) {
        active.add(row.bucket);
        tokens += row.total_tokens;
        conversations += row.conversations;
      }
    return {
      from: start,
      to: today,
      active_days: active.size,
      totals: {
        billable_total_tokens: tokens,
        conversation_count: conversations,
      },
      ...(n === 30
        ? {
            avg_per_active_day: active.size
              ? Math.round(tokens / active.size)
              : 0,
          }
        : {}),
    };
  };
  return {
    from,
    to,
    days: days.size,
    totals: { ...totals, total_cost_usd: cost.toFixed(6) },
    rolling: { last_7d: roll(7), last_30d: roll(30) },
  };
}

function heatmap(
  rows: UsageRow[],
  from: string,
  to: string,
  p: URLSearchParams,
) {
  const values = bucketData(rows, false);
  const week_starts_on =
    p.get("week_starts_on")?.toLowerCase() === "mon" ? "mon" : "sun";
  const max = Math.max(0, ...[...values.values()].map((v) => v.total_tokens));
  const active_days = [...values.values()].filter(
    (v) => v.total_tokens > 0,
  ).length;
  const base = { from, to, week_starts_on, active_days, streak_days: 0 };
  if (p.get("format") === "compact") {
    const indexes = new Map<string, number>();
    const days = [...values].map(([d, v]) => {
      const pairs: number[] = [];
      for (const [model, tokens] of Object.entries(v.models)) {
        if (!indexes.has(model)) indexes.set(model, indexes.size);
        pairs.push(indexes.get(model)!, tokens);
      }
      return [d, v.total_tokens, pairs];
    });
    return {
      ...base,
      format: "compact",
      max_value: max,
      model_names: [...indexes.keys()],
      days,
    };
  }
  const cells = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) {
    const b = values.get(d),
      v = b?.total_tokens || 0;
    cells.push({
      day: d,
      total_tokens: v,
      billable_total_tokens: v,
      level: v > 0 ? Math.ceil((v / max) * 4) : 0,
      models: b?.models ?? null,
    });
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { ...base, weeks };
}

interface Device {
  id: string;
  device_name: string | null;
  platform: string | null;
  created_at: string;
}
async function deviceReport(
  db: D1Database,
  user: string,
  from: string,
  to: string,
  clock: Clock,
) {
  const devices = (
    await db
      .prepare(
        "SELECT id,device_name,platform,created_at FROM tokentracker_devices WHERE user_id=? AND revoked_at IS NULL",
      )
      .bind(user)
      .all<Device>()
  ).results;
  const accountSources = new Set(["cursor", "trae-cn"]);
  const out = [];
  for (const device of devices) {
    const rows = await accountUsage(
      db,
      user,
      device.id,
      from,
      to,
      "day",
      clock,
      false,
      false,
    );
    out.push({
      ...device,
      total_tokens: rows.reduce(
        (sum, r) => sum + (accountSources.has(r.source) ? 0 : r.total_tokens),
        0,
      ),
    });
  }
  const accounts = await accountUsage(
    db,
    user,
    null,
    from,
    to,
    "day",
    clock,
    true,
    false,
  );
  const bySource = new Map<string, number>();
  for (const row of accounts)
    bySource.set(
      row.source,
      (bySource.get(row.source) || 0) + row.total_tokens,
    );
  return {
    from,
    to,
    devices: out.sort((a, b) => b.total_tokens - a.total_tokens),
    account_sources: [...bySource]
      .map(([source, total_tokens]) => ({ source, total_tokens }))
      .filter((s) => s.total_tokens > 0)
      .sort((a, b) => b.total_tokens - a.total_tokens),
  };
}

function validDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(day + "T00:00:00Z");
  return Number.isFinite(+d) && isoDay(d) === day;
}

export async function accountReport(
  req: Request,
  db: D1Database,
  user: string,
  kind: string,
  membership: ReportMembership,
) {
  const p = new URL(req.url).searchParams;
  const recovery_url = "https://www.tokentracker.cc/cloud";
  if (!membership.can_read_cloud) {
    const code =
      membership.status === "expired"
        ? "cloud_read_only_expired"
        : "cloud_membership_required";
    return reportJson(
      { ok: false, status: 402, code, error: code, membership, recovery_url },
      402,
    );
  }
  const clock =
    kind === "monthly"
      ? reportClock(null, null)
      : reportClock(p.get("tz"), p.get("tz_offset_minutes"));
  const today = clock.day(new Date());
  let from = p.get("from") || "",
    to = p.get("to") || "";
  if (kind === "hourly") {
    from = to = p.get("day") || isoDay(new Date());
  } else if (kind === "heatmap") {
    to = to || today;
    if (!validDay(to)) return reportJson({ error: "Invalid date" }, 400);
    const raw = parseInt(p.get("weeks") || "52", 10);
    from = shiftDay(
      to,
      1 - 7 * (Number.isFinite(raw) ? Math.max(1, Math.min(raw, 104)) : 52),
    );
  } else if (kind === "monthly" && (!from || !to)) {
    const months = Math.min(36, parseInt(p.get("months") || "", 10));
    if (!(months > 0))
      return reportJson({ error: "Missing from/to or months" }, 400);
    to = to || isoDay(new Date());
    if (!validDay(to)) return reportJson({ error: "Invalid date" }, 400);
    const d = new Date(to + "T00:00:00Z");
    from =
      from ||
      isoDay(
        new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months + 1, 1)),
      );
  }
  if (!from || !to) return reportJson({ error: "Missing from/to" }, 400);
  if (!validDay(from) || !validDay(to))
    return reportJson({ error: "Invalid date" }, 400);
  if ((Date.parse(to) - Date.parse(from)) / DAY > 1095)
    from = shiftDay(to, -1095);
  const min = historyStart(membership, kind === "hourly");
  if (min && to < min) {
    const code = "cloud_history_window_exceeded";
    return reportJson(
      {
        ok: false,
        status: 400,
        code,
        error: code,
        membership,
        available_from: min,
        recovery_url,
      },
      400,
    );
  }
  if (min && from < min) from = min;
  const rawId = p.get("device_id");
  const id = rawId && deviceIdPattern.test(rawId) ? rawId : null;
  if (kind === "devices")
    return reportJson(await deviceReport(db, user, from, to, clock));
  const grain =
    kind === "model-breakdown"
      ? "all"
      : kind === "hourly"
        ? "hour"
        : kind === "monthly"
          ? "month"
          : "day";
  const rows = await accountUsage(
    db,
    user,
    id,
    from,
    to,
    grain,
    clock,
    false,
    ["daily", "summary", "model-breakdown"].includes(kind),
  );
  if (kind === "model-breakdown") return reportJson(breakdown(rows, from, to));
  if (kind === "heatmap") return reportJson(heatmap(rows, from, to, p));
  if (kind === "summary") {
    const first = shiftDay(today, -29);
    const rolling =
      from <= first && to >= today
        ? rows
        : await accountUsage(
            db,
            user,
            id,
            first,
            today,
            "day",
            clock,
            false,
            false,
          );
    return reportJson(summary(rows, rolling, from, to, today));
  }
  const data = [...bucketData(rows, kind === "daily")].map(([key, b]) => ({
    [grain]: key,
    ...b,
  }));
  return reportJson(
    kind === "hourly" ? { day: from, data } : { from, to, data },
  );
}
