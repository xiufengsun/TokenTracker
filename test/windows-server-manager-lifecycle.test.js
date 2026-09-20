const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function readServerManager() {
  return fs
    .readFileSync(path.join(repoRoot, "TokenTrackerWin/ServerManager.cs"), "utf8")
    .replace(/\r\n/g, "\n");
}

test("Windows server startup re-checks shutdown before and after child launch", () => {
  const source = readServerManager();
  const startup = source.slice(
    source.indexOf("private async Task StartServerOnceAsync()"),
    source.indexOf("    /// <summary>Run a one-shot", source.indexOf("private async Task StartServerOnceAsync()")),
  );

  assert.match(
    startup,
    /private async Task StartServerOnceAsync\(\)\n\s*\{\n\s*if \(_stopping\) return;/,
    "startup must stop before resolving/launching a runtime after shutdown begins",
  );
  assert.match(
    startup,
    /var process = LaunchServer\([\s\S]*?if \(_stopping\)\n\s*\{\n\s*CleanupLaunchedProcess\(process\);\n\s*return;/,
    "a child created in the stop/launch race must be cleaned up",
  );
});

test("Windows server liveness and notifications are race-safe", () => {
  const source = readServerManager();

  assert.match(
    source,
    /var currentProcess = Volatile\.Read\(ref _serverProcess\);[\s\S]*?IsProcessAlive\(currentProcess\)/,
    "startup checks must tolerate a Process disposed by a concurrent stop",
  );
  assert.match(
    source,
    /private static bool IsProcessAlive\(Process process\)[\s\S]*?catch \{ return false; \}/,
    "process-handle races must be treated as not alive",
  );
  assert.match(source, /private void RaiseStatusChanged\(ServerStatus status\)/);
  assert.match(source, /private void RaiseSyncStarted\(\)/);
  assert.match(source, /private void RaiseSyncCompleted\(\)/);
  assert.doesNotMatch(
    source.replace(/private void RaiseStatusChanged[\s\S]*?private void RaiseSyncStarted/, ""),
    /StatusChanged\?\.Invoke\(/,
    "status callbacks outside the guarded boundary could terminate a process callback thread",
  );
});

test("Windows server teardown and health probes keep process identity", () => {
  const source = readServerManager();
  const launchStart = source.indexOf("private Process? LaunchServer(");
  const launchEnd = source.indexOf("    private void CleanupLaunchedProcess", launchStart);
  const launch = source.slice(launchStart, launchEnd);
  assert.match(
    launch,
    /catch \(Exception ex\)[\s\S]*?CleanupLaunchedProcess\(process\);[\s\S]*?if \(!_stopping\)\s*\n\s*Fail\(/,
    "post-launch setup failures must kill/dispose the child before reporting failure",
  );

  const waitStart = source.indexOf("private async Task<bool> WaitForServerAsync(");
  const waitEnd = source.indexOf("    private static async Task<bool> CheckHealthAsync", waitStart);
  const wait = source.slice(waitStart, waitEnd);
  assert.match(
    wait,
    /CheckHealthAsync\(expectedBaseUrl\)[\s\S]*?IsCurrentServerProcess\(expectedProcess\)/,
    "a successful startup probe must be followed by an identity/liveness check",
  );

  const healthStart = source.indexOf("private void StartHealthLoop(");
  const health = source.slice(healthStart);
  assert.match(
    health,
    /await CheckHealthAsync\(expectedBaseUrl\)[\s\S]*?IsCurrentHealthLoop\(process, expectedBaseUrl, generation, cts\)[\s\S]*?SetStatus\(ServerStatus.Running\)/,
    "a cancelled or superseded health loop must discard probe results before publishing status",
  );
  assert.match(
    health,
    /RetireHealthLoop\(cts, generation\)[\s\S]*?RequestRestart\("health checks failed"\)/,
    "only the current health loop may request recovery",
  );
});

test("Windows background sync cannot hold the single-flight slot forever", () => {
  const source = readServerManager();

  // The loopback client is deliberately unbounded, so the only thing standing
  // between a dead socket (a suspended laptop is the usual cause) and a
  // permanently stuck tray is a watchdog on the per-request token. Without it
  // _syncInFlight never clears, which silences both the five-minute timer and
  // the "Sync Now" menu item while `tracker sync` in a terminal still works.
  assert.match(
    source,
    /Timeout = Timeout\.InfiniteTimeSpan/,
    "the local API still owns the sync budget; do not add a finite client timeout",
  );
  assert.match(
    source,
    /private static readonly TimeSpan BackgroundSyncDeadline = TimeSpan\.FromMinutes\((\d+)\)/,
    "the background sync slot needs an explicit deadline constant",
  );
  const minutes = Number(
    /private static readonly TimeSpan BackgroundSyncDeadline = TimeSpan\.FromMinutes\((\d+)\)/.exec(source)[1],
  );
  // The local API kills its sync child at SYNC_TIMEOUT_MS (120s), and macOS
  // caps the same exchange at 130s. Stay above that so a slow but live publish
  // is never cut short.
  assert.ok(minutes >= 3, `BackgroundSyncDeadline must exceed the server's own 120s budget, got ${minutes}m`);

  const trigger = source.slice(
    source.indexOf("public void TriggerBackgroundSync()"),
    source.indexOf("private bool StartDirectSync()"),
  );
  assert.match(
    trigger,
    /cts = new CancellationTokenSource\(\);\n\s*cts\.CancelAfter\(BackgroundSyncDeadline\);/,
    "every background sync token must carry the deadline before the slot is claimed",
  );
});
