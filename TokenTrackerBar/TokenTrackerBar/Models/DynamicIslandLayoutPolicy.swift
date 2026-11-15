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

    /// Hover-peek expansion (+8pt per horizontal side, +8pt downward) when
    /// pointer enters the collapsed island with immediate hover-expand off.
    static let peekWidthExpansion: CGFloat = 16
    static let peekHeightExpansion: CGFloat = 8

    /// Tactile press tuck (+4pt per horizontal side, +4pt downward) — a 50%
    /// inward tuck relative to hover peek while `mouseDown` is held.
    static let pressWidthExpansion: CGFloat = 8
    static let pressHeightExpansion: CGFloat = 4

    /// Delay before retracting a hover peek vs collapsing the full detail card.
    static let peekCollapseDelay: TimeInterval = 0.15
    static let expandedCollapseDelay: TimeInterval = 0.25

    /// Spring response and damping parameters shared with the SwiftUI layer.
    static let morphSpringResponse: Double = 0.5
    static let morphSpringDamping: Double = 0.85
    static let pressSpringResponse: Double = 0.5
    static let pressSpringDamping: Double = 0.55
    static let collapseSpringResponse: Double = 0.4
    static let collapseSpringDamping: Double = 1.0

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

    /// Rendered collapsed width: full peek (+16pt) on hover, 50% inward tuck
    /// (+8pt) while pressed, or exact notch/wing width when idle.
    static func visualCollapsedWidth(
        collapsedWidth: CGFloat,
        isHovered: Bool,
        isPressing: Bool
    ) -> CGFloat {
        if isPressing {
            return collapsedWidth + pressWidthExpansion
        }
        if isHovered {
            return collapsedWidth + peekWidthExpansion
        }
        return collapsedWidth
    }

    /// Rendered width across collapsed, peeking, pressing, and expanded states.
    static func visualWidth(
        collapsedWidth: CGFloat,
        isExpanded: Bool,
        isHovered: Bool,
        isPressing: Bool
    ) -> CGFloat {
        if isExpanded {
            return max(expandedWidth, collapsedWidth)
        }
        return visualCollapsedWidth(
            collapsedWidth: collapsedWidth,
            isHovered: isHovered,
            isPressing: isPressing
        )
    }

    /// Rendered collapsed height: full peek (+8pt) on hover, 50% inward tuck
    /// (+4pt) while pressed, or exact notch height when idle.
    static func visualCollapsedHeight(
        collapsedHeight: CGFloat,
        isHovered: Bool,
        isPressing: Bool
    ) -> CGFloat {
        if isPressing {
            return collapsedHeight + pressHeightExpansion
        }
        if isHovered {
            return collapsedHeight + peekHeightExpansion
        }
        return collapsedHeight
    }

    /// AppKit hit-testing width. Retains full peek bounds (+16pt) whenever
    /// hovered OR pressing so pressing near the outer 4pt rim never drops the
    /// pointer outside `hitRegion` before `mouseUp`.
    static func hitWidth(
        collapsedWidth: CGFloat,
        isExpanded: Bool,
        isHovered: Bool,
        isPressing: Bool
    ) -> CGFloat {
        if isExpanded {
            return max(expandedWidth, collapsedWidth)
        }
        if isHovered || isPressing {
            return collapsedWidth + peekWidthExpansion
        }
        return collapsedWidth
    }

    /// AppKit collapsed hit-testing height. Retains full peek bounds (+8pt)
    /// whenever hovered OR pressing so a press near the lower 4pt rim stays
    /// inside `hitRegion` through `mouseUp`.
    static func hitCollapsedHeight(
        collapsedHeight: CGFloat,
        isHovered: Bool,
        isPressing: Bool
    ) -> CGFloat {
        if isHovered || isPressing {
            return collapsedHeight + peekHeightExpansion
        }
        return collapsedHeight
    }

    /// Smoothly interpolated upper concave shoulder radius across idle, press,
    /// peek, and expanded states.
    static func topShoulderRadius(
        collapsedHeight: CGFloat,
        isExpanded: Bool,
        isHovered: Bool,
        isPressing: Bool
    ) -> CGFloat {
        if isExpanded {
            return 8
        }
        let idle = min(6, collapsedHeight / 4)
        if isPressing {
            return min(7, idle + 0.5)
        }
        if isHovered {
            return min(7.5, idle + 1.0)
        }
        return idle
    }

    /// Smoothly interpolated lower convex corner radius across idle, press,
    /// peek, and expanded states.
    static func bottomCornerRadius(
        collapsedHeight: CGFloat,
        isExpanded: Bool,
        isHovered: Bool,
        isPressing: Bool
    ) -> CGFloat {
        if isExpanded {
            return 22
        }
        let idle = min(12, collapsedHeight / 2.5)
        if isPressing {
            return min(16, idle + 1.2)
        }
        if isHovered {
            return min(16, idle + 2.4)
        }
        return idle
    }

    /// Returns the hover-exit delay before collapsing from an expanded card or a collapsed peek.
    static func collapseDelay(isExpanded: Bool) -> TimeInterval {
        isExpanded ? expandedCollapseDelay : peekCollapseDelay
    }
}

