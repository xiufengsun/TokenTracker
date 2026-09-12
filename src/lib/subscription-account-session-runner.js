const fs = require("node:fs/promises");
const path = require("node:path");
const cp = require("node:child_process");
const { promisify } = require("node:util");
const { accountPaths, getAccount, listAccounts, readOptionalJson } = require("./subscription-accounts");
const { readAccountAuth, identityMatches, accountEnvironment } = require("./subscription-account-auth");
const { openLock } = require("./fs");
const { readSession, sessionPaths, writeSession } = require("./subscription-account-sessions");
const { transferClaudeSession, transcriptFiles } = require("./subscription-account-transcripts");
const { probeAccount, quotaAvailability } = require("./subscription-account-pool");
const { getAccountLimits } = require("./subscription-account-usage");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForExit(exit, ms) {
  let timer;
  try { await Promise.race([exit, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]); }
  finally { clearTimeout(timer); }
}

async function verifyClaudeLogin({ trackerDir, account, runFile = promisify(cp.execFile) }) {
  const { resolveInvocation } = require("../commands/accounts");
  const home = await fs.realpath(accountPaths(trackerDir, account.id).runtimeHome);
  const env = accountEnvironment(account, home);
  const invocation = await resolveInvocation("claude", ["auth", "status"], env);
  try {
    const { stdout } = await runFile(invocation.command, invocation.args, { env, timeout: 15000, maxBuffer: 65536, windowsHide: true });
    const status = JSON.parse(stdout);
    if (status.loggedIn !== true || status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty"
      || (account.identity.email && status.email !== account.identity.email)) throw new Error("Wrong CLI login");
  } catch { throw new Error("auth_unavailable"); }
}

