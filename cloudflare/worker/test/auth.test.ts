import { env } from "cloudflare:workers";
import { beforeAll, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import schema from "../../migrations/0003_account_auth.sql?raw";
import ambiguous from "../../migrations/0041_auth_ambiguous_email.sql?raw";
import legacy from "../../migrations/0004_legacy_identities.sql?raw";
import { digest, getAccountId, nonce } from "../src/auth";
import { legacyDigest, resolveSocial } from "../src/auth-oauth";
import { dispatchAuth } from "../src/auth-router";

const cfg = {
  DB: env.DB,
  AUTH_ORIGIN: "https://qa.test",
  AUTH_WEB_ORIGIN: "https://web.test",
  AUTH_LIMIT: { limit: async () => ({ success: true }) },
  AUTH_SECRET: nonce(),
  AUTH_MIGRATION_KEY: nonce(),
  AUTH_REGISTRATION_ENABLED: "1",
};
const make = (
  path: string,
  value?: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(cfg.AUTH_ORIGIN + path, {
    method: value === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
beforeAll(async () => {
  await env.DB.batch(
    [schema, legacy, ambiguous]
      .join("\n")
      .split(";")
      .filter((s) => s.trim())
      .map((s) => env.DB.prepare(s)),
  );
});
it("restores the original ID only for a verified provider subject; a different subject cannot inherit it via email", async () => {
  const id = crypto.randomUUID(),
    email = "old@example.test",
    subject = "123";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tt_auth_legacy VALUES(?,?)").bind(
      await legacyDigest(cfg, "github", subject),
      id,
    ),
    env.DB.prepare("INSERT INTO tt_auth_legacy VALUES(?,?)").bind(
      await legacyDigest(cfg, "email", email),
      id,
    ),
  ]);
  expect(
    await resolveSocial(cfg, "google", {
      subject: "456",
      email,
      name: "wrong",
    }),
  ).toBeNull();
  expect(
    (await resolveSocial(cfg, "github", { subject, email, name: "original" }))
      ?.id,
  ).toBe(id);
  expect(
    (await resolveSocial(cfg, "github", { subject, email, name: "original" }))
      ?.id,
  ).toBe(id);
});
it("consumes an OAuth code once with its matching verifier; refresh rotates and logout revokes", async () => {
  const user = crypto.randomUUID(),
    verifier = nonce(),
    code = nonce();
  await env.DB.prepare(
    "INSERT INTO tt_auth_accounts(id,email,email_verified,created_at) VALUES(?, 'test@example.test',1,'2026-01-01')",
  )
    .bind(user)
    .run();
  await env.DB.prepare(
    "INSERT INTO tt_auth_exchange VALUES(?,?,?,unixepoch()+120)",
  )
    .bind(await digest(code), await digest(verifier), user)
    .run();
  const path = "/api/auth/oauth/exchange?client_type=mobile";
  expect(
    (await dispatchAuth(make(path, { code, code_verifier: nonce() }), cfg))
      ?.status,
  ).toBe(401);
  const result = await dispatchAuth(
    make(path, { code, code_verifier: verifier }),
    cfg,
  );
  const s = (await result!.json()) as {
    user: { id: string };
    accessToken: string;
    refreshToken: string;
  };
  expect(s.user.id).toBe(user);
  expect(
    await getAccountId(
      make("/", undefined, { Authorization: "Bearer " + s.accessToken }),
      cfg,
    ),
  ).toBe(user);
  expect(
    (await dispatchAuth(make(path, { code, code_verifier: verifier }), cfg))
      ?.status,
  ).toBe(401);
  const rotate = () =>
    dispatchAuth(
      make("/api/auth/refresh?client_type=mobile", {
        refresh_token: s.refreshToken,
      }),
      cfg,
    );
  const rotations = await Promise.all([rotate(), rotate()]);
  expect(rotations.map((r) => r?.status).sort()).toEqual([200, 401]);
  const next = (await rotations.find((r) => r?.status === 200)!.json()) as {
    refreshToken: string;
  };
  expect(
    (
      await dispatchAuth(
        make("/api/auth/logout?client_type=mobile", {
          refresh_token: next.refreshToken,
        }),
        cfg,
      )
    )?.status,
  ).toBe(200);
  expect(
    await getAccountId(
      make("/", undefined, { Authorization: "Bearer " + s.accessToken }),
      cfg,
    ),
  ).toBeNull();
});
it("exchanges an old InsForge refresh token into a Cloudflare session without changing the user ID", async () => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO tt_auth_accounts(id,email,email_verified,created_at) VALUES(?, 'legacy-refresh@example.test',1,'2026-01-01')",
  ).bind(id).run();
  const legacy = {
    ...cfg,
    LEGACY_AUTH_ENABLED: "1",
    LEGACY_AUTH_ORIGIN: "https://legacy.test",
    LEGACY_AUTH_ANON_KEY: "anon-test-key",
    LEGACY_AUTH_EXPIRES_AT: String(Math.floor(Date.now() / 1000) + 600),
  };
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    expect(url).toMatch(/^https:\/\/legacy\.test\/api\/auth\/(?:refresh|logout)\?client_type=mobile$/);
    expect(init?.headers).toMatchObject({
      apikey: "anon-test-key",
      Authorization: "Bearer anon-test-key",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "old-refresh" });
    if (url.endsWith("/logout?client_type=mobile")) return Response.json({ success: true });
    return Response.json({ user: { id } });
  });
  try {
    const response = await dispatchAuth(
      make("/api/auth/refresh?client_type=mobile", { refresh_token: "old-refresh" }),
      legacy,
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { user: { id: string }; accessToken: string; refreshToken: string };
    expect(body.user.id).toBe(id);
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(
      await getAccountId(
        make("/", undefined, { Authorization: "Bearer " + body.accessToken }),
        legacy,
      ),
    ).toBe(id);
    expect(
      (
        await dispatchAuth(
          make("/api/auth/logout?client_type=mobile", { refresh_token: "old-refresh" }),
          legacy,
        )
      )?.status,
    ).toBe(200);
  } finally {
    provider.mockRestore();
  }
});
it("uses a current legacy browser session to issue a same-account Cloudflare cookie", async () => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO tt_auth_accounts(id,email,email_verified,created_at) VALUES(?, 'legacy-web@example.test',1,'2026-01-01')",
  ).bind(id).run();
  const legacy = {
    ...cfg,
    LEGACY_AUTH_ENABLED: "1",
    LEGACY_AUTH_MODE: "exchange",
    LEGACY_AUTH_ORIGIN: "https://legacy.test",
    LEGACY_AUTH_ANON_KEY: "legacy-public-key",
    LEGACY_AUTH_EXPIRES_AT: String(Math.floor(Date.now() / 1000) + 600),
  };
  let signedIn = true;
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://legacy.test/api/auth/sessions/current");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer legacy.web.token", apikey: "legacy-public-key" });
    return signedIn ? Response.json({ user: { id } }) : new Response(null, { status: 401 });
  });
  const exchange = () => make("/api/auth/session-migrate", {}, {
    Origin: cfg.AUTH_WEB_ORIGIN, Authorization: "Bearer legacy.web.token",
  });
  try {
    expect((await dispatchAuth(exchange(), { ...legacy, LEGACY_AUTH_MODE: "parallel" }))?.status).toBe(409);
    expect(provider).not.toHaveBeenCalled();
    const migrated = await dispatchAuth(exchange(), legacy);
    expect(migrated?.status).toBe(200);
    expect(migrated?.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    const cookie = migrated!.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^insforge_refresh_token=.+; HttpOnly; Secure;/);
    const session = (await migrated!.json()) as { user: { id: string }; csrfToken: string; refreshToken?: string };
    expect(session.user.id).toBe(id);
    expect(session.refreshToken).toBeUndefined();

    signedIn = false;
    expect((await dispatchAuth(exchange(), legacy))?.status).toBe(401);
    const refreshed = await dispatchAuth(make("/api/auth/refresh", {}, {
      Cookie: cookie.split(";")[0], "X-CSRF-Token": session.csrfToken, Origin: cfg.AUTH_WEB_ORIGIN,
    }), legacy);
    expect(refreshed?.status).toBe(200);
    expect(await refreshed!.json()).toMatchObject({ user: { id } });
    expect(provider).toHaveBeenCalledTimes(2);
  } finally {
    provider.mockRestore();
  }
});
it("restores dormant ID after email proof, leaves a rejected code unusable, and verifies the new password", async () => {
  const id = crypto.randomUUID(),
    email = "dormant@example.test";
  await env.DB.prepare("INSERT INTO tt_auth_legacy VALUES(?,?)")
    .bind(await legacyDigest(cfg, "email", email), id)
    .run();
  let code = "";
  const withMail = {
    ...cfg,
    AUTH_EMAIL_FROM: "auth@qa.test",
    EMAIL: {
      send: async (m: { text: string }) => {
        code = m.text.match(/\d{6}/)![0];
      },
    },
  };
  expect(
    (
      await dispatchAuth(
        make("/api/auth/users", { email, password: "sample-password" }),
        withMail,
      )
    )?.status,
  ).toBe(409);
  await dispatchAuth(
    make("/api/auth/email/send-reset-password", { email }),
    withMail,
  );
  const exchange = () =>
    dispatchAuth(
      make("/api/auth/email/exchange-reset-password-token", { email, code }),
      withMail,
    );
  const otp = ((await (await exchange())!.json()) as { token: string }).token;
  expect((await exchange())?.status).toBe(401);
  expect(
    (
      await dispatchAuth(
        make("/api/auth/email/reset-password", {
          otp,
          newPassword: "new-test-password",
        }),
        withMail,
      )
    )?.status,
  ).toBe(200);
  const login = await dispatchAuth(
    make("/api/auth/sessions", { email, password: "new-test-password" }),
    withMail,
  );
  const session = (await login!.json()) as {
    user: { id: string };
    csrfToken: string;
    refreshToken?: string;
  };
  expect(session.user.id).toBe(id);
  expect(session.refreshToken).toBeUndefined();
  const cookies = login!.headers.get("set-cookie")!.split(";")[0];
  expect(
    (
      await dispatchAuth(
        make("/api/auth/refresh", {}, { Cookie: cookies }),
        withMail,
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await dispatchAuth(
        make(
          "/api/auth/refresh",
          {},
          { Cookie: cookies, "X-CSRF-Token": session.csrfToken },
        ),
        withMail,
      )
    )?.status,
  ).toBe(200);
});
it("accepts a verified legacy password and rejects untrusted browser origins", async () => {
  const id = crypto.randomUUID(),
    email = "password@example.test";
  await env.DB.prepare(
    "INSERT INTO tt_auth_accounts(id,email,email_verified,password_hash,created_at) VALUES(?,?,0,?,'2026-01-01')",
  )
    .bind(id, email, await hash("correct-password", 4))
    .run();
  expect(
    (
      await dispatchAuth(
        make("/api/auth/sessions", { email, password: "wrong" }),
        cfg,
      )
    )?.status,
  ).toBe(401);
  expect(
    (
      await dispatchAuth(
        make(
          "/api/auth/sessions",
          { email, password: "correct-password" },
          { Origin: "https://wrong.test" },
        ),
        cfg,
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await dispatchAuth(
        make("/api/auth/sessions", { email, password: "correct-password" }),
        cfg,
      )
    )?.status,
  ).toBe(200);
});

it.each(["github", "google"])("starts production %s OAuth only on the branded host", async (provider) => {
  const origin = "https://api.tokentracker.cc";
  const liveEnv = {
    ...cfg, AUTH_ORIGIN: origin, AUTH_WEB_ORIGIN: "https://www.tokentracker.cc", AUTH_ENFORCE_CANONICAL_ORIGIN: "1",
    GITHUB_CLIENT_ID: "fixture", GITHUB_CLIENT_SECRET: "fixture",
    GOOGLE_CLIENT_ID: "fixture", GOOGLE_CLIENT_SECRET: "fixture",
    TOKENTRACKER_BILLING_ENVIRONMENT: "live",
  };
  const path = async (redirect: string) => "/api/auth/oauth/" + provider + "?" + new URLSearchParams({
    redirect_uri: redirect, code_challenge: await digest(nonce()),
  });
  const foreign = await dispatchAuth(new Request(origin + await path("https://www.tokentracker.cc.example.test/dashboard")), liveEnv);
  expect(foreign?.status).toBe(400);
  for (const returnTo of ["tokentracker://auth/callback", liveEnv.AUTH_WEB_ORIGIN + "/dashboard"]) {
    const start = await path(returnTo);
    expect((await dispatchAuth(new Request("https://qa-worker.example.test" + start), liveEnv))?.status).toBe(421);
    const begin = await dispatchAuth(new Request(origin + start), liveEnv);
    expect(begin?.status).toBe(200);
    const { authUrl } = (await begin!.json()) as { authUrl: string };
    expect(new URL(authUrl).origin).toBe(origin);
    const redirect = await dispatchAuth(new Request(authUrl), liveEnv);
    const providerUrl = new URL(redirect!.headers.get("location")!);
    expect(providerUrl.searchParams.get("redirect_uri")).toBe(origin + "/api/auth/oauth/callback/" + provider);
  }
});

it.each(["http://127.0.0.1:7680/", "tokentracker://auth/callback", "tokentracker-qa://auth/callback"])("completes the provider callback for %s with a one-time PKCE exchange", async (redirect) => {
  const testEnv = {
    ...cfg,
    TOKENTRACKER_BILLING_ENVIRONMENT: "sandbox",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
  };
  const verifier = nonce(),
    challenge = await digest(verifier);
  const begin = (redirect: string) =>
    dispatchAuth(
      make(
        "/api/auth/oauth/github?" +
          new URLSearchParams({
            redirect_uri: redirect,
            code_challenge: challenge,
          }),
      ),
      testEnv,
    );
  for (const rejected of [
    "https://evil.example/",
    "http://127.0.0.1.evil.example:8888/",
    "http://localhost:9999/redirect",
    "http://user@localhost:9999/",
  ]) {
    expect((await begin(rejected))?.status).toBe(400);
  }
  const { authUrl } = (await (await begin(redirect))!.json()) as {
    authUrl: string;
  };
  const navigation = await dispatchAuth(new Request(authUrl), testEnv);
  const provider = new URL(navigation!.headers.get("location")!);
  expect(provider.hostname).toBe("github.com");
  expect(provider.searchParams.get("code_challenge_method")).toBe("S256");
  const path =
    "/api/auth/oauth/callback/github?code=provider-code&state=" +
    provider.searchParams.get("state");
  expect((await dispatchAuth(make(path), testEnv))?.status).toBe(400);
  const browser = navigation!.headers.get("set-cookie")!.split(";")[0];
  const endpoint = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      expect(init?.redirect).toBe("manual");
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({ access_token: "provider-test-token" });
      if (url === "https://api.github.com/user")
        return Response.json({ id: 7768, name: "QA" });
      if (url === "https://api.github.com/user/emails")
        return Response.json([
          { email: "qa-oauth@example.test", primary: true, verified: true },
        ]);
      throw new Error("Unexpected provider");
    });
  try {
    const returned = await dispatchAuth(
      make(path, undefined, { Cookie: browser }),
      testEnv,
    );
    let target: URL;
    if (redirect.startsWith("http:")) {
      expect(returned?.status).toBe(302);
      target = new URL(returned!.headers.get("location")!);
      expect(target.origin).toBe("http://127.0.0.1:7680");
    } else {
      expect(returned?.status).toBe(200);
      expect(returned!.headers.get("Content-Type")).toContain("text/html");
      expect(returned!.headers.get("Cache-Control")).toContain("no-store");
      expect(returned!.headers.get("Referrer-Policy")).toBe("no-referrer");
      const page = await returned!.text();
      expect(page).toContain("Signed in successfully");
      expect(page).toContain("M20 6 9 17l-5-5");
      const link = page.match(/id="open-app" href="([^"]+)"/);
      expect(link).not.toBeNull();
      target = new URL(link![1]);
      expect(target.protocol + "//" + target.host + target.pathname).toBe(redirect);
    }
    const code = target.searchParams.get("insforge_code");
    const result = await dispatchAuth(
      make("/api/auth/oauth/exchange?client_type=mobile", {
        code,
        code_verifier: verifier,
      }),
      testEnv,
    );
    expect(result?.status).toBe(200);
    expect(
      (await dispatchAuth(make(path, undefined, { Cookie: browser }), testEnv))
        ?.status,
    ).toBe(400);
  } finally {
    endpoint.mockRestore();
  }
});
it("holds email-only recovery for colliding source identities while preserving original provider IDs", async () => {
  const email = "mixed@example.test",
    id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO tt_auth_identity_conflicts VALUES(?)")
    .bind(await legacyDigest(cfg, "email", email))
    .run();
  await env.DB.prepare("INSERT INTO tt_auth_legacy VALUES(?,?)")
    .bind(await legacyDigest(cfg, "github", "known-case-owner"), id)
    .run();
  expect(
    (
      await dispatchAuth(
        make("/api/auth/email/send-reset-password", { email }),
        cfg,
      )
    )?.status,
  ).toBe(409);
  expect(
    await resolveSocial(cfg, "google", {
      subject: "unlinked",
      email,
      name: "",
    }),
  ).toBeNull();
  expect(
    (
      await resolveSocial(cfg, "github", {
        subject: "known-case-owner",
        email,
        name: "",
      })
    )?.id,
  ).toBe(id);
});

