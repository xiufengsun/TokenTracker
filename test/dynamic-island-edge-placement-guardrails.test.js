const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const policySource = fs.readFileSync(
  path.join(root, "TokenTrackerBar/TokenTrackerBar/Models/DynamicIslandPlacementPolicy.swift"),
  "utf8",
);
const controllerSource = fs.readFileSync(
  path.join(root, "TokenTrackerBar/TokenTrackerBar/Services/DynamicIslandController.swift"),
  "utf8",
);
const viewSource = fs.readFileSync(
  path.join(root, "TokenTrackerBar/TokenTrackerBar/Views/DynamicIslandView.swift"),
  "utf8",
);
const bridgeSource = fs.readFileSync(
  path.join(root, "TokenTrackerBar/TokenTrackerBar/Services/NativeBridge.swift"),
  "utf8",
);
const labsSource = fs.readFileSync(
  path.join(root, "dashboard/src/components/settings/LabsSection.jsx"),
  "utf8",
);

test("placement policy keeps edge collapsed metrics off and orthogonal to hide-icon", () => {
  assert.match(policySource, /showsCollapsedMetrics\(for placement: DynamicIslandPlacement\) -> Bool/);
  assert.match(policySource, /placement == \.island/);
  assert.match(policySource, /edgePillDepth/);
  assert.match(policySource, /edgePillLength/);
  assert.doesNotMatch(
    policySource,
    /hideMenuBarIcon|HideMenuBar/,
    "placement geometry must stay orthogonal to hide-menu-bar-icon",
  );
});

