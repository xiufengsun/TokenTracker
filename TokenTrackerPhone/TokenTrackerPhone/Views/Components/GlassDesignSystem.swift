import SwiftUI

// MARK: - Brand Palette & Ambient Canvas

enum BrandPalette {
    static let emerald = Color.accentColor
    static let amber = Color(.sRGB, red: 0.94, green: 0.62, blue: 0.14, opacity: 1.0)
    static let coral = Color(.sRGB, red: 0.92, green: 0.34, blue: 0.32, opacity: 1.0)

    static func paceColor(fraction: Double) -> Color {
        if fraction >= 0.90 { return coral }
        if fraction >= 0.72 { return amber }
        return emerald
    }
}

/// Atmospheric background with subtle emerald/slate depth so native iOS 26
/// Liquid Glass lenses have genuine optical depth to refract without neon clutter.
struct AtmosphericGlassCanvas: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            Color(.systemGroupedBackground)
                .ignoresSafeArea()

            GeometryReader { geo in
                Circle()
                    .fill(BrandPalette.emerald.opacity(colorScheme == .dark ? 0.14 : 0.09))
                    .frame(width: geo.size.width * 0.95, height: geo.size.width * 0.95)
                    .blur(radius: 75)
                    .offset(x: -geo.size.width * 0.25, y: -geo.size.height * 0.12)

                Circle()
                    .fill(Color.cyan.opacity(colorScheme == .dark ? 0.08 : 0.05))
                    .frame(width: geo.size.width * 0.75, height: geo.size.width * 0.75)
                    .blur(radius: 85)
                    .offset(x: geo.size.width * 0.38, y: geo.size.height * 0.28)
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
    }
}

// MARK: - Surface Panels (Data Content vs Floating Liquid Glass Controls)

/// Content surface for dense telemetry, charts, and grouped rows.
/// Uses semantic system grouped surfaces with subtle rim definition so Liquid Glass
/// floating controls (tab bar, period/scope capsules, action pills) read distinctly above content.
struct TelemetrySurface<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground).opacity(0.92))
                    .overlay {
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.75)
                    }
            }
    }
}

/// Interactive Liquid Glass capsule chip using iOS 26 `.glassEffect`.
struct LiquidGlassPill<Content: View>: View {
    var isSelected: Bool = false
    var tint: Color? = nil
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(.horizontal, 13)
            .padding(.vertical, 8)
            .glassEffect(
                isSelected
                    ? .regular.tint(tint ?? BrandPalette.emerald).interactive()
                    : .regular.interactive(),
                in: .capsule
            )
    }
}

// MARK: - Provider Emblem

struct ProviderEmblem: View {
    let source: String
    var size: CGFloat = 28

    var body: some View {
        let tint = ProviderIdentity.tint(source)
        Image(systemName: ProviderIdentity.symbol(source))
            .font(.system(size: size * 0.46, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: size * 0.30, style: .continuous))
            .accessibilityHidden(true)
    }
}

// MARK: - CodexBar-Style Pace Progress Bar (Adapted for iPhone Dynamic Type & Touch)

/// Precision Core Graphics bar that renders window fill + CodexBar-style punched
/// even-burn pace notch when a target & window duration exist.
struct PaceMeterBar: View, Animatable {
    var percent: Double
    let fillColor: Color
    var pacePercent: Double? = nil
    var paceOver: Bool = false
    var height: CGFloat = 8

    var animatableData: Double {
        get { percent }
        set { percent = newValue }
    }

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Canvas { context, size in
            let scale = max(displayScale, 1)
            let align: (CGFloat) -> CGFloat = { ($0 * scale).rounded() / scale }
            let radius = size.height / 2
            let cornerSize = CGSize(width: radius, height: radius)
            let rect = CGRect(origin: .zero, size: size)
            context.clip(to: Path(rect))

            context.fill(
                Path { $0.addRoundedRect(in: rect, cornerSize: cornerSize) },
                with: .color(Color.primary.opacity(0.09))
            )

            let clamped = min(100, max(0, percent))
            let fillWidth = size.width * clamped / 100
            if fillWidth > 0 {
                let fillRect = CGRect(
                    x: 0,
                    y: 0,
                    width: max(size.height, min(fillWidth, size.width)),
                    height: size.height
                )
                context.fill(
                    Path { $0.addRoundedRect(in: fillRect, cornerSize: cornerSize) },
                    with: .color(fillColor)
                )
            }

            if let pacePercent {
                let x = align(size.width * min(100, max(0, pacePercent)) / 100)
                let punchWidth = align(6)
                let stripeWidth = align(2)
                let extend = size.height

                let gap = CGRect(
                    x: x - punchWidth / 2,
                    y: -extend,
                    width: punchWidth,
                    height: size.height + extend * 2
                )
                context.blendMode = .destinationOut
                context.fill(Path(gap), with: .color(.white))
                context.blendMode = .normal

                let stripe = CGRect(
                    x: x - stripeWidth / 2,
                    y: 0,
                    width: stripeWidth,
                    height: size.height
                )
                context.fill(
                    Path(stripe),
                    with: .color(paceOver ? BrandPalette.coral : BrandPalette.emerald)
                )
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

// MARK: - Inline Notice Banner

struct InlineNoticeBanner: View {
    let icon: String
    let tint: Color
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.glass)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .glassEffect(.regular.tint(tint.opacity(0.16)), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
