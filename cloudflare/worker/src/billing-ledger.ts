import { mutateOwner } from "./billing-orders";
import {
  BillingError,
  isoDate,
  object,
  text,
  type CloudOrder,
} from "../../../dashboard/edge-patches/cloud/contracts";
import type { WaffoLedger } from "../../../dashboard/edge-patches/cloud/waffo-reconciliation";
import type { WaffoPeriod } from "../../../dashboard/edge-patches/cloud/waffo";

type Args = Record<string, unknown>;
type Session = Pick<D1DatabaseSession, "prepare" | "batch">;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const conflict = () => new BillingError("payment_evidence_conflict", 409);

function equalEvidence(
  left: string,
  right: Args,
  ignore: string[] = [],
): boolean {
  const a = JSON.parse(left);
  const keys = new Set([...Object.keys(a), ...Object.keys(right)]);
  return [...keys]
    .filter((key) => !ignore.includes(key))
    .every((k) => a[k] === right[k]);
}

function nextTerm(start: string, months: number): string {
  const t = new Date(start);
  const last = new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + months + 1, 0),
  ).getUTCDate();
  const day = Math.min(last, t.getUTCDate());
  t.setUTCDate(1);
  t.setUTCMonth(t.getUTCMonth() + months);
  t.setUTCDate(day);
  return t.toISOString();
}

function validPeriod(start: string, end: string, order: CloudOrder) {
  const length = Date.parse(end) - Date.parse(start);
  const diff = Date.parse(end) - Date.parse(nextTerm(start, order.term_months));
  if (
    length <= 0 ||
    diff > 86400000 ||
    (order.environment === "live" && diff < -86400000)
  )
    throw conflict();
}

// Detect two paid attempts or a paid ancestor of an already attempted retry, without discarding either payment.
const markRetryConflict = `WITH RECURSIVE
  owned AS (SELECT id,retry_order_id,checkout_attempts FROM tokentracker_cloud_orders WHERE user_id=?1 AND environment=?2),
  edges(a,b) AS (SELECT id,retry_order_id FROM owned WHERE retry_order_id IS NOT NULL UNION ALL
                 SELECT retry_order_id,id FROM owned WHERE retry_order_id IS NOT NULL),
  chain(id) AS (SELECT ?3 UNION SELECT edges.b FROM chain JOIN edges ON chain.id=edges.a),
  descendants(id) AS (SELECT retry_order_id FROM owned WHERE id=?3 AND retry_order_id IS NOT NULL
    UNION SELECT o.retry_order_id FROM owned o JOIN descendants d ON o.id=d.id WHERE o.retry_order_id IS NOT NULL)
  UPDATE tokentracker_cloud_orders SET retry_payment_conflict_at=coalesce(retry_payment_conflict_at,${NOW})
  WHERE id IN (SELECT id FROM chain) AND (
    EXISTS(SELECT 1 FROM tokentracker_cloud_payments p JOIN tokentracker_cloud_orders o ON o.id=p.order_id
           WHERE p.order_id=?3 AND p.transaction_id<>?4 AND (o.billing_mode='fixed' OR p.waffo_order_id IS NOT ?5)) OR
    EXISTS(SELECT 1 FROM owned WHERE id IN (SELECT id FROM descendants) AND checkout_attempts>0) OR
    EXISTS(SELECT 1 FROM tokentracker_cloud_payments WHERE user_id=?1 AND environment=?2 AND order_id<>?3
           AND order_id IN (SELECT id FROM chain)))`;

function validateEvent(order: CloudOrder, event: Args) {
  const kind = text(event.kind),
    id = text(event.event_id),
    action = text(event.action_id),
    remote = text(event.waffo_order_id);
  const occurred = isoDate(event.occurred_at),
    recurring = order.billing_mode === "recurring";
  if (
    event.order_id !== order.id ||
    event.provider_price_id !== order.provider_price_id ||
    Date.parse(occurred) > Date.now() + 300000 ||
    !["authorization", "payment", "refund", "subscription"].includes(kind) ||
    (recurring
      ? event.subscription_id !== remote
      : !!event.subscription_id || kind === "subscription")
  )
    throw conflict();
  return { kind, id, action, remote, occurred, recurring };
}

