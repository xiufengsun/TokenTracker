import { prepareReportDays } from "./report-refresh";

export function pruneSnapshots(db: D1Database) {
  return db
    .prepare(
      `DELETE FROM tokentracker_leaderboard_snapshots WHERE rowid IN (
    SELECT id FROM (SELECT rowid AS id,dense_rank() OVER(PARTITION BY period ORDER BY to_day DESC) AS r
    FROM tokentracker_leaderboard_snapshots) WHERE r>3)`,
    )
    .run();
}

export async function queueSummary(db: D1Database) {
  const row = await db
    .prepare(
      `SELECT count(*) FILTER(WHERE status='auto_excluded') AS auto_excluded,
    count(*) FILTER(WHERE status='review') AS review,coalesce(max(peak_tokens),0) AS max_peak_tokens,
    max(detected_at) AS latest_detected_at FROM tokentracker_leaderboard_anomaly_flags WHERE status IN ('auto_excluded','review')`,
    )
    .first();
  const state = await db
    .prepare(
      `SELECT last_completed_at AS last_scan_completed_at,last_queue_changed_at,last_response_completed_at
    FROM tokentracker_anticheat_run_state WHERE id=1`,
    )
    .first();
  if (!state) throw new Error("Missing moderation run state");
  return { ok: true, ...row, ...state };
}

export async function quarantineAudit(db: D1Database, blocked: Set<string> | null) {
  if (blocked === null)
    return {
      ok: true,
      blocklist_configured: false,
      orphan_users: 0,
      orphan_rows: 0,
      orphan_tokens: 0,
      oldest_orphan_quarantined_at: null,
      blocked_total: 0,
      blocked_without_flags: 0,
    };
  const state = await db
    .prepare(
      `WITH blocked(uid) AS (SELECT value FROM json_each(?)),orphans AS (
      SELECT * FROM tokentracker_hourly_quarantine q WHERE instr(coalesce(quarantine_reason,''),'RESTORED')=0
        AND NOT EXISTS(SELECT 1 FROM blocked b WHERE b.uid=q.user_id))
    SELECT count(DISTINCT user_id) AS orphan_users,count(*) AS orphan_rows,coalesce(sum(total_tokens),0) AS orphan_tokens,
      min(quarantined_at) AS oldest_orphan_quarantined_at,(SELECT count(*) FROM blocked) AS blocked_total,
      (SELECT count(*) FROM blocked b WHERE NOT EXISTS (SELECT 1 FROM tokentracker_leaderboard_anomaly_flags f WHERE f.user_id=b.uid))
      AS blocked_without_flags FROM orphans`,
    )
    .bind(JSON.stringify([...blocked]))
    .first();
  return { ok: true, blocklist_configured: true, ...state };
}

export async function reconcileQueue(db: D1Database, stamp: string) {
  // String equality preserves the microseconds in the queue revision; SQLite julianday has millisecond precision.
  const done = await db.batch([
    db
      .prepare(
        `DELETE FROM tokentracker_leaderboard_snapshots WHERE EXISTS (
    SELECT 1 FROM tokentracker_anticheat_run_state WHERE id=1 AND last_queue_changed_at=?)
    AND user_id IN (SELECT user_id FROM tokentracker_leaderboard_anomaly_flags WHERE status IN('auto_excluded','banned'))`,
      )
      .bind(stamp),
    db
      .prepare(
        "UPDATE tokentracker_anticheat_run_state SET last_response_completed_at=? WHERE id=1 AND last_queue_changed_at=?",
      )
      .bind(stamp, stamp),
  ]);
  return done[1].meta.changes
    ? {
        ok: true,
        reconciled_snapshot_rows: done[0].meta.changes,
        last_response_completed_at: stamp,
      }
    : null;
}

