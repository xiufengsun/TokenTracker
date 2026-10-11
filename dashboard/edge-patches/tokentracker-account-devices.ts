/**
 * InsForge Edge: list the signed-in user's active devices with per-device
 * usage totals for [from, to]. Powers the dashboard device filter dropdown
 * and the per-device usage card. Reuses account_usage_grouped (no DB change):
 * one RPC per device with p_device_ids=[id] gives that device's isolated sum.
 *
 * Auth: HS256 JWT_SECRET signature verification (same template as
 * tokentracker-account-summary). InsForge does NOT validate JWTs at the
 * gateway, so we verify the signature ourselves before returning per-user data.
 */
import { createClient } from "npm:@insforge/sdk";
import { cloudReadAccess, cloudFailure, cloudHistoryFailure } from "./cloud/access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const raw = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

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

interface DeviceRow {
  id: string;
  device_name: string | null;
  platform: string | null;
  created_at: string | null;
}

interface GroupedRow {
  bucket: string | null;
  source: string | null;
  total_tokens: number | null;
}

// Keep in sync with ACCOUNT_LEVEL_SOURCES in src/lib/source-metadata.js (parity
// asserted by test/account-source-parity.test.js). Account-level sources come
// from a per-ACCOUNT cloud API with no device attribution — the RPC's account
// branch intentionally ignores p_device_ids, so a per-device query would add
// the user's ENTIRE account-level total to EVERY device (the "N identical
// devices" skew). A device breakdown must therefore exclude them.
const ACCOUNT_LEVEL_SOURCES = new Set<string>(["cursor", "trae-cn"]);

async function sumDeviceTokens(
  client: ReturnType<typeof createClient>,
  userId: string,
  deviceId: string,
  fromIso: string,
  toIso: string,
  fromDay: string,
  toDay: string,
  tz: string | null,
  tzOffsetMinutes: number | null,
): Promise<number> {
  // The cached variant serves repeat device-card loads from the shared 30s
  // Postgres cache instead of re-running the full scan per device.
  const { data, error } = await client.database.rpc("account_usage_grouped_cached", {
    p_user_id: userId,
    p_device_id: deviceId,
    p_from: fromIso,
    p_to: toIso,
    p_trunc: "day",
    p_tz: tz,
    p_offset_min: tzOffsetMinutes,
  });
  if (error) {
    console.error(`account-devices: usage sum failed for device ${deviceId}: ${error.message}`);
    return 0;
  }
  const rows = (Array.isArray(data) ? data : []) as GroupedRow[];
  let sum = 0;
  for (const r of rows) {
    // The UTC query window is widened ±1 day for TZ shifts; the RPC buckets to
    // tz-local days, so trim back to the requested [from, to] here (mirrors
    // account-summary's `daily.filter(d.day >= from && d.day <= to)`).
    const day = String(r.bucket || "");
    if (day < fromDay || day > toDay) continue;
    if (ACCOUNT_LEVEL_SOURCES.has(String(r.source || ""))) continue;
    sum += Number(r.total_tokens) || 0;
  }
  return sum;
}

