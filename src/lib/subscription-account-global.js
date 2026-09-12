const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { getAccount, accountPaths, privateDirectory, readOptionalJson } = require("./subscription-accounts");
const { readAccountAuth, identityMatches } = require("./subscription-account-auth");
const { openLock, writeFileAtomic, inspectLock } = require("./fs");
const { keychainOperation } = require("./subscription-keychain");

const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function optionalText(file) {
  try { return await fs.readFile(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function locations(trackerDir, provider, home = os.homedir(), env = process.env) {
  if (!["claude", "codex"].includes(provider)) throw new Error("Invalid provider");
  const runtimeHome = provider === "claude" ? env.CLAUDE_CONFIG_DIR || path.join(home, ".claude") : env.CODEX_HOME || path.join(home, ".codex");
  if (!path.isAbsolute(runtimeHome)) throw new Error("Default account path must be absolute");
  const root = path.join(trackerDir, "subscription-accounts", "defaults");
  return { root, state: path.join(root, provider + ".json"), journal: path.join(root, provider + "-pending.json"), runtimeHome,
    config: provider === "claude" ? (env.CLAUDE_CONFIG_DIR ? path.join(runtimeHome, ".claude.json") : path.join(home, ".claude.json")) : path.join(runtimeHome, "config.toml"),
    credentials: path.join(runtimeHome, provider === "claude" ? ".credentials.json" : "auth.json") };
}
function settings(raw) {
  const top = (raw || "").split(/^\s*\[/m)[0];
  return { store: top.match(/^\s*cli_auth_credentials_store\s*=.*$/m)?.[0] || null,
    login: top.match(/^\s*forced_login_method\s*=.*$/m)?.[0] || null };
}
function replaceSettings(raw, value) {
  const text = raw || "";
  const split = text.search(/^\s*\[/m);
  const prefix = split === -1 ? text : text.slice(0, split);
  const suffix = split === -1 ? "" : text.slice(split);
  return [value.store, value.login].filter(Boolean).join("\n") + "\n" +
    prefix.replace(/^\s*(?:cli_auth_credentials_store|forced_login_method)\s*=.*(?:\r?\n|$)/gm, "") + suffix;
}
async function adapters(options) {
  const { trackerDir, provider, home, env, platform = process.platform, keychain = keychainOperation } = options;
  const p = locations(trackerDir, provider, home, env);
  const file = (name) => ({ name: "credentials", read: () => optionalText(name), write: async (value) => {
    if (value === null) await fs.rm(name, { force: true });
    else { await privateDirectory(path.dirname(name)); await writeFileAtomic(name, value, { mode: 0o600 }); }
  } });
  const slots = [file(p.credentials)];
  slots.push({ name: "config", read: async () => {
    const raw = await optionalText(p.config);
    return provider === "claude" ? (raw ? JSON.parse(raw).oauthAccount ?? null : null) : settings(raw);
  }, write: async (value) => {
    const raw = await optionalText(p.config);
    let next;
    if (provider === "claude") {
      next = raw ? JSON.parse(raw) : {};
      if (value === null) delete next.oauthAccount; else next.oauthAccount = value;
      next = JSON.stringify(next, null, 2) + "\n";
    } else next = replaceSettings(raw, value);
    await writeFileAtomic(p.config, next, { mode: 0o600 });
  } });
  if (provider === "claude" && platform === "darwin") {
    let canonical = p.runtimeHome;
    try { canonical = await fs.realpath(canonical); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const hash = crypto.createHash("sha256").update(canonical.normalize("NFC")).digest("hex").slice(0, 8);
    const account = process.env.USER || os.userInfo().username;
    for (const service of [`Claude Code-credentials-${hash}`, "Claude Code-credentials"]) slots.push({ name: service,
      read: async () => { const result = await keychain({ service, account, interactive: options.interactive === true }); return result.found ? result.value : null; },
      write: (value) => keychain({ service, account, interactive: true, action: value === null ? "delete" : "write", ...(value === null ? {} : { value }) }),
    });
  }
  return { p, slots };
}
async function capture(slots) {
  const data = {};
  for (const slot of slots) data[slot.name] = await slot.read();
  return data;
}
const refreshChecks = new Map();
async function verifyRefresh({ account, auth, fetchImpl = fetch }) {
  if (!identityMatches(account, auth) || !auth?.accessToken) return false;
  if (account.provider === "codex") return true; // Account and user claims were compared by readAccountAuth.
  const response = await fetchImpl("https://api.anthropic.com/api/oauth/profile", { method: "GET", redirect: "error",
    headers: { Authorization: `Bearer ${auth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) return false;
  const profile = await response.json();
  if (!profile?.account?.uuid || !profile?.organization?.uuid) return false;
  return digest([profile.account.uuid, profile.organization.uuid]) === account.identity.key;
}
async function acceptVerifiedRefresh(options, p, slots, state, current) {
  if (!state.written || digest(current.config) !== digest(state.written.config)) return false;
  const key = p.state + ":" + digest(current);
  if (refreshChecks.get(key) > Date.now()) return false;
  refreshChecks.set(key, Date.now() + 60000);
  if (refreshChecks.size > 100) refreshChecks.delete(refreshChecks.keys().next().value);
  const lock = await openLock(path.join(p.root, options.provider + ".lock"), { quietIfLocked: true });
  if (!lock) return false;
  try {
    if (await readOptionalJson(p.journal) || digest(await readOptionalJson(p.state)) !== digest(state)) return false;
    const account = await getAccount({ trackerDir: options.trackerDir, id: state.accountId });
    const auth = await (options.readAuth || readAccountAuth)({ trackerDir: options.trackerDir, account: { ...account, allowKeychain: true },
      sourceHome: p.runtimeHome, sourceConfig: p.config, includeCredentials: true, interactive: false,
      ...(options.provider === "claude" && !(options.env || process.env).CLAUDE_CONFIG_DIR ? { sourceService: "Claude Code-credentials" } : {}) });
    if (!auth?.credentialData || !await (options.verifyRefresh || verifyRefresh)({ account, auth, fetchImpl: options.fetchImpl })) return false;
    if (digest(await capture(slots)) !== digest(current)) return false;
    const managedHome = accountPaths(options.trackerDir, state.accountId).runtimeHome;
    await writeFileAtomic(path.join(managedHome, options.provider === "claude" ? ".credentials.json" : "auth.json"), JSON.stringify(auth.credentialData), { mode: 0o600 });
    await writeFileAtomic(p.state, JSON.stringify({ ...state, written: current, writtenDigest: digest(current), updatedAt: new Date().toISOString() }), { mode: 0o600 });
    return true;
  } finally { await lock.release(); }
}
async function globalAccountStatus(options) {
  options = { ...options, interactive: false };
  const { p, slots } = await adapters(options);
  const state = await readOptionalJson(p.state);
  if (await readOptionalJson(p.journal)) return { state: "recovery_required", activeAccountId: null, canRestore: true };
  if (!state) return { state: "system", activeAccountId: `system-${options.provider}`, canRestore: false };
  if (state.runtimeHome !== p.runtimeHome) return { state: "changed", activeAccountId: null, canRestore: false };
  let unchanged = false;
  try {
    const current = await capture(slots);
    unchanged = digest(current) === state.writtenDigest || await acceptVerifiedRefresh(options, p, slots, state, current);
  } catch { /* No background authentication prompts. */ }
  return { state: unchanged ? "active" : "changed", activeAccountId: unchanged ? state.accountId : null, managedAccountId: state.accountId,
    canRestore: true, updatedAt: state.updatedAt, scope: "default_cli", restartRequired: true };
}

// Transactional changes to default CLI authentication only. API keys, browser
// sessions, IDE-private stores, running processes and shell rc files are never
// rewritten. Each slot is checked before writing and before compensation.
async function activateGlobalAccount({ trackerDir, id, provider, restore = false, ...dependencies }) {
  let account;
  if (!restore) { account = await getAccount({ trackerDir, id }); provider = account.provider; }
  const options = { trackerDir, provider, ...dependencies, interactive: true };
  const { p, slots } = await adapters(options);
  await privateDirectory(p.root);
  // Save a verified renewal from the outgoing default before replacing it.
  await globalAccountStatus(options);
  const lock = await openLock(path.join(p.root, provider + ".lock"), { quietIfLocked: true });
  if (!lock) return { status: "blocked", reason: "switch_busy" };
  let accountLock;
  try {
    const previous = await readOptionalJson(p.state);
    if (previous && previous.runtimeHome !== p.runtimeHome) return { status: "blocked", reason: "external_change" };
    const pending = await readOptionalJson(p.journal);
    if (pending && !restore) return { status: "blocked", reason: "recovery_required" };
    const before = await capture(slots);
    let next;
    if (restore) {
      if (pending) {
        next = { ...before };
        for (const name of pending.attempted) {
          if (digest(before[name]) !== digest(pending.next[name]) && digest(before[name]) !== digest(pending.before[name])) return { status: "blocked", reason: "external_change" };
          next[name] = pending.before[name];
        }
      } else {
        if (!previous || previous.runtimeHome !== p.runtimeHome || digest(before) !== previous.writtenDigest) return { status: "blocked", reason: "external_change" };
        next = previous.original;
      }
    } else {
      if (!account.identity || account.archived || account.invalidatedAt) return { status: "blocked", reason: "login_required" };
      const lease = await inspectLock(path.join(accountPaths(trackerDir, id).dir, "runtime.lock"));
      if (lease.exists && lease.alive) return { status: "blocked", reason: "account_busy" };
      accountLock = await openLock(path.join(accountPaths(trackerDir, id).dir, "runtime.lock"), { quietIfLocked: true });
      if (!accountLock) return { status: "blocked", reason: "account_busy" };
      const reader = dependencies.readAuth || readAccountAuth;
      const auth = await reader({ trackerDir, account: { ...account, allowKeychain: true }, includeCredentials: true, interactive: true });
      if (!identityMatches(account, auth) || !auth?.accessToken || !auth.credentialData) return { status: "blocked", reason: "credentials_unavailable" };
      if (auth.expiresAt && auth.expiresAt < Date.now() + 60000) return { status: "blocked", reason: "auth_expired" };
      if (!await (dependencies.verifyRefresh || verifyRefresh)({ account, auth, fetchImpl: dependencies.fetchImpl })) return { status: "blocked", reason: "credentials_unavailable" };
      next = { ...before, credentials: JSON.stringify(auth.credentialData) + "\n", config: provider === "claude" ? auth.oauthAccount : {
        store: 'cli_auth_credentials_store = "file"', login: 'forced_login_method = "chatgpt"',
      } };
      for (const slot of slots.slice(2)) next[slot.name] = JSON.stringify(auth.credentialData);
    }
    const transaction = { before, next, attempted: [], runtimeHome: p.runtimeHome, previous };
    await writeFileAtomic(p.journal, JSON.stringify(transaction), { mode: 0o600 });
    try {
      for (const slot of slots) {
        if (digest(await slot.read()) !== digest(before[slot.name])) throw new Error("external_change");
        transaction.attempted.push(slot.name);
        await writeFileAtomic(p.journal, JSON.stringify(transaction), { mode: 0o600 });
        await slot.write(next[slot.name]);
      }
      if (digest(await capture(slots)) !== digest(next)) throw new Error("verification_failed");
      if (restore) {
        // Recovering a failed transaction leaves its previously committed
        // selection intact. Restoring the original system login clears it.
        if (pending?.previous) await writeFileAtomic(p.state, JSON.stringify(pending.previous), { mode: 0o600 });
        else await fs.rm(p.state, { force: true });
      } else await writeFileAtomic(p.state, JSON.stringify({ accountId: id, runtimeHome: p.runtimeHome,
        original: previous?.original || before, written: next, writtenDigest: digest(next), updatedAt: new Date().toISOString() }), { mode: 0o600 });
      await fs.rm(p.journal, { force: true });
      return { status: "applied", activeAccountId: restore ? pending?.previous?.accountId || `system-${provider}` : id,
        scope: "default_cli", restartRequired: true };
    } catch {
      let restored = true;
      for (const slot of [...slots].reverse().filter((slot) => transaction.attempted.includes(slot.name))) {
        try {
          const current = await slot.read();
          if (digest(current) === digest(before[slot.name])) continue;
          if (digest(current) !== digest(next[slot.name])) { restored = false; continue; }
          await slot.write(before[slot.name]);
        } catch { restored = false; }
      }
      if (restored) {
        try {
          if (previous) await writeFileAtomic(p.state, JSON.stringify(previous), { mode: 0o600 });
          else await fs.rm(p.state, { force: true });
          await fs.rm(p.journal, { force: true });
        } catch { restored = false; }
      }
      return { status: "blocked", reason: restored ? "switch_failed" : "recovery_required" };
    }
  } finally { if (accountLock) await accountLock.release(); await lock.release(); }
}
// Call under the account runtime lease before starting an isolated runtime.
// A copied OAuth refresh token must not be refreshed by two different homes.
async function usesDefaultLogin({ trackerDir, account }) {
  const p = locations(trackerDir, account.provider);
  const [state, pending] = await Promise.all([readOptionalJson(p.state), readOptionalJson(p.journal)]);
  return state?.accountId === account.id || Boolean(pending);
}
module.exports = { activateGlobalAccount, globalAccountStatus, locations, replaceSettings, usesDefaultLogin, verifyRefresh };
