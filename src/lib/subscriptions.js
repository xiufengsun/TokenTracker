const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const cp = require("node:child_process");

const { readJson } = require("./fs");
const { resolveTrackerPaths } = require("./tracker-paths");
const { probeOpenclawSessionPluginState } = require("./openclaw-session-plugin");

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const MACOS_SECURITY_BIN = "/usr/bin/security";
const CLAUDE_CODE_KEYCHAIN_SERVICES = ["Claude Code-credentials"];
// On Linux and Windows, Claude Code persists the same OAuth payload as a plain
// JSON file instead of the macOS Keychain — at ~/.claude/.credentials.json on
// Linux and %USERPROFILE%\.claude\.credentials.json on Windows (both resolve via
// os.homedir()). The payload shape is identical:
// { claudeAiOauth: { accessToken, subscriptionType, ... } }
const CLAUDE_CODE_CREDENTIALS_FILE = ".credentials.json";
// Platforms where Claude Code stores credentials in the plain JSON file above
// rather than the macOS Keychain.
const CLAUDE_CODE_CREDENTIALS_FILE_PLATFORMS = new Set(["linux", "win32"]);
// Refresh slightly before wall-clock expiry so Limits does not spend a request
// that Anthropic answers with 429 for a real-but-expired Claude Code token.
const CLAUDE_TOKEN_EXPIRY_SKEW_MS = 60_000;

function usesClaudeCodeCredentialsFile(platform) {
  return CLAUDE_CODE_CREDENTIALS_FILE_PLATFORMS.has(platform);
}

function normalizeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeScalarToString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return normalizeString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return normalizeString(String(value));
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

function base64UrlDecodeToString(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const padLen = (4 - (value.length % 4)) % 4;
  const padded = value + "=".repeat(padLen);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(base64, "base64").toString("utf8");
  } catch (_e) {
    return null;
  }
}

function decodeJwtPayload(token) {
  const jwt = normalizeString(token);
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const decoded = base64UrlDecodeToString(parts[1]);
  if (!decoded) return null;
  try {
    return JSON.parse(decoded);
  } catch (_e) {
    return null;
  }
}

function extractOpenAiAuthNamespace(payload) {
  if (!payload || typeof payload !== "object") return null;
  const ns = payload[OPENAI_AUTH_CLAIM];
  if (!ns || typeof ns !== "object" || Array.isArray(ns)) return null;
  return ns;
}

function extractChatgptSubscriptionFromPayload(payload) {
  const ns = extractOpenAiAuthNamespace(payload);
  if (!ns) return null;

  const planType = normalizeString(ns.chatgpt_plan_type);
  const activeStart = normalizeString(ns.chatgpt_subscription_active_start);
  const activeUntil = normalizeString(ns.chatgpt_subscription_active_until);
  const lastChecked = normalizeString(ns.chatgpt_subscription_last_checked);

  if (!planType && !activeStart && !activeUntil && !lastChecked) return null;
  return { planType, activeStart, activeUntil, lastChecked };
}

function mergeSubscription(primary, secondary) {
  if (!primary && !secondary) return null;
  const a = primary || {};
  const b = secondary || {};
  return {
    planType: a.planType || b.planType || null,
    activeStart: a.activeStart || b.activeStart || null,
    activeUntil: a.activeUntil || b.activeUntil || null,
    lastChecked: a.lastChecked || b.lastChecked || null,
  };
}

function isDisplayablePlanType(planType) {
  const normalized = normalizeString(planType);
  if (!normalized) return false;
  const v = normalized.toLowerCase();
  if (v === "free" || v === "none" || v === "unknown") return false;
  return true;
}

function resolveCodexHome({ home, env }) {
  const explicit = normalizeString(env?.CODEX_HOME);
  return explicit ? path.resolve(explicit) : path.join(home, ".codex");
}

function resolveOpencodeDataDir({ home, env }) {
  const explicit = normalizeString(env?.XDG_DATA_HOME);
  const base = explicit ? path.resolve(explicit) : path.join(home, ".local", "share");
  return path.join(base, "opencode");
}

