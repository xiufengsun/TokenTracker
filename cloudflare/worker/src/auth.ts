import {
  SignJWT,
  base64url,
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import { compare } from "bcryptjs";

export interface AuthEnv {
  DB: D1Database;
  AUTH_SECRET?: string;
  AUTH_ORIGIN?: string;
  AUTH_ENFORCE_CANONICAL_ORIGIN?: string;
  AUTH_WEB_ORIGIN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  AUTH_EMAIL_FROM?: string;
  /** Temporary bridge for sessions issued by the retired InsForge backend. */
  LEGACY_AUTH_ENABLED?: string;
  LEGACY_AUTH_MODE?: string;
  LEGACY_AUTH_JWKS_URL?: string;
  LEGACY_AUTH_ORIGIN?: string;
  LEGACY_AUTH_ANON_KEY?: string;
  /** Optional only for a legacy HS256 access-token deployment. */
  LEGACY_AUTH_REFRESH_SECRET?: string;
  LEGACY_AUTH_EXPIRES_AT?: string;
  EMAIL?: {
    send(message: {
      from: string;
      to: string;
      text: string;
      subject: string;
    }): Promise<unknown>;
  };
  AUTH_LIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}

export type Account = {
  id: string;
  email: string;
  email_verified: number;
  profile: string;
  created_at: string;
};
export const seconds = () => Math.floor(Date.now() / 1000);
export const nonce = () =>
  base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async (s: string) =>
  base64url.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  );
