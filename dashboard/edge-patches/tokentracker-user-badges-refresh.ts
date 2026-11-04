/**
 * InsForge Edge: cloud achievement / badge recompute trigger.
 *
 * Why this exists (issues #925 / #987):
 *   Badge metrics are computed by pure-SQL `public.user_badges_refresh_v2()`
 *   (see scripts/ops/user-badges.sql). Historically that ran on pg_cron
 *   (`tokentracker-user-badges-refresh`, six-hourly at minute 32 (cron minute 32, every 6 hours)). Around
 * 2026-10-17T00:32Z that job stopped advancing while InsForge HTTP
 *   leaderboard schedules kept working — every public profile's badges
 *   share that single frozen `updated_at`.
 *
 *   InsForge's `schedules` API only invokes HTTP URLs (not raw SQL), and
 *   unrestricted SQL / cron.job access is unavailable on this project.
 *   This edge is therefore the durable production write path: a privileged
 *   POST calls `user_badges_refresh_v2()` via the service role, then an InsForge
 *   schedule hits it on the same 6-hour cadence.
 *
 *   Use the ordinary project-admin SQL endpoint, NOT /api/database/rpc:
 *   the latter has a backend Axios proxy capped at 10s regardless of the SDK
 *   or fetch timeout. This endpoint executes one fixed SELECT as project_admin
 *   with a 30s server limit; it does not need unrestricted/root SQL access.
 *   Apply the maintained-rollup migration first (docs/user-badges-refresh.md).
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
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
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
  const started = Date.now();
  logBadgeRefresh({ event: "start" });
  // One attempt only: after a transport error the commit outcome is unknown.
  // The SQL function owns the shared claim and the entire atomic recompute.
  const signal = AbortSignal.timeout(110_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/database/advance/rawsql`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "SELECT public.user_badges_refresh_v2() AS result" }),
      signal,
    });
    if (!response.ok) {
      // Backend error bodies can contain SQL or credentials. Log status only.
      await response.body?.cancel();
      logBadgeRefresh({ event: "error", status: response.status, ms: Date.now() - started });
      return json({ ok: false, error: "user_badges_refresh failed" }, 500);
    }
    const payload = await response.json();
    const value = payload?.rows?.[0]?.result;
    // PostgreSQL bigint arrives as a decimal string on the admin SQL endpoint.
    // Missing/malformed rows must not turn into a false successful refresh.
    const result = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (payload?.rows?.length !== 1 || !Number.isSafeInteger(result) || result < 0) {
      throw new Error("Invalid refresh result");
    }
    const ms = Date.now() - started;
    logBadgeRefresh({ event: "ok", ms, result });
    return json({ ok: true, ms, result });
  } catch {
    logBadgeRefresh({
      event: "error",
      reason: signal.aborted ? "timeout" : "request_failed",
      ms: Date.now() - started,
    });
    return json({
      ok: false,
      error: signal.aborted ? "user_badges_refresh timed out" : "user_badges_refresh failed",
    }, signal.aborted ? 504 : 500);
  }
}
