const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "../TokenTrackerWin", file), "utf8");

test("tray summary updates never wake the dashboard renderer to read currency", () => {
  const source = read("TrayApplicationContext.cs");
  const summary = source.slice(source.indexOf("private Task RefreshSummaryOnceAsync()"), source.indexOf("private void PersistCurrencyFromDashboard()"));
  assert.match(summary, /var \(symbol, rate\) = _summaryCurrency;/);
  assert.doesNotMatch(summary, /ReadCurrencyAsync|ExecuteScriptAsync|ReadPersisted/);
  const persist = source.slice(source.indexOf("private async Task PersistCurrencyFromDashboardAsync()"), source.indexOf("private void PostToUi("));
  assert.match(persist, /revision != _currencyReadRevision/);
  assert.match(persist, /currency is null\) return;/);
  assert.match(persist, /_summaryCurrency = \(symbol, rate\);[\s\S]*RefreshSummary\(\);/);
});

test("failed currency reads preserve the last known currency instead of persisting USD", () => {
  const source = read("DashboardWindow.cs");
  const currency = source.slice(source.indexOf("public async Task<(string Symbol, decimal Rate)?> ReadCurrencyAsync()"), source.indexOf("public async Task<string> ReadLocalePreferenceAsync()"));
  assert.match(currency, /if \(!_coreReady\) return null;/);
  assert.match(currency, /catch \{ return null; \}/);
});

test("hidden and minimized dashboards suspend with OAuth and restore race protection", () => {
  const source = read("DashboardWindow.cs");
  assert.match(source, /IsVisibleChanged[^\n]*UpdateWebViewActivity/);
  assert.match(source, /_activity\?\.Update\(IsVisible && WindowState != WindowState.Minimized, _oauthInFlight\)/);
  assert.match(source, /visible => view.Visibility = visible \? Visibility.Visible : Visibility.Collapsed/);
  assert.match(source, /core.Resume, core.TrySuspendAsync, Log/);
  // Behavioral coverage for pending suspension, recovery and OAuth is in
  // WebViewActivityTests; keep this check on the native host's wiring only.
  assert.match(source, /_activity\?\.Dispose\(\);[\s\S]*_activity = null;/);
  assert.doesNotMatch(source, /--disable-background-timer-throttling|--disable-renderer-backgrounding|--disable-backgrounding-occluded-windows/);
  const oauth = source.slice(source.indexOf("private void BeginNativeOAuth()"), source.indexOf("private async Task WaitForNativeOAuthTimeoutAsync("));
  assert.match(oauth, /_oauthInFlight = true;[\s\S]*UpdateWebViewActivity/);
  assert.match(oauth, /var attempt = \+\+_oauthAttempt;/);
  assert.match(source, /WaitForNativeOAuthTimeoutAsync\(_oauthTimeout\.Token, attempt\)/);
  assert.match(source, /ExpireNativeOAuth\(long attempt\)/);
  assert.match(source, /if \(attempt != _oauthAttempt \|\| !_oauthInFlight\) return;/);
});
