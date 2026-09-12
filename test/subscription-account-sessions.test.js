const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createAccount, accountPaths } = require("../src/lib/subscription-accounts");
const { transferClaudeSession, ownedTranscript } = require("../src/lib/subscription-account-transcripts");
const { createSession, listSessions, requestSwitch, sessionPaths, writeSession } = require("../src/lib/subscription-account-sessions");
const { runManagedClaude, verifyClaudeLogin } = require("../src/lib/subscription-account-session-runner");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

async function until(read, predicate) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { const result = await read(); if (predicate(result)) return result; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail("Timed out waiting for session state");
}
async function signIn(f) {
  for (const account of [f.a, f.b]) {
    const home = accountPaths(f.trackerDir, account.id).runtimeHome;
    await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: account.id, organizationUuid: "org" } }));
    const auth = await require("../src/lib/subscription-account-auth").readAccountAuth({ ...f, account });
    await require("../src/lib/subscription-accounts").bindIdentity({ ...f, id: account.id, identity: auth.identity });
  }
}

async function fixture(t) {
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-sessions-"));
  t.after(() => fs.rm(trackerDir, { recursive: true, force: true }));
  const a = await createAccount({ trackerDir, provider: "claude", label: "A" });
  const b = await createAccount({ trackerDir, provider: "claude", label: "B" });
  return { trackerDir, a, b };
}
const sessionId = "11111111-2222-4333-8444-555555555555";

test("resume transfers one conversation, and excludes inherited usage across A-B-A", async (t) => {
  const f = await fixture(t);
  const relative = path.join("projects", "-project", sessionId + ".jsonl");
  const source = path.join(accountPaths(f.trackerDir, f.a.id).runtimeHome, relative);
  const target = path.join(accountPaths(f.trackerDir, f.b.id).runtimeHome, relative);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'A turn\n');
  await fs.writeFile(path.join(path.dirname(source), "unrelated.jsonl"), "private\n");
  assert.equal(await transferClaudeSession({ ...f, from: f.a.id, to: f.b.id, sessionId }), true);
  assert.equal((await ownedTranscript({ trackerDir: f.trackerDir, id: f.b.id, file: target })).toString(), "");
  await assert.rejects(fs.access(path.join(path.dirname(target), "unrelated.jsonl")));
  await fs.appendFile(target, "B turn\n");
  await transferClaudeSession({ ...f, from: f.b.id, to: f.a.id, sessionId });
  await fs.appendFile(source, "A again\n");
  assert.equal((await ownedTranscript({ trackerDir: f.trackerDir, id: f.a.id, file: source })).toString(), "A turn\nA again\n");
  assert.equal((await ownedTranscript({ trackerDir: f.trackerDir, id: f.b.id, file: target })).toString(), "B turn\n");
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
});

test("usage totals count each account's own turns exactly once after resuming back and forth", async (t) => {
  const f = await fixture(t); await signIn(f);
  const { scanAccountUsage } = require("../src/lib/subscription-account-usage");
  const { getAccount } = require("../src/lib/subscription-accounts");
  const relative = path.join("projects", "project", sessionId + ".jsonl");
  const source = path.join(accountPaths(f.trackerDir, f.a.id).runtimeHome, relative);
  const target = path.join(accountPaths(f.trackerDir, f.b.id).runtimeHome, relative);
  const line = (id, tokens) => JSON.stringify({ timestamp: "2026-09-11T01:00:00.000Z", message: { id, model: "claude-sonnet-4-5", usage: { input_tokens: tokens, output_tokens: 10 } } }) + "\n";
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, line("a1", 100));
  await transferClaudeSession({ ...f, from: f.a.id, to: f.b.id, sessionId });
  await fs.appendFile(target, line("b1", 200));
  await transferClaudeSession({ ...f, from: f.b.id, to: f.a.id, sessionId });
  await fs.appendFile(source, line("a2", 300));
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.equal((await scanAccountUsage({ ...f, account: await getAccount({ ...f, id: f.a.id }) })).totalTokens, 420);
    assert.equal((await scanAccountUsage({ ...f, account: await getAccount({ ...f, id: f.b.id }) })).totalTokens, 210);
  }
});

test("transfer refuses conflicting histories and symlink traversal", async (t) => {
  const f = await fixture(t);
  const sourceHome = accountPaths(f.trackerDir, f.a.id).runtimeHome;
  const targetHome = accountPaths(f.trackerDir, f.b.id).runtimeHome;
  await fs.mkdir(path.join(sourceHome, "projects", "p"), { recursive: true });
  await fs.mkdir(path.join(targetHome, "projects", "p"), { recursive: true });
  const name = sessionId + ".jsonl";
  await fs.writeFile(path.join(sourceHome, "projects", "p", name), "source\n");
  await fs.writeFile(path.join(targetHome, "projects", "p", name), "different\n");
  await assert.rejects(transferClaudeSession({ ...f, from: f.a.id, to: f.b.id, sessionId }));
  await assert.rejects(transferClaudeSession({ ...f, from: f.a.id, to: f.b.id, sessionId: "../escape" }));
  await fs.rm(path.join(targetHome, "projects", "p"), { recursive: true });
  await fs.symlink(sourceHome, path.join(targetHome, "projects", "p"));
  await assert.rejects(transferClaudeSession({ ...f, from: f.a.id, to: f.b.id, sessionId }));
});

