"use strict";

// Guard rails for the native popover's account-view authority.
//
// There is no Swift test target in this repo (see TokenTrackerBar/project.yml),
// so the invariants that keep a transient cloud failure from silently shrinking
// the popover to this-machine data are asserted against the source itself.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("Dynamic Island usage follows local queue writes independently of menu bar metrics", () => {
  const root = "TokenTrackerBar/TokenTrackerBar/";
  const api = read(root + "Services/APIClient.swift");
  const view = read(root + "Views/DynamicIslandView.swift");
  const status = read(root + "Services/StatusBarController.swift");
  const localReader = api.slice(api.indexOf("func fetchLocalIslandUsage("), api.indexOf("func fetchSummary("));
  assert.match(localReader, /fetchLocalSummary\(from: range\.to, to: range\.to\)/);
  assert.match(localReader, /fetchLocalSummary\(from: range\.from, to: range\.to\)/);
  assert.match(localReader, /fetch\("\/functions\/tokentracker-usage-summary", queryItems: withTimeZoneQueryItems/);
  assert.doesNotMatch(localReader, /withAccountQueryItems|fetchSummaryWithSource/);
  assert.match(view, /APIClient\.shared\.fetchLocalIslandUsage\(\)/);
  assert.doesNotMatch(view, /viewModel\.(?:today|rolling|last7d|last30d|total)/);
  assert.match(view, /UsageLimitsView\(limits: viewModel\.usageLimits/);
  assert.match(status, /queueActivityMonitor\.onSettledActivity[\s\S]*?dynamicIslandController\.refreshLocalUsage\(\)\s*let summaries = self\.selectedMenuBarSummaries/);
});

test("account fallback reasons are classified, and transient ones are recognised by prefix", () => {
  const source = read("TokenTrackerBar/TokenTrackerBar/Models/AccountViewSource.swift");

  assert.match(source, /case account\b/);
  assert.match(source, /case localAuthoritative\(reason: String\)/);
  assert.match(source, /case localTransient\(reason: String\)/);
  assert.match(
    source,
    /if reason\.hasPrefix\("transient"\) \{ return \.localTransient\(reason: reason\) \}/,
    "Transient reasons must be matched by prefix so the server can add new ones.",
  );
  assert.match(
    source,
    /return \.localAuthoritative\(reason: reason\.isEmpty \? "unspecified" : reason\)/,
    "A server too old to send the fallback header must keep the pre-fix behaviour.",
  );
});

test("a transient fallback never replaces an account snapshot that is already shown", () => {
  const source = read("TokenTrackerBar/TokenTrackerBar/Models/AccountViewSource.swift");

  assert.match(
    source,
    /mutating func shouldAdopt\([\s\S]*guard source\.isTransientFallback else \{[\s\S]*return true\n {8}\}/,
    "Authoritative sources (account, signed out, cloud sync off) always publish.",
  );
  assert.match(
    source,
    /degradedDatasets\.insert\(dataset\)\n {8}if hasExistingValue, recordByDataset\[dataset\]\?\.source\.isAccount == true \{[\s\S]*return false/,
    "A transient fallback must keep the existing account snapshot.",
  );
  assert.match(
    source,
    /recordByDataset\[dataset\] = Record\(source: source, scope: scope\)\n {8}return true\n {4}\}/,
    "With no account snapshot to keep, local data is still better than an empty panel.",
  );
});

test("every account-capable popover fetch keeps its response authority", () => {
  const apiClient = read("TokenTrackerBar/TokenTrackerBar/Services/APIClient.swift");

  for (const fn of [
    "fetchDaily",
    "fetchHeatmap",
    "fetchModelBreakdown",
    "fetchMonthly",
    "fetchHourly",
  ]) {
    assert.match(
      apiClient,
      new RegExp(`func ${fn}\\([^)]*\\) async throws -> AccountFetchResult<`),
      `${fn} must return the account-view authority, not a bare payload.`,
    );
  }
  assert.match(
    apiClient,
    /X-TokenTracker-Account-Fallback/,
    "The fallback reason header must be read by the client.",
  );
  assert.doesNotMatch(
    apiClient,
    /withAccountQueryItems\(\[[\s\S]{0,200}?\]\)\)\n\t\}\n\n\tfunc fetch(Daily|Heatmap|Monthly|Hourly|ModelBreakdown)[^\n]*-> (Daily|Heatmap|Monthly|Hourly|Model)/,
    "No account endpoint may fall back to the header-dropping generic fetch.",
  );
});

