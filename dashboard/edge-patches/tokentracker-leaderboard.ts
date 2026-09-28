/**
 * InsForge Edge: public leaderboard list.
 *
 * IMPORTANT — why no Authorization header is read here:
 * InsForge's platform gateway validates any incoming `Authorization: Bearer ...`
 * against the service JWT secret *before* this function runs. Any token problem
 * (bad signature, expired, wrong issuer, stale after key rotation) is surfaced
 * as an opaque HTTP 500 JWSError instead of a proper 401. That blew up the
 * Leaderboard for real users whose stored access_token drifted (GitHub issue #6
 * / Linear 001-51).
 *
 * Fix: this endpoint is now purely public. The client passes its own `user_id`
 * as a query parameter (already known from the Insforge auth context) to get
 * `is_me` highlighting. The function never touches the Authorization header,
 * so no JWT validation path can ever fire for Leaderboard reads.
 *
 * Security note: `user_id` from the query is only used for row-highlight. All
 * leaderboard entries are public data in `tokentracker_leaderboard_snapshots`,
 * so spoofing `user_id` at worst re-highlights a different row — no PII or
 * private data is exposed.
 */
import { createClient } from "npm:@insforge/sdk";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};
const BLOCKED_LEADERBOARD_USER_IDS = new Set(
  (Deno.env.get("LEADERBOARD_BLOCKED_USER_IDS") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

/**
 * Kept deliberately plain: do NOT add Content-Encoding here.
 *
 * This endpoint carried a gzip branch for a while (body over 1 KB and a caller
 * advertising gzip got a compressed stream). It never reached a client. The
 * InsForge gateway decompresses an encoded edge response and forwards it as
 * identity: `Vary: Accept-Encoding` is passed through, `Content-Encoding` is
 * stripped, and both `Content-Length` and the ETag are computed over the plain
 * body. Verified end to end on 2026-09-20 against the public leaderboard
 * endpoint with cache-busted requests: 77529 bytes on the wire either way, and
 * a body starting with `{"en` rather than the gzip magic 1f 8b.
 *
 * So compressing here only burns CPU twice. The way to shrink these responses
 * is fewer bytes (the *_compact RPCs) or fewer requests (client-side caches).
 */
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      // A leaderboard response is a view of a mutable snapshot. Caching the
      // edge response makes a freshly refreshed snapshot invisible until the
      // browser/CDN TTL expires.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "CDN-Cache-Control": "no-store",
    },
  });
}

/**
 * Decode (without verifying) the `sub` claim from a JWT. Pure back-compat
 * fallback so v0.5.46 clients that still send an Authorization header
 * (instead of the new `user_id` query param) still get `is_me` highlighting.
 * Signature is NOT verified — the value is only used for cosmetic row
 * highlighting on public data, never for authorization.
 */
