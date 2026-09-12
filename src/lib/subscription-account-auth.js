const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { accountPaths, readOptionalJson } = require("./subscription-accounts");

function decode(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
  catch { return {}; }
}

function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function fingerprint(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

async function readAccountAuth({ trackerDir, account, platform = process.platform, keychainReader, interactive = false, includeCredentials = false,
  sourceHome, sourceConfig, sourceService }) {
  const runtimeHome = sourceHome || accountPaths(trackerDir, account.id).runtimeHome;
  if (account.provider === "codex") {
    const auth = await readOptionalJson(path.join(runtimeHome, "auth.json"));
    const tokens = auth?.tokens;
    const accessToken = text(tokens?.access_token);
    if (!accessToken || auth?.auth_mode === "apikey" || auth?.OPENAI_API_KEY) return null;
    const access = decode(accessToken);
    const id = decode(tokens?.id_token);
    const ns = { ...access["https://api.openai.com/auth"], ...id["https://api.openai.com/auth"] };
    const accountId = text(tokens?.account_id) || text(ns.chatgpt_account_id);
    if (!accountId) return null;
    const userId = text(ns.chatgpt_user_id) || text(id.sub) || text(access.sub);
    const email = text(id.email) || text(access["https://api.openai.com/profile"]?.email);
    return { ...(includeCredentials ? { credentialData: auth } : {}), accessToken, accountId, expiresAt: Number(access.exp) * 1000 || null,
      fingerprint: fingerprint(accessToken), identity: {
        key: fingerprint(JSON.stringify([accountId, userId])), email, plan: text(ns.chatgpt_plan_type),
        subscriptionEndsAt: text(ns.chatgpt_subscription_active_until),
      } };
  }
  const config = await readOptionalJson(sourceConfig || path.join(runtimeHome, ".claude.json"));
  const oauth = config?.oauthAccount;
  const accountId = text(oauth?.accountUuid);
  const org = text(oauth?.organizationUuid);
  if (!accountId) return null;
  let credentials = await readOptionalJson(path.join(runtimeHome, ".credentials.json"));
  // Explicit opt-in, exact account-specific service only. No global fallback.
  if (platform === "darwin" && account.allowKeychain) {
    const canonical = await fs.realpath(runtimeHome);
    const service = sourceService || `Claude Code-credentials-${fingerprint(canonical.normalize("NFC")).slice(0, 8)}`;
    let user;
    try { user = process.env.USER || os.userInfo().username; } catch { user = "claude-code-user"; }
    if (!/^[a-zA-Z0-9._-]+$/.test(user)) user = "claude-code-user";
    try {
      const result = keychainReader
        ? { value: (await keychainReader("/usr/bin/security", ["find-generic-password", "-s", service, "-a", user, "-w"], { timeout: 3000, maxBuffer: 64 * 1024, encoding: "utf8" })).stdout }
        : await require("./subscription-keychain").keychainOperation({ service, account: user, interactive });
      if (result.value) {
        const stored = JSON.parse(result.value);
        // A verified refresh copied from the shared login can be newer than
        // the isolated Keychain item. Never replace it with the older token.
        if (!credentials?.claudeAiOauth?.accessToken || Number(stored?.claudeAiOauth?.expiresAt || 0) >= Number(credentials?.claudeAiOauth?.expiresAt || 0)) credentials = stored;
      }
    } catch { /* A missing/locked scoped item never authorizes a global lookup. */ }
  }
  const token = credentials?.claudeAiOauth;
  const accessToken = text(token?.accessToken);
  return { ...(includeCredentials ? { credentialData: credentials, oauthAccount: oauth } : {}), accessToken, accountId, expiresAt: Number(token?.expiresAt) || null,
    fingerprint: accessToken ? fingerprint(accessToken) : null,
    identity: { key: fingerprint(JSON.stringify([accountId, org])), email: text(oauth.emailAddress),
      plan: text(token?.subscriptionType), subscriptionEndsAt: null } };
}

function identityMatches(account, auth) {
  return Boolean(!account.invalidatedAt && account.identity?.key && auth?.identity?.key === account.identity.key);
}

// Isolated subscription launches must not inherit credentials or alternative backends.
function accountEnvironment(account, runtimeHome, inherited = process.env) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|OPENAI_|AZURE_OPENAI_|CLAUDE_CODE_|CLAUDECODE$|CODEX_|AWS_BEARER_TOKEN_BEDROCK$|CLAUDE_CONFIG_DIR$|CLAUDE_CONFIG_PATH$|CLAUDE_SECURESTORAGE_CONFIG_DIR$)/i.test(key)) delete env[key];
  }
  env[account.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = runtimeHome;
  if (account.provider === "claude") env.CLAUDE_SECURESTORAGE_CONFIG_DIR = runtimeHome;
  return env;
}

module.exports = { readAccountAuth, identityMatches, accountEnvironment };
