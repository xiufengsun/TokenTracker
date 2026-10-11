"use strict";

// Shared command runner for local-CLI limit providers.
//
// Extracted from usage-limits.js (which keeps a require of it) so
// ark-coding-plan-limits.js and future providers don't have to copy it.
// This is a superset of both former copies: the original's `completeWhen`
// early-settlement hook, plus the hardening that previously only lived in
// the ark copy — an abort `signal` wired into the spawn lifecycle, a
// `platform` override with `where.exe` discovery on native Windows, and a
// byte-capped maxBuffer for piped spawn output.

const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Run a command without a shell by default, optionally piping options.input to stdin. */
function runCommand(commandRunner, command, args, options = {}) {
  const merged = {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    useShell: false,
    ...options,
  };
  if (typeof commandRunner === "function") {
    return Promise.resolve(commandRunner(command, args, merged));
  }

  const {
    timeout,
    maxBuffer,
    input,
    completeWhen,
    completionGraceMs = 250,
    killProcessGroup = false,
    platform = process.platform,
    signal,
    useShell = false,
    ...spawnOptions
  } = merged;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      const error = new Error(`spawn ${command} aborted`);
      error.name = "AbortError";
      resolve({ status: null, stdout: "", stderr: "", error });
      return;
    }

    const useProcessGroup = killProcessGroup && platform !== "win32";
    // `useShell` is opt-in per call site. It exists for npm's Windows .cmd
    // shims, which Node's spawn cannot execute directly — but shell
    // execution means cmd.exe re-parses the joined command line, so any
    // argument carrying shell metacharacters (e.g. a powershell -Command
    // script with `|`) would be split. Default false keeps direct spawns,
    // which is what every pre-existing usage-limits call site expects.
    // Under shell execution quote the command unconditionally: cmd.exe
    // metacharacters are not limited to whitespace (`C:\Users\a&b\...`
    // has none yet splits at `&`), and Windows account names allow them.
    const shellCommand = useShell && !command.startsWith('"')
      ? `"${command}"`
      : command;
    let child;
    try {
      child = cp.spawn(shellCommand, args, {
        ...spawnOptions,
        detached: useProcessGroup || spawnOptions.detached,
        shell: useShell,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error });
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let timer = null;
    let hardTimer = null;
    let completionTimer = null;
    let abortListener = null;

    const settle = ({ status = null, error = null } = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      if (completionTimer) clearTimeout(completionTimer);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      let finalError = error;
      if (!finalError && timedOut) {
        finalError = new Error(`spawn ${command} ETIMEDOUT`);
        finalError.code = "ETIMEDOUT";
      }
      const result = { status, stdout, stderr };
      if (finalError) result.error = finalError;
      resolve(result);
    };

    const signalChild = (killSignal) => {
      try {
        if (useProcessGroup && Number.isInteger(child.pid)) {
          process.kill(-child.pid, killSignal);
        } else {
          child.kill(killSignal);
        }
      } catch (_error) {}
    };

    const stopChild = ({ timeoutExpired = false } = {}) => {
      if (settled) return;
      if (timeoutExpired) timedOut = true;
      signalChild("SIGTERM");
      // A CLI may leave descendants or inherited stdio alive after SIGTERM.
      // Escalate after a short grace period and settle even if close never fires.
      hardTimer = setTimeout(() => {
        signalChild("SIGKILL");
        settle({ status: null });
      }, 1000);
      if (typeof hardTimer.unref === "function") hardTimer.unref();
    };

    const scheduleCompletion = () => {
      if (typeof completeWhen !== "function" || settled) return;
      let complete = false;
      try {
        complete = Boolean(completeWhen(stdout, stderr));
      } catch (_error) {}
      if (!complete) return;
      if (completionTimer) clearTimeout(completionTimer);
      completionTimer = setTimeout(
        () => stopChild(),
        Math.max(0, Number(completionGraceMs) || 0),
      );
    };

    const appendOutput = (key, chunk) => {
      if (settled) return;
      if (key === "stdout") stdout += chunk;
      else stderr += chunk;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      // Unlike exec/execFile, spawn does not apply a maxBuffer guard to piped
      // streams. Enforce the combined byte cap here so a verbose CLI cannot
      // grow this process without bound.
      if (outputBytes > maxBuffer) {
        const error = new Error(`spawn ${command} maxBuffer length exceeded`);
        error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        signalChild("SIGKILL");
        settle({ status: null, error });
        return;
      }
      scheduleCompletion();
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));
    child.on("error", (error) => settle({ status: null, error }));
    child.on("close", (code) => settle({ status: timedOut ? null : code }));

    if (signal) {
      abortListener = () => stopChild();
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => stopChild({ timeoutExpired: true }), timeout);
    }
    if (input !== undefined) {
      child.stdin?.on("error", (error) => {
        signalChild("SIGKILL");
        settle({ error });
      });
      try {
        child.stdin?.end(input);
      } catch (error) {
        signalChild("SIGKILL");
        settle({ error });
      }
    }
  });
}

