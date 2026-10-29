import AppKit
import SwiftUI

/// Clawd pixel-art companion with full animation suite.
/// Animations ported from Clawd-on-Desk SVG keyframes (39 states).
struct ClawdCompanionView: View {
    /// Where the companion is rendered. `.dashboard` is the menu-bar popover header
    /// (horizontal row with the sync button); `.floating` is the standalone desktop
    /// pet window (transparent, enlarged sprite, hover/tap bubble, no sync button).
    enum Layout { case dashboard, floating }

    @ObservedObject var viewModel: DashboardViewModel
    var layout: Layout = .dashboard
    /// Floating desktop pet only — wired up by `DesktopPetWindowController`.
    var onRequestDashboard: (() -> Void)? = nil
    var onClosePet: (() -> Void)? = nil
    /// Floating pet: hover enter/leave, so the controller can slide an edge-hidden pet
    /// out and back.
    var onHoverChanged: ((Bool) -> Void)? = nil
    /// Reset sleep activity timer on token consumption.
    var onKeepActive: (() -> Void)? = nil
    /// Floating pet: change the pet size preset (from the right-click menu).
    var onSetSize: ((PetSizePreset) -> Void)? = nil
    /// Floating pet: switch the persistent companion identity.
    var onSetCharacter: ((PetCharacter) -> Void)? = nil
    /// Floating pet: report the bubble's intrinsic height so its transparent host
    /// can grow without clipping multi-row usage content.
    var onBubbleHeightChanged: ((CGFloat) -> Void)? = nil
    /// Floating pet: gates the bubble by on-screen width (set by DesktopPetWindowController).
    @ObservedObject var petState: PetWindowState = .alwaysAllowed
    /// Appearance is shared with the floating pet so the popover changes immediately.
    @ObservedObject private var characterStore = PetCharacterStore.shared
    @ObservedObject private var petCatalog = PetCatalog.shared
    /// Limit visibility / used-vs-remaining preferences also affect the compact pet line.
    @ObservedObject private var limitsStore = LimitsSettingsStore.shared

    /// Floating pet: briefly reveal the quip bubble after a tap (hover shows data instead).
    @State private var floatingBubbleShown = false
    @State private var floatingBubbleTask: Task<Void, Never>?

    @State private var eyesClosed = false
    @State private var hoverSide: HoverSide = .none
    @State private var hoverDirectionIndex: Int? = nil
    @State private var currentAction: CharacterAction = .none
    @State private var quipIndex = 0
    @State private var armWave = false
    @State private var syncSpinActive = false
    @State private var syncSpinStart = Date()
    @State private var syncSpinStopTask: Task<Void, Never>?
    @State private var hoveringSync = false
    @State private var hoveringCharacter = false
    @State private var tapOverrideState: ClawdState?
    @State private var idleVariant: ClawdState = .idleLiving
    @State private var lastTokens = 0
    @State private var modelStatusText: String? = nil
    @State private var modelStatusTask: Task<Void, Never>? = nil
    @State private var blinkTask: Task<Void, Never>? = nil
    @State private var idleVariantTask: Task<Void, Never>? = nil

    private let px: CGFloat = 4.0
    private let syncSpinPeriod: TimeInterval = 0.8
    /// Liquid Glass and its shadow paint outside the bubble's layout bounds. Reserve
    /// that optical area inside the measured SwiftUI hierarchy so the NSPanel grows
    /// with the complete rendered bubble instead of clipping its top edge.
    private static let floatingBubbleTopEffectInset: CGFloat = 24
    /// Sprite magnification for the standalone desktop-pet window, driven by the chosen
    /// size preset (only applied in the `.floating` layout).
    private var floatingScale: CGFloat { petState.floatingScale }

