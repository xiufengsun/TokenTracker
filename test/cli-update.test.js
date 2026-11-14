const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { cmdUpdate } = require("../src/commands/update");
const {
  compareVersions,
  planUpdate,
  npmCliCandidates,
  formatCommand,
  fetchLatestNpmVersion,
} = require("../src/lib/cli-update");

const NODE = "/usr/bin/node";
const NPM_CLI = "/usr/lib/node_modules/npm/bin/npm-cli.js";
const NPM_ROOT = "/usr/lib/node_modules/tokentracker-cli";
const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
const WIN_NPM_CLI = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
const WIN_PREFIX = "C:\\Users\\me\\AppData\\Roaming\\npm";
const WIN_ROOT = `${WIN_PREFIX}\\node_modules\\tokentracker-cli`;
const BREW_ROOT = "/opt/homebrew/Cellar/tokentracker/1.4.7/libexec/lib/node_modules/tokentracker-cli";
const BREW_LINKED = "/opt/homebrew/opt/tokentracker/libexec/lib/node_modules/tokentracker-cli";

// cmdUpdate writes through injected streams. Swapping process.stdout.write
// would also swallow the frames node:test writes there to report results,
// which corrupted JSON.parse() on the Windows runner.
function sink() {
  const io = { out: "", err: "" };
  io.stdout = { write: (chunk) => { io.out += String(chunk ?? ""); return true; } };
  io.stderr = { write: (chunk) => { io.err += String(chunk ?? ""); return true; } };
  return io;
}

async function runUpdate(argv, deps = {}, io = sink()) {
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  try {
    const result = await cmdUpdate(argv, { ...deps, stdout: io.stdout, stderr: io.stderr });
    return { out: io.out, err: io.err, exitCode: process.exitCode, result };
  } finally {
    process.exitCode = prevExit;
  }
}

function registry(version, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ version }),
  });
}

// `npm prefix --global` probes answer with npmPrefix (or fail without one) and
// are recorded apart from the install/upgrade calls.
function fakeSpawn({ code = 0, npmPrefix = null, onSpawn } = {}) {
  const calls = [];
  const probes = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    if (args.at(-2) === "prefix" && args.at(-1) === "--global") {
      probes.push({ command, args, options });
      process.nextTick(() => {
        if (npmPrefix) child.stdout.emit("data", `${npmPrefix}\n`);
        child.emit("close", npmPrefix ? 0 : 1);
      });
      return child;
    }
    calls.push({ command, args, options });
    if (onSpawn) onSpawn({ command, args, options });
    process.nextTick(() => child.emit("close", code));
    return child;
  };
  return { spawn, calls, probes };
}

// Paths compare with forward slashes, so the same fixtures hold on the
// Windows CI runner, where path.join() rewrites them with backslashes.
// versions maps a package root to its package.json version and can be
// changed while a test runs; links maps a path to its realpath.
function fakeFs({ versions = {}, files = [], links = {} } = {}) {
  const norm = (value) => String(value).replace(/\\/g, "/");
  const exists = new Set([...files, ...Object.keys(links)].map(norm));
  return {
    versions,
    existsSync: (file) => exists.has(norm(file)),
    realpathSync: (file) => {
      const key = Object.keys(links).find((link) => norm(link) === norm(file));
      return key ? links[key] : file;
    },
    readFileSync: (file) => {
      const root = Object.keys(versions).find((dir) => `${norm(dir)}/package.json` === norm(file));
      if (!root) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return JSON.stringify({ name: "tokentracker-cli", version: versions[root] });
    },
  };
}

function plan(packageRoot, extra = {}) {
  return planUpdate({
    packageRoot,
    platform: "linux",
    current: "1.4.7",
    latest: "1.4.12",
    writable: true,
    npm: [NODE, NPM_CLI],
    ...extra,
  });
}

