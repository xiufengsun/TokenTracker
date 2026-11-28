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
  dedupeKeyFetch = null,
  nowMs = Date.now(),
} = {}) {
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    const err = new Error("Claude refresh skipped: no refresh_token available");
    err.code = "NO_REFRESH_TOKEN";
    throw err;
  }

  const cleanRefreshToken = sanitizeAsciiToken(refreshToken, "refreshToken");
  const singleflightBucket = dedupeKeyFetch || fetchImpl;
  let tokenMap = inflightRefreshesByFetch.get(singleflightBucket);
  if (!tokenMap) {
    tokenMap = new Map();
    inflightRefreshesByFetch.set(singleflightBucket, tokenMap);
  }
  const existing = tokenMap.get(cleanRefreshToken);
  if (existing) {
    return existing;
  }

  const run = (async () => {
    const cleanScopes = sanitizeScopes(scopes);
    const scopeStr = cleanScopes && cleanScopes.length > 0
      ? cleanScopes.join(" ")
      : typeof scopes === "string" && scopes.trim().length > 0
        ? sanitizeScopes(scopes.trim().split(/\s+/))?.join(" ") || CLAUDE_DEFAULT_SCOPES.join(" ")
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
        refresh_token: cleanRefreshToken,
        client_id: sanitizeAsciiToken(clientId, "clientId"),
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
      if (res.status === 400 && String(detail || "").toLowerCase() === "invalid_scope") {
        const err = new Error(`Claude token refresh failed: ${res.status} (invalid_scope)`);
        err.code = "REFRESH_HTTP_ERROR";
        err.status = res.status;
        err.detail = detail;
        throw err;
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

    return sanitizeClaudeTokens({
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? body.refresh_token
        : cleanRefreshToken,
      expiresAt,
      refreshTokenExpiresAt,
      scopes: typeof body.scope === "string"
        ? body.scope.split(" ").filter(Boolean)
        : Array.isArray(scopes) ? scopes : CLAUDE_DEFAULT_SCOPES,
    });
  })();

  tokenMap.set(cleanRefreshToken, run);
  try {
    return await run;
  } finally {
    if (tokenMap.get(cleanRefreshToken) === run) {
      tokenMap.delete(cleanRefreshToken);
    }
  }
}

// In-process singleflight map keyed by base fetchImpl (so production calls using global
// fetch deduplicate concurrent refreshes per refreshToken, while isolated test mocks don't collide).
const inflightRefreshesByFetch = new WeakMap();