// Account-level sources excluded from the per-device sums above still belong in
// the breakdown (otherwise the card total is short of the dashboard total by
// exactly their share). An empty p_device_ids returns ONLY the RPC's account
// branch (the machine branch matches no device), giving each source's deduped
// account-wide total in one call.
async function sumAccountSources(
  client: ReturnType<typeof createClient>,
  userId: string,
  fromIso: string,
  toIso: string,
  fromDay: string,
  toDay: string,
  tz: string | null,
  tzOffsetMinutes: number | null,
): Promise<Array<{ source: string; total_tokens: number }>> {
  const { data, error } = await client.database.rpc("account_usage_grouped", {
    p_user_id: userId,
    p_device_ids: [],
    p_from: fromIso,
    p_to: toIso,
    p_trunc: "day",
    p_tz: tz,
    p_offset_min: tzOffsetMinutes,
  });
  if (error) {
    console.error(`account-devices: account-source sum failed: ${error.message}`);
    return [];
  }
  const rows = (Array.isArray(data) ? data : []) as GroupedRow[];
  const bySource = new Map<string, number>();
  for (const r of rows) {
    const day = String(r.bucket || "");
    if (day < fromDay || day > toDay) continue;
    const source = String(r.source || "");
    if (!ACCOUNT_LEVEL_SOURCES.has(source)) continue;
    bySource.set(source, (bySource.get(source) || 0) + (Number(r.total_tokens) || 0));
  }
  return [...bySource.entries()]
    .map(([source, total_tokens]) => ({ source, total_tokens }))
    .filter((s) => s.total_tokens > 0)
    .sort((a, b) => b.total_tokens - a.total_tokens);
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  let from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  if (!from || !to) return json({ error: "Missing from/to" }, 400);
  // Same span bound as the other account-* endpoints: every distinct range is
  // a cold fill for the shared PG cache, so arbitrary from/to is not accepted
  // verbatim (3 years covers every real view).
  const MAX_RANGE_DAYS = 1095;
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
    const maxFromMs = toMs - MAX_RANGE_DAYS * 86_400_000;
    if (fromMs < maxFromMs) from = new Date(maxFromMs).toISOString().slice(0, 10);
  }
  const tz = url.searchParams.get("tz") || null;
  const tzOffsetRaw = url.searchParams.get("tz_offset_minutes");
  const tzOffsetMinutes = tzOffsetRaw != null && tzOffsetRaw !== "" ? Number(tzOffsetRaw) : null;

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
  if (!baseUrl) return json({ error: "server misconfigured" }, 500);
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

  let cloudAccess;
  try { cloudAccess = await cloudReadAccess(client, userId, "daily"); }
  catch { return json({ error: "Cloud access unavailable", code: "cloud_access_unavailable" }, 503); }
  if (!cloudAccess.ok) return cloudFailure(cloudAccess, corsHeaders);
  const historyFailure = cloudHistoryFailure(cloudAccess, to);
  if (historyFailure) return cloudFailure(historyFailure, corsHeaders);
  if (cloudAccess.available_from && from < cloudAccess.available_from) from = cloudAccess.available_from;

  let devices: DeviceRow[];
  try {
    const { data, error } = await client.database
      .from("tokentracker_devices")
      .select("id, device_name, platform, created_at")
      .eq("user_id", userId)
      .is("revoked_at", null);
    if (error) throw new Error(error.message);
    devices = (data ?? []) as DeviceRow[];
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  // Widen the UTC window ±1 day so TZ-shifted edge hours are captured (mirrors
  // account-summary); sumDeviceTokens trims the tz-local day buckets back to
  // [from, to]. The RPC handles per-device isolation + source-class dedup for
  // machine-level sources; account-level sources are excluded there entirely.
  const startDate = new Date(`${from}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const endDate = new Date(`${to}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 2);
  const rangeStart = startDate.toISOString();
  const rangeEnd = endDate.toISOString();

  // Per-device RPC errors are already degraded to 0 inside sumDeviceTokens;
  // this catch is a last-resort guard for unexpected (synchronous) failures.
  let withTotals: Array<DeviceRow & { total_tokens: number }>;
  let accountSources: Array<{ source: string; total_tokens: number }>;
  try {
    [withTotals, accountSources] = await Promise.all([
      Promise.all(
        devices.map(async (d) => ({
          ...d,
          total_tokens: await sumDeviceTokens(client, userId, d.id, rangeStart, rangeEnd, from, to, tz, tzOffsetMinutes),
        })),
      ),
      sumAccountSources(client, userId, rangeStart, rangeEnd, from, to, tz, tzOffsetMinutes),
    ]);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  withTotals.sort((a, b) => b.total_tokens - a.total_tokens);
  return json({ from, to, devices: withTotals, account_sources: accountSources });
}
