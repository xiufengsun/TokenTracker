const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const controllerSource = fs.readFileSync(
  path.join(
    __dirname,
    "../TokenTrackerBar/TokenTrackerBar/Services/DynamicIslandController.swift",
  ),
  "utf8",
);

const policySource = fs.readFileSync(
  path.join(
    __dirname,
    "../TokenTrackerBar/TokenTrackerBar/Models/DynamicIslandLayoutPolicy.swift",
  ),
  "utf8",
);

test("the island leaves another app's full-screen Space instead of overlaying it", () => {
  const behaviorMatch = controllerSource.match(
    /panel\.collectionBehavior\s*=\s*\[([^\]]+)\]/,
  );
  assert.ok(behaviorMatch, "island panel must set an explicit collectionBehavior");
  assert.match(behaviorMatch[1], /\.canJoinAllSpaces\b/);
  assert.doesNotMatch(
    behaviorMatch[1],
    /\.fullScreenAuxiliary\b/,
    "fullScreenAuxiliary would keep the island on top of native full-screen Spaces",
  );
});

test("island presence is gated on a testable full-screen policy", () => {
  assert.match(
    policySource,
    /enum\s+DynamicIslandFullscreenPolicy/,
    "full-screen decisions must live in a pure policy, not only AppKit glue",
  );
  assert.match(
    policySource,
    /static\s+func\s+shouldShowPanel\(featureEnabled:\s*Bool,\s*fullscreenActive:\s*Bool\)/,
  );
  assert.match(
    controllerSource,
    /DynamicIslandFullscreenPolicy\.shouldShowPanel\(/,
    "the controller must consult the policy before showing the panel",
  );
  assert.match(
    controllerSource,
    /NSWorkspace\.activeSpaceDidChangeNotification/,
    "space changes (native full-screen enter/exit) must refresh presence",
  );
  assert.match(
    controllerSource,
    /NSWorkspace\.didActivateApplicationNotification/,
    "app switches must refresh presence so a newly focused full-screen app hides the island",
  );
  assert.match(
    controllerSource,
    /NSApp\.observe\(\s*\\\.currentSystemPresentationOptions/,
    "same-space full-screen changes presentation options without a Space or app switch",
  );
  assert.match(
    controllerSource,
    /func setEnabled\([\s\S]*?fullscreenActive = readFullscreenActive\(\)[\s\S]*?applyPresence\(\)/,
    "enabling the island must re-read full-screen state so it does not appear over an already full-screen app",
  );
  assert.match(
    controllerSource,
    /CGRectMakeWithDictionaryRepresentation/,
    "window bounds must come from the CFDictionary helper; a [String: CGFloat] cast drops real window lists",
  );
});

test("Dynamic Island restore settles on fullscreen events with a bounded burst, not a poll", () => {
  const settleFunctionMatch = controllerSource.match(
    /private func scheduleNextFullscreenSettle\(\) \{([\s\S]*?)\n    private func cancelFullscreenSettleRetries/,
  );
  assert.ok(
    settleFunctionMatch,
    "scheduleNextFullscreenSettle must exist as its own function, bounded above cancelFullscreenSettleRetries",
  );
  const settleBody = settleFunctionMatch[1];

  assert.match(
    settleBody,
    /guard\s+fullscreenSettleAttempt\s*<\s*Self\.fullscreenSettleDelays\.count\s+else\s*\{\s*return\s*\}/,
    "each tick must check a bounded attempt index against the delay list before scheduling another",
  );
  assert.match(
    settleBody,
    /fullscreenSettleAttempt\s*\+=\s*1/,
    "each tick must advance the attempt index — a reschedule with no advancing counter is the old unbounded loop",
  );
  assert.match(
    settleBody,
    /guard self\.fullscreenActive else \{ return \}\s*\n\s*self\.scheduleNextFullscreenSettle\(\)/,
    "a tick may only schedule the next one while still full-screen, and must call the bounded scheduler",
  );

  assert.doesNotMatch(
    controllerSource,
    /if self\.fullscreenActive \{\s*\n\s*self\.scheduleFullscreenRetry\(\)/,
    "the old unbounded retry loop (reschedule on fullscreenActive alone, no attempt bound) must not come back",
  );
  assert.doesNotMatch(
    controllerSource,
    /Self\.retryInterval/,
    "a single fixed retryInterval heartbeat must not come back — settling now uses a bounded delay list",
  );

  assert.match(
    policySource,
    /static\s+let\s+settleDelays:\s*\[TimeInterval\]\s*=\s*\[[^\]]+\]/,
    "the settle schedule must be a finite array of delays, not a single repeating interval",
  );
  assert.doesNotMatch(
    policySource,
    /static\s+let\s+retryInterval/,
    "the old single-interval retry constant must be gone",
  );

  assert.match(
    controllerSource,
    /func armFullscreenSettleRetries\(\)\s*\{[^}]*fullscreenSettleAttempt = 0/,
    "arming a burst must reset the attempt index so a new signal restarts the schedule from the top",
  );

  assert.match(
    controllerSource,
    /deinit\s*\{[^}]*fullscreenSettleWorkItem\?\.cancel\(\)/,
    "deinit must cancel the pending settle work item",
  );
  assert.match(
    controllerSource,
    /func setEnabled\([^)]*\)\s*\{[^}]*cancelFullscreenSettleRetries\(\)/,
    "setEnabled must cancel any in-flight settle burst before re-reading",
  );
  assert.match(
    controllerSource,
    /func setEnabled\([^)]*\)\s*\{[^}]*if enabled && fullscreenActive \{\s*\n\s*armFullscreenSettleRetries\(\)/,
    "setEnabled may only arm a new settle burst when enabled && fullscreenActive",
  );

  assert.match(
    controllerSource,
    /DynamicIslandRestorePolicy\.mustForceShowDuringDismissal\(/,
    "applyPresence must consult the testable restore policy, not an inlined isVisibilityDismissing check",
  );
  assert.match(
    controllerSource,
    /NSApplication\.didBecomeActiveNotification/,
    "app activation must remain a restore signal even though it alone cannot cover a background exit",
  );
});
