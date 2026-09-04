const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

// Turn-end syncing on native Windows regressed because the Codex/Every Code
// notify command was hardcoded to `/usr/bin/env node ...`, which Windows cannot
// execute — so notify.cjs never launched (issue #361). These tests lock in the
// OS-aware command and assert Windows setup/repair never writes `/usr/bin/env`.

process.env.TOKENTRACKER_SKIP_LOCAL_RUNTIME_COPY = "1";
process.env.TOKENTRACKER_SKIP_FIRST_SYNC = "1";
process.env.TOKENTRACKER_SKIP_OPENCLAW_CLI = "1";

const {
  buildCodexNotifyCmd,
  buildAcodeNotifyCmd,
  buildEveryCodeNotifyCmd,
  isManagedNotifyCmd,
  restoreCodexNotify,
  upsertCodexNotify,
} = require("../src/lib/codex-config");
const { repairCodexNotifyIntegration } = require("../src/commands/init");
const { withHome } = require("./helpers/with-home");

test("buildCodexNotifyCmd targets the Node executable on Windows", () => {
  const notifyPath = "C:\\Users\\a\\.tokentracker\\bin\\notify.cjs";
  const cmd = buildCodexNotifyCmd(notifyPath, {
    platform: "win32",
    execPath: "C:\\node\\node.exe",
  });
  assert.deepEqual(cmd, ["C:\\node\\node.exe", notifyPath]);
  assert.ok(!cmd.includes("/usr/bin/env"));
});

test("buildCodexNotifyCmd keeps the /usr/bin/env form on POSIX", () => {
  const notifyPath = "/home/a/.tokentracker/bin/notify.cjs";
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(buildCodexNotifyCmd(notifyPath, { platform }), [
      "/usr/bin/env",
      "node",
      notifyPath,
    ]);
  }
});

test("buildEveryCodeNotifyCmd appends the every-code source on both platforms", () => {
  const notifyPath = "C:\\Users\\a\\.tokentracker\\bin\\notify.cjs";
  assert.deepEqual(
    buildEveryCodeNotifyCmd(notifyPath, { platform: "win32", execPath: "C:\\node\\node.exe" }),
    ["C:\\node\\node.exe", notifyPath, "--source=every-code"],
  );
  const posixPath = "/home/a/.tokentracker/bin/notify.cjs";
  assert.deepEqual(buildEveryCodeNotifyCmd(posixPath, { platform: "linux" }), [
    "/usr/bin/env",
    "node",
    posixPath,
    "--source=every-code",
  ]);
});

test("buildAcodeNotifyCmd appends the acode source on both platforms", () => {
  const notifyPath = "C:\\Users\\a\\.tokentracker\\bin\\notify.cjs";
  assert.deepEqual(
    buildAcodeNotifyCmd(notifyPath, { platform: "win32", execPath: "C:\\node\\node.exe" }),
    ["C:\\node\\node.exe", notifyPath, "--source=acode"],
  );
  const posixPath = "/home/a/.tokentracker/bin/notify.cjs";
  assert.deepEqual(buildAcodeNotifyCmd(posixPath, { platform: "linux" }), [
    "/usr/bin/env",
    "node",
    posixPath,
    "--source=acode",
  ]);
});