it("treats an empty browser refresh as missing credentials and rejects malformed JSON", async () => {
  const refresh = (body: string) =>
    dispatchAuth(
      new Request(cfg.AUTH_ORIGIN + "/api/auth/refresh", {
        method: "POST",
        body,
      }),
      cfg,
    );
  expect((await refresh(""))?.status).toBe(401);
  expect((await refresh("{"))?.status).toBe(400);
});

it("returns the rotated CSRF token when a desktop relay refreshes a browser login", async () => {
  const email = "desktop-relay@example.test";
  const login = await dispatchAuth(
    make("/api/auth/users", { email, password: "qa-password" }),
    cfg,
  );
  const original = login!.headers
    .get("set-cookie")!
    .split(";")[0]
    .split("=")[1];
  const rotation = await dispatchAuth(
    make("/api/auth/refresh?client_type=mobile", { refresh_token: original }),
    cfg,
  );
  const next = (await rotation!.json()) as {
    csrfToken: string;
    refreshToken: string;
    accessToken: string;
  };
  expect(next.csrfToken).toBeTruthy();
  const logout = make(
    "/api/auth/logout",
    {},
    {
      Cookie: "insforge_refresh_token=" + next.refreshToken,
      "X-CSRF-Token": next.csrfToken,
    },
  );
  expect((await dispatchAuth(logout, cfg))?.status).toBe(200);
  expect(
    await getAccountId(
      make("/", undefined, { Authorization: "Bearer " + next.accessToken }),
      cfg,
    ),
  ).toBeNull();
});

