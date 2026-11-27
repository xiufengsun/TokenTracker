export type BillingEnvironment = "live" | "sandbox";

export interface Membership {
  environment: BillingEnvironment;
  phase: string;
  status: string;
  expires_at: string | null;
  trial_ends_at: string | null;
  transition_ends_at: string | null;
  read_only_until: string | null;
  gift_expires_at: string | null;
  access_source: string;
  has_gift: boolean;
  trial_available: boolean;
  can_read_cloud: boolean;
  can_upload_cloud: boolean;
  machine_limit: number | null;
  sync_interval_seconds: number;
  hourly_history_days: number;
  daily_history_months: number;
}

// Insert only trusted SQL expressions here. The two expressions occur once, in argument order.
// Using a subquery lets admission checks and writes run in the same D1 transaction.
export function membershipQuery(
  userSql: string,
  environmentSql: string,
): string {
  return `WITH
    member_args(uid,scope) AS (VALUES(${userSql},${environmentSql})),
    policy AS (SELECT p.*, a.uid, julianday('now') AS as_of FROM tokentracker_cloud_policy p
      JOIN member_args a ON p.environment=a.scope WHERE p.hosting_mode='hosted'),
    trial AS (SELECT julianday(trial_ends_at) AS ends FROM tokentracker_cloud_accounts,member_args
      WHERE user_id=uid AND environment=scope),
    paid AS (SELECT julianday(starts_at) AS starts,julianday(ends_at) AS ends,
        julianday(revoked_at) AS revoked,refunded_cents=amount_cents AS refunded
      FROM tokentracker_cloud_payments,member_args WHERE user_id=uid AND environment=scope),
    gifts AS (SELECT julianday(starts_at) AS starts,julianday(ends_at) AS ends,julianday(revoked_at) AS revoked
      FROM tokentracker_cloud_gift_grants,member_args WHERE user_id=uid AND environment=scope),
    base AS (SELECT policy.*, (SELECT ends FROM trial) AS trial_end,
        CASE WHEN EXISTS(SELECT 1 FROM tokentracker_devices d WHERE d.user_id=policy.uid
          AND julianday(d.created_at)<julianday(policy.launch_at)) THEN julianday(launch_at,'+30 days') END AS transition_end
      FROM policy),
    intervals AS (SELECT starts,ends FROM paid WHERE NOT refunded AND revoked IS NULL
      UNION ALL SELECT starts,ends FROM gifts WHERE revoked IS NULL),
    coverage AS (SELECT starts,ends, max(ends) OVER (ORDER BY starts,ends ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_end
      FROM intervals,base WHERE ends>base.as_of),
    connected AS (SELECT ends,sum(starts>max(base.as_of,coalesce(prior_end,base.as_of)))
      OVER (ORDER BY starts,ends ROWS UNBOUNDED PRECEDING) AS gaps FROM coverage,base),
    base_coverage AS (SELECT starts,ends,max(ends) OVER (ORDER BY starts,ends ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_end
      FROM paid,base WHERE NOT refunded AND ends>base.as_of),
    base_connected AS (SELECT ends,sum(starts>max(as_of,coalesce(trial_end,0),coalesce(transition_end,0),coalesce(prior_end,0)))
      OVER (ORDER BY starts,ends ROWS UNBOUNDED PRECEDING) AS gaps FROM base_coverage,base),
    signals AS (SELECT base.*,
        max(coalesce(trial_end,0),coalesce(transition_end,0),coalesce((SELECT max(ends) FROM base_connected WHERE gaps=0),0)) AS base_end,
        EXISTS(SELECT 1 FROM paid WHERE NOT refunded AND revoked IS NULL AND starts<=as_of AND ends>as_of) AS paid_now,
        EXISTS(SELECT 1 FROM gifts WHERE revoked IS NULL AND starts<=as_of AND ends>as_of) AS gift_now,
        (SELECT max(ends) FROM connected WHERE gaps=0) AS contiguous_end,
        (SELECT max(ends) FROM gifts WHERE revoked IS NULL AND ends>as_of) AS gift_end,
        (SELECT max(val) FROM (
          SELECT trial_end AS val UNION ALL SELECT transition_end
          UNION ALL SELECT max(CASE WHEN refunded THEN min(ends,coalesce(revoked,ends)) ELSE ends END) FROM paid WHERE starts<=as_of
          UNION ALL SELECT max(min(ends,coalesce(revoked,ends))) FROM gifts WHERE starts<=as_of AND (revoked IS NULL OR revoked>starts)
        )) AS history_end
      FROM base),
    state AS (SELECT signals.*, CASE WHEN phase='preview' THEN 'legacy_free'
       WHEN paid_now OR gift_now THEN 'active' WHEN trial_end>as_of THEN 'trial'
       WHEN transition_end>as_of THEN 'transition' WHEN history_end IS NOT NULL THEN 'expired' ELSE 'free' END AS status
      FROM signals)
    SELECT environment,phase,status,
      strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN status='active' THEN contiguous_end
        WHEN base_end>as_of THEN base_end END) AS expires_at,
      strftime('%Y-%m-%dT%H:%M:%fZ',trial_end) AS trial_ends_at,
      strftime('%Y-%m-%dT%H:%M:%fZ',transition_end) AS transition_ends_at,
      strftime('%Y-%m-%dT%H:%M:%fZ',history_end+30) AS read_only_until,
      strftime('%Y-%m-%dT%H:%M:%fZ',gift_end) AS gift_expires_at,
      CASE WHEN phase<>'active' THEN 'none' WHEN paid_now AND gift_now THEN 'mixed' WHEN paid_now THEN 'payment'
        WHEN gift_now THEN 'gift' ELSE 'none' END AS access_source,
      gift_end IS NOT NULL AS has_gift, trial_end IS NULL AND NOT EXISTS(SELECT 1 FROM paid)
        AND NOT EXISTS(SELECT 1 FROM gifts) AS trial_available,
      status IN ('legacy_free','active','trial','transition') OR (status='expired' AND history_end+30>as_of) AS can_read_cloud,
      status IN ('legacy_free','active','trial','transition') AS can_upload_cloud,
      CASE WHEN status='legacy_free' THEN NULL WHEN status IN ('active','trial','transition') THEN 99 ELSE 1 END AS machine_limit,
      CASE WHEN status IN ('legacy_free','active','trial','transition') THEN 900 ELSE 86400 END AS sync_interval_seconds,
      90 AS hourly_history_days,24 AS daily_history_months FROM state`;
}

export async function readMembership(
  db: D1Database,
  userId: string,
  environment: BillingEnvironment,
): Promise<Membership> {
  const row = await db
    .prepare(membershipQuery("?", "?"))
    .bind(userId, environment)
    .first<Membership>();
  if (!row) throw new Error("Missing billing policy");
  return {
    ...row,
    has_gift: Boolean(row.has_gift),
    trial_available: Boolean(row.trial_available),
    can_read_cloud: Boolean(row.can_read_cloud),
    can_upload_cloud: Boolean(row.can_upload_cloud),
  };
}
