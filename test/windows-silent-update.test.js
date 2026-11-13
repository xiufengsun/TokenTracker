const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");

test("silent Windows upgrade relaunches only after a successful install", () => {
  const source = read("TokenTrackerWin", "UpdateChecker.cs");
  const method = source.indexOf("internal static string BuildSilentInstallerArguments");
  const launch = source.indexOf("private static void LaunchSilentInstaller");
  assert.ok(method >= 0 && launch > method, "LaunchSilentInstaller must use the extracted argument builder");

  const builder = source.slice(method, launch);
  assert.match(builder, /\/FORCECLOSEAPPLICATIONS/);
  assert.match(builder, /&& start \\\"\\\"/);
  assert.doesNotMatch(builder, /[^&]& start /);
  assert.match(builder, /--startup/);
  assert.match(
    source.slice(launch, source.indexOf("ProcessStartInfo", launch)),
    /BuildSilentInstallerArguments\(setupPath,\s*appExe\)/,
    "the detached cmd must be built by BuildSilentInstallerArguments",
  );
});

test("silent Windows upgrade work does not resume on the WinForms synchronization context", () => {
  const source = read("TokenTrackerWin", "UpdateChecker.cs");
  assert.match(
    source,
    /if \(SynchronizationContext\.Current is not null\)\s*return await Task\.Run\(\(\) => CheckAsync\(silent\)\)/,
  );
  assert.match(
    source,
    /if \(SynchronizationContext\.Current is not null\)\s*return await Task\.Run\(\(\) => DownloadAndInstallAsync\(\)\)/,
  );

  const tray = read("TokenTrackerWin", "TrayApplicationContext.cs");
  assert.match(tray, /Task\.Run\(\(\) => _updateChecker\.CheckAsync\(silent: true\)\)/);
  assert.match(tray, /Task\.Run\(\(\) => _updateChecker\.DownloadAndInstallAsync\(\)\)/);
  assert.doesNotMatch(tray, /_ = _updateChecker\.(CheckAsync|DownloadAndInstallAsync)\(/);
});

test("the Windows installer force-closes a crashed host during upgrade", () => {
  const iss = read("TokenTrackerWin", "installer", "TokenTracker.iss");
  assert.match(iss, /^\s*CloseApplications=yes\s*$/m);
  assert.match(iss, /^\s*ForceCloseApplications=yes\s*$/m);
  assert.match(iss, /^\s*RestartApplications=no\s*$/m);
});
