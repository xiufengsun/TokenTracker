import SwiftUI

/// SwiftUI content of the Dynamic Island panel.
///
/// Collapsed (island): a notch-hugging black bar — today's tokens on the left
/// wing, today's cost on the right wing, the center occluded by the hardware
/// notch. Collapsed (edge): a fixed right-edge pill with no metric text.
/// Hover: expands into a spend summary (today / 7d / 30d / total) plus the
/// usage-limits bars, all fed by the shared `DashboardViewModel`.
///
/// The panel window is always the expanded size; only this black shape
/// animates. Growing from a top-aligned outer frame (instead of resizing the
/// window mid-animation) keeps the top edge glued to the screen so no
/// wallpaper seam flashes through.
struct DynamicIslandView: View {
    @ObservedObject var viewModel: DashboardViewModel
    @ObservedObject var state: DynamicIslandState
    /// Reports the measured wing width (max of both labels + breathing room)
    /// so the controller can shrink the hit-test pill to hug the text.
    let onWingWidthChanged: (CGFloat) -> Void
    /// Reports the rendered island height after layout so the controller can
    /// size the expanded hit-test rect to the actual black shape.
    let onExpandedHeightChanged: (CGFloat) -> Void

    /// Horizontal breathing room added around the widest wing label.
    private static let wingPadding: CGFloat = 16

    /// Width / height of the menu-bar icon. Only changes with the icon style,
    /// so per-frame ticks never invalidate this view. `IslandMenuBarIcon`
    /// owns the frame image itself.
    @State private var menuBarIconAspect: CGFloat = 1
    @State private var wingMetrics = WingSelection.default
    @State private var compactModeEnabled = false

    var body: some View {
        // Referenced so currency/locale changes force a re-render.
        let _ = state.settingsTick
        ZStack(alignment: .top) {
            island
        }
        // Fixed root frame matching the (always-expanded) panel exactly — a
        // fluid root on a borderless panel triggers NSWindow constraint
        // updates that crash (same trap DesktopPetHost avoids).
        .frame(width: state.panelSize.width, height: state.panelSize.height, alignment: .top)
        // The panel covers the menu-bar / notch safe area; never let SwiftUI
        // inset the black fill or a top seam appears.
        .ignoresSafeArea()
        // The island is always a black surface — force dark styling for the
        // embedded summary cards and limit bars regardless of system theme.
        .environment(\.colorScheme, .dark)
        .preferredColorScheme(.dark)
        .onReceive(NotificationCenter.default.publisher(for: .menuBarIconFrameUpdated)) { note in
            // The animator posts a frame per tick (up to 24/s while the bot
            // sprints). Writing state here on every tick re-ran this whole
            // body, the hidden measurement copies and both preference
            // round-trips. Only an icon-style switch changes the aspect.
            guard let image = note.object as? NSImage else { return }
            let aspect = Self.aspect(of: image)
            if abs(aspect - menuBarIconAspect) > 0.01 { menuBarIconAspect = aspect }
        }
        .onAppear {
            if let icon = StatusBarController.currentMenuBarIcon {
                self.menuBarIconAspect = Self.aspect(of: icon)
            }
            self.wingMetrics = resolveWingMetrics()
            self.compactModeEnabled = DynamicIslandCompactPolicy.isEnabled()
                && DynamicIslandPlacementPolicy.compactModeApplies(for: state.placement)
        }
        .onChange(of: state.settingsTick) { _ in
            self.wingMetrics = resolveWingMetrics()
            self.compactModeEnabled = DynamicIslandCompactPolicy.isEnabled()
                && DynamicIslandPlacementPolicy.compactModeApplies(for: state.placement)
        }
    }

