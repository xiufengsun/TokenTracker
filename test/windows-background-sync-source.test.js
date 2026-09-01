const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("Windows background sync publishes through the authenticated local API", () => {
  const serverManager = read("TokenTrackerWin/ServerManager.cs");
  const publisher = read("TokenTrackerWin/LocalSyncPublisher.cs");
  const trayContext = read("TokenTrackerWin/TrayApplicationContext.cs");

  assert.match(trayContext, /new\(\)\s*\{\s*Interval\s*=\s*5\s*\*\s*60\s*\*\s*1000\s*\}/);
  assert.match(trayContext, /_syncTimer\.Tick \+= \(_, _\) => TriggerBackgroundSync\(\)/);
  assert.match(
    trayContext,
    /ServerStatus\.Running[\s\S]*_syncTimer\.Start\(\);[\s\S]*TriggerBackgroundSync\(\);/,
  );
  assert.match(
    serverManager,
    /public void TriggerBackgroundSync\(\)[\s\S]*RunBackgroundSyncAsync\(cts\)/,
    "Windows timer sync should run asynchronously through the local API",
  );
  assert.match(
    serverManager,
    /new LocalSyncPublisher\(\s*LocalSyncHttp,\s*BaseUrl\s*\)\.PublishAsync\(/,
    "ServerManager should delegate the authenticated exchange to the tested publisher",
  );
  assert.match(publisher, /\/api\/local-auth/);
  assert.match(
    publisher,
    /HttpMethod\.Post[\s\S]*\/functions\/tokentracker-local-sync/,
  );
  assert.match(publisher, /x-tokentracker-local-auth/);
  assert.match(
    publisher,
    /"\{\\"auto\\":true,\\"background\\":true,\\"allLocalSources\\":true,\\"publishAccount\\":true,\\"nativeOnlyWsl\\":true\}"/,
    "Windows background sync should publish all local sources and request native-only WSL",
  );
  assert.match(
    serverManager,
    /LocalSyncHttp[\s\S]*UseProxy\s*=\s*false[\s\S]*Timeout\s*=\s*Timeout\.InfiniteTimeSpan/,
    "Background local sync must let the server own its complete budget and cancel on shutdown",
  );
  assert.match(serverManager, /SyncStarted\?\.Invoke\(\)/);
  assert.match(serverManager, /SyncCompleted\?\.Invoke\(\)/);
  assert.match(serverManager, /public void TriggerSync\(\)[\s\S]*StartDirectSync\(\)/);
  assert.match(
    serverManager,
    /var args = new\[\] \{ "sync" \};[\s\S]*StartTrackerProcess\([\s\S]*\n\s*false,\s*args\)/,
    "Manual sync should remain the direct exhaustive plain sync path",
  );
});
