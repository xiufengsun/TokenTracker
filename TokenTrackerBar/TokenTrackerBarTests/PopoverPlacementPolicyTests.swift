import XCTest

final class PopoverPlacementPolicyTests: XCTestCase {
    private let screen = CGRect(x: 0, y: 0, width: 1512, height: 950)
    private let bodyWidth: CGFloat = 480

    private func anchorFrame(midX: CGFloat) -> CGRect {
        CGRect(x: midX - 1, y: 928, width: 2, height: 1)
    }

    private func popoverFrame(midX: CGFloat) -> CGRect {
        CGRect(x: midX - bodyWidth / 2, y: 928 - 720, width: bodyWidth, height: 720)
    }

    // MARK: - originX

    func testCenteredUnderAnchorWhenScreenHasRoom() {
        XCTAssertEqual(
            PopoverPlacementPolicy.originX(bodyWidth: bodyWidth, anchorMidX: 1000, screenFrame: screen),
            760
        )
    }

    func testRightEdgeIconClampsPanelInsideScreenInsteadOfOverflowing() {
        // Icon 20pt from the right edge: hard-centering would start at 1251 and
        // run to 1731, well past the 1512 screen edge.
        let x = PopoverPlacementPolicy.originX(bodyWidth: bodyWidth, anchorMidX: 1492, screenFrame: screen)
        XCTAssertEqual(x, 1512 - bodyWidth - PopoverPlacementPolicy.edgeInset)
        XCTAssertLessThanOrEqual(x + bodyWidth, screen.maxX)
    }

    func testLeftEdgeIconClampsPanelInsideScreen() {
        let x = PopoverPlacementPolicy.originX(bodyWidth: bodyWidth, anchorMidX: 20, screenFrame: screen)
        XCTAssertEqual(x, PopoverPlacementPolicy.edgeInset)
    }

    func testSecondaryDisplayWithNegativeCoordinates() {
        let leftScreen = CGRect(x: -1920, y: 0, width: 1920, height: 1080)
        let x = PopoverPlacementPolicy.originX(bodyWidth: bodyWidth, anchorMidX: -100, screenFrame: leftScreen)
        XCTAssertLessThanOrEqual(x + bodyWidth, leftScreen.maxX - PopoverPlacementPolicy.edgeInset)
        XCTAssertGreaterThanOrEqual(x, leftScreen.minX + PopoverPlacementPolicy.edgeInset)
    }

    // MARK: - isDisplaced

    func testLegitimateEdgeSlideIsNotDisplaced() {
        // NSPopover slid the body left so its right edge hugs the screen while
        // the arrow still points at the anchor: must not be yanked back.
        let anchor = anchorFrame(midX: 1490)
        let body = CGRect(x: 1512 - bodyWidth - 2, y: 928 - 720, width: bodyWidth, height: 720)
        XCTAssertFalse(
            PopoverPlacementPolicy.isDisplaced(popoverFrame: body, anchorFrame: anchor, screenFrame: screen)
        )
    }

    func testHardCenteredOverflowIsDisplaced() {
        let anchor = anchorFrame(midX: 1490)
        XCTAssertTrue(
            PopoverPlacementPolicy.isDisplaced(
                popoverFrame: popoverFrame(midX: 1490),
                anchorFrame: anchor,
                screenFrame: screen
            )
        )
    }

    func testBodyStrayedEntirelyOffTheAnchorIsDisplaced() {
        let anchor = anchorFrame(midX: 700)
        let body = CGRect(x: 1000, y: 928 - 720, width: bodyWidth, height: 720)
        XCTAssertTrue(
            PopoverPlacementPolicy.isDisplaced(popoverFrame: body, anchorFrame: anchor, screenFrame: screen)
        )
    }

    func testVerticalDropIsDisplaced() {
        let anchor = anchorFrame(midX: 700)
        let body = CGRect(x: 460, y: 928 - 720 - 100, width: bodyWidth, height: 720)
        XCTAssertTrue(
            PopoverPlacementPolicy.isDisplaced(popoverFrame: body, anchorFrame: anchor, screenFrame: screen)
        )
    }

    func testAlignedCenteredPopoverIsNotDisplaced() {
        let anchor = anchorFrame(midX: 700)
        XCTAssertFalse(
            PopoverPlacementPolicy.isDisplaced(
                popoverFrame: popoverFrame(midX: 700),
                anchorFrame: anchor,
                screenFrame: screen
            )
        )
    }
}