    var body: some View {
        Group {
            switch layout {
            case .dashboard: dashboardContent
            case .floating: floatingContent
            }
        }
        .onAppear {
            updateDiscreteAnimationLoops(isVisible: isCharacterTimelineVisible)
            lastTokens = viewModel.todayTokens
        }
        .onChange(of: isCharacterTimelineVisible) { isVisible in
            updateDiscreteAnimationLoops(isVisible: isVisible)
        }
        .onDisappear {
            stopDiscreteAnimationLoops()
            floatingBubbleTask?.cancel()
            floatingBubbleTask = nil
            modelStatusTask?.cancel()
            modelStatusTask = nil
            syncSpinStopTask?.cancel()
            syncSpinStopTask = nil
        }
        .onChange(of: viewModel.todayTokens) { newTokens in
            if lastTokens > 0, newTokens > lastTokens {
                // Token activity counts as life: don't let the pet appear asleep mid-work.
                if petState.sleepState != nil { petState.sleepState = nil }
                onKeepActive?()
                let delta = newTokens - lastTokens
                let formattedDelta = TokenFormatter.formatCompact(delta)
                modelStatusText = Strings.randomTokenIncrementMessage(delta: formattedDelta)
                
                modelStatusTask?.cancel()
                modelStatusTask = Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    if !Task.isCancelled {
                        modelStatusText = nil
                    }
                }
            }
            lastTokens = newTokens
        }
        .onChange(of: viewModel.isSyncing) { syncing in
            if !syncing {
                if viewModel.todayTokens <= lastTokens {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        quipIndex += 1
                    }
                    floatingBubbleTask?.cancel()
                    floatingBubbleShown = true
                    floatingBubbleTask = Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        if !Task.isCancelled {
                            floatingBubbleShown = false
                        }
                    }
                }
            }
        }
    }

    /// Menu-bar popover header: character + bubble + sync button in a row.
    private var dashboardContent: some View {
        HStack(alignment: .center, spacing: 10) {
            characterView
                .frame(width: 15 * px, height: 16 * px)
                .modifier(ActionModifier(action: currentAction))
                .modifier(ClawdHoverModifier(hoveringCharacter: $hoveringCharacter, onActive: { loc in
                    let mid = 15 * px / 2
                    hoverSide = loc.x < mid - 10 ? .left : (loc.x > mid + 10 ? .right : .center)
                    updateLookDirection(at: loc, in: CGSize(width: 15 * px, height: 16 * px))
                }, onEnded: {
                    hoverSide = .none
                    hoverDirectionIndex = nil
                }))
                .onTapGesture { handleTap() }

            bubbleView
                .id("quip-\(quipIndex)")
                .offset(y: -2)

            Spacer(minLength: 0)

            syncButton
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom,-8)
    }

    /// Standalone desktop pet: enlarged sprite with a hover/tap bubble floating above it.
    private var floatingContent: some View {
        VStack(spacing: 3) {
            // The bubble is ALWAYS in the view tree — only its opacity toggles. Its
            // intrinsic height grows the transparent panel upward while the panel's
            // bottom edge (and therefore the sprite) stays fixed, avoiding both clipping
            // and the hover feedback loop caused by moving the sprite under the cursor.
            bubbleView
                .padding(.top, Self.floatingBubbleTopEffectInset)
                .id("quip-\(quipIndex)")
                .fixedSize()
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: FloatingBubbleHeightPreferenceKey.self,
                            value: proxy.size.height
                        )
                    }
                }
                .allowsHitTesting(false)
                .opacity(floatingBubbleVisible ? 1 : 0)
                .animation(.easeOut(duration: 0.18), value: floatingBubbleVisible)
                .offset(x: petState.isSnapped ? (petState.isRightEdge ? -40 : 40) : 0)
                .frame(
                    maxWidth: .infinity,
                    minHeight: petState.bubbleHeight,
                    maxHeight: petState.bubbleHeight,
                    alignment: .bottom
                )

            characterView
                .frame(width: 15 * px, height: 16 * px)
                .scaleEffect(floatingScale)
                .frame(width: 15 * px * floatingScale, height: 16 * px * floatingScale)
                .modifier(ActionModifier(action: currentAction))
                .modifier(PetLookHoverModifier(
                    enabled: activeCharacter.spriteVersionNumber == 2,
                    onActive: { loc in
                        updateLookDirection(
                            at: loc,
                            in: CGSize(width: 15 * px * floatingScale, height: 16 * px * floatingScale)
                        )
                    },
                    onEnded: { hoverDirectionIndex = nil }
                ))
                // Floating pet uses a plain discrete hover (NOT ClawdHoverModifier's
                // continuous one): the per-frame .active flickered the hover-gated bubble.
                // No lean here — the pet stays upright in exchange for rock-steady hover.
                .onHover { hovering in
                    // Idempotent push/pop guard so a dropped/duplicated hover event can't
                    // leak a cursor-stack level (would leave the hand cursor stuck).
                    if hovering {
                        if !hoveringCharacter { NSCursor.openHand.push() }
                    } else {
                        if hoveringCharacter { NSCursor.pop() }
                    }
                    hoveringCharacter = hovering
                }
                .onChange(of: hoveringCharacter) { onHoverChanged?($0) }
                .onTapGesture(count: 2) { onRequestDashboard?() }
                .onTapGesture(count: 1) { handleFloatingTap() }
                .contextMenu {
                    Button(Strings.openDashboard) { onRequestDashboard?() }
                    Button(Strings.menuSyncNow) { Task { await viewModel.triggerSync() } }
                    Menu(Strings.menuPetSize) {
                        let current = PetSizePreset.from(scale: petState.floatingScale)
                        ForEach(PetSizePreset.allCases, id: \.self) { preset in
                            Button {
                                onSetSize?(preset)
                            } label: {
                                if preset == current {
                                    Label(preset.menuLabel, systemImage: "checkmark")
                                } else {
                                    Text(preset.menuLabel)
                                }
                            }
                        }
                    }
                    Menu(Strings.menuPetCharacter) {
                        ForEach(PetCharacter.allCases, id: \.self) { character in
                            Button {
                                onSetCharacter?(character)
                            } label: {
                                if character == characterStore.character {
                                    Label(character.menuLabel, systemImage: "checkmark")
                                } else {
                                    Text(character.menuLabel)
                                }
                            }
                        }
                    }
                    Divider()
                    Button(Strings.menuHidePet) { onClosePet?() }
                }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .onPreferenceChange(FloatingBubbleHeightPreferenceKey.self) { height in
            onBubbleHeightChanged?(height)
        }
    }

    /// The floating bubble is shown while hovering (precise data) or briefly after a tap —
    /// but only when enough of the pet is on-screen (not edge-tucked or dragging off).
    private var floatingBubbleVisible: Bool {
        (hoveringCharacter || floatingBubbleShown || modelStatusText != nil)
            && petState.bubbleAllowed
    }

    // MARK: - Speech Bubble

    @State private var hoveringBubble = false

    private var bubbleView: some View {
        bubbleContent
            .foregroundStyle(.primary)
            .frame(maxWidth: layout == .floating ? 320 : nil, alignment: .center)
            .fixedSize(horizontal: false, vertical: true)
            // The popover bubble's tail is carved out of the LEFT 6pt of the
            // shape, so a symmetric horizontal padding leaves the content only
            // ~4pt from the body edge. Add the tail width back on the leading
            // side so text gets the intended inset from the rounded body.
            .padding(.leading, layout == .floating ? 13 : 16)
            .padding(.trailing, layout == .floating ? 13 : 10)
            .padding(.vertical, layout == .floating ? 7 : 9)
            // Floating bubble has a downward tail (6pt) carved out of the bottom; add
            // matching bottom padding so the text stays centered in the rounded body.
            .padding(.bottom, layout == .floating ? 7 : 0)
            .modifier(PetBubbleSurface(isFloating: layout == .floating))
            .scaleEffect(hoveringBubble ? 1.03 : 1.0)
            .animation(.easeOut(duration: 0.12), value: hoveringBubble)
            .onHover { h in
                hoveringBubble = h
                if h { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
            .onTapGesture { handleTap() }
            .transition(.asymmetric(
                insertion: .opacity.combined(with: .scale(
                    scale: 0.92,
                    anchor: layout == .floating ? .bottom : .leading
                )),
                removal: .opacity
            ))
    }

    @ViewBuilder
    private var bubbleContent: some View {
        if showsFloatingUsageBreakdown {
            floatingUsageContent
        } else {
            Text(bubbleText)
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .lineLimit(layout == .floating ? 2 : 3)
                .lineSpacing(1)
        }
    }

    /// Hover data gets an intentional hierarchy: the token total is the primary
    /// metric, followed by one compact progress row for each active, non-full
    /// limit. Exact percentages remain in the full Limits view, where they have
    /// room and context.
    private var floatingUsageContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            if viewModel.todayTokens > 0 {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(TokenFormatter.formatCompact(viewModel.todayTokens)) tokens")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(Strings.petCostToday(viewModel.todayCost))
                        .font(.system(size: 9.5, weight: .regular, design: .rounded))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.bottom, 6)
                Rectangle()
                    .fill(.white.opacity(0.13))
                    .frame(height: 0.5)
                    .padding(.bottom, 4)
            }

            ForEach(activePetLimits.indices, id: \.self) { index in
                let reading = activePetLimits[index]
                let display = petLimitDisplay(for: reading)
                HStack(spacing: 7) {
                    Circle()
                        .fill(display.tone.color)
                        .frame(width: 5, height: 5)
                        .shadow(color: display.tone.color.opacity(0.45), radius: 3)
                    Text("\(reading.provider) \(reading.window)")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 2)
                    Capsule()
                        .fill(.white.opacity(0.14))
                        .frame(width: 50, height: 4)
                        .overlay(alignment: .leading) {
                            Capsule()
                                .fill(display.tone.color)
                                .frame(
                                    width: CGFloat(max(0, min(100, display.value)) / 100 * 50),
                                    height: 4
                                )
                        }
                    Text(display.resetText ?? "")
                        .font(.system(size: 8.5, weight: .regular, design: .rounded))
                        .foregroundStyle(.secondary)
                        .frame(width: 42, alignment: .trailing)
                        .lineLimit(1)
                }
                .padding(.top, index > 0 ? 3 : 0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Sync Button

    private var syncButton: some View {
        TimelineView(.animation(
            minimumInterval: 1.0 / 30.0,
            paused: !syncSpinActive || !viewModel.isPopoverVisible
        )) { timeline in
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 11))
                .foregroundStyle(viewModel.isSyncing ? .tertiary : (hoveringSync ? .primary : .secondary))
                .rotationEffect(.degrees(syncRotationDegrees(at: timeline.date)))
                .scaleEffect(hoveringSync && !viewModel.isSyncing ? 1.15 : 1.0)
                .animation(.easeOut(duration: 0.15), value: hoveringSync)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
                .onTapGesture { triggerManualSync() }
                .onHover { h in
                    hoveringSync = h
                    if h { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                }
                .accessibilityLabel(viewModel.isSyncing ? Strings.syncingUsageData : Strings.syncUsageData)
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { triggerManualSync() }
                .onChange(of: viewModel.isSyncing) { syncing in
                    if syncing {
                        startSyncSpin()
                    } else {
                        stopSyncSpinAfterCurrentTurn()
                    }
                }
                .onDisappear {
                    syncSpinStopTask?.cancel()
                    syncSpinStopTask = nil
                }
        }
    }

    private func triggerManualSync() {
        guard !viewModel.isSyncing else { return }
        Task { await viewModel.triggerSync() }
    }

    private func syncRotationDegrees(at date: Date) -> Double {
        guard syncSpinActive else { return 0 }
        let elapsed = max(0, date.timeIntervalSince(syncSpinStart))
        return (elapsed / syncSpinPeriod * 360).truncatingRemainder(dividingBy: 360)
    }

    private func startSyncSpin() {
        syncSpinStopTask?.cancel()
        syncSpinStopTask = nil
        syncSpinStart = Date()
        syncSpinActive = true
    }

    private func stopSyncSpinAfterCurrentTurn() {
        guard syncSpinActive else { return }
        syncSpinStopTask?.cancel()

        let elapsed = max(0, Date().timeIntervalSince(syncSpinStart))
        let remainder = elapsed.truncatingRemainder(dividingBy: syncSpinPeriod)
        let delay = remainder == 0 ? 0 : syncSpinPeriod - remainder

        syncSpinStopTask = Task { @MainActor in
            if delay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
            guard !Task.isCancelled, !viewModel.isSyncing else { return }
            syncSpinActive = false
            syncSpinStopTask = nil
        }
    }

    // MARK: - Character Canvas (all animations time-driven)

    /// Shared drawing context passed to each state's draw function.
    private struct DrawCtx {
        let t: Double
        let s: CGFloat
        let yBase: CGFloat
        let yOff: CGFloat
        let size: CGSize
        let bodyColor: Color
        let accentColor: Color
        let eyeColor: Color
        let eyesClosed: Bool
        let hoverLeanX: CGFloat
        let hoverEyeShift: CGFloat
        let hoveringCharacter: Bool
        let hoverSide: HoverSide
        let isRightEdgeMini: Bool

        func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat,
               dx: CGFloat = 0, dy: CGFloat = 0) -> CGRect {
            let actualX: CGFloat = isRightEdgeMini ? (15.0 - (x + dx) - w) : (x + dx)
            return CGRect(x: actualX * s, y: (y - yBase + dy) * s + yOff,
                          width: w * s, height: h * s)
        }
    }

    private var characterView: some View {
        Group {
            switch activeCharacter.renderer {
            case .clawd:
                clawdCanvas
            case .vector where BotFrames.isAvailable:
                BotSpriteView(
                    state: clawdState.petStateName,
                    colorId: characterStore.botColor,
                    isVisible: isCharacterTimelineVisible
                )
            case .vector:
                // Pre-rendered clips missing or schema-stale (run gen:bot-frames).
                // Fall back to Clawd rather than an empty transparent window, matching
                // what MenuBarAnimator.applyBot does.
                clawdCanvas
            case .atlas:
                PetAtlasSpriteView(
                    character: activeCharacter,
                    state: clawdState,
                    isVisible: isCharacterTimelineVisible,
                    lookDirectionIndex: hoverDirectionIndex ?? (layout == .floating ? petState.lookDirectionIndex : nil),
                    isDragging: petState.isDragging,
                    dragDirection: petState.dragDirection
                )
            }
        }
        // Scaled by what is actually being DRAWN, not by the selected character: the
        // vector fallback above draws Clawd, and applying bot's 1.35 to Clawd's tightly
        // cropped artwork would render it 61% oversized and clipped by the window.
        .scaleEffect(paintedVisualScale)
    }

    private var paintedVisualScale: CGFloat {
        if activeCharacter.renderer == .vector && !BotFrames.isAvailable {
            return PetCharacter.clawd.visualScale
        }
        return activeCharacter.visualScale
    }

    private var activeCharacter: PetCharacter {
        characterStore.character
    }

    private func updateLookDirection(at location: CGPoint, in size: CGSize) {
        guard activeCharacter.spriteVersionNumber == 2 else {
            hoverDirectionIndex = nil
            return
        }
        let dx = location.x - size.width / 2
        let dy = location.y - size.height / 2
        let degrees = (atan2(dx, -dy) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
        hoverDirectionIndex = Int((degrees / 22.5).rounded()) % 16
    }

    private var clawdCanvas: some View {
        TimelineView(.animation(
            minimumInterval: characterFrameInterval,
            paused: characterTimelinePaused
        )) { timeline in
            Canvas { context, size in
                let s = px
                let yBase: CGFloat = 6
                let ctx = DrawCtx(
                    t: timeline.date.timeIntervalSinceReferenceDate,
                    s: s,
                    yBase: yBase,
                    yOff: (size.height - 10 * s) / 2,
                    size: size,
                    bodyColor: Color(red: 0.87, green: 0.53, blue: 0.43),
                    accentColor: Color(red: 1.0, green: 0.82, blue: 0.40),
                    eyeColor: Color.black,
                    eyesClosed: eyesClosed,
                    hoverLeanX: hoverLeanX,
                    hoverEyeShift: hoverEyeShift,
                    hoveringCharacter: hoveringCharacter,
                    hoverSide: hoverSide,
                    isRightEdgeMini: petState.isTucked && petState.isRightEdge
                )

                switch clawdState {
                case .idleLiving:      Self.drawIdleLiving(ctx: ctx, context: &context)
                case .idleLook:        Self.drawIdleLook(ctx: ctx, context: &context)
                case .idleDoze:        Self.drawIdleDoze(ctx: ctx, context: &context)
                case .sleeping:        Self.drawSleeping(ctx: ctx, context: &context)
                case .workingTyping:   Self.drawWorkingTyping(ctx: ctx, context: &context)
                case .workingThinking: Self.drawWorkingThinking(ctx: ctx, context: &context)
                case .workingUltrathink: Self.drawWorkingUltrathink(ctx: ctx, context: &context)
                case .workingJuggling: Self.drawWorkingJuggling(ctx: ctx, context: &context)
                case .workingWizard:   Self.drawWorkingWizard(ctx: ctx, context: &context)
                case .workingOverheated: Self.drawWorkingOverheated(ctx: ctx, context: &context)
                case .happy:           Self.drawHappy(ctx: ctx, context: &context)
                case .disconnected:    Self.drawDisconnected(ctx: ctx, context: &context)
                case .error:           Self.drawError(ctx: ctx, context: &context)
                case .yawning:         Self.drawYawning(ctx: ctx, context: &context)
                case .waking:          Self.drawWaking(ctx: ctx, context: &context)
                case .miniIdle:        Self.drawMiniIdle(ctx: ctx, context: &context)
                case .miniPeek:        Self.drawMiniPeek(ctx: ctx, context: &context)
                case .miniAlert:       Self.drawMiniAlert(ctx: ctx, context: &context)
                case .miniHappy:       Self.drawMiniHappy(ctx: ctx, context: &context)
                case .miniSleep:       Self.drawMiniSleep(ctx: ctx, context: &context)
                }
            }
        }
    }

    private var characterTimelinePaused: Bool {
        CompanionAnimationPolicy.shouldPauseTimeline(
            surface: animationSurface,
            isPopoverVisible: viewModel.isPopoverVisible,
            isFloatingPetVisible: petState.isWindowVisible,
            isStaticFrame: clawdState == .miniIdle
        )
    }

    private var isCharacterTimelineVisible: Bool {
        CompanionAnimationPolicy.isVisible(
            surface: animationSurface,
            isPopoverVisible: viewModel.isPopoverVisible,
            isFloatingPetVisible: petState.isWindowVisible
        )
    }

    private var animationSurface: CompanionAnimationPolicy.Surface {
        layout == .dashboard ? .popover : .floatingPet
    }

    private var characterFrameInterval: TimeInterval {
        switch clawdState {
        case .workingTyping, .workingThinking, .workingUltrathink, .workingJuggling,
             .workingWizard, .workingOverheated, .happy, .error, .yawning, .waking:
            return 1.0 / 15.0
        case .disconnected, .miniAlert, .miniPeek, .miniHappy:
            return 1.0 / 5.0
        case .idleLiving, .idleLook:
            return hoveringCharacter ? 1.0 / 8.0 : 1.0 / 3.0
        case .idleDoze, .sleeping, .miniSleep:
            return 1.0
        case .miniIdle:
            return 60.0
        }
    }

    /// 超级思考动画用于仪表盘 WebView 加载层（与 `workingUltrathink` 一致：震颤/火花等）。
    struct LoadingMascotView: View {
        private let px: CGFloat = 4.0

        var body: some View {
            TimelineView(.animation(minimumInterval: 1.0 / 15.0)) { timeline in
                Canvas { context, size in
                    let s = px
                    let yBase: CGFloat = 6
                    let ctx = DrawCtx(
                        t: timeline.date.timeIntervalSinceReferenceDate,
                        s: s,
                        yBase: yBase,
                        yOff: (size.height - 10 * s) / 2,
                        size: size,
                        bodyColor: Color(red: 0.87, green: 0.53, blue: 0.43),
                        accentColor: Color(red: 1.0, green: 0.82, blue: 0.40),
                        eyeColor: Color.black,
                        eyesClosed: false,
                        hoverLeanX: 0,
                        hoverEyeShift: 0,
                        hoveringCharacter: false,
                        hoverSide: .none,
                        isRightEdgeMini: false
                    )
                    ClawdCompanionView.drawWorkingUltrathink(ctx: ctx, context: &context)
                }
            }
            .frame(width: 15 * px, height: 16 * px)
        }
    }

    // MARK: - Per-State Drawing Functions

    private static func drawIdleLiving(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let breathPhase = sin(t / 3.2 * .pi * 2)
        let breathDx: CGFloat = 0
        let breathDy = breathPhase * 0.5

        let actionT = (t / 10.0).truncatingRemainder(dividingBy: 1.0)
        let bodyShiftX: CGFloat = {
            if actionT < 0.08 || (actionT > 0.25 && actionT < 0.30) || (actionT > 0.45 && actionT < 0.60) || actionT > 0.60 {
                return 0
            }
            if actionT >= 0.12 && actionT <= 0.22 { return 1 }
            if actionT >= 0.48 && actionT <= 0.57 { return -1 }
            if actionT >= 0.33 && actionT <= 0.38 { return 0.5 }
            return 0
        }()

        let hoverLean = ctx.hoverLeanX
        let dx = bodyShiftX + hoverLean + breathDx
        let dy = breathDy

        context.fill(Path(ctx.r(3, 15, 9, 0.5, dx: dx)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3, dx: 0)), with: .color(bodyColor))
        }

        let tScaleX: CGFloat = 1.0 + breathPhase * 0.015
        let tScaleY: CGFloat = 1.0 - breathPhase * 0.015
        let tW = 11 * tScaleX, tH = 7 * tScaleY
        let tX = 2 + (11 - tW) / 2, tY = 6 + (7 - tH)
        context.fill(Path(ctx.r(tX, tY, tW, tH, dx: dx, dy: dy)), with: .color(bodyColor))

        let scratching = actionT >= 0.33 && actionT <= 0.39
        let scratchY: CGFloat = scratching ? 9 + sin(t * 30) * 1.5 : 9
        context.fill(Path(ctx.r(0, scratchY, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(13, 9, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        let eyeShift: CGFloat = {
            if ctx.hoverSide != .none { return ctx.hoverEyeShift }
            if actionT >= 0.12 && actionT <= 0.22 { return 1.5 }
            if actionT >= 0.48 && actionT <= 0.57 { return -1.5 }
            return 0
        }()

        let blinkPhases: [ClosedRange<Double>] = [0.03...0.07, 0.18...0.22, 0.47...0.51, 0.78...0.82]
        let isBlinkTime = blinkPhases.contains { $0.contains(actionT) }

        if ctx.eyesClosed || isBlinkTime {
            context.fill(Path(ctx.r(4 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
        }

        if ctx.hoveringCharacter {
            context.fill(Path(ctx.r(tX, tY, tW, tH, dx: dx, dy: dy)), with: .color(.white.opacity(0.06)))
        }
    }

    private static func drawIdleLook(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t

        let breathPhase = sin(t / 3.2 * .pi * 2)
        let dy = breathPhase * 0.4

        let actionT = (t / 10.0).truncatingRemainder(dividingBy: 1.0)
        let bodyShiftX: CGFloat = {
            if actionT >= 0.12 && actionT <= 0.22 { return 1 }
            if actionT >= 0.48 && actionT <= 0.57 { return -1 }
            if actionT >= 0.33 && actionT <= 0.38 { return 0.5 }
            return 0
        }()
        let eyeShift: CGFloat = {
            if ctx.hoverSide != .none { return ctx.hoverEyeShift }
            if actionT >= 0.12 && actionT <= 0.22 { return 3 }
            if actionT >= 0.48 && actionT <= 0.57 { return -3 }
            return 0
        }()
        let dx = bodyShiftX + ctx.hoverLeanX

        drawBaseCharacterStatic(ctx: ctx, context: &context,
                                dx: dx, dy: dy,
                                eyeShift: eyeShift,
                                breathPhase: breathPhase)
    }

    private static func drawIdleDoze(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let breathPhase = sin(t / 4.0 * .pi * 2)
        let squashX: CGFloat = 1.05 + breathPhase * 0.03
        let dy: CGFloat = 1.0 + breathPhase * 0.8

        context.fill(Path(ctx.r(3, 15, 9 * squashX, 0.5)), with: .color(.black.opacity(0.14)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }

        let tW = 11 * squashX, tH = 7 * (1.0 - breathPhase * 0.03)
        let tX = 2 + (11 - tW) / 2
        context.fill(Path(ctx.r(tX, 6 + (7 - tH), tW, tH, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(0, 10, 2, 2, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 10, 2, 2, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(4, 9, 1, 0.35, dy: dy)), with: .color(eyeColor))
        context.fill(Path(ctx.r(10, 9, 1, 0.35, dy: dy)), with: .color(eyeColor))
    }

    private static func drawSleeping(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let breathPhase = sin(t / 4.5 * .pi * 2)
        let squashScale = 1.0 + breathPhase * 0.03
        let dy: CGFloat = 1.0 + breathPhase * 0.8

        context.fill(Path(ctx.r(3, 15, 9 * squashScale, 0.5)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }

        let tW = 11 * squashScale, tH = 7 * (1.0 - breathPhase * 0.02)
        let tX = 2 + (11 - tW) / 2
        context.fill(Path(ctx.r(tX, 6 + (7 - tH), tW, tH, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(0, 10, 2, 2, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 10, 2, 2, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(4, 9, 1, 0.35, dy: dy)), with: .color(eyeColor))
        context.fill(Path(ctx.r(10, 9, 1, 0.35, dy: dy)), with: .color(eyeColor))

        // Absolute canvas coordinates: in sprite space the Zs drifted to x 52-60 and
        // y -20, i.e. out of the frame and straight into the speech bubble's corner.
        for i in 0..<3 {
            let zT = (t + Double(i) * 2.0).truncatingRemainder(dividingBy: 6.0) / 6.0
            let sway = sin(zT * .pi * 3) * 2
            let alpha: Double = {
                if zT < 0.1 { return zT * 10 }
                if zT > 0.9 { return (1.0 - zT) * 10 }
                return 0.8
            }()
            let fontSize: CGFloat = 6.5 + CGFloat(zT) * 3
            context.draw(
                Text("Z")
                    .font(.system(size: fontSize, weight: .bold, design: .monospaced))
                    .foregroundColor(.secondary.opacity(alpha * 0.7)),
                at: CGPoint(x: 45 + CGFloat(sway) * 2, y: 14 - CGFloat(zT) * 9)
            )
        }
    }

    private static func drawWorkingTyping(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let jitterX: CGFloat = sin(t * 78.5) * 0.3
        let jitterY: CGFloat = sin(t * 65.3) * 0.5
        let dx = jitterX + ctx.hoverLeanX
        let dy = jitterY

        context.fill(Path(ctx.r(3, 15, 9, 0.5, dx: dx)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 13, 1, 2)), with: .color(bodyColor))
        }

        context.fill(Path(ctx.r(2, 6, 11, 7, dx: dx, dy: dy)), with: .color(bodyColor))

        let leftArmY: CGFloat = 9 + sin(t * 41.9) * 1.5
        let rightArmY: CGFloat = 9 + sin(t * 52.4) * 1.5
        context.fill(Path(ctx.r(0, leftArmY, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, rightArmY, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        let scanPhase = (t / 1.2).truncatingRemainder(dividingBy: 1.0)
        let eyeShift = CGFloat(scanPhase < 0.5 ? scanPhase * 4 - 1 : 3 - scanPhase * 4)
        if ctx.eyesClosed {
            context.fill(Path(ctx.r(4 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
        }

        // Data particles rising off the keyboard. They used to be 1.6-2.8pt at 0.8
        // alpha and to fade out above the canvas, which made the effect effectively
        // invisible; they now top out at the frame edge and stay large enough to read.
        let particleColor = Color(red: 0.25, green: 0.77, blue: 1.0)
        for i in 0..<7 {
            let pT = (t * 1.2 + Double(i) * 0.14).truncatingRemainder(dividingBy: 1.0)
            let pY = 13.0 - pT * 9.6
            let pX = 7.5 + sin(Double(i) * 2.1) * 3.5
            let alpha = pT < 0.15 ? pT / 0.15 : (pT > 0.75 ? (1.0 - pT) / 0.25 : 1.0)
            let pSize: CGFloat = 0.7 + CGFloat(pT) * 0.4
            context.fill(Path(ctx.r(CGFloat(pX), CGFloat(pY), pSize, pSize)),
                         with: .color(particleColor.opacity(alpha * 0.95)))
        }
    }

    private static func drawWorkingThinking(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let swayPhase = sin(t / 4.0 * .pi * 2)
        let swayX = swayPhase * 1.0
        let dx = swayX + ctx.hoverLeanX

        context.fill(Path(ctx.r(3 + swayX, 15, 9, 0.5)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 13, 1, 2)), with: .color(bodyColor))
        }

        context.fill(Path(ctx.r(2, 6, 11, 7, dx: dx)), with: .color(bodyColor))

        context.fill(Path(ctx.r(0, 9, 2, 2, dx: dx)), with: .color(bodyColor))

        let tapPhase = sin(t / 0.8 * .pi * 2)
        let tapArmY: CGFloat = 7 + tapPhase * 0.5
        context.fill(Path(ctx.r(13, tapArmY, 2, 2, dx: dx)), with: .color(bodyColor))

        let thinkBlinkT = (t / 4.0).truncatingRemainder(dividingBy: 1.0)
        let isThinkBlink = thinkBlinkT > 0.46 && thinkBlinkT < 0.54

        if ctx.eyesClosed || isThinkBlink {
            context.fill(Path(ctx.r(4, 8.5, 1, 0.35, dx: dx)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10, 8.5, 1, 0.35, dx: dx)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4, 7, 1, 2, dx: dx)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10, 7, 1, 2, dx: dx)), with: .color(eyeColor))
        }

        // Thought indicator above the head. The web SVG's 10x9 speech cloud can't be
        // ported literally: this canvas is 60x64pt and the torso starts at y=6, so only
        // 12pt (3 sprite units) of clear space exists above the head. The cloud's body
        // clipped off the top edge and its down-right tail was the only part left
        // on-screen — landing squarely on Clawd's face. Sequential dots read the same
        // and stay inside the frame.
        let dotColor = Color(red: 0, green: 0.51, blue: 0.99)
        let dotT = (t / 2.0).truncatingRemainder(dividingBy: 1.0)
        let dotY: CGFloat = 3.6 + sin(t / 1.6 * .pi * 2) * 0.2
        for (index, dotX) in [CGFloat(5), 7, 9].enumerated() {
            guard dotT > 0.2 + Double(index) * 0.2 else { continue }
            context.fill(Path(ctx.r(dotX, dotY, 1, 1, dx: dx * 0.5)), with: .color(dotColor))
        }
    }

    private static func drawWorkingUltrathink(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let shakePhase = sin(t / 0.15 * .pi)
        let dx: CGFloat = shakePhase * 0.3
        let dy: CGFloat = cos(t / 0.15 * .pi * 0.9) * 0.15

        let shadowW: CGFloat = 9 + shakePhase * 0.2
        context.fill(Path(ctx.r(3, 15, shadowW, 0.5, dx: dx)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 13, 1, 2)), with: .color(bodyColor))
        }

        context.fill(Path(ctx.r(2, 6, 11, 7, dx: dx, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(0, 9, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        let tapFastY: CGFloat = 7 + sin(t / 0.8 * .pi * 2) * 0.5
        context.fill(Path(ctx.r(13, tapFastY, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        let focusT = (t / 2.0).truncatingRemainder(dividingBy: 1.0)
        let isFocusBlink = focusT > 0.70 && focusT < 0.78

        if ctx.eyesClosed || isFocusBlink {
            context.fill(Path(ctx.r(4, 8.5, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10, 8.5, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4, 7, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10, 7, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
        }

        let sparkColor = Color(red: 1, green: 0.84, blue: 0)
        for i in 0..<4 {
            let spT = (t + Double(i) * 0.3).truncatingRemainder(dividingBy: 1.2) / 1.2
            let spRise = spT * 3.0
            let spAlpha = spT < 0.15 ? spT / 0.15 : (spT > 0.6 ? max(0, (1.0 - spT) / 0.4) : 1.0)
            let spX: CGFloat = [10, 6, 3, 8][i]
            let spSize: CGFloat = 1.0 - CGFloat(spT) * 0.7
            context.fill(Path(ctx.r(spX, 6 - CGFloat(spRise), spSize, spSize, dx: dx)),
                         with: .color(sparkColor.opacity(spAlpha)))
        }

        for i in 0..<3 {
            let stT = (t + Double(i) * 0.7).truncatingRemainder(dividingBy: 2.0) / 2.0
            let stRise = stT * 2.5
            let stAlpha = stT < 0.2 ? stT * 3 : (stT > 0.7 ? max(0, (1.0 - stT) / 0.3) : 0.6)
            let stX: CGFloat = [5, 9, 7][i]
            let stSize: CGFloat = 0.8 + CGFloat(stT) * 0.7
            context.fill(Path(ctx.r(stX, 6 - CGFloat(stRise), stSize, stSize / 2, dx: dx)),
                         with: .color(.gray.opacity(stAlpha * 0.4)))
        }

        let rainbowColors: [Color] = [
            Color(red: 1, green: 0.32, blue: 0.32),
            Color(red: 1, green: 0.60, blue: 0),
            Color(red: 1, green: 0.76, blue: 0.03),
            Color(red: 0.30, green: 0.69, blue: 0.31),
            Color(red: 0.13, green: 0.59, blue: 0.95),
            Color(red: 0.61, green: 0.15, blue: 0.69),
            Color(red: 1, green: 0.32, blue: 0.32),
            Color(red: 1, green: 0.60, blue: 0),
            Color(red: 0.30, green: 0.69, blue: 0.31),
            Color(red: 0.13, green: 0.59, blue: 0.95),
        ]
        let letters = Array("ultrathink")
        // 9pt glyphs centered at 1.5 lost their top third off the frame.
        let textY: CGFloat = 4.5
        let charW: CGFloat = 5.8
        let totalW = CGFloat(letters.count) * charW
        let startX = (ctx.size.width - totalW) / 2
        for (i, ch) in letters.enumerated() {
            let phase = (t + Double(i) * 0.1).truncatingRemainder(dividingBy: 1.0)
            let wave = sin(phase * .pi)
            let letterAlpha = 0.15 + wave * 0.85
            context.draw(
                Text(String(ch))
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundColor(rainbowColors[i].opacity(letterAlpha)),
                at: CGPoint(x: startX + CGFloat(i) * charW + charW / 2, y: textY)
            )
        }
    }

    private static func drawWorkingJuggling(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t
        let bounce = -abs(sin(t * 3.2)) * 0.5
        drawBaseCharacterStatic(ctx: ctx, context: &context, dx: 0, dy: bounce, eyeShift: 0, breathPhase: 0)

        // A circular toss needs ~5 sprite units of vertical travel; the headroom is 3,
        // so a third of the old orbit spent its time off-canvas and the balls appeared
        // to blink out of existence. A flattened arc keeps all three in frame for the
        // whole cycle while the horizontal sweep still carries the juggling read.
        let colors: [Color] = [.red, ctx.accentColor, .green]
        for index in 0..<3 {
            let phase = t * 2.4 + Double(index) * (2 * .pi / 3)
            let x = 7.0 + CGFloat(cos(phase)) * 4.5
            let y = 3.9 + CGFloat(sin(phase)) * 0.85
            context.fill(Path(ctx.r(x, y, 1.2, 1.2)), with: .color(colors[index]))
        }
    }

    private static func drawWorkingWizard(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t
        drawBaseCharacterStatic(ctx: ctx, context: &context, dx: 0, dy: 0, eyeShift: 0, breathPhase: CGFloat(sin(t * 2)) * 0.2)

        let hat = Color(red: 0.25, green: 0.19, blue: 0.55)
        // A full-height cone needs 5 sprite units but only 3 (12pt) exist above the
        // head, so the hat is a 3-step silhouette: it still reads as pointed instead
        // of losing its tip off the top edge.
        context.fill(Path(ctx.r(3, 5.2, 9, 0.8)), with: .color(hat))
        context.fill(Path(ctx.r(4.5, 4, 6, 1.2)), with: .color(hat))
        context.fill(Path(ctx.r(6.5, 3.1, 2, 0.9)), with: .color(hat))

        // The staff sits just outside the right arm (x 13...15) so it reads as a
        // separate prop rather than a stripe painted onto the sleeve.
        context.fill(Path(ctx.r(14, 6.5, 0.8, 5.5)), with: .color(.brown))
        let sparkle = 0.35 + 0.65 * abs(sin(t * 4))
        context.fill(Path(ctx.r(13.6, 5.2, 1.4, 1.4)), with: .color(ctx.accentColor.opacity(sparkle)))
    }

    private static func drawWorkingOverheated(ctx: DrawCtx, context: inout GraphicsContext) {
        drawError(ctx: ctx, context: &context)
        let pulse = 0.35 + abs(sin(ctx.t * 5)) * 0.45
        context.fill(Path(ctx.r(2, 11, 11, 3)), with: .color(.red.opacity(pulse * 0.18)))
    }

    private static func drawHappy(ctx: DrawCtx, context: inout GraphicsContext) {
        let bounce = -abs(sin(ctx.t * 5)) * 1.5
        drawBaseCharacterStatic(ctx: ctx, context: &context, dx: 0, dy: bounce, eyeShift: 0, breathPhase: 0)

        // Replace the open eyes with compact smiling eyes.
        context.fill(Path(ctx.r(3.5, 7.5, 2, 3, dy: bounce)), with: .color(ctx.bodyColor))
        context.fill(Path(ctx.r(9.5, 7.5, 2, 3, dy: bounce)), with: .color(ctx.bodyColor))
        context.fill(Path(ctx.r(3.5, 9, 2, 0.5, dy: bounce)), with: .color(ctx.eyeColor))
        context.fill(Path(ctx.r(9.5, 9, 2, 0.5, dy: bounce)), with: .color(ctx.eyeColor))
        context.fill(Path(ctx.r(7, 11, 1.5, 0.7, dy: bounce)), with: .color(ctx.eyeColor))

        let sparkle = 0.3 + abs(sin(ctx.t * 6)) * 0.7
        context.fill(Path(ctx.r(1, 5, 1, 1)), with: .color(ctx.accentColor.opacity(sparkle)))
        context.fill(Path(ctx.r(13, 4, 1, 1)), with: .color(ctx.accentColor.opacity(1 - sparkle * 0.5)))
    }

    private static func drawDisconnected(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, s = ctx.s
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let bodyT = (t / 6.0).truncatingRemainder(dividingBy: 1.0)
        let bodyShiftX: CGFloat = {
            if bodyT >= 0.12 && bodyT <= 0.22 { return -1 }
            if bodyT >= 0.29 && bodyT <= 0.39 { return 1 }
            if bodyT >= 0.56 && bodyT <= 0.88 { return 1 }
            return 0
        }()
        let eyeShift: CGFloat = {
            if bodyT >= 0.12 && bodyT <= 0.22 { return -2 }
            if bodyT >= 0.29 && bodyT <= 0.39 { return 2 }
            if bodyT >= 0.56 && bodyT <= 0.88 { return 3 }
            return 0
        }()

        let dx = bodyShiftX

        context.fill(Path(ctx.r(3, 15, 9, 0.5, dx: dx)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }

        context.fill(Path(ctx.r(2, 6, 11, 7, dx: dx)), with: .color(bodyColor))
        context.fill(Path(ctx.r(0, 9, 2, 2, dx: dx)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 9, 2, 2, dx: dx)), with: .color(bodyColor))

        let blinkT = (t / 6.0).truncatingRemainder(dividingBy: 1.0)
        let isBlinkNow = (blinkT > 0.20 && blinkT < 0.24) || (blinkT > 0.60 && blinkT < 0.64) || (blinkT > 0.80 && blinkT < 0.84)

        if ctx.eyesClosed || isBlinkNow {
            context.fill(Path(ctx.r(4 + eyeShift, 9, 1, 0.35, dx: dx)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 9, 1, 0.35, dx: dx)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4 + eyeShift, 8, 1, 2, dx: dx)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 8, 1, 2, dx: dx)), with: .color(eyeColor))
        }

        // Both marks live in the 12pt headroom, in absolute canvas coordinates: the
        // sprite-space originals (x -2 and x 16) fell outside the 60x64 canvas
        // entirely, so the "?" only grazed the left edge and the "!" was never
        // visible at all. White also disappeared against a light popover — the
        // question mark now uses a semantic color that adapts to the appearance.
        if bodyT < 0.50 {
            let qAlpha: Double = bodyT < 0.12 ? 0 : (bodyT < 0.46 ? 1 : (1.0 - (bodyT - 0.46) / 0.04))
            context.draw(
                Text("?")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundColor(.secondary.opacity(qAlpha)),
                at: CGPoint(x: (4 + dx) * s, y: 6)
            )
        }
        if bodyT >= 0.50 {
            let eAlpha: Double = bodyT < 0.56 ? 0 : (bodyT < 0.85 ? 1 : (1.0 - (bodyT - 0.85) / 0.10))
            context.draw(
                Text("!")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundColor(Color(red: 0, green: 0.51, blue: 0.99).opacity(eAlpha)),
                at: CGPoint(x: (11 + dx) * s, y: 6)
            )
        }
    }

    private static func drawError(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, s = ctx.s
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let breathPhase = sin(t / 2.5 * .pi * 2)
        let squashDy: CGFloat = 1.5 + breathPhase * 0.8

        context.fill(Path(ctx.r(-1, 15, 17, 0.5)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 9, 1, 1)), with: .color(bodyColor))
        }

        let tW: CGFloat = 13 + breathPhase * 0.5
        let tX: CGFloat = 1 + (13 - tW) / 2
        context.fill(Path(ctx.r(tX, 10, tW, 5, dy: squashDy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(-1, 13, 2, 2, dy: squashDy)), with: .color(bodyColor))

        let fanPhase = sin(t / 0.4 * .pi * 2)
        let fanArmY: CGFloat = 11 + fanPhase * 1.5
        context.fill(Path(ctx.r(13, fanArmY, 2, 2, dy: squashDy)), with: .color(bodyColor))

        let xColor = eyeColor
        for eyeX: CGFloat in [3, 10] {
            context.fill(Path(ctx.r(eyeX, 12, 2, 0.4, dy: squashDy)),
                         with: .color(xColor))
            context.fill(Path(ctx.r(eyeX + 0.8, 11.2, 0.4, 2, dy: squashDy)),
                         with: .color(xColor))
        }

        // The collapsed pose puts the torso at y 34-54pt, so the smoke and the label
        // have the whole upper half of the canvas. Both used to overshoot it: the
        // smoke rose to -48pt and the label was centered at -12pt, entirely above
        // the frame, only visible because Canvas doesn't clip.
        for i in 0..<3 {
            let smT = (t + Double(i) * 1.0).truncatingRemainder(dividingBy: 3.0) / 3.0
            let rise = smT * 5.5
            let alpha = smT < 0.2 ? smT * 3 : (smT > 0.6 ? (1.0 - smT) / 0.4 : 0.6)
            let smX: CGFloat = 5 + CGFloat(i) * 2 + sin(smT * .pi) * 2
            context.fill(Path(ctx.r(smX, 9 - CGFloat(rise), 2, 1)),
                         with: .color(.gray.opacity(alpha * 0.3)))
        }

        let flashAlpha = 0.15 + sin(t / 0.8 * .pi * 2) * 0.85
        context.draw(
            Text("ERROR")
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundColor(Color.red.opacity(max(0, flashAlpha))),
            at: CGPoint(x: 7.5 * s, y: 9)
        )
    }

    private static func drawMiniIdle(ctx: DrawCtx, context: inout GraphicsContext) {
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor
        context.fill(Path(ctx.r(3, 15, 9, 0.5)), with: .color(.black.opacity(0.12)))
        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }
        context.fill(Path(ctx.r(2, 6, 11, 7)), with: .color(bodyColor))
        context.fill(Path(ctx.r(0, 9, 2, 2)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 9, 2, 2)), with: .color(bodyColor))
        context.fill(Path(ctx.r(4, 8, 1, 2)), with: .color(eyeColor))
        context.fill(Path(ctx.r(10, 8, 1, 2)), with: .color(eyeColor))
    }

    private static func drawMiniPeek(ctx: DrawCtx, context: inout GraphicsContext) {
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor
        context.fill(Path(ctx.r(3, 15, 9, 0.5)), with: .color(.black.opacity(0.12)))
        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }
        context.fill(Path(ctx.r(2, 6, 11, 7)), with: .color(bodyColor))
        
        // Left arm is resting
        context.fill(Path(ctx.r(0, 9, 2, 2)), with: .color(bodyColor))
        
        // Right arm is waving
        let waveY = 8 + sin(ctx.t * 28.0) * 1.5
        context.fill(Path(ctx.r(13, waveY, 2, 2)), with: .color(bodyColor))
        
        context.fill(Path(ctx.r(4, 8, 1, 2)), with: .color(eyeColor))
        context.fill(Path(ctx.r(10, 8, 1, 2)), with: .color(eyeColor))
    }

    private static func drawMiniAlert(ctx: DrawCtx, context: inout GraphicsContext) {
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor
        context.fill(Path(ctx.r(3, 15, 9, 0.5)), with: .color(.black.opacity(0.12)))
        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }
        context.fill(Path(ctx.r(2, 6, 11, 7)), with: .color(bodyColor))
        context.fill(Path(ctx.r(0, 9, 2, 2)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 9, 2, 2)), with: .color(bodyColor))
        
        context.fill(Path(ctx.r(4, 9, 1.5, 0.4)), with: .color(eyeColor))
        context.fill(Path(ctx.r(9.5, 9, 1.5, 0.4)), with: .color(eyeColor))

        let flash = sin(ctx.t * 8.0) > 0
        if flash {
            // Kept inside the 12pt headroom — the stem used to start 4pt above it.
            context.fill(Path(ctx.r(7, 3.1, 1, 2)), with: .color(.red))
            context.fill(Path(ctx.r(7, 5.4, 1, 0.8)), with: .color(.red))
        }
    }

    private static func drawMiniHappy(ctx: DrawCtx, context: inout GraphicsContext) {
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor
        context.fill(Path(ctx.r(3, 15, 9, 0.5)), with: .color(.black.opacity(0.12)))
        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }
        context.fill(Path(ctx.r(2, 6, 11, 7)), with: .color(bodyColor))
        context.fill(Path(ctx.r(0, 9, 2, 2)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 9, 2, 2)), with: .color(bodyColor))
        context.fill(Path(ctx.r(3.5, 9, 1.5, 0.5)), with: .color(eyeColor))
        context.fill(Path(ctx.r(10, 9, 1.5, 0.5)), with: .color(eyeColor))

        let starAlpha = 0.5 + sin(ctx.t * 10.0) * 0.5
        context.fill(Path(ctx.r(9, 3, 1.2, 1.2)), with: .color(.yellow.opacity(starAlpha)))
    }

    private static func drawMiniSleep(ctx: DrawCtx, context: inout GraphicsContext) {
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor
        context.fill(Path(ctx.r(3, 15, 9, 0.5)), with: .color(.black.opacity(0.12)))
        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }
        context.fill(Path(ctx.r(2, 6, 11, 7)), with: .color(bodyColor))
        context.fill(Path(ctx.r(0, 9, 2, 2)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 9, 2, 2)), with: .color(bodyColor))
        context.fill(Path(ctx.r(4, 9, 1, 0.35)), with: .color(eyeColor))
        context.fill(Path(ctx.r(10, 9, 1, 0.35)), with: .color(eyeColor))

        let zT = ctx.t.truncatingRemainder(dividingBy: 4.0) / 4.0
        let alpha = zT < 0.15 ? zT * 6 : (zT > 0.85 ? (1.0 - zT) * 6 : 0.7)
        context.draw(
            Text("z")
                .font(.system(size: 7, weight: .bold, design: .monospaced))
                .foregroundColor(.secondary.opacity(alpha * 0.85)),
            at: CGPoint(x: (ctx.isRightEdgeMini ? 4 : 11) * ctx.s, y: 13 - CGFloat(zT) * 8)
        )
    }

    private static func drawYawning(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor
        let breathPhase = sin(t / 2.0 * .pi * 2)
        let dy: CGFloat = -1.0 + breathPhase * 0.5
        let dx = ctx.hoverLeanX

        context.fill(Path(ctx.r(3, 15, 9, 0.5, dx: dx)), with: .color(.black.opacity(0.12)))
        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }
        context.fill(Path(ctx.r(2, 6, 11, 7, dx: dx, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(0, 9, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 9, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(4, 9, 1.5, 0.4, dx: dx, dy: dy)), with: .color(eyeColor))
        context.fill(Path(ctx.r(10, 9, 1.5, 0.4, dx: dx, dy: dy)), with: .color(eyeColor))
        context.fill(Path(ctx.r(7, 10.5, 1.5, 1.5, dx: dx, dy: dy)), with: .color(eyeColor))
    }

    private static func drawWaking(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor
        let bouncePhase = sin(t * 20.0)
        let dy: CGFloat = bouncePhase * 0.8
        let dx = ctx.hoverLeanX + sin(t * 15.0) * 0.3

        context.fill(Path(ctx.r(3, 15, 9, 0.5, dx: dx)), with: .color(.black.opacity(0.12)))
        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }
        context.fill(Path(ctx.r(2, 5, 11, 8, dx: dx, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(0, 7, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 7, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(3.5, 8, 2, 2.5, dx: dx, dy: dy)), with: .color(eyeColor))
        context.fill(Path(ctx.r(9.5, 8, 2, 2.5, dx: dx, dy: dy)), with: .color(eyeColor))
        context.fill(Path(ctx.r(4, 8.5, 0.8, 0.8, dx: dx, dy: dy)), with: .color(.white))
        context.fill(Path(ctx.r(10, 8.5, 0.8, 0.8, dx: dx, dy: dy)), with: .color(.white))
    }

    // MARK: - State Resolution

    enum ClawdState: Equatable {
        case idleLiving
        case idleLook
        case idleDoze
        case sleeping
        case workingTyping
        case workingThinking
        case workingUltrathink
        case workingJuggling
        case workingWizard
        case workingOverheated
        case happy
        case disconnected
        case error
        case yawning
        case waking

        // Mini Mode
        case miniIdle
        case miniPeek
        case miniAlert
        case miniHappy
        case miniSleep
    }

    private var clawdState: ClawdState {
        // 0. Tap override (temporary animation) — explicit interaction wins.
        if let override = tapOverrideState { return override }

        // 1. Resolve raw state
        let rawState: ClawdState = {
            if !viewModel.serverOnline { return .disconnected }
            if viewModel.error != nil { return .error }
            if viewModel.isSyncing { return .workingTyping }
            if modelStatusText != nil { return .happy }
            if viewModel.isLoading { return .workingThinking }
            if viewModel.todayTokens == 0 { return .sleeping }
            return idleVariant
        }()

        // 1.5. Idle-timer sleep/wake override — but never mask an active
        //      working/error/disconnected state (the pet shouldn't doze mid-sync).
        let isBusy = rawState == .workingTyping || rawState == .happy ||
            rawState == .disconnected || rawState == .error
        if let sleepState = petState.sleepState, !isBusy {
            if petState.isTucked {
                if sleepState == .sleeping || sleepState == .yawning {
                    return .miniSleep
                }
                if sleepState == .waking {
                    return .miniPeek
                }
            }
            return sleepState
        }

        // 2. Mini mode redirection
        if petState.isTucked {
            if rawState == .disconnected || rawState == .error {
                return .miniAlert
            }
            if rawState == .happy {
                return .miniHappy
            }
            if petState.isHovered {
                return .miniPeek
            }
            if rawState == .sleeping {
                return .miniSleep
            }
            if rawState == .workingTyping || rawState == .workingThinking ||
                rawState == .workingUltrathink || rawState == .workingJuggling ||
                rawState == .workingWizard || rawState == .workingOverheated {
                return .miniPeek
            }
            return .miniIdle
        }

        return rawState
    }

    // MARK: - Drawing Helpers

    private var hoverLeanX: CGFloat {
        switch hoverSide {
        case .left: return -1.2
        case .right: return 1.2
        case .center, .none: return 0
        }
    }

    private var hoverEyeShift: CGFloat {
        switch hoverSide {
        case .left: return -0.5
        case .right: return 0.5
        case .center, .none: return 0
        }
    }

    /// Standard base character drawing with offset (used by simpler states like idleLook).
    private static func drawBaseCharacterStatic(
        ctx: DrawCtx, context: inout GraphicsContext,
        dx: CGFloat, dy: CGFloat,
        eyeShift: CGFloat, breathPhase: CGFloat
    ) {
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        context.fill(Path(ctx.r(3, 15, 9, 0.5, dx: dx, dy: dy)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3, dx: dx, dy: dy)), with: .color(bodyColor))
        }

        let tScaleX: CGFloat = 1.0 + breathPhase * 0.015
        let tW = 11 * tScaleX, tH: CGFloat = 7
        let tX = 2 + (11 - tW) / 2
        context.fill(Path(ctx.r(tX, 6, tW, tH, dx: dx, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(0, 9, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 9, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        if ctx.eyesClosed {
            context.fill(Path(ctx.r(4 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
        }

        if ctx.hoveringCharacter {
            context.fill(Path(ctx.r(tX, 6, tW, tH, dx: dx, dy: dy)), with: .color(.white.opacity(0.06)))
        }
    }

    // MARK: - Quip Pool

    private var showsFloatingUsageBreakdown: Bool {
        layout == .floating
            && hoveringCharacter
            && viewModel.serverOnline
            && !viewModel.isSyncing
            && modelStatusText == nil
            && (viewModel.todayTokens > 0 || !activePetLimits.isEmpty)
    }

    /// Bubble text. In the floating desktop pet, hovering the sprite reveals the
    /// precise today figure plus every active provider limit. The structured
    /// bubble uses the same rows; this text remains its accessible/fallback label.
    private var bubbleText: String {
        if let statusText = modelStatusText {
            return statusText
        }
        if layout == .floating, hoveringCharacter, viewModel.serverOnline, !viewModel.isSyncing {
            let usage = viewModel.todayTokens > 0
                ? Strings.tokensSpentToday(
                    tokens: TokenFormatter.formatCompact(viewModel.todayTokens),
                    cost: viewModel.todayCost
                )
                : nil
            let limits = petLimitSummaries
            if !limits.isEmpty {
                return [usage, limits.joined(separator: "\n")].compactMap { $0 }.joined(separator: "\n")
            }
            if let usage { return usage }
        }
        return currentQuip
    }

    private struct PetLimitReading {
        let provider: String
        let window: String
        let usedPercent: Double
        let resetAt: Date?
        /// A share of another window. Remaining mode must not redraw it as 100 − used.
        var share: Bool = false
    }

    private enum PetLimitTone {
        case good, warning, danger

        var color: Color {
            switch self {
            case .good: return .mint
            case .warning: return .yellow
            case .danger: return .red
            }
        }
    }

    private struct PetLimitDisplay {
        let value: Double
        let label: String
        let tone: PetLimitTone
        let resetText: String?
    }

    /// Keep the tooltip useful by surfacing every visible window that is in use
    /// but not full. Zero-use and already-full windows stay in the full Limits view.
    private var activePetLimits: [PetLimitReading] {
        guard let limits = viewModel.usageLimits else { return [] }
        let hidden = limitsStore.hiddenProviders
        var readings: [PetLimitReading] = []

        func providerName(_ id: String) -> String {
            LimitsSettingsStore.displayNames[id] ?? id.capitalized
        }

        func add(_ id: String, _ label: String, _ used: Double, _ resetAt: Date?, share: Bool = false) {
            guard !hidden.contains(id), used.isFinite else { return }
            readings.append(PetLimitReading(
                provider: providerName(id),
                window: label,
                usedPercent: min(max(used, 0), 100),
                resetAt: resetAt,
                share: share
            ))
        }

        func isoDate(_ value: String?) -> Date? {
            guard let value else { return nil }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.date(from: value) ?? {
                formatter.formatOptions = [.withInternetDateTime]
                return formatter.date(from: value)
            }()
        }

        func generic(_ id: String, configured: Bool, error: String?, windows: [(String, GenericLimitWindow?)]) {
            guard configured, error == nil else { return }
            for (label, window) in windows {
                if let window {
                    add(id, label, window.usedPercent, isoDate(window.resetAt))
                }
            }
        }

        let claude = limits.claude
        if claude.configured, claude.error == nil {
            if let window = claude.fiveHour { add("claude", "5h", window.utilization, isoDate(window.resetsAt)) }
            if let window = claude.sevenDay { add("claude", "7d", window.utilization, isoDate(window.resetsAt)) }
            if let window = claude.sevenDayOpus { add("claude", "Opus", window.utilization, isoDate(window.resetsAt)) }
            for window in claude.weeklyScoped ?? [] {
                add("claude", window.label, window.utilization, isoDate(window.resetsAt))
            }
        }

        let codex = limits.codex
        if codex.configured, codex.error == nil {
            if let window = codex.primaryWindow { add("codex", "5h", Double(window.usedPercent), epochDate(window.resetAt)) }
            if let window = codex.secondaryWindow { add("codex", "7d", Double(window.usedPercent), epochDate(window.resetAt)) }
            if let window = codex.creditWindow { add("codex", Strings.codexCreditsLabel, window.usedPercent, epochDate(window.resetAt)) }
            if let window = codex.sparkPrimaryWindow { add("codex", "Spark 5h", Double(window.usedPercent), epochDate(window.resetAt)) }
            if let window = codex.sparkSecondaryWindow { add("codex", "Spark 7d", Double(window.usedPercent), epochDate(window.resetAt)) }
        }

        generic("cursor", configured: limits.cursor.configured, error: limits.cursor.error, windows: [
            (Strings.cursorPlanLabel, limits.cursor.primaryWindow), (Strings.cursorAutoLabel, limits.cursor.secondaryWindow), ("API", limits.cursor.tertiaryWindow), (Strings.cursorGrokBotLabel, limits.cursor.quaternaryWindow)
        ])
        generic("gemini", configured: limits.gemini.configured, error: limits.gemini.error, windows: [
            ("Pro", limits.gemini.primaryWindow), ("Flash", limits.gemini.secondaryWindow), ("Lite", limits.gemini.tertiaryWindow)
        ])
        if let kimi = limits.kimi {
            generic("kimi", configured: kimi.configured, error: kimi.error, windows: [
                (Strings.kimiWeeklyLabel, kimi.primaryWindow), (Strings.kimiFiveHourLabel, kimi.secondaryWindow), (Strings.kimiTotalLabel, kimi.tertiaryWindow)
            ])
        }
        generic("kiro", configured: limits.kiro.configured, error: limits.kiro.error, windows: [
            (Strings.kiroMonthLabel, limits.kiro.primaryWindow), (Strings.kiroBonusLabel, limits.kiro.secondaryWindow)
        ])
        if let grok = limits.grok {
            generic("grok", configured: grok.configured, error: grok.error, windows: [
                (Strings.grokPrimaryLabel(periodType: grok.periodType), grok.primaryWindow),
                (Strings.grokOndemandLabel, grok.secondaryWindow),
            ])
            if grok.configured, grok.error == nil {
                for entry in grok.products ?? [] {
                    guard let product = entry.product, !product.isEmpty, let window = entry.window else { continue }
                    let label = Strings.grokProductLabel(product: product, fallback: entry.label)
                    guard !label.isEmpty else { continue }
                    add("grok", label, window.usedPercent, isoDate(window.resetAt), share: true)
                }
            }
        }
        if let copilot = limits.copilot {
            generic("copilot", configured: copilot.configured, error: copilot.error, windows: [
                ("Premium", copilot.primaryWindow), ("Chat", copilot.secondaryWindow)
            ])
        }
        generic("antigravity", configured: limits.antigravity.configured, error: limits.antigravity.error, windows: [
            ("Claude weekly", limits.antigravity.primaryWindow), ("Claude 5h", limits.antigravity.secondaryWindow),
            ("Gemini weekly", limits.antigravity.tertiaryWindow), ("Gemini 5h", limits.antigravity.quaternaryWindow)
        ])
        if let zcode = limits.zcode {
            generic("zcode", configured: zcode.configured, error: zcode.error, windows: [
                ("GLM-5.2", zcode.primaryWindow), ("GLM-5 Turbo", zcode.secondaryWindow), ("Other", zcode.tertiaryWindow)
            ])
        }
        if let opencodeGo = limits.opencodeGo {
            generic("opencodeGo", configured: opencodeGo.configured, error: opencodeGo.error, windows: [
                ("5h", opencodeGo.primaryWindow), ("Weekly", opencodeGo.secondaryWindow), ("Month", opencodeGo.tertiaryWindow)
            ])
        }
        if let commandCode = limits.commandCode {
            generic("commandCode", configured: commandCode.configured, error: commandCode.error, windows: [
                ("5h", commandCode.primaryWindow), ("Weekly", commandCode.secondaryWindow)
            ])
        }
        if let qoder = limits.qoder {
            // Empty 0/0 buckets (no active plan / no add-on pack) show no
            // quota — keep this card in step with the popover, which drops
            // them too. Windows without credit fields are kept.
            generic("qoder", configured: qoder.configured, error: qoder.error, windows: [
                ("Credits", qoder.primaryWindow),
                ("Add-on", qoder.tertiaryWindow),
                ("Ultimate Free Calls", qoder.secondaryWindow)
            ].filter { $1?.limitCredits != 0 })
        }
        if let devin = limits.devin {
            generic("devin", configured: devin.configured, error: devin.error, windows: [
                ("Daily", devin.primaryWindow), ("Weekly", devin.secondaryWindow)
            ])
        }

        return readings
            .filter { $0.usedPercent > 0 && $0.usedPercent < 100 }
            .sorted {
                if $0.usedPercent != $1.usedPercent { return $0.usedPercent > $1.usedPercent }
                return ($0.resetAt ?? .distantFuture) < ($1.resetAt ?? .distantFuture)
            }
    }

    private func epochDate(_ epoch: Int?) -> Date? {
        epoch.map { Date(timeIntervalSince1970: TimeInterval($0)) }
    }

    private func petLimitDisplay(for reading: PetLimitReading) -> PetLimitDisplay {
        let isRemaining = limitsStore.displayMode == .remaining && !reading.share
        let value = isRemaining ? 100 - reading.usedPercent : reading.usedPercent
        let label: String
        let tone: PetLimitTone

        if isRemaining {
            if value <= 0 {
                label = Strings.petLimitDepleted
                tone = .danger
            } else if value <= 20 {
                label = Strings.petLimitLow
                tone = .warning
            } else if value <= 50 {
                label = Strings.petLimitSomeLeft
                tone = .warning
            } else {
                label = Strings.petLimitAvailable
                tone = .good
            }
        } else if value >= 100 {
            label = Strings.petLimitAtLimit
            tone = .danger
        } else if value >= 80 {
            label = Strings.petLimitNearLimit
            tone = .warning
        } else if value >= 50 {
            label = Strings.petLimitWatch
            tone = .warning
        } else {
            label = Strings.petLimitAvailable
            tone = .good
        }

        let resetText = petLimitResetText(reading.resetAt)
        return PetLimitDisplay(value: value, label: label, tone: tone, resetText: resetText)
    }

    private func petLimitSummary(for reading: PetLimitReading) -> String {
        let display = petLimitDisplay(for: reading)
        let reset = display.resetText.map { " · \(Strings.petLimitReset($0))" } ?? ""
        return "\(reading.provider) \(reading.window) · \(display.label)\(reset)"
    }

    private var petLimitSummary: String? {
        activePetLimits.first.map { petLimitSummary(for: $0) }
    }

    private var petLimitSummaries: [String] {
        activePetLimits.map { petLimitSummary(for: $0) }
    }

    private func petLimitResetText(_ date: Date?) -> String? {
        guard let date else { return nil }
        let seconds = date.timeIntervalSinceNow
        if seconds <= 0 { return Strings.limitResetNow }
        let whole = Int(seconds)
        if whole >= 86_400 { return "\(whole / 86_400)d" }
        if whole >= 3_600 { return "\(whole / 3_600)h" }
        return "\(max(1, whole / 60))m"
    }

    private var currentQuip: String {
        let pool = quipPool
        guard !pool.isEmpty else { return "" }
        return pool[quipIndex % pool.count]
    }

    private var quipPool: [String] {
        let tokens = viewModel.todayTokens
        let cost = viewModel.todayCost
        let f = TokenFormatter.formatCompact(tokens)

        if viewModel.isSyncing {
            return Strings.syncingQuips
        }

        var pool: [String] = []

        // === Today data ===
        if tokens == 0 {
            pool += Strings.emptyTodayQuips
        } else {
            pool.append(Strings.tokensToday(f))
            if cost != "$0.00" && cost != "$0" {
                pool += [
                    Strings.tokensSpentToday(tokens: f, cost: cost),
                    Strings.aiInvestedToday(cost),
                    Strings.billToday(cost: cost, tokens: f),
                    Strings.aiTabToday(cost),
                ]
            }
            if tokens < 50_000 {
                pool += Strings.warmupQuips
            } else if tokens < 200_000 {
                pool += Strings.flowQuips
            } else if tokens < 500_000 {
                pool += Strings.busyQuips
            } else if tokens < 2_000_000 {
                pool += Strings.heavyQuips
            } else {
                pool += Strings.massiveQuips
            }
        }

        pool += petLimitSummaries

        // === 7-Day / 30-Day rolling stats ===
        let w7 = viewModel.last7dTokens
        let d7 = viewModel.last7dActiveDays
        let m30 = viewModel.last30dTokens
        let avg = viewModel.last30dAvgPerDay

        if w7 > 0 {
            pool.append(Strings.sevenDayTotal(TokenFormatter.formatCompact(w7)))
            if d7 > 0 {
                pool.append("🗓️ \(Strings.activeDaysThisWeek(d7))")
                if d7 >= 7 {
                    pool.append(Strings.perfectStreak)
                }
            }
        }
        if m30 > 0 {
            pool.append(Strings.thirtyDayTotal(TokenFormatter.formatCompact(m30)))
            if avg > 0 {
                pool.append(Strings.averagingPerDay(TokenFormatter.formatCompact(avg)))
            }
        }

        // === Heatmap stats (streak, total active days) ===
        if let heatmap = viewModel.heatmap {
            let streak = heatmap.streakDays
            let totalActive = heatmap.activeDays
            if streak > 1 {
                pool.append(Strings.streakDays(streak))
            }
            if totalActive > 30 {
                pool.append(Strings.activeDaysAllTime(totalActive))
            }
        }

        // === Top model insights ===
        let models = viewModel.topModels
        if let top = models.first {
            pool.append(Strings.topModel(top.name, top.percent))
            if models.count >= 2 {
                pool.append(Strings.runnerUp(models[1].name, models[1].percent))
            }
            if models.count >= 3 {
                pool.append(Strings.modelCount(models.count))
            }
            // Source variety
            let sources = Set(models.map { $0.source })
            if sources.count >= 2 {
                let names = sources.map { $0.capitalized }.sorted().joined(separator: " + ")
                pool.append(Strings.multiToolSetup(names))
            }
        }

        // === Conversation count ===
        let convos = viewModel.todaySummary?.totals.conversationCount ?? 0
        if convos > 0 {
            pool.append(Strings.conversationsToday(convos))
            if convos >= 10 {
                pool.append(Strings.busyTalker(convos))
            }
        }

        // === Personality (always) ===
        pool += Strings.personalityQuips

        return pool
    }

    // MARK: - Tap (cycles through fun animation states)

    /// All the fun states to show temporarily on tap
    private static let tapAnimations: [ClawdState] = [
        .happy,             // 用量增长后的庆祝
        .workingWizard,     // 连续活跃
        .workingJuggling,   // 多模型并行
        .workingThinking,   // 加载/思考
        .workingUltrathink,  // 超级思考 (震颤+火花+彩虹)
        .workingTyping,      // 打字 (抖动+数据粒子)
        .disconnected,       // 找东西 (问号/感叹号)
        .idleLook,           // 四处张望
        .idleDoze,           // 打瞌睡
        .sleeping,           // 睡觉 (Zzz)
        .error,              // 错误 (趴下+冒烟)
    ]

    @State private var tapAnimIndex = 0

    private func handleTap() {
        withAnimation(.easeInOut(duration: 0.25)) { quipIndex += 1 }

        // Physical reaction (jump/wiggle/flip via ActionModifier)
        let physicalActions: [CharacterAction] = [.jump, .wiggle, .flip, .multiBlink, .wave]
        let action = physicalActions.randomElement() ?? .jump
        currentAction = action

        switch action {
        case .wave:
            armWave = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { armWave = false }
        case .multiBlink:
            Task { @MainActor in
                for _ in 0..<3 {
                    eyesClosed = true
                    try? await Task.sleep(nanoseconds: 80_000_000)
                    eyesClosed = false
                    try? await Task.sleep(nanoseconds: 80_000_000)
                }
            }
        default: break
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if currentAction == action { currentAction = .none }
        }

        // Canvas state override: cycle through all animation states
        let anim = Self.tapAnimations[tapAnimIndex % Self.tapAnimations.count]
        tapAnimIndex += 1
        tapOverrideState = anim

        // Hold the animation for 2.5s then return to normal
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            if tapOverrideState == anim { tapOverrideState = nil }
        }
    }

    /// Floating pet tap: the standard reaction, plus a temporary quip bubble (since the
    /// floating bubble is hidden until hover). Hover still shows the precise data instead.
    private func handleFloatingTap() {
        handleTap()
        floatingBubbleTask?.cancel()
        floatingBubbleShown = true
        floatingBubbleTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if !Task.isCancelled { floatingBubbleShown = false }
        }
    }

    // MARK: - Idle Variant Rotation

    /// Periodically switches between idle animations for visual variety
    private func startIdleVariantLoop() {
        guard idleVariantTask == nil else { return }
        idleVariantTask = Task { @MainActor in
            while !Task.isCancelled {
                let delay = Double.random(in: 12...25)
                do {
                    try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                } catch {
                    break
                }
                guard !Task.isCancelled else { break }

                var variants: [ClawdState] = [.idleLiving, .idleLook, .idleLiving, .idleLiving]
                let tokens = viewModel.todayTokens
                if tokens >= 200_000 { variants.append(.workingThinking) }
                if tokens >= 500_000 { variants.append(.workingJuggling) }
                // .workingOverheated is deliberately excluded: it draws the error visuals
                // (X-eyes + red pulse), which must stay reserved for a real error state.
                if tokens >= 2_000_000 { variants.append(.workingUltrathink) }
                if viewModel.topModels.count >= 3 { variants.append(.workingJuggling) }
                if (viewModel.heatmap?.streakDays ?? 0) >= 7 { variants.append(.workingWizard) }
                idleVariant = variants.randomElement() ?? .idleLiving
            }
        }
    }

    // MARK: - Idle Blink

    private func startBlinkLoop() {
        guard blinkTask == nil else { return }
        blinkTask = Task { @MainActor in
            while !Task.isCancelled {
                let delay = Double.random(in: 2.5...5.0)
                do {
                    try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                } catch {
                    break
                }
                guard !Task.isCancelled else { break }
                guard clawdState != .sleeping && clawdState != .idleDoze else { continue }

                eyesClosed = true
                do {
                    try await Task.sleep(nanoseconds: 120_000_000)
                } catch {
                    eyesClosed = false
                    break
                }
                eyesClosed = false
            }
        }
    }

    private func updateDiscreteAnimationLoops(isVisible: Bool) {
        if isVisible {
            startBlinkLoop()
            startIdleVariantLoop()
        } else {
            stopDiscreteAnimationLoops()
        }
    }

    private func stopDiscreteAnimationLoops() {
        blinkTask?.cancel()
        blinkTask = nil
        idleVariantTask?.cancel()
        idleVariantTask = nil
        eyesClosed = false
    }

    // MARK: - Types

    private enum HoverSide { case left, center, right, none }
    enum CharacterAction: Equatable { case none, jump, wiggle, flip, multiBlink, wave }
}

// MARK: - Action Modifier

private struct ActionModifier: ViewModifier {
    let action: ClawdCompanionView.CharacterAction
    @State private var offset: CGFloat = 0
    @State private var rotation: Double = 0
    @State private var scaleX: CGFloat = 1

    func body(content: Content) -> some View {
        content
            .offset(y: offset)
            .rotationEffect(.degrees(rotation))
            .scaleEffect(x: scaleX, y: 1)
            .onChange(of: action) { a in
                switch a {
                case .jump:
                    withAnimation(.interpolatingSpring(stiffness: 500, damping: 12)) { offset = -10 }
                    after(0.15) { withAnimation(.interpolatingSpring(stiffness: 500, damping: 12)) { offset = 0 } }
                case .wiggle:
                    withAnimation(.easeInOut(duration: 0.07).repeatCount(6, autoreverses: true)) { rotation = 6 }
                    after(0.45) { withAnimation(.easeOut(duration: 0.1)) { rotation = 0 } }
                case .flip:
                    withAnimation(.easeInOut(duration: 0.2)) { scaleX = -1 }
                    after(0.35) { withAnimation(.easeInOut(duration: 0.2)) { scaleX = 1 } }
                default: break
                }
            }
    }

    private func after(_ t: Double, _ block: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + t, execute: block)
    }
}

// MARK: - Bubble Shape

private struct BubbleShape: Shape {
    /// Which side the little tail points toward. `.left` for the dashboard header
    /// (bubble sits to the right of Clawd); `.down` for the floating pet (bubble sits
    /// above Clawd, so the tail points down at the sprite).
    enum Direction { case left, down }
    var direction: Direction = .left

    func path(in rect: CGRect) -> Path {
        let tail: CGFloat = 6
        var p = Path()
        switch direction {
        case .left:
            let tailY = rect.midY
            let body = CGRect(x: tail, y: 0, width: rect.width - tail, height: rect.height)
            let r = min(18, min(body.width, body.height) / 2)
            p.addRoundedRect(in: body, cornerSize: CGSize(width: r, height: r))
            p.move(to: CGPoint(x: tail, y: tailY - 4))
            p.addLine(to: CGPoint(x: 0, y: tailY))
            p.addLine(to: CGPoint(x: tail, y: tailY + 4))
        case .down:
            let tailX = rect.midX
            let body = CGRect(x: 0, y: 0, width: rect.width, height: rect.height - tail)
            let r = min(18, min(body.width, body.height) / 2)
            p.addRoundedRect(in: body, cornerSize: CGSize(width: r, height: r))
            p.move(to: CGPoint(x: tailX - 4, y: rect.height - tail))
            p.addLine(to: CGPoint(x: tailX, y: rect.height))
            p.addLine(to: CGPoint(x: tailX + 4, y: rect.height - tail))
        }
        p.closeSubpath()
        return p
    }
}

/// Applies glass to the bubble content itself. On macOS 26 the native SwiftUI
/// modifier owns both foreground treatment and glass geometry; older systems use a
/// shape-backed material without crossing the SwiftUI/AppKit rendering boundary.
private struct PetBubbleSurface: ViewModifier {
    let isFloating: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isFloating {
            if #available(macOS 26, *) {
                content
                    .glassEffect(
                        .regular,
                        in: BubbleShape(direction: .down)
                    )
                    .overlay {
                        BubbleShape(direction: .down)
                            .stroke(.white.opacity(0.18), lineWidth: 0.6)
                    }
                    .shadow(color: .black.opacity(0.16), radius: 4, y: 1)
            } else {
                content
                    .background {
                        BubbleShape(direction: .down)
                            .fill(.regularMaterial)
                    }
                    .overlay {
                        BubbleShape(direction: .down)
                            .stroke(.white.opacity(0.18), lineWidth: 0.6)
                    }
                    .shadow(color: .black.opacity(0.16), radius: 4, y: 1)
            }
        } else {
            content
                .background {
                    BubbleShape(direction: .left)
                        .fill(.regularMaterial)
                        .overlay {
                            BubbleShape(direction: .left)
                                .stroke(.white.opacity(0.12), lineWidth: 0.5)
                        }
                        .shadow(color: .black.opacity(0.08), radius: 1.5, y: 0.5)
                }
        }
    }
}

/// Carries the bubble's unconstrained height out of its fixed-bottom layout slot.
private struct FloatingBubbleHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// MARK: - Continuous Hover Modifier (macOS 14+)

private struct ClawdHoverModifier: ViewModifier {
    @Binding var hoveringCharacter: Bool
    var onActive: (CGPoint) -> Void
    var onEnded: () -> Void

    func body(content: Content) -> some View {
        // Dashboard popover: continuous hover so Clawd leans toward the cursor.
        // (The floating pet does NOT use this modifier — it uses a plain discrete
        // .onHover — because onContinuousHover's per-frame `.active` flickered the pet's
        // hover-gated bubble under the 15fps redraw.)
        if #available(macOS 14, *) {
            content.onContinuousHover { phase in
                switch phase {
                case .active(let loc):
                    if !hoveringCharacter { NSCursor.pointingHand.push() }
                    hoveringCharacter = true
                    onActive(loc)
                case .ended:
                    if hoveringCharacter { NSCursor.pop() }
                    hoveringCharacter = false
                    onEnded()
                }
            }
        } else {
            content
        }
    }
}

/// Direction-only continuous hover used by V2 atlas pets. It deliberately does not
/// mutate the bubble's hover state, so the floating window keeps its stable discrete
/// enter/leave behavior while the sprite can still choose all 16 look cells.
private struct PetLookHoverModifier: ViewModifier {
    let enabled: Bool
    var onActive: (CGPoint) -> Void
    var onEnded: () -> Void

    func body(content: Content) -> some View {
        if enabled, #available(macOS 14, *) {
            content.onContinuousHover { phase in
                switch phase {
                case .active(let location): onActive(location)
                case .ended: onEnded()
                }
            }
        } else {
            content
        }
    }
}

extension ClawdCompanionView.ClawdState {
    /// The web vocabulary for this state, as used by `dashboard/src/lib/bot-appearance.js`.
    ///
    /// The two sides genuinely have different vocabularies — a Swift enum here, string
    /// state names there — so this bridge is unavoidable. `test/bot-parity.test.js`
    /// asserts every name below is one the web mapping actually knows.
    var petStateName: String {
        switch self {
        case .idleLiving: return "idle-living"
        case .idleLook: return "idle-look"
        case .idleDoze: return "idle-doze"
        case .sleeping: return "sleeping"
        case .workingTyping: return "working-typing"
        case .workingThinking: return "working-thinking"
        case .workingUltrathink: return "working-ultrathink"
        case .workingJuggling: return "working-juggling"
        case .workingWizard: return "working-wizard"
        case .workingOverheated: return "working-overheated"
        case .happy: return "happy"
        case .disconnected: return "disconnected"
        case .error: return "error"
        case .yawning: return "idle-yawn"
        case .waking: return "waking"
        case .miniIdle: return "mini-idle"
        case .miniPeek: return "mini-peek"
        case .miniAlert: return "mini-alert"
        case .miniHappy: return "mini-happy"
        case .miniSleep: return "mini-sleep"
        }
    }
}
