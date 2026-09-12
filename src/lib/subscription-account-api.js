const path = require("node:path");
const accounts = require("./subscription-accounts");
const { accountDetails } = require("./subscription-account-usage");
const { discoverSystemAccounts } = require("./subscription-system-accounts");
const { normalizePlanLabel } = require("./usage-limits");

function publicAccount(account) {
  return { id: account.id, provider: account.provider, label: account.label, archived: account.archived,
    allowKeychain: account.allowKeychain, createdAt: account.createdAt, boundAt: account.boundAt || null,
    email: account.identity?.email || null, plan: normalizePlanLabel(account.identity?.plan, account.provider),
    subscriptionEndsAt: account.identity?.subscriptionEndsAt || null, registered: Boolean(account.identity) && !account.invalidatedAt };
}

function accountCommands(id, platform = process.platform) {
  // Use the CLI that is actually serving this dashboard, including EmbeddedServer.
  const parts = [process.execPath, path.resolve(__dirname, "../../bin/tracker.js"), "accounts"];
  const quote = platform === "win32" ? (s) => `'${s.replace(/'/g, "''")}'` : (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const command = (action) => (platform === "win32" ? "& " : "") + [...parts, action, id].map(quote).join(" ");
  return { login: command("login"), run: command("run"), auto: command("auto") };
}

async function detailsForAccount({ trackerDir, account, forceRefresh = false }) {
  if (account.archived) return { status: "archived", usage: null, limits: null };
  const { globalAccountStatus } = require("./subscription-account-global");
  const global = await globalAccountStatus({ trackerDir, provider: account.provider });
  if (global.state === "recovery_required" || (global.managedAccountId === account.id && global.state !== "active")) {
    return { status: "default_changed", usage: null, limits: null };
  }
  if (global.activeAccountId === account.id) {
    const detail = await require("./subscription-system-accounts").systemAccountDetails({ trackerDir, provider: account.provider,
      expectedIdentity: account.identity.key, authorized: true, forceRefresh });
    const after = await globalAccountStatus({ trackerDir, provider: account.provider });
    if (after.activeAccountId !== account.id) return { status: "default_changed", usage: null, limits: null };
    // Shared logs do not carry a reliable per-request account identity.
    return { status: detail.status, usage: null, limits: detail.limits };
  }
  return accountDetails({ trackerDir, account, forceRefresh });
}

async function subscriptionAccountRequest({ trackerDir, method, body, url }) {
  if (method === "GET") {
    const loginId = url.searchParams.get("loginId");
    if (loginId) return { login: require("./subscription-account-login").loginManager(trackerDir).status(loginId) };
    const id = url.searchParams.get("id");
    if (id) {
      if (["system-claude", "system-codex"].includes(id)) return require("./subscription-system-accounts").systemAccountDetails({ trackerDir, provider: id.slice(7) });
      const account = await accounts.getAccount({ trackerDir, id });
      const detail = await detailsForAccount({ trackerDir, account });
      return { account: publicAccount(account), commands: accountCommands(id), ...detail };
    }
    const global = {};
    for (const provider of ["claude", "codex"]) {
      try { global[provider] = await require("./subscription-account-global").globalAccountStatus({ trackerDir, provider }); }
      catch { global[provider] = { state: "unavailable", activeAccountId: null }; }
    }
    return { global, accounts: (await accounts.listAccounts({ trackerDir })).map(publicAccount),
      systemAccounts: (await discoverSystemAccounts()).map((a) => ({ ...a, plan: normalizePlanLabel(a.plan, a.provider) })), platform: process.platform,
      logins: require("./subscription-account-login").loginManager(trackerDir).active(),
      sessions: await require("./subscription-account-sessions").listSessions({ trackerDir }),
      poolCommands: { claude: accountCommands("claude").auto, codex: accountCommands("codex").auto } };
  }
  if (body?.action === "refresh_system") {
    return require("./subscription-system-accounts").systemAccountDetails({ trackerDir, provider: body.provider, interactive: true, forceRefresh: true });
  }
  if (body?.action === "delete") return { deletion: await accounts.deleteAccount({ trackerDir, id: body.id }) };
  if (body?.action === "activate" || body?.action === "restore_default") {
    return { activation: await require("./subscription-account-global").activateGlobalAccount({ trackerDir,
      id: body.id, provider: body.provider, restore: body.action === "restore_default" }) };
  }
  if (body?.action === "login_start") {
    const manager = require("./subscription-account-login").loginManager(trackerDir);
    return { login: await manager.start({ id: body.id, provider: body.provider, label: body.label, allowKeychain: body.allowKeychain }) };
  }
  if (body?.action === "launch") {
    return { launch: await require("./subscription-account-launch").launchInTerminal({ trackerDir,
      id: body.id, provider: body.provider, auto: body.auto, ...(body.cwd ? { cwd: body.cwd } : {}) }) };
  }
  if (body?.action === "switch_session") {
    return { switch: await require("./subscription-account-sessions").requestSwitch({ trackerDir,
      sessionId: body.sessionId, accountId: body.id }) };
  }
  if (body?.action === "session_rotation") {
    return { switch: await require("./subscription-account-sessions").requestSwitch({ trackerDir,
      sessionId: body.sessionId, auto: body.auto }) };
  }
  if (body?.action === "login_cancel" || body?.action === "login_code") {
    const manager = require("./subscription-account-login").loginManager(trackerDir);
    return { login: body.action === "login_cancel" ? manager.cancel(body.loginId) : manager.submitCode(body.loginId, body.code) };
  }
  if (body?.action === "create") {
    return { account: publicAccount(await accounts.createAccount({ trackerDir, provider: body.provider, label: body.label, allowKeychain: body.allowKeychain })) };
  }
  if (body?.action === "update") {
    const account = await accounts.updateAccount({ trackerDir, id: body.id, label: body.label, archived: body.archived, allowKeychain: body.allowKeychain });
    if (body.allowKeychain === true) await require("./subscription-account-auth").readAccountAuth({ trackerDir, account, interactive: true });
    return { account: publicAccount(account) };
  }
  if (body?.action === "refresh") {
    const account = await accounts.getAccount({ trackerDir, id: body.id });
    if (account.archived) throw new Error("Restore this account to refresh usage");
    return { account: publicAccount(account), commands: accountCommands(account.id),
      ...await detailsForAccount({ trackerDir, account, forceRefresh: true }) };
  }
  throw new Error("Unknown account action");
}

module.exports = { subscriptionAccountRequest, publicAccount, accountCommands };
