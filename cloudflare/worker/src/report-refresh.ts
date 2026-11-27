import {
  costGroupJson,
  rankedCostRows,
  relevantCostSql,
  COST_TOKEN_FIELDS,
} from "./report-cost-provenance";
import { publicRowCost as computeRowCost } from "./report-public-pricing";
import { shiftDay } from "./report-usage";
import { snapshotBounds, publicBlocklist } from "./report-public";
import type { PublicEnv } from "./report-public";
import type { UsageRow } from "./report-usage";

const tokenFields = [
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_output_tokens",
] as const;
const sumFields = tokenFields.map((c) => "sum(" + c + ") AS " + c).join(",");
const reportTable = "tokentracker_leaderboard_rollup_daily_v2";

// SQL fragments here are provided by the two internal callers. All data is bound.
export function rollupInsertSql(
  fromExpr: string,
  toExpr: string,
  userExpr?: string,
  daySetExpr?: string,
) {
  return (
    `INSERT INTO ${reportTable} (user_id,source,model,day,pricing_tier,${tokenFields.join(",")},cost_provenance) ` +
    rollupSelect(fromExpr, toExpr, userExpr, daySetExpr)
  );
}

function rollupSelect(
  fromExpr: string,
  toExpr: string,
  userExpr?: string,
  daySetExpr?: string,
  evidenceOnly = false,
) {
  const inScope = (
    alias: string,
    time: string,
  ) => `${alias}.${time}>=${fromExpr} AND ${alias}.${time}<${toExpr}
    ${userExpr ? " AND " + alias + ".user_id=" + userExpr : ""}
    ${daySetExpr ? " AND substr(" + alias + "." + time + ",1,10) IN (" + daySetExpr + ")" : ""}`;
  return `WITH base AS NOT MATERIALIZED (
      SELECT h.*, CASE WHEN h.source='cursor' THEN '' ELSE coalesce(dm.machine_cluster_id,h.device_id) END AS cluster
      FROM tokentracker_hourly h LEFT JOIN tokentracker_devices d ON d.id=h.device_id AND d.user_id=h.user_id
      LEFT JOIN tokentracker_device_machine dm ON dm.device_id=h.device_id WHERE ${inScope("h", "hour_start")}
      ${evidenceOnly ? "AND (h.source='grok' OR (h.source='cursor' AND lower(h.model) GLOB 'grok-bot-*'))" : ""}
      AND (h.source='cursor' OR (h.source NOT IN ('cursor','trae-cn') AND d.id IS NOT NULL AND d.revoked_at IS NULL))
    ), ${rankedCostRows()}, rows AS (
      SELECT user_id,source,model,hour_start,${tokenFields.join(",")},total_cost_usd,cost_coverage,cost_conflict FROM picked
      UNION ALL SELECT user_id,source,model,bucket_start,${tokenFields.join(",")},0,NULL,0 FROM tokentracker_account_session_states s
        WHERE ${evidenceOnly ? "0 AND" : ""} s.source='trae-cn' AND ${inScope("s", "bucket_start")}
    ), timed AS (
      SELECT *,substr(hour_start,1,10) AS day, CASE WHEN (instr(lower(model),'deepseek-v4-flash')>0 OR instr(lower(model),'deepseek-v4-pro')>0)
      AND substr(hour_start,12,2) NOT IN ('01','02','03','06','07','08','09') THEN 'off_peak' ELSE 'peak' END AS tier FROM rows
    ) SELECT user_id,source,model,day,tier,${sumFields},${costGroupJson()} AS proof FROM timed GROUP BY user_id,source,model,day,tier`;
}
export function rebuildReportDayStatements(
  db: D1Database,
  day: string,
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM " + reportTable + " WHERE day=?").bind(day),
    db
      .prepare(rollupInsertSql("?1", "?2"))
      .bind(day + "T00:00:00.000000Z", shiftDay(day, 1) + "T00:00:00.000000Z"),
    db.prepare("DELETE FROM report_dirty_days WHERE day=?").bind(day),
  ];
}

export async function prepareReportDays(
  db: D1Database,
  maxDays = 32,
): Promise<boolean> {
  const queue = (
    await db
      .prepare("SELECT day FROM report_dirty_days ORDER BY day LIMIT ?")
      .bind(maxDays + 1)
      .all<{ day: string }>()
  ).results;
  for (const { day } of queue.slice(0, maxDays))
    await db.batch(rebuildReportDayStatements(db, day));
  return queue.length <= maxDays;
}