    private var island: some View {
        let geo = state.geometry
        let expanded = state.isExpanded
        let isEdge = state.placement == .edge
        let edgeWaking = isEdge && state.isEdgeWaking && !expanded
        // Wake deepens the resting pill slightly before unfold (edgeWakeBoost).
        let wakeBoost: CGFloat = edgeWaking ? DynamicIslandPlacementPolicy.edgeWakeBoost : 0
        let islandWidth = expanded
            ? max(DynamicIslandGeometry.expandedWidth, geo.collapsedWidth)
            : geo.collapsedWidth + wakeBoost
        // Island mode keeps the native notch silhouette. Edge mode uses
        // `EdgeNotchShape` (gentle isotropic bezel fillet + inward corners)
        // for both collapsed and expanded so the spring morphs one shape.
        let shoulderRadius: CGFloat = {
            if isEdge { return 0 }
            return expanded ? CGFloat(8) : min(6, geo.collapsedHeight / 4)
        }()
        let renderedWidth = islandWidth + shoulderRadius * 2
        let revealWidth = DynamicIslandVisibilityPolicy.revealWidth(
            progress: state.visibilityProgress,
            fullWidth: renderedWidth,
            centerGapWidth: isEdge ? 0 : geo.centerGapWidth,
            hasNotch: isEdge ? false : geo.hasNotch,
            isDismissing: state.isVisibilityDismissing
        )
        let bottomRadius: CGFloat = {
            if isEdge { return 0 }
            return expanded ? 22 : min(12, geo.collapsedHeight / 2.5)
        }()
        let islandShape = IslandRoundedRectangle(
            topShoulderRadius: shoulderRadius,
            bottomRadius: bottomRadius
        )
        let edgeCurl = DynamicIslandPlacementPolicy.edgeCurlRadius(isExpanded: expanded)
        let edgeCorner = DynamicIslandPlacementPolicy.edgeCornerRadius(isExpanded: expanded)
        let edgeShape = EdgeNotchShape(curlRadius: edgeCurl, cornerRadius: edgeCorner)

        // Fillet + rim clearance for expanded edge content only. Collapsed
        // stays tight so the 3-dot pill does not grow with the curl pad.
        // Inset is applied *inside* the fixed islandWidth so the reveal mask,
        // hit rect, and EdgeNotchShape stay aligned — padding outside the
        // frame previously grew chrome past revealWidth and chopped the
        // inward (leading) side ("Plan" → "Ian").
        // Horizontal clears the inward corner only (not curl+N). Vertical is
        // balanced: modest top, bottom ≥ expanded curl so the footer is not
        // clipped into the bezel fillet (that read as a murky black veil).
        let edgeContentInsetX: CGFloat = (isEdge && expanded)
            ? DynamicIslandPlacementPolicy.edgeExpandedContentInset
            : 0
        let edgeContentInsetTop: CGFloat = (isEdge && expanded)
            ? DynamicIslandPlacementPolicy.edgeExpandedContentInsetTop
            : 0
        let edgeContentInsetBottom: CGFloat = (isEdge && expanded)
            ? DynamicIslandPlacementPolicy.edgeExpandedContentInsetBottom
            : 0
        let content = VStack(spacing: 0) {
            if !expanded {
                if DynamicIslandPlacementPolicy.showsCollapsedMetrics(for: state.placement) {
                    collapsedRow
                        .transition(.opacity)
                } else {
                    edgeCollapsedPill
                        .transition(.opacity)
                }
            } else {
                expandedHeaderRow
                    .transition(.opacity)
                expandedContent
                    .transition(.opacity)
            }
        }
        // Edge expanded: pad first (balanced vertical), then lock outer
        // width so content shrinks into the shape instead of pushing past
        // the trailing reveal mask.
        .padding(.top, edgeContentInsetTop)
        .padding(.bottom, edgeContentInsetBottom)
        .padding(.horizontal, edgeContentInsetX)
        // Width is always explicit. Height: nil when expanded lets the VStack
        // size naturally to its content; explicit when collapsed.
        .frame(width: islandWidth, height: expanded ? nil : geo.collapsedHeight, alignment: .top)
        // The native notch shoulder flares outward at the screen edge, then
        // curves inward to the content body. Keep that flare outside the
        // content width so it never squeezes either metric wing. Edge mode
        // has no shoulders (inset above handles bezel clearance).
        .padding(.horizontal, shoulderRadius)
        .fixedSize(horizontal: false, vertical: expanded)

        // One concrete chrome per placement — never swap Capsule ↔ rounded
        // rect through AnyView, or the spring has nothing continuous to morph.
        let chrome: AnyView = {
            if isEdge {
                // Collapsed chrome: no drop shadow and no stroke (avoids AA
                // dirt at the flush bezel join). Expanded keeps a light rim +
                // soft inward shadow; wake only deepens the body and brightens
                // the quiet dots (see edgeCollapsedPill).
                return AnyView(
                    content
                        .clipShape(edgeShape)
                        .background(
                            edgeShape.fill(Color.black)
                                .shadow(
                                    color: .black.opacity(expanded ? 0.22 : 0),
                                    radius: expanded ? 12 : 0,
                                    x: expanded ? -3 : 0,
                                    y: 0
                                )
                        )
                        .overlay(
                            Group {
                                if expanded {
                                    edgeShape
                                        .stroke(
                                            LinearGradient(
                                                colors: [
                                                    Color.white.opacity(0.16),
                                                    Color.white.opacity(0.04),
                                                    Color.white.opacity(0.10)
                                                ],
                                                startPoint: .topLeading,
                                                endPoint: .bottomTrailing
                                            ),
                                            lineWidth: 0.5
                                        )
                                }
                            }
                        )
                )
            }
            return AnyView(
                content
                    .clipShape(islandShape)
                    .background(
                        islandShape.fill(Color.black)
                            .shadow(color: .black.opacity(expanded ? 0.25 : 0), radius: expanded ? 10 : 0, x: 0, y: expanded ? 5 : 0)
                            .shadow(color: .black.opacity(expanded ? 0.15 : 0), radius: expanded ? 3 : 0, x: 0, y: expanded ? 1 : 0)
                    )
                    .overlay(
                        Group {
                            if expanded {
                                islandShape
                                    .stroke(
                                        LinearGradient(
                                            colors: [
                                                Color.white.opacity(0.18),
                                                Color.white.opacity(0.05),
                                                Color.white.opacity(0.08)
                                            ],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        ),
                                        lineWidth: 0.5
                                    )
                            }
                        }
                    )
            )
        }()

        return chrome
        // Report the rendered island height back to the controller for
        // hit-test sizing. This runs AFTER layout so it reads the actual
        // natural content height — no chicken-and-egg.
        .background(
            GeometryReader { proxy in
                Color.clear.preference(key: IslandRenderedHeightKey.self, value: proxy.size.height)
            }
        )
        .onPreferenceChange(IslandRenderedHeightKey.self) { h in
            onExpandedHeightChanged(h)
        }
        // Reveal from the center without scaling the contents.
        .mask(alignment: isEdge ? .trailing : .center) {
            Rectangle()
                .frame(width: revealWidth)
        }
        // Island: top-center. Edge: trailing (vertically centered) so the
        // resting pill sits mid-bezel like CodeNotch and expands in place.
        .frame(
            maxWidth: .infinity,
            maxHeight: .infinity,
            alignment: isEdge ? .trailing : .top
        )
    }

