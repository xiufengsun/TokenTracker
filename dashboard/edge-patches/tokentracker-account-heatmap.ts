/**
 * InsForge Edge: account-wide activity heatmap (cross-device, by user_id).
 * Mirrors local-api.js `tokentracker-usage-heatmap` response schema.
 * Level algorithm: 0 if no billable tokens, else 1..4 based on ratio to max.
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

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
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Convert UTC timestamp to local YYYY-MM-DD (see local-api.js#getZonedParts).
 * Positive offsetMinutes = east of UTC.
 */
function zonedDayKey(hourStart: string, tz: string | null, offsetMinutes: number | null): string {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(hourStart));
      const y = parts.find((p) => p.type === "year")?.value;
      const m = parts.find((p) => p.type === "month")?.value;
      const d = parts.find((p) => p.type === "day")?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch { /* fall through */ }
  }
  if (offsetMinutes != null && Number.isFinite(offsetMinutes)) {
    const shifted = new Date(new Date(hourStart).getTime() + offsetMinutes * 60000);
    return shifted.toISOString().slice(0, 10);
  }
  return hourStart.slice(0, 10);
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const raw = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Verify HS256 JWT against JWT_SECRET and return its sub. Mirrors the helper
 * in tokentracker-device-token-issue.ts. Returns null on any failure — caller
 * surfaces that as 401. InsForge does NOT validate JWTs at the gateway, so
 * exposing per-user data without local verification lets anyone forge
 * {"sub":"<victim>"} and read another user's data.
 */
async function verifiedUserIdFromJwt(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as Record<string, unknown>;
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]);
    let ok = false;
    if (header.alg === "HS256") {
      const secret = Deno.env.get("JWT_SECRET");
      if (!secret) return null;
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("HMAC", key, sig, data);
    } else if (header.alg === "RS256") {
      const publicKeyPem = Deno.env.get("JWT_PUBLIC_KEY");
      if (!publicKeyPem) return null;
      const publicKeyDer = Uint8Array.from(atob(publicKeyPem.replace(/-----[^-]+-----|\s/g, "")), (char) => char.charCodeAt(0));
      const key = await crypto.subtle.importKey("spki", publicKeyDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
    } else return null;
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    const sub = payload.sub;
    if (typeof sub === "string" && sub.length > 0) return sub;
    const uid = payload.user_id;
    if (typeof uid === "string" && uid.length > 0) return uid;
  } catch { /* ignore */ }
  return null;
}

// [local day, total tokens, { model: tokens }] as returned by
// account_heatmap_compact. Positional, so the model names are the only
// repeated strings on the wire.
type CompactDay = [string, number | string, Record<string, number | string> | null];

const COMPACT_TTL_MS = 30_000;
const COMPACT_STALE_IF_ERROR_MS = 5 * 60_000;
const compactCache = new Map<string, { fetchedAt: number; days: CompactDay[] }>();
const compactInFlight = new Map<string, Promise<CompactDay[]>>();

/**
 * Server-side aggregation, folded all the way down to one row per local day.
 *
 * account_heatmap_compact() runs the very same account_usage_grouped_cached()
 * scan underneath — same 30s shared Postgres cache, same cross-device dedup —
 * but collapses (bucket, source, model, pricing_tier) x 8 token columns into
 * [day, total_tokens, { model: tokens }] inside Postgres. The heatmap only ever
 * read `bucket`, `model` and `total_tokens`, so shipping the other eight columns
 * over the wire was pure egress: they crossed the network only to be summed and
 * dropped. A 52-week window for a heavy account goes from ~400 KB to ~45 KB,
 * and p90 latency from ~7.3s to ~1.4s (the tail was large-payload transfer
 * jitter, not query time).
 *
 * Range filtering moved into the RPC too (p_range_from/p_range_to), matching the
 * `day < from || day > to` skip this function's caller used to do in JS.
 */