/// Hover outcome for the Dynamic Island's two-stage interaction model.
enum DynamicIslandHoverAction: Equatable {
    case none
    case peek
    case expand
}

/// Pure interaction gate for hover and click events emitted by the fixed-size
/// hosting container. Tracking areas can briefly retain their expanded geometry
/// while the island spring is collapsing, so visual hover alone is not enough:
/// the pointer must also be inside the controller's current black-shape rect.
enum DynamicIslandInteractionPolicy {
    static let expandOnHoverDefaultsKey = "DynamicIslandExpandOnHoverEnabled"

    /// Reads whether immediate hover expansion is enabled in the given `UserDefaults` store.
    static func isExpandOnHoverEnabled(from defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: expandOnHoverDefaultsKey)
    }

    /// Persists the immediate hover-expansion preference in the given `UserDefaults` store.
    static func setExpandOnHoverEnabled(_ enabled: Bool, in defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: expandOnHoverDefaultsKey)
    }

    /// Returns true only when hover is active and the pointer lies inside the current hit region.
    static func shouldExpand(
        hovering: Bool,
        pointerInsideInteractiveRegion: Bool
    ) -> Bool {
        hovering && pointerInsideInteractiveRegion
    }

    /// Resolves whether a hover enter should be ignored, peek the collapsed
    /// silhouette, or hold/open the full detail card.
    ///
    /// Returning `.expand` whenever `isExpanded` is already true ensures a
    /// brief pointer exit and re-entry within `collapseDelay` keeps the open
    /// card expanded instead of downgrading it to a peek.
    static func hoverAction(
        hovering: Bool,
        pointerInsideInteractiveRegion: Bool,
        isExpanded: Bool,
        expandOnHover: Bool
    ) -> DynamicIslandHoverAction {
        guard shouldExpand(
            hovering: hovering,
            pointerInsideInteractiveRegion: pointerInsideInteractiveRegion
        ) else {
            return .none
        }
        if isExpanded || expandOnHover {
            return .expand
        }
        return .peek
    }

    /// Returns true when the island accepts pointer input and is not yet expanded.
    static func shouldExpandOnClick(
        acceptsInteraction: Bool,
        isExpanded: Bool
    ) -> Bool {
        acceptsInteraction && !isExpanded
    }

    /// Returns true on the initial unexpanded hover-enter transition so haptics do not repeat.
    static func shouldPerformHoverHaptic(
        wasHovered: Bool,
        isHovered: Bool,
        isExpanded: Bool
    ) -> Bool {
        !isExpanded && !wasHovered && isHovered
    }

    /// Forwards the state-appropriate hover-exit collapse delay from `DynamicIslandLayoutPolicy`.
    static func collapseDelay(isExpanded: Bool) -> TimeInterval {
        DynamicIslandLayoutPolicy.collapseDelay(isExpanded: isExpanded)
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