    /// Fixed right-edge collapsed chrome: quiet 3-dot stack on a solid black
    /// `EdgeNotchShape` body. No vertical specular hairline and no collapsed
    /// rim/shadow. Wake (via `state.isEdgeWaking`) brightens the dots and
    /// gently scales them before unfold.
    private var edgeCollapsedPill: some View {
        let geo = state.geometry
        let waking = state.isEdgeWaking
        // Quieter than the old grip chrome: smaller dots, softer contrast,
        // more breathing room. Mid dot leads; sides stay subordinate.
        let midOpacity: Double = waking ? 0.72 : 0.40
        let sideOpacity: Double = waking ? 0.38 : 0.20
        let dotSize: CGFloat = waking ? 3.0 : 2.75
        let spacing: CGFloat = 8
        return ZStack {
            VStack(spacing: spacing) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Color.white.opacity(index == 1 ? midOpacity : sideOpacity))
                        .frame(width: dotSize, height: dotSize)
                }
            }
            .scaleEffect(waking ? 1.06 : 1.0)
            .accessibilityHidden(true)
        }
        .frame(width: geo.collapsedWidth + (waking ? DynamicIslandPlacementPolicy.edgeWakeBoost : 0),
               height: geo.collapsedHeight)
        .contentShape(Rectangle())
        .accessibilityLabel(Strings.menuPlacementEdge)
    }

    // MARK: - Collapsed wings

    /// Tokens left, cost right; the center gap sits behind the hardware notch
    /// (or is plain filler on the simulated island). Also kept as the header
    /// row while expanded so the numbers never jump around.
    private var collapsedRow: some View {
        let geo = state.geometry
        let metrics = wingMetrics
        return HStack(spacing: 0) {
            Group {
                if compactModeEnabled {
                    compactRingWingView()
                } else {
                    buildWingView(for: metrics.left)
                }
            }
            .frame(width: geo.wingWidth)
            Spacer()
                .frame(width: geo.centerGapWidth)
            buildWingView(for: metrics.right, suppressValue: compactModeEnabled)
                .frame(width: geo.wingWidth)
        }
        .frame(height: geo.collapsedHeight)
        // Invisible natural-size copies of both wings: their measured max
        // drives the shared wing width, keeping the island tight + symmetric.
        .background(
            HStack(spacing: 0) {
                if compactModeEnabled {
                    measured(compactRingWingView())
                } else {
                    measured(buildWingView(for: metrics.left, liveIcon: false))
                }
                measured(buildWingView(for: metrics.right, suppressValue: compactModeEnabled, liveIcon: false))
            }
            .hidden()
        )
        .onPreferenceChange(WingNaturalWidthKey.self) { natural in
            onWingWidthChanged(ceil(natural) + Self.wingPadding)
        }
    }

    /// The two collapsed-wing metrics: the user's two menu-bar slots, kept
    /// positional so an explicit "none" slot leaves that wing empty. Hidden
    /// providers are filtered exactly like the menu bar. Reads preferences
    /// once per render.
    private func resolveWingMetrics() -> WingSelection {
        let hidden = LimitsSettingsStore.shared.hiddenProviders
        let ids = MenuBarDisplayPreferences.read()
        func metric(at index: Int, fallback: MenuBarDisplayMetric) -> MenuBarDisplayMetric? {
            guard ids.indices.contains(index) else { return fallback }
            let id = ids[index]
            // Explicit "show nothing" slot (issue #379).
            if id == MenuBarDisplayPreferences.noneID { return nil }
            guard let parsed = MenuBarDisplayMetric(rawValue: id) else { return fallback }
            if let provider = parsed.providerKey, hidden.contains(provider) { return nil }
            return parsed
        }
        return WingSelection(
            left: metric(at: 0, fallback: .todayTokens),
            right: metric(at: 1, fallback: .todayCost)
        )
    }

    private static func aspect(of image: NSImage) -> CGFloat {
        guard image.size.width > 0, image.size.height > 0 else { return 1 }
        return image.size.width / image.size.height
    }

    /// `liveIcon: false` is for the hidden measurement copies: they only need
    /// the icon's footprint, not its animation frames.
    @ViewBuilder
    private func buildWingView(
        for metric: MenuBarDisplayMetric?,
        suppressValue: Bool = false,
        liveIcon: Bool = true
    ) -> some View {
        if let metric {
            buildMetricWingView(for: metric, suppressValue: suppressValue, liveIcon: liveIcon)
        } else {
            // Explicit "none" slot: contribute nothing to the wing (the
            // shared minWingWidth floor keeps the island shape balanced).
            Color.clear.frame(width: 0, height: 0)
        }
    }

    private func buildMetricWingView(
        for metric: MenuBarDisplayMetric,
        suppressValue: Bool = false,
        liveIcon: Bool = true
    ) -> some View {
        let content = wingContent(for: metric)
        return HStack(spacing: 4) {
            if let providerKey = metric.providerKey,
               let iconName = LimitsSettingsStore.iconNames[providerKey] {
                Image(iconName)
                    .renderingMode(.original)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: 10.5, height: 10.5)
            } else if metric == .todayTokens, StatusBarController.currentMenuBarIcon != nil {
                Group {
                    if liveIcon {
                        IslandMenuBarIcon(isLive: state.isPanelVisible)
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 15.5 * menuBarIconAspect, height: 15.5)
            } else if let icon = content.icon {
                Image(systemName: icon)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Color.white.opacity(0.92))
            }

            if let label = content.label {
                Text(label)
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.55))
            }

            if !content.value.isEmpty && !(metric == .todayTokens && suppressValue) {
                wingLabel(content.value)
            }
        }
    }

    private var ringMetric: MenuBarDisplayMetric? {
        DynamicIslandCompactPolicy.resolveRingMetric(
            primarySlot: wingMetrics.left,
            secondarySlot: wingMetrics.right,
            limits: viewModel.usageLimits,
            hiddenProviders: LimitsSettingsStore.shared.hiddenProviders
        )
    }

    private var ringValues: (trim: Double, color: Double)? {
        guard let ringMetric else { return nil }
        return DynamicIslandCompactPolicy.ringValues(
            pct: viewModel.usageLimits?.utilizationPercent(for: ringMetric),
            displayMode: LimitsSettingsStore.shared.displayMode
        )
    }

    private func compactRingWingView() -> some View {
        let metric = ringMetric
        let values = ringValues
        let icon = metric.flatMap(\.providerKey).flatMap { LimitsSettingsStore.iconNames[$0] }
        let fallbackIcon = NSApp.applicationIconImage ?? NSImage(named: NSImage.applicationIconName) ?? NSImage()
        let tier = DynamicIslandCompactPolicy.quotaColor(colorValue: values?.color ?? 0)
        let color: Color = switch tier {
        case .green: .green
        case .yellow: .yellow
        case .red: .red
        }

        return ZStack {
            Circle()
                .stroke(Color.white.opacity(0.15), lineWidth: 2.5)
            if let values {
                Circle()
                    .trim(from: 0, to: values.trim)
                    .stroke(color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeInOut(duration: 0.35), value: values.trim)
            }
            if let icon {
                Image(icon)
                    .renderingMode(.original)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: 9, height: 9)
            } else {
                Image(nsImage: fallbackIcon)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: 9, height: 9)
            }
        }
        .frame(width: 18, height: 18)
        .id(metric?.rawValue ?? "empty")
    }

    private func wingContent(for metric: MenuBarDisplayMetric) -> (icon: String?, label: String?, value: String) {
        switch metric {
        case .todayTokens:
            // Same "has data" gate as the menu bar (todaySummary != nil): the
            // value stays put during re-syncs instead of blinking empty.
            let val = viewModel.todaySummary == nil ? "" : TokenFormatter.formatCompact(viewModel.todayTokens)
            return ("bolt.fill", nil, val)
        case .todayCost:
            let val = viewModel.todaySummary == nil ? "" : viewModel.todayCost
            return (nil, nil, val)
        case .last7dTokens:
            let val = viewModel.rollingSummary == nil ? "--" : TokenFormatter.formatCompact(viewModel.last7dTokens)
            return ("clock.fill", "7d", val)
        case .totalTokens:
            let val = viewModel.totalSummary == nil ? "--" : TokenFormatter.formatCompact(viewModel.totalTokens)
            return ("chart.bar.fill", "Tot", val)
        case .totalCost:
            let val = viewModel.totalSummary == nil ? "--" : viewModel.totalCost
            return (nil, "All", val)
        case .claude5h, .codex5h, .codexSpark5h, .kimi5h, .antigravityClaude5h, .antigravityGemini5h:
            return (nil, "5h", limitPercentText(for: metric) ?? "--")
        case .claude7d, .codex7d, .codexSpark7d, .antigravityClaudeWeekly, .antigravityGeminiWeekly:
            return (nil, "7d", limitPercentText(for: metric) ?? "--")
        case .cursorPlan:
            return (nil, "Plan", limitPercentText(for: metric) ?? "--")
        case .cursorAuto:
            return (nil, "Auto", limitPercentText(for: metric) ?? "--")
        case .cursorAPI:
            return (nil, "API", limitPercentText(for: metric) ?? "--")
        case .geminiPro:
            return (nil, "Pro", limitPercentText(for: metric) ?? "--")
        case .geminiFlash:
            return (nil, "Flash", limitPercentText(for: metric) ?? "--")
        case .geminiLite:
            return (nil, "Lite", limitPercentText(for: metric) ?? "--")
        default:
            return (nil, metric.menuLabel, limitPercentText(for: metric) ?? "--")
        }
    }

    /// Limit percent for a wing, sharing the menu bar's guards (configured,
    /// no error) and its display-mode/rounding rules so both surfaces agree.
    private func limitPercentText(for metric: MenuBarDisplayMetric) -> String? {
        guard let pct = viewModel.usageLimits?.utilizationPercent(for: metric) else { return nil }
        return LimitsSettingsStore.formatPercentText(pct)
    }

    private func measured<Content: View>(_ content: Content) -> some View {
        content
            .fixedSize()
            .background(GeometryReader { proxy in
                Color.clear.preference(key: WingNaturalWidthKey.self, value: proxy.size.width)
            })
    }

    private func wingLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundStyle(Color.white.opacity(0.95))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    @StateObject private var starStore = GitHubStarStore.shared
    @State private var hoveringBrand = false
    @State private var hoveringStar = false
    @State private var hoveringGear = false

    /// Shared height for the header's Star capsule and gear button so the two
    /// controls read as one family (same height, same 0.5pt hairline).
    private static let headerControlHeight: CGFloat = 26

    private var expandedHeaderRow: some View {
        let geo = state.geometry
        // Edge collapsed height is the vertical pill length (~80); the expanded
        // header should stay menu-bar-ish regardless of placement.
        let headerHeight: CGFloat = state.placement == .edge
            ? 36
            : geo.collapsedHeight
        let appIcon = NSApp.applicationIconImage ?? NSImage(named: NSImage.applicationIconName) ?? NSImage()
        return HStack(spacing: 0) {
            Button(action: {
                if let url = URL(string: "https://www.tokentracker.cc") {
                    NSWorkspace.shared.open(url)
                }
            }) {
                HStack(spacing: 6) {
                    Image(nsImage: appIcon)
                        .resizable()
                        .interpolation(.high)
                        .scaledToFit()
                        .frame(width: 18, height: 18)
                        .cornerRadius(4)
                        .shadow(color: .black.opacity(0.35), radius: 1.5, x: 0, y: 1)

                    Text("TokenTracker")
                        .font(.system(size: 12.5, weight: .regular, design: .rounded))
                        .foregroundStyle(Color.white.opacity(hoveringBrand ? 1.0 : 0.85))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointingHandCursor()
            .onHover { hovering in
                withAnimation(.easeOut(duration: 0.12)) { hoveringBrand = hovering }
            }
            .accessibilityLabel(Strings.openTokenTrackerWebsite)
            .help(Strings.openTokenTrackerWebsite)

            Spacer()

            Button(action: {
                if let url = URL(string: "https://github.com/xiufengsun/TokenTracker") {
                    NSWorkspace.shared.open(url)
                }
            }) {
                HStack(spacing: 4) {
                    GithubLogoView(size: 11.5)
                        .opacity(hoveringStar ? 1.0 : 0.9)

                    Text(Strings.starButton)
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(Color.white.opacity(hoveringStar ? 1.0 : 0.90))

                    if let stars = starStore.starCount {
                        Text(String(stars))
                            .font(.system(size: 10, weight: .regular, design: .rounded))
                            .foregroundStyle(Color.white.opacity(hoveringStar ? 0.75 : 0.55))
                    }
                }
                .padding(.horizontal, 9)
                .frame(height: Self.headerControlHeight)
                .background(
                    Capsule()
                        .fill(Color.white.opacity(hoveringStar ? 0.16 : 0.09))
                        .overlay(Capsule().strokeBorder(Color.white.opacity(hoveringStar ? 0.28 : 0.15), lineWidth: 0.5))
                )
            }
            .buttonStyle(.plain)
            .pointingHandCursor()
            .onHover { hovering in
                withAnimation(.easeOut(duration: 0.12)) { hoveringStar = hovering }
            }
            .accessibilityLabel(Strings.menuStarOnGitHub)
            .help(Strings.menuStarOnGitHub)

            // Settings gear — same visual family as the Star capsule. Surfaces
            // the tray menu on click, since right-clicking the island is easy
            // to miss.
            Button(action: {
                StatusBarController.showContextMenuFromIslandGear()
            }) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(Color.white.opacity(hoveringGear ? 0.95 : 0.65))
                    .frame(width: Self.headerControlHeight, height: Self.headerControlHeight)
                    .background(
                        Circle()
                            .fill(Color.white.opacity(hoveringGear ? 0.16 : 0.09))
                            .overlay(Circle().strokeBorder(Color.white.opacity(hoveringGear ? 0.28 : 0.15), lineWidth: 0.5))
                    )
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .pointingHandCursor()
            .onHover { hovering in
                withAnimation(.easeOut(duration: 0.12)) { hoveringGear = hovering }
            }
            .accessibilityLabel(Strings.menuSettings)
            .help(Strings.menuSettings)
            .padding(.leading, 8)
        }
        .padding(.horizontal, state.placement == .edge ? 8 : 14)
        .frame(height: headerHeight)
    }

    // MARK: - Expanded detail

    /// Cap for the limits list: island chrome (header + summary cards +
    /// divider + footer + paddings) stays under ~240pt, so this keeps the
    /// whole island within `maxExpandedHeight` and the panel's bounds.
    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            SummaryCardsView(
                todayTokens: viewModel.todayTokens,
                todayCost: viewModel.todayCost,
                last7dTokens: viewModel.last7dTokens,
                last7dActiveDays: viewModel.last7dActiveDays,
                last30dTokens: viewModel.last30dTokens,
                last30dAvgPerDay: viewModel.last30dAvgPerDay,
                totalTokens: viewModel.totalTokens,
                totalCost: viewModel.totalCost
            )

            // Self-sizing up to the cap (outer `.fixedSize` makes the scroll
            // view hug its content), scrollable beyond it — many configured
            // providers must not push the island past the panel's bottom.
            ScrollView(.vertical, showsIndicators: false) {
                UsageLimitsView(limits: viewModel.usageLimits, subscriptions: viewModel.subscriptions)
            }
            .frame(maxHeight: DynamicIslandLayoutPolicy.limitsHeight(panelHeight: state.panelSize.height))
            // macOS soft scroll-edge fades read as murky black bands inside the
            // black edge card; harden/hide them when placement is edge.
            .modifier(EdgePanelScrollEdgeChrome(enabled: state.placement == .edge))

            Divider()
                .opacity(0.4)
                .padding(.vertical, 2)

            FooterView(horizontalPadding: 4, verticalPadding: 2)
        }
        .padding(.horizontal, state.placement == .edge ? 8 : 14)
        .padding(.top, state.placement == .edge ? 6 : 10)
        .padding(.bottom, state.placement == .edge ? 8 : 10)
    }
}

