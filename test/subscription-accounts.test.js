const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const store = require("../src/lib/subscription-accounts");
const { readAccountAuth, identityMatches, accountEnvironment } = require("../src/lib/subscription-account-auth");
const { scanAccountUsage, getAccountLimits, accountDetails } = require("../src/lib/subscription-account-usage");
const { launchAccount, validateRunArgs } = require("../src/commands/accounts");
const { publicAccount } = require("../src/lib/subscription-account-api");

async function fixture(t, provider = "codex", label = "Personal") {
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-accounts-"));
  t.after(() => fs.rm(trackerDir, { recursive: true, force: true }));
  const account = await store.createAccount({ trackerDir, provider, label });
  return { trackerDir, account, ...store.accountPaths(trackerDir, account.id) };
}
const jwt = (body) => `header.${Buffer.from(JSON.stringify(body)).toString("base64url")}.signature`;
async function signIn(f, identity = "account-a", tokenVersion = 1) {
  if (f.account.provider === "codex") {
    const payload = { sub: "user-a", email: "test@example.invalid", exp: 4000000000,
      "https://api.openai.com/auth": { chatgpt_account_id: identity, chatgpt_plan_type: "plus" }, tokenVersion };
    await fs.writeFile(path.join(f.runtimeHome, "auth.json"), JSON.stringify({ tokens: {
      access_token: jwt(payload), id_token: jwt(payload), account_id: identity,
    } }));
  } else {
    await fs.writeFile(path.join(f.runtimeHome, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: identity, organizationUuid: "org-a", emailAddress: "test@example.invalid" } }));
    await fs.writeFile(path.join(f.runtimeHome, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `claude-token-${identity}-${tokenVersion}`, expiresAt: 4000000000000, subscriptionType: "max" } }));
  }
  return readAccountAuth(f);
}
async function bind(f, identity) {
  const auth = await signIn(f, identity);
  f.account = await store.bindIdentity({ ...f, id: f.account.id, identity: auth.identity });
  return auth;
}
function claudeLine(input, msgId = "message-a") {
  return JSON.stringify({ timestamp: "2026-09-11T01:10:00.000Z", message: { id: msgId, model: "claude-sonnet-4-5", usage: { input_tokens: input, output_tokens: 20, cache_read_input_tokens: 30 } } }) + "\n";
}
async function writeLog(f, input = 100) {
  const folder = path.join(f.runtimeHome, f.account.provider === "claude" ? "projects/project" : "sessions");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, f.account.provider === "claude" ? "session.jsonl" : "rollout-session.jsonl");
  const content = f.account.provider === "claude" ? claudeLine(input) : [
    { type: "session_meta", payload: { id: "session-a" } },
    { type: "turn_context", payload: { model: "gpt-5" } },
    { timestamp: "2026-09-11T01:10:00.000Z", type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: 30, output_tokens: 20, total_tokens: input + 20 },
    } } },
  ].map((v) => JSON.stringify(v)).join("\n") + "\n";
  await fs.writeFile(file, content);
  return file;
}

test("account metadata is private, path-safe, token-free, and archive is reversible", async (t) => {
  const f = await fixture(t);
  assert.equal((await fs.stat(f.metadata)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.runtimeHome)).mode & 0o777, 0o700);
  assert.throws(() => store.accountPaths(f.trackerDir, "../escape"));
  await assert.rejects(store.createAccount({ trackerDir: f.trackerDir, provider: "unknown", label: "a" }));
  await assert.rejects(store.updateAccount({ ...f, id: f.account.id, label: "\n" }));
  await bind(f);
  assert.ok(!(await fs.readFile(f.metadata, "utf8")).includes("access_token"));
  assert.ok(!JSON.stringify(publicAccount(f.account)).includes(f.account.identity.key));
  await store.updateAccount({ ...f, id: f.account.id, archived: true });
  await assert.rejects(launchAccount({ ...f, id: f.account.id }), /Restore/);
  await store.updateAccount({ ...f, id: f.account.id, archived: false, label: "Work" });
  assert.equal((await store.listAccounts(f))[0].label, "Work");
  assert.ok(await fs.stat(path.join(f.runtimeHome, "auth.json")));
});

test("identity binding rejects a different login and duplicate subscriptions", async (t) => {
  const f = await fixture(t);
  await bind(f);
  const changed = await signIn(f, "account-b");
  assert.equal(identityMatches(f.account, changed), false);
  await assert.rejects(store.bindIdentity({ ...f, id: f.account.id, identity: changed.identity }), /different/);
  assert.equal((await accountDetails(f)).status, "identity_mismatch");
  await signIn(f, "account-a");
  assert.equal((await accountDetails({ ...f, account: await store.getAccount({ ...f, id: f.account.id }) })).status, "identity_mismatch");
  const second = await store.createAccount({ ...f, provider: "codex", label: "duplicate" });
  await assert.rejects(store.bindIdentity({ ...f, id: second.id, identity: f.account.identity }), /already registered/);
});

