const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const apiClientPath = path.join(
  __dirname,
  "..",
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "APIClient.swift",
);
const dashboardViewModelPath = path.join(
  __dirname,
  "..",
  "TokenTrackerBar",
  "TokenTrackerBar",
  "ViewModels",
  "DashboardViewModel.swift",
);

function readAPIClient() {
  return fs.readFileSync(apiClientPath, "utf8");
}

test("macOS usage-limits request outlives the server provider timeout budget", () => {
  const source = readAPIClient();

  assert.match(
    source,
    /private static let usageLimitsRequestTimeout: TimeInterval = 25/,
    "The limits request needs headroom above the server's 15-second per-provider timeout.",
  );
  assert.match(
    source,
    /func fetchUsageLimits\(devinEnabled: Bool = false, hiddenProviders: \[String\] = \[\]\)[\s\S]*fetch\([\s\S]*"\/functions\/tokentracker-usage-limits"[\s\S]*requestTimeout: Self\.usageLimitsRequestTimeout[\s\S]*\)/,
    "Only the usage-limits endpoint should opt into the longer request timeout.",
  );
  assert.match(
    source,
    /if let requestTimeout \{[\s\S]*request\.timeoutInterval = requestTimeout[\s\S]*session\.data\(for: request\)/,
    "The endpoint-specific timeout must be applied to its URLRequest.",
  );
});

test("macOS usage-limits hydrates the last good record before refreshing", () => {
  const source = fs.readFileSync(dashboardViewModelPath, "utf8");

  assert.match(
    source,
    /usageLimits = UsageLimitsCache\.load\(\)\?\.applyingDevinSelection/,
    "A restarted app should render its last good limits record instead of a skeleton — with Devin rows stripped while its switch is off.",
  );
  assert.match(
    source,
    /APIClient\.shared\.fetchUsageLimits\(\s*devinEnabled: selected,\s*hiddenProviders: Self\.fetchGateHiddenProviders\(\)\s*\)[\s\S]*limitsPublicationAuthority\.publish\([\s\S]*UsageLimitsCache\.save\(published,\s*devinSelected: LimitsSettingsStore\.shared\.isVisible\("devin"\)\)/,
    "A successful background refresh must persist the authoritative record with the current Devin selection, so disabled quota is also removed from disk.",
  );
});

test("macOS local API session bypasses URLCache after a system clock rollback", () => {
  const source = readAPIClient();

  assert.match(
    source,
    /self\.session = URLSession\(configuration: LocalAPIConfiguration\.makeSessionConfiguration\(\)\)/,
    "The API client must use the configuration covered by the native runtime test.",
  );
});
