import { hash } from "bcryptjs";
import {
  authError,
  digest,
  findUser,
  issueSession,
  nonce,
  seconds,
} from "./auth";
import { emailKey, legacyDigest, type LegacyEnv } from "./auth-oauth";

type EmailEnv = LegacyEnv & { AUTH_REGISTRATION_ENABLED?: string };
const acceptablePassword = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 6 &&
  new TextEncoder().encode(value).length <= 72;
const accepted = () =>
  Response.json(
    { success: true },
    { headers: { "Cache-Control": "no-store" } },
  );
const emailValid = (value: string) =>
  value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
async function sendProof(
  env: EmailEnv,
  email: string,
  purpose: "reset" | "recover",
) {
  if (!env.EMAIL || !env.AUTH_EMAIL_FROM)
    return authError("Email delivery is not configured", 503);
  const random = new Uint32Array(1);
  // Rejection sampling keeps decimal one-time codes uniform.
  do {
    crypto.getRandomValues(random);
  } while (random[0] >= 4294000000);
  const code = String(random[0] % 1000000).padStart(6, "0"),
    now = seconds();
  const key = await legacyDigest(env, "otp:" + purpose, email + "\0" + code);
  const result = await env.DB.prepare(
    `INSERT INTO tt_auth_email_codes(email,purpose,digest,expires_at,sent_at,remaining)
    VALUES(?,?,?,?,?,5) ON CONFLICT(email,purpose) DO UPDATE SET digest=excluded.digest,
    expires_at=excluded.expires_at,sent_at=excluded.sent_at,remaining=5 WHERE tt_auth_email_codes.sent_at<=?`,
  )
    .bind(email, purpose, key, now + 600, now, now - 60)
    .run();
  if (!result.meta.changes) return accepted();
  try {
    await env.EMAIL.send({
      from: env.AUTH_EMAIL_FROM,
      to: email,
      subject: "Your TokenTracker verification code",
      text:
        "Your TokenTracker verification code is " +
        code +
        ". It expires in 10 minutes.",
    });
  } catch {
    await env.DB.prepare(
      "DELETE FROM tt_auth_email_codes WHERE digest=? AND email=? AND purpose=?",
    )
      .bind(key, email, purpose)
      .run();
    return authError("Email delivery failed", 503);
  }
  return accepted();
}
async function consumeProof(
  env: EmailEnv,
  email: string,
  purpose: string,
  code: unknown,
) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  const key = await legacyDigest(env, "otp:" + purpose, email + "\0" + code);
  const [accepted] = await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM tt_auth_email_codes WHERE email=? AND purpose=? AND digest=? AND remaining>0 AND expires_at>? RETURNING email",
    ).bind(email, purpose, key, seconds()),
    env.DB.prepare(
      "UPDATE tt_auth_email_codes SET remaining=remaining-1 WHERE email=? AND purpose=? AND digest<>? AND remaining>0",
    ).bind(email, purpose, key),
  ]);
  return accepted.results.length === 1;
}
export async function emailRoute(
  req: Request,
  env: EmailEnv,
  path: string,
  body: Record<string, unknown>,
) {
  if (req.method !== "POST") return null;
  const email = typeof body.email === "string" ? emailKey(body.email) : "";
  if (path === "/api/auth/email/reset-password") {
    if (!acceptablePassword(body.newPassword) || typeof body.otp !== "string")
      return authError("Invalid password or token", 400);
    const proof = await digest(body.otp);
    const id = await env.DB.prepare(
      "SELECT user_id FROM tt_auth_reset_tokens WHERE digest=? AND expires_at>?",
    )
      .bind(proof, seconds())
      .first<string>("user_id");
    if (!id) return authError("Invalid reset token", 401);
    const hashed = await hash(body.newPassword, 10);
    const [update] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE tt_auth_accounts SET password_hash=?,email_verified=1,claimed=1 WHERE id=? AND EXISTS
      (SELECT 1 FROM tt_auth_reset_tokens WHERE digest=? AND user_id=? AND expires_at>?)`,
      ).bind(hashed, id, proof, id, seconds()),
      env.DB.prepare(
        "DELETE FROM tt_auth_sessions WHERE user_id=? AND EXISTS (SELECT 1 FROM tt_auth_reset_tokens WHERE digest=? AND user_id=?)",
      ).bind(id, proof, id),
      env.DB.prepare(
        "DELETE FROM tt_auth_reset_tokens WHERE user_id=? AND EXISTS (SELECT 1 FROM tt_auth_reset_tokens WHERE digest=? AND user_id=?)",
      ).bind(id, proof, id),
    ]);
    return update.meta.changes === 1
      ? accepted()
      : authError("Invalid reset token", 401);
  }
  if (!path.startsWith("/api/auth/email/") && path !== "/api/auth/users")
    return null;
  if (!emailValid(email)) return authError("Invalid email", 400);
  const addressDigest = await legacyDigest(env, "email", email);
  if (
    await env.DB.prepare(
      "SELECT 1 FROM tt_auth_identity_conflicts WHERE identity_digest=?",
    )
      .bind(addressDigest)
      .first()
  )
    return authError(
      "Use your original sign-in method or contact support",
      409,
    );
  const account = await env.DB.prepare(
    "SELECT id FROM tt_auth_accounts WHERE email=?",
  )
    .bind(email)
    .first<string>("id");
  const pending = await env.DB.prepare(
    "SELECT user_id FROM tt_auth_legacy WHERE identity_digest=?",
  )
    .bind(await legacyDigest(env, "email", email))
    .first<string>("user_id");
  if (path === "/api/auth/users") {
    if (!acceptablePassword(body.password))
      return authError("Invalid password", 400);
    if (account || pending)
      return authError("Use account recovery for this email", 409);
    if (env.AUTH_REGISTRATION_ENABLED !== "1")
      return authError("New registrations are not enabled", 503);
    // Match the existing project's password signup policy. A password-only signup
    // does not verify ownership of its address and cannot claim a legacy identity.
    const id = crypto.randomUUID();
    const added = await env.DB.prepare(
      "INSERT INTO tt_auth_accounts(id,email,email_verified,password_hash,profile,created_at,claimed) VALUES(?,?,0,?,?,?,1) ON CONFLICT DO NOTHING",
    )
      .bind(
        id,
        email,
        await hash(body.password, 10),
        JSON.stringify({
          name: typeof body.name === "string" ? body.name.slice(0, 200) : "",
        }),
        new Date().toISOString(),
      )
      .run();
    if (!added.meta.changes)
      return authError("Use account recovery for this email", 409);
    return issueSession(req, env, (await findUser(env, id))!);
  }
  if (
    path === "/api/auth/email/send-reset-password" ||
    path === "/api/auth/email/send-verification"
  ) {
    if (!env.EMAIL || !env.AUTH_EMAIL_FROM)
      return authError("Email delivery is not configured", 503);
    if (!account && !pending) return accepted();
    return sendProof(
      env,
      email,
      path.endsWith("send-verification") ? "recover" : "reset",
    );
  }
  const reset = path.endsWith("/exchange-reset-password-token");
  if (!reset && path !== "/api/auth/email/verify") return null;
  if (
    !(await consumeProof(
      env,
      email,
      reset ? "reset" : "recover",
      body.code ?? body.otp,
    ))
  )
    return authError("Invalid verification code", 401);
  const id = account ?? pending;
  if (!id || (account && pending && account !== pending))
    return authError("Account recovery requires review", 409);
  await env.DB.prepare(
    "INSERT INTO tt_auth_accounts(id,email,email_verified,claimed,created_at) VALUES(?,?,1,1,?) ON CONFLICT(id) DO UPDATE SET email_verified=1,claimed=1 WHERE tt_auth_accounts.email=excluded.email",
  )
    .bind(id, email, new Date().toISOString())
    .run();
  const user = await findUser(env, id);
  if (!user || emailKey(user.email) !== email)
    return authError("Account recovery requires review", 409);
  if (!reset) return issueSession(req, env, user);
  const token = nonce();
  await env.DB.prepare("INSERT INTO tt_auth_reset_tokens VALUES(?,?,?)")
    .bind(await digest(token), id, seconds() + 300)
    .run();
  return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
