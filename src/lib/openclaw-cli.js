const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function cliError(message, code) {
  return Object.assign(new Error(message), { code });
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

function resolveOpenclawCommand(env, platform = process.platform) {
  if (platform !== "win32") return { command: "openclaw", prefixArgs: [] };

  // Match Node's case-insensitive Windows environment lookup. An explicit
  // empty PATH must not fall back to the user's real OpenClaw installation.
  const pathKey = Object.keys(env).sort().find((key) => key.toUpperCase() === "PATH");
  const searchPath = pathKey === undefined ? process.env.PATH || "" : env[pathKey];
  for (const entry of String(searchPath || "").split(";")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const executable = path.join(dir, "openclaw.exe");
    if (isFile(executable)) return { command: executable, prefixArgs: [] };
    if (!isFile(path.join(dir, "openclaw.cmd"))) continue;

    // npm puts Windows shims in the prefix, alongside node_modules. Launch
    // the declared JS bin with Node directly: cmd.exe would re-interpret
    // user paths containing %, &, or other shell metacharacters.
    const packageDir = path.join(dir, "node_modules", "openclaw");
    let metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
    } catch (error) {
      throw cliError(`Cannot resolve npm OpenClaw entry: ${error.message}`, "EINVAL");
    }
    const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.openclaw;
    if (metadata.name !== "openclaw" || typeof bin !== "string" || !/\.(?:[cm]?js)$/i.test(bin)) {
      throw cliError("Unsupported npm OpenClaw entry", "EINVAL");
    }
    const packageRoot = fs.realpathSync.native(packageDir);
    const target = fs.realpathSync.native(path.resolve(packageDir, bin));
    const relative = path.relative(packageRoot, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !isFile(target)) {
      throw cliError("npm OpenClaw entry is outside its package", "EINVAL");
    }
    return { command: process.execPath, prefixArgs: [target] };
  }
  throw cliError("OpenClaw CLI is not on PATH", "ENOENT");
}

function runOpenclawCli(args, env = process.env) {
  if (env?.TOKENTRACKER_SKIP_OPENCLAW_CLI === "1") {
    return {
      code: 1,
      skippedReason: "openclaw-cli-missing",
      error: "skipped via TOKENTRACKER_SKIP_OPENCLAW_CLI",
      stdout: "",
      stderr: "",
    };
  }
  let result;
  try {
    const { command, prefixArgs } = resolveOpenclawCommand(env);
    result = cp.spawnSync(command, [...prefixArgs, ...args], {
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    result = { error };
  }
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.error) {
    return {
      code: 1,
      skippedReason: result.error.code === "ENOENT" ? "openclaw-cli-missing" : "openclaw-cli-error",
      error: result.error.message || String(result.error),
      stdout,
      stderr,
    };
  }
  if (result.status !== 0) {
    const scope = args[0] === "hooks" ? "hooks" : "plugins";
    return {
      code: Number(result.status || 1),
      skippedReason: `openclaw-${scope}-install-failed`,
      error: (stderr || stdout).trim() || `openclaw ${scope} install failed`,
      stdout,
      stderr,
    };
  }
  return { code: 0, stdout, stderr };
}

module.exports = { resolveOpenclawCommand, runOpenclawCli };