// A restored PostgreSQL rollup predates the optional evidence column. Compare its
// original token basis with the raw observations before populating metadata. An
// unavailable history must never erase a closed-day token aggregate.
async function populateHistoricalCosts(
  db: D1Database,
  from: string,
  to: string,
) {
  const missing = `FROM ${reportTable} WHERE day BETWEEN ? AND ? AND cost_provenance IS NULL AND ${relevantCostSql}`;
  const pending = (
    await db
      .prepare("SELECT DISTINCT day " + missing + " ORDER BY day LIMIT 33")
      .bind(from, to)
      .all<{ day: string }>()
  ).results;
  for (const { day } of pending.slice(0, 32)) {
    const matching = COST_TOKEN_FIELDS.map((c) => `r.${c}=g.${c}`).join(
      " AND ",
    );
    await db
      .prepare(
        `WITH grouped AS MATERIALIZED (${rollupSelect("?1", "?2", undefined, undefined, true)})
      UPDATE ${reportTable} AS r SET cost_provenance=g.proof FROM grouped g
      WHERE r.day=?3 AND r.cost_provenance IS NULL AND r.day=g.day AND r.user_id=g.user_id AND r.source=g.source
        AND r.model=g.model AND r.pricing_tier=g.tier AND ${matching}`,
      )
      .bind(
        day + "T00:00:00.000000Z",
        shiftDay(day, 1) + "T00:00:00.000000Z",
        day,
      )
      .run();
  }
  if (
    pending.length &&
    (await db
      .prepare("SELECT 1 " + missing + " LIMIT 1")
      .bind(from, to)
      .first())
  ) {
    throw new Error("Historical cost basis unavailable");
  }
}
export type RankPeriod = "week" | "month" | "total";
const groups: Record<string, string[]> = {
  gpt_tokens: ["codex"],
  claude_tokens: ["claude", "pi-anthropic"],
  gemini_tokens: ["gemini"],
  cursor_tokens: ["cursor"],
  opencode_tokens: ["opencode"],
  openclaw_tokens: ["openclaw"],
  hermes_tokens: ["hermes"],
  kiro_tokens: ["kiro"],
  copilot_tokens: ["copilot", "pi-github-copilot", "pi-copilot"],
  kimi_tokens: ["kimi"],
};
const allSources = Object.values(groups).flat();
const sqlList = (s: string[]) => s.map((v) => "'" + v + "'").join(",");
function calcRates(source: string, model: string, pricing_tier: string) {
  const row = {
    bucket: "",
    source,
    model,
    pricing_tier,
    conversations: 0,
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  } satisfies UsageRow;
  return {
    source,
    model,
    pricing_tier,
    ...Object.fromEntries(
      [
        ["input", "input_tokens"],
        ["output", "output_tokens"],
        ["cached", "cached_input_tokens"],
        ["creation", "cache_creation_input_tokens"],
        ["reasoning", "reasoning_output_tokens"],
      ].map(([dest, key]) => [
        dest,
        computeRowCost({ ...row, [key]: 1_000_000 }),
      ]),
    ),
  };
}

async function updateReportRates(db: D1Database, from: string, to: string) {
  const dims = (
    await db
      .prepare(
        "SELECT DISTINCT source,model,pricing_tier FROM " +
          reportTable +
          " WHERE day BETWEEN ? AND ? EXCEPT SELECT source,model,pricing_tier FROM report_model_rates",
      )
      .bind(from, to)
      .all<{ source: string; model: string; pricing_tier: string }>()
  ).results;
  for (let i = 0; i < dims.length; i += 100) {
    const rates = dims
      .slice(i, i + 100)
      .map((d) => calcRates(d.source, d.model, d.pricing_tier));
    await db
      .prepare(
        `INSERT INTO report_model_rates SELECT json_extract(value,'$.source'),json_extract(value,'$.model'),
      json_extract(value,'$.pricing_tier'),json_extract(value,'$.input'),json_extract(value,'$.output'),
      json_extract(value,'$.cached'),json_extract(value,'$.creation'),json_extract(value,'$.reasoning') FROM json_each(?)
      WHERE true ON CONFLICT(source,model,pricing_tier) DO NOTHING`,
      )
      .bind(JSON.stringify(rates))
      .run();
  }
}

