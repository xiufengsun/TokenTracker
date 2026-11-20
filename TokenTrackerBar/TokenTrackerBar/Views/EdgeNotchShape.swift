import SwiftUI

/// Right-edge "welded to the bezel" silhouette inspired by CodeNotch's
/// `SideNotchShape`, without cutout / dip / four-edge transforms.
///
/// Canonical layout: `rect.width` is depth into the screen, `rect.height` is
/// length along the edge, and `rect.maxX` is the physical screen edge.
///
/// Middle path (not a plain flush rounded-rect, not stretched flare ears):
/// a modest *isotropic* concave fillet (`curlRadius`) eases each end into the
/// bezel, then a convex inward corner finishes the body. Fillet depth and
/// along-edge run stay equal — never `curlAlong ≈ 3×depth` — so the join
/// reads as one organic weld rather than lobes sticking out along the edge.
struct EdgeNotchShape: Shape {
    /// Inverse curve where each end meets the bezel (CodeNotch curl / fillet).
    var curlRadius: CGFloat
    /// Convex corner on the inward (screen-facing) side.
    var cornerRadius: CGFloat
    /// Hairline of black pushed past the bezel so no wallpaper seam shows.
    var bezelHidden: CGFloat = 1

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(curlRadius, cornerRadius) }
        set {
            curlRadius = newValue.first
            cornerRadius = newValue.second
        }
    }

    /// Bézier handle reach for a circular quarter-turn.
    private static let circleReach: CGFloat = 0.5523

    func path(in rect: CGRect) -> Path {
        let depth = max(0, rect.width)
        let length = max(0, rect.height)
        guard depth > 0.5, length > 0.5 else { return Path(rect) }

        // Clamp order: corner first, then hidden band, then isotropic curl from
        // what remains. Thin resting pills (~10 pt) keep round inward corners;
        // curl collapses to a soft ~3–4 pt weld instead of stretched ears.
        let corner = min(max(0, cornerRadius), depth / 2, length / 4)
        let hidden = min(max(0, bezelHidden), max(0, depth - corner - 0.5))
        let curl = min(
            max(0, curlRadius),
            max(0, depth - corner - hidden),
            length / 4
        )
        let bodyTop = rect.minY + curl
        let bodyBottom = rect.maxY - curl
        let bezelX = rect.maxX
        let inwardX = rect.minX

        var path = Path()
        // Top bezel tip.
        path.move(to: CGPoint(x: bezelX, y: rect.minY))
        if hidden > 0 {
            path.addLine(to: CGPoint(x: bezelX - hidden, y: rect.minY))
        }
        // Top fillet: bezel → body (isotropic quarter-turn, no along-stretch).
        if curl > 0.5 {
            let from = path.currentPoint ?? CGPoint(x: bezelX - hidden, y: rect.minY)
            let flareEnd = CGPoint(x: bezelX - hidden - curl, y: bodyTop)
            path.addCurve(
                to: flareEnd,
                control1: CGPoint(x: from.x, y: from.y + curl * Self.circleReach),
                control2: CGPoint(x: flareEnd.x + curl * Self.circleReach, y: flareEnd.y)
            )
        }
        // Top inward corner.
        let topCornerStart = CGPoint(x: inwardX + corner, y: bodyTop)
        path.addLine(to: topCornerStart)
        if corner > 0.5 {
            path.addCurve(
                to: CGPoint(x: inwardX, y: bodyTop + corner),
                control1: CGPoint(
                    x: topCornerStart.x - corner * Self.circleReach,
                    y: topCornerStart.y
                ),
                control2: CGPoint(
                    x: inwardX,
                    y: bodyTop + corner - corner * Self.circleReach
                )
            )
        } else {
            path.addLine(to: CGPoint(x: inwardX, y: bodyTop))
        }
        // Inward straight edge.
        path.addLine(to: CGPoint(x: inwardX, y: bodyBottom - corner))
        // Bottom inward corner.
        if corner > 0.5 {
            path.addCurve(
                to: CGPoint(x: inwardX + corner, y: bodyBottom),
                control1: CGPoint(
                    x: inwardX,
                    y: bodyBottom - corner + corner * Self.circleReach
                ),
                control2: CGPoint(
                    x: inwardX + corner - corner * Self.circleReach,
                    y: bodyBottom
                )
            )
        } else {
            path.addLine(to: CGPoint(x: inwardX, y: bodyBottom))
        }
        // Bottom fillet back out to the bezel.
        if curl > 0.5 {
            let flareStart = CGPoint(x: bezelX - hidden - curl, y: bodyBottom)
            path.addLine(to: flareStart)
            let flareEnd = CGPoint(x: bezelX - hidden, y: rect.maxY)
            path.addCurve(
                to: flareEnd,
                control1: CGPoint(
                    x: flareStart.x + curl * Self.circleReach,
                    y: flareStart.y
                ),
                control2: CGPoint(
                    x: flareEnd.x,
                    y: flareEnd.y - curl * Self.circleReach
                )
            )
        } else {
            path.addLine(to: CGPoint(x: bezelX - hidden, y: bodyBottom))
            path.addLine(to: CGPoint(x: bezelX - hidden, y: rect.maxY))
        }
        path.addLine(to: CGPoint(x: bezelX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

/// Motion vocabulary for the right-edge surface — mirrors CodeNotch's
/// `NotchMotion` so expand/collapse feels like liquid chrome, not a hard cut.
enum EdgeNotchMotion {
    /// Folding open and shut (CodeNotch `unfold`: 0.62 / 0.72).
    static let unfold = Animation.spring(response: 0.62, dampingFraction: 0.72)
    /// Contents catching up with the black shape.
    static let contents = Animation.spring(response: 0.48, dampingFraction: 0.80)
    /// Brief wake deepen on approach before full expand.
    static let wake = Animation.spring(response: 0.28, dampingFraction: 0.78)

    static func respectingReduceMotion(_ animation: Animation, reduce: Bool) -> Animation? {
        reduce ? nil : animation
    }
}
