import { nativeReturnPage } from "./auth-native-return";
import { base64url } from "jose";
import {
  type Account,
  type AuthEnv,
  authError,
  cookie,
  digest,
  findUser,
  issueSession,
  nonce,
  seconds,
} from "./auth";

export interface LegacyEnv extends AuthEnv {
  AUTH_MIGRATION_KEY?: string;
  AUTH_REGISTRATION_ENABLED?: string;
  TOKENTRACKER_BILLING_ENVIRONMENT?: string;
}
type Provider = "github" | "google";
const CALLBACK = "/api/auth/oauth/callback/";
const providers = {
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
  },
};
export async function legacyDigest(
  env: LegacyEnv,
  kind: string,
  value: string,
) {
  if (!env.AUTH_MIGRATION_KEY) throw new Error("Missing migration key");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.AUTH_MIGRATION_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url.encode(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, enc.encode(kind + "\0" + value)),
    ),
  );
}
export const emailKey = (email: string) => email.trim().toLowerCase();
class ProviderFailure extends Error {}
async function jsonFetch(step: string, url: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", "TokenTracker");
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, redirect: "manual" });
  } catch {
    throw new ProviderFailure(step + " connection failed");
  }
  if (!response.ok)
    throw new ProviderFailure(step + " returned HTTP " + response.status);
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ProviderFailure(step + " returned an unreadable response");
  }
}
const stateCookie = (state: string) => "__Host-tt-oauth-" + state;
async function providerIdentity(provider: Provider, token: string) {
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json",
    "User-Agent": "TokenTracker",
  };
  if (provider === "google") {
    const u = await jsonFetch(
      "user profile",
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers },
    );
    if (
      typeof u.sub !== "string" ||
      !u.sub ||
      u.email_verified !== true ||
      typeof u.email !== "string"
    )
      return null;
    return {
      subject: u.sub,
      email: emailKey(u.email),
      name: typeof u.name === "string" ? u.name : "",
    };
  }
  const u = await jsonFetch("user profile", "https://api.github.com/user", {
    headers,
  });
  if (!Number.isSafeInteger(u.id)) return null;
  const result = await jsonFetch(
    "verified email",
    "https://api.github.com/user/emails",
    { headers },
  );
  if (!Array.isArray(result)) return null;
  const emails = result as {
    primary: boolean;
    verified: boolean;
    email: string;
  }[];
  const address = emails.find(
    (e) => e.primary && e.verified && typeof e.email === "string",
  );
  return address
    ? {
        subject: String(u.id),
        email: emailKey(address.email),
        name: String(u.name ?? u.login ?? ""),
      }
    : null;
}
export async function resolveSocial(
  env: LegacyEnv,
  provider: Provider,
  identity: { subject: string; email: string; name: string },
): Promise<Account | null> {
  const db = env.DB;
  const subjectDigest = await legacyDigest(env, provider, identity.subject);
  if (
    await db
      .prepare(
        "SELECT 1 FROM tt_auth_identity_conflicts WHERE identity_digest=?",
      )
      .bind(subjectDigest)
      .first()
  )
    return null;
  const known = await db
    .prepare(
      "SELECT user_id FROM tt_auth_providers WHERE provider=? AND subject=?",
    )
    .bind(provider, identity.subject)
    .first<string>("user_id");
  if (known) {
    await db
      .prepare("UPDATE tt_auth_accounts SET claimed=1 WHERE id=? AND claimed=0")
      .bind(known)
      .run();
    return findUser(env, known);
  }
  const archivedId = await db
    .prepare("SELECT user_id FROM tt_auth_legacy WHERE identity_digest=?")
    .bind(await legacyDigest(env, provider, identity.subject))
    .first<string>("user_id");
  const ambiguous = Boolean(
    await db
      .prepare(
        "SELECT 1 FROM tt_auth_identity_conflicts WHERE identity_digest=?",
      )
      .bind(await legacyDigest(env, "email", identity.email))
      .first(),
  );
  if (ambiguous && !archivedId) return null;
  const emailOwner = await db
    .prepare("SELECT id FROM tt_auth_accounts WHERE email=?")
    .bind(identity.email)
    .first<string>("id");
  const reserved = await db
    .prepare("SELECT user_id FROM tt_auth_legacy WHERE identity_digest=?")
    .bind(await legacyDigest(env, "email", identity.email))
    .first<string>("user_id");
  // A new social subject cannot take an existing account on the strength of its email.
  if (
    (!ambiguous && emailOwner && emailOwner !== archivedId) ||
    (reserved && reserved !== archivedId)
  )
    return null;
  if (!archivedId && env.AUTH_REGISTRATION_ENABLED !== "1") return null;
  const id = archivedId ?? crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO tt_auth_accounts(id,email,email_verified,profile,created_at,claimed,email_ambiguous) VALUES(?,?,1,?,?,1,?) ON CONFLICT(id) DO UPDATE SET claimed=1",
      )
      .bind(
        id,
        identity.email,
        JSON.stringify({ name: identity.name }),
        new Date().toISOString(),
        Number(ambiguous),
      ),
    db
      .prepare(
        "INSERT INTO tt_auth_providers(provider,subject,user_id) VALUES(?,?,?)",
      )
      .bind(provider, identity.subject, id),
  ]);
  return findUser(env, id);
}
function credentials(env: AuthEnv, p: Provider) {
  return p === "google"
    ? [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET]
    : [env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET];
}
export async function oauthRoute(
  req: Request,
  env: LegacyEnv,
  body: Record<string, unknown>,
) {
  const url = new URL(req.url),
    path = url.pathname,
    db = env.DB;
  if (path === "/api/auth/oauth/exchange" && req.method === "POST") {
    if (
      typeof body.code !== "string" ||
      typeof body.code_verifier !== "string" ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)
    )
      return authError("Invalid exchange", 400);
    const id = await db
      .prepare(
        "DELETE FROM tt_auth_exchange WHERE digest=? AND challenge=? AND expires_at>? RETURNING user_id",
      )
      .bind(
        await digest(body.code),
        await digest(body.code_verifier),
        seconds(),
      )
      .first<string>("user_id");
    const user = id && (await findUser(env, id));
    return user
      ? issueSession(req, env, user)
      : authError("Invalid exchange", 401);
  }
  if (req.method !== "GET") return null;
  const callback = path.startsWith(CALLBACK);
  const provider = path.slice(
    callback ? CALLBACK.length : "/api/auth/oauth/".length,
  );
  if (provider !== "github" && provider !== "google") return null;
  const [client, secret] = credentials(env, provider);
  if (!client || !secret || !env.AUTH_ORIGIN || !env.AUTH_MIGRATION_KEY)
    return authError("OAuth provider not configured", 503);
  const cb = env.AUTH_ORIGIN + CALLBACK + provider;
  if (!callback && !url.searchParams.has("start")) {
    const redirect = url.searchParams.get("redirect_uri") ?? "",
      challenge = url.searchParams.get("code_challenge") ?? "";
    let permitted = redirect === "tokentracker://auth/callback" ||
      (env.TOKENTRACKER_BILLING_ENVIRONMENT === "sandbox" && redirect === "tokentracker-qa://auth/callback");
    try {
      const dest = new URL(redirect);
      const loopback =
        dest.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(dest.hostname) &&
        !!dest.port;
      const site = env.AUTH_WEB_ORIGIN && dest.origin === env.AUTH_WEB_ORIGIN;
      if (
        (loopback || site) &&
        !dest.username &&
        !dest.password &&
        !dest.search &&
        !dest.hash &&
        ["/", "/auth/callback", "/dashboard"].includes(dest.pathname)
      )
        permitted = true;
    } catch {
      permitted = false;
    }
    if (!permitted || !/^[\w-]{43}$/.test(challenge))
      return authError("Invalid OAuth redirect or PKCE challenge", 400);
    const start = nonce();
    await db
      .prepare("INSERT INTO tt_auth_oauth VALUES(?,?,?,?,?,?,?)")
      .bind(
        await digest(start),
        provider,
        redirect,
        challenge,
        nonce(),
        "",
        seconds() + 600,
      )
      .run();
    return Response.json(
      { authUrl: env.AUTH_ORIGIN + path + "?start=" + start },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!callback) {
    const secretCookie = nonce(),
      state = nonce();
    const flow = await db
      .prepare(
        "UPDATE tt_auth_oauth SET state=?,cookie_digest=? WHERE state=? AND cookie_digest='' AND expires_at>? AND provider=? RETURNING verifier",
      )
      .bind(
        await digest(state),
        await digest(secretCookie),
        await digest(url.searchParams.get("start") ?? ""),
        seconds(),
        provider,
      )
      .first<{ verifier: string }>();
    if (!flow) return authError("OAuth request expired", 400);
    const dest = new URL(providers[provider].authorize);
    dest.search = new URLSearchParams({
      client_id: client,
      redirect_uri: cb,
      response_type: "code",
      scope: providers[provider].scope,
      state,
      code_challenge: await digest(flow.verifier),
      code_challenge_method: "S256",
    }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        Location: dest.href,
        "Cache-Control": "no-store",
        "Set-Cookie":
          stateCookie(state) +
          "=" +
          secretCookie +
          "; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600",
      },
    });
  }
  const code = url.searchParams.get("code");
  if (!code) return authError("OAuth authorization declined", 400);
  const state = url.searchParams.get("state") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(state))
    return authError("OAuth login state expired. Start a new sign-in.", 400);
  const flow = await db
    .prepare(
      "DELETE FROM tt_auth_oauth WHERE state=? AND cookie_digest=? AND provider=? AND expires_at>? RETURNING redirect_uri,challenge,verifier",
    )
    .bind(
      await digest(state),
      await digest(cookie(req, stateCookie(state))),
      provider,
      seconds(),
    )
    .first<{ redirect_uri: string; challenge: string; verifier: string }>();
  if (!flow)
    return authError(
      "OAuth login expired, already used, or opened in another browser. Start a new sign-in.",
      400,
    );
  let identity;
  try {
    const exchanged = await jsonFetch(
      "token exchange",
      providers[provider].token,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client,
          client_secret: secret,
          code,
          redirect_uri: cb,
          code_verifier: flow.verifier,
        }).toString(),
      },
    );
    if (typeof exchanged.access_token !== "string")
      return authError("OAuth exchange failed. Start a new sign-in.", 401);
    identity = await providerIdentity(provider, exchanged.access_token);
  } catch (error) {
    if (error instanceof ProviderFailure)
      return authError(provider + " OAuth: " + error.message, 502);
    throw error;
  }
  if (!identity) return authError("Provider identity unavailable", 401);
  const user = await resolveSocial(env, provider, identity);
  if (!user)
    return authError(
      "Use your original sign-in method to recover this account",
      409,
    );
  const oneTime = nonce();
  await db
    .prepare("INSERT INTO tt_auth_exchange VALUES(?,?,?,?)")
    .bind(await digest(oneTime), flow.challenge, user.id, seconds() + 120)
    .run();
  const dest = new URL(flow.redirect_uri);
  dest.searchParams.set("insforge_code", oneTime);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Set-Cookie": stateCookie(state) + "=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
  });
  if (dest.protocol === "tokentracker:" || dest.protocol === "tokentracker-qa:") {
    return nativeReturnPage(dest, req, headers);
  }
  headers.set("Location", dest.href);
  return new Response(null, { status: 302, headers });
}
