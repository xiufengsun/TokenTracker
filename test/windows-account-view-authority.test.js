"use strict";

// Windows counterpart of test/macos-account-view-authority.test.js.
//
// The tray/pet poller hits the same `?account=1` contract as the macOS popover
// and had the same defect: it read `X-TokenTracker-Account-View`, stored it in a
// flag nobody consumed, and published the payload regardless — so a transient
// cloud failure dropped the tray from cross-device totals to this machine.
//
// The behaviour itself is covered end-to-end against a loopback server in
// TokenTrackerWin.Tests/UsagePollerAccountAuthorityTests.cs, which CI runs on a
// Windows runner. These assertions are the cheap cross-platform half: they hold
// the *shape* of the code (no write-only flags, both headers read, the guards
// wired to this poll's authority) on runners with no .NET toolchain.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");
const usagePoller = fs.readFileSync(
  path.join(repoRoot, "TokenTrackerWin/UsagePoller.cs"),
  "utf8",
);

test("the write-only AccountViewActive flag is gone", () => {
  assert.doesNotMatch(
    usagePoller,
    /AccountViewActive/,
    "Tracking the account view in a field nobody reads is what made the bug invisible.",
  );
});

test("both account-view headers are read, transient matched by prefix", () => {
  assert.match(
    usagePoller,
    /private static AccountSource ReadAccountSource\(HttpResponseMessage resp\)/,
  );
  assert.match(usagePoller, /"X-TokenTracker-Account-View"/);
  assert.match(usagePoller, /"X-TokenTracker-Account-Fallback"/);
  assert.match(
    usagePoller,
    /reason\.StartsWith\("transient", StringComparison\.Ordinal\)\n\s*\? AccountSource\.LocalTransient\n\s*: AccountSource\.LocalAuthoritative/,
    "New transient reasons must not require a client change; a missing reason stays authoritative.",
  );
});

test("a transient fallback skips the publish instead of overwriting account figures", () => {
  assert.match(
    usagePoller,
    /var summarySource = ReadAccountSource\(resp\);\n\s*if \(summarySource == AccountSource\.LocalTransient && _showingAccountData\) return null;/,
    "Returning null leaves TrayApplicationContext._lastStats — the account snapshot — untouched.",
  );
});

test("rich pet stats cannot mix authorities into one published snapshot", () => {
  assert.match(
    usagePoller,
    /private async Task<\(int Streak, int ActiveDays\)\?> FetchHeatmapAsync\(/,
    "FetchHeatmapAsync must be able to signal a would-be downgrade.",
  );
  assert.match(
    usagePoller,
    /private async Task<IReadOnlyList<TopModelStat>\?> FetchTopModelsAsync\(/,
    "FetchTopModelsAsync must be able to signal a would-be downgrade.",
  );
  for (const guard of [
    /FetchHeatmapAsync\([\s\S]*?string tzQuery, bool retainAccount, string refreshQuery, CancellationToken cancellationToken = default\)[\s\S]*?if \(ReadAccountSource\(resp\) == AccountSource\.LocalTransient && retainAccount\) return null;/,
    /FetchTopModelsAsync\([\s\S]*?string today, string tzQuery, bool retainAccount, string refreshQuery, CancellationToken cancellationToken = default\)[\s\S]*?if \(ReadAccountSource\(resp\) == AccountSource\.LocalTransient && retainAccount\) return null;/,
  ]) {
    assert.match(usagePoller, guard, "each rich sub-fetch must apply the same rule");
  }
  assert.match(
    usagePoller,
    /if \(heatmap is null \|\| topModels is null\) return null;/,
    "UsageStats is published atomically, so one degraded dataset skips the whole poll.",
  );
});

test("the rich-stat guards read this poll's authority, not the last publish's", () => {
  // `_showingAccountData` is assigned at the very end of FetchAsync, so it
  // describes the *previous* published snapshot. It starts false, so on a cold
  // start — and on any local-to-account transition — a summary that came back
  // as Account paired with a transient heatmap/model response would pass a
  // guard written against the old flag alone, mixing this machine's streak and
  // top models into an account-authoritative UsageStats. Worse, the next poll
  // then sees the flag as true, returns null, and leaves that mixed snapshot
  // rendering in the tray until the failing dataset recovers.
  assert.match(
    usagePoller,
    /var retainAccount = summarySource == AccountSource\.Account \|\| _showingAccountData;/,
    "The retention decision must include what THIS poll is about to render as.",
  );
  for (const call of [
    /var heatmapTask = FetchHeatmapAsync\(tzQuery, retainAccount, refreshQuery, cancellationToken\);/,
    /var modelsTask = FetchTopModelsAsync\(today, tzQuery, retainAccount, refreshQuery, cancellationToken\);/,
  ]) {
    assert.match(usagePoller, call, "both rich sub-fetches must be told the current authority");
  }
  // The flag must not be consulted directly inside the helpers any more.
  const heatmapBody = usagePoller.slice(usagePoller.indexOf("FetchHeatmapAsync(string tzQuery"));
  assert.doesNotMatch(
    heatmapBody,
    /_showingAccountData/,
    "A helper reading the previous-publish flag reintroduces the transition gap.",
  );
});

test("account authority is recorded only on a real publish", () => {
  assert.match(
    usagePoller,
    /_showingAccountData = summarySource == AccountSource\.Account;\n\s*return new UsageStats\(/,
    "The flag must track what is actually on screen, not what the last response said.",
  );
});