test("the view model gates every dataset behind the account-view authority", () => {
  const viewModel = read("TokenTrackerBar/TokenTrackerBar/ViewModels/DashboardViewModel.swift");

  for (const dataset of [
    "todaySummary",
    "periodSummary",
    "rollingSummary",
    "totalSummary",
    "daily",
    "hourly",
    "monthly",
    "heatmap",
    "modelBreakdown",
  ]) {
    assert.match(
      viewModel,
      new RegExp(`for: \\.${dataset},`),
      `${dataset} must go through shouldPublish before overwriting what is on screen.`,
    );
  }

  assert.match(
    viewModel,
    /private static let accountRecoveryDelays: \[TimeInterval\] = \[1, 3, 10\]/,
    "A transient cloud failure should retry on a short backoff, not wait for the next tick.",
  );
  assert.match(
    viewModel,
    /if accountViewState\.isDegraded \{\n {12}scheduleAccountRecoveryRetry\(\)\n {8}\} else \{\n {12}cancelAccountRecovery\(\)/,
    "Recovery retries must stop as soon as the account view comes back.",
  );
  assert.match(
    viewModel,
    /guard accountRecoveryAttempt < Self\.accountRecoveryDelays\.count else \{ return \}/,
    "Retries must be bounded.",
  );
});

test("the local server tags why it served this-machine data", () => {
  const localApi = read("src/lib/local-api.js");

  assert.match(localApi, /const ACCOUNT_FALLBACK_CLOUD_SYNC_OFF = "cloud-sync-off";/);
  assert.match(localApi, /const ACCOUNT_FALLBACK_SIGNED_OUT = "signed-out";/);
  assert.match(
    localApi,
    /res\.setHeader\("X-TokenTracker-Account-View", "0"\);\n\s*res\.setHeader\("X-TokenTracker-Account-Fallback", result\);/,
    "Every local fallback response must carry its reason.",
  );
  assert.match(
    localApi,
    /function classifyAccountFallback\(err\)[\s\S]*return "transient-timeout"[\s\S]*return "transient-auth"[\s\S]*return "transient-network"/,
    "Timeout, auth and network failures must be distinguishable in logs.",
  );
});

test("dataset authority is keyed by query scope, not by dataset alone", () => {
  const source = read("TokenTrackerBar/TokenTrackerBar/Models/AccountViewSource.swift");
  const viewModel = read("TokenTrackerBar/TokenTrackerBar/ViewModels/DashboardViewModel.swift");

  assert.match(
    source,
    /mutating func shouldAdopt\(\n\s*_ source: AccountViewSource,\n\s*for dataset: Dataset,\n\s*scope: String,\n\s*hasExistingValue: Bool\n\s*\) -> Bool \{/,
    "Authority is only meaningful for the query it was recorded on.",
  );
  assert.match(
    source,
    /if let record = recordByDataset\[dataset\], record\.scope != scope \{\n\s*recordByDataset\.removeValue\(forKey: dataset\)\n\s*degradedDatasets\.remove\(dataset\)\n\s*\}\n\s*guard source\.isTransientFallback else \{/,
    "A record from a scope the view has left must be dropped BEFORE the retained-snapshot rule runs, or last period's numbers outrank this period's response.",
  );

  // Every gated publish must name the scope it answers for; one that forgets
  // reintroduces the cross-scope retention this test exists to prevent.
  const calls = viewModel.match(/self\.shouldPublish\(/g) ?? [];
  const scoped = viewModel.match(/scope: AccountViewStateStore\.Scope\./g) ?? [];
  assert.ok(calls.length >= 12, `expected the full set of gated publishes, found ${calls.length}`);
  assert.equal(
    scoped.length,
    calls.length,
    "every shouldPublish call site must pass the scope its response answers for",
  );

  // Period-scoped datasets follow the selection; sliding windows deliberately
  // do not, so midnight gives a transient failure no fresh chance to downgrade.
  assert.match(viewModel, /for: \.periodSummary,\n\s*scope: AccountViewStateStore\.Scope\.range\(range\.from, range\.to\)/);
  assert.match(viewModel, /for: \.modelBreakdown,\n\s*scope: AccountViewStateStore\.Scope\.range\(range\.from, range\.to\)/);
  assert.match(viewModel, /for: \.monthly,\n\s*scope: AccountViewStateStore\.Scope\.range\(range\.from, range\.to\)/);
  assert.match(viewModel, /for: \.hourly,\n\s*scope: AccountViewStateStore\.Scope\.day\(rollingTo\)/);
  assert.match(viewModel, /for: \.heatmap,\n\s*scope: AccountViewStateStore\.Scope\.heatmap/);

  // The full load and the hidden menu-bar refresh both publish todaySummary.
  // They must key it on the same local day string, or each would invalidate the
  // other's authority every pass and hand a transient failure a way through.
  const todayScopes = viewModel.match(/for: \.todaySummary,\n\s*scope: [^\n]+/g) ?? [];
  assert.equal(todayScopes.length, 2, "both publish paths must scope todaySummary");
  for (const scoped of todayScopes) {
    assert.match(scoped, /AccountViewStateStore\.Scope\.day\(/);
  }

  // The executed test below declares this enum locally to stay standalone.
  assert.match(
    read("TokenTrackerBar/TokenTrackerBar/Models/UsagePublicationPolicy.swift"),
    /enum UsageSummaryViewSource: Equatable \{\n {4}case localQueue\n {4}case accountUpload\n\}/,
    "Change this and the standalone driver in the executed test needs the same change.",
  );
});

// The store is Foundation-only, so where a Swift toolchain exists the state
// machine is exercised for real rather than pattern-matched. Skipped elsewhere
// (Linux validators, machines without Xcode) — the assertions above still hold
// the shape of the code there.
const swiftAvailable =
  process.platform === "darwin" &&
  spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status === 0;

test(
  "account authority does not survive a change of period or day (executed)",
  { skip: swiftAvailable ? false : "no Swift toolchain on this platform" },
  () => {
    const driver = `
import Foundation

// AccountViewSource.swift references this one type from
// UsagePublicationPolicy.swift, which drags in most of the app. Declaring the
// four lines here keeps the driver standalone; the assertion above pins the
// real enum's shape so this copy cannot silently drift.
enum UsageSummaryViewSource: Equatable {
    case localQueue
    case accountUpload
}

typealias Store = AccountViewStateStore
let month = Store.Scope.range("2026-08-01", "2026-08-31")
let week = Store.Scope.range("2026-08-31", "2026-09-06")
var failures = 0

func check(_ ok: Bool, _ what: String) {
    if !ok { failures += 1; FileHandle.standardError.write("FAIL \\(what)\\n".data(using: .utf8)!) }
}

// The reported regression: the user switches period while the cloud read fails.
var store = Store()
var summary: String? = nil
_ = store.shouldAdopt(.account, for: .periodSummary, scope: month, hasExistingValue: false)
summary = "month account totals"
let adopted = store.shouldAdopt(.localTransient(reason: "transient-network"),
                                for: .periodSummary, scope: week,
                                hasExistingValue: summary != nil)
if adopted { summary = "week local totals" }
check(adopted, "a new period's response must not be outranked by the old period's authority")
check(summary == "week local totals", "the panel must not keep last period's numbers")

// The invariant this whole guard exists for must survive: same scope, transient loses.
var sameScope = Store()
_ = sameScope.shouldAdopt(.account, for: .periodSummary, scope: month, hasExistingValue: false)
check(sameScope.shouldAdopt(.localTransient(reason: "transient-timeout"),
                            for: .periodSummary, scope: month,
                            hasExistingValue: true) == false,
      "a transient fallback still never replaces an account snapshot of the same scope")

// Signing out must still switch to local.
var signOut = Store()
_ = signOut.shouldAdopt(.account, for: .periodSummary, scope: month, hasExistingValue: false)
check(signOut.shouldAdopt(.localAuthoritative(reason: "signed-out"),
                          for: .periodSummary, scope: month,
                          hasExistingValue: true) == true,
      "an authoritative local view always replaces account data")

// A scope change also resets the retry budget.
var degraded = Store()
_ = degraded.shouldAdopt(.account, for: .modelBreakdown, scope: month, hasExistingValue: false)
_ = degraded.shouldAdopt(.localTransient(reason: "transient-network"),
                         for: .modelBreakdown, scope: month, hasExistingValue: true)
check(degraded.isDegraded, "a retained snapshot marks the dataset degraded")
_ = degraded.shouldAdopt(.account, for: .modelBreakdown, scope: week, hasExistingValue: true)
check(!degraded.isDegraded, "a healthy response on the new scope clears the degraded flag")

// Crossing midnight: yesterday's account hourly must not be kept under today's label.
var midnight = Store()
_ = midnight.shouldAdopt(.account, for: .hourly, scope: Store.Scope.day("2026-09-01"), hasExistingValue: false)
check(midnight.shouldAdopt(.localTransient(reason: "transient-network"),
                           for: .hourly, scope: Store.Scope.day("2026-09-02"),
                           hasExistingValue: true) == true,
      "a day-scoped dataset lets the new day through")

// Sliding windows keep a constant scope, so midnight is not an opening.
var heatmap = Store()
_ = heatmap.shouldAdopt(.account, for: .heatmap, scope: Store.Scope.heatmap, hasExistingValue: false)
check(heatmap.shouldAdopt(.localTransient(reason: "transient-network"),
                          for: .heatmap, scope: Store.Scope.heatmap,
                          hasExistingValue: true) == false,
      "the year heatmap keeps its account snapshot across midnight")

exit(failures == 0 ? 0 : 1)
`;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-account-scope-"));
    try {
      const driverPath = path.join(dir, "main.swift");
      const binary = path.join(dir, "scopecheck");
      fs.writeFileSync(driverPath, driver);
      const build = spawnSync(
        "swiftc",
        [
          path.join(repoRoot, "TokenTrackerBar/TokenTrackerBar/Models/AccountViewSource.swift"),
          driverPath,
          "-o",
          binary,
        ],
        { encoding: "utf8" },
      );
      assert.equal(build.status, 0, `swiftc failed:\n${build.stderr}`);
      const run = spawnSync(binary, { encoding: "utf8" });
      assert.equal(run.status, 0, `state machine violated its invariants:\n${run.stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
