import SwiftUI

// MARK: - Monochrome Palette

/// Token Tracker on iPhone is black and white. Ink is the system label color,
/// so it flips with Light / Dark Mode. Color appears only when it means
/// something: orange when a target is close, red when it is reached or an
/// action failed.
enum Palette {
    static let ink = Color.primary
    static let warning = Color.orange
    static let critical = Color.red

    /// Fill for a target meter: ink until 72%, then orange, then red at 90%.
    static func paceColor(fraction: Double) -> Color {
        if fraction >= 0.90 { return critical }
        if fraction >= 0.72 { return warning }
        return ink
    }

    /// Grayscale steps for stacked data (token composition, heatmap levels).
    static func step(_ index: Int) -> Color {
        let opacities: [Double] = [0.88, 0.58, 0.34, 0.18]
        return ink.opacity(opacities[min(max(index, 0), opacities.count - 1)])
    }
}

/// Plain grouped background. Liquid Glass controls float above it.
struct AppBackground: View {
    var body: some View {
        Color(.systemGroupedBackground)
            .ignoresSafeArea()
    }
}

// MARK: - Product Mark

/// The real Token Tracker mark (black rounded square, white bolt), shipped as
/// the `TokenTrackerMark` asset copied from the app icon artwork. Never redraw it.
struct TokenTrackerMark: View {
    var size: CGFloat = 56

    var body: some View {
        Image("TokenTrackerMark")
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(width: size, height: size)
            .shadow(color: .black.opacity(0.18), radius: size * 0.08, y: size * 0.03)
            .accessibilityLabel("Token Tracker")
    }
}

// MARK: - Surface Panels

/// Content surface for dense numbers, charts, and grouped rows. Glass stays on
/// controls; data sits on an opaque grouped surface for contrast.
struct TelemetrySurface<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
                    .overlay {
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.75)
                    }
            }
    }
}

/// Neutral Liquid Glass segmented control (horizon, meter mode).
struct GlassSegmentedControl<Item: Hashable & Identifiable>: View {
    let items: [Item]
    @Binding var selection: Item
    let label: (Item) -> String
    var identifierPrefix: String = "segment"
    var fillsWidth: Bool = true

    @Namespace private var namespace

    var body: some View {
        GlassEffectContainer(spacing: 6) {
            HStack(spacing: 6) {
                ForEach(items) { item in
                    let selected = selection == item
                    Button {
                        withAnimation(.easeOut(duration: 0.2)) { selection = item }
                    } label: {
                        Text(label(item))
                            .font(.subheadline.weight(selected ? .semibold : .regular))
                            .foregroundStyle(selected ? Color(.systemBackground) : Color.primary)
                            .lineLimit(1)
                            .frame(maxWidth: fillsWidth ? .infinity : nil)
                            .padding(.horizontal, fillsWidth ? 4 : 16)
                            .padding(.vertical, 8)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .glassEffect(
                        selected ? .regular.tint(.primary).interactive() : .regular.interactive(),
                        in: .capsule
                    )
                    .glassEffectID(item.id, in: namespace)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("\(identifierPrefix).\(item.id)")
                }
            }
        }
    }
}

// MARK: - Provider Emblem

/// A provider's real brand mark, resolved exactly like the dashboard's
/// `ProviderIcon` (see `ProviderMarkCatalog.generated.swift`). Unknown sources
/// get the dashboard's dashed placeholder circle, never a stand-in glyph.
struct ProviderEmblem: View {
    let source: String
    var size: CGFloat = 28

    var body: some View {
        mark
            .frame(width: size * 0.62, height: size * 0.62)
            .frame(width: size, height: size)
            .background(
                Color.primary.opacity(0.06),
                in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            )
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var mark: some View {
        if let entry = ProviderMarks.entry(for: source) {
            Image(entry.asset)
                .resizable()
                .renderingMode(entry.isTemplate ? .template : .original)
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .foregroundStyle(.primary)
        } else {
            Circle()
                .strokeBorder(style: StrokeStyle(lineWidth: 1.2, dash: [2.6, 2.6]))
                .foregroundStyle(.tertiary)
                .padding(size * 0.04)
        }
    }
}

enum ProviderMarks {
    /// `piAwareLogoKey()` + `PROVIDER_ICON_MAP` lookup from ProviderIcon.jsx.
    static func entry(for source: String) -> ProviderMarkCatalog.Entry? {
        let key = source.uppercased()
        if let hit = ProviderMarkCatalog.entries[key] { return hit }
        if key.hasPrefix("PI-") { return ProviderMarkCatalog.entries["PI"] }
        return nil
    }
}

// MARK: - Pace Meter Bar

/// Fill bar with an optional even-burn pace notch (the macOS menu bar's
/// CodexBar-style punch-out) when a target and window duration exist.
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
                    with: .color(paceOver ? Palette.critical : Color.primary)
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
    var tint: Color = .secondary
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
                .fixedSize(horizontal: false, vertical: true)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.glass)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

// MARK: - Buttons

extension View {
    /// Prominent Liquid Glass button inked black in Light Mode and white in
    /// Dark Mode, with the label drawn in the opposite color.
    func primaryGlassButton() -> some View {
        self
            .buttonStyle(.glassProminent)
            .tint(Color.primary)
            .foregroundStyle(Color(.systemBackground))
    }
}

// MARK: - Debug screenshot anchors

extension View {
    /// Debug builds only: scrolls to the `--scroll` anchor once content has loaded.
    func scenarioScrollAnchor(_ proxy: ScrollViewProxy) -> some View {
        #if DEBUG
        task {
            guard let anchor = SimulatorLaunchScenario.scrollAnchor else { return }
            try? await Task.sleep(for: .milliseconds(700))
            proxy.scrollTo(anchor, anchor: .top)
        }
        #else
        self
        #endif
    }
}
