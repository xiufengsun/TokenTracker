import CoreGraphics
import Foundation

/// Where the Dynamic Island chrome lives on screen.
///
/// `.island` is the existing top-center / notch-hugging layout.
/// `.edge` is the CodeNotch-inspired right-edge fixed pill (v1: right only).
enum DynamicIslandPlacement: String, CaseIterable, Equatable {
    case island
    case edge

    var bridgeValue: String { rawValue }

    static func fromBridge(_ value: String?) -> DynamicIslandPlacement {
        guard let value, let parsed = DynamicIslandPlacement(rawValue: value) else {
            return .island
        }
        return parsed
    }
}

/// Pure preference + geometry policy for island vs edge placement.
///
/// Keeping placement math here (instead of in AppKit) makes the right-edge
/// pill sizing and panel anchoring unit-testable, and keeps the hide-menu-bar
/// icon setting orthogonal: changing icon visibility never changes these
/// numbers.
enum DynamicIslandPlacementPolicy {
    static let defaultsKey = "DynamicIslandPlacement"

    // MARK: - Collapsed pill (CodeNotch resting proportions)
    //
    // CodeNotch: Design.scale 44/117 → pillWidth ≈ 9.8 pt, pillHeight ≈ 79 pt.
    // Depth 10 holds a quiet 3-dot stack (no specular hairline). `edgeWakeBoost`
    // deepens the pill briefly on hover before unfold.

    /// Depth of the collapsed right-edge pill into the screen (pt).
    static let edgePillDepth: CGFloat = 10
    /// Length of the collapsed right-edge pill along the screen edge (pt).
    static let edgePillLength: CGFloat = 80
    /// Extra wake depth beyond the visible pill so hover is forgiving
    /// (CodeNotch `pillHotZone` is deliberately larger than the resting body).
    static let edgeHotZoneDepth: CGFloat = 36
    /// Extra depth the resting pill gains on hover approach before full expand.
    static let edgeWakeBoost: CGFloat = 4

    // MARK: - Shape radii (fed into `EdgeNotchShape`)

    /// Ideal bezel fillet when the shape is deep enough. Thin resting pills
    /// clamp this in `EdgeNotchShape.path` to an isotropic ~3–4 pt weld
    /// (never stretched along-edge ears).
    static let edgeCurlIdeal: CGFloat = 8
    static let edgeCornerIdeal: CGFloat = 14
    /// Expanded card: larger soft fillet + island-matching inward corner.
    static let edgeCurlExpanded: CGFloat = 18
    static let edgeCornerExpanded: CGFloat = 22

    static func placement(from defaults: UserDefaults = .standard) -> DynamicIslandPlacement {
        DynamicIslandPlacement.fromBridge(defaults.string(forKey: defaultsKey))
    }

    static func write(_ placement: DynamicIslandPlacement, to defaults: UserDefaults = .standard) {
        defaults.set(placement.rawValue, forKey: defaultsKey)
    }

    /// Collapsed chrome must not carry variable-length metric strings in edge
    /// mode — that is the whole point of the fixed pill.
    static func showsCollapsedMetrics(for placement: DynamicIslandPlacement) -> Bool {
        placement == .island
    }

    /// Wing-width measurement only applies to the notch-hugging layout.
    static func appliesWingMetrics(for placement: DynamicIslandPlacement) -> Bool {
        placement == .island
    }

    /// Compact ring mode only makes sense on island wings.
    static func compactModeApplies(for placement: DynamicIslandPlacement) -> Bool {
        placement == .island
    }

    /// Fixed collapsed size for edge mode. Island mode keeps using notch /
    /// simulated geometry from the controller.
    static func edgeCollapsedSize() -> CGSize {
        CGSize(width: edgePillDepth, height: edgePillLength)
    }

    /// Curl radius for the current edge chrome state (isotropic bezel fillet).
    static func edgeCurlRadius(isExpanded: Bool) -> CGFloat {
        isExpanded ? edgeCurlExpanded : edgeCurlIdeal
    }

    /// Inward corner radius for the current edge chrome state.
    static func edgeCornerRadius(isExpanded: Bool) -> CGFloat {
        isExpanded ? edgeCornerExpanded : edgeCornerIdeal
    }

