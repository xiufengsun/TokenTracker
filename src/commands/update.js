"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  parseVersion,
  compareVersions,
  classifyInstall,
  brewLinkedPackageRoot,
  npmCliCandidates,
  planUpdate,
  fetchLatestNpmVersion,
  officialCommands,
} = require("../lib/cli-update");

const USAGE = "Usage: tokentracker update [--check] [--json]";
const NPM_PREFIX_TIMEOUT_MS = 15000;

function parseArgs(argv) {
  const out = { check: false, json: false };
  for (const arg of argv) {
    if (arg === "--check") out.check = true;
    else if (arg === "--json") out.json = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

function defaultPackageRoot(fsImpl) {
  const root = path.resolve(__dirname, "..", "..");
  try {
    return fsImpl.realpathSync(root);
  } catch {
    return root;
  }
}

function canWrite(dir, fsImpl) {
  try {
    fsImpl.accessSync(dir, fsImpl.constants ? fsImpl.constants.W_OK : fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Never through a shell: every command is node, npm-cli.js, or brew with
// fixed arguments, so there is nothing for a shell to resolve or expand.
function runSpawn(spawnImpl, argv, { pipe = false, timeoutMs = 0 } = {}) {
  const [command, ...args] = argv;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawnImpl(command, args, {
        shell: false,
        windowsHide: true,
        stdio: pipe ? ["ignore", "pipe", "pipe"] : "inherit",
      });
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: error && error.message ? error.message : String(error) });
      return;
    }

    if (pipe && child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk; });
    if (pipe && child.stderr) child.stderr.on("data", (chunk) => { stderr += chunk; });

    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish({ code: 1, stdout, stderr: `${path.basename(command)} timed out` });
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }
    child.on("error", (error) => {
      finish({ code: 1, stdout, stderr: error && error.message ? error.message : String(error) });
    });
    child.on("close", (code) => {
      finish({ code: code == null ? 1 : code, stdout, stderr });
    });
  });
}

// A candidate counts only when it resolves to npm-cli.js itself: a bin/npm
// that is a shell wrapper cannot be run with node.
function resolveNpmCli(candidate, fsImpl) {
  try {
    if (!fsImpl.existsSync(candidate)) return null;
    const real = typeof fsImpl.realpathSync === "function" ? fsImpl.realpathSync(candidate) : candidate;
    return /[\\/]npm-cli\.js$/.test(real) ? real : null;
  } catch {
    return null;
  }
}

function findNpm({ prefix, platform, execPath, fsImpl }) {
  for (const candidate of npmCliCandidates({ prefix, platform, execPath })) {
    const cli = resolveNpmCli(candidate, fsImpl);
    if (cli) return [execPath, cli];
  }
  // A Unix PATH lookup does not search the current directory, so plain npm is
  // a safe fallback there. Windows would need npm.cmd under cmd.exe.
  return platform === "win32" ? null : ["npm"];
}

// npm's answer, not the directory layout, decides whether this copy is npm's
// global install: it honours npmrc, NPM_CONFIG_PREFIX and the Windows default.
// The install path is a realpath, so the configured prefix is resolved too.
async function readNpmGlobalPrefix(spawnImpl, npm, fsImpl) {
  const result = await runSpawn(spawnImpl, [...npm, "prefix", "--global"], {
    pipe: true,
    timeoutMs: NPM_PREFIX_TIMEOUT_MS,
  });
  if (result.code !== 0) return null;
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const prefix = lines.length ? lines[lines.length - 1] : null;
  if (!prefix || typeof fsImpl.realpathSync !== "function") return prefix;
  try {
    return fsImpl.realpathSync(prefix);
  } catch {
    return prefix;
  }
}

function readInstalledVersion(packageRoot, fsImpl) {
  try {
    const raw = fsImpl.readFileSync(path.join(packageRoot, "package.json"), "utf8");
    const manifest = JSON.parse(raw);
    return parseVersion(manifest && manifest.version) ? parseVersion(manifest.version).raw : null;
  } catch {
    return null;
  }
}

function writeLines(stdout, lines) {
  if (lines.length) stdout.write(`${lines.join("\n")}\n`);
}