test("Windows Codex repair never writes /usr/bin/env to config.toml", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codex-win-"));
  const restoreHome = withHome(dir);
  const prevCodexHome = process.env.CODEX_HOME;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const codexHome = path.join(dir, ".codex");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const trackerDir = path.join(dir, ".tokentracker");
  const binDir = path.join(trackerDir, "bin");

  try {
    process.env.CODEX_HOME = codexHome;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(codexConfigPath, 'model = "gpt-5-codex"\n', "utf8");

    const result = await repairCodexNotifyIntegration({
      home: dir,
      trackerDir,
      binDir,
      safeMode: false,
    });
    assert.equal(result.changed, true);

    const written = await fs.readFile(codexConfigPath, "utf8");
    assert.ok(!written.includes("/usr/bin/env"), written);
    assert.ok(written.includes("notify = ["), written);
    // The rewritten command launches notify.cjs via the running Node executable.
    assert.ok(written.includes("notify.cjs"), written);
  } finally {
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    restoreHome();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// Making the notify command OS-aware (#361) turned argv[0] into a value that
// varies between invocations on the same Windows box: the desktop app runs the
// bundled EmbeddedServer\node.exe, a terminal `tokentracker` runs the system /
// nvm Node. binDir already varied the same way. Strict array equality then
// misreads our own command as a stranger's, so recognition must key off the
// notify.cjs tail instead.
const WIN_TRACKER_BIN = "C:\\Users\\a\\.tokentracker\\bin\\notify.cjs";
const APP_NODE = "C:\\Program Files\\TokenTracker\\EmbeddedServer\\node.exe";
const SYSTEM_NODE = "C:\\Program Files\\nodejs\\node.exe";

test("isManagedNotifyCmd recognizes our command across a changed Node executable", () => {
  const expected = [SYSTEM_NODE, WIN_TRACKER_BIN];
  assert.equal(isManagedNotifyCmd([APP_NODE, WIN_TRACKER_BIN], expected), true);
  assert.equal(isManagedNotifyCmd(expected, expected), true);
  // POSIX form written by an earlier version, read back by a Windows install.
  assert.equal(
    isManagedNotifyCmd(["/usr/bin/env", "node", WIN_TRACKER_BIN], expected),
    true,
  );
});

test("isManagedNotifyCmd rejects foreign commands and mismatched --source args", () => {
  const expected = [SYSTEM_NODE, WIN_TRACKER_BIN];
  assert.equal(isManagedNotifyCmd(["python", "notify.py"], expected), false);
  // notify.cjs from some other tool, not under ~/.tokentracker/.
  assert.equal(
    isManagedNotifyCmd([SYSTEM_NODE, "C:\\other\\bin\\notify.cjs"], expected),
    false,
  );
  assert.equal(isManagedNotifyCmd(null, expected), false);
  assert.equal(isManagedNotifyCmd([], expected), false);
  // The Every Code command must not be mistaken for the Codex one.
  assert.equal(
    isManagedNotifyCmd([APP_NODE, WIN_TRACKER_BIN, "--source=every-code"], expected),
    false,
  );
  assert.equal(
    isManagedNotifyCmd([APP_NODE, WIN_TRACKER_BIN], [
      SYSTEM_NODE,
      WIN_TRACKER_BIN,
      "--source=every-code",
    ]),
    false,
  );
});

test("uninstall removes a notify command written by a different Node executable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codex-restore-"));
  const codexConfigPath = path.join(dir, "config.toml");
  const notifyOriginalPath = path.join(dir, "codex_notify_original.json");
  try {
    // Config as the desktop app left it: argv[0] is the bundled node.
    await fs.writeFile(
      codexConfigPath,
      `model = "gpt-5-codex"\nnotify = [${JSON.stringify(APP_NODE)}, ${JSON.stringify(WIN_TRACKER_BIN)}]\n`,
      "utf8",
    );
    // Setup recorded that the user had no notify of their own.
    await fs.writeFile(
      notifyOriginalPath,
      JSON.stringify({ notify: null, capturedAt: new Date().toISOString() }),
      "utf8",
    );

    // Uninstall runs from a terminal, so it builds argv[0] = system node.
    const result = await restoreCodexNotify({
      codexConfigPath,
      notifyOriginalPath,
      notifyCmd: [SYSTEM_NODE, WIN_TRACKER_BIN],
    });

    assert.equal(result.skippedReason, null);
    assert.equal(result.restored, true);
    const after = await fs.readFile(codexConfigPath, "utf8");
    assert.ok(!after.includes("notify"), after);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("setup never records our own stale command as the user's original notify", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codex-capture-"));
  const codexConfigPath = path.join(dir, "config.toml");
  const notifyOriginalPath = path.join(dir, "codex_notify_original.json");
  try {
    // Our own command is in the config, but the backup file is gone (the user
    // deleted ~/.tokentracker). Capturing it would make uninstall "restore"
    // our dead command forever.
    await fs.writeFile(
      codexConfigPath,
      `model = "gpt-5-codex"\nnotify = [${JSON.stringify(APP_NODE)}, ${JSON.stringify(WIN_TRACKER_BIN)}]\n`,
      "utf8",
    );

    await upsertCodexNotify({
      codexConfigPath,
      notifyCmd: [SYSTEM_NODE, WIN_TRACKER_BIN],
      notifyOriginalPath,
      captureOriginal: true,
    });

    const captured = JSON.parse(await fs.readFile(notifyOriginalPath, "utf8").catch(() => "null"));
    if (captured) assert.equal(captured.notify, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