/// Soft macOS ScrollView edge fades look like translucent black masks on the
/// solid black edge card. Prefer a hard/hidden edge chrome when available.
private struct EdgePanelScrollEdgeChrome: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled {
            if #available(macOS 26.0, *) {
                // Soft/hard scroll-edge fades both read as murky black bands
                // on the solid black edge card — disable the effect entirely.
                content.scrollEdgeEffectStyle(nil, for: .vertical)
            } else {
                content
            }
        } else {
            content
        }
    }
}

private struct WingSelection: Equatable {
    let left: MenuBarDisplayMetric?
    let right: MenuBarDisplayMetric?

    static let `default` = WingSelection(left: .todayTokens, right: .todayCost)
}

/// The animated menu-bar icon inside a wing. Frames arrive up to 24/s; as a
/// SwiftUI `Image` each one re-ran layout for the whole island tree. This
/// leaf swaps a CALayer mask instead, so a tick never reaches SwiftUI.
private struct IslandMenuBarIcon: NSViewRepresentable {
    /// False while the panel is hidden: ticks are dropped instead of
    /// updating an off-screen layer.
    let isLive: Bool

    func makeNSView(context: Context) -> IslandMenuBarIconView {
        let view = IslandMenuBarIconView()
        view.isLive = isLive
        return view
    }

