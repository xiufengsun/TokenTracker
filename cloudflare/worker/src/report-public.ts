import { reportJson } from "./report-account";
export interface PublicEnv {
  DB: D1Database;
  LEADERBOARD_BLOCKED_USER_IDS?: string;
}

export function publicBlocklist(env: PublicEnv): Set<string> | null {
  if (typeof env.LEADERBOARD_BLOCKED_USER_IDS !== "string") return null;
  return new Set(
    env.LEADERBOARD_BLOCKED_USER_IDS.toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
export async function snapshotBounds(db: D1Database, period: string) {
  const now = new Date();
  if (period === "week") {
    now.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    const from_day = now.toISOString().slice(0, 10);
    now.setUTCDate(now.getUTCDate() + 6);
    return { from_day, to_day: now.toISOString().slice(0, 10) };
  }
  if (period === "month")
    return {
      from_day: now.toISOString().slice(0, 7) + "-01",
      to_day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
        .toISOString()
        .slice(0, 10),
    };
  return (
    (await db
      .prepare(
        "SELECT from_day,to_day FROM tokentracker_leaderboard_snapshots WHERE period='total' ORDER BY to_day DESC LIMIT 1",
      )
      .first<{ from_day: string; to_day: string }>()) ?? {
      from_day: "2024-01-01",
      to_day: now.toISOString().slice(0, 10),
    }
  );
}
export interface Snapshot extends Record<string, unknown> {
  user_id: string;
  display_name: string | null;
  rank: number;
  avatar_url: string | null;
  generated_at: string;
  total_tokens: number;
  estimated_cost_usd: number | null;
  is_public: boolean | null;
}
type DbSnapshot = Omit<Snapshot, "is_public"> & { is_public: number | null };
function publicRow(raw: DbSnapshot) {
  return {
    ...raw,
    is_public: raw.is_public === null ? null : Boolean(raw.is_public),
    estimated_cost_usd:
      raw.estimated_cost_usd == null ? null : Number(raw.estimated_cost_usd),
  } as Snapshot;
}
export async function snapshotRow(
  db: D1Database,
  id: string,
  period: string,
  from: string,
  to: string,
) {
  const raw = await db
    .prepare(
      "SELECT * FROM tokentracker_leaderboard_snapshots WHERE user_id=? AND period=? AND from_day=? AND to_day=?",
    )
    .bind(id, period, from, to)
    .first<DbSnapshot>();
  return raw ? publicRow(raw) : null;
}
export async function fullBadges(db: D1Database, id: string, self: boolean) {
  const rows = await db
    .prepare(
      `SELECT json_object('id',b.badge_id,'tier',tier,'metric_value',metric_value,
    'thresholds',json_array(bronze,silver,gold,diamond),'lower_is_better',json(CASE WHEN lower_is_better THEN 'true' ELSE 'false' END),
    'next_threshold',CASE tier WHEN 4 THEN NULL WHEN 3 THEN diamond WHEN 2 THEN gold WHEN 1 THEN silver ELSE bronze END,
    'achieved',json_object('bronze',bronze_at,'silver',silver_at,'gold',gold_at,'diamond',diamond_at),
    'serials',json_object('bronze',bronze_no,'silver',silver_no,'gold',gold_no,'diamond',diamond_no),
    'meta',json(meta),'updated_at',updated_at) AS payload FROM tokentracker_user_badges b JOIN tokentracker_badge_catalog c USING(badge_id)
    WHERE user_id=? AND (? OR tier>=1) ORDER BY tier DESC,sort_order`,
    )
    .bind(id, Number(self))
    .all<{ payload: string }>();
  return rows.results.map((r) => JSON.parse(r.payload));
}
export async function proBadges(db: D1Database, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const now = new Date().toISOString();
  try {
    const rows = await db
      .prepare(
        `SELECT value AS uid FROM json_each(?) u WHERE EXISTS (
      SELECT 1 FROM tokentracker_cloud_policy WHERE environment='live' AND phase='active'
      AND hosting_mode='hosted' AND julianday(launch_at)<=julianday(?2))
      AND NOT EXISTS (SELECT 1 FROM tokentracker_user_settings WHERE user_id=u.value AND leaderboard_anonymous)
      AND (EXISTS (SELECT 1 FROM tokentracker_cloud_payments WHERE user_id=u.value AND environment='live'
        AND julianday(starts_at)<=julianday(?2) AND julianday(ends_at)>julianday(?2)
        AND revoked_at IS NULL AND refunded_cents<amount_cents) OR EXISTS (
          SELECT 1 FROM tokentracker_cloud_gift_grants WHERE user_id=u.value AND environment='live'
          AND julianday(starts_at)<=julianday(?2) AND julianday(ends_at)>julianday(?2) AND revoked_at IS NULL))`,
      )
      .bind(JSON.stringify(ids), now)
      .all<{ uid: string }>();
    return new Set(rows.results.map((r) => r.uid));
  } catch {
    return new Set<string>();
  } // Old deployments render the leaderboard without Pro adornments on a billing error.
}
function highlight(req: Request, p: URLSearchParams) {
  const id = p.get("user_id") || p.get("userId");
  if (id) return id;
  const h = req.headers.get("Authorization");
  if (!h?.startsWith("Bearer ")) return null;
  try {
    // Legacy highlighting only. Never used for access or private profile fields.
    const payload = JSON.parse(
      atob(h.slice(7).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return String(payload.sub || payload.user_id || "") || null;
  } catch {
    return null;
  }
}
export async function leaderboard(
  req: Request,
  db: D1Database,
  blocked: Set<string>,
) {
  const p = new URL(req.url).searchParams,
    period = p.get("period") || "week";
  const limit = Math.min(100, parseInt(p.get("limit") || "20") || 20),
    offset = parseInt(p.get("offset") || "0") || 0;
  if (limit <= 0 || offset < 0)
    return reportJson({ error: "Failed to fetch leaderboard" }, 500);
  const { from_day, to_day } = await snapshotBounds(db, period);
  const id = highlight(req, p);
  const base =
    " FROM tokentracker_leaderboard_snapshots WHERE period=? AND from_day=? AND to_day=?";
  const args = [period, from_day, to_day];
  const results = await db.batch([
    db
      .prepare("SELECT *" + base + " ORDER BY rank LIMIT ? OFFSET ?")
      .bind(...args, limit, offset),
    db.prepare("SELECT count(*) AS total" + base).bind(...args),
  ]);
  const all = (results[0].results as DbSnapshot[]).map(publicRow);
  const total = Number((results[1].results[0] as { total: number }).total);
  const me = id
    ? await snapshotRow(db, id, ...(args as [string, string, string]))
    : null;
  const visible = all.filter((r) => !blocked.has(r.user_id.toLowerCase()));
  const my = me && !blocked.has(me.user_id.toLowerCase()) ? me : null;
  const ids = [
    ...new Set([...visible.map((r) => r.user_id), ...(my ? [my.user_id] : [])]),
  ];
  const pro = await proBadges(db, ids);
  const badges = new Map<
    string,
    { badges: { id: string; tier: number }[]; badge_count: number }
  >();
  if (ids.length) {
    const rs = await db
      .prepare(
        `SELECT b.user_id,b.badge_id,b.tier FROM tokentracker_user_badges b JOIN tokentracker_badge_catalog c USING(badge_id)
      WHERE user_id IN (SELECT value FROM json_each(?)) AND tier>=1 ORDER BY b.user_id,tier DESC,sort_order`,
      )
      .bind(JSON.stringify(ids))
      .all<{ user_id: string; badge_id: string; tier: number }>();
    for (const r of rs.results) {
      const b = badges.get(r.user_id) ?? { badges: [], badge_count: 0 };
      b.badge_count++;
      if (b.badges.length < 3) b.badges.push({ id: r.badge_id, tier: r.tier });
      badges.set(r.user_id, b);
    }
  }
  const decorate = (r: Snapshot) => ({
    ...r,
    ...(badges.get(r.user_id) || { badges: [], badge_count: 0 }),
    pro_active: pro.has(r.user_id),
  });
  return reportJson({
    entries: visible.map((r) => ({
      ...decorate(r),
      is_me: my?.user_id === r.user_id,
    })),
    me: my ? decorate(my) : null,
    total_entries: total,
    total_pages: Math.ceil(total / limit),
    from: from_day,
    to: to_day,
    generated_at: all[0]?.generated_at ?? me?.generated_at ?? null,
  });
}
