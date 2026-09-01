const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("Windows background and manual sync keep separate execution paths", () => {
  const serverManager = read("TokenTrackerWin/ServerManager.cs");
  const publisher = read("TokenTrackerWin/LocalSyncPublisher.cs");
  const trayContext = read("TokenTrackerWin/TrayApplicationContext.cs");

  assert.match(
    trayContext,
    /new\(\)\s*\{\s*Interval\s*=\s*5\s*\*\s*60\s*\*\s*1000\s*\}/,
    "Windows tray background sync timer should remain a 5-minute timer",
  );
  assert.match(
    trayContext,
    /_syncTimer\.Tick \+= \(_, _\) => TriggerBackgroundSync\(\)/,
    "Windows timer tick should route through TriggerBackgroundSync",
  );
  assert.match(
    trayContext,
    /ServerStatus\.Running[\s\S]*_syncTimer\.Start\(\);[\s\S]*TriggerBackgroundSync\(\);/,
    "Windows server-running path should trigger the same background sync path",
  );
  assert.match(
    serverManager,
    /public void TriggerBackgroundSync\(\)[\s\S]*RunBackgroundSyncAsync\(cts\)/,
    "Windows background sync should select the asynchronous local API path",
  );
  assert.match(
    serverManager,
    /new LocalSyncPublisher\(\s*LocalSyncHttp,\s*BaseUrl\s*\)\.PublishAsync\(/,
    "Windows background sync should authenticate before posting all background flags",
  );
  assert.match(
    publisher,
    /\/api\/local-auth/,
    "The extracted publisher should own the authenticated background request",
  );
  assert.match(publisher, /\/functions\/tokentracker-local-sync/);
  assert.match(publisher, /nativeOnlyWsl/);
  const backgroundMethod = serverManager.match(
    /public void TriggerBackgroundSync\(\)[\s\S]*?\n    \}\r?\n\r?\n    private bool StartDirectSync/,
  )?.[0];
  assert.ok(backgroundMethod, "background sync method should remain discoverable");
  assert.doesNotMatch(
    backgroundMethod,
    /StartDirectSync\(\)/,
    "Windows background sync must not launch a second direct tracker process",
  );
  assert.match(
    serverManager,
    /public void TriggerSync\(\)[\s\S]*StartDirectSync\(\)/,
    "Manual sync should keep the direct tracker process path",
  );
  assert.match(
    serverManager,
    /var args = new\[\] \{ "sync" \};[\s\S]*StartTrackerProcess\([\s\S]*\n\s*false,\s*args\)/,
    "Manual sync should remain exhaustive plain sync and preserve the user's WSL mode",
  );
  assert.match(
    serverManager,
    /if \(forceNativeOnlyWslMode\)[\s\S]*psi\.Environment\["TOKENTRACKER_WSL_MODE"\]\s*=\s*"native-only";/,
    "The child launcher should retain the explicit WSL environment hook for authorized paths",
  );
  assert.match(serverManager, /StartTrackerProcess\(\s*nodePath,\s*entryPath,\s*false,\s*"serve"/);
});
