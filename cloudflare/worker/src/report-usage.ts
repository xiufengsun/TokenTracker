import {
  costGroupJson,
  parseCostGroup,
  rankedCostRows,
  type CloudCostProvenance,
} from "./report-cost-provenance.ts";

export interface UsageRow {
  bucket: string;
  source: string;
  model: string;
  pricing_tier: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  conversations: number;
  total_cost_usd?: number;
  cost_provenance?: CloudCostProvenance;
}

export const quantities = [
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_output_tokens",
  "conversations",
] as const;

export const DAY = 86_400_000;
export function shiftDay(day: string, days: number) {
  return new Date(Date.parse(day + "T00:00:00Z") + days * DAY)
    .toISOString()
    .slice(0, 10);
}

export type BucketSize = "day" | "month" | "hour" | "all";
export interface Clock {
  day(at: Date): string;
  offsetMinutes(time: number): number;
}

export function reportClock(tz: string | null, offset: string | null): Clock {
  let formatter: Intl.DateTimeFormat | undefined;
  if (tz) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "longOffset",
      });
    } catch {
      /* The source database falls back to the caller's fixed offset. */
    }
  }
  const numericOffset = Number(offset);
  function offsetMinutes(time: number) {
    if (!formatter)
      return Number.isFinite(numericOffset) ? Math.trunc(numericOffset) : 0;
    const zone = formatter
      .formatToParts(time)
      .find((part) => part.type === "timeZoneName")?.value;
    const match = /^GMT([+-])(\d\d):(\d\d)$/.exec(zone || "");
    return match
      ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
      : 0;
  }
  return {
    offsetMinutes,
    day: (at) =>
      new Date(+at + offsetMinutes(+at) * 60_000).toISOString().slice(0, 10),
  };
}

// SQLite has no IANA timezone database. Bind UTC offsets for each DST interval so
// the database can group on local dates without sending every hourly row out to JS.
function clockExpression(clock: Clock, start: number, end: number) {
  const parameters: (number | string)[] = [];
  const steps: string[] = [];
  let previous = clock.offsetMinutes(start);
  for (let utc = start; utc < end; utc += DAY) {
    const last = Math.min(utc + DAY, end);
    const next = clock.offsetMinutes(last);
    if (next === previous) continue;
    let low = utc / 60_000;
    let high = last / 60_000;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (clock.offsetMinutes(mid * 60_000) === previous) low = mid;
      else high = mid;
    }
    steps.push("WHEN hour_start < ? THEN ?");
    parameters.push(
      new Date(high * 60_000).toISOString().replace(".000Z", ".000000Z"),
      previous,
    );
    previous = next;
  }
  parameters.push(previous);
  return {
    expression: steps.length ? "CASE " + steps.join(" ") + " ELSE ? END" : "?",
    parameters,
  };
}

export async function accountUsage(
  db: D1Database,
  userId: string,
  deviceId: string | null,
  from: string,
  to: string,
  bucket: BucketSize,
  clock: Clock,
  accountOnly = false,
  withEvidence = true,
): Promise<UsageRow[]> {
  if (to < from) return [];
  const fromDay = shiftDay(from, -1);
  const untilDay = shiftDay(to, 2);
  const fromStamp = fromDay + "T00:00:00.000000Z",
    toStamp = untilDay + "T00:00:00.000000Z";
  const offset = clockExpression(
    clock,
    Date.parse(fromStamp),
    Date.parse(toStamp),
  );
  const format =
    bucket === "all"
      ? ""
      : bucket === "hour"
        ? "%Y-%m-%dT%H:00:00"
        : bucket === "month"
          ? "%Y-%m"
          : "%Y-%m-%d";
  const fields = quantities.join(", ");
  const averages = quantities.map((c) => "SUM(" + c + ") AS " + c).join(", ");
  const query = `
    WITH active AS (SELECT id FROM tokentracker_devices WHERE user_id=?1 AND revoked_at IS NULL),
    selected AS (SELECT id FROM active WHERE id=?4 OR NOT EXISTS (SELECT 1 FROM active WHERE id=?4)),
    base AS NOT MATERIALIZED (
      SELECT h.*, CASE WHEN h.source='cursor' THEN '' ELSE COALESCE(dm.machine_cluster_id, h.device_id) END AS cluster
      FROM tokentracker_hourly h
      LEFT JOIN tokentracker_device_machine dm ON dm.device_id=h.device_id
      WHERE h.user_id=?1 AND h.hour_start>=?2 AND h.hour_start<?3
        AND (h.source='cursor' OR (?5=0 AND h.source<>'trae-cn' AND h.device_id IN selected))
    ), ${
      withEvidence
        ? rankedCostRows()
        : `ranked AS (
      SELECT *,row_number() OVER(PARTITION BY user_id,cluster,hour_start,source,model ORDER BY total_tokens DESC,updated_at DESC) AS place FROM base
    ), picked AS (SELECT * FROM ranked WHERE place=1)`
    },
    observed AS (
      SELECT hour_start,source,model,${fields}${withEvidence ? ",total_cost_usd,cost_coverage,cost_conflict" : ""} FROM picked
      UNION ALL
      SELECT bucket_start,source,model,total_tokens,input_tokens,output_tokens,cached_input_tokens,
             cache_creation_input_tokens,reasoning_output_tokens,1${withEvidence ? ",0,NULL,0" : ""}
      FROM tokentracker_account_session_states WHERE user_id=?1 AND source='trae-cn'
        AND bucket_start>=?2 AND bucket_start<?3
    ), located AS (
      SELECT *, datetime(hour_start, printf('%d minutes', ${offset.expression})) AS local_time,
        CASE WHEN (instr(lower(model),'deepseek-v4-flash')>0 OR instr(lower(model),'deepseek-v4-pro')>0)
          AND substr(hour_start,12,2) NOT IN ('01','02','03','06','07','08','09')
          THEN 'off_peak' ELSE 'peak' END AS pricing_tier
      FROM observed WHERE ?5=1 OR EXISTS (SELECT 1 FROM active)
    )
    SELECT strftime('${format}',local_time) AS bucket,source,model,pricing_tier,${averages}${withEvidence ? "," + costGroupJson() + " AS provenance_json" : ""}
    FROM located WHERE date(local_time) BETWEEN ? AND ?
    GROUP BY bucket,source,model,pricing_tier ORDER BY bucket,source,model,pricing_tier`;
  const records = (
    await db
      .prepare(query)
      .bind(
        userId,
        fromStamp,
        toStamp,
        deviceId,
        Number(accountOnly),
        ...offset.parameters,
        from,
        to,
      )
      .all<UsageRow & { provenance_json?: string | null }>()
  ).results;
  return records.map(({ provenance_json, ...row }) =>
    provenance_json
      ? { ...row, cost_provenance: parseCostGroup(provenance_json) }
      : row,
  );
}
