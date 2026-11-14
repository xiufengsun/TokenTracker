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

const viewSource = fs.readFileSync(
  path.join(
    __dirname,
    "../TokenTrackerBar/TokenTrackerBar/Views/DynamicIslandView.swift",
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

const bridgeSource = fs.readFileSync(
  path.join(
    __dirname,
    "../TokenTrackerBar/TokenTrackerBar/Services/NativeBridge.swift",
  ),
  "utf8",
);

test("the whole island rect owns hover, including the empty notch center", () => {
  assert.match(
    controllerSource,
    /return super\.hitTest\(point\) \?\? self/,
    "the AppKit container must claim empty points inside the island rect",
  );
  assert.match(
    controllerSource,
    /NSTrackingArea\(/,
    "the AppKit container must track hover independently of SwiftUI content",
  );
  assert.match(
    controllerSource,
    /override func mouseEntered[\s\S]*?handleHover\(true\)/,
    "entering any part of the island rect must route through handleHover(true)",
  );
  assert.match(
    controllerSource,
    /override func mouseExited[\s\S]*?handleHover\(false\)/,
    "leaving the island rect must route through handleHover(false)",
  );
  assert.doesNotMatch(
    viewSource,
    /\.onHover\(perform: onHoverChanged\)/,
    "SwiftUI content bounds must not be the authoritative island hover source",
  );
});

test("hover peeks by default and only expands on click unless expandOnHover is enabled", () => {
  assert.match(
    policySource,
    /static let expandOnHoverDefaultsKey = "DynamicIslandExpandOnHoverEnabled"/,
    "expand-on-hover preference must use a stable UserDefaults key",
  );
  assert.match(
    policySource,
    /enum DynamicIslandHoverAction:\s*Equatable\s*\{\s*case none\s*case peek\s*case expand\s*\}/,
    "hover policy must model .none, .peek, and .expand outcomes explicitly",
  );
  assert.match(
    controllerSource,
    /DynamicIslandInteractionPolicy\.hoverAction\(/,
    "handleHover must consult the pure hoverAction policy instead of expanding unconditionally",
  );
  assert.match(
    controllerSource,
    /NSHapticFeedbackManager\.defaultPerformer\.perform\(\.levelChange,\s*performanceTime:\s*\.now\)/,
    "entering collapsed hover must trigger subtle trackpad haptic feedback",
  );
  assert.match(
    bridgeSource,
    /"dynamicIslandExpandOnHover":\s*DynamicIslandInteractionPolicy\.isExpandOnHoverEnabled\(\)/,
    "NativeBridge must publish dynamicIslandExpandOnHover to the dashboard",
  );
  assert.match(
    bridgeSource,
    /case "dynamicIslandExpandOnHover":[\s\S]*?DynamicIslandInteractionPolicy\.setExpandOnHoverEnabled\(bool\)/,
    "NativeBridge must persist dynamicIslandExpandOnHover mutations",
  );
});

test("collapsed island claims first-click tactile press and retains peek hit bounds", () => {
  assert.match(
    controllerSource,
    /if islandController\?\.isExpanded == false\s*\{\s*return self\s*\}/,
    "collapsed/peeking IslandHitView must claim hitTest directly so SwiftUI wing labels cannot swallow the first click",
  );
  assert.match(
    controllerSource,
    /override func acceptsFirstMouse\(for event: NSEvent\?\) -> Bool \{ true \}/,
    "the non-activating panel must accept the very first click without stealing focus",
  );
  assert.match(
    controllerSource,
    /override func mouseDown\(with event: NSEvent\)[\s\S]*?handleMouseDown\(/,
    "IslandHitView must drive tactile press on mouseDown",
  );
  assert.match(
    controllerSource,
    /override func mouseUp\(with event: NSEvent\)[\s\S]*?handleMouseUp\(/,
    "IslandHitView must complete click-to-expand on mouseUp",
  );
  assert.match(
    controllerSource,
    /DynamicIslandLayoutPolicy\.hitWidth\(/,
    "hitRectInPanel must size width via hitWidth so pressing near the outer rim keeps full peek bounds",
  );
  assert.match(
    controllerSource,
    /DynamicIslandLayoutPolicy\.hitCollapsedHeight\(/,
    "hitRectInPanel must size collapsed height via hitCollapsedHeight so pressing near the bottom rim stays inside hitRegion",
  );
  assert.match(
    controllerSource,
    /guard wasExpanded \|\| state\.isHovered \|\| state\.isPressing else \{ return \}/,
    "collapse() must retract unexpanded hover-peek and press states too, not only expanded cards",
  );
  assert.match(
    controllerSource,
    /func handleMouseDragged[\s\S]*?if inside \{\s*collapseWorkItem\?\.cancel\(\)\s*collapseWorkItem = nil\s*\}/,
    "drag re-entry during an active press must cancel any pending hover-exit collapseWorkItem",
  );
});

test("DynamicIslandView applies calibrated morph, tactile press, and critically damped collapse springs", () => {
  assert.match(
    viewSource,
    /\.spring\(response:\s*0\.5,\s*dampingFraction:\s*0\.85,\s*blendDuration:\s*0\)/,
    "primary morph spring must match 0.5s response / 0.85 damping",
  );
  assert.match(
    viewSource,
    /\.spring\(response:\s*0\.5,\s*dampingFraction:\s*0\.55,\s*blendDuration:\s*0\)/,
    "tactile press spring must match 0.5s response / 0.55 damping",
  );
  assert.match(
    viewSource,
    /\.spring\(response:\s*0\.4,\s*dampingFraction:\s*1\.0,\s*blendDuration:\s*0\)/,
    "collapse spring must be critically damped (0.4s / 1.0) to prevent top-bezel overshoot",
  );
  assert.match(
    viewSource,
    /accessibilityDisplayShouldReduceMotion/,
    "spring animations must respect macOS Reduce Motion",
  );
  assert.match(
    viewSource,
    /\.mask\(alignment:\s*\.center\)\s*\{[\s\S]*?\}\s*(?:\/\/[^\n]*\n\s*)*\.shadow\(/,
    "drop shadow must be applied after .mask(alignment: .center) so the mask does not clip the shadow blur",
  );
});
