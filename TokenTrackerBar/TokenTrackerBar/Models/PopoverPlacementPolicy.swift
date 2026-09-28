import CoreGraphics

/// Screen-fit placement for the status-item popover.
///
/// NSPopover slides the panel body along the menu bar so the arrow keeps
/// pointing at the status item while the body stays on screen. Any
/// post-show repositioning must reproduce that contract instead of
/// hard-centering the body under the anchor, which pushes the panel
/// off-screen when the icon sits within half a panel width of a screen edge.
/// Frames reaching this policy are `_NSPopoverWindow` frames, ~13pt wider
/// per side than the visible content body.
enum PopoverPlacementPolicy {
    /// Minimum gap kept between the panel and the screen edge.
    static let edgeInset: CGFloat = 8
    /// Tolerance for the panel top vs the menu-bar bottom offset.
    static let verticalTolerance: CGFloat = 24
    /// How far the panel may hang over a screen edge before it counts as
    /// displaced. NSPopover's own edge-fit inset is not documented; absorb
    /// its small variance instead of fighting it with a reposition.
    static let overflowTolerance: CGFloat = 4

    /// Horizontal origin centering the body under the anchor without crossing
    /// the screen edges.
    static func originX(bodyWidth: CGFloat, anchorMidX: CGFloat, screenFrame: CGRect) -> CGFloat {
        let minX = screenFrame.minX + edgeInset
        let maxX = screenFrame.maxX - bodyWidth - edgeInset
        // Panel wider than the screen: prefer the leading edge.
        guard maxX > minX else { return minX }
        return min(max(anchorMidX - bodyWidth / 2, minX), maxX)
    }

    /// Whether the shown popover left its anchor or the screen. A body merely
    /// slid sideways by NSPopover's own edge-fit still contains the anchor's
    /// midX and is not displaced.
    static func isDisplaced(
        popoverFrame: CGRect,
        anchorFrame: CGRect,
        screenFrame: CGRect
    ) -> Bool {
        if abs(popoverFrame.maxY - anchorFrame.minY) > verticalTolerance { return true }
        if popoverFrame.maxX > screenFrame.maxX + overflowTolerance { return true }
        if popoverFrame.minX < screenFrame.minX - overflowTolerance { return true }
        return !(popoverFrame.minX <= anchorFrame.midX && popoverFrame.maxX >= anchorFrame.midX)
    }
}