    func updateNSView(_ view: IslandMenuBarIconView, context: Context) {
        view.isLive = isLive
    }
}

/// Template-style rendering on Core Animation: a white fill masked by the
/// frame's alpha. Each frame is rasterized once per size and cached, so the
/// animator's drawing-handler images are not re-filled on every tick.
private final class IslandMenuBarIconView: NSView {
    var isLive = false {
        didSet {
            guard isLive, !oldValue, let icon = StatusBarController.currentMenuBarIcon else { return }
            show(icon)
        }
    }

    private let maskLayer = CALayer()
    private var observer: NSObjectProtocol?
    private var current: NSImage?
    /// Weak keys: frames of a style that is switched away are released.
    private var rasterCache = NSMapTable<NSImage, CGImage>(keyOptions: .weakMemory, valueOptions: .strongMemory)
    private var rasterPixelSize: CGSize = .zero

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.withAlphaComponent(0.95).cgColor
        maskLayer.contentsGravity = .resizeAspect
        layer?.mask = maskLayer
        observer = NotificationCenter.default.addObserver(
            forName: .menuBarIconFrameUpdated,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let image = note.object as? NSImage else { return }
            MainActor.assumeIsolated {
                guard let self, self.isLive else { return }
                self.show(image)
            }
        }
        current = StatusBarController.currentMenuBarIcon
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    /// SwiftUI sizes the view via `setFrameSize` without a layout pass, so
    /// the mask frame follows here rather than in `layout()`.
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        if let current { show(current) }
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        if let current { show(current) }
    }

    /// Display only: clicks and hover belong to the island around it.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func show(_ image: NSImage) {
        current = image
        let scale = window?.backingScaleFactor ?? 2
        let pixelSize = CGSize(width: ceil(bounds.width * scale), height: ceil(bounds.height * scale))
        guard pixelSize.width > 0, pixelSize.height > 0 else { return }
        if pixelSize != rasterPixelSize {
            rasterCache.removeAllObjects()
            rasterPixelSize = pixelSize
        }
        let raster: CGImage
        if let cached = rasterCache.object(forKey: image) {
            raster = cached
        } else {
            guard let rendered = Self.rasterize(image, pixelSize: pixelSize) else { return }
            rasterCache.setObject(rendered, forKey: image)
            raster = rendered
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        maskLayer.frame = bounds
        maskLayer.contentsScale = scale
        maskLayer.contents = raster
        CATransaction.commit()
    }

    /// Aspect-fits the image into `pixelSize`; only the alpha channel matters.
    private static func rasterize(_ image: NSImage, pixelSize: CGSize) -> CGImage? {
        guard image.size.width > 0, image.size.height > 0,
              let ctx = CGContext(
                  data: nil,
                  width: Int(pixelSize.width),
                  height: Int(pixelSize.height),
                  bitsPerComponent: 8,
                  bytesPerRow: 0,
                  space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              )
        else { return nil }
        let fit = min(pixelSize.width / image.size.width, pixelSize.height / image.size.height)
        let drawn = CGSize(width: image.size.width * fit, height: image.size.height * fit)
        let rect = CGRect(
            x: (pixelSize.width - drawn.width) / 2,
            y: (pixelSize.height - drawn.height) / 2,
            width: drawn.width,
            height: drawn.height
        )
        ctx.interpolationQuality = .high
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
        image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        return ctx.makeImage()
    }
}

