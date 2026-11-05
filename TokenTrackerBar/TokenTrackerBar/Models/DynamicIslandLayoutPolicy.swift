import CoreGraphics
import Foundation

/// Pure layout policy shared by the Dynamic Island controller and view.
///
/// Keeping the screen-height math outside AppKit makes the low-resolution and
/// Dock-reserved cases deterministic and unit-testable.
enum DynamicIslandLayoutPolicy {
    static let expandedWidth: CGFloat = 480
    static let shadowBleed: CGFloat = 28
    static let maximumIslandHeight: CGFloat = 800
    static let fixedChromeHeight: CGFloat = 240
    static let minimumLimitsHeight: CGFloat = 96

    static var maximumPanelHeight: CGFloat {
        maximumIslandHeight + shadowBleed
    }

    /// Fits the panel between the physical top edge and the bottom of the
    /// usable desktop (above a visible Dock), while preserving a viable minimum
    /// on unusual display configurations.
    static func panelHeight(screenTop: CGFloat, visibleBottom: CGFloat) -> CGFloat {
        let available = max(0, screenTop - visibleBottom)
        return min(maximumPanelHeight, max(available, minimumLimitsHeight + fixedChromeHeight + shadowBleed))
    }

    /// The provider list consumes whatever vertical room remains after the
    /// header, summary cards, divider, footer, and shadow bleed.
    static func limitsHeight(panelHeight: CGFloat) -> CGFloat {
        max(minimumLimitsHeight, panelHeight - shadowBleed - fixedChromeHeight)
    }
}

/// Pure interaction gate for hover events emitted by the fixed-size hosting
/// view. SwiftUI tracking areas can briefly retain their expanded geometry
/// while the island spring is collapsing, so visual hover alone is not enough:
/// the pointer must also be inside the controller's current black-shape rect.
enum DynamicIslandInteractionPolicy {
    static func shouldExpand(
        hovering: Bool,
        pointerInsideInteractiveRegion: Bool
    ) -> Bool {
        hovering && pointerInsideInteractiveRegion
    }
}

/// Timing and geometry for the island's centered visibility mask.
enum DynamicIslandVisibilityPolicy {
    static let showDuration: Double = 0.28
    static let hideDuration: Double = 0.28
    /// Lets SwiftUI commit the hidden frame before the panel leaves.
    static let hideSettleDelay: Double = 0.05
    static var hideCompletionDelay: Double { hideDuration + hideSettleDelay }
    static let centerPointWidth: CGFloat = 1

    static func revealWidth(
        progress: CGFloat,
        fullWidth: CGFloat,
        centerGapWidth: CGFloat,
        hasNotch: Bool,
        isDismissing: Bool = false
    ) -> CGFloat {
        let full = max(0, fullWidth)
        // The close endpoint must clear the notch's rounded lower corners.
        let hiddenWidth = hasNotch && !isDismissing
            ? max(0, centerGapWidth)
            : centerPointWidth
        let start = min(full, hiddenWidth)
        let clampedProgress = min(1, max(0, progress))
        return start + (full - start) * clampedProgress
    }
}

/// Presence gate so a user-disabled island and an active full-screen app
/// both suppress the panel without coupling those two reasons.
enum DynamicIslandFullscreenPolicy {
    static func shouldShowPanel(featureEnabled: Bool, fullscreenActive: Bool) -> Bool {
        featureEnabled && !fullscreenActive
    }

    /// Native green-button full-screen sets `.fullScreen`. Legacy / video
    /// players typically hide both the menu bar and the Dock without that
    /// flag. System auto-hide preferences use different flags and must not
    /// be passed in as `hides*`.
    static func presentationLooksFullscreen(
        containsFullScreen: Bool,
        hidesMenuBar: Bool,
        hidesDock: Bool
    ) -> Bool {
        containsFullScreen || (hidesMenuBar && hidesDock)
    }

    /// Quartz window bounds are top-left on the primary display; AppKit
    /// screen frames are bottom-left. `primaryMaxY` is the primary screen's
    /// `frame.maxY`.
    static func appKitRect(fromQuartz rect: CGRect, primaryMaxY: CGFloat) -> CGRect {
        CGRect(
            x: rect.origin.x,
            y: primaryMaxY - rect.origin.y - rect.height,
            width: rect.width,
            height: rect.height
        )
    }

