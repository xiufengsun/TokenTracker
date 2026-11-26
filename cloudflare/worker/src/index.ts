import { scheduledReports } from "./report-jobs";
import { dispatchAuth } from "./auth-router";
import { dispatchDevice } from "./devices";
import { dispatchBilling } from "./billing";
import { dispatchReports } from "./reports";
import { dispatchUsageMirror, mirrorUsage } from "./usage-mirror";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const api: ExportedHandler<Env> = {
  async scheduled(event, env) {
    if (event.cron === "* * * * *") {
      if (!env.USAGE_MIRROR_SOURCE_URL) return;
      // A client flush handles one batch for responsiveness; the cron can drain
      // more of the backlog while keeping the invocation bounded.
      for (let batch = 0; batch < 20; batch++) {
        if (!(await mirrorUsage(env, null))) break;
      }
      return;
    }
    await scheduledReports(event.cron, env);
  },
  async fetch(request, env): Promise<Response> {
    try {
      const routed =
        (await dispatchUsageMirror(request, env)) ??
        (await dispatchAuth(request, env)) ??
        (await dispatchDevice(request, env)) ??
        (await dispatchBilling(request, env)) ??
        (await dispatchReports(request, env));
      if (routed) return routed;
    } catch {
      return Response.json(
        { error: "internal error" },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
    const path = new URL(request.url).pathname;
    if (
      path !== "/functions/tokentracker-community-models" &&
      path !== "/tokentracker-community-models"
    ) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: cors },
      );
    }
    try {
      const payload = await env.DB.prepare(
        "SELECT payload FROM community_snapshot WHERE id = 'total'",
      ).first<string>("payload");
      if (payload === null) {
        return Response.json(
          { error: "community stats snapshot is not ready" },
          {
            status: 503,
            headers: {
              ...cors,
              "Cache-Control": "no-store",
              "Retry-After": "30",
            },
          },
        );
      }
      return new Response(payload, {
        headers: {
          ...cors,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
          "X-Community-Stats-Source": "snapshot",
        },
      });
    } catch {
      return Response.json(
        { error: "internal error" },
        { status: 500, headers: cors },
      );
    }
  },
};

export default api;
