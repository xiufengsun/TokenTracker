/**
 * InsForge Edge: OAuth-style device flow — poll step.
 *
 * Called by the CLI at the cadence indicated by the authorize response
 * (default 5s). Returns:
 *   - 200 { status: "pending" }            – still waiting on the user
 *   - 200 { status: "approved", user_id, device_token, device_id }
 *                                         – user granted the code
 *   - 410 { status: "expired" }            – the 15-minute window lapsed
 *   - 404 { status: "unknown" }            – device_code is bogus
 *
 * Public endpoint — the device_code itself is the bearer credential.
 */
import { createClient } from "npm:@insforge/sdk";
import { cloudRpc, cloudFailure } from "./cloud/access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function issueDeviceToken(client: ReturnType<typeof createClient>, userId: string,
  clientInfo: string | null, machineId: string | null, deviceCode: string) {
  const hostname = clientInfo?.match(/^\S+\s+(.+)$/)?.[1]?.trim();
  const bare = `TokenTracker CLI${clientInfo ? ` (${clientInfo})` : ""}`.slice(0, 128);
  const legacy = `${bare}${machineId ? ` #${machineId.slice(0, 8)}` : ""}`.slice(0, 128);
  const deviceName = (hostname || legacy).slice(0, 128);
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const result = await cloudRpc(client, "cloud_issue_device_token", {
    p_user_id: userId, p_device_name: deviceName, p_platform: "cli-device-flow", p_machine_id: machineId,
    p_legacy_names: Array.from(new Set([deviceName, legacy, bare])),
    p_token_id: crypto.randomUUID(), p_token_hash: await sha256Hex(token), p_rotate: true,
    p_device_code: deviceCode,
  });
  return { token, result };
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { device_code?: string } = {};
  try { body = await req.json(); } catch (_e) { /* */ }
  const deviceCode = typeof body.device_code === "string" ? body.device_code.trim() : "";
  if (!/^[0-9a-f]{64}$/.test(deviceCode)) return json({ status: "unknown" }, 404);

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY");
  if (!baseUrl) return json({ error: "misconfigured" }, 500);
  if (!serviceRoleKey) return json({ error: "misconfigured" }, 500);

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  const { data, error } = await client.database
    .from("tokentracker_device_codes")
    .select("device_code, user_id, status, expires_at, approved_at, client_info, machine_id")
    .eq("device_code", deviceCode)
    .maybeSingle();

  if (error) {
    // Log internals server-side only — this is a public endpoint and error
    // messages can leak schema/infrastructure details.
    console.error("[device-flow-poll] db error:", String(error?.message ?? error));
    return json({ error: "db error" }, 502);
  }
  if (!data) return json({ status: "unknown" }, 404);

  const row = data as { user_id: string | null; status: string; expires_at: string; client_info: string | null; machine_id: string | null };
  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() > expiresAt) {
    // Best-effort cleanup. Scope the UPDATE to status='pending' so two
    // concurrent CLI polls racing past the same expiry don't both write —
    // PostgREST has no transactional read-modify-write here, but the
    // predicate makes the second update a no-op.
    await client.database
      .from("tokentracker_device_codes")
      .update({ status: "expired" })
      .eq("device_code", deviceCode)
      .eq("status", "pending");
    return json({ status: "expired" }, 410);
  }

  if (row.status === "approved" && row.user_id) {
    // Do not let an already-approved device code bypass an account ban by
    // polling after its existing devices and tokens were revoked. Heuristic
    // anomaly flags are not a ban; see tokentracker-ingest for why.
    if (isLeaderboardBlockedUser(row.user_id)) {
      return json({ error: "Account blocked" }, 403);
    }
    try {
      const issued = await issueDeviceToken(client, row.user_id, row.client_info, row.machine_id, deviceCode);
      if (!issued.result.ok) return cloudFailure(issued.result, corsHeaders);
      return json({
        status: "approved",
        user_id: row.user_id,
        device_token: issued.token,
        device_id: issued.result.device_id,
        machine_id: issued.result.machine_id, membership: issued.result.membership,
      });
    } catch (e) {
      console.error("[device-flow-poll] issue failed:", String((e as Error)?.message ?? e));
      return json({ error: "Failed to issue device token" }, 500);
    }
  }
  return json({ status: "pending" });
}
