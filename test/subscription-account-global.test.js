const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createAccount, bindIdentity } = require("../src/lib/subscription-accounts");
const { activateGlobalAccount, globalAccountStatus, locations } = require("../src/lib/subscription-account-global");

async function fixture(t, provider) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-global-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const trackerDir = path.join(home, "tracker");
  const account = await createAccount({ trackerDir, provider, label: "Work" });
  await bindIdentity({ trackerDir, id: account.id, identity: { key: "work", email: "work@example.invalid" } });
  const options = { home, trackerDir, provider, id: account.id, env: {}, platform: "linux", verifyRefresh: async () => true,
    readAuth: async () => ({ identity: { key: "work" }, accessToken: "fixture", expiresAt: Date.now() + 3600000,
      credentialData: provider === "claude" ? { claudeAiOauth: { accessToken: "fixture" } } : { tokens: { access_token: "fixture" } },
      oauthAccount: { accountUuid: "work", emailAddress: "work@example.invalid" } }) };
  const p = locations(trackerDir, provider, home, {});
  await fs.mkdir(p.runtimeHome, { recursive: true });
  return { ...options, p };
}

test("Codex activation updates the default auth store and preserves unrelated config on restore", async (t) => {
  const f = await fixture(t, "codex");
  await fs.writeFile(f.p.credentials, '{"old":"login"}');
  await fs.writeFile(f.p.config, 'model = "gpt-test"\ncli_auth_credentials_store = "keyring"\n[projects."/work"]\ntrust_level = "trusted"\n');
  assert.equal((await activateGlobalAccount(f)).status, "applied");
  assert.equal((await globalAccountStatus(f)).activeAccountId, f.id);
  assert.match(await fs.readFile(f.p.config, "utf8"), /cli_auth_credentials_store = "file"/);
  await fs.appendFile(f.p.config, '\n[features]\nexample = true\n');
  assert.equal((await globalAccountStatus(f)).state, "active");
  assert.equal((await activateGlobalAccount({ ...f, restore: true })).status, "applied");
  assert.equal(await fs.readFile(f.p.credentials, "utf8"), '{"old":"login"}');
  const config = await fs.readFile(f.p.config, "utf8");
  assert.match(config, /keyring/); assert.match(config, /example = true/); assert.match(config, /trust_level/);
  assert.equal((await globalAccountStatus(f)).state, "system");
});

