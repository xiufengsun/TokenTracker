const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function readTrayContext() {
  return fs
    .readFileSync(path.join(repoRoot, "TokenTrackerWin/TrayApplicationContext.cs"), "utf8")
    .replace(/\r\n/g, "\n");
}

test("Windows tray schedules periodic silent update checks while resident", () => {
  const source = readTrayContext();

  // A long-lived tray process must re-check for updates, not only once at launch.
  assert.match(
    source,
    /private const int UpdateCheckIntervalMinutes = \d+ \* 60;/,
    "update check interval must be defined in hours worth of minutes",
  );
  assert.match(
    source,
    /private readonly System\.Windows\.Forms\.Timer _updateCheckTimer = new\(\)\n\s*\{\n\s*Interval = UpdateCheckIntervalMinutes \* 60 \* 1000,\n\s*\};/,
    "a dedicated timer must drive periodic update checks",
  );
  assert.match(
    source,
    /_updateCheckTimer\.Tick \+= \(_, _\) => _ = Task\.Run\(\(\) => _updateChecker\.CheckAsync\(silent: true\)\);\n\s*_updateCheckTimer\.Start\(\);/,
    "timer ticks must run the same silent check as launch, off the WinForms sync context",
  );
  // The launch check stays in place.
  assert.match(
    source,
    /_ = Task\.Run\(\(\) => _updateChecker\.CheckAsync\(silent: true\)\);\n\s*_updateCheckTimer\.Tick/,
    "the launch-time check must be kept alongside the periodic one",
  );
});

test("periodic update check timer is disposed with the tray context", () => {
  const source = readTrayContext();
  const disposeStart = source.indexOf("protected override void Dispose(bool disposing)");
  assert.notEqual(disposeStart, -1, "Dispose override must exist");
  const dispose = source.slice(disposeStart);

  assert.match(
    dispose,
    /_updateCheckTimer\.Dispose\(\);/,
    "the update check timer must be disposed to avoid leaks after quit",
  );
});