    /// Horizontal breathing room inside the expanded edge card so labels clear
    /// the inward corners. Curl is a bezel fillet (not leading clearance) —
    /// do not pad with `curl + N` or the left side grows a vacant black gutter.
    static let edgeExpandedContentInset: CGFloat = 6
    /// Top clearance so the header clears the inward corner without a cavern
    /// of empty black that reads as a murky top mask.
    static let edgeExpandedContentInsetTop: CGFloat = 12
    /// Bottom clearance under the footer — at least the expanded curl so
    /// "Open Dashboard" / Quit sit above the bezel fillet, not inside it.
    static let edgeExpandedContentInsetBottom: CGFloat = 18

    /// UserDefaults key for the persisted mid-edge vertical offset (points,
    /// AppKit: positive = up from the default vertically-centered rest).
    static let edgeVerticalOffsetKey = "DynamicIslandEdgeVerticalOffset"

    static func edgeVerticalOffset(from defaults: UserDefaults = .standard) -> CGFloat {
        CGFloat(defaults.double(forKey: edgeVerticalOffsetKey))
    }

    static func writeEdgeVerticalOffset(_ offset: CGFloat, to defaults: UserDefaults = .standard) {
        defaults.set(Double(offset), forKey: edgeVerticalOffsetKey)
    }

    /// Clamp an offset so the edge panel stays inside the usable strip
    /// (above Dock / below menu bar reserve implied by `visibleBottom`…
    /// `screenFrame.maxY`).
    static func clampEdgeVerticalOffset(
        _ offset: CGFloat,
        screenFrame: CGRect,
        visibleBottom: CGFloat,
        panelHeight: CGFloat
    ) -> CGFloat {
        let available = max(0, screenFrame.maxY - visibleBottom)
        let height = min(panelHeight, available)
        let centeredY = visibleBottom + (available - height) / 2
        let minY = visibleBottom
        let maxY = screenFrame.maxY - height
        let rawY = centeredY + offset
        let clampedY = min(max(rawY, minY), max(minY, maxY))
        return clampedY - centeredY
    }

    /// Panel frame for edge mode: same generous size as the island panel, but
    /// pinned to the right edge. Default rest is vertically centered in the
    /// usable desktop strip; `verticalOffset` (persisted) shifts that rest
    /// along the bezel within safe bounds.
    static func edgePanelFrame(
        screenFrame: CGRect,
        visibleBottom: CGFloat,
        panelWidth: CGFloat,
        verticalOffset: CGFloat = 0
    ) -> CGRect {
        let panelHeight = DynamicIslandLayoutPolicy.panelHeight(
            screenTop: screenFrame.maxY,
            visibleBottom: visibleBottom
        )
        let width = max(panelWidth, DynamicIslandLayoutPolicy.expandedWidth)
        let available = max(0, screenFrame.maxY - visibleBottom)
        let height = min(panelHeight, available)
        let centeredY = visibleBottom + (available - height) / 2
        let clamped = clampEdgeVerticalOffset(
            verticalOffset,
            screenFrame: screenFrame,
            visibleBottom: visibleBottom,
            panelHeight: panelHeight
        )
        let y = centeredY + clamped
        return CGRect(
            x: screenFrame.maxX - width,
            y: y,
            width: width,
            height: height
        )
    }

    /// Interactive rect of the black shape in panel coordinates (origin
    /// bottom-left). Collapsed: vertically centered trailing pill (CodeNotch
    /// resting position). Expanded: trailing card, also vertically centered so
    /// the spring morph does not leap from mid-edge to the menu bar.
    static func edgeHitRect(
        panelSize: CGSize,
        isExpanded: Bool,
        collapsedSize: CGSize,
        expandedWidth: CGFloat,
        expandedHeight: CGFloat
    ) -> CGRect {
        let width: CGFloat
        let height: CGFloat
        if isExpanded {
            width = min(max(expandedWidth, collapsedSize.width), panelSize.width)
            height = min(max(expandedHeight, collapsedSize.height), panelSize.height)
        } else {
            // Hot zone is a bit deeper than the visible pill for easier hover.
            width = min(max(collapsedSize.width, edgeHotZoneDepth), panelSize.width)
            height = min(collapsedSize.height, panelSize.height)
        }
        let x = panelSize.width - width
        let y = (panelSize.height - height) / 2
        return CGRect(x: x, y: y, width: width, height: height)
    }

    /// Prefer the main / cursor screen in edge mode; island mode still prefers
    /// a hardware-notched screen when available.
    static func prefersNotchedScreen(for placement: DynamicIslandPlacement) -> Bool {
        placement == .island
    }
}