test("token refresh preserves identity, while API-key accounts are ineligible", async (t) => {
  const f = await fixture(t);
  const first = await bind(f);
  const fresh = await signIn(f, "account-a", 2);
  assert.ok(identityMatches(f.account, fresh));
  assert.notEqual(fresh.fingerprint, first.fingerprint);
  await fs.writeFile(path.join(f.runtimeHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "not-a-subscription" }));
  assert.equal(await readAccountAuth(f), null);
});

test("Claude never reads Keychain without opt-in and never falls back to the global service", async (t) => {
  const f = await fixture(t, "claude");
  await bind(f);
  await fs.unlink(path.join(f.runtimeHome, ".credentials.json"));
  const calls = [];
  const keychainReader = async (_bin, args) => { calls.push(args); throw new Error("denied"); };
  const auth = await readAccountAuth({ ...f, platform: "darwin", keychainReader });
  assert.equal(auth.accessToken, null);
  assert.equal(calls.length, 0);
  await readAccountAuth({ ...f, account: { ...f.account, allowKeychain: true }, platform: "darwin", keychainReader });
  assert.equal(calls.length, 1);
  assert.match(calls[0][2], /^Claude Code-credentials-[a-f0-9]{8}$/);
  assert.ok(!calls[0].includes("Claude Code-credentials"));
});

test("account environments isolate auth and backend overrides without changing the parent", () => {
  const inherited = { PATH: "/bin", ANTHROPIC_API_KEY: "a", anthropic_auth_token: "b", OPENAI_BASE_URL: "https://wrong.invalid", CODEX_HOME: "/wrong", CLAUDE_CONFIG_DIR: "/wrong", CLAUDE_CODE_USE_BEDROCK: "1" };
  const env = accountEnvironment({ provider: "codex" }, "/selected", inherited);
  assert.deepEqual(env, { PATH: "/bin", CODEX_HOME: "/selected" });
  assert.equal(inherited.CODEX_HOME, "/wrong");
  for (const args of [["-c", "model_provider=wrong"], ["--profile=wrong"], ["auth", "login"], ["--settings", "wrong.json"]]) assert.throws(() => validateRunArgs(args));
  assert.doesNotThrow(() => validateRunArgs(["--model", "gpt-5", "literal $(do-not-execute)"]));
});

test("CLI launches use argument arrays, preserve exit status and block a concurrent login", async (t) => {
  const f = await fixture(t);
  await bind(f);
  const canonicalHome = await fs.realpath(f.runtimeHome);
  let child;
  const started = launchAccount({ ...f, id: f.account.id, args: ["--model", "gpt-5"], spawnImpl: (command, args, options) => {
    assert.equal(command, "codex"); assert.deepEqual(args, ["--model", "gpt-5"]);
    assert.equal(options.shell, false); assert.equal(options.env.CODEX_HOME, canonicalHome);
    child = new EventEmitter(); child.kill = () => {}; return child;
  } });
  while (!child) await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(launchAccount({ ...f, id: f.account.id, login: true }), /already has/);
  child.emit("exit", 7);
  assert.equal(await started, 7);
  // A failed child must release the runtime lock.
  const again = await launchAccount({ ...f, id: f.account.id, spawnImpl: () => {
    const c = new EventEmitter(); c.kill = () => {}; process.nextTick(() => c.emit("exit", 0)); return c;
  } });
  assert.equal(again, 0);
});

for (const provider of ["claude", "codex"]) {
  test(`${provider}: separate account buckets, repeat scans and changed logs remain correct`, async (t) => {
    const a = await fixture(t, provider);
    const b = await fixture(t, provider);
    await bind(a, "account-a"); await bind(b, "account-b");
    const fileA = await writeLog(a, 100); await writeLog(b, 200);
    const first = await scanAccountUsage(a);
    const second = await scanAccountUsage(b);
    assert.equal(first.totalTokens, provider === "claude" ? 150 : 120);
    assert.equal(second.totalTokens, provider === "claude" ? 250 : 220);
    assert.deepEqual(await scanAccountUsage(a), first);
    assert.ok(first.estimatedCostUsd > 0);
    if (provider === "claude") {
      await fs.appendFile(fileA, claudeLine(300, "message-b"));
      assert.equal((await scanAccountUsage(a)).totalTokens, 500);
    } else {
      await writeLog(a, 400);
      assert.equal((await scanAccountUsage(a)).totalTokens, 420);
    }
    assert.deepEqual(await scanAccountUsage(b), second);
    await assert.rejects(fs.access(path.join(a.trackerDir, "queue.jsonl")));
  });
}

