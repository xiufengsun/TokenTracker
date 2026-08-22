import XCTest

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
                screenFrame: screen
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.windowCoversScreenIncludingMenuBar(
                windowBounds: zoomed,
                screenFrame: screen
            )
        )
        XCTAssertFalse(
            DynamicIslandFullscreenPolicy.windowCoversScreenIncludingMenuBar(
                windowBounds: splitHalf,
                screenFrame: screen
            )
        )
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
