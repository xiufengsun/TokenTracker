import { prepareReportDays } from "./report-refresh";

export async function refreshCommunity(db: D1Database) {
  if (!(await prepareReportDays(db)))
    throw new Error("Historical rollup backfill in progress");
  const now = new Date().toISOString(),
    today = now.slice(0, 10);
  // Keep the source trigger's comparison of two complete UTC weeks. Today's partial
  // observations are still included in the published 30-day series and toplines.
  const result = await db
    .prepare(
      `
    WITH RECURSIVE calendar(day) AS (
      SELECT date(?1,'-29 days') UNION ALL SELECT date(day,'+1 day') FROM calendar WHERE day<?1
    ), usage AS MATERIALIZED (
      SELECT r.user_id,trim(r.source) AS source,trim(r.model) AS model,r.day,r.total_tokens AS tokens,
        r.input_tokens,r.output_tokens,r.cached_input_tokens,r.cache_creation_input_tokens,r.reasoning_output_tokens
      FROM tokentracker_leaderboard_rollup_daily_v2 r WHERE trim(r.model)<>'' AND lower(trim(r.model))<>'auto'
        AND r.day<=?1 AND NOT EXISTS(SELECT 1 FROM tokentracker_leaderboard_anomaly_flags f
          WHERE f.user_id=r.user_id AND f.status IN ('auto_excluded','banned'))
    ), totals AS (
      SELECT coalesce(sum(tokens),0) AS tokens,count(DISTINCT user_id) AS developers,
        count(DISTINCT user_id) FILTER(WHERE day>=date(?1,'-29 days')) AS developers_30d,
        coalesce(sum(tokens) FILTER(WHERE day>=date(?1,'-29 days')),0) AS tokens_30d,
        coalesce(sum(input_tokens),0) AS input,coalesce(sum(output_tokens),0) AS output,
        coalesce(sum(cached_input_tokens),0) AS cache_read,coalesce(sum(cache_creation_input_tokens),0) AS cache_write,
        coalesce(sum(reasoning_output_tokens),0) AS reasoning FROM usage
    ), models AS (SELECT model AS name,sum(tokens) AS tokens FROM usage GROUP BY model ORDER BY tokens DESC,name LIMIT 15),
    providers AS (SELECT source AS name,sum(tokens) AS tokens,count(DISTINCT user_id) AS developers FROM usage WHERE source<>'' GROUP BY source),
    daily AS (SELECT day,sum(tokens) AS tokens,count(DISTINCT user_id) AS developers FROM usage WHERE day>=date(?1,'-29 days') GROUP BY day),
    filled AS (SELECT c.day,coalesce(d.tokens,0) AS tokens,coalesce(d.developers,0) AS developers FROM calendar c LEFT JOIN daily d USING(day)),
    series AS (SELECT *,cast(round(avg(tokens) OVER(ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)) AS INTEGER) AS avg7 FROM filled),
    growth AS (SELECT sum(tokens) FILTER(WHERE day BETWEEN date(?1,'-7 days') AND date(?1,'-1 day')) AS current_tokens,
      sum(tokens) FILTER(WHERE day BETWEEN date(?1,'-14 days') AND date(?1,'-8 days')) AS prev_tokens,
      avg(developers) FILTER(WHERE day BETWEEN date(?1,'-7 days') AND date(?1,'-1 day')) AS current_users,
      avg(developers) FILTER(WHERE day BETWEEN date(?1,'-14 days') AND date(?1,'-8 days')) AS prev_users FROM filled),
    mix AS (SELECT 1 AS pos,'input' AS key,input AS tokens FROM totals UNION ALL SELECT 2,'cache_read',cache_read FROM totals
      UNION ALL SELECT 3,'cache_write',cache_write FROM totals UNION ALL SELECT 4,'output',output FROM totals UNION ALL SELECT 5,'reasoning',reasoning FROM totals),
    users AS (SELECT user_id,sum(tokens) AS tokens FROM usage GROUP BY user_id),
    bands AS (SELECT CASE WHEN tokens<1000000 THEN 1 WHEN tokens<10000000 THEN 2 WHEN tokens<100000000 THEN 3 WHEN tokens<1000000000 THEN 4 ELSE 5 END AS pos,
      count(*) AS developers,sum(tokens) AS tokens FROM users GROUP BY pos),
    machines AS (SELECT lower(trim(platform)) AS name,row_number() OVER(PARTITION BY machine_hash ORDER BY last_seen_at DESC) AS n
      FROM tokentracker_telemetry_daily WHERE day>=date(?1,'-29 days') AND trim(platform)<>''),
    platforms AS (SELECT name,count(*) AS n FROM machines WHERE machines.n=1 GROUP BY name)
    INSERT INTO community_snapshot(id,generated_at,payload)
    SELECT 'total',?2,json_object(
      'top_models',json((SELECT json_group_array(json_object('name',name,'tokens',tokens,'share',coalesce(round(tokens*1000.0/nullif(t.tokens,0))/10,0)) ORDER BY tokens DESC,name) FROM models)),
      'providers',json((SELECT json_group_array(json_object('name',name,'tokens',tokens,'developers',developers,'share',coalesce(round(tokens*1000.0/nullif(t.tokens,0))/10,0)) ORDER BY tokens DESC,name) FROM providers)),
      'daily_growth',json((SELECT json_group_array(json_object('day',day,'tokens',tokens,'tokens_7d_avg',avg7,'active_developers',developers) ORDER BY day) FROM series)),
      'token_mix',json((SELECT json_group_array(json_object('key',key,'tokens',tokens,'share',coalesce(round(tokens*1000.0/nullif((SELECT sum(tokens) FROM mix),0))/10,0)) ORDER BY pos) FROM mix)),
      'user_distribution',json((SELECT json_group_array(json_object('key',CASE pos WHEN 1 THEN 'lt_1m' WHEN 2 THEN '1m_10m' WHEN 3 THEN '10m_100m' WHEN 4 THEN '100m_1b' ELSE '1b_plus' END,
        'developers',developers,'tokens',tokens,'developer_share',coalesce(round(developers*1000.0/nullif(t.developers,0))/10,0),'token_share',coalesce(round(tokens*1000.0/nullif(t.tokens,0))/10,0)) ORDER BY pos) FROM bands)),
      'platforms',json((SELECT json_group_array(json_object('name',name,'machines',n,'share',round(n*1000.0/(SELECT sum(n) FROM platforms))/10) ORDER BY n DESC,name) FROM platforms)),
      'total_tokens',t.tokens,'active_developers_total',t.developers,'active_developers_30d',t.developers_30d,'tokens_30d',t.tokens_30d,
      'token_growth_pct',round((g.current_tokens-g.prev_tokens)*1000.0/nullif(g.prev_tokens,0))/10,
      'developer_growth_pct',round((g.current_users-g.prev_users)*1000.0/nullif(g.prev_users,0))/10,
      'period','total','from','1970-01-01','to',?1,'generated_at',?2
    ) FROM totals t CROSS JOIN growth g WHERE true
    ON CONFLICT(id) DO UPDATE SET generated_at=excluded.generated_at,payload=excluded.payload
      WHERE julianday(excluded.generated_at)>=julianday(community_snapshot.generated_at)`,
    )
    .bind(today, now)
    .run();
  return { upserted: result.meta.changes };
}