test("Claude default activation writes both known CLI services; partial failure restores the original login", async (t) => {
  const f = await fixture(t, "claude");
  await fs.writeFile(f.p.credentials, '{"old":"file"}');
  await fs.writeFile(f.p.config, JSON.stringify({ oauthAccount: { accountUuid: "personal" }, theme: "dark" }));
  const items = new Map([["Claude Code-credentials", "old-keychain"]]);
  let fail = true;
  const keychain = async ({ service, action = "read", value, interactive }) => {
    if (action === "read") return { found: items.has(service), value: items.get(service) };
    assert.equal(interactive, true);
    if (fail && service === "Claude Code-credentials" && action === "write") { fail = false; throw new Error("fixture failure"); }
    if (action === "write") items.set(service, value); else items.delete(service);
    return { found: true };
  };
  const options = { ...f, platform: "darwin", keychain };
  assert.equal((await activateGlobalAccount(options)).reason, "switch_failed");
  assert.deepEqual([...items.values()], ["old-keychain"]);
  assert.equal(JSON.parse(await fs.readFile(f.p.config, "utf8")).oauthAccount.accountUuid, "personal");
  assert.equal((await activateGlobalAccount(options)).status, "applied");
  assert.equal(items.size, 2);
  assert.equal((await globalAccountStatus(options)).activeAccountId, f.id);
  assert.equal(JSON.parse(await fs.readFile(f.p.config, "utf8")).theme, "dark");
  assert.equal((await fs.stat(f.p.state)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(await globalAccountStatus(options)).includes("fixture"), false);
});

test("external login changes are detected and are not overwritten by restore", async (t) => {
  const f = await fixture(t, "codex");
  await activateGlobalAccount(f);
  await fs.writeFile(f.p.credentials, "external-login");
  assert.equal((await globalAccountStatus({ ...f, readAuth: async () => null })).state, "changed");
  assert.equal((await activateGlobalAccount({ ...f, restore: true })).reason, "external_change");
  assert.equal(await fs.readFile(f.p.credentials, "utf8"), "external-login");
});

test("background global status reads never allow a Keychain prompt", async (t) => {
  const f = await fixture(t, "claude");
  const items = new Map();
  const keychain = async ({ service, action = "read", value }) => {
    if (action === "write") items.set(service, value);
    if (action === "delete") items.delete(service);
    return { found: items.has(service), value: items.get(service) };
  };
  await activateGlobalAccount({ ...f, platform: "darwin", keychain });
  assert.equal((await globalAccountStatus({ ...f, platform: "darwin", keychain: async (args) => {
    assert.equal(args.interactive, false); throw new Error("locked");
  } })).state, "changed");
});

test("verified default token renewal remains selected and updates the managed credential copy", async (t) => {
  const f = await fixture(t, "codex");
  await activateGlobalAccount(f);
  const refreshed = { tokens: { access_token: "renewed-fixture" } };
  await fs.writeFile(f.p.credentials, JSON.stringify(refreshed));
  const state = await globalAccountStatus({ ...f, readAuth: async () => ({ identity: { key: "work" }, accessToken: "renewed-fixture", credentialData: refreshed }) });
  assert.equal(state.state, "active");
  const { accountPaths } = require("../src/lib/subscription-accounts");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(accountPaths(f.trackerDir, f.id).runtimeHome, "auth.json"))), refreshed);
  assert.equal((await activateGlobalAccount({ ...f, restore: true })).status, "applied");
});

test("Claude refresh ownership is checked against the provider profile rather than the local label", async () => {
  const { verifyRefresh } = require("../src/lib/subscription-account-global");
  const crypto = require("node:crypto");
  const identity = { key: crypto.createHash("sha256").update(JSON.stringify(["account", "org"])).digest("hex") };
  const input = { account: { provider: "claude", identity }, auth: { identity, accessToken: "fixture" } };
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/profile"); assert.equal(options.redirect, "error");
    return { ok: true, json: async () => ({ account: { uuid: "account" }, organization: { uuid: "org" } }) };
  };
  assert.equal(await verifyRefresh({ ...input, fetchImpl }), true);
  assert.equal(await verifyRefresh({ ...input, fetchImpl: async () => ({ ok: true, json: async () => ({ account: { uuid: "other" }, organization: { uuid: "org" } }) }) }), false);
});

test("an active default cannot start a second isolated credential refresh runtime", async (t) => {
  const f = await fixture(t, "codex");
  await activateGlobalAccount(f);
  const { launchAccount } = require("../src/commands/accounts");
  await assert.rejects(launchAccount({ trackerDir: f.trackerDir, id: f.id, spawnImpl: () => assert.fail("must not spawn") }), /local default/);
});

test("recovery after a crash between state commit and journal removal restores the previous selection", async (t) => {
  const f = await fixture(t, "codex");
  await fs.writeFile(f.p.credentials, '{"original":true}');
  await activateGlobalAccount(f);
  const state = JSON.parse(await fs.readFile(f.p.state, "utf8"));
  await fs.writeFile(f.p.journal, JSON.stringify({ before: state.original, next: state.written, attempted: Object.keys(state.written), previous: null, runtimeHome: f.p.runtimeHome }));
  assert.equal((await globalAccountStatus(f)).state, "recovery_required");
  const restored = await activateGlobalAccount({ ...f, restore: true });
  assert.equal(restored.activeAccountId, "system-codex");
  assert.equal((await globalAccountStatus(f)).state, "system");
  assert.equal(await fs.readFile(f.p.credentials, "utf8"), '{"original":true}');
});