it("keeps two browser OAuth attempts independently bound to their initiating cookies", async () => {
  const testEnv = {
    ...cfg,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
  };
  const challenge = await digest(nonce());
  async function start() {
    const init = await dispatchAuth(
      make(
        "/api/auth/oauth/github?" +
          new URLSearchParams({
            redirect_uri: "http://127.0.0.1:7680/",
            code_challenge: challenge,
          }),
      ),
      testEnv,
    );
    const result = await dispatchAuth(
      new Request(((await init!.json()) as { authUrl: string }).authUrl),
      testEnv,
    );
    return result!.headers.get("set-cookie")!.split(";")[0].split("=")[0];
  }
  const [a, b] = await Promise.all([start(), start()]);
  expect(a).not.toBe(b);
  expect(a).toMatch(/^__Host-tt-oauth-/);
});

it("allows the isolated app callback only in the sandbox", async () => {
  const challenge = await digest(nonce());
  for (const [mode, status] of [["sandbox", 200], ["live", 400]] as const) {
    const params = new URLSearchParams({redirect_uri:"tokentracker-qa://auth/callback", code_challenge:challenge});
    const result = await dispatchAuth(make("/api/auth/oauth/github?"+params),
      {...cfg, GITHUB_CLIENT_ID:"client", GITHUB_CLIENT_SECRET:"secret", TOKENTRACKER_BILLING_ENVIRONMENT:mode});
    expect(result?.status).toBe(status);
  }
});