async function fetchHeatmapCompact(
  client: ReturnType<typeof createClient>,
  userId: string,
  requestedDeviceId: string | null,
  fromIso: string,
  toIso: string,
  rangeFrom: string,
  rangeTo: string,
  tz: string | null,
  tzOffsetMinutes: number | null,
): Promise<CompactDay[]> {
  const cacheKey = JSON.stringify([userId, requestedDeviceId, fromIso, toIso, rangeFrom, rangeTo, tz, tzOffsetMinutes]);
  const cached = compactCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < COMPACT_TTL_MS) return cached.days;
  const existing = compactInFlight.get(cacheKey);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const { data, error } = await client.database.rpc("account_heatmap_compact", {
        p_user_id: userId,
        p_device_id: requestedDeviceId,
        p_from: fromIso,
        p_to: toIso,
        p_tz: tz,
        p_offset_min: tzOffsetMinutes,
        p_range_from: rangeFrom,
        p_range_to: rangeTo,
      });
      if (error) throw new Error(error.message);
      const days = (Array.isArray(data) ? data : []) as CompactDay[];
      compactCache.set(cacheKey, { fetchedAt: Date.now(), days });
      if (compactCache.size > 64) {
        const oldest = compactCache.keys().next().value;
        if (oldest) compactCache.delete(oldest);
      }
      return days;
    } catch (error) {
      const stale = compactCache.get(cacheKey);
      if (stale && Date.now() - stale.fetchedAt < COMPACT_STALE_IF_ERROR_MS) return stale.days;
      throw error;
    }
  })().finally(() => compactInFlight.delete(cacheKey));
  compactInFlight.set(cacheKey, pending);
  return pending;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  // Clamp weeks so a buggy/malicious client cannot force a full-history scan
  // (every distinct range is also a cold fill for the shared PG cache).
  const weeksRaw = parseInt(url.searchParams.get("weeks") || "52", 10);
  const weeks = Number.isFinite(weeksRaw) ? Math.min(Math.max(weeksRaw, 1), 104) : 52;
  const tz = url.searchParams.get("tz") || null;
  const tzOffsetRaw = url.searchParams.get("tz_offset_minutes");
  const tzOffsetMinutes = tzOffsetRaw != null && tzOffsetRaw !== "" ? Number(tzOffsetRaw) : null;
  const toParam = url.searchParams.get("to") || "";
  const weekStartsOnRaw = (url.searchParams.get("week_starts_on") || "sun").toLowerCase();
  const weekStartsOn = weekStartsOnRaw === "mon" ? "mon" : "sun";
  // Opt-in sparse wire format (src/lib/heatmap-compact.js rebuilds the grid).
  // A caller that does not ask for it gets the dense payload byte for byte, so
  // every already-shipped client keeps working untouched.
  const wantsCompact = url.searchParams.get("format") === "compact";

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) return json({ error: "server misconfigured" }, 500);

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  const userId = await verifiedUserIdFromJwt(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  const rawDeviceId = url.searchParams.get("device_id");
  const requestedDeviceId = rawDeviceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawDeviceId)
    ? rawDeviceId
    : null;

  // End anchor: caller-supplied `to` in their local day, else local today.
  const toStr = toParam || zonedDayKey(new Date().toISOString(), tz, tzOffsetMinutes);
  const end = new Date(`${toStr}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - weeks * 7 + 1);
  const from = start.toISOString().slice(0, 10);
  const to = toStr;

  // Widen ±1 day so TZ-shifted edges still get caught by the UTC query.
  const startDate = new Date(`${from}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const nextDay = new Date(`${to}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 2);
  const rangeStart = startDate.toISOString();
  const rangeEnd = nextDay.toISOString();

  let compactDays: CompactDay[];
  try {
    compactDays = await fetchHeatmapCompact(client, userId, requestedDeviceId, rangeStart, rangeEnd, from, to, tz, tzOffsetMinutes);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const byDay = new Map<string, { total_tokens: number; billable_total_tokens: number; models: Record<string, number> }>();
  for (const [day, total, models] of compactDays) {
    const tt = Number(total) || 0;
    // Per-model totals so the activity-heatmap tooltip can show MODEL breakdown
    // in cloud mode — mirrors src/lib/local-api.js heatmap cells. Postgres folds
    // a NULL/empty model into "unknown", same as the old String(model || …) did.
    const mdl: Record<string, number> = {};
    if (models) for (const name of Object.keys(models)) mdl[name] = Number(models[name]) || 0;
    byDay.set(day, { total_tokens: tt, billable_total_tokens: tt, models: mdl });
  }

  const allValues = Array.from(byDay.values())
    .map((d) => d.billable_total_tokens)
    .filter((v) => v > 0);
  const maxValue = allValues.length > 0 ? Math.max(...allValues) : 0;
  const calcLevel = (v: number): 0 | 1 | 2 | 3 | 4 => {
    if (v <= 0) return 0;
    if (maxValue === 0) return 1;
    const r = v / maxValue;
    if (r <= 0.25) return 1;
    if (r <= 0.5) return 2;
    if (r <= 0.75) return 3;
    return 4;
  };

  const cells: { day: string; total_tokens: number; billable_total_tokens: number; level: number; models: Record<string, number> | null }[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.toISOString().slice(0, 10);
    const data = byDay.get(day);
    const billable = data?.billable_total_tokens || 0;
    cells.push({
      day,
      total_tokens: data?.total_tokens || 0,
      billable_total_tokens: billable,
      level: calcLevel(billable),
      models: data?.models || null,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Both wire formats are derived from `cells` below this line, so the scalars
  // cannot drift apart: same grid, same clamp, same coercions.
  const activeDays = cells.filter((c) => c.billable_total_tokens > 0).length;

  if (wantsCompact) {
    // Two things are paid for repeatedly in the dense payload, and neither is
    // data. The grid: 52 weeks is 364 five-key objects whose
    // billable_total_tokens merely repeats total_tokens and whose level is a
    // function of max_value. And the model names: a year of daily rows names the
    // same ~160 models ~1900 times, which measured as 57% of the remaining
    // bytes. So the rows go out sparse, the names go out once, and the client
    // rebuilds an identical grid. On 2026-09-21 this endpoint was ~42 KB per
    // read, 60k reads a day, 31% of the project's entire egress.
    //
    // A day appears only when the RPC returned a row for it — `models` is
    // non-null exactly then (it is {} when that row folded no model), which is
    // what lets the client tell "no activity" from "activity, no model".
    const modelNames: string[] = [];
    const modelIndex = new Map<string, number>();
    const days = cells
      .filter((c) => c.models !== null)
      .map((c) => {
        const pairs: number[] = [];
        for (const name of Object.keys(c.models!)) {
          let idx = modelIndex.get(name);
          if (idx === undefined) {
            idx = modelNames.length;
            modelNames.push(name);
            modelIndex.set(name, idx);
          }
          pairs.push(idx, c.models![name]);
        }
        return [c.day, c.total_tokens, pairs];
      });
    return json({
      format: "compact",
      from,
      to,
      week_starts_on: weekStartsOn,
      active_days: activeDays,
      streak_days: 0,
      max_value: maxValue,
      model_names: modelNames,
      days,
    });
  }

  const weeksArr: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeksArr.push(cells.slice(i, i + 7));
  }

  return json({
    from,
    to,
    week_starts_on: weekStartsOn,
    active_days: activeDays,
    streak_days: 0,
    weeks: weeksArr,
  });
}