function npmDeps(extra = {}) {
  return {
    packageRoot: NPM_ROOT,
    execPath: NODE,
    currentVersion: "1.4.7",
    platform: "linux",
    writable: true,
    fetch: registry("1.4.12"),
    ...extra,
  };
}

test("compareVersions orders releases and prereleases", () => {
  assert.equal(compareVersions("1.4.7", "1.4.12"), -1);
  assert.equal(compareVersions("v1.4.12", "1.4.12"), 0);
  assert.equal(compareVersions("1.4.13", "1.4.12"), 1);
  assert.equal(compareVersions("1.4.12-beta.1", "1.4.12"), -1);
  assert.equal(compareVersions("1.4.12; touch /tmp/pwned", "1.4.12"), null);
  assert.equal(compareVersions("1.4.12\nrm -rf /", "1.4.12"), null);
});

test("npm global, Homebrew, and npx are the CLI update channels", () => {
  const npmPlan = plan(NPM_ROOT, { npmPrefix: "/usr" });
  assert.equal(npmPlan.channel, "npm");
  assert.equal(npmPlan.prefix, "/usr");
  assert.equal(npmPlan.apply, true);
  assert.deepEqual(npmPlan.command, [
    "npm",
    "install",
    "--global",
    "--prefix",
    "/usr",
    "tokentracker-cli@1.4.12",
  ]);
  assert.deepEqual(npmPlan.exec, [NODE, NPM_CLI, ...npmPlan.command.slice(1)]);

  const nvmPrefix = "/home/me/.nvm/versions/node/v20.19.0";
  const nvmPlan = plan(`${nvmPrefix}/lib/node_modules/tokentracker-cli`, { npmPrefix: nvmPrefix });
  assert.equal(nvmPlan.prefix, nvmPrefix);
  assert.equal(nvmPlan.apply, true);

  const brewPlan = plan(BREW_ROOT);
  assert.equal(brewPlan.channel, "brew");
  assert.deepEqual(brewPlan.command, ["brew", "upgrade", "xiufengsun/tokentracker/tokentracker"]);
  assert.deepEqual(brewPlan.exec, brewPlan.command);

  const linuxbrew = plan("/home/linuxbrew/.linuxbrew/Cellar/tokentracker/1.4.7/libexec/lib/node_modules/tokentracker-cli");
  assert.equal(linuxbrew.channel, "brew");

  const npxPlan = plan("/root/.npm/_npx/abc/node_modules/tokentracker-cli");
  assert.equal(npxPlan.channel, "npx");
  assert.equal(npxPlan.apply, false);
  assert.match(npxPlan.lines.join("\n"), /npx tokentracker-cli@1\.4\.12/);
});

test("windows runs npm-cli.js with node instead of npm.cmd", () => {
  const win = plan(WIN_ROOT, {
    platform: "win32",
    npm: [WIN_NODE, WIN_NPM_CLI],
    npmPrefix: WIN_PREFIX.toLowerCase(),
  });
  assert.equal(win.channel, "npm");
  assert.equal(win.prefix, WIN_PREFIX);
  assert.equal(win.apply, true);
  assert.equal(win.command[0], "npm");
  assert.equal(win.command[4], WIN_PREFIX);
  assert.deepEqual(win.exec.slice(0, 3), [WIN_NODE, WIN_NPM_CLI, "install"]);
  assert.equal(win.exec.some((arg) => /npm\.cmd$/i.test(arg)), false);
});

test("npm-cli.js is looked up next to the running node, then under the prefix", () => {
  const nvm = "/home/me/.nvm/versions/node/v20.19.0";
  assert.deepEqual(
    npmCliCandidates({ prefix: nvm, platform: "linux", execPath: `${nvm}/bin/node` }),
    [`${nvm}/bin/npm`, `${nvm}/lib/node_modules/npm/bin/npm-cli.js`],
  );
  assert.deepEqual(
    npmCliCandidates({ prefix: WIN_PREFIX, platform: "win32", execPath: WIN_NODE }),
    [WIN_NPM_CLI, `${WIN_PREFIX}\\node_modules\\npm\\bin\\npm-cli.js`],
  );
});

