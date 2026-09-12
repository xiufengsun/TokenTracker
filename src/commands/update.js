"use strict";

const { spawnSync } = require("node:child_process");
const { detectInstallChannel, formatCommandLine } = require("../lib/install-channel");

async function cmdUpdate(argv = [], deps = {}) {
  const opts = parseArgs(argv);
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;

  if (opts.help) {
    stdout.write(updateHelpText());
    return;
  }

  const detect = deps.detectInstallChannel || detectInstallChannel;
  const channel = detect({
    entryPath: deps.entryPath || process.argv[1],
    realpathSync: deps.realpathSync,
    existsSync: deps.existsSync,
    readFileSync: deps.readFileSync,
  });

  stdout.write(`Detected install: ${channel.method}\n`);

  if (!channel.action) {
    stderr.write(`${channel.reason}\n`);
    process.exitCode = 1;
    return;
  }

  const command = channel.command || formatCommandLine(channel.action);
  stdout.write(`Updating TokenTracker via \`${command}\`...\n`);
  const run = deps.spawnSync || spawnSync;
  const result = run(channel.action.bin, channel.action.args, {
    stdio: "inherit",
    env: deps.env || process.env,
    shell: (deps.platform || process.platform) === "win32",
  });

  if (result?.error) {
    stderr.write(`Failed to run \`${channel.action.bin}\`: ${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (result?.status !== 0) {
    process.exitCode = typeof result?.status === "number" ? result.status : 1;
    return;
  }

  stdout.write("Update finished. Restart any long-running `tokentracker serve` process to pick up the new version.\n");
}

function parseArgs(argv) {
  const out = { help: false };
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") out.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

function updateHelpText() {
  return [
    "tokentracker update",
    "",
    "Usage:",
    "  tokentracker update",
    "",
    "Delegates to the package manager that owns this copy (npm, bun, pnpm, yarn, or Homebrew).",
    "npx launches, desktop app bundles, and source checkouts are left unchanged.",
    "",
  ].join("\n");
}

module.exports = { cmdUpdate, parseArgs, updateHelpText };
