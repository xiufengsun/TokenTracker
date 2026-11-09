const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const { resolveClaudeKeychainAccount } = require("./subscriptions");

// Public Claude Code OAuth client. Same endpoint and client_id used by the official `claude` CLI.
const CLAUDE_REFRESH_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_DEFAULT_SCOPES = [
  "user:file_upload",
  "user:inference",
  "user:mcp_servers",
  "user:plugins",
  "user:profile",
  "user:sessions:claude_code",
];
const CLAUDE_AUTH_EXPIRED_MESSAGE = "Claude token expired — run `claude` once to refresh.";

// Refresh access tokens within 5 minutes of expiration, matching Codex refresh strategy.
const CLAUDE_ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

function isClaudeTokenStale(authBundle, nowMs = Date.now()) {
  if (!authBundle) return true;
  if (!authBundle.accessToken) return true;

  const exp = typeof authBundle.expiresAtMs === "number"
    ? authBundle.expiresAtMs
    : typeof authBundle.expiresAt === "number"
      ? authBundle.expiresAt
      : null;

  if (exp !== null && Number.isFinite(exp)) {
    return exp <= nowMs + CLAUDE_ACCESS_TOKEN_REFRESH_WINDOW_MS;
  }
  return false;
}

async function refreshClaudeTokens({
  refreshToken,
  scopes = CLAUDE_DEFAULT_SCOPES,
  clientId = CLAUDE_CLIENT_ID,
  fetchImpl = fetch,
  nowMs = Date.now(),
} = {}) {
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    const err = new Error("Claude refresh skipped: no refresh_token available");
    err.code = "NO_REFRESH_TOKEN";
    throw err;
  }

  const scopeStr = Array.isArray(scopes) && scopes.length > 0
    ? scopes.join(" ")
    : typeof scopes === "string" && scopes.trim().length > 0
      ? scopes
      : CLAUDE_DEFAULT_SCOPES.join(" ");

  const res = await fetchImpl(CLAUDE_REFRESH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Claude-Code/2.1.317",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken.trim(),
      client_id: clientId,
      scope: scopeStr,
    }),
  });

  if (res.status === 400 || res.status === 401) {
    let detail = null;
    try {
      const data = await res.json();
      detail = data?.error || data?.error_description || null;
    } catch (_e) {
      // Ignore parse failure
    }
    const err = new Error(CLAUDE_AUTH_EXPIRED_MESSAGE);
    err.code = "REFRESH_TOKEN_EXPIRED";
    err.status = res.status;
    err.detail = detail;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`Claude token refresh failed: ${res.status}`);
    err.code = "REFRESH_HTTP_ERROR";
    err.status = res.status;
    throw err;
  }

  const body = await res.json();
  if (!body || typeof body.access_token !== "string" || body.access_token.length === 0) {
    const err = new Error("Claude token refresh response missing access_token");
    err.code = "REFRESH_INVALID_RESPONSE";
    throw err;
  }

  const expiresInSec = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 28800;
  const refreshExpiresInSec = typeof body.refresh_token_expires_in === "number" && body.refresh_token_expires_in > 0
    ? body.refresh_token_expires_in
    : null;

  const expiresAt = nowMs + expiresInSec * 1000;
  const refreshTokenExpiresAt = refreshExpiresInSec ? nowMs + refreshExpiresInSec * 1000 : null;

  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : refreshToken,
    expiresAt,
    refreshTokenExpiresAt,
    scopes: typeof body.scope === "string"
      ? body.scope.split(" ").filter(Boolean)
      : Array.isArray(scopes) ? scopes : CLAUDE_DEFAULT_SCOPES,
  };
}

async function persistRefreshedClaudeAuth({
  currentPayload,
  newTokens,
  platform = process.platform,
  service = "Claude Code-credentials",
  account,
  credentialsPath,
  home,
  env = process.env,
  securityRunner,
} = {}) {
  const baseOauth = (currentPayload && typeof currentPayload === "object" && currentPayload.claudeAiOauth) || {};
  const merged = {
    ...(currentPayload && typeof currentPayload === "object" ? currentPayload : {}),
    claudeAiOauth: {
      ...baseOauth,
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      expiresAt: newTokens.expiresAt,
      ...(newTokens.refreshTokenExpiresAt ? { refreshTokenExpiresAt: newTokens.refreshTokenExpiresAt } : {}),
      ...(newTokens.scopes ? { scopes: newTokens.scopes } : {}),
    },
  };

  if (platform === "darwin") {
    const runner = typeof securityRunner === "function" ? securityRunner : cp.spawnSync;
    const acct = account || resolveClaudeKeychainAccount({ env });
    const result = runner("security", [
      "add-generic-password",
      "-s",
      service,
      "-a",
      acct,
      "-w",
      JSON.stringify(merged),
      "-U",
    ], {
      stdio: "ignore",
      timeout: 3000,
    });
    if (result && result.error) throw result.error;
    if (result && typeof result.status === "number" && result.status !== 0) {
      throw new Error(`security add-generic-password failed with exit code ${result.status}`);
    }
    return merged;
  }

  // Linux / Windows
  const credPath = credentialsPath || path.join(typeof home === "string" && home ? home : os.homedir(), ".claude", ".credentials.json");
  await fs.promises.mkdir(path.dirname(credPath), { recursive: true });
  const tmp = `${credPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await fs.promises.rename(tmp, credPath);
  return merged;
}

module.exports = {
  CLAUDE_REFRESH_ENDPOINT,
  CLAUDE_CLIENT_ID,
  CLAUDE_DEFAULT_SCOPES,
  CLAUDE_AUTH_EXPIRED_MESSAGE,
  CLAUDE_ACCESS_TOKEN_REFRESH_WINDOW_MS,
  isClaudeTokenStale,
  refreshClaudeTokens,
  persistRefreshedClaudeAuth,
};
