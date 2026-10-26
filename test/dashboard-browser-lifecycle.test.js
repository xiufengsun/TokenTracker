const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("macOS releases the dashboard WKWebView after a normal close", () => {
  const source = read(
    "TokenTrackerBar/TokenTrackerBar/Services/DashboardWindowController.swift",
  );

  assert.match(source, /private func releaseDashboardResources\(/);
  assert.match(source, /removeScriptMessageHandler\(forName: "nativeOAuth"\)/);
  assert.match(source, /removeScriptMessageHandler\(forName: "nativeBridge"\)/);
  assert.match(source, /NativeBridge\.shared\.webView = nil/);
  assert.match(source, /closingWindow\.contentView = nil/);
  assert.match(source, /self\.webView = nil/);
  assert.match(source, /self\.window = nil/);

  const closeHandler = source.match(
    /func windowWillClose\([\s\S]*?\r?\n    }\r?\n\r?\n    \/\/ MARK: - WKScriptMessageHandler/,
  )?.[0];
  assert.ok(closeHandler, "Dashboard close handler should exist");
  assert.match(closeHandler, /if oauthInFlight/);
  assert.match(closeHandler, /releaseDashboardResources\(closingWindow: closingWindow\)/);
});

test("macOS keeps PKCE state only while native OAuth is in flight", () => {
  const source = read(
    "TokenTrackerBar/TokenTrackerBar/Services/DashboardWindowController.swift",
  );
  const callbackSource = read("dashboard/src/pages/NativeAuthCallbackPage.jsx");

  assert.match(source, /private var oauthInFlight = false/);
  assert.match(source, /private var oauthTimeoutTask: Task<Void, Never>\?/);
  assert.match(source, /beginNativeOAuth\(\)/);
  assert.match(source, /completeNativeOAuth\(\)/);
  assert.match(source, /expireNativeOAuth\(\)/);
  assert.match(source, /messageType == "authCompleted"/);
  assert.match(callbackSource, /postNativeMessage\(\{ type: "authCompleted" \}\)/);
});

test("Windows hides and reuses the dashboard WebView2 on normal close", () => {
  const windowSource = read("TokenTrackerWin/DashboardWindow.cs");

  assert.match(windowSource, /private void CloseOrHideForOAuth\(\)/);
  assert.match(windowSource, /private WebView2CompositionControl _webView = CreateWebViewControl\(\)/);
  assert.match(windowSource, /_webView\.Dispose\(\)/);
  assert.match(windowSource, /private bool _oauthInFlight/);
  assert.match(windowSource, /BeginNativeOAuth\(\)/);
  assert.match(windowSource, /CompleteNativeOAuth\(\)/);
  assert.match(windowSource, /ExpireNativeOAuth\(long attempt\)/);
  assert.match(windowSource, /t\.GetString\(\) == "authCompleted"/);

  const closingHandler = windowSource.match(
    /protected override void OnClosing\([\s\S]*?\r?\n    }\r?\n\r?\n    protected override void OnClosed/,
  )?.[0];
  assert.ok(closingHandler, "Dashboard closing handler should exist");
  assert.match(closingHandler, /if \(!_exiting\)/);
  assert.match(closingHandler, /e\.Cancel = true;\s*Hide\(\);/);
  assert.doesNotMatch(
    closingHandler,
    /if \(!_exiting && _oauthInFlight\)/,
    "normal closes should use the same hide path as OAuth",
  );
});

test("Windows publishes WebView initialization before running it", () => {
  const source = read("TokenTrackerWin/DashboardWindow.cs");
  const initStart = source.indexOf("private Task InitializeWebViewAsync()");
  const retryStart = source.indexOf("    private async Task InitializeWebViewWithRetryAsync", initStart);
  const initSource = source.slice(initStart, retryStart);

  assert.match(
    initSource,
    /var completion = new TaskCompletionSource<bool>[\s\S]*?var task = completion\.Task[\s\S]*?_initializationTask = task[\s\S]*?_ = RunWebViewInitializationAsync\(task, completion\)/,
    "the in-flight task must be published before initialization starts",
  );
  assert.match(
    source,
    /private async Task RunWebViewInitializationAsync\([\s\S]*?ReferenceEquals\(_initializationTask, identity\)[\s\S]*?_initializationTask = null;/,
    "completion cleanup must not clear a newer initialization task",
  );
  assert.doesNotMatch(
    source.slice(retryStart, source.indexOf("    private async Task InitializeWebViewCoreAsync", retryStart)),
    /finally\s*\{\s*_initializationTask = null;/,
    "the retry routine must not unconditionally clear the shared task",
  );
});