// printed counts the leading lines already written before a spawn, so text
// mode does not repeat them; JSON always carries the whole message.
function emit(stdout, opts, payload, exitCode, printed = 0) {
  const lines = payload.lines.filter(Boolean);
  if (opts.json) {
    stdout.write(`${JSON.stringify({
      ok: payload.ok,
      current: payload.current,
      latest: payload.latest,
      channel: payload.channel,
      updateAvailable: payload.updateAvailable,
      command: payload.command,
      applied: payload.applied,
      message: lines.join("\n"),
    })}\n`);
  } else {
    writeLines(stdout, lines.slice(printed));
  }
  process.exitCode = exitCode;
  return payload;
}

async function cmdUpdate(argv = [], deps = {}) {
  // Injectable so tests never swap process.stdout: node:test reports a test
  // file's results to the runner over that same stream.
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    process.exitCode = 1;
    return null;
  }
  const fsImpl = deps.fs || fs;
  const spawnImpl = deps.spawn || spawn;
  const platform = deps.platform || process.platform;
  const execPath = deps.execPath || process.execPath;
  const packageRoot = deps.packageRoot || defaultPackageRoot(fsImpl);
  const current = deps.currentVersion || require("../../package.json").version;
  const writable = typeof deps.writable === "boolean"
    ? deps.writable
    : canWrite(path.dirname(packageRoot), fsImpl);

  let latest = null;
  let fetchError = null;
  try {
    latest = await fetchLatestNpmVersion(deps.fetch || globalThis.fetch);
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
  }

  if (fetchError) {
    return emit(stdout, opts, {
      ok: false,
      current,
      latest: null,
      channel: classifyInstall({ packageRoot, platform }).channel,
      updateAvailable: false,
      command: null,
      applied: false,
      lines: [
        "Could not read the latest tokentracker-cli version from the npm registry.",
        ...officialCommands(null),
      ],
    }, 1);
  }

  const install = classifyInstall({ packageRoot, platform });
  const cmp = compareVersions(current, latest);
  let npm = null;
  let npmPrefix = null;
  if (install.channel === "npm" && (cmp === null || cmp < 0)) {
    npm = findNpm({ prefix: install.prefix, platform, execPath, fsImpl });
    if (npm) npmPrefix = await readNpmGlobalPrefix(spawnImpl, npm, fsImpl);
  }

  const plan = planUpdate({ packageRoot, platform, current, latest, writable, npmPrefix, npm });
  if (opts.check || !plan.apply) {
    const exitCode = opts.check
      ? (plan.updateAvailable ? 1 : 0)
      : (plan.channel === "npm" && plan.updateAvailable ? 1 : 0);
    // --check exits 1 when a newer release exists. ok stays true because the
    // check itself succeeded; updateAvailable carries the result.
    return emit(stdout, opts, { ...plan, ok: opts.check || exitCode === 0, applied: false }, exitCode);
  }

  // Say what is about to run before the installer's own output scrolls by.
  const header = plan.lines.filter(Boolean);
  if (!opts.json) writeLines(stdout, header);
  const result = await runSpawn(spawnImpl, plan.exec, { pipe: opts.json });
  const lines = header.slice();
  let ok = result.code === 0;
  if (!ok) {
    const detail = (result.stderr || result.stdout || "").trim();
    lines.push(detail || `${plan.command[0]} exited with status ${result.code}`);
  } else if (plan.channel === "npm") {
    const installed = readInstalledVersion(packageRoot, fsImpl);
    if (installed && compareVersions(installed, plan.latest) < 0) {
      ok = false;
      lines.push(`The installer finished, but this install is still ${installed}.`);
    } else {
      lines.push(`Updated to ${plan.latest}. Restart a running tokentracker serve to pick up this version.`);
    }
  } else {
    const linked = brewLinkedPackageRoot(packageRoot);
    const installed = linked ? readInstalledVersion(linked, fsImpl) : null;
    if (installed && compareVersions(installed, plan.latest) < 0) {
      // brew exits 0 with "already installed" until the tap bumps the formula.
      ok = false;
      lines.push(`Homebrew still has ${installed}. The tap picks up a release within about an hour; run tokentracker update again later.`);
    } else if (installed) {
      lines.push(`Updated to ${installed}. Restart a running tokentracker serve to pick up this version.`);
    } else {
      lines.push("Homebrew finished. Run tokentracker --version in a new command to confirm the version.");
    }
  }

  return emit(stdout, opts, { ...plan, ok, applied: ok, lines }, ok ? 0 : 1, header.length);
}

module.exports = { cmdUpdate, parseArgs };