async function detectCodexChatgptSubscription({ home, env }) {
  const codexHome = resolveCodexHome({ home, env });
  const authPath = path.join(codexHome, "auth.json");
  const auth = await readJson(authPath);
  if (!auth || typeof auth !== "object") return null;

  const accessPayload = decodeJwtPayload(auth?.tokens?.access_token);
  const idPayload = decodeJwtPayload(auth?.tokens?.id_token);

  const accessInfo = extractChatgptSubscriptionFromPayload(accessPayload);
  const idInfo = extractChatgptSubscriptionFromPayload(idPayload);
  const merged = mergeSubscription(accessInfo, idInfo);
  if (!merged || !isDisplayablePlanType(merged.planType)) return null;

  return {
    tool: "codex",
    provider: "openai",
    product: "chatgpt",
    planType: merged.planType,
    activeStart: merged.activeStart,
    activeUntil: merged.activeUntil,
    lastChecked: merged.lastChecked,
  };
}

async function detectOpencodeChatgptSubscription({ home, env }) {
  const dataDir = resolveOpencodeDataDir({ home, env });
  const authPath = path.join(dataDir, "auth.json");
  const auth = await readJson(authPath);
  if (!auth || typeof auth !== "object") return null;

  const accessPayload = decodeJwtPayload(auth?.openai?.access);
  const info = extractChatgptSubscriptionFromPayload(accessPayload);
  if (!info || !isDisplayablePlanType(info.planType)) return null;

  return {
    tool: "opencode",
    provider: "openai",
    product: "chatgpt",
    planType: info.planType,
    activeStart: info.activeStart,
    activeUntil: info.activeUntil,
    lastChecked: info.lastChecked,
  };
}

// Match Claude Code 2.1.267's account derivation. A service-only lookup may
// select credentials from an older installation before the current account.
function resolveClaudeKeychainAccount({ env = process.env, userInfo = os.userInfo } = {}) {
  let account;
  try { account = env.USER || userInfo().username; } catch (_error) { return "claude-code-user"; }
  return typeof account === "string" && /^[a-zA-Z0-9._-]+$/.test(account)
    ? account : "claude-code-user";
}

function probeMacosKeychainGenericPassword({ service, securityRunner, timeoutMs, env } = {}) {
  const svc = normalizeString(service);
  if (!svc) return false;

  const runner = typeof securityRunner === "function" ? securityRunner : cp.spawnSync;
  if (runner === cp.spawnSync && !fs.existsSync(MACOS_SECURITY_BIN)) return false;

  const result = runner(MACOS_SECURITY_BIN, ["find-generic-password", "-s", svc, "-a", resolveClaudeKeychainAccount({ env })], {
    stdio: "ignore",
    timeout: Number.isFinite(timeoutMs) ? timeoutMs : 2000,
  });

  if (!result || result.error) return false;
  return result.status === 0;
}

function readMacosKeychainPassword({ service, securityRunner, timeoutMs, env } = {}) {
  const svc = normalizeString(service);
  if (!svc) return null;

  const runner = typeof securityRunner === "function" ? securityRunner : cp.spawnSync;
  if (runner === cp.spawnSync && !fs.existsSync(MACOS_SECURITY_BIN)) return null;

  const result = runner(MACOS_SECURITY_BIN, ["find-generic-password", "-s", svc, "-a", resolveClaudeKeychainAccount({ env }), "-w"], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: Number.isFinite(timeoutMs) ? timeoutMs : 2000,
    encoding: "utf8",
  });

  if (!result || result.error) return null;
  if (result.status !== 0) return null;

  const stdout =
    typeof result.stdout === "string"
      ? result.stdout
      : Buffer.isBuffer(result.stdout)
        ? result.stdout.toString("utf8")
        : "";
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readClaudeCodeCredentialsFile({ home, fsReader } = {}) {
  const homeDir = typeof home === "string" && home ? home : os.homedir();
  const credPath = path.join(homeDir, ".claude", CLAUDE_CODE_CREDENTIALS_FILE);
  const reader = typeof fsReader === "function" ? fsReader : fs.readFileSync;
  try {
    return reader(credPath, "utf8");
  } catch (_e) {
    return null;
  }
}