/// Rendered height of the island shape, reported after layout for hit-testing.
private struct IslandRenderedHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// Widest natural wing-label width; both wings adopt the max so the island
/// stays symmetric around the notch center.
private struct WingNaturalWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// Notch-like silhouette with inverse upper shoulders and rounded lower
/// corners. At the screen edge the black shape is wider, then curves inward
/// to the content body — matching the concave transition of a native notch.
struct IslandRoundedRectangle: Shape {
    var topShoulderRadius: CGFloat
    var bottomRadius: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(topShoulderRadius, bottomRadius) }
        set {
            topShoulderRadius = newValue.first
            bottomRadius = newValue.second
        }
    }

    func path(in rect: CGRect) -> Path {
        let shoulder = min(max(0, topShoulderRadius), min(rect.width / 4, rect.height / 2))
        let bodyLeft = rect.minX + shoulder
        let bodyRight = rect.maxX - shoulder
        let bodyWidth = max(0, bodyRight - bodyLeft)
        let bottom = min(max(0, bottomRadius), min(bodyWidth, rect.height) / 2)
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addCurve(
            to: CGPoint(x: bodyRight, y: rect.minY + shoulder),
            control1: CGPoint(x: rect.maxX - shoulder * 0.55, y: rect.minY),
            control2: CGPoint(x: bodyRight, y: rect.minY + shoulder * 0.45)
        )
        path.addLine(to: CGPoint(x: bodyRight, y: rect.maxY - bottom))
        path.addQuadCurve(
            to: CGPoint(x: bodyRight - bottom, y: rect.maxY),
            control: CGPoint(x: bodyRight, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: bodyLeft + bottom, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: bodyLeft, y: rect.maxY - bottom),
            control: CGPoint(x: bodyLeft, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: bodyLeft, y: rect.minY + shoulder))
        path.addCurve(
            to: CGPoint(x: rect.minX, y: rect.minY),
            control1: CGPoint(x: bodyLeft, y: rect.minY + shoulder * 0.45),
            control2: CGPoint(x: rect.minX + shoulder * 0.55, y: rect.minY)
        )
        path.closeSubpath()
        return path
    }
}