const names = [
  "exclude_peak_hard",
  "exclude_peak_soft",
  "exclude_ratio",
  "exclude_cohort_ratio",
  "review_peak",
  "review_day_total",
  "exclude_split_bucket_count",
  "review_ratio",
  "review_peak_share",
  "circuit_breaker_users",
  "lookback_days",
] as const;
export async function detectAnomalies(db: D1Database) {
  if (!(await prepareReportDays(db)))
    throw new Error("Historical rollup backfill in progress");
  const config = Object.fromEntries(
    (
      await db
        .prepare("SELECT key,value FROM tokentracker_anticheat_config")
        .all<{ key: string; value: number }>()
    ).results.map((r) => [r.key, r.value]),
  );
  if (!names.every((k) => Number.isFinite(config[k])))
    throw new Error("Incomplete moderation configuration");
  const now = new Date(),
    nowIso = now.toISOString();
  const startTime = new Date(
    +now - Math.round(config.lookback_days) * 86400000,
  ).toISOString();
  const startDay = startTime.slice(0, 10);
  // Bind the configuration once as a one-row CTE shared by every candidate.
  const cut =
    "(peak_tokens>=hard OR (cohort_ratio>=cohort AND peak_tokens>=soft AND ratio>=exc_ratio) OR (day_tokens>=rev_day AND coalesce(split_count,0)>=exclude_split))";
  const query = `WITH cfg(hard,soft,exc_ratio,cohort,rev_peak,rev_day,exclude_split,rev_ratio,rev_share,breaker) AS
    (VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)),
    scoped AS MATERIALIZED (
      SELECT user_id,source,model,hour_start,total_tokens,updated_at FROM tokentracker_hourly WHERE hour_start>=?11
      UNION ALL SELECT user_id,source,model,hour_start,total_tokens,updated_at FROM tokentracker_hourly WHERE hour_start<?11 AND updated_at>=?12
    ), buckets AS (
      SELECT user_id,source,model,hour_start,substr(hour_start,1,10) day,max(total_tokens) tok,max(updated_at) ingested_at
      FROM scoped GROUP BY user_id,source,model,hour_start
    ), daily AS (
      SELECT user_id,day,sum(tok) AS day_tokens,max(tok) AS peak_tokens,max(ingested_at) AS ingested_at FROM buckets GROUP BY user_id,day
    ), model_peaks AS (
      SELECT user_id,source,model,day,max(tok) AS tok FROM buckets GROUP BY user_id,source,model,day
    ), ranked AS (
      SELECT *,row_number() OVER w AS rn,max(tok) OVER(PARTITION BY source,model,day) AS max1,
        nth_value(tok,2) OVER(PARTITION BY source,model,day ORDER BY tok DESC,user_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS max2
      FROM model_peaks WINDOW w AS (PARTITION BY source,model,day ORDER BY tok DESC,user_id)
    ), pick AS (
      SELECT d.*,r.source,r.model,coalesce(CASE WHEN r.rn=1 THEN r.max2 ELSE r.max1 END,0) AS ref,
       row_number() OVER(PARTITION BY d.user_id,d.day ORDER BY r.tok DESC,r.source,r.model) AS ord
      FROM daily d JOIN ranked r ON r.user_id=d.user_id AND r.day=d.day AND d.peak_tokens=r.tok CROSS JOIN cfg
      WHERE (d.day>=substr(?11,1,10) OR (d.ingested_at>=?12 AND (d.peak_tokens>=hard OR d.day_tokens>=rev_day)))
        AND (d.peak_tokens>=min(rev_peak,soft) OR d.day_tokens>=rev_day) AND NOT EXISTS (
        SELECT 1 FROM tokentracker_leaderboard_anomaly_flags f WHERE f.user_id=d.user_id AND f.day=d.day AND status IN('cleared','banned'))
    ), candidates AS MATERIALIZED (SELECT * FROM pick WHERE ord=1),
    history AS (
      SELECT c.user_id,c.day,r.day AS baseline_day,sum(r.total_tokens) AS tok FROM candidates c JOIN tokentracker_leaderboard_rollup_daily_v2 r
        ON r.user_id=c.user_id AND r.day<c.day AND r.day>=date(c.day,'-14 days') GROUP BY c.user_id,c.day,r.day
    ), numbered AS (
      SELECT *,row_number() OVER(PARTITION BY user_id,day ORDER BY tok) AS rn,count(*) OVER(PARTITION BY user_id,day) n FROM history
    ), median AS (
      SELECT user_id,day,avg(tok) AS med FROM numbered WHERE rn IN ((n+1)/2,(n+2)/2) GROUP BY user_id,day
    ), near AS (
      SELECT b.*,row_number() OVER(PARTITION BY b.user_id,b.day,b.source,b.model ORDER BY hour_start) AS seq FROM buckets b
      JOIN candidates c ON c.user_id=b.user_id AND c.day=b.day CROSS JOIN cfg
      WHERE c.day_tokens>=rev_day AND b.tok>=rev_peak*0.75 AND b.tok<soft
        AND NOT EXISTS (SELECT 1 FROM tokentracker_hourly h WHERE h.user_id=b.user_id AND h.source=b.source AND h.model=b.model
            AND h.hour_start=b.hour_start AND h.total_tokens>=soft)
    ), runs AS (
      SELECT user_id,day,count(*) AS n FROM near GROUP BY user_id,day,source,model,unixepoch(hour_start)-seq*1800
    ), splits AS (SELECT user_id,day,max(n) AS split_count FROM runs GROUP BY user_id,day),
    evidence AS (
      SELECT c.*,m.med,round(c.day_tokens*1.0/nullif(m.med,0),2) AS ratio,round(c.peak_tokens*1.0/nullif(c.day_tokens,0),3) AS peak_share,
        CASE WHEN ref>0 THEN round(peak_tokens*1.0/ref,2) ELSE 999999 END AS cohort_ratio,
        coalesce(s.split_count,0) AS split_count,cfg.* FROM candidates c LEFT JOIN median m USING(user_id,day)
        LEFT JOIN splits s USING(user_id,day) CROSS JOIN cfg
    ), stats AS (SELECT count(DISTINCT CASE WHEN ${cut} THEN user_id END) AS suspects FROM evidence)
    INSERT INTO tokentracker_leaderboard_anomaly_flags AS f(user_id,day,peak_tokens,day_tokens,baseline_median,ratio,peak_share,cohort_ratio,
      peak_source,peak_model,status,note,detected_at)
      SELECT user_id,day,peak_tokens,day_tokens,med,ratio,peak_share,cohort_ratio,source,model,
      CASE WHEN suspects<=breaker AND ${cut} THEN 'auto_excluded' ELSE 'review' END,
      CASE WHEN suspects>breaker THEN 'circuit breaker: '||suspects||' users met the exclusion bar in one run; all downgraded to review'
        WHEN day_tokens>=rev_day AND split_count>=exclude_split THEN 'automatic threshold-splitting signal: '||split_count||' consecutive near-threshold buckets for one source/model' END,?13
      FROM evidence CROSS JOIN stats WHERE ${cut} OR (peak_tokens>=rev_peak AND ratio>=rev_ratio AND peak_share>=rev_share) OR day_tokens>=rev_day
      ON CONFLICT(user_id,day) DO UPDATE SET peak_tokens=excluded.peak_tokens,day_tokens=excluded.day_tokens,baseline_median=excluded.baseline_median,
      ratio=excluded.ratio,peak_share=excluded.peak_share,cohort_ratio=excluded.cohort_ratio,note=coalesce(excluded.note,f.note),
      status=CASE WHEN f.status='auto_excluded' THEN f.status ELSE excluded.status END,detected_at=excluded.detected_at
      RETURNING status,(SELECT suspects FROM stats)>?10 AS breaker_tripped`;
  const values = names.slice(0, 10).map((k) => config[k]);
  const result = await db.batch([
    db
      .prepare(query)
      .bind(
        ...values,
        startDay + "T00:00:00.000000Z",
        startTime.slice(0, -1) + "000Z",
        nowIso,
      ),
    db
      .prepare(
        "UPDATE tokentracker_anticheat_run_state SET last_completed_at=? WHERE id=1",
      )
      .bind(nowIso),
  ]);
  const rows = result[0].results as {
    status: string;
    breaker_tripped: number;
  }[];
  return {
    inserted_excluded: rows.filter((r) => r.status === "auto_excluded").length,
    inserted_review: rows.filter((r) => r.status === "review").length,
    breaker_tripped: rows.some((r) => Boolean(r.breaker_tripped)),
    queue: await queueSummary(db),
  };
}