function unsafeDecodeJwtSub(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const p = parts[1];
    const padded = p
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(p.length + ((4 - (p.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const sub = payload.sub;
    if (typeof sub === "string" && sub.length > 0) return sub;
    const uid = payload.user_id;
    if (typeof uid === "string" && uid.length > 0) return uid;
  } catch {
    /* ignore */
  }
  return null;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const period = url.searchParams.get("period") || "week";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20") || 20, 100);
  const offset = parseInt(url.searchParams.get("offset") || "0") || 0;
  // Preferred path: client passes user_id as a query param (v0.5.51+).
  // Fallback: v0.5.46 clients still send a Bearer token — decode its sub
  // claim (WITHOUT signature verification) so they keep seeing is_me
  // highlighting. Signature validation is unnecessary because sub is only
  // used to pick which public row to highlight.
  let requestedUserId =
    url.searchParams.get("user_id") || url.searchParams.get("userId") || null;
  if (!requestedUserId) {
    const authH = req.headers.get("Authorization");
    const token = authH?.startsWith("Bearer ") ? authH.slice(7) : null;
    if (token) requestedUserId = unsafeDecodeJwtSub(token);
  }

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  // Always use service role (never the caller's token) so a stale/broken
  // caller token can't cascade into a 500 on the DB query.
  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  const now = new Date();
  let from_day: string;
  let to_day: string;
  if (period === "week") {
    // ISO 8601 Monday-start week. Must match
    // tokentracker-leaderboard-refresh.ts AND dashboard/src/lib/date-range.ts
    // so the (period, from_day, to_day) tuple the reader queries matches the
    // tuple the refresh wrote.
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const offset = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - offset); // Monday
    from_day = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 6); // Sunday
    to_day = d.toISOString().slice(0, 10);
  } else if (period === "month") {
    from_day = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    to_day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  } else {
    // period === "total": find the most recent (from_day, to_day) pair written
    // by the refresh job. Hardcoding (2024-01-01, today) used to 404 whenever
    // today's snapshot hadn't been generated yet, so the UI saw "no data".
    const { data: latest } = await client.database
      .from("tokentracker_leaderboard_snapshots")
      .select("from_day, to_day")
      .eq("period", "total")
      .order("to_day", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = latest as { from_day?: string; to_day?: string } | null;
    from_day = (row?.from_day ?? "2024-01-01").slice(0, 10);
    to_day = (row?.to_day ?? now.toISOString()).slice(0, 10);
  }

  const {
    data: entries,
    error,
    count,
  } = await client.database
    .from("tokentracker_leaderboard_snapshots")
    .select("*", { count: "exact" })
    .eq("period", period)
    .eq("from_day", from_day)
    .eq("to_day", to_day)
    .order("rank", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) return json({ error: error.message }, 500);

  let me: unknown = null;
  if (requestedUserId) {
    try {
      const { data: mr } = await client.database
        .from("tokentracker_leaderboard_snapshots")
        .select("*")
        .eq("period", period)
        .eq("from_day", from_day)
        .eq("to_day", to_day)
        .eq("user_id", requestedUserId)
        .limit(1)
        .maybeSingle();
      if (mr) me = mr;
    } catch {
      /* ignore */
    }
  }

  const visibleEntries = (entries || []).filter(
    (e: { user_id?: string }) => !e.user_id || !BLOCKED_LEADERBOARD_USER_IDS.has(e.user_id),
  );
  const visibleMe =
    me && !BLOCKED_LEADERBOARD_USER_IDS.has((me as { user_id?: string }).user_id || "")
      ? me
      : null;

  // Achievement badges: one RPC for the page's users (top-3 per user by tier,
  // then catalog order). Exposure policy mirrors the profile modal: presence
  // in the snapshot table already makes aggregate numbers public, and badges
  // are derived from those same numbers, so every visible row gets its badges
  // (anonymous rows included — badges carry no identity). Fail-soft: the list
  // must never 500 because badges hiccuped.
  type CompactBadge = { id: string; tier: number };
  type CompactBadges = { badges?: CompactBadge[]; badge_count?: number };
  let badgeMap: Record<string, CompactBadges> = {};
  const badgeUserIds = [
    ...new Set(
      [...visibleEntries, visibleMe]
        .map((e) => (e as { user_id?: string } | null)?.user_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (badgeUserIds.length > 0) {
    try {
      const { data: badgeData, error: badgeErr } = await client.database.rpc(
        "user_badges_compact",
        { p_user_ids: badgeUserIds },
      );
      if (!badgeErr && badgeData && typeof badgeData === "object") {
        badgeMap = badgeData as Record<string, CompactBadges>;
      }
    } catch {
      /* fail-soft: render the list without badges */
    }
  }
  const badgesFor = (e: { user_id?: string } | null) => ({
    badges: (e?.user_id && badgeMap[e.user_id]?.badges) || [],
    badge_count: (e?.user_id && badgeMap[e.user_id]?.badge_count) || 0,
  });
  // `generated_at` belongs to the persisted snapshot, not to this read
  // request. Returning the request time made stale month/total snapshots look
  // fresh to both the dashboard and the freshness watchdog. Include `me` as a
  // fallback because a page beyond the end of the public ranking can have no
  // rows while the signed-in user's snapshot row still exists.
  const snapshotGeneratedAt = [...(entries || []), ...(me ? [me] : [])]
    .map((entry: { generated_at?: unknown }) =>
      typeof entry.generated_at === "string" ? entry.generated_at : null,
    )
    .find((value): value is string => Boolean(value)) ?? null;

  return json({
    entries: visibleEntries.map((e: { user_id?: string }) => ({
      ...e,
      ...badgesFor(e),
      is_me: (visibleMe as { user_id?: string } | null)?.user_id === e.user_id,
    })),
    me: visibleMe ? { ...(visibleMe as Record<string, unknown>), ...badgesFor(visibleMe as { user_id?: string }) } : null,
    total_entries: count || 0,
    total_pages: Math.ceil((count || 0) / limit),
    from: from_day,
    to: to_day,
    generated_at: snapshotGeneratedAt,
  });
}
