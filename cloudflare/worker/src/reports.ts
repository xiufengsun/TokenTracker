import { getAccountId } from "./auth";
import { readMembership } from "./billing-membership";
import { accountReport, reportJson } from "./report-account";
import { leaderboard, publicBlocklist } from "./report-public";
import { profileReport } from "./report-profile";
import { skillsReport } from "./report-skills";
import badgeSvg from "./report-badge";
import embedSvg from "./report-embed";

import { reportJob } from "./report-jobs";
import { telemetry } from "./report-telemetry";
import { likes, visibility } from "./report-social";

const accountKinds = new Set([
  "summary",
  "daily",
  "hourly",
  "monthly",
  "heatmap",
  "devices",
  "model-breakdown",
  "skills",
]);
const publicKinds = new Set([
  "leaderboard",
  "leaderboard-profile",
  "badge-svg",
  "embed-svg",
  "profile-likes",
]);
type ReportEnv = Pick<Env, "DB"> & {
  LEADERBOARD_BLOCKED_USER_IDS?: string;
  LEADERBOARD_REFRESH_SECRET?: string;
  TOKENTRACKER_BILLING_ENVIRONMENT?: string;
};

export async function dispatchReports(
  req: Request,
  env: ReportEnv,
): Promise<Response | null> {
  const match = /^\/(?:functions\/)?tokentracker-(.+)$/.exec(
    new URL(req.url).pathname,
  );
  if (!match) return null;
  const name = match[1];
  const kind = name.startsWith("account-") ? name.slice(8) : "";
  if (
    !accountKinds.has(kind) &&
    !publicKinds.has(name) &&
    ![
      "telemetry",
      "public-visibility",
      "user-badges-refresh",
      "leaderboard-refresh",
    ].includes(name)
  )
    return null;
  if (req.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          name === "telemetry"
            ? "POST, OPTIONS"
            : kind === "skills" ||
                name === "public-visibility" ||
                name === "profile-likes"
              ? "GET, POST, OPTIONS"
              : "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      },
    });
  try {
    if (name === "leaderboard-refresh" || name === "user-badges-refresh")
      return await reportJob(req, env, name);
    if (name === "telemetry") return await telemetry(req, env.DB);
    if (name === "public-visibility") {
      const user = await getAccountId(req, env);
      return user
        ? await visibility(req, env.DB, user)
        : reportJson({ error: "Unauthorized" }, 401);
    }
    if (publicKinds.has(name)) {
      const blocked = publicBlocklist(env);
      if (!blocked)
        return reportJson(
          { error: "Leaderboard configuration unavailable" },
          503,
        );
      if (name === "profile-likes")
        return await likes(req, env.DB, await getAccountId(req, env), blocked);
      if (name === "badge-svg") return await badgeSvg(req, env.DB, blocked);
      if (name === "embed-svg") return await embedSvg(req, env.DB, blocked);
      if (name === "leaderboard")
        return await leaderboard(req, env.DB, blocked);
      if (req.method !== "GET")
        return reportJson({ error: "Method not allowed" }, 405);
      return await profileReport(
        req,
        env.DB,
        await getAccountId(req, env),
        blocked,
      );
    }
    if (req.method !== "GET" && !(kind === "skills" && req.method === "POST"))
      return reportJson({ error: "Method not allowed" }, 405);
    const user = await getAccountId(req, env);
    if (!user) return reportJson({ error: "Unauthorized" }, 401);
    if (kind === "skills") return await skillsReport(req, env.DB, user);
    const environment = env.TOKENTRACKER_BILLING_ENVIRONMENT || "live";
    if (environment !== "live" && environment !== "sandbox")
      throw new Error("Unrecognized billing environment");
    let membership;
    try {
      membership = await readMembership(env.DB, user, environment);
    } catch {
      return reportJson(
        { error: "Cloud access unavailable", code: "cloud_access_unavailable" },
        503,
      );
    }
    return await accountReport(req, env.DB, user, kind, membership);
  } catch {
    return reportJson({ error: "Report unavailable" }, 500);
  }
}