// This controller owns only its own child. Web requests are a private mailbox,
// never an arbitrary PID/shell command. SIGTERM -> wait -> --resume keeps the
// same Terminal and conversation while changing the actual child's auth home.
async function runManagedClaude({ trackerDir, sessionId, spawnImpl = cp.spawn,
  probe = probeAccount, quotaReader = getAccountLimits, quotaIntervalMs = 60000,
  verify = verifyClaudeLogin, settleMs = 1500, pollMs = 500, stopTimeoutMs = 10000 }) {
  let session = await readSession({ trackerDir, sessionId });
  if (session.provider !== "claude" || session.state !== "starting") throw new Error("Session cannot be started again");
  const paths = sessionPaths(trackerDir, sessionId);
  const controllerLock = await openLock(path.join(paths.dir, "controller.lock"), { quietIfLocked: true });
  if (!controllerLock) throw new Error("Session is already controlled");
  let current = null;
  let currentLock = null;
  let stopping = false;
  let heartbeat;
  let lastQuotaCheck = Date.now();
  let lastProbeState = null;
  let writes = Promise.resolve();
  const publish = (patch) => {
    session = { ...session, ...patch, heartbeatAt: new Date().toISOString() };
    const snapshot = { ...session };
    writes = writes.catch(() => {}).then(() => writeSession(trackerDir, snapshot));
    return writes;
  };
  const forward = (signal) => { stopping = true; current?.child.kill(signal); };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);

  async function reserve(id) {
    const account = await getAccount({ trackerDir, id });
    if (account.provider !== "claude" || account.archived || account.invalidatedAt || !account.identity) throw new Error("account_unavailable");
    const auth = await readAccountAuth({ trackerDir, account });
    if (!identityMatches(account, auth)) throw new Error("identity_mismatch");
    const lock = await openLock(path.join(accountPaths(trackerDir, id).dir, "runtime.lock"), { quietIfLocked: true });
    if (!lock) throw new Error("busy");
    try {
      if (await require("./subscription-account-global").usesDefaultLogin({ trackerDir, account })) throw new Error("default_account");
      await verify({ trackerDir, account });
    } catch (error) { await lock.release(); throw error; }
    return { account, lock };
  }
  async function start(account) {
    const { resolveInvocation } = require("../commands/accounts");
    if (!identityMatches(account, await readAccountAuth({ trackerDir, account }))) throw new Error("identity_mismatch");
    const home = await fs.realpath(accountPaths(trackerDir, account.id).runtimeHome);
    const resume = (await transcriptFiles(home, session.conversationId)).length > 0;
    const args = [resume ? "--resume" : "--session-id", session.conversationId];
    const env = accountEnvironment(account, home);
    const invocation = await resolveInvocation("claude", args, env);
    const child = spawnImpl(invocation.command, invocation.args, { cwd: session.cwd, env, stdio: "inherit", shell: false });
    const state = { child, account, exited: false, code: null };
    state.exit = new Promise((resolve) => {
      child.once("error", () => { state.exited = true; state.code = 1; resolve(1); });
      child.once("exit", (code, signal) => {
        state.exited = true; state.code = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1); resolve(state.code);
      });
    });
    if (stopping) child.kill("SIGTERM");
    await waitForExit(state.exit, settleMs);
    return state;
  }
  async function switchTo(accountId, requestId) {
    let target;
    const outgoing = current;
    const oldLock = currentLock;
    try {
      await publish({ state: "switching", targetAccountId: accountId, requestId, switchResult: null, error: null });
      const account = await getAccount({ trackerDir, id: accountId });
      const available = await probe({ trackerDir, account, forceRefresh: false });
      // Manual switching can proceed without quota-read permission after the
      // official CLI verifies its own login. Automatic rotation requires
      // positively available quota and never guesses from an unknown response.
      const manualUnknown = requestId && available.state === "unknown" && available.reason !== "identity_mismatch";
      if (available.state !== "available" && !manualUnknown) {
        await publish({ state: "running", targetAccountId: null, error: available.reason || available.state, requestId, switchResult: "blocked" }); return;
      }
      target = await reserve(accountId);
      if (!outgoing.exited) {
        outgoing.child.kill("SIGTERM");
        await waitForExit(outgoing.exit, stopTimeoutMs);
        if (!outgoing.exited) {
          await publish({ state: "running", targetAccountId: null, switchResult: "blocked", error: "stop_timeout" }); return;
        }
      }
      if (stopping) return;
      await transferClaudeSession({ trackerDir, from: outgoing.account.id, to: accountId, sessionId: session.conversationId });
      const next = await start(target.account);
      current = next;
      if (next.exited) throw new Error("launch_failed");
      currentLock = target.lock; target = null;
      await oldLock.release();
      await publish({ state: "running", accountId, childPid: next.child.pid, targetAccountId: null, switchResult: "complete", error: null });
    } catch {
      if (current !== outgoing && !current.exited) {
        // The new child is already live; a receipt/lease write error must not
        // start a second process against either account.
        await publish({ state: "running", accountId: current.account.id, childPid: current.child.pid,
          targetAccountId: null, requestId, error: "controller_error" });
        return;
      }
      // The old home is never modified during the forward transfer. If the new
      // CLI made a transcript before failing, recover those appended records too.
      if (outgoing.exited && !stopping) {
        try {
          if (current !== outgoing) await transferClaudeSession({ trackerDir, from: accountId, to: outgoing.account.id, sessionId: session.conversationId });
          await verify({ trackerDir, account: outgoing.account });
          current = await start(outgoing.account);
          await publish({ state: current.exited ? "failed" : "running", accountId: outgoing.account.id,
            childPid: current.child.pid, targetAccountId: null, requestId, switchResult: "restored", error: "switch_failed" });
        } catch { await publish({ state: "failed", targetAccountId: null, requestId, error: "restore_failed" }); }
      } else await publish({ state: "running", targetAccountId: null, requestId, switchResult: "blocked", error: "switch_failed" });
    } finally { if (target) await target.lock.release(); }
  }
  try {
    const reserved = await reserve(session.accountId); currentLock = reserved.lock;
    await publish({ pid: process.pid, state: "starting", error: null });
    // The heartbeat continues while a quota fetch / graceful shutdown is pending.
    heartbeat = setInterval(() => { void publish({}).catch(() => {}); }, 2000);
    current = await start(reserved.account);
    if (current.exited && (!session.auto || [0, 130, 143].includes(current.code))) {
      await publish({ state: current.code === 0 ? "stopped" : "failed", exitCode: current.code, error: current.code === 0 ? null : "launch_failed" }); return current.code;
    }
    await publish({ state: current.exited ? "switching" : "running", childPid: current.child.pid });
    while (!stopping) {
      const request = await readOptionalJson(paths.request);
      if (request) {
        await fs.rm(paths.request, { force: true });
        if (Date.now() - request.createdAt < 30000) {
          if (typeof request.auto === "boolean") await publish({ auto: request.auto, requestId: request.id, error: null });
          else if (request.accountId !== current.account.id) await switchTo(request.accountId, request.id);
        }
      }
      if (session.state === "failed") break;
      const exited = current.exited;
      if (exited && [0, 130, 143].includes(current.code)) break;
      if (session.auto && (exited || Date.now() - lastQuotaCheck >= quotaIntervalMs)) {
        lastQuotaCheck = Date.now();
        try {
          const auth = await readAccountAuth({ trackerDir, account: current.account });
          lastProbeState = quotaAvailability("claude", await quotaReader({ trackerDir, account: current.account, auth, forceRefresh: true })).state;
        } catch { lastProbeState = "unknown"; }
        if (lastProbeState === "exhausted") {
          const candidates = (await listAccounts({ trackerDir })).filter((a) => a.provider === "claude" && a.id !== current.account.id && a.identity && !a.archived && !a.invalidatedAt);
          let target = null;
          for (const account of candidates) {
            try { if ((await probe({ trackerDir, account, forceRefresh: false })).state === "available") { target = account; break; } } catch { /* next eligible */ }
          }
          if (target) { await switchTo(target.id, null); if (!current.exited) continue; }
          else await publish({ error: "pool_empty" });
        }
      }
      if (current.exited) break;
      await Promise.race([current.exit, delay(pollMs)]);
    }
    if (!current.exited) await current.exit;
    await publish({ state: current.code === 0 || stopping ? "stopped" : "failed", exitCode: current.code, targetAccountId: null });
    return current.code;
  } catch {
    // A controller error must not abandon a live child and release its account
    // lease. Keep ownership until this specific child finishes.
    if (current && !current.exited) {
      await publish({ state: "running", error: "controller_error" });
      await current.exit;
    }
    await publish({ state: "failed", error: "launch_failed" });
    return 1;
  } finally {
    clearInterval(heartbeat);
    await writes.catch(() => {});
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
    if (currentLock) await currentLock.release();
    await controllerLock.release();
  }
}

module.exports = { runManagedClaude, verifyClaudeLogin };
