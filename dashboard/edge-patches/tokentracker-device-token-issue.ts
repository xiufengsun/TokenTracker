/**
 * InsForge Edge：为当前登录用户签发 device token（写入 tokentracker_devices / tokentracker_device_tokens）。
 * 与文档中 historical 名称 tokentracker-device-token-issue 不同：本项目云端 slug 为 tokentracker-device-token-issue。
 */
import { createClient } from "npm:@insforge/sdk";
import { cloudRpc, cloudFailure } from "./cloud/access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-tokentracker-device-token-hash",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isLeaderboardBlockedUser(userId: string): boolean {
  return (Deno.env.get("LEADERBOARD_BLOCKED_USER_IDS") ?? "")
    .split(",")
    .some((candidate) => candidate.trim() === userId);
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
 * Verify a HS256 JWT signature locally with JWT_SECRET and return its `sub`.
 *
 * Previously this function only decoded the payload without verifying the
 * signature, which let any caller forge `{"sub":"<victim>"}` and obtain a
 * service-role-signed device token bound to that victim's account. The
 * companion endpoint `tokentracker-leaderboard-profile.ts` already verifies
 * signatures here for the same reason — InsForge does NOT validate JWTs at
 * the gateway, so edge functions must do it themselves.
 *
 * Returns null on any failure (bad shape, bad signature, expired); the
 * caller surfaces that as 401.
 */
async function verifiedUserIdFromJwt(token: string): Promise<string | null> {
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
    const payloadStr = new TextDecoder().decode(b64urlToBytes(parts[1]));
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    const sub = payload.sub;
    if (typeof sub === "string" && sub.length > 0) return sub;
    const uid = payload.user_id;
    if (typeof uid === "string" && uid.length > 0) return uid;
  } catch {
    /* ignore */
  }
  return null;
}

function resolveUserIdForUserMode(bearer: string): Promise<string | null> {
  return verifiedUserIdFromJwt(bearer);
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;

  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!bearer) return json({ error: "Missing bearer token" }, 401);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) return json({ error: "server misconfigured" }, 500);
  const adminMode = Boolean(serviceRoleKey && bearer === serviceRoleKey);

  let userId: string | null = null;
  let dbClient: ReturnType<typeof createClient>;

  if (adminMode) {
    const fromBody = typeof body.user_id === "string" ? body.user_id : null;
    const dataObj = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : null;
    const fromData = dataObj && typeof dataObj.user_id === "string" ? dataObj.user_id : null;
    userId = fromBody || fromData;
    if (!userId) return json({ error: "user_id is required (admin mode)" }, 400);
    dbClient = createClient({
      baseUrl,
      edgeFunctionToken: serviceRoleKey!,
      anonKey,
      ...(anonKey ? { headers: { apikey: anonKey } } : {}),
    });
  } else {
    userId = await resolveUserIdForUserMode(bearer);
    if (!userId) return json({ error: "Unauthorized" }, 401);
    // 用 service role key 操作 DB：用户身份已通过 JWT 签名验证（HS256 + JWT_SECRET），
    // 不再依赖用户的短期 access token（15 min 过期）做 DB 写入。
    dbClient = createClient({
      baseUrl,
      edgeFunctionToken: serviceRoleKey,
      anonKey,
      ...(anonKey ? { headers: { apikey: anonKey } } : {}),
    });
  }

  // A leaderboard ban must stop new uploads, not merely hide the account from
  // the public snapshot. Check before touching devices or minting credentials.
  // Only an explicit ban stops the write path. An `auto_excluded` anomaly flag
  // deliberately does not: the detector is heuristic, and
  // tokentracker-leaderboard-refresh already excludes flagged accounts from the
  // public snapshot on its own. Blocking ingest as well meant a false positive
  // could not upload the corrected numbers that would clear it -- the account
  // was stuck until someone opened an issue (#639).
  if (isLeaderboardBlockedUser(userId)) {
    return json({ error: "Account blocked" }, 403);
  }

  const dataObj2 = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : undefined;
  const deviceName = String(body.device_name ?? dataObj2?.device_name ?? "Token Tracker")
    .slice(0, 128);
  const platform = String(body.platform ?? dataObj2?.platform ?? "web").slice(
    0,
    32,
  );
  const machineIdRaw = body.machine_id ?? dataObj2?.machine_id;
  const machineId =
    typeof machineIdRaw === "string" && machineIdRaw.trim().length >= 8
      ? machineIdRaw.trim().slice(0, 64)
      : null;

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  try {
    const issued = await cloudRpc(dbClient, "cloud_issue_device_token", {
      p_user_id: userId, p_device_name: deviceName, p_platform: platform, p_machine_id: machineId,
      p_legacy_names: Array.from(new Set([deviceName,
        ...(machineId ? [`Token Tracker (dashboard) #${machineId.slice(0, 8)}`] : []),
        "Token Tracker (dashboard)", "Token Tracker"])),
      p_token_id: crypto.randomUUID(), p_token_hash: await sha256Hex(token), p_rotate: false,
    });
    if (!issued.ok) return cloudFailure(issued, corsHeaders);
    return json({ token, device_id: issued.device_id, created_at: issued.created_at,
      machine_id: issued.machine_id, membership: issued.membership });
  } catch (error) {
    console.error("device issuance failed", (error as Error).message);
    return json({ error: "Cloud access unavailable", code: "cloud_access_unavailable" }, 503);
  }
}