export const authError = (error: string, status: number) =>
  Response.json(
    { error, message: error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
export const findUser = (env: AuthEnv, id: string) =>
  env.DB.prepare(
    "SELECT id,email,email_verified,profile,created_at FROM tt_auth_accounts WHERE id=?",
  )
    .bind(id)
    .first<Account>();

let legacyJwksUrl = "";
let legacyJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function legacyAuthEnabled(env: AuthEnv) {
  if (env.LEGACY_AUTH_ENABLED !== "1") return false;
  const expiresAt = Number(env.LEGACY_AUTH_EXPIRES_AT || 0);
  return Number.isFinite(expiresAt) && expiresAt > seconds();
}

function legacyJwksFor(env: AuthEnv) {
  const url = env.LEGACY_AUTH_JWKS_URL?.trim();
  if (!url) return null;
  if (url !== legacyJwksUrl) {
    legacyJwksUrl = url;
    legacyJwks = createRemoteJWKSet(new URL(url), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
      cacheMaxAge: 600000,
    });
  }
  return legacyJwks;
}

type LegacyClaims = { sub?: unknown; exp?: unknown; role?: unknown; type?: unknown; sessionType?: unknown };

async function currentLegacyUserId(token: string, env: AuthEnv): Promise<string | null> {
  if (!env.LEGACY_AUTH_ORIGIN || !env.LEGACY_AUTH_ANON_KEY || token.length > 8192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const response = await fetch(
    new URL("/api/auth/sessions/current", env.LEGACY_AUTH_ORIGIN),
    {
      headers: { Authorization: "Bearer " + token, apikey: env.LEGACY_AUTH_ANON_KEY },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    },
  );
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("Legacy session validation unavailable");
  const data = (await response.json()) as { user?: { id?: unknown } };
  const id = data.user?.id;
  return typeof id === "string" && id ? id : null;
}

async function verifyLegacyAccessToken(token: string, env: AuthEnv): Promise<string | null> {
  if (!legacyAuthEnabled(env)) return null;
  if (env.LEGACY_AUTH_MODE === "parallel") {
    // The original service owns the session in parallel mode. Verify it there
    // without rotating the refresh credential or issuing a second session.
    return currentLegacyUserId(token, env);
  }
  try {
    const header = decodeProtectedHeader(token);
    let payload: LegacyClaims;
    if (header.alg === "RS256") {
      const jwks = legacyJwksFor(env);
      if (!jwks) return null;
      ({ payload } = await jwtVerify(token, jwks, { algorithms: ["RS256"] }));
    } else if (header.alg === "HS256" && env.LEGACY_AUTH_REFRESH_SECRET) {
      ({ payload } = await jwtVerify(
        token,
        new TextEncoder().encode(env.LEGACY_AUTH_REFRESH_SECRET),
        { algorithms: ["HS256"] },
      ));
    } else {
      return null;
    }
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    if (typeof payload.exp !== "number" || payload.exp <= seconds()) return null;
    if (payload.role && payload.role !== "authenticated") return null;
    return payload.sub;
  } catch {
    return null;
  }
}

async function exchangeLegacyRefresh(token: string, env: AuthEnv) {
  if (!legacyAuthEnabled(env) || !env.LEGACY_AUTH_ORIGIN || !env.LEGACY_AUTH_ANON_KEY) return null;
  try {
    const response = await fetch(
      `${env.LEGACY_AUTH_ORIGIN.replace(/\/$/, "")}/api/auth/refresh?client_type=mobile`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: env.LEGACY_AUTH_ANON_KEY,
          Authorization: `Bearer ${env.LEGACY_AUTH_ANON_KEY}`,
        },
        body: JSON.stringify({ refresh_token: token }),
        redirect: "manual",
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { user?: { id?: unknown } };
    const id = data.user?.id;
    return typeof id === "string" && id ? findUser(env, id) : null;
  } catch {
    return null;
  }
}

async function revokeLegacyRefresh(token: string, env: AuthEnv) {
  if (!legacyAuthEnabled(env) || !env.LEGACY_AUTH_ORIGIN || !env.LEGACY_AUTH_ANON_KEY) return false;
  try {
    const response = await fetch(
      `${env.LEGACY_AUTH_ORIGIN.replace(/\/$/, "")}/api/auth/logout?client_type=mobile`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: env.LEGACY_AUTH_ANON_KEY,
          Authorization: `Bearer ${env.LEGACY_AUTH_ANON_KEY}`,
        },
        body: JSON.stringify({ refresh_token: token }),
        redirect: "manual",
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}
async function legacyUserFromAccess(req: Request, env: AuthEnv) {
  const token = req.headers
    .get("Authorization")
    ?.match(/^Bearer ([^\s]+)$/i)?.[1];
  // Issuing a new long-lived session uses the original service's current
  // decision. The offline JWT checks remain available for ordinary API reads.
  const id = token && legacyAuthEnabled(env) ? await currentLegacyUserId(token, env) : null;
  return id ? findUser(env, id) : null;
}
export const publicUser = (u: Account) => ({
  id: u.id,
  email: u.email,
  emailVerified: !!u.email_verified,
  profile: JSON.parse(u.profile),
  createdAt: u.created_at,
});
const cookieName = "insforge_refresh_token";
export function cookie(req: Request, key: string) {
  return (
    (req.headers.get("Cookie") ?? "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(key + "="))
      ?.slice(key.length + 1) ?? ""
  );
}
export async function getAccountId(
  req: Request,
  env: AuthEnv,
): Promise<string | null> {
  const token = req.headers
    .get("Authorization")
    ?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return null;
  let claims;
  if (env.AUTH_SECRET && env.AUTH_ORIGIN) {
    try {
      claims = (
        await jwtVerify(token, new TextEncoder().encode(env.AUTH_SECRET), {
          algorithms: ["HS256"],
          issuer: env.AUTH_ORIGIN,
          audience: "tokentracker-account",
          requiredClaims: ["exp", "sub", "sid"],
        })
      ).payload;
    } catch {
      claims = null;
    }
  }
  if (claims && typeof claims.sid === "string" && typeof claims.sub === "string") {
    return env.DB.prepare(
      "SELECT user_id FROM tt_auth_sessions WHERE id=? AND user_id=? AND expires_at>?",
    )
      .bind(claims.sid, claims.sub, seconds())
      .first<string>("user_id");
  }
  const legacyId = await verifyLegacyAccessToken(token, env);
  if (!legacyId) return null;
  return env.DB.prepare("SELECT id FROM tt_auth_accounts WHERE id=?")
    .bind(legacyId)
    .first<string>("id");
}
function responseHeaders(refresh: string, browser: boolean, lifetime: number) {
  const h = new Headers({ "Cache-Control": "no-store" });
  if (browser)
    h.append(
      "Set-Cookie",
      cookieName +
        "=" +
        refresh +
        "; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=" +
        lifetime,
    );
  return h;
}
const mobile = (req: Request) =>
  new URL(req.url).searchParams.get("client_type") === "mobile";
export async function issueSession(
  req: Request,
  env: AuthEnv,
  u: Account,
  previous?: { id: string; digest: string },
) {
  if (!env.AUTH_SECRET || !env.AUTH_ORIGIN)
    return authError("Authentication not configured", 503);
  const sid = previous?.id ?? crypto.randomUUID();
  const refresh = nonce(),
    csrf = nonce(),
    lifetime = 30 * 86400;
  const next = [
    await digest(refresh),
    await digest(csrf),
    seconds() + lifetime,
  ];
  const token = await new SignJWT({
    sid,
    role: "authenticated",
    email: u.email,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(u.id)
    .setIssuer(env.AUTH_ORIGIN)
    .setAudience("tokentracker-account")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(env.AUTH_SECRET));
  const write = previous
    ? env.DB.prepare(
        "UPDATE tt_auth_sessions SET refresh_digest=?,csrf_digest=?,expires_at=? WHERE id=? AND refresh_digest=? AND expires_at>?",
      ).bind(...next, sid, previous.digest, seconds())
    : env.DB.prepare(
        "INSERT INTO tt_auth_sessions(refresh_digest,csrf_digest,expires_at,id,user_id) VALUES(?,?,?,?,?)",
      ).bind(...next, sid, u.id);
  if ((await write.run()).meta.changes !== 1)
    return authError("Invalid session", 401);
  return Response.json(
    {
      user: publicUser(u),
      accessToken: token,
      csrfToken: csrf,
      ...(mobile(req) ? { refreshToken: refresh } : {}),
    },
    { headers: responseHeaders(refresh, !mobile(req), lifetime) },
  );
}
export async function jsonInput(
  req: Request,
): Promise<Record<string, unknown> | null> {
  const reader = req.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let len = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    len += value.byteLength;
    if (len > 16384) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (len === 0) return {};
  const bytes = new Uint8Array(len);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
export async function sessionRoute(
  req: Request,
  env: AuthEnv,
  path: string,
  entry: Record<string, unknown>,
) {
  if (path === "/api/auth/sessions/current" && req.method === "GET") {
    const id = await getAccountId(req, env),
      u = id && (await findUser(env, id));
    return u
      ? Response.json(
          { user: publicUser(u) },
          { headers: { "Cache-Control": "no-store" } },
        )
      : Response.json(
          { error: "AUTH_UNAUTHORIZED", message: "Unauthorized" },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        );
  }
  if (req.method !== "POST") return null;
  if (path === "/api/auth/session-migrate") {
    if (env.LEGACY_AUTH_MODE === "parallel")
      return authError("Refresh this session with the original service", 409);
    const accessUser = await legacyUserFromAccess(req, env);
    const supplied =
      typeof entry.refresh_token === "string"
        ? entry.refresh_token
        : typeof entry.refreshToken === "string"
          ? entry.refreshToken
          : "";
    const user = accessUser ?? (supplied ? await exchangeLegacyRefresh(supplied, env) : null);
    return user ? issueSession(req, env, user) : authError("Invalid legacy session", 401);
  }
  if (path === "/api/auth/sessions") {
    if (
      typeof entry.email !== "string" ||
      typeof entry.password !== "string" ||
      !entry.password ||
      entry.password.length > 1024
    )
      return authError("Invalid credentials", 401);
    const u = await env.DB.prepare(
      "SELECT * FROM tt_auth_accounts WHERE (email_ambiguous=0 AND email=?1) OR (email_ambiguous=1 AND email=?1 COLLATE BINARY)",
    )
      .bind(entry.email.trim())
      .first<Account & { password_hash: string | null }>();
    if (!u?.password_hash || !(await compare(entry.password, u.password_hash)))
      return authError("Invalid credentials", 401);
    await env.DB.prepare(
      "UPDATE tt_auth_accounts SET claimed=1 WHERE id=? AND claimed=0",
    )
      .bind(u.id)
      .run();
    return issueSession(req, env, u);
  }
  if (path !== "/api/auth/refresh" && path !== "/api/auth/logout") return null;
  const supplied = mobile(req)
    ? (entry.refresh_token ?? entry.refreshToken)
    : cookie(req, cookieName);
  if (typeof supplied !== "string" || !supplied)
    return authError("Invalid session", 401);
  const hashed = await digest(supplied);
  const session = await env.DB.prepare(
    "SELECT id,user_id,csrf_digest FROM tt_auth_sessions WHERE refresh_digest=? AND expires_at>?",
  )
    .bind(hashed, seconds())
    .first<{ id: string; user_id: string; csrf_digest: string }>();
  if (!session) {
    if (env.LEGACY_AUTH_MODE === "parallel")
      return authError("Refresh or sign out with the original service", 401);
    if (path.endsWith("/logout") && legacyAuthEnabled(env)) {
      if (!(await revokeLegacyRefresh(supplied, env)))
        return authError("Invalid session", 401);
      return Response.json(
        { success: true },
        { headers: responseHeaders("", !mobile(req), 0) },
      );
    }
    const legacyUser = path.endsWith("/refresh") ? await exchangeLegacyRefresh(supplied, env) : null;
    return legacyUser ? issueSession(req, env, legacyUser) : authError("Invalid session", 401);
  }
  if (
    !mobile(req) &&
    session.csrf_digest !==
      (await digest(req.headers.get("X-CSRF-Token") ?? ""))
  )
    return authError("Invalid CSRF token", 403);
  if (path.endsWith("/logout")) {
    // A background refresh can rotate the digest after authorization. Logout revokes the same session ID.
    await env.DB.prepare("DELETE FROM tt_auth_sessions WHERE id=?")
      .bind(session.id)
      .run();
    return Response.json(
      { success: true },
      { headers: responseHeaders("", !mobile(req), 0) },
    );
  }
  const u = await findUser(env, session.user_id);
  return u
    ? issueSession(req, env, u, { id: session.id, digest: hashed })
    : authError("Invalid session", 401);
}