test("printed commands are quoted for the shell the user pastes into", () => {
  assert.equal(formatCommand(["npm", "--prefix", "/usr", "tokentracker-cli@1.4.12"], "darwin"),
    "npm --prefix /usr tokentracker-cli@1.4.12");
  assert.equal(formatCommand(["npm", "--prefix", "/home/a b/$HOME/`id`/it's\\x"], "linux"),
    "npm --prefix '/home/a b/$HOME/`id`/it'\\''s\\x'");
  assert.equal(formatCommand(["npm", "--prefix", WIN_PREFIX], "win32"), `npm --prefix ${WIN_PREFIX}`);
  assert.equal(formatCommand(["npm", "--prefix", "C:\\Users\\John Doe\\npm"], "win32"),
    'npm --prefix "C:\\Users\\John Doe\\npm"');
});

test("a lib/node_modules copy outside npm's global prefix is not updated", () => {
  const roots = [
    "/home/me/.volta/tools/image/packages/tokentracker-cli/lib/node_modules/tokentracker-cli",
    "/home/me/.local/share/mise/installs/npm-tokentracker-cli/1.4.7/lib/node_modules/tokentracker-cli",
    "/home/me/work/lib/node_modules/tokentracker-cli",
  ];
  for (const root of roots) {
    const result = plan(root, { npmPrefix: "/usr/local" });
    assert.equal(result.channel, "npm", root);
    assert.equal(result.apply, false, root);
    assert.equal(result.command, null, root);
    assert.equal(result.exec, null, root);
    assert.match(result.lines.join("\n"), /npm's global prefix is \/usr\/local/, root);
  }

  const unknown = plan("/home/me/work/lib/node_modules/tokentracker-cli", { npmPrefix: null });
  assert.equal(unknown.apply, false);
  assert.match(unknown.lines.join("\n"), /Could not confirm/);
});

test("other package managers and source checkouts are not updated in place", () => {
  const roots = [
    "/home/me/proj/node_modules/tokentracker-cli",
    "/home/me/.local/share/pnpm/global/5/node_modules/tokentracker-cli",
    "/home/me/.config/yarn/global/node_modules/tokentracker-cli",
    "/home/me/.bun/install/global/node_modules/tokentracker-cli",
    "/root/CodeProjects/TokenTracker",
  ];
  for (const root of roots) {
    const result = plan(root);
    const text = result.lines.join("\n");
    assert.equal(result.apply, false, root);
    assert.equal(result.command, null, root);
    assert.equal(text.includes("pnpm"), false, root);
    assert.equal(text.includes("yarn"), false, root);
    assert.equal(text.includes(" bun"), false, root);
    assert.match(text, /npm install -g tokentracker-cli@1\.4\.12/);
    assert.match(text, /brew upgrade xiufengsun\/tokentracker\/tokentracker/);
    assert.match(text, /npx tokentracker-cli@1\.4\.12/);
  }
});

test("a bundled app, including the Homebrew cask's, is not updated with npm", () => {
  for (const root of [
    "/Applications/TokenTracker.app/Contents/Resources/EmbeddedServer/tokentracker",
    "/opt/homebrew/Caskroom/tokentracker/1.4.7/TokenTracker.app/Contents/Resources/EmbeddedServer/tokentracker",
  ]) {
    const result = plan(root);
    const text = result.lines.join("\n");
    assert.equal(result.channel, "app", root);
    assert.equal(result.apply, false, root);
    assert.match(text, /brew upgrade --cask xiufengsun\/tokentracker\/tokentracker/);
    assert.match(text, /Check for Updates/);
    assert.match(text, /AppImage/);
    assert.equal(text.includes("npm install"), false);
  }
});

test("an npm install that is already current does not run", () => {
  const result = plan(NPM_ROOT, { current: "1.4.12", latest: "1.4.12" });
  assert.equal(result.updateAvailable, false);
  assert.equal(result.apply, false);
  assert.match(result.lines.join("\n"), /already the latest release/);
});

test("fetchLatestNpmVersion rejects a version that is not a release number", async () => {
  await assert.rejects(
    fetchLatestNpmVersion(registry("1.4.12; touch /tmp/pwned")),
    /unusable version/,
  );
  assert.equal(await fetchLatestNpmVersion(registry("v1.4.12")), "1.4.12");
});

test("update --check reports a newer npm release without installing", async () => {
  const spawn = fakeSpawn({ npmPrefix: "/usr" });
  const captured = await runUpdate(["--check", "--json"], npmDeps({
    fs: fakeFs({ files: [NPM_CLI] }),
    spawn: spawn.spawn,
  }));
  const payload = JSON.parse(captured.out);
  assert.equal(payload.ok, true);
  assert.equal(payload.updateAvailable, true);
  assert.equal(payload.applied, false);
  assert.equal(payload.channel, "npm");
  assert.equal(payload.command[5], "tokentracker-cli@1.4.12");
  assert.equal(captured.exitCode, 1);
  assert.equal(spawn.probes.length, 1);
  assert.equal(spawn.calls.length, 0);
});

test("update installs the npm global prefix in place", async () => {
  const files = fakeFs({ files: [NPM_CLI], versions: { [NPM_ROOT]: "1.4.7" } });
  const io = sink();
  const spawn = fakeSpawn({
    npmPrefix: "/usr",
    onSpawn() {
      io.stdout.write("installer output\n");
      files.versions[NPM_ROOT] = "1.4.12";
    },
  });
  const captured = await runUpdate([], npmDeps({ fs: files, spawn: spawn.spawn }), io);
  assert.equal(captured.exitCode, 0);
  assert.equal(spawn.probes[0].command, NODE);
  assert.deepEqual(spawn.probes[0].args, [NPM_CLI, "prefix", "--global"]);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].command, NODE);
  assert.deepEqual(spawn.calls[0].args, [
    NPM_CLI,
    "install",
    "--global",
    "--prefix",
    "/usr",
    "tokentracker-cli@1.4.12",
  ]);
  assert.equal(spawn.calls[0].options.shell, false);
  // The planned command prints before the installer runs, the result after.
  const planned = "npm install --global --prefix /usr tokentracker-cli@1.4.12";
  const plannedAt = captured.out.indexOf(planned);
  const installerAt = captured.out.indexOf("installer output");
  const resultAt = captured.out.indexOf("Updated to 1.4.12");
  assert.ok(plannedAt >= 0 && plannedAt < installerAt && installerAt < resultAt, captured.out);
  assert.equal(captured.out.split(planned).length, 2);
});

