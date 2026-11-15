import XCTest

/// Unit tests for Dynamic Island layout, hover/click interaction, and fullscreen policies.
final class DynamicIslandLayoutPolicyTests: XCTestCase {
    func testLargeDisplayUsesMaximumPanelHeight() {
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.panelHeight(screenTop: 1_080, visibleBottom: 0),
            DynamicIslandLayoutPolicy.maximumPanelHeight
        )
    }

    func testShortDisplayKeepsPanelAboveVisibleDock() {
        let height = DynamicIslandLayoutPolicy.panelHeight(screenTop: 720, visibleBottom: 40)

        XCTAssertEqual(height, 680)
        XCTAssertLessThanOrEqual(height, 720 - 40)
    }

    func testLimitsListShrinksWithPanelButKeepsUsableMinimum() {
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.limitsHeight(panelHeight: 680),
            412
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.limitsHeight(panelHeight: 200),
            DynamicIslandLayoutPolicy.minimumLimitsHeight
        )
    }

    func testHoverEnterRequiresPointerInsideCurrentInteractiveRegion() {
        XCTAssertFalse(
            DynamicIslandInteractionPolicy.shouldExpand(
                hovering: true,
                pointerInsideInteractiveRegion: false
            )
        )
        XCTAssertTrue(
            DynamicIslandInteractionPolicy.shouldExpand(
                hovering: true,
                pointerInsideInteractiveRegion: true
            )
        )
        XCTAssertFalse(
            DynamicIslandInteractionPolicy.shouldExpand(
                hovering: false,
                pointerInsideInteractiveRegion: true
            )
        )
    }

    /// Verifies that `DynamicIslandExpandOnHoverEnabled` defaults to `false` and round-trips in `UserDefaults`.
    func testExpandOnHoverPreferenceDefaultsToFalseAndPersistsInSuite() throws {
        let suiteName = "com.tokentracker.tests.island-hover.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertEqual(
            DynamicIslandInteractionPolicy.expandOnHoverDefaultsKey,
            "DynamicIslandExpandOnHoverEnabled"
        )
        XCTAssertFalse(DynamicIslandInteractionPolicy.isExpandOnHoverEnabled(from: defaults))

        DynamicIslandInteractionPolicy.setExpandOnHoverEnabled(true, in: defaults)
        XCTAssertTrue(DynamicIslandInteractionPolicy.isExpandOnHoverEnabled(from: defaults))

        DynamicIslandInteractionPolicy.setExpandOnHoverEnabled(false, in: defaults)
        XCTAssertFalse(DynamicIslandInteractionPolicy.isExpandOnHoverEnabled(from: defaults))
    }

    /// Verifies that hover peeks when collapsed by default and expands when opted in or already open.
    func testHoverActionPeeksByDefaultAndExpandsWhenOptedInOrAlreadyExpanded() {
        XCTAssertEqual(
            DynamicIslandInteractionPolicy.hoverAction(
                hovering: true,
                pointerInsideInteractiveRegion: false,
                isExpanded: false,
                expandOnHover: true
            ),
            .none
        )
        XCTAssertEqual(
            DynamicIslandInteractionPolicy.hoverAction(
                hovering: false,
                pointerInsideInteractiveRegion: true,
                isExpanded: false,
                expandOnHover: true
            ),
            .none
        )
        XCTAssertEqual(
            DynamicIslandInteractionPolicy.hoverAction(
                hovering: true,
                pointerInsideInteractiveRegion: true,
                isExpanded: false,
                expandOnHover: false
            ),
            .peek
        )
        XCTAssertEqual(
            DynamicIslandInteractionPolicy.hoverAction(
                hovering: true,
                pointerInsideInteractiveRegion: true,
                isExpanded: false,
                expandOnHover: true
            ),
            .expand
        )
        // Brief exit and re-entry while already expanded must keep the detail
        // card open rather than downgrading it to a collapsed hover peek.
        XCTAssertEqual(
            DynamicIslandInteractionPolicy.hoverAction(
                hovering: true,
                pointerInsideInteractiveRegion: true,
                isExpanded: true,
                expandOnHover: false
            ),
            .expand
        )
    }

    /// Verifies that click-to-expand only triggers while interaction is enabled and the card is collapsed.
    func testClickExpansionRequiresAcceptedInteractionAndCollapsedIsland() {
        XCTAssertFalse(
            DynamicIslandInteractionPolicy.shouldExpandOnClick(
                acceptsInteraction: false,
                isExpanded: false
            )
        )
        XCTAssertTrue(
            DynamicIslandInteractionPolicy.shouldExpandOnClick(
                acceptsInteraction: true,
                isExpanded: false
            )
        )
        XCTAssertFalse(
            DynamicIslandInteractionPolicy.shouldExpandOnClick(
                acceptsInteraction: true,
                isExpanded: true
            )
        )
    }

    /// Verifies that hover haptics fire only on the initial collapsed hover-enter transition.
    func testHoverHapticFiresOnlyOnCollapsedHoverEntryTransition() {
        XCTAssertTrue(
            DynamicIslandInteractionPolicy.shouldPerformHoverHaptic(
                wasHovered: false,
                isHovered: true,
                isExpanded: false
            )
        )
        XCTAssertFalse(
            DynamicIslandInteractionPolicy.shouldPerformHoverHaptic(
                wasHovered: true,
                isHovered: true,
                isExpanded: false
            )
        )
        XCTAssertFalse(
            DynamicIslandInteractionPolicy.shouldPerformHoverHaptic(
                wasHovered: false,
                isHovered: true,
                isExpanded: true
            )
        )
        XCTAssertFalse(
            DynamicIslandInteractionPolicy.shouldPerformHoverHaptic(
                wasHovered: true,
                isHovered: false,
                isExpanded: false
            )
        )
    }

    /// Verifies rendered widths and heights across idle, hover-peek, press-tuck, and expanded states.
    func testNotchNookPeekAndTactilePressVisualGeometry() {
        XCTAssertEqual(DynamicIslandLayoutPolicy.peekWidthExpansion, 16)
        XCTAssertEqual(DynamicIslandLayoutPolicy.peekHeightExpansion, 8)
        XCTAssertEqual(DynamicIslandLayoutPolicy.pressWidthExpansion, 8)
        XCTAssertEqual(DynamicIslandLayoutPolicy.pressHeightExpansion, 4)

        // Idle: exact notch + wings silhouette.
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.visualCollapsedWidth(collapsedWidth: 200, isHovered: false, isPressing: false),
            200
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.visualCollapsedHeight(collapsedHeight: 32, isHovered: false, isPressing: false),
            32
        )

        // Hover peek: +16pt width (+8pt per side) and +8pt downward height.
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.visualCollapsedWidth(collapsedWidth: 200, isHovered: true, isPressing: false),
            216
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.visualCollapsedHeight(collapsedHeight: 32, isHovered: true, isPressing: false),
            40
        )

        // Tactile press on mouseDown: 50% inward tuck (+8pt width, +4pt height).
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.visualCollapsedWidth(collapsedWidth: 200, isHovered: true, isPressing: true),
            208
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.visualCollapsedHeight(collapsedHeight: 32, isHovered: true, isPressing: true),
            36
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.visualCollapsedWidth(collapsedWidth: 200, isHovered: false, isPressing: true),
            208
        )

        // Expanded width respects both expandedWidth and unusually wide wings.
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.visualWidth(collapsedWidth: 200, isExpanded: true, isHovered: true, isPressing: false),
            DynamicIslandLayoutPolicy.expandedWidth
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.visualWidth(collapsedWidth: 520, isExpanded: true, isHovered: false, isPressing: false),
            520
        )
    }

    /// Verifies that `hitWidth` and `hitCollapsedHeight` retain full peek bounds during press tuck.
    func testHitRegionRetainsFullPeekBoundsDuringTactilePressTuck() {
        // Idle hit rect matches collapsed silhouette.
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.hitWidth(collapsedWidth: 200, isExpanded: false, isHovered: false, isPressing: false),
            200
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.hitCollapsedHeight(collapsedHeight: 32, isHovered: false, isPressing: false),
            32
        )

        // Hover peek hit rect grows to +16pt width / +8pt height.
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.hitWidth(collapsedWidth: 200, isExpanded: false, isHovered: true, isPressing: false),
            216
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.hitCollapsedHeight(collapsedHeight: 32, isHovered: true, isPressing: false),
            40
        )

        // Pressing near the outer 4pt rim must keep the full peek hit rect so
        // the inward visual tuck never drops the pointer outside hitRegion
        // before mouseUp completes the click.
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.hitWidth(collapsedWidth: 200, isExpanded: false, isHovered: true, isPressing: true),
            216
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.hitCollapsedHeight(collapsedHeight: 32, isHovered: true, isPressing: true),
            40
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.hitWidth(collapsedWidth: 200, isExpanded: false, isHovered: false, isPressing: true),
            216
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.hitCollapsedHeight(collapsedHeight: 32, isHovered: false, isPressing: true),
            40
        )

        // Expanded hit width uses the card width.
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.hitWidth(collapsedWidth: 200, isExpanded: true, isHovered: true, isPressing: false),
            DynamicIslandLayoutPolicy.expandedWidth
        )
    }

    /// Verifies that upper shoulder and lower corner radii increase monotonically from idle to expanded.
    func testCornerRadiiInterpolateMonotonicallyAcrossInteractionStates() {
        let idleTop = DynamicIslandLayoutPolicy.topShoulderRadius(
            collapsedHeight: 32, isExpanded: false, isHovered: false, isPressing: false
        )
        let pressTop = DynamicIslandLayoutPolicy.topShoulderRadius(
            collapsedHeight: 32, isExpanded: false, isHovered: true, isPressing: true
        )
        let peekTop = DynamicIslandLayoutPolicy.topShoulderRadius(
            collapsedHeight: 32, isExpanded: false, isHovered: true, isPressing: false
        )
        let expandedTop = DynamicIslandLayoutPolicy.topShoulderRadius(
            collapsedHeight: 32, isExpanded: true, isHovered: true, isPressing: false
        )
        XCTAssertLessThan(idleTop, pressTop)
        XCTAssertLessThan(pressTop, peekTop)
        XCTAssertLessThan(peekTop, expandedTop)

        let idleBottom = DynamicIslandLayoutPolicy.bottomCornerRadius(
            collapsedHeight: 32, isExpanded: false, isHovered: false, isPressing: false
        )
        let pressBottom = DynamicIslandLayoutPolicy.bottomCornerRadius(
            collapsedHeight: 32, isExpanded: false, isHovered: true, isPressing: true
        )
        let peekBottom = DynamicIslandLayoutPolicy.bottomCornerRadius(
            collapsedHeight: 32, isExpanded: false, isHovered: true, isPressing: false
        )
        let expandedBottom = DynamicIslandLayoutPolicy.bottomCornerRadius(
            collapsedHeight: 32, isExpanded: true, isHovered: true, isPressing: false
        )
        XCTAssertLessThan(idleBottom, pressBottom)
        XCTAssertLessThan(pressBottom, peekBottom)
        XCTAssertLessThan(peekBottom, expandedBottom)
    }

    /// Verifies collapse delays and spring response/damping constants for two-stage interaction.
    func testCollapseDelayAndSpringParametersMatchTwoStageSpec() {
        XCTAssertEqual(DynamicIslandInteractionPolicy.collapseDelay(isExpanded: false), 0.15)
        XCTAssertEqual(DynamicIslandInteractionPolicy.collapseDelay(isExpanded: true), 0.25)
        XCTAssertLessThan(
            DynamicIslandInteractionPolicy.collapseDelay(isExpanded: false),
            DynamicIslandInteractionPolicy.collapseDelay(isExpanded: true)
        )

        XCTAssertEqual(DynamicIslandLayoutPolicy.morphSpringResponse, 0.5)
        XCTAssertEqual(DynamicIslandLayoutPolicy.morphSpringDamping, 0.85)
        XCTAssertEqual(DynamicIslandLayoutPolicy.pressSpringResponse, 0.5)
        XCTAssertEqual(DynamicIslandLayoutPolicy.pressSpringDamping, 0.55)
        XCTAssertEqual(DynamicIslandLayoutPolicy.collapseSpringResponse, 0.4)
        XCTAssertEqual(DynamicIslandLayoutPolicy.collapseSpringDamping, 1.0)
    }

    func testNotchedRevealStartsBehindHardwareNotchAndExpandsSymmetrically() {
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 0,
                fullWidth: 320,
                centerGapWidth: 120,
                hasNotch: true
            ),
            120
        )
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 0.5,
                fullWidth: 320,
                centerGapWidth: 120,
                hasNotch: true
            ),
            220
        )
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 1,
                fullWidth: 320,
                centerGapWidth: 120,
                hasNotch: true
            ),
            320
        )
    }

    func testSimulatedRevealStartsAtCenterWithoutStretchingPastBounds() {
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 0,
                fullWidth: 160,
                centerGapWidth: 28,
                hasNotch: false
            ),
            DynamicIslandVisibilityPolicy.centerPointWidth
        )
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: -1,
                fullWidth: 160,
                centerGapWidth: 28,
                hasNotch: false
            ),
            DynamicIslandVisibilityPolicy.centerPointWidth
        )
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 2,
                fullWidth: 160,
                centerGapWidth: 28,
                hasNotch: false
            ),
            160
        )
    }

    func testNotchedDismissalFinishesFullyBehindHardwareNotch() {
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 0,
                fullWidth: 320,
                centerGapWidth: 120,
                hasNotch: true,
                isDismissing: true
            ),
            DynamicIslandVisibilityPolicy.centerPointWidth
        )
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 1,
                fullWidth: 320,
                centerGapWidth: 120,
                hasNotch: true,
                isDismissing: true
            ),
            320
        )
    }

    func testFullscreenSettleDelaysAreShortBoundedAndIncreasing() {
        let delays = DynamicIslandFullscreenRetryPolicy.settleDelays

        // Bounded burst, not a heartbeat: 2-4 delays, each short.
        XCTAssertGreaterThanOrEqual(delays.count, 2)
        XCTAssertLessThanOrEqual(delays.count, 4)
        for delay in delays {
            XCTAssertGreaterThan(delay, 0)
            XCTAssertLessThanOrEqual(delay, 1.5)
        }
        XCTAssertEqual(delays, delays.sorted(), "delays should back off, not tick at a fixed rate")
    }

    func testForceShowWhenRestoringDuringMidHide() {
        // The user exits full-screen during a hide animation: the panel is
        // still on screen mid-collapse, so the restore path must force-show
        // through the `isPanelVisible && panel.isVisible` guard.
        XCTAssertTrue(
            DynamicIslandRestorePolicy.mustForceShowDuringDismissal(
                shouldShowPanel: true,
                isVisibilityDismissing: true
            )
        )
        XCTAssertFalse(
            DynamicIslandRestorePolicy.mustForceShowDuringDismissal(
                shouldShowPanel: true,
                isVisibilityDismissing: false
            )
        )
        XCTAssertFalse(
            DynamicIslandRestorePolicy.mustForceShowDuringDismissal(
                shouldShowPanel: false,
                isVisibilityDismissing: true
            )
        )
        XCTAssertFalse(
            DynamicIslandRestorePolicy.mustForceShowDuringDismissal(
                shouldShowPanel: false,
                isVisibilityDismissing: false
            )
        )
    }

    func testHideCompletionIncludesCompositorSettleDelay() {
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.hideCompletionDelay,
            DynamicIslandVisibilityPolicy.hideDuration + DynamicIslandVisibilityPolicy.hideSettleDelay
        )
    }

    func testLatestVisibilityTransitionOwnsDelayedCompletion() {
        var tracker = DynamicIslandVisibilityTransitionTracker()
        let opening = tracker.begin()
        let closing = tracker.begin()
        let reopening = tracker.begin()

        XCTAssertFalse(tracker.owns(opening))
        XCTAssertFalse(tracker.owns(closing))
        XCTAssertTrue(tracker.owns(reopening))
    }

    func testPanelStaysHiddenWhileFeatureOffOrFullscreen() {
        XCTAssertTrue(
            DynamicIslandFullscreenPolicy.shouldShowPanel(
                featureEnabled: true,
                fullscreenActive: false
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.shouldShowPanel(
                featureEnabled: true,
                fullscreenActive: true
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.shouldShowPanel(
                featureEnabled: false,
                fullscreenActive: false
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.shouldShowPanel(
                featureEnabled: false,
                fullscreenActive: true
            )
        )
    }

    func testPresentationFullscreenIgnoresPartialMenuBarOrDockHide() {
        XCTAssertTrue(
            DynamicIslandFullscreenPolicy.presentationLooksFullscreen(
                containsFullScreen: true,
                hidesMenuBar: false,
                hidesDock: false
            )
        )
        XCTAssertTrue(
            DynamicIslandFullscreenPolicy.presentationLooksFullscreen(
                containsFullScreen: false,
                hidesMenuBar: true,
                hidesDock: true
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.presentationLooksFullscreen(
                containsFullScreen: false,
                hidesMenuBar: true,
                hidesDock: false
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.presentationLooksFullscreen(
                containsFullScreen: false,
                hidesMenuBar: false,
                hidesDock: true
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.presentationLooksFullscreen(
                containsFullScreen: false,
                hidesMenuBar: false,
                hidesDock: false
            )
        )
    }

    func testWindowCoverageTreatsMenuBarOverlapAsFullscreenNotZoom() {
        let screen = CGRect(x: 0, y: 0, width: 1_440, height: 900)
        let fullscreen = screen
        let zoomed = CGRect(x: 0, y: 0, width: 1_440, height: 875)
        let splitHalf = CGRect(x: 0, y: 0, width: 720, height: 900)

        XCTAssertTrue(
            DynamicIslandFullscreenPolicy.windowCoversScreenIncludingMenuBar(
                windowBounds: fullscreen,
                screenFrame: screen,
                menuBarHeight: 25
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.windowCoversScreenIncludingMenuBar(
                windowBounds: zoomed,
                screenFrame: screen,
                menuBarHeight: 25
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.windowCoversScreenIncludingMenuBar(
                windowBounds: splitHalf,
                screenFrame: screen,
                menuBarHeight: 25
            )
        )
    }

    func testWindowCoverageIsInconclusiveWhenMenuBarIsHidden() {
        // With the menu bar set to auto-hide, `visibleFrame` reaches the
        // physical top edge and a *maximized* (not full-screen) window covers
        // the whole screen. Geometry can no longer prove full-screen, so the
        // policy must defer to presentation options instead of suppressing
        // the island behind the maximized window (issue #507).
        let screen = CGRect(x: 0, y: 0, width: 1_440, height: 900)

        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.windowCoversScreenIncludingMenuBar(
                windowBounds: screen,
                screenFrame: screen,
                menuBarHeight: 0
            )
        )
    }

    func testOnlyApplicationAndShieldingLayersCanCoverTheIslandScreen() {
        // Owner-name filtering cannot carry this: `kCGWindowOwnerName` is
        // localized, so an English allowlist ("Control Center", "Notification
        // Center") matches nothing on a non-English system and every system
        // overlay reaches the coverage test (issue #507).
        XCTAssertTrue(DynamicIslandFullscreenPolicy.windowLayerCanCoverIslandScreen(0))
        XCTAssertTrue(DynamicIslandFullscreenPolicy.windowLayerCanCoverIslandScreen(1_000))
        XCTAssertTrue(DynamicIslandFullscreenPolicy.windowLayerCanCoverIslandScreen(2_147_483_629))

        XCTAssertFalse(DynamicIslandFullscreenPolicy.windowLayerCanCoverIslandScreen(20))
        XCTAssertFalse(DynamicIslandFullscreenPolicy.windowLayerCanCoverIslandScreen(24))
        XCTAssertFalse(DynamicIslandFullscreenPolicy.windowLayerCanCoverIslandScreen(25))
        // Notification Center widgets / wallpaper backdrops sit far below the
        // desktop and can report screen-sized frames.
        XCTAssertFalse(DynamicIslandFullscreenPolicy.windowLayerCanCoverIslandScreen(-2_147_483_601))
        XCTAssertFalse(DynamicIslandFullscreenPolicy.windowLayerCanCoverIslandScreen(-1))
    }

    func testQuartzBoundsConvertAgainstPrimaryDisplayTop() {
        let converted = DynamicIslandFullscreenPolicy.appKitRect(
            fromQuartz: CGRect(x: 100, y: 0, width: 200, height: 50),
            primaryMaxY: 900
        )

        XCTAssertEqual(converted, CGRect(x: 100, y: 850, width: 200, height: 50))
    }

    func testFullscreenVerdictPrefersWindowCoverageOverPresentation() {
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.isFullscreenAppActive(
                windowCoversIslandScreen: false,
                presentationLooksFullscreen: true,
                screenCount: 2
            )
        )
        XCTAssertTrue(
            DynamicIslandFullscreenPolicy.isFullscreenAppActive(
                windowCoversIslandScreen: false,
                presentationLooksFullscreen: true,
                screenCount: 1
            )
        )
        XCTAssertTrue(
            DynamicIslandFullscreenPolicy.isFullscreenAppActive(
                windowCoversIslandScreen: true,
                presentationLooksFullscreen: false,
                screenCount: 2
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.isFullscreenAppActive(
                windowCoversIslandScreen: nil,
                presentationLooksFullscreen: true,
                screenCount: 2
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.isFullscreenAppActive(
                windowCoversIslandScreen: nil,
                presentationLooksFullscreen: false,
                screenCount: 1
            )
        )
    }
}
