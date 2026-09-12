const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { getAccount, listAccounts, privateDirectory } = require("./subscription-accounts");
const { discoverSystemAccounts } = require("./subscription-system-accounts");
const { probeAccount } = require("./subscription-account-pool");
const { createSession, writeSession } = require("./subscription-account-sessions");

function terminalEnvironment(inherited = process.env) {
  const env = { ...inherited };
  // npm --prefix dashboard must not leak its project-specific npm environment
  // into Terminal's login shell (nvm rejects npm_config_prefix).
  for (const key of Object.keys(env)) if (/^npm_/i.test(key) || key === "INIT_CWD") delete env[key];
  return env;
}

function terminalScript({ args, cwd, platform, trackerDir }) {
  const parts = [process.execPath, path.resolve(__dirname, "../../bin/tracker.js"), "accounts", "--store", trackerDir, ...args];
  if (platform === "win32") {
    const quote = (s) => `'${s.replace(/'/g, "''")}'`;
    return `Remove-Item Env:npm_config_prefix,Env:NPM_CONFIG_PREFIX -ErrorAction SilentlyContinue\nSet-Location -LiteralPath ${quote(cwd)} -ErrorAction Stop\nRemove-Item -LiteralPath $PSCommandPath -ErrorAction SilentlyContinue\n& ${parts.map(quote).join(" ")}\nexit $LASTEXITCODE\n`;
  }
  const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  return `#!/bin/sh\nunset npm_config_prefix NPM_CONFIG_PREFIX\ncd -- ${quote(cwd)} || exit 1\nrm -f -- "$0"\nexec ${parts.map(quote).join(" ")}\n`;
}

async function launchInTerminal({ trackerDir, id, provider, auto = false, cwd = os.homedir(),
  platform = process.platform, runFile = promisify(execFile), spawnImpl = spawn,
  probe = (options) => probeAccount({ ...options, forceRefresh: false }) }) {
  if (typeof auto !== "boolean" || typeof cwd !== "string" || !path.isAbsolute(cwd) || /[\x00-\x1f\x7f]/.test(cwd)) throw new Error("Invalid launch options");
  const directory = await fs.realpath(cwd);
  if (!(await fs.stat(directory)).isDirectory()) throw new Error("Choose a project directory");
  let args;
  let selectedAccount;
  if (auto) {
    if (!["claude", "codex"].includes(provider)) throw new Error("Invalid provider");
    const candidates = (await listAccounts({ trackerDir })).filter((a) => a.provider === provider && a.identity && !a.archived && !a.invalidatedAt);
    const issues = [];
    let available = false;
    const deadline = Date.now() + 20000;
    for (const account of candidates) {
      if (Date.now() >= deadline) break;
      let result;
      try { result = await probe({ trackerDir, account }); } catch { result = { state: "unknown", reason: "quota_unknown" }; }
      if (result.state === "available") { available = true; selectedAccount = account; break; }
      issues.push({ id: account.id, reason: result.reason || result.state });
    }
    if (!available) return { status: "blocked", issues };
    args = ["auto", provider];
  } else if (["system-claude", "system-codex"].includes(id)) {
    if (!(await discoverSystemAccounts()).some((a) => a.id === id)) throw new Error("Local account no longer available");
    args = ["run-default", id.slice(7)];
  } else {
    const account = await getAccount({ trackerDir, id });
    if (!account.identity || account.archived || account.invalidatedAt) throw new Error("Sign in before launching");
    const global = await require("./subscription-account-global").globalAccountStatus({ trackerDir, provider: account.provider });
    if (global.activeAccountId === account.id) args = ["run-default", account.provider];
    else {
      if (global.managedAccountId === account.id || global.state === "recovery_required") return { status: "blocked", issues: [{ id, reason: "default_changed" }] };
      args = ["run", account.id]; selectedAccount = account;
    }
  }
  const session = selectedAccount?.provider === "claude"
    ? await createSession({ trackerDir, accountId: selectedAccount.id, provider: "claude", cwd: directory, auto }) : null;
  if (session) args = ["session", session.id];
  const root = path.join(trackerDir, "subscription-accounts", "launches");
  await privateDirectory(root);
  const file = path.join(root, crypto.randomBytes(16).toString("hex") + (platform === "win32" ? ".ps1" : ".command"));
  await fs.writeFile(file, terminalScript({ args, cwd: directory, trackerDir, platform }), { mode: 0o700, flag: "wx" });
  try {
    const options = { timeout: 10000, maxBuffer: 65536, windowsHide: true, env: terminalEnvironment() };
    // A fresh Terminal instance also avoids an already-running instance's
    // inherited npm prefix; its existing tabs and Claude sessions stay intact.
    if (platform === "darwin") await runFile("/usr/bin/open", ["-n", "-a", "Terminal", file], options);
    else if (platform === "win32") {
      // Start-Process returns after opening the interactive console. All data
      // lives in a private generated script; no user command text is accepted.
      const quote = (s) => `'${s.replace(/'/g, "''")}'`;
      await runFile("powershell.exe", ["-NoProfile", "-Command", `Start-Process powershell.exe -ArgumentList @('-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File',${quote('"' + file + '"')})`], options);
    } else if (platform === "linux") await new Promise((resolve, reject) => {
      // Some terminals remain attached for the whole interactive session.
      // A launcher timeout must never terminate the user's running CLI.
      const child = spawnImpl("x-terminal-emulator", ["-e", "/bin/sh", file], { detached: true, stdio: "ignore", shell: false, env: terminalEnvironment() });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
    else throw new Error("Unsupported desktop");
    return { status: "dispatched", ...(session ? { sessionId: session.id } : {}) };
  } catch {
    await fs.rm(file, { force: true });
    if (session) await writeSession(trackerDir, { ...session, state: "failed", error: "terminal_failed" });
    throw new Error("Could not open a terminal");
  }
}

module.exports = { launchInTerminal, terminalScript, terminalEnvironment };
