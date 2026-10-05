const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const statusBarControllerPath = path.join(
  __dirname,
  "..",
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "StatusBarController.swift",
);

function readStatusBarController() {
  return fs.readFileSync(statusBarControllerPath, "utf8");
}

function readDashboardView() {
  return fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "TokenTrackerBar",
      "TokenTrackerBar",
      "Views",
      "DashboardView.swift",
    ),
    "utf8",
  );
}

test("menu-bar popover keeps cached dashboard content visible during background sync", () => {
  const source = readDashboardView();

  assert.match(
    source,
    /if\s+viewModel\.isSyncing\s*&&\s*viewModel\.summary\s*==\s*nil\s*\{/,
    "Background sync should only replace the dashboard with a blocking progress view before the first summary exists.",
  );
  assert.doesNotMatch(
    source,
    /if\s+viewModel\.isSyncing\s*\{/,
    "An unconditional isSyncing branch hides cached content every time the popover triggers a background refresh.",
  );
});

test("menu-bar popover restores Tahoe glass via deferred activation with a realign guard", () => {
  const source = readStatusBarController();
  const toggleStart = source.indexOf("private func togglePopover()");
  const toggleEnd = source.indexOf("private func makePopoverAnchorWindow()");
  const togglePopover = source.slice(toggleStart, toggleEnd);
  const didCloseStart = source.indexOf("private func handlePopoverDidClose()");
  const didCloseEnd = source.indexOf("// MARK: - Click Handling");
  const handlePopoverDidClose = source.slice(didCloseStart, didCloseEnd);

  // Full Liquid Glass needs app activation on macOS 26+, but activating in the
  // same runloop pass as popover.show() strands the popover on another display
  // (#481). The contract: activation is deferred to the next runloop tick,
  // gated on the popover still being shown, and followed by a realign guard.
  assert.match(
    togglePopover,
    /DispatchQueue\.main\.async[\s\S]*?self\.popover\.isShown[\s\S]*?if\s+#available\(macOS\s+26,\s*\*\)\s*\{[\s\S]*?canActivateForPopoverGlass\(\)[\s\S]*?NSApp\.activate\(ignoringOtherApps:\s*true\)[\s\S]*?realignPopoverWithAnchorIfDisplaced\(\)/,
    "Tahoe activation must be deferred past the anchoring pass, gated on popover.isShown plus the focus-steal guard, and followed by the realign guard (#481).",
  );
  assert.ok(
    togglePopover.indexOf("let popoverAdmitted") !== -1 &&
      togglePopover.indexOf("let popoverAdmitted") < togglePopover.indexOf("#available(macOS 26"),
    "Only the glass activation is macOS 26-only. The admission check and its activate + re-show fallback must run on every version, or macOS 15 never gets the popover onto another app's full-screen Space (#681).",
  );
  assert.match(
    source,
    /private\s+func\s+canActivateForPopoverGlass\(\)\s*->\s*Bool\s*\{[\s\S]*?window\.canBecomeKey[\s\S]*?window\.screen\s*!==\s*anchorScreen\s*\|\|\s*!window\.isOnActiveSpace[\s\S]*?return\s+false/,
    "Activation must be skipped while another key-capable window is visible on a different screen or Space — it would dismiss the transient popover (#481).",
  );
  assert.ok(
    togglePopover.indexOf("window.makeKey()") <
      togglePopover.indexOf("NSApp.activate(ignoringOtherApps: true)"),
    "Forced activation must never run before the popover is key, or AppKit may restore a stale Dashboard window and Space.",
  );
  const activateMatches = togglePopover.match(/NSApp\.activate/g) || [];
  assert.equal(
    activateMatches.length,
    2,
    "togglePopover must contain exactly two NSApp.activate calls — the guarded everyday one and the full-screen admission one, both deferred.",
  );
  assert.ok(
    togglePopover.indexOf("DispatchQueue.main.async") <
      togglePopover.indexOf("NSApp.activate"),
    "A synchronous NSApp.activate in the popover-open path regresses #481; it must stay inside the deferred block.",
  );
  assert.match(
    togglePopover,
    /if\s+ProcessInfo\.processInfo\.systemUptime\s*-\s*popoverShownAt\s*>\s*0\.5\s*\{\s*closePopoverIfShown\(\)\s*\}/,
    "One physical click on the full-screen revealed menu bar dispatches the button action twice (macOS 26); the close toggle must be debounced or the popover closes before it is ever seen.",
  );
  assert.match(
    togglePopover,
    /anchorWindow\.addChildWindow\(window,\s*ordered:\s*\.above\)/,
    "The popover window must be attached as a child of the anchor window — an inactive app's popover is otherwise never admitted onto another app's full-screen Space.",
  );
  assert.match(
    togglePopover,
    /isOnActiveSpace[\s\S]*?reshowPopoverOnActiveSpace\(\)/,
    "When the popover is not admitted onto the active Space, activation plus the one-shot re-show recovery must run.",
  );
  assert.match(
    togglePopover,
    /let\s+popoverAdmitted\s*=\s*self\.popover\.contentViewController\?\.view\.window\?\.isOnActiveSpace/,
    "Admission must be read off the popover window, not the anchor: the anchor is canJoinAllSpaces and reports admitted on every regular desktop even while the popover stayed pinned to another one (#506).",
  );
  assert.match(
    togglePopover,
    /if\s+let\s+reusedWindow\s*=\s*popover\.contentViewController\?\.view\.window\s*\{\s*reusedWindow\.collectionBehavior\.insert\(\[\.canJoinAllSpaces,\s*\.fullScreenAuxiliary\]\)\s*\}\s*popover\.show\(/,
    "The reused _NSPopoverWindow must be marked canJoinAllSpaces BEFORE show() — the Space assignment happens inside show(), so the post-show insert lands too late and the popover renders on one desktop only (#506).",
  );
  assert.match(
    source,
    /private\s+func\s+reshowPopoverOnActiveSpace\(\)\s*\{[\s\S]*?guard\s+!popoverReshowAttempted\s+else\s*\{\s*return\s*\}[\s\S]*?popoverReshowAttempted\s*=\s*true[\s\S]*?togglePopover\(\)/,
    "The re-show recovery must be latched to a single attempt so it can never loop.",
  );
  assert.match(
    source,
    /closePopoverIfShown\(\)\s*\n\s*\/\/[\s\S]*?DispatchQueue\.main\.async\s*\{\s*\[weak self\]\s*in\s*self\?\.togglePopover\(\)\s*\}/,
    "A stranded popover must be re-shown on the next tick: the reused window has to order out first, and an inline toggle would be swallowed by the double-dispatch guard.",
  );
  assert.match(
    source,
    /private\s+func\s+positionPopoverAnchorWindow[\s\S]*?NSEvent\.mouseLocation[\s\S]*?clickScreen\s*!=\s*buttonScreen/,
    "The anchor must follow the display the click happened on — the status item's real window can live on another display's menu bar (#481).",
  );
  assert.match(
    handlePopoverDidClose,
    /removeChildWindow\(popoverWindow\)/,
    "Popover close must detach the reused popover window from the anchor or the next show inherits a stale child relationship.",
  );
  assert.match(
    source,
    /private\s+func\s+realignPopoverWithAnchorIfDisplaced\(\)\s*\{[\s\S]*?popoverWindow\.screen\s*!==\s*anchorWindow\.screen[\s\S]*?popoverWindow\.setFrame\(frame,\s*display:\s*true\)/,
    "The realign guard must compare the popover window against the app-owned anchor and move it back when displaced (#481).",
  );
  assert.match(
    togglePopover,
    /addChildWindow[\s\S]*?DispatchQueue\.main\.async\s*\{\s*\[weak self\]\s*in\s*self\?\.realignPopoverWithAnchorIfDisplaced\(\)\s*\}\s*popoverDismissMonitor/,
    "Every show must run a next-tick realign so an edge-clipped popover is pulled back on-screen.",
  );
  assert.match(
    source,
    /private\s+func\s+realignPopoverWithAnchorIfDisplaced\(\)\s*\{[\s\S]*?guard\s+let\s+screen\s*=\s*anchorWindow\.screen[\s\S]*?frame\.origin\.x\s*=\s*PopoverPlacementPolicy\.originX\([\s\S]*?screenFrame:\s*screen\.frame/,
    "Realign must screen-clamp the origin against the anchor's own screen; hard-centering or clamping against a wrong screen frame pushes the panel off-screen near an edge.",
  );
  assert.match(
    togglePopover,
    /window\.makeKey\(\)/,
    "The popover window should remain key for keyboard and VoiceOver interaction.",
  );
  assert.match(
    togglePopover,
    /NSEvent\.addGlobalMonitorForEvents\(\s*matching:\s*\[[^\]]*\.leftMouseDown[^\]]*\.rightMouseDown[^\]]*\]/,
    "An inactive app needs a global mouse monitor so clicks in other apps still close the transient popover.",
  );
  assert.match(
    togglePopover,
    /popoverDismissMonitor\s*=\s*NSEvent\.addGlobalMonitorForEvents[\s\S]*?closePopoverIfShown\(\)/,
    "The stored global monitor must close the popover.",
  );
  assert.match(
    handlePopoverDidClose,
    /NSEvent\.removeMonitor\(popoverDismissMonitor\)[\s\S]*self\.popoverDismissMonitor\s*=\s*nil/,
    "Popover cleanup must remove and clear the global mouse monitor.",
  );
});

test("menu-bar popover is anchored to an app-owned positioning window", () => {
  const source = readStatusBarController();
  const didCloseStart = source.indexOf("forName: NSPopover.didCloseNotification");
  const didCloseEnd = source.indexOf("// MARK: - Click Handling");
  const didCloseObserver = source.slice(didCloseStart, didCloseEnd);

  assert.match(
    source,
    /private\s+var\s+popoverAnchorWindow:\s*NSWindow\?/,
    "StatusBarController should keep an app-owned anchor window for stable popover positioning.",
  );
  assert.match(
    source,
    /private\s+func\s+makePopoverAnchorWindow\(\)\s*->\s*NSWindow[\s\S]*styleMask:\s*\[\.borderless\][\s\S]*collectionBehavior\s*=\s*\[[^\]]*\.canJoinAllSpaces[^\]]*\.fullScreenAuxiliary[^\]]*\.ignoresCycle[^\]]*\.stationary[^\]]*\]/,
    "The anchor window should be borderless, invisible, and allowed in full-screen Spaces.",
  );
  assert.match(
    source,
    /private\s+func\s+positionPopoverAnchorWindow\(under\s+button:\s*NSStatusBarButton\)\s*->\s*NSView\?[\s\S]*button\.window[\s\S]*convertToScreen[\s\S]*setFrame\(anchorFrame,\s*display:\s*false\)[\s\S]*orderFrontRegardless\(\)/,
    "The anchor window should be positioned from the clicked status button's screen rect before showing the popover.",
  );
  assert.match(
    source,
    /guard\s+let\s+anchorView\s*=\s*positionPopoverAnchorWindow\(under:\s*button\)[\s\S]*popover\.show\(relativeTo:\s*anchorView\.bounds,\s*of:\s*anchorView,\s*preferredEdge:\s*\.minY\)/,
    "The popover should show relative to the app-owned anchor view, not the system status button window.",
  );
  assert.match(
    source,
    /private\s+func\s+closePopoverIfShown\(\)\s*\{[\s\S]*if\s+popover\.isShown\s*\{[\s\S]*popover\.performClose\(nil\)[\s\S]*\}\s*popoverAnchorWindow\?\.orderOut\(nil\)/,
    "Closing the popover path should also hide the app-owned anchor window.",
  );
  assert.match(
    source,
    /if\s+popover\.isShown\s*\{[\s\S]*?closePopoverIfShown\(\)[\s\S]*?return\s*\}/,
    "Left-click toggling should use the same synchronous close cleanup path as other close triggers (with the duplicate-dispatch debounce).",
  );
  assert.match(
    didCloseObserver,
    /queue:\s*\.main/,
    "The did-close cleanup uses MainActor.assumeIsolated, so the observer must run on the main queue.",
  );
  assert.match(
    source,
    /forName:\s*NSPopover\.didCloseNotification[\s\S]*object:\s*popover[\s\S]*\)\s*\{\s*\[weak self\]\s+_\s+in\s*MainActor\.assumeIsolated\s*\{\s*self\?\.handlePopoverDidClose\(\)\s*\}/,
    "The popover did-close observer should clean up synchronously on the main actor before the next open can reuse the anchor window.",
  );
  assert.doesNotMatch(
    didCloseObserver,
    /Task\s*\{\s*@MainActor/,
    "The did-close cleanup must not be deferred through an unstructured MainActor task.",
  );
  assert.match(
    source,
    /Task\s*\{\s*await\s+viewModel\.refreshForPopoverOpen\(\)\s*\}/,
    "Opening the popover should run the throttled lightweight sync path before reloading dashboard data.",
  );
  assert.doesNotMatch(
    source,
    /Task\s*\{\s*await\s+viewModel\.loadAll\(\)\s*\}/,
    "Opening the popover should not only reload cached dashboard data.",
  );

  const viewModelPath = path.join(
    __dirname,
    "..",
    "TokenTrackerBar",
    "TokenTrackerBar",
    "ViewModels",
    "DashboardViewModel.swift",
  );
  const viewModel = fs.readFileSync(viewModelPath, "utf8");
  assert.match(
    viewModel,
    /lastPopoverOpenSyncAttemptAt\s*=\s*now\s*await\s+syncThenLoad\(silent:\s*true\)/,
    "Popover-open opportunistic sync must stay silent so it never plays the sync animation over cached content.",
  );
  const refreshPolicy = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "TokenTrackerBar",
      "TokenTrackerBar",
      "Models",
      "BackgroundRefreshPolicy.swift",
    ),
    "utf8",
  );
  assert.match(
    refreshPolicy,
    /static let defaultPopoverOpenSyncInterval: TimeInterval = 300/,
    "Popover-open sync should match the background sync cadence instead of re-syncing every minute.",
  );
  assert.match(
    viewModel,
    /shouldRunPopoverOpenLoad\([\s\S]*lastRefreshed/,
    "When popover sync is throttled, dashboard reload should also be debounced by lastRefreshed.",
  );
  assert.match(
    viewModel,
    /guard\s+!isLoading\s+else\s*\{\s*shouldReloadAfterCurrentLoad\s*=\s*true\s*return\s*\}/,
    "Concurrent dashboard reload requests should queue one follow-up load instead of being dropped.",
  );
  assert.match(
    viewModel,
    /private\s+func\s+finishDataLoad\([^)]*\)\s+async[\s\S]*shouldReloadAfterCurrentLoad\s*=\s*false[\s\S]*await\s+loadAll\(\)/,
    "A queued reload should run after the current load finishes so sync-now can refresh stale data.",
  );
  assert.match(
    viewModel,
    /needsFullRefreshOnPopoverOpen\s*=\s*true[\s\S]*guard\s+!summaries\.isEmpty/,
    "Hidden publication refreshes must mark charts and detail data dirty even when no token summary is selected.",
  );
  assert.match(
    viewModel,
    /else if needsFullRefreshOnPopoverOpen \|\| BackgroundRefreshPolicy\.shouldRunPopoverOpenLoad/,
    "Opening the popover must reload dirty full-dashboard data even inside the normal 30-second debounce.",
  );
});
