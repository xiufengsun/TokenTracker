const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");
const appDelegatePath = path.join(
  repoRoot,
  "TokenTrackerBar",
  "TokenTrackerBar",
  "TokenTrackerBarApp.swift",
);
const dashboardWindowControllerPath = path.join(
  repoRoot,
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "DashboardWindowController.swift",
);

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("macOS defers every initial dashboard navigation until the bundled server startup settles", () => {
  const appDelegate = read(appDelegatePath);
  const controller = read(dashboardWindowControllerPath);
  const launchHandler = appDelegate.match(
    /func applicationDidFinishLaunching\([\s\S]*?\n    }\n\n    func applicationWillTerminate/,
  )?.[0];

  assert.ok(launchHandler, "AppDelegate should define its launch sequence");

  const ordinaryStart = launchHandler.indexOf("removeLegacyAppBundleIfNeeded()");
  assert.notEqual(ordinaryStart, -1, "ordinary startup should retain its original service initialization");
  const ordinaryLaunch = launchHandler.slice(ordinaryStart);
  const ensureIndex = ordinaryLaunch.indexOf("await serverManager.ensureServerRunning()");
  const allowIndex = ordinaryLaunch.indexOf(
    "DashboardWindowController.shared.allowDashboardNavigation()",
  );
  assert.notEqual(ensureIndex, -1, "launch should await the bundled server startup");
  assert.notEqual(allowIndex, -1, "launch should explicitly open the dashboard navigation gate");
  assert.ok(
    allowIndex > ensureIndex,
    "the navigation gate must remain closed until the old listener has been replaced",
  );
  const qaLaunch = launchHandler.slice(0, ordinaryStart);
  assert.match(qaLaunch, /guard await profile\.verifyServer\(\) else/);
  assert.ok(qaLaunch.indexOf("allowDashboardNavigation()") > qaLaunch.indexOf("verifyServer()"),
    "QA navigation must wait for its owned-server challenge");
  assert.doesNotMatch(qaLaunch, /ensureServerRunning\(|syncThenLoad\(|startAutoRefresh\(/);

  assert.match(controller, /private var dashboardNavigationAllowed = false/);
  assert.match(controller, /private var pendingDashboardURL: URL\?/);
  assert.match(controller, /func allowDashboardNavigation\(\)/);
  assert.match(
    controller,
    /private func loadDashboard\(_ url: URL\)[\s\S]*guard dashboardNavigationAllowed else \{[\s\S]*pendingDashboardURL = url[\s\S]*return[\s\S]*var request = URLRequest\(url: url\)[\s\S]*webView\?\.load\(request\)/,
    "all local dashboard loads should pass through one readiness gate",
  );

  const directLoads = controller.match(/webView\?*\.load\(/g) || [];
  assert.equal(
    directLoads.length,
    1,
    "only the gated loadDashboard helper may issue a WKWebView navigation",
  );
});
