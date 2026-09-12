const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { discoverSystemAccounts } = require("../src/lib/subscription-system-accounts");

test("discovers official default accounts without copying credentials, assigning history or returning secrets", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-default-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".codex"));
  const jwt = `h.${Buffer.from(JSON.stringify({ email: "local@example.invalid", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })).toString("base64url")}.s`;
  const auth = JSON.stringify({ tokens: { access_token: jwt, id_token: jwt, account_id: "local-id" } });
  await fs.writeFile(path.join(home, ".codex/auth.json"), auth);
  await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "claude-id", emailAddress: "claude@example.invalid" } }));
  const before = await fs.readdir(home);
  const rows = await discoverSystemAccounts({ home, env: {} });
  assert.deepEqual(rows.map((r) => r.id), ["system-claude", "system-codex"]);
  assert.equal(rows[1].plan, "plus"); assert.equal(rows[1].email, "local@example.invalid");
  for (const row of rows) { assert.equal(row.registered, false); assert.equal(row.usage, undefined); }
  assert.ok(!JSON.stringify(rows).includes(jwt)); assert.ok(!JSON.stringify(rows).includes("local-id"));
  assert.deepEqual(await fs.readdir(home), before);
  assert.equal(await fs.readFile(path.join(home, ".codex/auth.json"), "utf8"), auth);
  await fs.writeFile(path.join(home, ".codex/auth.json"), JSON.stringify({ OPENAI_API_KEY: "api-key" }));
  assert.equal((await discoverSystemAccounts({ home, env: {} })).length, 1);
  assert.deepEqual(await discoverSystemAccounts({ home, env: { CODEX_HOME: path.join(home, "missing"), CLAUDE_CONFIG_DIR: path.join(home, "missing") } }), []);
  await fs.mkdir(path.join(home, "custom"));
  await fs.writeFile(path.join(home, "custom/.claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "custom", emailAddress: "custom@example.invalid" } }));
  assert.equal((await discoverSystemAccounts({ home, env: { CLAUDE_CONFIG_DIR: path.join(home, "custom") } }))[0].email, "custom@example.invalid");
  await fs.writeFile(path.join(home, "custom/.claude.json"), "malformed");
  assert.deepEqual(await discoverSystemAccounts({ home, env: { CLAUDE_CONFIG_DIR: path.join(home, "custom") } }), []);
});

test("local quota snapshots bind to the credential identity and discard an in-flight account change", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-system-quota-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".claude"));
  await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "account-a" } }));
  const { systemAccountDetails } = require("../src/lib/subscription-system-accounts");
  const identity = { key: "a".repeat(64) };
  const options = { trackerDir: path.join(home, "tracker"), home, env: {}, provider: "claude",
    readAuth: async ({ interactive, account }) => { assert.equal(interactive, false); assert.equal(account.allowKeychain, false); return { identity, fingerprint: "token-a", accessToken: "fixture" }; },
    getLimits: async ({ account, auth }) => { assert.equal(account.id, identity.key.slice(0, 32)); assert.equal(auth.fingerprint, "token-a"); return { status: "ok", five_hour: { utilization: 29 } }; } };
  const result = await systemAccountDetails(options);
  assert.equal(result.limits.five_hour.utilization, 29);
  assert.equal(result.account.id, "system-claude"); assert.equal(result.usage, null);
  assert.equal(JSON.stringify(result).includes("fixture"), false);
  let reads = 0;
  const changed = await systemAccountDetails({ ...options, readAuth: async () => ({ identity, fingerprint: ++reads === 1 ? "token-a" : "token-b", accessToken: "fixture" }) });
  assert.equal(changed.status, "identity_mismatch"); assert.equal(changed.limits, null);
  const mismatched = await systemAccountDetails({ ...options, expectedIdentity: "b".repeat(64), getLimits: async () => assert.fail("must not fetch wrong identity") });
  assert.equal(mismatched.limits, null);
});