function sanitizeAsciiToken(value, label) {
  if (typeof value !== "string") {
    throw new Error(`Invalid Claude ${label}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) {
    throw new Error(`Invalid Claude ${label}`);
  }
  const codes = new Array(trimmed.length);
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) {
      throw new Error(`Invalid Claude ${label}`);
    }
    codes[i] = code;
  }
  return String.fromCharCode(...codes);
}

function sanitizeScopes(scopes) {
  if (!Array.isArray(scopes)) return null;
  const out = [];
  for (const s of scopes) {
    if (typeof s !== "string" || s.length === 0 || s.length > 128) continue;
    if (!/^[a-zA-Z0-9:_.-]+$/.test(s)) continue;
    out.push(sanitizeAsciiToken(s, "scope"));
  }
  return out;
}

function sanitizeClaudeTokens(newTokens) {
  if (!newTokens || typeof newTokens !== "object") {
    throw new Error("Invalid Claude token payload");
  }
  const accessToken = sanitizeAsciiToken(newTokens.accessToken, "accessToken");
  const refreshToken = sanitizeAsciiToken(newTokens.refreshToken, "refreshToken");
  const expiresAt = Number(newTokens.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new Error("Invalid Claude expiresAt");
  }
  const refreshTokenExpiresAt =
    newTokens.refreshTokenExpiresAt != null && Number.isFinite(Number(newTokens.refreshTokenExpiresAt))
      ? Number(newTokens.refreshTokenExpiresAt)
      : null;
  const scopes = sanitizeScopes(newTokens.scopes);

  return {
    accessToken,
    refreshToken,
    expiresAt,
    refreshTokenExpiresAt,
    scopes,
  };
}

function readLatestStoredClaudePayload({
  platform,
  service,
  account,
  credPath,
  securityRunner,
}) {
  if (platform === "darwin") {
    const runner = typeof securityRunner === "function" ? securityRunner : cp.spawnSync;
    const res = runner("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      encoding: "utf8",
    });
    if (!res || res.error || res.status !== 0) return null;
    const stdout = typeof res.stdout === "string"
      ? res.stdout
      : Buffer.isBuffer(res.stdout)
        ? res.stdout.toString("utf8")
        : "";
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_e) {
      return null;
    }
  }

  try {
    const raw = fs.readFileSync(credPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_e) {
    return null;
  }
}

async function persistRefreshedClaudeAuth({
  currentPayload,
  newTokens,
  expectedRefreshToken,
  platform = process.platform,
  service = "Claude Code-credentials",
  account,
  credentialsPath,
  home,
  env = process.env,
  securityRunner,
} = {}) {
  const sanitized = sanitizeClaudeTokens(newTokens);
  const acct = platform === "darwin" ? (account || resolveClaudeKeychainAccount({ env })) : null;
  const credPath = platform !== "darwin"
    ? (credentialsPath || path.join(typeof home === "string" && home ? home : os.homedir(), ".claude", ".credentials.json"))
    : null;

  // Reread stored credentials immediately before writing so we do not overwrite
  // another account's login or an already-rotated token written concurrently.
  const latestPayload = readLatestStoredClaudePayload({
    platform,
    service,
    account: acct,
    credPath,
    securityRunner,
  });
  const capturedRefreshToken =
    (typeof expectedRefreshToken === "string" && expectedRefreshToken) ||
    (typeof currentPayload?.claudeAiOauth?.refreshToken === "string" ? currentPayload.claudeAiOauth.refreshToken : null);
  const latestRefreshToken =
    typeof latestPayload?.claudeAiOauth?.refreshToken === "string" ? latestPayload.claudeAiOauth.refreshToken : null;

  if (capturedRefreshToken) {
    if (platform !== "darwin" && !fs.existsSync(credPath)) {
      return null;
    }
    if (latestPayload && latestRefreshToken !== capturedRefreshToken) {
      return latestPayload;
    }
  }

  const basePayload = latestPayload || (currentPayload && typeof currentPayload === "object" ? currentPayload : {});
  const baseOauth = (basePayload.claudeAiOauth && typeof basePayload.claudeAiOauth === "object")
    ? basePayload.claudeAiOauth
    : {};
  const merged = {
    ...basePayload,
    claudeAiOauth: {
      ...baseOauth,
      accessToken: sanitized.accessToken,
      refreshToken: sanitized.refreshToken,
      expiresAt: sanitized.expiresAt,
      ...(sanitized.refreshTokenExpiresAt ? { refreshTokenExpiresAt: sanitized.refreshTokenExpiresAt } : {}),
      ...(sanitized.scopes ? { scopes: sanitized.scopes } : {}),
    },
  };
  const serialized = JSON.stringify(merged, null, platform === "darwin" ? 0 : 2);

  if (platform === "darwin") {
    const runner = typeof securityRunner === "function" ? securityRunner : cp.spawnSync;
    const result = runner("security", [
      "add-generic-password",
      "-s",
      service,
      "-a",
      acct,
      "-w",
      serialized,
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
  await fs.promises.mkdir(path.dirname(credPath), { recursive: true });
  const tmp = `${credPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.promises.writeFile(tmp, serialized, { mode: 0o600, flag: "wx" });
    await fs.promises.rename(tmp, credPath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
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
