import { prepareReportDays } from "./report-refresh";

const thresholds = ["bronze", "silver", "gold", "diamond"] as const;
const facts = [
  ["token_titan", "tokens", "'{}'"],
  ["big_day", "max_tokens", "json_object('date',best_day)"],
  ["wordsmith", "output_tokens", "'{}'"],
  ["marathoner", "active_days", "'{}'"],
  ["streak", "streak", "json_object('run_start',run_start,'run_end',run_end)"],
  ["weekend_warrior", "weekends", "'{}'"],
  ["momentum", "ratio", "json_object('week',wow_week)"],
  ["polyglot", "models", "json_object('favorite_model',favorite_model)"],
  ["trendsetter", "early_models", "'{}'"],
  ["multitool", "sources", "'{}'"],
  ["podium", "current_rank", "'{}'"],
  ["veteran", "veteran_days", "json_object('first_day',first_day)"],
];

const badgeSql = `WITH usm AS MATERIALIZED (
  SELECT user_id,source,model,day,sum(total_tokens) AS tokens,sum(output_tokens) AS output_tokens
  FROM tokentracker_leaderboard_rollup_daily_v2 WHERE day<=date(?1) GROUP BY user_id,source,model,day
), daily AS (
  SELECT user_id,day,sum(tokens) AS tokens,sum(output_tokens) AS output_tokens FROM usm
  GROUP BY user_id,day HAVING sum(tokens)>0
), base AS (
  SELECT user_id,sum(tokens) AS tokens,sum(output_tokens) AS output_tokens,count(*) AS active_days,
    count(*) FILTER(WHERE strftime('%w',day) IN('0','6')) AS weekends,min(day) AS first_day,
    cast(julianday(date(?1))-julianday(min(day)) AS integer) AS veteran_days,max(tokens) AS max_tokens FROM daily GROUP BY user_id
), best AS (
  SELECT user_id,day,row_number() OVER(PARTITION BY user_id ORDER BY tokens DESC,day) AS ord FROM daily
), islands AS (
  SELECT user_id,day,julianday(day)-row_number() OVER(PARTITION BY user_id ORDER BY day) AS grp FROM daily
), streaks AS (
  SELECT user_id,count(*) AS streak,min(day) AS run_start,max(day) AS run_end,
    row_number() OVER(PARTITION BY user_id ORDER BY count(*) DESC,max(day) DESC) AS ord FROM islands GROUP BY user_id,grp
), weeks AS (
  SELECT user_id,date(day,'-6 days','weekday 1') AS wk,sum(tokens) AS tok FROM daily GROUP BY user_id,wk
), prev AS (
  SELECT *,lag(wk) OVER w AS pw,lag(tok) OVER w AS pt FROM weeks WINDOW w AS (PARTITION BY user_id ORDER BY wk)
), growth AS (
  SELECT user_id,wk,tok*1.0/pt AS ratio,row_number() OVER(PARTITION BY user_id ORDER BY tok*1.0/pt DESC,wk) AS ord
    FROM prev WHERE date(wk,'-7 days')=pw AND pt>=10000000
), variety AS (
  SELECT user_id,count(DISTINCT model) AS models,count(DISTINCT source) AS sources FROM usm WHERE tokens>0 GROUP BY user_id
), debut AS (
  SELECT model,min(day) AS debut FROM usm GROUP BY model HAVING count(DISTINCT user_id)>=5
  AND min(day)>=(SELECT date(min(day),'+30 days') FROM usm)
), early AS (
  SELECT u.user_id,count(*) AS early_models FROM (SELECT user_id,model,min(day) AS first_day FROM usm GROUP BY user_id,model) u
    JOIN debut d USING(model) WHERE u.first_day<=date(d.debut,'+7 days') GROUP BY u.user_id
), fav AS (
  SELECT user_id,model,row_number() OVER(PARTITION BY user_id ORDER BY sum(tokens) DESC,model) AS ord FROM usm GROUP BY user_id,model
), ranks AS (
  SELECT user_id,min(rank) AS current_rank FROM tokentracker_leaderboard_snapshots WHERE period='total'
    AND to_day=(SELECT max(to_day) FROM tokentracker_leaderboard_snapshots WHERE period='total') GROUP BY user_id
), all_facts AS MATERIALIZED (
  SELECT b.*,bd.day AS best_day,s.streak,s.run_start,s.run_end,g.ratio,g.wk AS wow_week,
    v.models,v.sources,f.model AS favorite_model,e.early_models,r.current_rank FROM base b
  LEFT JOIN best bd ON bd.user_id=b.user_id AND bd.ord=1 LEFT JOIN streaks s ON s.user_id=b.user_id AND s.ord=1
  LEFT JOIN growth g ON g.user_id=b.user_id AND g.ord=1 LEFT JOIN variety v ON v.user_id=b.user_id
  LEFT JOIN fav f ON f.user_id=b.user_id AND f.ord=1 LEFT JOIN early e ON e.user_id=b.user_id LEFT JOIN ranks r ON r.user_id=b.user_id
), measures AS (
  SELECT user_id,c.badge_id,CASE c.badge_id ${facts.map(([id, col]) => "WHEN '" + id + "' THEN " + col).join(" ")} END AS val,
    CASE c.badge_id ${facts.map(([id, , meta]) => "WHEN '" + id + "' THEN " + meta).join(" ")} END AS meta
    FROM all_facts CROSS JOIN tokentracker_badge_catalog c
), earned AS (
  SELECT m.*,c.lower_is_better,CASE
    ${[...thresholds]
      .reverse()
      .map(
        (name, i) =>
          "WHEN (c.lower_is_better AND val<=c." +
          name +
          ") OR (NOT c.lower_is_better AND val>=c." +
          name +
          ") THEN " +
          (4 - i),
      )
      .join(" ")}
    ELSE 0 END AS tier FROM measures m JOIN tokentracker_badge_catalog c USING(badge_id) WHERE val IS NOT NULL
)
INSERT INTO tokentracker_user_badges AS b(user_id,badge_id,tier,metric_value,meta,bronze_at,silver_at,gold_at,diamond_at,updated_at)
  SELECT user_id,badge_id,tier,val,meta,${thresholds.map((_, i) => "CASE WHEN tier>=" + (i + 1) + " THEN ?1 END").join(",")},?1
    FROM earned WHERE true ON CONFLICT(user_id,badge_id) DO UPDATE SET
    tier=max(b.tier,excluded.tier),metric_value=CASE WHEN (SELECT lower_is_better FROM tokentracker_badge_catalog WHERE badge_id=b.badge_id)
      THEN min(coalesce(b.metric_value,excluded.metric_value),excluded.metric_value) ELSE excluded.metric_value END,
    meta=json_patch(coalesce(b.meta,'{}'),excluded.meta),
    ${thresholds.map((t) => t + "_at=coalesce(b." + t + "_at,excluded." + t + "_at)").join(",")},updated_at=excluded.updated_at`;