export async function refreshRanking(
  env: PublicEnv,
  period: RankPeriod,
  force = false,
) {
  const db = env.DB,
    blocked = publicBlocklist(env);
  if (!blocked) throw new Error("Leaderboard configuration unavailable");
  const started = new Date().toISOString();
  const { from_day: from, to_day: to } =
    period === "total"
      ? { from_day: "1970-01-01", to_day: started.slice(0, 10) }
      : await snapshotBounds(db, period);
  const claim = await db
    .prepare(
      `INSERT INTO report_refresh_claim VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET
      started_at=excluded.started_at WHERE julianday(started_at)<=julianday(excluded.started_at)-?/86400.0`,
    )
    .bind(period, started, force ? 0 : 30)
    .run();
  if (!claim.meta.changes) return { upserted: 0, skipped: true };
  if (!(await prepareReportDays(db)))
    throw new Error("Historical rollup backfill in progress");
  await populateHistoricalCosts(db, from, to);
  await updateReportRates(db, from, to);
  const columns = Object.keys(groups);
  const counts = Object.entries(groups).map(
    ([col, sources]) =>
      "coalesce(sum(r.total_tokens) FILTER(WHERE r.source IN (" +
      sqlList(sources) +
      ")),0) AS " +
      col,
  );
  const rateNames = ["input", "cached", "creation", "output", "reasoning"];
  const uncoveredCost = COST_TOKEN_FIELDS.map(
    (col, i) =>
      `(r.${col}-coalesce(json_extract(r.cost_provenance,'$.covered_tokens.${col}'),0))*p.${rateNames[i]}`,
  ).join("+");
  // Ambiguous top-ranked source observations invalidate the entire refresh transaction.
  const costSql = `CASE WHEN json_extract(r.cost_provenance,'$.ambiguous')=1 THEN json_extract('conflicting cost observations','$')
    WHEN r.source='grok' AND (instr(lower(r.model),'build-free')>0 OR instr(lower(r.model),'free-tier')>0 OR lower(r.model) GLOB '*-free') THEN 0
    ELSE coalesce(json_extract(r.cost_provenance,'$.reported_usd'),0)+(${uncoveredCost})/1000000.0 END`;
  const cas = "(SELECT started_at FROM report_refresh_claim WHERE kind=?1)=?4";
  // D1 executes the replacement in one transaction. A superseded refresh cannot delete later rows.
  const rs = await db.batch([
    db
      .prepare(
        `INSERT INTO tokentracker_leaderboard_snapshots(period,from_day,to_day,generated_at,user_id,rank,
      ${columns.join(",")},other_tokens,total_tokens,estimated_cost_usd,is_public,display_name,avatar_url,github_url)
      WITH ranked AS (
        SELECT user_id,${counts.join(",")},coalesce(sum(r.total_tokens) FILTER(WHERE r.source NOT IN (${sqlList(allSources)})),0) AS other_tokens,
          sum(r.total_tokens) AS total_tokens,round(sum(${costSql}),2) AS cost
        FROM ${reportTable} r JOIN report_model_rates p USING(source,model,pricing_tier)
        WHERE day BETWEEN ?2 AND ?3 AND ${cas} AND r.user_id NOT IN(SELECT value FROM json_each(?5))
          AND NOT EXISTS(SELECT 1 FROM tokentracker_leaderboard_anomaly_flags f WHERE f.user_id=r.user_id AND f.status='auto_excluded')
        GROUP BY user_id
      ) SELECT ?1,?2,?3,?4,r.user_id,row_number() OVER(ORDER BY total_tokens DESC,r.user_id),
        ${columns.join(",")},other_tokens,total_tokens,cost,coalesce(s.leaderboard_public,0),
        CASE WHEN s.leaderboard_anonymous THEN 'Anonymous' ELSE coalesce(p.display_name,
          (SELECT display_name FROM tokentracker_leaderboard_snapshots old WHERE old.user_id=r.user_id ORDER BY generated_at DESC LIMIT 1),'Anonymous') END,
        CASE WHEN s.leaderboard_anonymous THEN NULL WHEN p.user_id IS NOT NULL THEN p.avatar_url
          ELSE (SELECT avatar_url FROM tokentracker_leaderboard_snapshots old WHERE old.user_id=r.user_id ORDER BY generated_at DESC LIMIT 1) END,
        CASE WHEN s.show_github_url AND NOT s.leaderboard_anonymous THEN s.github_url END
        FROM ranked r LEFT JOIN tokentracker_user_settings s ON s.user_id=r.user_id LEFT JOIN tokentracker_user_profiles p ON p.user_id=r.user_id WHERE true
        ON CONFLICT(period,from_day,to_day,user_id) DO UPDATE SET
          ${["rank", ...columns, "other_tokens", "total_tokens", "estimated_cost_usd", "is_public", "display_name", "avatar_url", "github_url", "generated_at"].map((c) => c + "=excluded." + c).join(",")}`,
      )
      .bind(period, from, to, started, JSON.stringify([...blocked])),
    db
      .prepare(
        "DELETE FROM tokentracker_leaderboard_snapshots WHERE period=?1 AND from_day=?2 AND to_day=?3 AND generated_at<>?4 AND " +
          cas,
      )
      .bind(period, from, to, started),
  ]);
  return { upserted: rs[0].meta.changes };
}