@MainActor
final class GitHubStarStore: ObservableObject {
    static let shared = GitHubStarStore()
    @Published var starCount: Int? = nil

    private static let cacheKey = "GitHubStarCountCache"

    private init() {
        // Serve the last known count immediately; refresh in the background.
        let cached = UserDefaults.standard.integer(forKey: Self.cacheKey)
        if cached > 0 { starCount = cached }
        fetchStars()
    }

    func fetchStars() {
        guard let url = URL(string: "https://api.github.com/repos/xiufengsun/TokenTracker") else { return }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let count = json["stargazers_count"] as? Int {
                    self.starCount = count
                    UserDefaults.standard.set(count, forKey: Self.cacheKey)
                }
            } catch {
                // Ignore network errors gracefully
            }
        }
    }
}

struct GithubLogoView: View {
    var size: CGFloat = 12
    var body: some View {
        Canvas { context, size in
            var path = Path()
            let s = size.width / 16.0
            path.move(to: CGPoint(x: 8 * s, y: 0))
            path.addCurve(to: CGPoint(x: 16 * s, y: 8 * s), control1: CGPoint(x: 12.42 * s, y: 0), control2: CGPoint(x: 16 * s, y: 3.58 * s))
            path.addCurve(to: CGPoint(x: 10.55 * s, y: 15.59 * s), control1: CGPoint(x: 16 * s, y: 11.54 * s), control2: CGPoint(x: 13.68 * s, y: 14.54 * s))
            path.addCurve(to: CGPoint(x: 10 * s, y: 15.21 * s), control1: CGPoint(x: 10.15 * s, y: 15.67 * s), control2: CGPoint(x: 10 * s, y: 15.42 * s))
            path.addCurve(to: CGPoint(x: 10.01 * s, y: 13.01 * s), control1: CGPoint(x: 10 * s, y: 14.94 * s), control2: CGPoint(x: 10.01 * s, y: 14.08 * s))
            path.addCurve(to: CGPoint(x: 9.47 * s, y: 11.53 * s), control1: CGPoint(x: 10.01 * s, y: 12.26 * s), control2: CGPoint(x: 9.76 * s, y: 11.78 * s))
            path.addCurve(to: CGPoint(x: 13.12 * s, y: 7.58 * s), control1: CGPoint(x: 11.25 * s, y: 11.33 * s), control2: CGPoint(x: 13.12 * s, y: 10.65 * s))
            path.addCurve(to: CGPoint(x: 12.3 * s, y: 5.43 * s), control1: CGPoint(x: 13.12 * s, y: 6.7 * s), control2: CGPoint(x: 12.81 * s, y: 5.99 * s))
            path.addCurve(to: CGPoint(x: 12.22 * s, y: 3.31 * s), control1: CGPoint(x: 12.38 * s, y: 5.23 * s), control2: CGPoint(x: 12.66 * s, y: 4.41 * s))
            path.addCurve(to: CGPoint(x: 10.02 * s, y: 4.13 * s), control1: CGPoint(x: 12.22 * s, y: 3.31 * s), control2: CGPoint(x: 11.55 * s, y: 3.09 * s))
            path.addCurve(to: CGPoint(x: 8 * s, y: 3.86 * s), control1: CGPoint(x: 9.38 * s, y: 3.95 * s), control2: CGPoint(x: 8.7 * s, y: 3.86 * s))
            path.addCurve(to: CGPoint(x: 5.98 * s, y: 4.13 * s), control1: CGPoint(x: 7.3 * s, y: 3.86 * s), control2: CGPoint(x: 6.62 * s, y: 3.95 * s))
            path.addCurve(to: CGPoint(x: 3.78 * s, y: 3.31 * s), control1: CGPoint(x: 4.45 * s, y: 3.09 * s), control2: CGPoint(x: 3.78 * s, y: 3.31 * s))
            path.addCurve(to: CGPoint(x: 3.7 * s, y: 5.43 * s), control1: CGPoint(x: 3.34 * s, y: 4.41 * s), control2: CGPoint(x: 3.62 * s, y: 5.23 * s))
            path.addCurve(to: CGPoint(x: 2.88 * s, y: 7.58 * s), control1: CGPoint(x: 3.19 * s, y: 5.99 * s), control2: CGPoint(x: 2.88 * s, y: 6.71 * s))
            path.addCurve(to: CGPoint(x: 6.52 * s, y: 11.53 * s), control1: CGPoint(x: 2.88 * s, y: 10.64 * s), control2: CGPoint(x: 4.74 * s, y: 11.33 * s))
            path.addCurve(to: CGPoint(x: 6.01 * s, y: 12.6 * s), control1: CGPoint(x: 6.29 * s, y: 11.73 * s), control2: CGPoint(x: 6.08 * s, y: 12.08 * s))
            path.addCurve(to: CGPoint(x: 3.68 * s, y: 11.94 * s), control1: CGPoint(x: 5.55 * s, y: 12.81 * s), control2: CGPoint(x: 4.4 * s, y: 12.47 * s))
            path.addCurve(to: CGPoint(x: 2.45 * s, y: 11.12 * s), control1: CGPoint(x: 3.53 * s, y: 11.7 * s), control2: CGPoint(x: 3.08 * s, y: 11.11 * s))
            path.addCurve(to: CGPoint(x: 2.46 * s, y: 11.65 * s), control1: CGPoint(x: 1.78 * s, y: 11.13 * s), control2: CGPoint(x: 2.18 * s, y: 11.5 * s))
            path.addCurve(to: CGPoint(x: 3.28 * s, y: 12.78 * s), control1: CGPoint(x: 2.8 * s, y: 11.84 * s), control2: CGPoint(x: 3.19 * s, y: 12.55 * s))
            path.addCurve(to: CGPoint(x: 5.97 * s, y: 13.72 * s), control1: CGPoint(x: 3.44 * s, y: 13.23 * s), control2: CGPoint(x: 3.96 * s, y: 14.09 * s))
            path.addCurve(to: CGPoint(x: 5.98 * s, y: 15.21 * s), control1: CGPoint(x: 5.97 * s, y: 14.39 * s), control2: CGPoint(x: 5.98 * s, y: 15.02 * s))
            path.addCurve(to: CGPoint(x: 5.43 * s, y: 15.59 * s), control1: CGPoint(x: 5.98 * s, y: 15.42 * s), control2: CGPoint(x: 5.83 * s, y: 15.67 * s))
            path.addCurve(to: CGPoint(x: 0, y: 8 * s), control1: CGPoint(x: 2.32 * s, y: 14.54 * s), control2: CGPoint(x: 0, y: 11.54 * s))
            path.addCurve(to: CGPoint(x: 8 * s, y: 0), control1: CGPoint(x: 0, y: 3.58 * s), control2: CGPoint(x: 3.58 * s, y: 0))
            path.closeSubpath()

            context.fill(path, with: .color(.white))
        }
        .frame(width: size, height: size)
    }
}
