import { authError, jsonInput, sessionRoute } from "./auth";
import { emailRoute } from "./auth-email";
import { type LegacyEnv, oauthRoute } from "./auth-oauth";

export async function dispatchAuth(
  req: Request,
  env: LegacyEnv,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/api/auth/")) return null;
  if (env.AUTH_ENFORCE_CANONICAL_ORIGIN === "1" && url.origin !== env.AUTH_ORIGIN)
    return authError("Authentication requires the canonical TokenTracker origin", 421);
  const origin = req.headers.get("Origin");
  const allowed = origin === env.AUTH_WEB_ORIGIN || origin === env.AUTH_ORIGIN;
  if (origin && !allowed) return authError("Origin not allowed", 403);
  const cors = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
  if (origin && allowed) {
    cors.set("Access-Control-Allow-Origin", origin);
    cors.set("Access-Control-Allow-Credentials", "true");
    cors.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    cors.set(
      "Access-Control-Allow-Headers",
      "Authorization,Content-Type,apikey,X-API-Key,X-CSRF-Token",
    );
  }
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  if (path === "/api/auth/public-config") {
    return Response.json(
      {
        requireEmailVerification: false,
        passwordMinLength: 6,
        oAuthProviders: [
          ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
            ? ["github"]
            : []),
          ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
            ? ["google"]
            : []),
        ],
        customOAuthProviders: [],
      },
      { headers: cors },
    );
  }
  if (!env.AUTH_SECRET || !env.AUTH_ORIGIN || !env.AUTH_MIGRATION_KEY)
    return authError("Authentication not configured", 503);
  if (req.method === "POST" || path.startsWith("/api/auth/oauth/")) {
    const ip = req.headers.get("CF-Connecting-IP");
    if (!env.AUTH_LIMIT)
      return authError("Authentication admission not configured", 503);
    if (!(await env.AUTH_LIMIT.limit({ key: ip ?? "local" })).success)
      return authError("Too many attempts", 429);
  }
  const body = req.method === "POST" ? await jsonInput(req) : {};
  if (!body) return authError("Invalid request", 400);
  const result =
    (await sessionRoute(req, env, path, body)) ??
    (path.startsWith("/api/auth/oauth/")
      ? await oauthRoute(req, env, body)
      : null) ??
    (await emailRoute(req, env, path, body)) ??
    authError("Unknown auth route", 404);
  cors.forEach((v, k) => result.headers.set(k, v));
  return result;
}
