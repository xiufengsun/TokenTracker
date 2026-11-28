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
  // Inno Setup accepts CloseApplications=force|yes|no. ForceCloseApplications
  // is only a command-line switch (/FORCECLOSEAPPLICATIONS), not a [Setup]
  // directive; CI's ISCC 6.7.1 rejects the latter.
  assert.match(iss, /^\s*CloseApplications=force\s*$/m);
  assert.doesNotMatch(iss, /^\s*ForceCloseApplications\s*=/m);
  assert.match(iss, /^\s*RestartApplications=no\s*$/m);
});

test("every Windows tray and settings update entry point requires user confirmation", () => {
  const tray = read("TokenTrackerWin", "TrayApplicationContext.cs").replace(/\r\n/g, "\n");

  const onCheckStart = tray.indexOf("private void OnCheckUpdatesClicked()");
  const promptStart = tray.indexOf("private void PromptAndInstallPendingUpdate()");
  const manualStart = tray.indexOf("private async Task RunManualCheckAsync()");
  assert.ok(onCheckStart >= 0 && promptStart > onCheckStart && manualStart > promptStart);

  const onCheckBody = tray.slice(onCheckStart, promptStart);
  assert.match(
    onCheckBody,
    /case UpdateChecker\.UpdateState\.UpdateAvailable:\s*PromptAndInstallPendingUpdate\(\);/,
    "tray 'Update to vX' and Settings 'checkForUpdates' must prompt instead of installing directly",
  );
  assert.doesNotMatch(
    onCheckBody,
    /DownloadAndInstallAsync/,
    "OnCheckUpdatesClicked must never bypass confirmation",
  );

  const manualEnd = tray.indexOf("private void RefreshUpdateMenuItem()");
  assert.ok(manualEnd > manualStart);
  const manualBody = tray.slice(manualStart, manualEnd);
  assert.match(
    manualBody,
    /case UpdateChecker\.CheckOutcome\.UpdateAvailable:\s*PromptAndInstallPendingUpdate\(\);/,
    "manual update check must also confirm via PromptAndInstallPendingUpdate",
  );

  const promptBody = tray.slice(promptStart, manualStart);
  assert.match(promptBody, /MessageBox\.Show\(/);
  assert.match(promptBody, /if \(confirm == DialogResult\.Yes\)\s*_ = RunDashboardUpdateNowAsync\(\);/);

  // Only RunDashboardUpdateNowAsync (invoked after Sidebar ConfirmModal or MessageBox confirmation)
  // triggers DownloadAndInstallAsync.
  const runActionStart = tray.indexOf("private void RunDashboardNativeAction(string name)");
  const runUpdateStart = tray.indexOf("private async Task RunDashboardUpdateNowAsync()");
  assert.ok(runActionStart >= 0 && runUpdateStart > runActionStart);
  const runActionBody = tray.slice(runActionStart, runUpdateStart);
  assert.match(runActionBody, /case "checkForUpdates":\s*OnCheckUpdatesClicked\(\);/);
  assert.match(runActionBody, /case "updateNow":\s*_ = RunDashboardUpdateNowAsync\(\);/);

  const pushStart = tray.indexOf("private void PushDashboardNativeSettings()");
  assert.ok(pushStart >= 0);
  const pushBody = tray.slice(pushStart, tray.indexOf("private void ApplyDashboardNativeSetting", pushStart));
  assert.match(
    pushBody,
    /updateInProgress = _updateChecker\.State is UpdateChecker\.UpdateState\.Downloading\s+or UpdateChecker\.UpdateState\.Installing,/,
  );
});
