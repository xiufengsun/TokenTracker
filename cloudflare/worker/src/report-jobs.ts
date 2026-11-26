import { getAccountId } from "./auth";
import { reportJson } from "./report-account";
import { refreshAchievements } from "./report-achievements";
import { refreshCommunity } from "./report-community";
import {
  pruneSnapshots,
  detectAnomalies,
  queueSummary,
  quarantineAudit,
  reconcileQueue,
} from "./report-moderation";
import { publicBlocklist } from "./report-public";
import { prepareReportDays, refreshRanking } from "./report-refresh";
import type { RankPeriod } from "./report-refresh";
import type { PublicEnv } from "./report-public";
type JobEnv = PublicEnv & { LEADERBOARD_REFRESH_SECRET?: string };
const kinds = ["week", "month", "total"] as const;

export async function scheduledReports(cron: string, env: JobEnv) {
  switch (cron) {
    case "17,47 * * * *":
      return await refreshRanking(env, "month");
    case "23 */6 * * *":
      return await refreshRanking(env, "total");
    case "32 */6 * * *":
      return await refreshAchievements(env.DB);
    case "17 * * * *":
      return await refreshCommunity(env.DB);
    case "41 * * * *":
      return await detectAnomalies(env.DB);
    case "*/10 * * * *":
      return { caught_up: await prepareReportDays(env.DB) };
    case "12 4 * * *":
      return { pruned: (await pruneSnapshots(env.DB)).meta.changes };
    default:
      throw new Error("Unknown report schedule");
  }
}

async function privileged(req: Request, env: JobEnv) {
  const supplied = req.headers.get("x-refresh-secret"),
    expected = env.LEADERBOARD_REFRESH_SECRET;
  if (!supplied || !expected) return false;
  const hash = (s: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [a, b] = await Promise.all([hash(supplied), hash(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function reportJob(req: Request, env: JobEnv, name: string) {
  const params = new URL(req.url).searchParams;
  if (req.method === "GET" && name === "leaderboard-refresh") {
    if (params.get("quarantine_audit") === "1")
      return reportJson(
        await quarantineAudit(env.DB, publicBlocklist(env)),
      );
    if (params.get("anomalies") === "1")
      return reportJson(await queueSummary(env.DB));
  }
  if (req.method !== "POST")
    return reportJson({ error: "Method not allowed" }, 405);
  const admin = await privileged(req, env);
  if (name === "user-badges-refresh") {
    if (!admin) return reportJson({ error: "Unauthorized" }, 401);
    const start = Date.now();
    const result = await refreshAchievements(env.DB);
    return reportJson({ ok: true, ms: Date.now() - start, result });
  }
  if (!admin && !(await getAccountId(req, env)))
    return reportJson({ error: "unauthorized" }, 401);
  const b = await req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);
  if (!b || typeof b !== "object")
    return reportJson({ error: "Invalid JSON body" }, 400);
  if (
    !admin &&
    (b.scan_anomalies === true ||
      b.force_refresh === true ||
      b.anti_cheat_reconcile_at !== undefined)
  ) {
    return reportJson(
      { error: "privileged anti-cheat operation required" },
      403,
    );
  }
  if (!admin && b.period !== "week")
    return reportJson({ error: "signed-in users may only refresh week" }, 403);
  if (b.anti_cheat_reconcile_at !== undefined) {
    if (
      typeof b.anti_cheat_reconcile_at !== "string" ||
      !Number.isFinite(Date.parse(b.anti_cheat_reconcile_at))
    ) {
      return reportJson({ error: "invalid anti-cheat queue timestamp" }, 400);
    }
    const reconciled = await reconcileQueue(env.DB, b.anti_cheat_reconcile_at);
    return reconciled
      ? reportJson(reconciled)
      : reportJson(
          { error: "anti-cheat queue changed during snapshot reconciliation" },
          409,
        );
  }
  const scan = b.scan_anomalies === true ? await detectAnomalies(env.DB) : null;
  const periods = kinds.includes(b.period as RankPeriod)
    ? [b.period as RankPeriod]
    : kinds;
  const results: Record<string, unknown> = {};
  for (const period of periods)
    results[period] = await refreshRanking(
      env,
      period,
      b.force_refresh === true,
    );
  return reportJson({ ok: true, results, ...(scan ? { scan } : {}) });
}
