// Interactive QA acceptance: the provider owns login and consent in the user's browser.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";

const provider = process.argv[2];
assert.ok(["github", "google"].includes(provider));
const origin =
  "https://api-qa-tokentracker-migration-staging.sunxiufeng1992.workers.dev";
const expected = process.env.TT_QA_ID;
assert.match(expected ?? "", /^[a-f0-9-]{36}$/i);
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
async function api(path, data, bearer, expectedStatus = 200) {
  const response = await fetch(origin + path, {
    method: data === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  assert.equal(response.status, expectedStatus, path.split("?")[0]);
  return response.json();
}
let finish;
const callback = new Promise((resolve, reject) => {
  finish = { resolve, reject };
});
let received = false;
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (
    req.method !== "GET" ||
    u.pathname !== "/auth/callback" ||
    !u.searchParams.get("insforge_code") ||
    received
  ) {
    res.writeHead(404).end();
    return;
  }
  received = true;
  res
    .writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    })
    .end("TokenTracker QA received the callback. You can close this tab.");
  finish.resolve(u.searchParams.get("insforge_code"));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const timer = setTimeout(
  () => finish.reject(new Error("Provider login timed out")),
  9 * 60_000,
);
try {
  const redirect =
    "http://127.0.0.1:" + server.address().port + "/auth/callback";
  const config = await api("/api/auth/public-config");
  assert.ok(
    config.oAuthProviders.includes(provider),
    "Provider binding is not advertised",
  );
  const { authUrl } = await api(
    "/api/auth/oauth/" +
      provider +
      "?" +
      new URLSearchParams({
        redirect_uri: redirect,
        code_challenge: challenge,
      }),
  );
  assert.equal(new URL(authUrl).origin, origin);
  await new Promise((resolve, reject) =>
    execFile("open", [authUrl], (e) => (e ? reject(e) : resolve())),
  );
  console.log("Waiting for " + provider + " consent in the browser");
  const code = await callback;
  const exchange = () =>
    api("/api/auth/oauth/exchange?client_type=mobile", {
      code,
      code_verifier: verifier,
    });
  const old = await exchange();
  assert.equal(old.user.id, expected);
  const user = await api(
    "/api/auth/sessions/current",
    undefined,
    old.accessToken,
  );
  assert.equal(user.user.id, expected);
  await api(
    "/api/auth/oauth/exchange?client_type=mobile",
    { code, code_verifier: verifier },
    null,
    401,
  );
  const next = await api("/api/auth/refresh?client_type=mobile", {
    refresh_token: old.refreshToken,
  });
  assert.equal(next.user.id, expected);
  await api("/api/auth/logout?client_type=mobile", {
    refresh_token: next.refreshToken,
  });
  await api("/api/auth/sessions/current", undefined, next.accessToken, 401);
  const receipt = {
    provider,
    verified_at: new Date().toISOString(),
    original_id: true,
    current_user: true,
    pkce_single_use: true,
    refresh: true,
    logout: true,
  };
  if (process.env.TT_QA_RECEIPT)
    writeFileSync(process.env.TT_QA_RECEIPT, JSON.stringify(receipt), {
      mode: 0o600,
    });
  console.log(JSON.stringify(receipt));
} finally {
  clearTimeout(timer);
  server.close();
  server.closeAllConnections();
}