test("update follows bin/npm to npm-cli.js and skips a bin/npm that is a shell wrapper", async () => {
  const linked = fakeSpawn({ npmPrefix: "/usr" });
  await runUpdate(["--check"], npmDeps({
    fs: fakeFs({ links: { "/usr/bin/npm": "/opt/npm/bin/npm-cli.js" } }),
    spawn: linked.spawn,
  }));
  assert.equal(linked.probes[0].args[0], "/opt/npm/bin/npm-cli.js");

  const wrapped = fakeSpawn({ npmPrefix: "/usr" });
  await runUpdate(["--check"], npmDeps({
    fs: fakeFs({ links: { "/usr/bin/npm": "/usr/share/npm/npm.sh" }, files: [NPM_CLI] }),
    spawn: wrapped.spawn,
  }));
  assert.equal(wrapped.probes[0].args[0], NPM_CLI);
});

test("update on Windows spawns node and npm-cli.js without a shell", async () => {
  const files = fakeFs({ files: [WIN_NPM_CLI], versions: { [WIN_ROOT]: "1.4.7" } });
  const spawn = fakeSpawn({
    npmPrefix: WIN_PREFIX,
    onSpawn() {
      files.versions[WIN_ROOT] = "1.4.12";
    },
  });
  const captured = await runUpdate([], npmDeps({
    packageRoot: WIN_ROOT,
    execPath: WIN_NODE,
    platform: "win32",
    fs: files,
    spawn: spawn.spawn,
  }));
  assert.equal(captured.exitCode, 0);
  assert.equal(spawn.probes[0].command, WIN_NODE);
  assert.deepEqual(spawn.probes[0].args, [WIN_NPM_CLI, "prefix", "--global"]);
  assert.equal(spawn.calls[0].command, WIN_NODE);
  assert.deepEqual(spawn.calls[0].args.slice(0, 5), [WIN_NPM_CLI, "install", "--global", "--prefix", WIN_PREFIX]);
  for (const call of [...spawn.probes, ...spawn.calls]) {
    assert.equal(call.options.shell, false);
    assert.equal(/npm\.cmd$/i.test(call.command), false);
  }
  assert.match(captured.out, /Updated to 1\.4\.12/);
});