function detectClaudeCodeCredentialsPresence({ platform = process.platform, securityRunner, home, fsReader, env } = {}) {
  if (platform === "darwin") {
    for (const service of CLAUDE_CODE_KEYCHAIN_SERVICES) {
      const present = probeMacosKeychainGenericPassword({
        service,
        securityRunner,
        env,
      });
      if (!present) continue;

      // Existence-only probe: do not read secrets or infer paid tier.
      return {
        tool: "claude",
        provider: "anthropic",
        product: "credentials",
        planType: "present",
      };
    }
    return null;
  }

  if (!usesClaudeCodeCredentialsFile(platform)) return null;

  // Linux/Windows: credentials live in the .credentials.json file (mode 0600 on
  // Linux; user-profile ACLs on Windows). Existence-only: just check that the
  // file is readable and contains the OAuth key.
  const raw = readClaudeCodeCredentialsFile({ home, fsReader });
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    if (payload?.claudeAiOauth && typeof payload.claudeAiOauth === "object") {
      return {
        tool: "claude",
        provider: "anthropic",
        product: "credentials",
        planType: "present",
      };
    }
  } catch (_e) {
    // fall through
  }
  return null;
}

function parseClaudeOauthExpiryMs(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (value <= 0) return 0;
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return parseClaudeOauthExpiryMs(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function extractClaudeCodeOauth(payload, nowMs = Date.now()) {
  const oauth = payload?.claudeAiOauth;
  const accessToken = normalizeString(oauth?.accessToken);
  if (!accessToken) return null;
  const expiresAtMs = parseClaudeOauthExpiryMs(oauth?.expiresAt);
  if (expiresAtMs != null && expiresAtMs <= nowMs + CLAUDE_TOKEN_EXPIRY_SKEW_MS) return null;
  return { accessToken, expiresAtMs };
}

function extractClaudeKeychainSubscription(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const oauth = payload.claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return null;

  const subscriptionType = normalizeScalarToString(oauth.subscriptionType);
  const rateLimitTier = normalizeScalarToString(oauth.rateLimitTier);

  if (!subscriptionType) return null;
  return { subscriptionType, rateLimitTier };
}

function detectClaudeCodeSubscriptionDetails({ platform = process.platform, securityRunner, home, fsReader, env } = {}) {
  const rawPayloads = [];
  if (platform === "darwin") {
    for (const service of CLAUDE_CODE_KEYCHAIN_SERVICES) {
      const raw = readMacosKeychainPassword({ service, securityRunner, env });
      if (raw) rawPayloads.push(raw);
    }
  } else if (usesClaudeCodeCredentialsFile(platform)) {
    const raw = readClaudeCodeCredentialsFile({ home, fsReader });
    if (raw) rawPayloads.push(raw);
  } else {
    return null;
  }

  for (const raw of rawPayloads) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_e) {
      continue;
    }

    const info = extractClaudeKeychainSubscription(payload);
    if (!info) continue;

    return {
      tool: "claude",
      provider: "anthropic",
      product: "subscription",
      planType: info.subscriptionType,
      rateLimitTier: info.rateLimitTier,
    };
  }

  return null;
}

