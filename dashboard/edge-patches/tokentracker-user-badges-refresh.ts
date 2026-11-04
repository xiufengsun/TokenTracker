/**
 * InsForge Edge: cloud achievement / badge recompute trigger.
 *
 * Why this exists (issues #925 / #987):
 *   Badge metrics are computed by pure-SQL `public.user_badges_refresh()`
 *   (see scripts/ops/user-badges.sql). Historically that ran on pg_cron
 *   (`tokentracker-user-badges-refresh`, six-hourly at minute 32 (cron minute 32, every 6 hours)). Around
 * 2026-10-17T00:32Z that job stopped advancing while InsForge HTTP
 *   leaderboard schedules kept working — every public profile's badges
 *   share that single frozen `updated_at`.
 *
 *   InsForge's `schedules` API only invokes HTTP URLs (not raw SQL), and
 *   unrestricted SQL / cron.job access is unavailable on this project.
 *   This edge is therefore the durable production write path: a privileged
 *   POST calls `user_badges_refresh()` via the service role, then an InsForge
 *   schedule hits it on the same 6-hour cadence.
 *
 * Auth (write path only):
 *   - `x-refresh-secret: $LEADERBOARD_REFRESH_SECRET` (cron / ops), or
 *   - `Authorization: Bearer $INSFORGE_SERVICE_ROLE_KEY`
 *   Anon / signed-in users cannot trigger a full recompute.
 *
 * Rollback:
 *   insforge schedules delete <id>
 *   insforge functions delete tokentracker-user-badges-refresh
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-refresh-secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function authorizePrivileged(req: Request): boolean {
  const secret = Deno.env.get("LEADERBOARD_REFRESH_SECRET");
  const provided = req.headers.get("x-refresh-secret");
  if (secret && provided && timingSafeEqualStr(provided, secret)) return true;

  const auth = req.headers.get("Authorization");
  const bearer = auth ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  const serviceKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (bearer && serviceKey && timingSafeEqualStr(bearer, serviceKey)) return true;
  return false;
}

function logBadgeRefresh(event: Record<string, unknown>) {
  console.log(JSON.stringify({ scope: "user-badges-refresh", ...event }));
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!authorizePrivileged(req)) return json({ error: "Unauthorized" }, 401);

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!baseUrl || !serviceRoleKey) {
    return json({ error: "server misconfigured" }, 500);
  }
  const incomingApiKey =
    req.headers.get("apikey") ??
    req.headers.get("Apikey") ??
    req.headers.get("x-api-key") ??
    undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ??
    Deno.env.get("ANON_KEY") ??
    incomingApiKey ??
    undefined;

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  const started = Date.now();
  logBadgeRefresh({ event: "start" });
  const { data, error } = await client.database.rpc("user_badges_refresh");
  if (error) {
    logBadgeRefresh({
      event: "error",
      message: error.message || "rpc failed",
      ms: Date.now() - started,
    });
    return json({ ok: false, error: error.message || "user_badges_refresh failed" }, 500);
  }

  logBadgeRefresh({ event: "ok", ms: Date.now() - started, result: data ?? null });
  return json({
    ok: true,
    ms: Date.now() - started,
    result: data ?? null,
  });
}