    /// Whether a window on this Core Graphics layer could be a full-screen
    /// app window at all. A native full-screen window keeps
    /// `NSWindow.Level.normal` (0); system chrome sits on its own layers
    /// (Dock 20, menu bar 24, Control Center 25) and desktop-adjacent
    /// surfaces — Notification Center widgets, wallpaper backdrops — use
    /// large *negative* layers. A shielding-level window (>= 1000, e.g. the
    /// screen saver) does cover the island, so it still counts.
    ///
    /// This has to carry the filtering on its own: `kCGWindowOwnerName` is
    /// localized ("控制中心", "알림 센터"), so an English owner allowlist
    /// matches nothing on a non-English system and every system overlay
    /// reaches the coverage test (issue #507).
    static func windowLayerCanCoverIslandScreen(_ layer: Int) -> Bool {
        if layer < 0 { return false }
        return !(layer >= 20 && layer < 1_000)
    }

    /// A window that covers a screen including its menu-bar strip is in
    /// full-screen, not merely zoomed to `visibleFrame`.
    ///
    /// The strip must actually exist. With "Automatically hide and show the
    /// menu bar" set to Always, `visibleFrame` reaches the physical top edge
    /// (`menuBarHeight == 0`) and every maximized window covers the whole
    /// screen — geometry can no longer prove full-screen, so return false and
    /// let the caller fall back to presentation options. Otherwise the island
    /// would hide forever behind a maximized (not full-screen) window.
    static func windowCoversScreenIncludingMenuBar(
        windowBounds: CGRect,
        screenFrame: CGRect,
        menuBarHeight: CGFloat
    ) -> Bool {
        guard menuBarHeight >= 1 else { return false }
        return windowBounds.minX <= screenFrame.minX + 1
            && windowBounds.maxX >= screenFrame.maxX - 1
            && windowBounds.minY <= screenFrame.minY + 1
            && windowBounds.maxY >= screenFrame.maxY - 1
    }

    /// Only the island's own screen counts. A covering window on that screen
    /// is decisive. Presentation options are system-wide, so they may only
    /// break a tie on a single display (or when the window list is missing
    /// there). Multiple displays never hide from presentation alone.
    static func isFullscreenAppActive(
        windowCoversIslandScreen: Bool?,
        presentationLooksFullscreen: Bool,
        screenCount: Int
    ) -> Bool {
        if windowCoversIslandScreen == true { return true }
        if screenCount > 1 { return false }
        return presentationLooksFullscreen
    }
}

/// Coalesced settle schedule for re-reading the full-screen window list after
/// an environment signal (space change, activation, presentation-options
/// change). Extracted so the schedule is unit-testable and the controller
/// never hardcodes it.
enum DynamicIslandFullscreenRetryPolicy {
    /// Delays for a bounded re-read burst fired after an environment signal.
    /// A space-change notification can fire before the covering window is
    /// dropped from the window list, so the first read (and often the second)
    /// can still be stale; these delays give the window server time to
    /// settle. Bounded, not a heartbeat: native full-screen enter/exit both
    /// fire an observer, so a retry never has to survive an arbitrary gap
    /// with no signal — it only has to outlast the window list's own catch-up
    /// window after one has already fired.
    static let settleDelays: [TimeInterval] = [0.15, 0.45, 1.0]
}

/// Restore-path decision during a mid-flight hide. When the island should
/// show but a hide animation is still settling, the controller must force
/// show() rather than letting the `isPanelVisible && panel.isVisible` guard
/// skip it — the panel is still on screen mid-collapse and would otherwise
/// stay hidden until the next environment change.
enum DynamicIslandRestorePolicy {
    /// Whether the restore path must force-show through a mid-flight hide.
    static func mustForceShowDuringDismissal(
        shouldShowPanel: Bool,
        isVisibilityDismissing: Bool
    ) -> Bool {
        shouldShowPanel && isVisibilityDismissing
    }
}

/// Rejects stale delayed completions after rapid toggles.
struct DynamicIslandVisibilityTransitionTracker {
    private(set) var current = 0

    mutating func begin() -> Int {
        current &+= 1
        return current
    }

    func owns(_ transition: Int) -> Bool {
        transition == current
    }
}