test("quota requests, cache and credential rotation are isolated per account", async (t) => {
  const a = await fixture(t), b = await fixture(t);
  const authA = await bind(a, "account-a"), authB = await bind(b, "account-b");
  const seen = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, "error");
    if (url.endsWith("rate-limit-reset-credits")) return new Response("{}", { status: 404 });
    seen.push(options.headers["ChatGPT-Account-Id"]);
    const pct = options.headers["ChatGPT-Account-Id"] === "account-a" ? 21 : 78;
    return Response.json({ rate_limit: { primary_window: { used_percent: pct, reset_at: 4000000000, limit_window_seconds: 18000 } } });
  };
  const first = await getAccountLimits({ ...a, auth: authA, fetchImpl });
  const other = await getAccountLimits({ ...b, auth: authB, fetchImpl });
  assert.equal(first.primary_window.used_percent, 21); assert.equal(other.primary_window.used_percent, 78);
  await getAccountLimits({ ...a, auth: authA, fetchImpl });
  assert.deepEqual(seen, ["account-a", "account-b"]);
  const refreshed = await signIn(a, "account-a", 2);
  await getAccountLimits({ ...a, auth: refreshed, fetchImpl });
  assert.equal(seen.length, 3);
  assert.ok(!(await fs.readFile(path.join(a.dir, "limits.json"), "utf8")).includes(authA.accessToken));
});

test("Claude 429 cooldown survives refresh, stale quota is labelled, expiry makes no request", async (t) => {
  const f = await fixture(t, "claude"), auth = await bind(f);
  const now = Date.now();
  await getAccountLimits({ ...f, auth, now, fetchImpl: async () => Response.json({ five_hour: { utilization: 45, resets_at: "2090-01-01T00:00:00Z" } }) });
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response("", { status: 429, headers: { "retry-after": "120" } }); };
  const limited = await getAccountLimits({ ...f, auth, now: now + 1, forceRefresh: true, fetchImpl });
  assert.equal(limited.status, "cooldown"); assert.equal(limited.stale, true); assert.equal(limited.five_hour.utilization, 45);
  await getAccountLimits({ ...f, auth, now: now + 10, forceRefresh: true, fetchImpl });
  assert.equal(calls, 1);
  const expired = await getAccountLimits({ ...f, auth: { ...auth, expiresAt: now }, now, fetchImpl });
  assert.equal(expired.status, "auth_expired"); assert.equal(calls, 1);
});

test("deleting an unused account removes its private history and only its scoped Claude credential", async (t) => {
  const { deleteAccount, createAccount, listAccounts, accountPaths } = require("../src/lib/subscription-accounts");
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-delete-"));
  t.after(() => fs.rm(trackerDir, { recursive: true, force: true }));
  const account = await createAccount({ trackerDir, provider: "claude", label: "Remove" });
  const other = await createAccount({ trackerDir, provider: "codex", label: "Keep" });
  const calls = [];
  const result = await deleteAccount({ trackerDir, id: account.id, platform: "darwin", keychain: async (args) => { calls.push(args); return { found: false }; } });
  assert.equal(result.status, "deleted");
  assert.match(calls[0].service, /^Claude Code-credentials-[a-f0-9]{8}$/);
  assert.equal(calls[0].action, "delete"); assert.equal(calls[0].interactive, true);
  assert.deepEqual((await listAccounts({ trackerDir })).map((a) => a.id), [other.id]);
  await assert.rejects(fs.access(accountPaths(trackerDir, account.id).dir));
});

test("deletion blocks the current default and an account with a running session", async (t) => {
  const { deleteAccount, createAccount, listAccounts, accountPaths } = require("../src/lib/subscription-accounts");
  const { openLock } = require("../src/lib/fs");
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-delete-busy-"));
  t.after(() => fs.rm(trackerDir, { recursive: true, force: true }));
  const account = await createAccount({ trackerDir, provider: "codex", label: "Keep" });
  const lock = await openLock(path.join(accountPaths(trackerDir, account.id).dir, "runtime.lock"));
  assert.equal((await deleteAccount({ trackerDir, id: account.id })).reason, "account_busy");
  await lock.release();
  const root = path.join(trackerDir, "subscription-accounts", "defaults");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "codex.json"), JSON.stringify({ accountId: account.id }));
  assert.equal((await deleteAccount({ trackerDir, id: account.id })).reason, "default_account");
  assert.equal((await listAccounts({ trackerDir })).length, 1);
});