async function recordAuthorization(
  db: Session,
  order: CloudOrder,
  event: Args,
) {
  const { kind, action, remote, recurring } = validateEvent(order, event);
  if (kind !== "authorization") throw conflict();
  const scope = order.environment,
    orderId = order.id,
    payload = JSON.stringify(event);
  const stmt = (sql: string, ...params: unknown[]) =>
    db.prepare(sql).bind(...params);
  if (
    !(await stmt(
      "SELECT 1 FROM tokentracker_cloud_waffo_attempts WHERE order_id=? AND environment=? AND waffo_order_id=? AND provider_price_id=? AND billing_mode='recurring'",
      orderId,
      scope,
      remote,
      order.provider_price_id,
    ).first())
  )
    throw conflict();

  if (
    !recurring ||
    event.period_number !== 0 ||
    event.currency !== order.currency ||
    event.base_amount_cents !== order.amount_cents ||
    event.amount_cents !== 0 ||
    event.action_id !== event.transaction_id ||
    event.starts_at ||
    event.ends_at
  )
    throw conflict();
  await stmt(
    "INSERT INTO tokentracker_cloud_waffo_authorizations(environment,transaction_id,order_id,waffo_order_id,normalized_event) VALUES (?,?,?,?,?) ON CONFLICT(environment,transaction_id) DO NOTHING",
    scope,
    action,
    orderId,
    remote,
    payload,
  ).run();
  const stored = await stmt(
    "SELECT normalized_event FROM tokentracker_cloud_waffo_authorizations WHERE environment=? AND transaction_id=?",
    scope,
    action,
  ).first<string>("normalized_event");
  if (!stored || !equalEvidence(stored, event)) throw conflict();
}