test("update on Windows without a bundled npm prints the command instead of running npm.cmd", async () => {
  const spawn = fakeSpawn({ npmPrefix: WIN_PREFIX });
  const captured = await runUpdate([], npmDeps({
    packageRoot: WIN_ROOT,
    execPath: WIN_NODE,
    platform: "win32",
    fs: fakeFs(),
    spawn: spawn.spawn,
  }));
  assert.equal(spawn.probes.length + spawn.calls.length, 0);
  assert.equal(captured.exitCode, 1);
  assert.match(captured.out, /Could not find npm/);
  assert.match(captured.out, /npm install --global --prefix C:\\Users\\me\\AppData\\Roaming\\npm tokentracker-cli@1\.4\.12/);
});

test("update refuses a lib/node_modules copy outside npm's global prefix", async () => {
  const spawn = fakeSpawn({ npmPrefix: "/usr/local" });
  const captured = await runUpdate([], npmDeps({
    packageRoot: "/home/me/.volta/tools/image/packages/tokentracker-cli/lib/node_modules/tokentracker-cli",
    fs: fakeFs({ files: [NPM_CLI] }),
    spawn: spawn.spawn,
  }));
  assert.equal(spawn.probes.length, 1);
  assert.equal(spawn.calls.length, 0);
  assert.equal(captured.exitCode, 1);
  assert.match(captured.out, /npm's global prefix is \/usr\/local/);
});

test("update compares npm's prefix after resolving its symlinks", async () => {
  const spawn = fakeSpawn({ npmPrefix: "/home/me/npm-global" });
  const captured = await runUpdate(["--check", "--json"], npmDeps({
    packageRoot: "/data/npm-global/lib/node_modules/tokentracker-cli",
    fs: fakeFs({ files: [NPM_CLI], links: { "/home/me/npm-global": "/data/npm-global" } }),
    spawn: spawn.spawn,
  }));
  assert.match(JSON.parse(captured.out).message, /npm install --global --prefix \/data\/npm-global/);
});

test("update does not claim success when the npm install leaves the old version", async () => {
  const spawn = fakeSpawn({ npmPrefix: "/usr" });
  const captured = await runUpdate([], npmDeps({
    fs: fakeFs({ files: [NPM_CLI], versions: { [NPM_ROOT]: "1.4.7" } }),
    spawn: spawn.spawn,
  }));
  assert.equal(spawn.calls.length, 1);
  assert.equal(captured.exitCode, 1);
  assert.match(captured.out, /still 1\.4\.7/);
});

test("update refuses an unwritable npm prefix", async () => {
  const spawn = fakeSpawn({ npmPrefix: "/usr" });
  const captured = await runUpdate([], npmDeps({
    writable: false,
    fs: fakeFs({ files: [NPM_CLI] }),
    spawn: spawn.spawn,
  }));
  assert.equal(spawn.calls.length, 0);
  assert.equal(captured.exitCode, 1);
  assert.match(captured.out, /not writable: \/usr/);
  assert.match(captured.out, /npm install --global --prefix \/usr tokentracker-cli@1\.4\.12/);
});

test("update runs brew upgrade and confirms the version Homebrew linked", async () => {
  const files = fakeFs({ versions: { [BREW_LINKED]: "1.4.7" } });
  const spawn = fakeSpawn({
    onSpawn() {
      files.versions[BREW_LINKED] = "1.4.12";
    },
  });
  const captured = await runUpdate([], {
    packageRoot: BREW_ROOT,
    currentVersion: "1.4.7",
    platform: "darwin",
    fs: files,
    fetch: registry("1.4.12"),
    spawn: spawn.spawn,
  });
  assert.equal(captured.exitCode, 0);
  assert.equal(spawn.calls[0].command, "brew");
  assert.deepEqual(spawn.calls[0].args, ["upgrade", "xiufengsun/tokentracker/tokentracker"]);
  assert.equal(spawn.calls[0].options.shell, false);
  assert.match(captured.out, /Updated to 1\.4\.12/);
});

test("update does not report applied when the Homebrew tap has not bumped yet", async () => {
  const spawn = fakeSpawn();
  const captured = await runUpdate(["--json"], {
    packageRoot: BREW_ROOT,
    currentVersion: "1.4.7",
    platform: "darwin",
    fs: fakeFs({ versions: { [BREW_LINKED]: "1.4.7" } }),
    fetch: registry("1.4.12"),
    spawn: spawn.spawn,
  });
  const payload = JSON.parse(captured.out);
  assert.equal(spawn.calls.length, 1);
  assert.equal(captured.exitCode, 1);
  assert.equal(payload.ok, false);
  assert.equal(payload.applied, false);
  assert.match(payload.message, /Homebrew still has 1\.4\.7/);
});

test("npx prints the next launch command and does not install", async () => {
  const spawn = fakeSpawn();
  const captured = await runUpdate([], {
    packageRoot: "/root/.npm/_npx/abc/node_modules/tokentracker-cli",
    currentVersion: "1.4.7",
    platform: "linux",
    fetch: registry("1.4.12"),
    spawn: spawn.spawn,
  });
  assert.equal(spawn.calls.length, 0);
  assert.equal(captured.exitCode, 0);
  assert.match(captured.out, /npx tokentracker-cli@1\.4\.12/);
});

test("a registry failure prints the three CLI install commands and does not install", async () => {
  const spawn = fakeSpawn();
  const captured = await runUpdate([], npmDeps({
    fetch: registry("1.4.12; rm -rf /", 200),
    spawn: spawn.spawn,
  }));
  assert.equal(spawn.probes.length + spawn.calls.length, 0);
  assert.equal(captured.exitCode, 1);
  assert.match(captured.out, /npm install -g tokentracker-cli@latest/);
  assert.match(captured.out, /brew upgrade xiufengsun\/tokentracker\/tokentracker/);
  assert.match(captured.out, /npx tokentracker-cli@latest/);
  assert.equal(captured.out.includes("rm -rf"), false);
});

test("unknown commands print help to stderr instead of throwing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-update-cli-"));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "../bin/tracker.js"), "updat"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Unknown command: updat/);
    assert.match(result.stderr, /Usage:/);
    assert.match(result.stderr, /npx tokentracker-cli \[--debug\] update \[--check\] \[--json\]/);
    assert.match(result.stderr, /doctor/);
    assert.equal(result.stderr.includes("    at "), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("update reports an unknown option with usage instead of a stack", async () => {
  const captured = await runUpdate(["--force"]);
  assert.equal(captured.out, "");
  assert.match(captured.err, /Unknown option: --force/);
  assert.match(captured.err, /Usage: tokentracker update \[--check\] \[--json\]/);
  assert.equal(captured.err.includes("    at "), false);
  assert.equal(captured.exitCode, 1);
});