test("session status distinguishes pending, running and expired; stale sessions cannot switch", async (t) => {
  const f = await fixture(t);
  const session = await createSession({ ...f, accountId: f.a.id, provider: "claude", cwd: f.trackerDir, auto: false });
  assert.equal((await listSessions(f))[0].state, "starting");
  await writeSession(f.trackerDir, { ...session, state: "running", pid: process.pid, heartbeatAt: new Date().toISOString() });
  assert.equal((await listSessions(f))[0].state, "running");
  await writeSession(f.trackerDir, { ...session, state: "running", pid: process.pid, heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  assert.equal((await listSessions(f))[0].state, "disconnected");
  await assert.rejects(requestSwitch({ ...f, sessionId: session.id, accountId: f.b.id }));
  await assert.rejects(fs.access(sessionPaths(f.trackerDir, session.id).request));
});

test("official CLI login verification rejects API billing and a different account", async (t) => {
  const f = await fixture(t);
  const account = { ...f.a, identity: { email: "chosen@example.invalid" } };
  let status = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: account.identity.email };
  const runFile = async (_command, args, options) => {
    assert.deepEqual(args, ["auth", "status"]);
    assert.ok(options.env.CLAUDE_CONFIG_DIR.includes(account.id));
    return { stdout: JSON.stringify(status) };
  };
  await verifyClaudeLogin({ ...f, account, runFile });
  status = { ...status, email: "other@example.invalid" };
  await assert.rejects(verifyClaudeLogin({ ...f, account, runFile }), /auth_unavailable/);
  status = { ...status, email: account.identity.email, authMethod: "api_key" };
  await assert.rejects(verifyClaudeLogin({ ...f, account, runFile }), /auth_unavailable/);
});

test("a live child is restarted in the same conversation under B; failed switch restores A", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX graceful shutdown fixture");
  const f = await fixture(t); await signIn(f);
  const session = await createSession({ ...f, accountId: f.a.id, provider: "claude", cwd: f.trackerDir, auto: false });
  const children = [];
  let failTarget = true;
  const invocations = [];
  const runner = runManagedClaude({ ...f, sessionId: session.id, settleMs: 100, pollMs: 20,
    verify: async () => {}, probe: async () => ({ state: "unknown", reason: "credentials_unavailable" }), spawnImpl: (_command, args, options) => {
      invocations.push({ args, home: options.env.CLAUDE_CONFIG_DIR });
      if (options.env.CLAUDE_CONFIG_DIR.includes(f.b.id) && failTarget) {
        const child = new EventEmitter(); child.kill = () => {}; queueMicrotask(() => child.emit("error", new Error("test launch failure"))); return child;
      }
      const child = spawn(process.execPath, ["-e", `const fs=require('fs'),path=require('path');const root=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','project');fs.mkdirSync(root,{recursive:true});fs.appendFileSync(path.join(root,process.argv[1]+'.jsonl'),'fixture turn\\n');process.on('SIGTERM',()=>process.exit(0));process.send('ready');setInterval(()=>{},1000);`, session.conversationId], { ...options, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.ready = new Promise((resolve) => child.once("message", resolve));
      children.push(child); return child;
    } });
  t.after(async () => { children.forEach((child) => child.kill("SIGTERM")); await runner; });
  const read = async () => (await listSessions(f))[0];
  await until(read, (s) => s.state === "running");
  await children.at(-1).ready;
  await requestSwitch({ ...f, sessionId: session.id, accountId: f.b.id });
  const restored = await until(read, (s) => s.switchResult === "restored");
  assert.equal(restored.accountId, f.a.id); assert.equal(restored.state, "running");
  await children.at(-1).ready;
  assert.equal(children[0].exitCode, 0);
  failTarget = false;
  await requestSwitch({ ...f, sessionId: session.id, accountId: f.b.id });
  const switched = await until(read, (s) => s.switchResult === "complete");
  await children.at(-1).ready;
  assert.equal(switched.accountId, f.b.id);
  assert.equal(switched.childPid, children.at(-1).pid);
  assert.ok(invocations.at(-1).home.includes(f.b.id));
  assert.deepEqual(invocations.at(-1).args, ["--resume", session.conversationId]);
  assert.equal(children.at(-2).exitCode, 0);
  children.at(-1).kill("SIGTERM");
  assert.equal(await runner, 0);
  assert.equal((await read()).state, "stopped");
});

test("confirmed exhaustion rotates an open session; unknown quota leaves its process alone", async (t) => {
  const f = await fixture(t); await signIn(f);
  const session = await createSession({ ...f, accountId: f.a.id, provider: "claude", cwd: f.trackerDir, auto: true });
  const children = [];
  let exhausted = false;
  const runner = runManagedClaude({ ...f, sessionId: session.id, settleMs: 5, pollMs: 5, quotaIntervalMs: 10,
    verify: async () => {},
    probe: async () => ({ state: "available" }),
    quotaReader: async ({ account }) => exhausted && account.id === f.a.id
      ? { status: "ok", five_hour: { utilization: 100, resets_at: new Date(Date.now() + 3600000).toISOString() } }
      : { status: "unavailable" },
    spawnImpl: (_command, args, options) => {
      const child = new EventEmitter(); child.pid = 9000 + children.length;
      child.kill = (signal) => { queueMicrotask(() => child.emit("exit", 0, signal)); return true; };
      children.push({ child, args, home: options.env.CLAUDE_CONFIG_DIR }); return child;
    } });
  t.after(async () => { children.at(-1)?.child.kill("SIGTERM"); await runner; });
  const read = async () => (await listSessions(f))[0];
  await until(read, (s) => s.state === "running");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(children.length, 1);
  exhausted = true;
  const switched = await until(read, (s) => s.accountId === f.b.id && s.state === "running");
  assert.equal(switched.switchResult, "complete");
  assert.equal(children.length, 2);
  assert.ok(children[1].home.includes(f.b.id));
  await requestSwitch({ ...f, sessionId: session.id, auto: false });
  await until(read, (s) => s.auto === false);
  children[1].child.kill("SIGTERM");
  assert.equal(await runner, 0);
});