async function collectLocalSubscriptions({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  securityRunner,
  probeKeychain = false,
  probeKeychainDetails = false,
} = {}) {
  const out = [];

  const codex = await detectCodexChatgptSubscription({ home, env });
  if (codex) out.push(codex);

  const opencode = await detectOpencodeChatgptSubscription({ home, env });
  if (opencode) out.push(opencode);

  if (probeKeychainDetails) {
    const claude = detectClaudeCodeSubscriptionDetails({ platform, securityRunner, home, env });
    if (claude) out.push(claude);
    else if (probeKeychain) {
      const present = detectClaudeCodeCredentialsPresence({ platform, securityRunner, home, env });
      if (present) out.push(present);
    }
  } else if (probeKeychain) {
    const claude = detectClaudeCodeCredentialsPresence({ platform, securityRunner, home, env });
    if (claude) out.push(claude);
  }

  const openclaw = await detectOpenclawSessionIntegration({ home, env });
  if (openclaw) out.push(openclaw);

  // Gemini: no stable local subscription/tier signal found yet.
  return out;
}

async function detectOpenclawSessionIntegration({ home, env }) {
  const { trackerDir } = await resolveTrackerPaths({ home });
  let state = null;
  try {
    state = await probeOpenclawSessionPluginState({ home, trackerDir, env });
  } catch (_err) {
    return null;
  }

  if (!state?.configured) return null;

  return {
    tool: "openclaw",
    provider: "openclaw",
    product: "session_plugin",
    planType: "enabled",
  };
}

// Returns the live OAuth token plus its expiry stamp. The expiry doubles as a
// rotation marker for the 429 cool-down: it changes on every refresh and, unlike
// the token itself, is not a secret, so nothing derived from a credential has to
// be written to disk.
function readClaudeCodeOauthToken({
  platform = process.platform,
  securityRunner,
  home,
  fsReader,
  env,
  nowMs = Date.now(),
} = {}) {
  if (platform === "darwin") {
    for (const service of CLAUDE_CODE_KEYCHAIN_SERVICES) {
      try {
        const raw = readMacosKeychainPassword({ service, securityRunner, env });
        if (!raw) continue;
        const oauth = extractClaudeCodeOauth(JSON.parse(raw), nowMs);
        if (oauth) return oauth;
      } catch (_e) {
        continue;
      }
    }
    return null;
  }

  if (!usesClaudeCodeCredentialsFile(platform)) return null;

  // Linux/Windows: Claude Code stores the OAuth payload as a JSON file
  // (mode 0600 on Linux; user-profile ACLs on Windows).
  const raw = readClaudeCodeCredentialsFile({ home, fsReader });
  if (!raw) return null;
  try {
    return extractClaudeCodeOauth(JSON.parse(raw), nowMs);
  } catch (_e) {
    return null;
  }
}

function readClaudeCodeAccessToken(options = {}) {
  return readClaudeCodeOauthToken(options)?.accessToken ?? null;
}

