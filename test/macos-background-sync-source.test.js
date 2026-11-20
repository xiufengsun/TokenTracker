const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("macOS background sync sends auto background while Sync Now drains", () => {
  const apiClient = read("TokenTrackerBar/TokenTrackerBar/Services/APIClient.swift");
  const viewModel = read("TokenTrackerBar/TokenTrackerBar/ViewModels/DashboardViewModel.swift");
  const refreshPolicy = read("TokenTrackerBar/TokenTrackerBar/Models/BackgroundRefreshPolicy.swift");
  const appDelegate = read("TokenTrackerBar/TokenTrackerBar/TokenTrackerBarApp.swift");
  const statusBarController = read("TokenTrackerBar/TokenTrackerBar/Services/StatusBarController.swift");

  assert.match(
    apiClient,
    /func triggerSync\(drain: Bool = false, auto: Bool = false\) async throws -> SyncResponse/,
  );
  assert.match(
    apiClient,
    /if drain \{[\s\S]*"auto":true,"background":true,"allLocalSources":true,"publishAccount":true,"drain":true[\s\S]*\} else if auto \{[\s\S]*"auto":true,"background":true,"allLocalSources":true,"publishAccount":true/,
  );
  assert.match(
    viewModel,
    /func syncThenLoad\(silent: Bool = false\)[\s\S]*APIClient\.shared\.triggerSync\(auto: true\)/,
  );
  assert.match(
    viewModel,
    /private func syncThenRefreshHidden\([\s\S]*triggerSync\(auto: true\)[\s\S]*refreshHiddenData/,
    "Hidden background refresh should sync once and then load only visible menu data.",
  );
  assert.match(
    viewModel,
    /if shouldSync \{[\s\S]*syncThenRefreshHidden\(menuBarSummaries: summaries\)[\s\S]*else if self\.isPopoverVisible[\s\S]*refreshHiddenData/,
    "The five-minute loop must avoid a full dashboard load while the popover is hidden.",
  );
  assert.match(
    apiClient,
    /localSyncResourceTimeout: TimeInterval = 130[\s\S]*syncConfig\.timeoutIntervalForResource = Self\.localSyncResourceTimeout[\s\S]*requestSession = path == "\/functions\/tokentracker-local-sync"/,
    "Local sync requests need a resource timeout longer than the server's 120-second response window.",
  );
  assert.match(
    apiClient,
    /func fetchSummaryWithSource\([\s\S]*latestAccountSummaryReadCompletedAt = completedAt/,
    "Every summary response should return its own authority and track account-cache completion.",
  );
  assert.match(
    apiClient,
    /private func fetchWithSource<T: Decodable>\([\s\S]*X-TokenTracker-Account-View[\s\S]*X-TokenTracker-Account-Fallback/,
    "The shared sourced fetch must read both account-view headers.",
  );
  assert.match(
    viewModel,
    /summaryPublicationState\.record\([\s\S]*for: \.today[\s\S]*for: \.rolling[\s\S]*for: \.total/,
    "Today, rolling, and total must keep independent publication authority.",
  );
  assert.match(
    viewModel,
    /private func performManualSync\(\)[\s\S]*APIClient\.shared\.triggerSync\(drain: true\)/,
  );
  assert.match(refreshPolicy, /static let defaultSyncInterval: TimeInterval = 300/);
  assert.match(
    appDelegate,
    /NSWorkspace\.didWakeNotification[\s\S]*NSWorkspace\.screensDidWakeNotification[\s\S]*NSWorkspace\.sessionDidBecomeActiveNotification/,
    "System wake, display wake, and session activation should all share the debounced catch-up path.",
  );
  assert.match(
    appDelegate,
    /wakeCatchUpDebounceInterval: TimeInterval = 60[\s\S]*scheduleWakeCatchUp/,
    "Overlapping wake notifications must remain coalesced instead of spawning duplicate syncs.",
  );
  assert.match(
    viewModel,
    /func catchUpAfterWakeOrSessionActive[\s\S]*if isPopoverVisible \{[\s\S]*syncThenLoad\(\)[\s\S]*syncThenRefreshHidden\(menuBarSummaries: summaries\)[\s\S]*else if isPopoverVisible \{[\s\S]*loadAll\(\)[\s\S]*refreshHiddenData\(menuBarSummaries: summaries\)/,
    "Hidden wake catch-up must use the same lightweight path as the timer.",
  );
  assert.match(
    viewModel,
    /private func refreshHiddenDataContents[\s\S]*checkServerHealth\(\)[\s\S]*guard serverOnline[\s\S]*WidgetSnapshotWriter\.hasConfiguredWidgets\(\)[\s\S]*await loadAll\(\)[\s\S]*loadMenuBarSummaries\(summaries, checkHealth: false\)[\s\S]*refreshUsageLimits\(\)/,
    "Hidden refresh must preserve full freshness for configured widgets, then use summaries and limits for everyone else.",
  );
  assert.match(
    viewModel,
    /if hiddenRefreshInFlight \{[\s\S]*pendingFullRefreshAfterHiddenRefresh = true/,
    "Opening the popover during hidden work must queue one full refresh.",
  );
  assert.match(
    viewModel,
    /private func finishHiddenRefresh\(\)[\s\S]*guard pendingFullRefreshAfterHiddenRefresh[\s\S]*await loadAll\(\)/,
    "The queued full refresh must run when hidden work completes.",
  );
  const widgetWriter = read("TokenTrackerBar/TokenTrackerBar/Services/WidgetSnapshotWriter.swift");
  assert.match(
    widgetWriter,
    /func hasConfiguredWidgets\(\) async -> Bool[\s\S]*getCurrentConfigurations[\s\S]*!configurations\.isEmpty[\s\S]*resume\(returning: true\)/,
    "Widget discovery should avoid full hidden loads when unused and fail toward freshness on query errors.",
  );
  assert.match(
    statusBarController,
    /private func selectedMenuBarSummaries\(\)[\s\S]*desktopPetController\.isVisible[\s\S]*summaries\.formUnion\(\[\.today, \.rolling\]\)/,
    "Queue writes must refresh the visible pet's today and rolling totals even when menu-bar stats are hidden.",
  );
});
