const cp = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs/promises");
const { accountPaths, getAccount, createAccount, bindIdentity, privateDirectory } = require("./subscription-accounts");
const { readAccountAuth, accountEnvironment } = require("./subscription-account-auth");
const { resolveInvocation } = require("../commands/accounts");
const { openLock } = require("./fs");

const AUTH_ENDPOINTS = {
  codex: new Set(["https://auth.openai.com/oauth/authorize"]),
  claude: new Set(["https://claude.ai/oauth/authorize", "https://platform.claude.com/oauth/authorize", "https://console.anthropic.com/oauth/authorize"]),
};
const managers = new Map();

function authorizationUrl(output, provider) {
  // Keep split output chunks until a URL terminator arrives. Never forward
  // arbitrary URLs, terminal escape sequences, or raw CLI output to the UI.
  const plain = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  for (const match of plain.matchAll(/https:\/\/[^\s<>"']+(?=[\s<>"'])/g)) {
    try {
      const url = new URL(match[0]);
      if (AUTH_ENDPOINTS[provider]?.has(url.origin + url.pathname)
        && !url.username && !url.password
        && ["client_id", "redirect_uri", "state", "code_challenge"].every((key) => url.searchParams.has(key))) return url.href;
    } catch { /* incomplete or non-URL output */ }
  }
  return null;
}

function createLoginManager({ trackerDir, spawnImpl = cp.spawn, timeoutMs = 180000 }) {
  const sessions = new Map();
  const snapshot = (s) => ({ id: s.id, accountId: s.account.id, provider: s.account.provider,
    state: s.state, authorizeUrl: s.authorizeUrl, needsCode: s.needsCode, error: s.error, expiresAt: s.expiresAt });
  const get = (id) => {
    const s = sessions.get(id);
    if (!s) throw new Error("Login session expired");
    return s;
  };
  async function start({ id, provider, label, allowKeychain }) {
    let account = id ? await getAccount({ trackerDir, id }) : null;
    provider = account?.provider || provider;
    if (!["claude", "codex"].includes(provider)) throw new Error("Choose Claude or Codex");
    if (account?.archived || account?.invalidatedAt) throw new Error("Account unavailable for sign-in");
    const root = path.join(trackerDir, "subscription-accounts");
    await privateDirectory(root);
    const providerLock = await openLock(path.join(root, `oauth-${provider}.lock`), { quietIfLocked: true });
    if (!providerLock) throw new Error("Another authorization is already running for this provider");
    let runtimeLock;
    try {
      account ||= await createAccount({ trackerDir, provider, label, allowKeychain });
      runtimeLock = await openLock(path.join(accountPaths(trackerDir, account.id).dir, "runtime.lock"), { quietIfLocked: true });
      if (!runtimeLock) throw new Error("Close this account's CLI before signing in");
      if (await require("./subscription-account-global").usesDefaultLogin({ trackerDir, account })) throw new Error("Restore the previous local default before signing in to this managed account again");
    } catch (error) { if (runtimeLock) await runtimeLock.release(); await providerLock.release(); throw error; }
    const { runtimeHome } = accountPaths(trackerDir, account.id);
    const session = { id: crypto.randomBytes(16).toString("hex"), account, state: "starting", authorizeUrl: null,
      needsCode: false, error: null, expiresAt: Date.now() + timeoutMs, child: null, stopped: false };
    sessions.set(session.id, session);
    let output = "", timer, killTimer, finalizing = false;
    const terminate = (signal = "SIGTERM") => {
      const child = session.child;
      if (!child) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* process already exited */ }
    };
    const onProcessExit = () => terminate("SIGKILL");
    const finish = async (state, error = null) => {
      if (finalizing) return;
      finalizing = true;
      clearTimeout(timer); clearTimeout(killTimer);
      process.off("exit", onProcessExit);
      session.authorizeUrl = null; session.needsCode = false; output = "";
      session.child?.stdin?.destroy();
      session.state = "saving";
      try {
        if (state === "complete") {
          const auth = await readAccountAuth({ trackerDir, account });
          await bindIdentity({ trackerDir, id: account.id, identity: auth?.identity });
        }
        session.state = state; session.error = error;
      } catch { session.state = "failed"; session.error = "identity_failed"; }
      finally {
        await Promise.allSettled([runtimeLock.release(), providerLock.release()]);
        const expiry = setTimeout(() => sessions.delete(session.id), 600000); expiry.unref?.();
      }
    };
    session.stop = (reason) => {
      if (finalizing || session.stopped) return;
      session.stopped = true; session.state = "cancelling";
      session.error = reason; session.authorizeUrl = null;
      terminate();
      killTimer = setTimeout(() => terminate("SIGKILL"), 1500); killTimer.unref?.();
    };
    try {
      const env = accountEnvironment(account, await fs.realpath(runtimeHome));
      const args = account.provider === "claude" ? ["auth", "login", "--claudeai"] : ["login"];
      const invocation = await resolveInvocation(account.provider, args, env);
      session.child = spawnImpl(invocation.command, invocation.args, { env, shell: false,
        stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
      process.on("exit", onProcessExit);
      const append = (chunk) => {
        if (session.stopped || finalizing) return;
        output = (output + chunk.toString()).slice(-32768);
        const url = authorizationUrl(output, account.provider);
        if (url) { session.authorizeUrl = url; session.state = "waiting"; }
        session.needsCode = account.provider === "claude" && /(?:paste|enter)[^\n]{0,100}(?:code|authorization)/i.test(output);
      };
      session.child.stdout.on("data", append);
      session.child.stderr.on("data", append);
      session.child.once("error", () => { void finish("failed", "cli_unavailable"); });
      session.child.once("close", (code) => {
        void finish(session.stopped ? (session.error === "timeout" ? "failed" : "cancelled") : code === 0 ? "complete" : "failed",
          session.error || (code === 0 ? null : "authorization_failed"));
      });
      timer = setTimeout(() => session.stop("timeout"), timeoutMs); timer.unref?.();
    } catch { terminate("SIGKILL"); await finish("failed", "cli_unavailable"); }
    return snapshot(session);
  }
  return {
    start,
    active: () => [...sessions.values()].filter((s) => ["starting", "waiting", "saving", "cancelling"].includes(s.state)).map(snapshot),
    status: (id) => snapshot(get(id)),
    cancel: (id) => { const s = get(id); s.stop("cancelled"); return snapshot(s); },
    submitCode: (id, code) => {
      const s = get(id);
      if (s.state !== "waiting" || !s.needsCode || typeof code !== "string" || !/^[a-zA-Z0-9._~#-]{1,4096}$/.test(code.trim())) throw new Error("Invalid authorization code");
      s.child.stdin.write(code.trim() + "\n");
      s.needsCode = false;
      return snapshot(s);
    },
  };
}

function loginManager(trackerDir) {
  if (!managers.has(trackerDir)) managers.set(trackerDir, createLoginManager({ trackerDir }));
  return managers.get(trackerDir);
}

module.exports = { authorizationUrl, createLoginManager, loginManager };