// Plan all events against one owner revision, including effects of earlier events in this batch.
// Commit only after the entire provider snapshot validates. A refund error cannot leak a partial grant.
async function applyFinancial(
  db: D1Database,
  order: CloudOrder,
  events: Args[],
) {
  if (!events.length || events.length > 100) throw conflict();
  const { id: orderId, user_id: user, environment: scope } = order;
  await mutateOwner(db, user, scope, async ({ stmt, writes }) => {
    const remoteIds = JSON.stringify([
      ...new Set(events.map((e) => text(e.waffo_order_id))),
    ]);
    const eventIds = JSON.stringify(events.map((e) => text(e.event_id)));
    const actionIds = JSON.stringify(events.map((e) => text(e.action_id)));
    const attempts = (
      await stmt(
        "SELECT waffo_order_id,provider_price_id,billing_mode FROM tokentracker_cloud_waffo_attempts WHERE order_id=? AND environment=?",
        orderId,
        scope,
      ).all()
    ).results;
    const periodRows = (
      await stmt(
        "SELECT waffo_order_id,period_number,starts_at,ends_at FROM tokentracker_cloud_waffo_periods WHERE order_id=? AND environment=?",
        orderId,
        scope,
      ).all()
    ).results;
    const paymentRows = (
      await stmt(
        "SELECT id,provider,transaction_id,order_id,user_id,currency,amount_cents,refunded_cents,ends_at,waffo_order_id FROM tokentracker_cloud_payments WHERE user_id=? AND environment=?",
        user,
        scope,
      ).all()
    ).results;
    const subscriptionRows = (
      await stmt(
        "SELECT provider_subscription_id,user_id,order_id,last_event_at FROM tokentracker_cloud_subscriptions WHERE provider='waffo' AND environment=? AND provider_subscription_id IN (SELECT value FROM json_each(?))",
        scope,
        remoteIds,
      ).all()
    ).results;
    const eventRows = (
      await stmt(
        `SELECT event_id,normalized_event,kind,action_id,status FROM tokentracker_cloud_events WHERE provider='waffo'
     AND environment=? AND (event_id IN (SELECT value FROM json_each(?)) OR (status='applied' AND kind IN('payment','refund') AND action_id IN(SELECT value FROM json_each(?))))`,
        scope,
        eventIds,
        actionIds,
      ).all()
    ).results;
    const journal = new Map(
      eventRows.map((r) => [String(r.event_id), String(r.normalized_event)]),
    );
    const applied = new Map(
      eventRows
        .filter((r) => r.status === "applied" && r.kind !== "subscription")
        .map((r) => [r.kind + ":" + r.action_id, String(r.normalized_event)]),
    );
    const periods = new Map(
      periodRows.map((r) => [r.waffo_order_id + ":" + r.period_number, r]),
    );
    const payments = new Map(
      paymentRows.map((r) => [r.provider + ":" + r.transaction_id, r]),
    );
    const subscriptions = new Map(
      subscriptionRows.map((r) => [String(r.provider_subscription_id), r]),
    );
    for (const event of events) {
      const { kind, id, action, remote, occurred, recurring } = validateEvent(
        order,
        event,
      );
      if (
        kind === "authorization" ||
        !attempts.some(
          (a) =>
            a.waffo_order_id === remote &&
            a.provider_price_id === order.provider_price_id &&
            a.billing_mode === order.billing_mode,
        )
      )
        throw conflict();
      const prior = journal.get(id);
      if (prior) {
        if (!equalEvidence(prior, event)) throw conflict();
        continue;
      }
      const payload = JSON.stringify(event),
        priorAction = applied.get(kind + ":" + action);
      let status = "applied";
      if (priorAction) {
        if (!equalEvidence(priorAction, event, ["event_id", "occurred_at"]))
          throw conflict();
        status = "duplicate";
      } else if (kind === "payment") {
        const amount = event.amount_cents;
        if (
          event.base_amount_cents !== order.amount_cents ||
          event.currency !== order.currency ||
          !Number.isSafeInteger(amount) ||
          Number(amount) < order.amount_cents ||
          action !== event.transaction_id
        )
          throw conflict();
        let start: string;
        let end: string;
        if (recurring) {
          start = isoDate(event.starts_at);
          end = isoDate(event.ends_at);
          validPeriod(start, end, order);
          const period = periods.get(
            remote + ":" + String(event.period_number),
          );
          if (
            !period ||
            Date.parse(String(period.starts_at)) !== Date.parse(start) ||
            Date.parse(String(period.ends_at)) !== Date.parse(end)
          )
            throw conflict();
          const linked = subscriptions.get(remote);
          if (
            linked &&
            (linked.order_id !== orderId || linked.user_id !== user)
          )
            throw conflict();
          if (!linked)
            subscriptions.set(remote, {
              order_id: orderId,
              user_id: user,
              last_event_at: occurred,
            });
          writes.push(
            stmt(
              `INSERT INTO tokentracker_cloud_subscriptions(provider,environment,provider_subscription_id,user_id,order_id,status,last_event_at,next_billed_at)
          VALUES('waffo',?,?,?,?,'active',?,?) ON CONFLICT(provider,environment,provider_subscription_id) DO UPDATE
          SET next_billed_at=CASE WHEN status IN ('active','trialing','past_due') AND cancel_at_period_end=0
            AND (next_billed_at IS NULL OR julianday(next_billed_at)<julianday(excluded.next_billed_at)) THEN excluded.next_billed_at ELSE next_billed_at END`,
              scope,
              remote,
              user,
              orderId,
              occurred,
              end,
            ),
          );
        } else {
          start = new Date(
            Math.max(
              Date.now(),
              ...Array.from(payments.values(), (p) =>
                Number(p.refunded_cents) < Number(p.amount_cents)
                  ? Date.parse(String(p.ends_at))
                  : 0,
              ),
            ),
          ).toISOString();
          end = nextTerm(start, order.term_months);
        }
        const paymentId = crypto.randomUUID();
        payments.set("waffo:" + action, {
          id: paymentId,
          order_id: orderId,
          user_id: user,
          currency: order.currency,
          amount_cents: amount,
          refunded_cents: 0,
          ends_at: end,
          waffo_order_id: remote,
        });
        writes.push(
          stmt(
            `INSERT INTO tokentracker_cloud_payments(id,order_id,user_id,provider,environment,transaction_id,subscription_id,
        currency,amount_cents,starts_at,ends_at,paid_at,waffo_order_id) VALUES (?,?,?,'waffo',?,?,?,?,?,?,?,?,?)`,
            paymentId,
            orderId,
            user,
            scope,
            action,
            recurring ? remote : null,
            order.currency,
            amount,
            start,
            end,
            occurred,
            remote,
          ),
          stmt(
            `UPDATE tokentracker_cloud_orders SET status='paid',provider_order_id=coalesce(provider_order_id,?),waffo_order_id=coalesce(waffo_order_id,?) WHERE id=?`,
            action,
            remote,
            orderId,
          ),
          stmt(markRetryConflict, user, scope, orderId, action, remote),
        );
      } else if (kind === "refund") {
        const p = payments.get("waffo:" + String(event.transaction_id));
        if (!p) throw new BillingError("waffo_notification_pending", 503);
        if (
          p.order_id !== orderId ||
          p.user_id !== user ||
          p.waffo_order_id !== remote
        )
          throw conflict();
        const amount = Number(event.amount_cents),
          total = Number(p.refunded_cents) + amount;
        if (
          event.currency !== p.currency ||
          !Number.isSafeInteger(amount) ||
          amount <= 0 ||
          total > Number(p.amount_cents)
        )
          throw conflict();
        p.refunded_cents = total;
        writes.push(
          stmt(
            `UPDATE tokentracker_cloud_payments SET refunded_cents=?,revoked_at=CASE WHEN ?=amount_cents THEN ${NOW} ELSE revoked_at END WHERE id=?`,
            total,
            total,
            p.id,
          ),
        );
      } else {
        const priorSub = subscriptions.get(remote);
        if (
          priorSub &&
          (priorSub.user_id !== user || priorSub.order_id !== orderId)
        )
          throw conflict();
        if (
          priorSub &&
          Date.parse(String(priorSub.last_event_at)) >= Date.parse(occurred)
        )
          status = "outdated";
        else {
          subscriptions.set(remote, {
            order_id: orderId,
            user_id: user,
            last_event_at: occurred,
          });
          writes.push(
            stmt(
              `INSERT INTO tokentracker_cloud_subscriptions(provider,environment,provider_subscription_id,user_id,order_id,status,cancel_at_period_end,last_event_at,next_billed_at)
        VALUES ('waffo',?,?,?,?,?,?,?,?) ON CONFLICT(provider,environment,provider_subscription_id) DO UPDATE
        SET status=excluded.status,cancel_at_period_end=excluded.cancel_at_period_end,last_event_at=excluded.last_event_at,next_billed_at=excluded.next_billed_at`,
              scope,
              remote,
              user,
              orderId,
              event.status,
              event.cancel_at_period_end ? 1 : 0,
              occurred,
              event.next_billed_at ?? null,
            ),
          );
        }
      }
      writes.push(
        stmt(
          `INSERT INTO tokentracker_cloud_events(provider,environment,event_id,kind,action_id,order_id,occurred_at,normalized_event,status)
      VALUES ('waffo',?,?,?,?,?,?,?,?)`,
          scope,
          id,
          kind,
          action,
          orderId,
          occurred,
          payload,
          status,
        ),
      );
      journal.set(id, payload);
      if (status === "applied" && kind !== "subscription")
        applied.set(kind + ":" + action, payload);
    }
  });
}
export function waffoLedger(db: D1Database, order: CloudOrder): WaffoLedger {
  const session = db.withSession("first-primary");
  return {
    async periods(bound, offset) {
      const rows = await session
        .prepare(
          `SELECT waffo_order_id,period_number,starts_at,ends_at FROM tokentracker_cloud_waffo_periods
        WHERE order_id=? AND environment=? ORDER BY waffo_order_id,period_number LIMIT 100 OFFSET ?`,
        )
        .bind(bound.id, bound.environment, offset)
        .all<WaffoPeriod>();
      return rows.results;
    },
    async call(name, args) {
      if (args.p_environment !== order.environment) throw conflict();
      if (name === "cloud_register_waffo_attempt") {
        if (
          args.p_order_id !== order.id ||
          args.p_provider_price_id !== order.provider_price_id ||
          args.p_billing_mode !== order.billing_mode
        )
          throw conflict();
        // A newly observed attempt changes the finality evidence used by close and restart.
        // Include it in the same owner revision as those operations.
        await mutateOwner(db, order.user_id, order.environment, async (t) => {
          const stored = await t
            .stmt(
              "SELECT order_id, provider_price_id, billing_mode FROM tokentracker_cloud_waffo_attempts WHERE environment=? AND waffo_order_id=?",
              order.environment,
              args.p_waffo_order_id,
            )
            .first();
          if (
            stored &&
            (stored.order_id !== order.id ||
              stored.provider_price_id !== order.provider_price_id ||
              stored.billing_mode !== order.billing_mode)
          )
            throw conflict();
          if (!stored)
            t.writes.push(
              t.stmt(
                "INSERT INTO tokentracker_cloud_waffo_attempts(order_id,environment,waffo_order_id,provider_price_id,billing_mode) VALUES(?,?,?,?,?)",
                order.id,
                order.environment,
                args.p_waffo_order_id,
                order.provider_price_id,
                order.billing_mode,
              ),
            );
          else
            t.writes.push(
              t.stmt(
                `UPDATE tokentracker_cloud_waffo_attempts SET last_seen_at=${NOW} WHERE environment=? AND waffo_order_id=?`,
                order.environment,
                args.p_waffo_order_id,
              ),
            );
        });
        return;
      }
      if (name === "cloud_record_waffo_period") {
        if (
          args.p_order_id !== order.id ||
          order.billing_mode !== "recurring" ||
          args.p_provider_price_id !== order.provider_price_id
        )
          throw conflict();
        const start = isoDate(args.p_starts_at),
          end = isoDate(args.p_ends_at);
        validPeriod(start, end, order);
        await session
          .prepare(
            `INSERT INTO tokentracker_cloud_waffo_periods VALUES(?,?,?,?,?,?)
          ON CONFLICT(order_id,waffo_order_id,period_number) DO NOTHING`,
          )
          .bind(
            order.id,
            order.environment,
            args.p_waffo_order_id,
            args.p_period_number,
            start,
            end,
          )
          .run();
        const match = await session
          .prepare(
            `SELECT 1 FROM tokentracker_cloud_waffo_periods WHERE order_id=? AND environment=? AND waffo_order_id=?
          AND period_number=? AND julianday(starts_at)=julianday(?) AND julianday(ends_at)=julianday(?)`,
          )
          .bind(
            order.id,
            order.environment,
            args.p_waffo_order_id,
            args.p_period_number,
            start,
            end,
          )
          .first();
        if (!match) throw conflict();
        return;
      }
      if (name === "cloud_record_waffo_authorization")
        return await recordAuthorization(session, order, object(args.p_event));
      if (name === "cloud_apply_waffo_events" && Array.isArray(args.p_events)) {
        return await applyFinancial(db, order, args.p_events.map(object));
      }
      throw new Error("Unknown billing operation");
    },
  };
}