test("controller reloads placement and pins edge panel to the right", () => {
  assert.match(controllerSource, /func reloadPlacement\(\)/);
  assert.match(controllerSource, /state\.placement == \.edge/);
  assert.match(controllerSource, /edgePanelFrame\(/);
  assert.match(controllerSource, /edgeHitRect\(/);
  assert.match(
    controllerSource,
    /appliesWingMetrics\(for: state\.placement\)/,
    "wing width must be ignored in edge mode",
  );
});

test("view uses a fixed edge pill without collapsed metric wings", () => {
  assert.match(viewSource, /edgeCollapsedPill/);
  assert.match(viewSource, /EdgeNotchShape/);
  assert.match(viewSource, /showsCollapsedMetrics\(for: state\.placement\)/);
  assert.match(viewSource, /state\.placement == \.edge/);
  assert.doesNotMatch(
    viewSource,
    /clipShape\(Capsule\(\)\)/,
    "collapsed edge must use EdgeNotchShape, not a bare Capsule",
  );
});

test("edge shape uses gentle isotropic curl with content inset", () => {
  assert.match(viewSource, /edgeContentInsetX/);
  assert.match(viewSource, /edgeContentInsetTop/);
  assert.match(viewSource, /edgeContentInsetBottom/);
  assert.match(viewSource, /edgeExpandedContentInset/);
  assert.doesNotMatch(
    viewSource,
    /edgeCurl \+ 4/,
    "horizontal inset must not pad with curl+4 (left gutter)",
  );
  assert.match(policySource, /edgeExpandedContentInset: CGFloat = 6/);
  assert.match(policySource, /edgeExpandedContentInsetTop: CGFloat = 12/);
  assert.match(policySource, /edgeExpandedContentInsetBottom: CGFloat = 18/);
  // Inset must be inside the fixed islandWidth (pad-then-frame), never grow
  // chrome past the trailing reveal mask. Vertical is balanced (bottom >= top).
  assert.match(viewSource, /\.padding\(\.top, edgeContentInsetTop\)[\s\S]*?\.padding\(\.bottom, edgeContentInsetBottom\)[\s\S]*?\.padding\(\.horizontal, edgeContentInsetX\)[\s\S]*?\.frame\(width: islandWidth/);

  assert.match(viewSource, /EdgeNotchShape\(curlRadius:/);
  assert.match(policySource, /edgeCurlExpanded: CGFloat = 18/);
  assert.match(policySource, /edgeCurlIdeal: CGFloat = 8/);
  assert.match(policySource, /edgeExpandedContentInset/);
  assert.match(policySource, /edgeExpandedContentInsetTop/);
  assert.match(policySource, /edgeExpandedContentInsetBottom/);
  assert.match(policySource, /edgeVerticalOffsetKey/);
  assert.match(policySource, /edgePanelFrame/);
  // Default rest still centers; offset shifts within clamp.
  assert.match(policySource, /\(available - height\) \/ 2/);
  assert.match(policySource, /clampEdgeVerticalOffset/);
});

test("controller uses CodeNotch-like unfold spring for edge expand", () => {
  assert.match(controllerSource, /EdgeNotchMotion\.unfold/);
  assert.match(controllerSource, /state\.placement == \.edge/);
});

test("edge shape is gentle isotropic curl without stretched ears", () => {
  const shape = fs.readFileSync(
    path.join(root, "TokenTrackerBar/TokenTrackerBar/Views/EdgeNotchShape.swift"),
    "utf8",
  );
  assert.match(shape, /struct EdgeNotchShape/);
  assert.match(shape, /enum EdgeNotchMotion/);
  assert.match(shape, /response: 0\.62/);
  assert.match(shape, /dampingFraction: 0\.72/);
  assert.match(shape, /circleReach/);
  assert.match(shape, /var curlRadius/);
  assert.doesNotMatch(shape, /fluidTurn/, "no fluidTurn ear path");
  assert.doesNotMatch(shape, /filletRamp/, "no filletRamp");
  // Along-edge run must stay isotropic (curl, not curl*3 stretch).
  assert.doesNotMatch(shape, /curlDepth \* 3/, "no along-stretch ears");
  assert.match(policySource, /edgeCurlRadius/);
  assert.match(policySource, /edgeCornerRadius/);
  assert.match(policySource, /edgeCurlIdeal: CGFloat = 8/);
});

test("collapsed edge chrome has no drop shadow or stroke AA dirt", () => {
  // Collapsed must gate shadow/stroke to expanded-only (flush join stays clean).
  assert.match(viewSource, /opacity\(expanded \? 0\.22 : 0\)/);
  assert.match(viewSource, /radius: expanded \? 12 : 0/);
  assert.match(
    viewSource,
    /if expanded \{[\s\S]*?edgeShape[\s\S]*?\.stroke\(/,
    "expanded edge may keep a light rim; collapsed must not stroke",
  );
});

test("reloadPlacement refreshes fullscreen presence for the new screen", () => {
  assert.match(
    controllerSource,
    /func reloadPlacement\(\)[\s\S]*?fullscreenActive = readFullscreenActive\(\)[\s\S]*?applyPresence\(\)/,
  );
  assert.match(controllerSource, /func presenceScreen\(\) -> NSScreen\?/);
});

test("native bridge exposes and accepts dynamicIslandPlacement", () => {
  assert.match(bridgeSource, /"dynamicIslandPlacement"/);
  assert.match(bridgeSource, /case "dynamicIslandPlacement":/);
  assert.match(bridgeSource, /DynamicIslandPlacementPolicy\.write/);
});

test("Labs settings offers island vs edge segmented control", () => {
  assert.match(labsSource, /dynamicIslandPlacement/);
  assert.match(labsSource, /SegmentedControl/);
  assert.match(labsSource, /settings\.labs\.island_placement/);
});

test("controller long-press drag repositions edge vertically", () => {
  assert.match(controllerSource, /installEdgeDragMonitors/);
  assert.match(controllerSource, /handleEdgeMouseDown/);
  assert.match(controllerSource, /beginEdgeDrag/);
  assert.match(controllerSource, /writeEdgeVerticalOffset/);
  assert.match(controllerSource, /edgeLongPressDuration/);
  assert.match(controllerSource, /verticalOffset: edgeVerticalOffset/);
});
