const path = require("node:path");
const fs = require("node:fs/promises");
const cp = require("node:child_process");
const { resolveTrackerPaths } = require("../lib/tracker-paths");
const { accountPaths, createAccount, listAccounts, getAccount, updateAccount, bindIdentity, invalidateAccount } = require("../lib/subscription-accounts");
const { readAccountAuth, identityMatches, accountEnvironment } = require("../lib/subscription-account-auth");
const { openLock } = require("../lib/fs");

function validateRunArgs(args, provider) {
  // Config/profile/backend flags can silently override the selected subscription.
  // Login/logout must go through the guarded login command instead.
  if (args.some((arg) => /^(?:-c.*|--(?:config|profile|settings|setting-sources|oss|local-provider|remote|api-key|auth-token)(?:=|$)|login$|logout$|auth$)/.test(arg)
    || (provider === "codex" && /^-p/.test(arg)))) {
    throw new Error("Account launches cannot override authentication, configuration or backend; use accounts login to authenticate");
  }
}

async function resolveInvocation(provider, args, env, platform = process.platform) {
  if (platform !== "win32") return { command: provider, args };
  // Native .exe installs and known npm entrypoints only. Never send arbitrary
  // user arguments through cmd.exe's shell re-parsing of .cmd shims.
  const parts = (env.PATH || env.Path || "").split(path.delimiter);
  for (const dir of parts) {
    const exe = path.join(dir, provider + ".exe");
    try { await fs.access(exe); return { command: exe, args }; } catch { /* next */ }
    const entry = provider === "codex"
      ? path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js")
      : path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    try { await fs.access(entry); return { command: process.execPath, args: [entry, ...args] }; } catch { /* next */ }
  }
  throw new Error(`Install the ${provider} CLI before launching this account`);
}

async function launchAccount({ trackerDir, id, login = false, args = [], spawnImpl = cp.spawn }) {
  const account = await getAccount({ trackerDir, id });
  if (account.archived) throw new Error("Restore this account before launching it");
  if (account.invalidatedAt) throw new Error("This account's history has mixed identities; archive it and add a fresh account");
  const { dir, runtimeHome } = accountPaths(trackerDir, id);
  const lock = await openLock(path.join(dir, "runtime.lock"), { quietIfLocked: true });
  if (!lock) throw new Error("This account already has a managed CLI running; close it before launching or logging in again");
  try {
    if (await require("../lib/subscription-account-global").usesDefaultLogin({ trackerDir, account })) throw new Error("This account is the local default. Start the official CLI normally, or restore the previous default before using an isolated session.");
    if (!login) {
      validateRunArgs(args, account.provider);
      const auth = await readAccountAuth({ trackerDir, account });
      if (!identityMatches(account, auth)) {
        if (auth?.identity?.key && account.identity) await invalidateAccount({ trackerDir, id });
        throw new Error("Account identity does not match. Complete accounts login or add a separate account");
      }
    }
    const env = accountEnvironment(account, await fs.realpath(runtimeHome));
    const cliArgs = login ? (account.provider === "claude" ? ["auth", "login", "--claudeai"] : ["login"]) : args;
    const invocation = await resolveInvocation(account.provider, cliArgs, env);
    const status = await new Promise((resolve, reject) => {
      const child = spawnImpl(invocation.command, invocation.args, { env, stdio: "inherit", shell: false });
      const forward = (signal) => child.kill(signal);
      const interrupt = () => forward("SIGINT");
      const terminate = () => forward("SIGTERM");
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
      child.once("error", () => { cleanup(); reject(new Error(`Could not launch ${account.provider}; check that its CLI is installed`)); });
      child.once("exit", (code, signal) => { cleanup(); resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)); });
    });
    if (status !== 0) return status;
    const auth = await readAccountAuth({ trackerDir, account });
    if (login) await bindIdentity({ trackerDir, id, identity: auth?.identity });
    else if (!identityMatches(account, auth)) {
      if (auth?.identity?.key) await invalidateAccount({ trackerDir, id });
      throw new Error("Account identity changed during the session; usage attribution is paused");
    }
    return 0;
  } finally { await lock.release(); }
}

async function cmdAccounts(argv) {
  let { trackerDir } = await resolveTrackerPaths();
  if (argv[0] === "--store") {
    if (!path.isAbsolute(argv[1] || "")) throw new Error("Account store must be an absolute path");
    trackerDir = argv[1]; argv = argv.slice(2);
  }
  const [action = "list", id, ...rest] = argv;
  if (action === "add") {
    const allowKeychain = rest.includes("--allow-keychain");
    const label = rest.filter((v) => v !== "--allow-keychain").join(" ");
    const account = await createAccount({ trackerDir, provider: id, label, allowKeychain });
    process.stdout.write(`Account created: ${account.id}\nLogin: tokentracker accounts login ${account.id}\nRun: tokentracker accounts run ${account.id}\n`);
  } else if (action === "list") {
    const accounts = await listAccounts({ trackerDir });
    for (const a of accounts) process.stdout.write(`${a.id}\t${a.provider}\t${a.label}\t${a.archived ? "archived" : a.identity ? "registered" : "login required"}\n`);
    if (!accounts.length) process.stdout.write("No accounts. Add one with: tokentracker accounts add <claude|codex> <label>\n");
  } else if (action === "session") {
    if (rest.length) throw new Error("Unexpected session arguments");
    process.exitCode = await require("../lib/subscription-account-session-runner").runManagedClaude({ trackerDir, sessionId: id });
  } else if (action === "run-default") {
    if (!["claude", "codex"].includes(id) || rest.length) throw new Error("Choose Claude or Codex");
    const invocation = await resolveInvocation(id, [], process.env);
    process.exitCode = await new Promise((resolve, reject) => {
      const child = cp.spawn(invocation.command, invocation.args, { stdio: "inherit", shell: false });
      child.once("error", () => reject(new Error("Could not start the official CLI")));
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } else if (action === "auto") {
    const { runAccountPool } = require("../lib/subscription-account-pool");
    const nextLaunchOnly = rest[0] === "--next-launch-only";
    const poolArgs = nextLaunchOnly ? rest.slice(1) : rest;
    process.exitCode = await runAccountPool({ trackerDir, provider: id, nextLaunchOnly,
      args: poolArgs[0] === "--" ? poolArgs.slice(1) : poolArgs });
  } else if (action === "login" || action === "run") {
    process.exitCode = await launchAccount({ trackerDir, id, login: action === "login", args: rest[0] === "--" ? rest.slice(1) : rest });
  } else if (action === "rename" || action === "archive" || action === "restore") {
    await updateAccount({ trackerDir, id, ...(action === "rename" ? { label: rest.join(" ") } : { archived: action === "archive" }) });
  } else if (action === "--help" || action === "help") {
    process.stdout.write("accounts add <claude|codex> <label> [--allow-keychain]\naccounts list\naccounts login <id>\naccounts run <id> [-- CLI arguments]\naccounts auto <claude|codex> [--next-launch-only] [-- CLI arguments]\naccounts rename <id> <label>\naccounts archive|restore <id>\n\nEach account uses an isolated CLI home. On macOS, --allow-keychain explicitly permits reading only this account's Claude Keychain item for limits. No system login is imported.\nAuto mode skips exhausted/unknown accounts and starts the next account only after an unsuccessful exit with confirmed quota exhaustion. It starts a new session and does not transfer conversation context. Ctrl-C and successful completion stop the pool.\n");
  } else throw new Error("Unknown accounts command; use accounts --help");
}

module.exports = { cmdAccounts, launchAccount, validateRunArgs, resolveInvocation };
