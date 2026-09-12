"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { cmdUpdate, parseArgs, updateHelpText } = require("../src/commands/update");
const { PACKAGE_NAME, BREW_FORMULA } = require("../src/lib/install-channel");

function createStreams() {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    stdout: {
      write(chunk) {
        out.stdout += String(chunk || "");
        return true;
      },
    },
    stderr: {
      write(chunk) {
        out.stderr += String(chunk || "");
        return true;
      },
    },
  };
}

async function runUpdate(argv, extra = {}) {
  const streams = createStreams();
  const prevExit = process.exitCode;
  const calls = [];
  try {
    await cmdUpdate(argv, {
      entryPath: extra.entryPath,
      realpathSync: extra.realpathSync || ((p) => p),
      spawnSync: extra.spawnSync || ((bin, args) => {
        calls.push({ bin, args });
        return extra.spawnResult || { status: 0 };
      }),
      platform: extra.platform,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    return {
      out: streams.out.stdout,
      err: streams.out.stderr,
      calls,
      exitCode: process.exitCode,
    };
  } finally {
    process.exitCode = prevExit;
  }
}

test("parseArgs rejects unknown flags including --dry-run", () => {
  assert.deepEqual(parseArgs([]), { help: false });
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.throws(() => parseArgs(["--dry-run"]), /Unknown option: --dry-run/);
});

test("update help does not mention --dry-run", () => {
  const help = updateHelpText();
  assert.match(help, /tokentracker update/);
  assert.equal(help.includes("--dry-run"), false);
});

test("update delegates npm-global installs to npm", async () => {
  const result = await runUpdate([], {
    entryPath: "/home/u/.nvm/versions/node/v20.11.0/lib/node_modules/tokentracker-cli/bin/tracker.js",
  });
  assert.deepEqual(result.calls, [{ bin: "npm", args: ["install", "-g", `${PACKAGE_NAME}@latest`] }]);
  assert.match(result.out, /Detected install: npm/);
  assert.match(result.out, /Updating TokenTracker via `npm install -g tokentracker-cli@latest`/);
  assert.match(result.out, /Update finished/);
  assert.equal(result.err, "");
});

test("update delegates Homebrew keg installs to brew upgrade", async () => {
  const result = await runUpdate([], {
    entryPath:
      "/opt/homebrew/Cellar/tokentracker/0.96.2/libexec/lib/node_modules/tokentracker-cli/bin/tracker.js",
  });
  assert.deepEqual(result.calls, [{ bin: "brew", args: ["upgrade", BREW_FORMULA] }]);
  assert.match(result.out, /Detected install: brew/);
});

test("update uses a Windows shell when spawning npm", async () => {
  let shell;
  await runUpdate([], {
    entryPath: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\tokentracker-cli\\bin\\tracker.js",
    platform: "win32",
    spawnSync: (bin, args, opts) => {
      shell = opts.shell;
      return { status: 0 };
    },
  });
  assert.equal(shell, true);
});

test("update refuses source checkouts without spawning a package manager", async () => {
  const result = await runUpdate([], {
    entryPath: path.join(__dirname, "..", "bin", "tracker.js"),
    realpathSync: undefined,
  });
  assert.deepEqual(result.calls, []);
  assert.equal(result.exitCode, 1);
  assert.match(result.out, /Detected install: other/);
  assert.match(result.err, /git checkout|source tree|managed install/);
});

test("update refuses npx and desktop installs", async () => {
  const npx = await runUpdate([], {
    entryPath: "/home/u/.npm/_npx/xyz/node_modules/tokentracker-cli/bin/tracker.js",
  });
  assert.deepEqual(npx.calls, []);
  assert.equal(npx.exitCode, 1);
  assert.match(npx.err, /launched via npx/);

  const desktop = await runUpdate([], {
    entryPath: "/Applications/TokenTracker.app/Contents/Resources/EmbeddedServer/tokentracker/bin/tracker.js",
  });
  assert.deepEqual(desktop.calls, []);
  assert.equal(desktop.exitCode, 1);
  assert.match(desktop.err, /desktop app/);
});

test("update --help prints subcommand help without spawning", async () => {
  const result = await runUpdate(["--help"], {
    entryPath: "/home/u/.nvm/versions/node/v20.11.0/lib/node_modules/tokentracker-cli/bin/tracker.js",
  });
  assert.deepEqual(result.calls, []);
  assert.match(result.out, /Delegates to the package manager/);
  assert.equal(result.out.includes("--dry-run"), false);
});

test("update surfaces a missing package-manager binary", async () => {
  const result = await runUpdate([], {
    entryPath: "/home/u/.nvm/versions/node/v20.11.0/lib/node_modules/tokentracker-cli/bin/tracker.js",
    spawnResult: { error: new Error("spawn npm ENOENT"), status: null },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.err, /Failed to run `npm`/);
});
