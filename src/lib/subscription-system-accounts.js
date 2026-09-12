const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { return null; }
}
function decode(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
  catch { return {}; }
}
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

// Discovery is read-only: provider-owned config files only, never Keychain or
// browser stores. These are references to current CLI homes, not managed copies.
async function discoverSystemAccounts({ home = os.homedir(), env = process.env } = {}) {
  const rows = [];
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const [codex, claude] = await Promise.all([
    readJson(path.join(codexHome, "auth.json")),
    readJson(env.CLAUDE_CONFIG_DIR ? path.join(claudeHome, ".claude.json") : path.join(home, ".claude.json")),
  ]);
  const base = (provider) => ({ id: `system-${provider}`, provider, system: true, archived: false, registered: false });
  const oauth = claude?.oauthAccount;
  if (text(oauth?.accountUuid)) {
    rows.push({ ...base("claude"), email: text(oauth.emailAddress), plan: null });
  }
  if (codex?.tokens?.access_token && !codex.OPENAI_API_KEY && codex.auth_mode !== "apikey") {
    const access = decode(codex.tokens.access_token), id = decode(codex.tokens.id_token);
    const ns = { ...access["https://api.openai.com/auth"], ...id["https://api.openai.com/auth"] };
    if (text(codex.tokens.account_id) || text(ns.chatgpt_account_id)) rows.push({ ...base("codex"),
      email: text(id.email) || text(access["https://api.openai.com/profile"]?.email), plan: text(ns.chatgpt_plan_type) });
  }
  return rows;
}

async function systemAccountDetails({ trackerDir, provider, interactive = false, forceRefresh = false, home = os.homedir(), env = process.env, expectedIdentity, authorized = false, readAuth, getLimits }) {
  if (!["claude", "codex"].includes(provider)) throw new Error("Invalid provider");
  const { privateDirectory, accountPaths, readOptionalJson } = require("./subscription-accounts");
  const { writeFileAtomic } = require("./fs");
  const { readAccountAuth } = require("./subscription-account-auth");
  const { getAccountLimits } = require("./subscription-account-usage");
  const root = path.join(trackerDir, "subscription-system-cache");
  await privateDirectory(root);
  const permissionFile = path.join(root, "permissions.json");
  const permission = await readOptionalJson(permissionFile) || {};
  if (interactive) { permission[provider] = true; await writeFileAtomic(permissionFile, JSON.stringify(permission), { mode: 0o600 }); }
  const account = (await discoverSystemAccounts({ home, env })).find((row) => row.provider === provider);
  if (!account) throw new Error("Local account unavailable");
  const sourceHome = provider === "claude" ? env.CLAUDE_CONFIG_DIR || path.join(home, ".claude") : env.CODEX_HOME || path.join(home, ".codex");
  const sourceConfig = env.CLAUDE_CONFIG_DIR ? path.join(sourceHome, ".claude.json") : path.join(home, ".claude.json");
  const read = () => (readAuth || readAccountAuth)({ trackerDir: root, account: { ...account, allowKeychain: authorized || permission[provider] === true },
    sourceHome, sourceConfig, interactive,
    ...(provider === "claude" && !env.CLAUDE_CONFIG_DIR ? { sourceService: "Claude Code-credentials" } : {}) });
  const auth = await read();
  if (!auth?.identity?.key || (expectedIdentity && auth.identity.key !== expectedIdentity)) return { account, status: "identity_mismatch", usage: null, limits: null };
  const cacheAccount = { ...account, id: auth.identity.key.slice(0, 32), identity: auth.identity };
  await privateDirectory(accountPaths(root, cacheAccount.id).dir);
  const limits = await (getLimits || getAccountLimits)({ trackerDir: root, account: cacheAccount, auth, forceRefresh });
  const after = await read();
  if (after?.identity?.key !== auth.identity.key || after?.fingerprint !== auth.fingerprint) return { account, status: "identity_mismatch", usage: null, limits: null };
  return { account, usage: null, limits, status: "ready" };
}
module.exports = { discoverSystemAccounts, systemAccountDetails };