// Returns the full Claude Code auth bundle (access token, refresh token, expiry, scopes,
// keychain service / file path, raw payload) so callers can detect staleness and trigger
// an automatic token refresh before expiration.
function readClaudeCodeAuthBundle({
  platform = process.platform,
  securityRunner,
  home,
  fsReader,
  env,
  nowMs = Date.now(),
} = {}) {
  const account = resolveClaudeKeychainAccount({ env });
  if (platform === "darwin") {
    for (const service of CLAUDE_CODE_KEYCHAIN_SERVICES) {
      try {
        const raw = readMacosKeychainPassword({ service, securityRunner, env });
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const oauth = parsed?.claudeAiOauth;
        if (!oauth || typeof oauth !== "object") continue;

        const accessToken = normalizeString(oauth?.accessToken);
        const refreshToken = normalizeString(oauth?.refreshToken);
        if (!accessToken && !refreshToken) continue;

        const expiresAtMs = parseClaudeOauthExpiryMs(oauth?.expiresAt);
        const refreshTokenExpiresAtMs = parseClaudeOauthExpiryMs(oauth?.refreshTokenExpiresAt);
        const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes : [];
        const subscriptionType = normalizeScalarToString(oauth?.subscriptionType);
        const rateLimitTier = normalizeScalarToString(oauth?.rateLimitTier);

        return {
          accessToken,
          refreshToken,
          expiresAtMs,
          refreshTokenExpiresAtMs,
          scopes,
          subscriptionType,
          rateLimitTier,
          service,
          account,
          rawPayload: parsed,
          platform,
        };
      } catch (_e) {
        continue;
      }
    }
    return null;
  }

  if (!usesClaudeCodeCredentialsFile(platform)) return null;

  const credPath = path.join(typeof home === "string" && home ? home : os.homedir(), ".claude", CLAUDE_CODE_CREDENTIALS_FILE);
  const raw = readClaudeCodeCredentialsFile({ home, fsReader });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth || typeof oauth !== "object") return null;

    const accessToken = normalizeString(oauth?.accessToken);
    const refreshToken = normalizeString(oauth?.refreshToken);
    if (!accessToken && !refreshToken) return null;

    const expiresAtMs = parseClaudeOauthExpiryMs(oauth?.expiresAt);
    const refreshTokenExpiresAtMs = parseClaudeOauthExpiryMs(oauth?.refreshTokenExpiresAt);
    const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes : [];
    const subscriptionType = normalizeScalarToString(oauth?.subscriptionType);
    const rateLimitTier = normalizeScalarToString(oauth?.rateLimitTier);

    return {
      accessToken,
      refreshToken,
      expiresAtMs,
      refreshTokenExpiresAtMs,
      scopes,
      subscriptionType,
      rateLimitTier,
      credentialsPath: credPath,
      rawPayload: parsed,
      platform,
    };
  } catch (_e) {
    return null;
  }
}

async function readCodexAccessToken({ home, env } = {}) {
  try {
    const codexHome = resolveCodexHome({ home, env });
    const authPath = path.join(codexHome, "auth.json");
    const auth = await readJson(authPath);
    return normalizeString(auth?.tokens?.access_token);
  } catch (_e) {
    return null;
  }
}

// Returns the access token + ChatGPT account id + plan type + auth.json path so callers can
// also trigger a refresh if the tokens are stale (issue #52: stale tokens → wham 401 →
// "Fetch failed" error after ~7-8 days of not running `codex`).
async function readCodexAuthBundle({ home, env } = {}) {
  try {
    const codexHome = resolveCodexHome({ home, env });
    const authPath = path.join(codexHome, "auth.json");
    const auth = await readJson(authPath);
    if (!auth || typeof auth !== "object") return null;

    const accessToken = normalizeString(auth?.tokens?.access_token);
    if (!accessToken) return null;

    const accessPayload = decodeJwtPayload(auth?.tokens?.access_token);
    const idPayload = decodeJwtPayload(auth?.tokens?.id_token);
    const accountId =
      normalizeString(auth?.tokens?.account_id) ||
      normalizeString(extractOpenAiAuthNamespace(accessPayload)?.chatgpt_account_id) ||
      normalizeString(extractOpenAiAuthNamespace(idPayload)?.chatgpt_account_id) ||
      null;

    const accessInfo = extractChatgptSubscriptionFromPayload(accessPayload);
    const idInfo = extractChatgptSubscriptionFromPayload(idPayload);
    const merged = mergeSubscription(accessInfo, idInfo);
    const planType = merged?.planType ? merged.planType.toLowerCase() : null;

    return {
      accessToken,
      accountId,
      planType,
      refreshToken: normalizeString(auth?.tokens?.refresh_token) || null,
      lastRefresh: normalizeString(auth?.last_refresh) || null,
      authPath,
      authJson: auth,
    };
  } catch (_e) {
    return null;
  }
}

module.exports = {
  CLAUDE_TOKEN_EXPIRY_SKEW_MS,
  parseClaudeOauthExpiryMs,
  resolveClaudeKeychainAccount,
  collectLocalSubscriptions,
  detectClaudeCodeCredentialsPresence,
  detectClaudeCodeSubscriptionDetails,
  readClaudeCodeAccessToken,
  readClaudeCodeAuthBundle,
  readClaudeCodeOauthToken,
  readCodexAccessToken,
  readCodexAuthBundle,
};
