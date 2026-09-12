const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const { createLoginManager, authorizationUrl } = require("../src/lib/subscription-account-login");
const { getAccount, listAccounts } = require("../src/lib/subscription-accounts");

const url = (provider = "codex") => `https://${provider === "codex" ? "auth.openai.com" : "claude.ai"}/oauth/authorize?client_id=official&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=random&code_challenge=pkce`;
async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("Expected login transition did not occur");
}
async function fixture(t, options = {}) {
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-login-"));
  const children = [];
  const manager = createLoginManager({ trackerDir, ...options, spawnImpl: (command, args, config) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = (signal) => { queueMicrotask(() => child.emit("close", null, signal)); return true; };
    children.push({ child, command, args, config });
    return child;
  } });
  t.after(async () => { for (const { child } of children) child.emit("close", 1); await new Promise((r) => setTimeout(r, 30)); await fs.rm(trackerDir, { recursive: true, force: true }); });
  return { trackerDir, manager, children };
}

test("only complete official OAuth URLs are forwarded, never terminal output or lookalike hosts", () => {
  assert.equal(authorizationUrl(url(), "codex"), null);
  assert.equal(authorizationUrl(url() + "\n", "codex"), url());
  assert.equal(authorizationUrl(url().replace("auth.openai.com", "auth.openai.com.evil.invalid") + "\n", "codex"), null);
  assert.equal(authorizationUrl(url().replace("state=random&", "") + "\n", "codex"), null);
  assert.equal(authorizationUrl("secret token\nhttps://example.invalid\n", "claude"), null);
  assert.equal(authorizationUrl(url("claude") + "\n", "codex"), null);
});

test("browser login keeps stdin open, isolates the CLI, binds saved identity and releases locks", async (t) => {
  const f = await fixture(t);
  const session = await f.manager.start({ provider: "codex", label: "Work" });
  const { child, command, args, config } = f.children[0];
  assert.equal(command, "codex"); assert.deepEqual(args, ["login"]); assert.equal(config.shell, false);
  assert.equal(child.stdin.destroyed, false);
  assert.ok(config.env.CODEX_HOME.includes(session.accountId));
  child.stderr.write("Do not expose this token\n" + url().slice(0, 60));
  assert.equal(f.manager.status(session.id).authorizeUrl, null);
  child.stdout.write(url().slice(60) + "\n");
  assert.equal(f.manager.status(session.id).authorizeUrl, url());
  assert.ok(!JSON.stringify(f.manager.status(session.id)).includes("Do not expose"));
  const jwt = `h.${Buffer.from(JSON.stringify({ sub: "user", email: "work@example.invalid" })).toString("base64url")}.s`;
  await fs.writeFile(path.join(config.env.CODEX_HOME, "auth.json"), JSON.stringify({ tokens: { access_token: jwt, id_token: jwt, account_id: "account" } }));
  child.emit("close", 0);
  await until(() => f.manager.status(session.id).state === "complete");
  assert.equal(f.manager.status(session.id).authorizeUrl, null);
  assert.equal((await getAccount({ trackerDir: f.trackerDir, id: session.accountId })).identity.email, "work@example.invalid");
  await until(async () => { try { await fs.access(path.join(f.trackerDir, "subscription-accounts", "oauth-codex.lock")); return false; } catch { return true; } });
  const next = await f.manager.start({ id: session.accountId });
  f.manager.cancel(next.id);
  await until(() => f.manager.status(next.id).state === "cancelled");
});

test("one login per provider, cancellation and timeout release the provider without creating duplicate drafts", async (t) => {
  const f = await fixture(t, { timeoutMs: 60 });
  const first = await f.manager.start({ provider: "claude", label: "First" });
  await assert.rejects(f.manager.start({ provider: "claude", label: "Second" }), /already running/);
  assert.equal((await listAccounts(f)).length, 1);
  const { config, args } = f.children[0];
  assert.deepEqual(args, ["auth", "login", "--claudeai"]);
  assert.equal(config.env.CLAUDE_CONFIG_DIR, config.env.CLAUDE_SECURESTORAGE_CONFIG_DIR);
  await until(() => f.manager.status(first.id).state === "failed");
  assert.equal(f.manager.status(first.id).error, "timeout");
});

test("Claude code handoff is validated and successful process exit alone cannot register an account", async (t) => {
  const f = await fixture(t);
  const session = await f.manager.start({ provider: "claude", label: "Code" });
  const { child } = f.children[0];
  child.stdout.write(url("claude") + "\nPaste authorization code:\n");
  assert.equal(f.manager.status(session.id).needsCode, true);
  assert.throws(() => f.manager.submitCode(session.id, "code\ncommand"));
  f.manager.submitCode(session.id, "valid_code#state");
  assert.equal(child.stdin.read().toString(), "valid_code#state\n");
  child.emit("close", 0);
  await until(() => f.manager.status(session.id).state === "failed");
  assert.equal(f.manager.status(session.id).error, "identity_failed");
  assert.equal((await getAccount({ trackerDir: f.trackerDir, id: session.accountId })).identity, null);
});

test("missing CLI gives a sanitized terminal error and releases locks", async (t) => {
  const f = await fixture(t);
  const session = await f.manager.start({ provider: "codex", label: "Missing" });
  f.children[0].child.emit("error", new Error("ENOENT secret path"));
  await until(() => f.manager.status(session.id).state === "failed");
  assert.equal(f.manager.status(session.id).error, "cli_unavailable");
  assert.ok(!JSON.stringify(f.manager.status(session.id)).includes("secret"));
});

test("a real piped callback process survives until handoff and is terminated on cancellation", async (t) => {
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-login-process-"));
  let child;
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    process.stdout.write(${JSON.stringify(url("claude") + "\nPaste authorization code:\n")});
    process.stdin.once('data', () => {
      fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({oauthAccount:{accountUuid:'real-process-user', emailAddress:'callback@example.invalid'}}));
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `;
  const manager = createLoginManager({ trackerDir, spawnImpl: (_command, _args, config) => {
    child = spawn(process.execPath, ["-e", script], config); return child;
  } });
  t.after(async () => { child?.kill("SIGKILL"); await fs.rm(trackerDir, { recursive: true, force: true }); });
  const login = await manager.start({ provider: "claude", label: "Callback" });
  await until(() => manager.status(login.id).needsCode);
  assert.equal(child.exitCode, null);
  manager.submitCode(login.id, "code#state");
  await until(() => manager.status(login.id).state === "complete");
  assert.equal((await getAccount({ trackerDir, id: login.accountId })).identity.email, "callback@example.invalid");
  await until(async () => { try { await fs.access(path.join(trackerDir, "subscription-accounts", "oauth-claude.lock")); return false; } catch { return true; } });
  const next = await manager.start({ id: login.accountId });
  await until(() => manager.status(next.id).state === "waiting");
  const pid = child.pid;
  manager.cancel(next.id);
  await until(() => manager.status(next.id).state === "cancelled");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await until(async () => { try { await fs.access(path.join(trackerDir, "subscription-accounts", "oauth-claude.lock")); return false; } catch { return true; } });
});
