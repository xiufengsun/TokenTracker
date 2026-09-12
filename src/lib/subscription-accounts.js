const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { openLock, writeFileAtomic } = require("./fs");

const PROVIDERS = new Set(["claude", "codex"]);
const ID_PATTERN = /^[a-f0-9]{32}$/;

function accountPaths(trackerDir, id) {
  if (!ID_PATTERN.test(id || "")) throw new Error("Invalid account ID");
  const dir = path.join(trackerDir, "subscription-accounts", id);
  return { dir, runtimeHome: path.join(dir, "home"), metadata: path.join(dir, "account.json") };
}

async function readOptionalJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("Cannot read account data"); }
}

async function privateDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

async function saveAccount(trackerDir, account) {
  await writeFileAtomic(accountPaths(trackerDir, account.id).metadata,
    JSON.stringify(account, null, 2) + "\n", { mode: 0o600 });
}

async function getAccount({ trackerDir, id }) {
  const account = await readOptionalJson(accountPaths(trackerDir, id).metadata);
  if (!account || account.id !== id || !PROVIDERS.has(account.provider)) throw new Error("Account not found");
  return account;
}

async function listAccounts({ trackerDir }) {
  let entries;
  try { entries = await fs.readdir(path.join(trackerDir, "subscription-accounts"), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const accounts = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ID_PATTERN.test(entry.name)) {
      const account = await readOptionalJson(accountPaths(trackerDir, entry.name).metadata);
      if (account && account.id === entry.name && PROVIDERS.has(account.provider)) accounts.push(account);
    }
  }
  return accounts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function deleteAccount({ trackerDir, id, platform = process.platform, keychain }) {
  return withRegistryLock(trackerDir, async () => {
    const account = await getAccount({ trackerDir, id });
    const p = accountPaths(trackerDir, id);
    // This namespace is permanently removed under the registry lock, so no
    // replacement owner can legitimately acquire its lease after the rename.
    const lock = await openLock(path.join(p.dir, "runtime.lock"), { quietIfLocked: true, serializeRelease: false });
    if (!lock) return { status: "blocked", reason: "account_busy" };
    try {
      if (await require("./subscription-account-global").usesDefaultLogin({ trackerDir, account })) return { status: "blocked", reason: "default_account" };
      if (account.provider === "claude" && platform === "darwin") {
        const canonical = await fs.realpath(p.runtimeHome);
        const service = "Claude Code-credentials-" + crypto.createHash("sha256").update(canonical.normalize("NFC")).digest("hex").slice(0, 8);
        await (keychain || require("./subscription-keychain").keychainOperation)({ service, account: process.env.USER || require("node:os").userInfo().username, action: "delete", interactive: true });
      }
      // Remove the registry entry atomically before cleaning its private data.
      // Interrupted cleanup cannot resurrect a selectable account.
      const removed = path.join(path.dirname(p.dir), "removed-" + id);
      await fs.rename(p.dir, removed);
      await require("./subscription-account-usage").drainAccountWork(p.dir);
      await fs.rm(removed, { recursive: true, force: true });
      await fs.rm(p.dir, { recursive: true, force: true });
      return { status: "deleted", id };
    } finally { await lock.release(); }
  });
}

async function withRegistryLock(trackerDir, action) {
  const root = path.join(trackerDir, "subscription-accounts");
  await privateDirectory(root);
  const lock = await openLock(path.join(root, "registry.lock"), { quietIfLocked: true });
  if (!lock) throw new Error("Accounts are being updated; try again");
  try { return await action(); } finally { await lock.release(); }
}

function accountLabel(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Account label must contain 1–80 printable characters");
  }
  return value.trim();
}

async function createAccount({ trackerDir, provider, label, allowKeychain = false }) {
  if (!PROVIDERS.has(provider)) throw new Error("Choose Claude or Codex");
  const name = accountLabel(label);
  return withRegistryLock(trackerDir, async () => {
    if ((await listAccounts({ trackerDir })).length >= 50) throw new Error("Account limit reached (50)");
    const id = crypto.randomBytes(16).toString("hex");
    const paths = accountPaths(trackerDir, id);
    await privateDirectory(paths.runtimeHome);
    const account = { id, provider, label: name, createdAt: new Date().toISOString(),
      allowKeychain: provider === "claude" && allowKeychain === true, archived: false, identity: null };
    // A new home intentionally does not inherit auth helpers or custom endpoints.
    if (provider === "codex") {
      await writeFileAtomic(path.join(paths.runtimeHome, "config.toml"),
        'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n', { mode: 0o600 });
    }
    await saveAccount(trackerDir, account);
    return account;
  });
}

async function updateAccount({ trackerDir, id, label, archived, allowKeychain }) {
  return withRegistryLock(trackerDir, async () => {
    const account = await getAccount({ trackerDir, id });
    if (label !== undefined) account.label = accountLabel(label);
    if (archived !== undefined) {
      if (typeof archived !== "boolean") throw new Error("Invalid archive state");
      if (!archived && account.identity && (await listAccounts({ trackerDir })).some((a) =>
        a.id !== id && !a.archived && a.provider === account.provider && a.identity?.key === account.identity.key)) {
        throw new Error("This subscription already has an active account");
      }
      account.archived = archived;
    }
    if (allowKeychain !== undefined) {
      if (typeof allowKeychain !== "boolean") throw new Error("Invalid Keychain preference");
      account.allowKeychain = account.provider === "claude" && allowKeychain;
    }
    await saveAccount(trackerDir, account);
    return account;
  });
}

async function bindIdentity({ trackerDir, id, identity }) {
  if (!identity?.key) throw new Error("Subscription identity unavailable; complete CLI login first");
  return withRegistryLock(trackerDir, async () => {
    const account = await getAccount({ trackerDir, id });
    if (account.invalidatedAt) throw new Error("Account history was invalidated by an identity change; archive it and add a fresh account");
    if (account.identity && account.identity.key !== identity.key) {
      account.invalidatedAt = new Date().toISOString();
      await saveAccount(trackerDir, account);
      throw new Error("This home belongs to a different account. Add a new account instead");
    }
    const duplicate = (await listAccounts({ trackerDir })).find((a) =>
      a.id !== id && !a.archived && a.provider === account.provider && a.identity?.key === identity.key);
    if (duplicate) throw new Error("This subscription is already registered; use its existing account");
    account.identity = identity;
    account.boundAt ||= new Date().toISOString();
    await saveAccount(trackerDir, account);
    return account;
  });
}

async function invalidateAccount({ trackerDir, id }) {
  return withRegistryLock(trackerDir, async () => {
    const account = await getAccount({ trackerDir, id });
    account.invalidatedAt ||= new Date().toISOString();
    await saveAccount(trackerDir, account);
  });
}

module.exports = { accountPaths, getAccount, listAccounts, createAccount, updateAccount, deleteAccount,
  bindIdentity, invalidateAccount, readOptionalJson, privateDirectory };
