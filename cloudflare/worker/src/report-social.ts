import { reportJson } from "./report-account";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function likes(
  req: Request,
  db: D1Database,
  caller: string | null,
  blocked: Set<string>,
) {
  let body: Record<string, unknown>;
  if (req.method === "GET")
    body = Object.fromEntries(new URL(req.url).searchParams);
  else if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      return reportJson({ error: "Invalid JSON body" }, 400);
    }
  } else return reportJson({ error: "Method not allowed" }, 405);
  if (!body || typeof body !== "object")
    return reportJson({ error: "target_user_id is required" }, 400);
  const target = body.target_user_id ?? body.user_id;
  if (typeof target !== "string" || !uuid.test(target))
    return reportJson({ error: "target_user_id is required" }, 400);
  if (blocked.has(target.toLowerCase()))
    return reportJson({ error: "Not found" }, 404);
  const anon =
    typeof body.anon_id === "string" && uuid.test(body.anon_id)
      ? "anon_" + body.anon_id
      : null;
  const liker = caller ?? anon;
  const bound = db
    .prepare(
      `SELECT count(*) AS n,coalesce(max(liker_id IN(?,?)),0) AS liked
      FROM tokentracker_profile_likes WHERE target_user_id=?`,
    )
    .bind(liker, anon, target);
  if (req.method === "GET") {
    const state = await bound.first<{ n: number; liked: number }>();
    return reportJson({ count: state!.n, liked: Boolean(state!.liked) });
  }
  const delta = body.action == null && (body.delta === 1 || body.delta === -1);
  if (!delta && body.action !== "like" && body.action !== "unlike")
    return reportJson({ error: "action must be 'like' or 'unlike'" }, 400);
  if (!delta && !liker) return reportJson({ error: "identity required" }, 401);
  const found = await db
    .prepare(
      "SELECT 1 FROM tokentracker_leaderboard_snapshots WHERE user_id=? LIMIT 1",
    )
    .bind(target)
    .first();
  if (!found) return reportJson({ error: "Not found" }, 404);
  const ops: D1PreparedStatement[] = [];
  if (delta && body.delta === -1) {
    ops.push(
      db
        .prepare(
          "DELETE FROM tokentracker_profile_likes WHERE id=(SELECT id FROM tokentracker_profile_likes WHERE target_user_id=? AND substr(liker_id,1,7)='compat_' LIMIT 1)",
        )
        .bind(target),
    );
  } else if (delta || body.action === "like") {
    ops.push(
      db
        .prepare(
          `INSERT INTO tokentracker_profile_likes (id,target_user_id,liker_id,is_authenticated,created_at)
      VALUES (?,?,?,?,?) ON CONFLICT(target_user_id,liker_id) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          target,
          delta ? "compat_" + crypto.randomUUID() : liker,
          Number(!delta && !!caller),
          new Date().toISOString(),
        ),
    );
  } else {
    ops.push(
      db
        .prepare(
          "DELETE FROM tokentracker_profile_likes WHERE target_user_id=? AND liker_id=?",
        )
        .bind(target, liker),
    );
  }
  if (!delta && caller && anon)
    ops.push(
      db
        .prepare(
          "DELETE FROM tokentracker_profile_likes WHERE target_user_id=? AND liker_id=?",
        )
        .bind(target, anon),
    );
  ops.push(bound);
  const result = await db.batch<{ n: number; liked: number }>(ops);
  const state = result[result.length - 1].results[0];
  return reportJson({ count: state.n, liked: !delta && Boolean(state.liked) });
}

export async function visibility(req: Request, db: D1Database, user: string) {
  if (req.method === "GET") {
    const row = await db
      .prepare(
        `SELECT s.leaderboard_public,s.leaderboard_anonymous,s.updated_at,s.github_url,s.show_github_url,
      p.display_name, (SELECT token_hash FROM tokentracker_public_views WHERE user_id=? AND revoked_at IS NULL LIMIT 1) AS share_token
      FROM tokentracker_user_profiles p LEFT JOIN tokentracker_user_settings s ON s.user_id=p.user_id WHERE p.user_id=?`,
      )
      .bind(user, user)
      .first<{
        leaderboard_public: number;
        leaderboard_anonymous: number;
        updated_at: string;
        github_url: string;
        show_github_url: number;
        display_name: string;
        share_token: string;
      }>();
    return reportJson({
      enabled: !!row?.leaderboard_public,
      anonymous: !!row?.leaderboard_anonymous,
      share_token: row?.share_token || null,
      updated_at: row?.updated_at || null,
      display_name: row?.display_name || null,
      github_url: row?.github_url || null,
      show_github_url: !!row?.show_github_url,
    });
  }
  if (req.method !== "POST")
    return reportJson({ error: "Method not allowed" }, 405);
  const body = await req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);
  if (!body || typeof body !== "object")
    return reportJson({ error: "Invalid JSON body" }, 400);
  const now = new Date().toISOString(),
    result: Record<string, unknown> = { updated_at: now };
  const cols: Record<string, string | number | null> = {};
  for (const [key, col] of [
    ["enabled", "leaderboard_public"],
    ["anonymous", "leaderboard_anonymous"],
    ["show_github_url", "show_github_url"],
  ]) {
    if (body[key] !== undefined) {
      result[key] = Boolean(body[key]);
      cols[col] = Number(result[key]);
    }
  }
  if (typeof body.display_name === "string") {
    cols.display_name = body.display_name.trim().slice(0, 50) || null;
    result.display_name = cols.display_name;
  }
  if (body.github_url !== undefined) {
    const raw = body.github_url;
    if (raw === null || (typeof raw === "string" && !raw.trim()))
      cols.github_url = null;
    else if (typeof raw === "string") {
      const m =
        /^@?([A-Za-z\d][A-Za-z\d-]{0,38})$/.exec(raw.trim()) ||
        /^https:\/\/github\.com\/([A-Za-z\d][A-Za-z\d-]{0,38})\/?$/i.exec(
          raw.trim(),
        );
      if (!m)
        return reportJson(
          {
            error:
              "Invalid GitHub URL. Use https://github.com/<username> or a bare username.",
          },
          400,
        );
      cols.github_url = "https://github.com/" + m[1];
    }
    if (cols.github_url !== undefined) result.github_url = cols.github_url;
  }
  const names = Object.keys(cols);
  if (names.length)
    await db
      .prepare(
        `INSERT INTO tokentracker_user_settings(user_id,created_at,updated_at,${names.join(",")})
    VALUES(?,?,?,${names.map(() => "?").join(",")}) ON CONFLICT(user_id) DO UPDATE SET updated_at=excluded.updated_at,${names.map((n) => n + "=excluded." + n).join(",")}`,
      )
      .bind(user, now, now, ...Object.values(cols))
      .run();
  return reportJson(result);
}