// Locate a binary on PATH. Unix uses `which`; native Windows ships no `which`
// (it has `where.exe` instead), so blindly spawning `which` there returns
// ENOENT and every provider would report itself unconfigured even when the
// binary is installed and signed in.
async function whichBinary(binary, { commandRunner, platform = process.platform, signal } = {}) {
  const probe = platform === "win32" ? "where" : "which";
  const result = await runCommand(commandRunner, probe, [binary], {
    timeout: 2000,
    signal,
    platform,
    killProcessGroup: true,
  });
  if (result?.error || result?.status !== 0) return null;
  const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  if (!stdout) return null;
  // `where` on Windows emits CRLF and may list several matches across PATH
  // entries; take the first line without the trailing `\r`, or the polluted
  // path would fail at spawn time.
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

async function isBinaryAvailable(binary, { commandRunner, platform, signal } = {}) {
  return (await whichBinary(binary, { commandRunner, platform, signal })) !== null;
}

// Expand a versioned install root (e.g. ~/.nvm/versions/node/<ver>/ or
// fnm's node-versions/<ver>/installation/) into its per-version bin
// directories. Returns [] when the root does not exist.
function versionedBinDirs(root, inner) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }))
      .map((entry) => path.join(root, entry.name, ...inner));
  } catch (_error) {
    return [];
  }
}

// Directories where globally installed CLIs commonly live even when the
// current process has a minimal PATH (e.g. a Finder-launched macOS app does
// not inherit the login-shell PATH, so Homebrew and npm global binaries are
// unreachable through `which`). Probed with statSync — no spawn.
function commonGlobalBinDirectories({ home = os.homedir(), platform = process.platform } = {}) {
  if (platform === "win32") {
    return [
      path.join(home, "AppData", "Roaming", "npm"),
    ];
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    // volta keeps shims for every global install here
    path.join(home, ".volta", "bin"),
    // nvm / fnm install npm globals under a per-version prefix that a
    // minimal PATH never sees; newest version first.
    ...versionedBinDirs(path.join(home, ".nvm", "versions", "node"), ["bin"]),
    ...versionedBinDirs(path.join(home, ".local", "share", "fnm", "node-versions"), ["installation", "bin"]),
    ...(platform === "darwin"
      ? versionedBinDirs(path.join(home, "Library", "Application Support", "fnm", "node-versions"), ["installation", "bin"])
      : []),
  ];
}

// Probe `binary` inside the given directories with statSync — no spawn.
// Exported so providers can treat a hit as install evidence without
// paying for a `which` process.
function statBinaryInDirs(binary, searchDirs, platform = process.platform) {
  for (const dir of searchDirs) {
    const candidate = path.join(dir, binary);
    for (const suffix of platform === "win32" ? ["", ".cmd", ".exe"] : [""]) {
      try {
        if (fs.statSync(candidate + suffix).isFile()) return candidate + suffix;
      } catch (_error) {}
    }
  }
  return null;
}

/**
 * Resolve a binary to an absolute path: `which`/`where` first, then a
 * spawn-free probe of the common global-install directories above. Returns
 * null when the binary cannot be found. Callers should spawn the returned
 * path (not the bare name): a bare name goes through PATH search again —
 * and on Windows cmd.exe searches the current directory first, which would
 * let an `arkcli.bat` dropped in the server cwd hijack the spawn.
 */
async function resolveBinaryPath(binary, { commandRunner, home, platform = process.platform, signal, globalBinDirs } = {}) {
  let resolved = null;
  try {
    resolved = await whichBinary(binary, { commandRunner, platform, signal });
  } catch (_error) {
    resolved = null;
  }
  if (resolved) return resolved;
  const searchDirs = Array.isArray(globalBinDirs)
    ? globalBinDirs
    : commonGlobalBinDirectories({ home, platform });
  return statBinaryInDirs(binary, searchDirs, platform);
}

// Resolving an npm CLI's absolute path does not resolve its /usr/bin/env node
// shebang. Finder-launched apps have a minimal PATH even when the CLI lives
// beside a working nvm/fnm/Homebrew Node. Scope this environment to the child;
// preserve the install's own runtime and use our running Node as a fallback.
function resolvedCliEnvironment(binaryPath, { env = process.env, platform = process.platform } = {}) {
  if (platform === "win32") return { ...env };
  const dirs = [path.dirname(binaryPath), ...(env.PATH || "/usr/bin:/bin").split(path.delimiter), path.dirname(process.execPath)];
  return { ...env, PATH: [...new Set(dirs.filter(Boolean))].join(path.delimiter) };
}

module.exports = {
  runCommand,
  whichBinary,
  isBinaryAvailable,
  commonGlobalBinDirectories,
  statBinaryInDirs,
  resolveBinaryPath,
  resolvedCliEnvironment,
};
