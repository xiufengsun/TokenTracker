import type { CloudOrder } from "../../../dashboard/edge-patches/cloud/contracts";
import {
  confirmExpiredUnusedWaffoCheckout,
  type WaffoConfig,
} from "../../../dashboard/edge-patches/cloud/waffo";
import { readMembership } from "./billing-membership";
import { mutateOwner } from "./billing-orders";

async function codeHash(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    /[^\x00-\x7f]/.test(value)
  )
    return null;
  const normal = value.replace(/[- \t\r\n\f\v]/g, "").toUpperCase();
  if (!/^TTPRO[0-9A-F]{32}$/.test(normal)) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normal),
  );
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}

export async function claimGift(
  db: D1Database,
  user: string,
  config: WaffoConfig,
  rawCode: unknown,
  request: string,
) {
  const hash = await codeHash(rawCode),
    scope = config.environment;
  async function attempt() {
    return await mutateOwner(db, user, scope, async (t) => {
      const code = await t
        .stmt(
          `SELECT c.id,b.duration_days,b.redeem_before,b.disabled_at FROM tokentracker_cloud_gift_codes c
        JOIN tokentracker_cloud_gift_batches b ON b.id=c.batch_id AND b.environment=c.environment WHERE c.environment=? AND c.code_hash=?`,
          scope,
          hash,
        )
        .first();
      const grant =
        code &&
        (await t
          .stmt(
            "SELECT id,user_id FROM tokentracker_cloud_gift_grants WHERE code_id=?",
            code.id,
          )
          .first());
      if (grant && grant.user_id === user)
        return { status: 200, id: String(grant.id), reused: true };
      if (
        !(await t
          .stmt(
            "SELECT 1 FROM tokentracker_cloud_policy WHERE environment=? AND phase='active' AND hosting_mode='hosted' AND julianday(launch_at)<=julianday('now')",
            scope,
          )
          .first())
      )
        return { status: 409, error: "gift_not_available" };
      const history = await t
        .stmt(
          "SELECT window_started_at,failed_attempts FROM tokentracker_cloud_gift_attempts WHERE user_id=? AND environment=?",
          user,
          scope,
        )
        .first();
      const now = Date.now(),
        since = history ? Date.parse(String(history.window_started_at)) : 0;
      if (now - since < 900000 && Number(history?.failed_attempts) >= 10)
        return {
          status: 429,
          error: "gift_redemption_rate_limited",
          retry: Math.max(1, Math.ceil((since + 900000 - now) / 1000)),
        };
      if (
        !code ||
        grant ||
        code.disabled_at ||
        Date.parse(String(code.redeem_before)) <= now ||
        (await t
          .stmt(
            "SELECT 1 FROM tokentracker_cloud_gift_grants WHERE user_id=? AND environment=? AND request_id=?",
            user,
            scope,
            request,
          )
          .first())
      ) {
        t.writes.push(
          t.stmt(
            `INSERT INTO tokentracker_cloud_gift_attempts VALUES(?,?,?,?)
          ON CONFLICT(user_id,environment) DO UPDATE SET window_started_at=excluded.window_started_at,failed_attempts=excluded.failed_attempts`,
            user,
            scope,
            new Date(now - since >= 900000 ? now : since).toISOString(),
            now - since >= 900000 ? 1 : Number(history?.failed_attempts) + 1,
          ),
        );
        return { status: 400, error: "gift_code_unavailable" };
      }
      if (
        await t
          .stmt(
            `SELECT 1 FROM tokentracker_cloud_subscriptions WHERE user_id=? AND environment=?
        AND status IN ('pending','active','trialing','past_due','paused') AND cancel_at_period_end=0`,
            user,
            scope,
          )
          .first()
      )
        return { status: 409, error: "gift_requires_renewal_cancel" };
      if (
        await t
          .stmt(
            "SELECT 1 FROM tokentracker_cloud_orders WHERE user_id=? AND environment=? AND status IN ('pending','ready')",
            user,
            scope,
          )
          .first()
      )
        return { status: 409, error: "gift_checkout_pending" };
      const intervals = await t
        .stmt(
          `SELECT starts_at,ends_at FROM tokentracker_cloud_payments
        WHERE user_id=?1 AND environment=?2 AND refunded_cents<amount_cents AND revoked_at IS NULL AND julianday(ends_at)>julianday('now')
        UNION ALL SELECT starts_at,ends_at FROM tokentracker_cloud_gift_grants
        WHERE user_id=?1 AND environment=?2 AND revoked_at IS NULL AND julianday(ends_at)>julianday('now')`,
          user,
          scope,
        )
        .all<{ starts_at: string; ends_at: string }>();
      let start = now;
      for (const period of intervals.results.sort(
        (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
      )) {
        if (Date.parse(period.starts_at) > start) break;
        start = Math.max(start, Date.parse(period.ends_at));
      }
      const id = crypto.randomUUID(),
        days = Number(code.duration_days);
      t.writes.push(
        t.stmt(
          "INSERT INTO tokentracker_cloud_gift_grants(id,code_id,user_id,environment,request_id,duration_days,redeemed_at,starts_at,ends_at) VALUES(?,?,?,?,?,?,?,?,?)",
          id,
          code.id,
          user,
          scope,
          request,
          days,
          new Date(now).toISOString(),
          new Date(start).toISOString(),
          new Date(start + days * 86400000).toISOString(),
        ),
      );
      return { status: 200, id, reused: false };
    });
  }
  let result;
  try {
    result = await attempt();
  } catch (e) {
    // Different accounts can present the same code concurrently. Re-read the winning grant.
    if (!String(e).includes("tokentracker_cloud_gift_grants.code_id")) throw e;
    result = await attempt();
  }
  if (result.error === "gift_checkout_pending") {
    const pending = await db
      .prepare(
        `SELECT * FROM tokentracker_cloud_orders WHERE user_id=? AND environment=?
      AND status IN ('ready','pending') ORDER BY created_at LIMIT 10`,
      )
      .bind(user, scope)
      .all<CloudOrder>();
    let closed = false;
    for (const order of pending.results) {
      if (
        order.cancel_requested_at ||
        order.provider !== "waffo" ||
        !(await confirmExpiredUnusedWaffoCheckout(order, config))
      )
        continue;
      await mutateOwner(db, user, scope, async (t) => {
        const current = await t.order(order.id);
        if (
          !current.cancel_requested_at &&
          ["pending", "ready"].includes(current.status) &&
          current.expires_at === order.expires_at &&
          current.provider_checkout_id === order.provider_checkout_id &&
          current.checkout_attempts ===
            (order as CloudOrder & { checkout_attempts: number })
              .checkout_attempts
        ) {
          t.writes.push(
            t.stmt(
              "UPDATE tokentracker_cloud_orders SET status='closed' WHERE id=?",
              order.id,
            ),
          );
          closed = true;
        }
      });
    }
    if (closed) result = await attempt();
  }
  if (result.status !== 200)
    return {
      status: result.status,
      retry: result.retry,
      data: { error: result.error, retry_after: result.retry },
    };
  const gift = await db
    .prepare(
      `SELECT id,duration_days,redeemed_at,starts_at,ends_at,revoked_at,CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
    WHEN julianday(starts_at)>julianday('now') THEN 'pending' WHEN julianday(ends_at)<=julianday('now') THEN 'expired' ELSE 'active' END AS state
    FROM tokentracker_cloud_gift_grants WHERE id=? AND user_id=? AND environment=?`,
    )
    .bind(result.id, user, scope)
    .first();
  if (!gift) throw new Error("Missing committed gift");
  return {
    status: 200,
    data: {
      gift,
      membership: await readMembership(db, user, scope),
      already_redeemed: result.reused,
    },
  };
}