export async function refreshAchievements(db: D1Database) {
  const now = new Date().toISOString();
  const claim = await db
    .prepare(
      `INSERT INTO report_refresh_claim VALUES ('badges',?) ON CONFLICT(kind) DO UPDATE
    SET started_at=excluded.started_at WHERE julianday(started_at)<=julianday(excluded.started_at)-300.0/86400`,
    )
    .bind(now)
    .run();
  if (!claim.meta.changes) return 0;
  if (!(await prepareReportDays(db)))
    throw new Error("Historical rollup backfill in progress");
  const result = await db.batch([
    db.prepare(badgeSql).bind(now),
    ...thresholds.map((t) =>
      db.prepare(`WITH
    maxima AS MATERIALIZED (SELECT badge_id,coalesce(max(${t}_no),0) AS prev FROM tokentracker_user_badges GROUP BY badge_id),
    nums AS MATERIALIZED (SELECT b.user_id,b.badge_id,m.prev+row_number() OVER(PARTITION BY b.badge_id ORDER BY b.${t}_at,b.user_id) AS n
      FROM tokentracker_user_badges b JOIN maxima m USING(badge_id) WHERE b.${t}_at IS NOT NULL AND b.${t}_no IS NULL)
    UPDATE tokentracker_user_badges AS b SET ${t}_no=n.n FROM nums n WHERE b.user_id=n.user_id AND b.badge_id=n.badge_id`),
    ),
  ]);
  return result[0].meta.changes;
}
