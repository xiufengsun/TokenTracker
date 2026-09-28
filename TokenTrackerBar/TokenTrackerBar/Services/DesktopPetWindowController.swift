import AppKit
import SwiftUI

/// A transparent, always-on-top, non-activating floating window that hosts the Clawd
/// companion as a desktop pet — the macOS counterpart of the Windows pet window
/// (PR #128). Where Windows had to host a WebView (no native Clawd renderer in .NET),
/// macOS hosts the native SwiftUI `ClawdCompanionView` directly and shares the app's
/// single `DashboardViewModel`, so the pet never polls independently and never drifts
/// from the menu bar.
@MainActor
final class DesktopPetWindowController: NSObject, NSWindowDelegate {
    /// Persists whether the user had the pet showing, so it returns on next launch.
    static let showDefaultsKey = "DesktopPetShow"
    private static let frameAutosaveName = "DesktopPetWindow"
    private static let sizeDefaultsKey = "DesktopPetSize"
    // Wide enough to fully contain the longest data bubble (e.g. "309.8M tokens —
    // $197.41 spent today"); the window is transparent so the extra width is invisible —
    // it just lets the centered bubble render without hitting the window edge (which
    // caused clipping → drift/flicker). The sprite stays centered in this width.
    // Width is fixed across all sizes (only the sprite scale + panel height change), so
    // the sprite always sits at the panel's horizontal center regardless of preset
    // (see PetSizePreset.panelWidth).
    /// Minimum on-screen width before the bubble is allowed. Below this — dragging the
    /// pet off the side, or tucked at an edge — the bubble is hidden so it never tries
    /// to render in a clipped width and flicker.
    private static let bubbleMinWidth: CGFloat = 300
    /// How much of the *sprite* peeks out when tucked against an edge.
    // Keep enough of the sprite's fixed artboard on-screen to leave a reliable
    // visual + hover handle. Thirty points could land entirely in transparent
    // artboard padding for the small preset or a sparse animation frame.
    private static let edgePeek: CGFloat = 48
    /// A drag that ends within this distance of the left/right edge tucks the pet away.
    private static let snapMargin: CGFloat = 24

    /// Current size preset (persisted). Drives sprite scale, panel height, and the
    /// sprite-derived edge-tuck geometry below.
    private var sizePreset: PetSizePreset = .medium

    /// Panel size for the current preset — width fixed, height grows with scale so a
    /// larger sprite isn't clipped at the panel's top/bottom.
    private var petSize: NSSize {
        NSSize(
            width: PetSizePreset.panelWidth,
            height: sizePreset.panelHeight + uiState.bubbleHeight - PetWindowState.minimumBubbleHeight
        )
    }
    /// The sprite is horizontally centered in the (wider) panel; this mirrors
    /// ClawdCompanionView's floating layout — sprite = 15 * px(4) * scale — so tucking
    /// exposes the *sprite*, not the panel's transparent margin.
    private var spriteWidth: CGFloat { 60 * sizePreset.scale }
    private var spriteLeftInset: CGFloat { (PetSizePreset.panelWidth - spriteWidth) / 2 }

    private enum Edge { case left, right }

    private let viewModel: DashboardViewModel
    private var panel: NSPanel?
    private var downMonitor: Any?
    private var dragMonitor: Any?
    private var upMonitor: Any?
    /// Mouse and window origin captured on mouse-down, so a drag can be replayed
    /// as an absolute offset instead of accumulating per-event deltas.
    private var dragAnchor: (mouse: NSPoint, window: NSPoint)?
    /// nil → freely placed; otherwise the edge the pet is tucked against.
    private var hiddenEdge: Edge?
    private var isRevealed = false
    private var didDrag = false
    private var sleepTimer: Timer? = nil
    private var lookTimer: Timer? = nil
    /// Drives whether the floating bubble may show (enough of the pet is on-screen).
    let uiState = PetWindowState()

    init(viewModel: DashboardViewModel) {
        self.viewModel = viewModel
        if let raw = UserDefaults.standard.string(forKey: Self.sizeDefaultsKey),
           let saved = PetSizePreset(rawValue: raw) {
            sizePreset = saved
        }
        super.init()
        uiState.floatingScale = sizePreset.scale
    }

    var isVisible: Bool { panel?.isVisible ?? false }

    func toggle() {
        if isVisible { hide() } else { show() }
    }

    func show() {
        let panel = panel ?? makePanel()
        self.panel = panel
        uiState.isWindowVisible = true
        panel.orderFrontRegardless()
        if hiddenEdge != nil {
            applyEdgeFrame(animated: false)
        }
        startLookTracking()
        UserDefaults.standard.set(true, forKey: Self.showDefaultsKey)
        keepActive()
        NativeBridge.shared.pushPetSettings()
    }

    func hide() {
        lookTimer?.invalidate()
        lookTimer = nil
        uiState.lookDirectionIndex = nil
        uiState.isDragging = false
        panel?.orderOut(nil)
        uiState.isWindowVisible = false
        UserDefaults.standard.set(false, forKey: Self.showDefaultsKey)
        sleepTimer?.invalidate()
        sleepTimer = nil
        NativeBridge.shared.pushPetSettings()
    }

    /// Re-show the pet on launch if it was visible when the app last quit.
    func restoreIfNeeded() {
        if UserDefaults.standard.bool(forKey: Self.showDefaultsKey) { show() }
    }

    private func isFrameOnScreen(_ frame: NSRect) -> Bool {
        let spriteFrame = NSRect(
            x: frame.origin.x + spriteLeftInset,
            y: frame.origin.y,
            width: spriteWidth,
            height: frame.size.height
        )
        for screen in NSScreen.screens {
            if screen.visibleFrame.intersects(spriteFrame) {
                return true
            }
        }
        return false
    }

    private func makePanel() -> NSPanel {
        let size = petSize
        // Use a hosting *controller* (not a bare NSHostingView as contentView): on a
        // borderless panel the latter routes SwiftUI's per-frame invalidations into
        // -[NSWindow _postWindowNeedsUpdateConstraints], which throws and crashes. A
        // fixed-frame root keeps sizing deterministic so no constraint cycle runs.
        let hostingController = NSHostingController(
            rootView: DesktopPetHost(
                petState: uiState,
                content: ClawdCompanionView(
                    viewModel: viewModel,
                    layout: .floating,
                    onRequestDashboard: { DashboardPresentationCoordinator.shared.showDashboard() },
                    onClosePet: { [weak self] in self?.hide() },
                    onHoverChanged: { [weak self] hovering in self?.handleHover(hovering) },
                    onKeepActive: { [weak self] in self?.keepActive() },
                    onSetSize: { [weak self] preset in self?.setSize(preset) },
                    onSetCharacter: { [weak self] character in self?.setCharacter(character) },
                    onBubbleHeightChanged: { [weak self] height in
                        self?.applyBubbleContentHeight(height)
                    },
                    petState: uiState
                )
            )
        )

        let panel = PetPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.contentViewController = hostingController
        // Transparent: only Clawd's opaque pixels (and the bubble material) show.
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        // Float above normal windows, ride along to every Space / full-screen app,
        // and stay out of Cmd-Tab cycling. Never activate the app on click.
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        // The pet moves itself (see installDragMonitors). AppKit's own background
        // dragging is off because it never fires here: the SwiftUI hosting view
        // consumes the mouse-down before AppKit can claim it, which on macOS 27
        // left the pet completely immovable (#634). Leaving both enabled would
        // double every drag on the systems where AppKit still cooperates.
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.acceptsMouseMovedEvents = true

        // Restore the last drag position, or park near the bottom-right on first run.
        panel.setFrameAutosaveName(Self.frameAutosaveName)
        var restored = false
        if panel.setFrameUsingName(Self.frameAutosaveName) {
            if isFrameOnScreen(panel.frame) {
                restored = true
            }
        }
        if restored {
            // Keep only the restored ORIGIN — the saved size may be from a different
            // preset (or an older build), so force the current preset's size. NSWindow
            // origin is bottom-left, so a taller preset grows upward in place.
            var f = panel.frame
            f.size = size
            panel.setFrame(f, display: false)
        } else if let screen = NSScreen.main {
            let area = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: area.maxX - size.width - 40, y: area.minY + 60))
        }
        self.panel = panel
        panel.delegate = self
        // If the saved frame had it tucked against an edge, restore that tucked state
        // (so a hover still slides it out).
        detectTuckedState(panel)
        if hiddenEdge != nil {
            // Normalize frames saved by older builds whose 30pt peek could leave the
            // visible portion entirely transparent.
            applyEdgeFrame(animated: false)
        }
        installDragMonitors(panel)
        updateBubbleAllowed()
        return panel
    }

    // MARK: - Bubble width gating

    func windowDidMove(_ notification: Notification) {
        updateBubbleAllowed()
        if let panel, didDrag {
            detectTuckedState(panel)
        }
    }

    /// Hide the bubble whenever too little of the pet is on-screen (edge-tucked, or being
    /// dragged off the side), so it never flickers trying to render in a clipped width.
    private func updateBubbleAllowed() {
        guard let panel, let screen = panel.screen ?? NSScreen.main else { return }
        let visibleW = panel.frame.intersection(screen.visibleFrame).width
        let allowed = visibleW >= Self.bubbleMinWidth
        if uiState.bubbleAllowed != allowed { uiState.bubbleAllowed = allowed }
    }

    /// Grow the transparent host upward to the bubble's measured SwiftUI height. That
    /// measurement already includes the bubble's visual-effect inset. The bottom edge
    /// stays fixed so the pet remains under the pointer; only a screen-top collision
    /// moves the panel down.
    private func applyBubbleContentHeight(_ measuredHeight: CGFloat) {
        guard measuredHeight.isFinite else { return }
        let nextHeight = max(
            PetWindowState.minimumBubbleHeight,
            ceil(measuredHeight)
        )
        guard abs(nextHeight - uiState.bubbleHeight) >= 0.5 else { return }

        uiState.bubbleHeight = nextHeight
        guard let panel else { return }

        let oldFrame = panel.frame
        var nextFrame = NSRect(
            x: oldFrame.origin.x,
            y: oldFrame.origin.y,
            width: petSize.width,
            height: petSize.height
        )
        if let screen = panel.screen ?? NSScreen.main {
            let visibleFrame = screen.visibleFrame
            let highestAllowedOrigin = max(visibleFrame.minY, visibleFrame.maxY - nextFrame.height)
            nextFrame.origin.y = min(nextFrame.origin.y, highestAllowedOrigin)
        }
        panel.setFrame(nextFrame, display: true)
    }

    // MARK: - Drag cursor + edge tucking

    private func installDragMonitors(_ panel: NSPanel) {
        // Anchor the drag. Dragging is done by hand rather than by AppKit's
        // `isMovableByWindowBackground`, which SwiftUI's hosting view stops from
        // ever triggering (#634 — the pet could not be moved at all on macOS 27).
        downMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown]) { [weak self, weak panel] event in
            guard let panel, event.window === panel else { return event }
            let origin = panel.frame.origin
            let mouse = NSEvent.mouseLocation
            Task { @MainActor [weak self] in
                self?.dragAnchor = (mouse: mouse, window: origin)
            }
            return event
        }
        // Closed-hand "grab" cursor while dragging the pet; restore the open hand on drop.
        dragMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDragged]) { [weak self, weak panel] event in
            if event.window === panel {
                let deltaX = event.deltaX
                let mouse = NSEvent.mouseLocation
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.didDrag = true
                    self.uiState.isDragging = true
                    if deltaX < 0 {
                        self.uiState.dragDirection = .left
                    } else if deltaX > 0 {
                        self.uiState.dragDirection = .right
                    }
                    NSCursor.closedHand.set()
                    self.moveDuringDrag(to: mouse)
                }
            }
            return event
        }
        upMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp]) { [weak self, weak panel] event in
            if event.window === panel {
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.keepActive()
                    if self.didDrag {            // only after a real drag, not a tap
                        NSCursor.openHand.set()
                        self.snapToEdgeIfNeeded()
                    }
                    self.uiState.isDragging = false
                    self.didDrag = false
                    self.dragAnchor = nil
                }
            }
            return event
        }
    }

    /// Moves the panel to follow the cursor, keeping the grab point under it.
    /// A drag that starts on an edge-tucked pet pulls it back out first, so the
    /// pet does not snap back to the edge mid-drag.
    private func moveDuringDrag(to mouse: NSPoint) {
        guard let panel, let anchor = dragAnchor else { return }
        if hiddenEdge != nil {
            hiddenEdge = nil
            isRevealed = false
            uiState.isTucked = false
            uiState.isSnapped = false
        }
        panel.setFrameOrigin(NSPoint(
            x: anchor.window.x + (mouse.x - anchor.mouse.x),
            y: anchor.window.y + (mouse.y - anchor.mouse.y)
        ))
    }

    /// On drop, tuck the pet away if it landed against the left/right edge.
    private func snapToEdgeIfNeeded() {
        guard let panel, let screen = panel.screen else { return }
        let vf = screen.visibleFrame
        let f = panel.frame
        let spriteLeft = f.origin.x + spriteLeftInset
        let spriteRight = spriteLeft + spriteWidth
        
        if spriteRight >= vf.maxX - Self.snapMargin {
            hiddenEdge = .right
            isRevealed = false
            uiState.isRightEdge = true
            uiState.isTucked = true
            uiState.isSnapped = true
            applyEdgeFrame(animated: true, saveFrameAfterAnimation: true)
        } else if spriteLeft <= vf.minX + Self.snapMargin {
            hiddenEdge = .left
            isRevealed = false
            uiState.isRightEdge = false
            uiState.isTucked = true
            uiState.isSnapped = true
            applyEdgeFrame(animated: true, saveFrameAfterAnimation: true)
        } else {
            hiddenEdge = nil
            uiState.isTucked = false
            uiState.isSnapped = false
        }
    }

    /// Hovering an edge-tucked pet slides it fully into view; leaving tucks it back.
    private func handleHover(_ hovering: Bool) {
        uiState.isHovered = hovering
        if hovering {
            keepActive()
        }
        guard hiddenEdge != nil else { return }
        if hovering, !isRevealed {
            isRevealed = true
            applyEdgeFrame(animated: true)
        } else if !hovering, isRevealed {
            isRevealed = false
            applyEdgeFrame(animated: true)
        }
    }

    /// Detect whether the (restored) frame is sitting mostly off-screen against an edge.
    private func detectTuckedState(_ panel: NSPanel) {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let vf = screen.visibleFrame
        let f = panel.frame
        let spriteLeft = f.origin.x + spriteLeftInset
        let spriteRight = spriteLeft + spriteWidth
        if spriteRight > vf.maxX {
            hiddenEdge = .right; isRevealed = false; uiState.isTucked = true; uiState.isRightEdge = true; uiState.isSnapped = true
        } else if spriteLeft < vf.minX {
            hiddenEdge = .left; isRevealed = false; uiState.isTucked = true; uiState.isRightEdge = false; uiState.isSnapped = true
        } else {
            uiState.isTucked = false
            if didDrag {
                hiddenEdge = nil
                uiState.isSnapped = false
            }
        }
    }

    /// Position the pet for its current `hiddenEdge` + `isRevealed` state.
    private func applyEdgeFrame(animated: Bool, saveFrameAfterAnimation: Bool = false) {
        guard let panel, let screen = panel.screen ?? NSScreen.main, let edge = hiddenEdge else { return }
        let vf = screen.visibleFrame
        var f = panel.frame
        switch (edge, isRevealed) {
        case (.right, true):  f.origin.x = vf.maxX - (spriteLeftInset + spriteWidth)
        case (.right, false): f.origin.x = vf.maxX - spriteLeftInset - Self.edgePeek
        case (.left, true):   f.origin.x = vf.minX - spriteLeftInset
        case (.left, false):  f.origin.x = vf.minX + Self.edgePeek - (spriteLeftInset + spriteWidth)
        }
        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.22
                panel.animator().setFrame(f, display: true)
            } completionHandler: { [weak self, weak panel] in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.uiState.isTucked = !self.isRevealed
                    if saveFrameAfterAnimation {
                        panel?.saveFrame(usingName: Self.frameAutosaveName)
                    }
                }
            }
        } else {
            panel.setFrame(f, display: true)
            uiState.isTucked = !isRevealed
            if saveFrameAfterAnimation {
                panel.saveFrame(usingName: Self.frameAutosaveName)
            }
        }
    }

    private func keepActive() {
        if uiState.sleepState == .sleeping {
            uiState.sleepState = .waking
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                if self?.uiState.sleepState == .waking {
                    self?.uiState.sleepState = nil
                }
            }
        } else if uiState.sleepState == .yawning {
            uiState.sleepState = nil
        }
        
        sleepTimer?.invalidate()
        sleepTimer = Timer.scheduledTimer(withTimeInterval: 300.0, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.triggerSleepSequence()
            }
        }
    }

    private func triggerSleepSequence() {
        guard uiState.sleepState == nil else { return }
        uiState.sleepState = .yawning
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            if self?.uiState.sleepState == .yawning {
                self?.uiState.sleepState = .sleeping
            }
        }
    }

    /// Change the pet's size preset (from the right-click menu). Width is fixed, so the
    /// sprite stays horizontally centered; only the sprite scale + panel height change.
    /// The sprite-derived tuck geometry recomputes from `sizePreset`, so a tucked pet is
    /// re-pinned to its edge after the resize.
    func setSize(_ preset: PetSizePreset) {
        guard preset != sizePreset else { return }
        sizePreset = preset
        UserDefaults.standard.set(preset.rawValue, forKey: Self.sizeDefaultsKey)
        // Drives ClawdCompanionView's sprite scale + the DesktopPetHost frame height.
        uiState.floatingScale = preset.scale

        guard let panel else { return }
        // Width unchanged → horizontal center unchanged; grow/shrink height in place.
        let old = panel.frame
        let newSize = petSize
        panel.setFrame(NSRect(x: old.origin.x, y: old.origin.y, width: newSize.width, height: newSize.height), display: true)
        panel.saveFrame(usingName: Self.frameAutosaveName)
        updateBubbleAllowed()
        // Re-pin to the edge with the new sprite geometry (peek/inset changed with scale).
        if hiddenEdge != nil {
            applyEdgeFrame(animated: false)
        } else {
            detectTuckedState(panel)
        }
        NativeBridge.shared.pushPetSettings()
    }

    /// Change the visible companion identity without rebuilding the floating window.
    /// `PetCharacterStore` is the single source of truth — every view observes it
    /// directly, so no per-window mirror to keep in sync.
    func setCharacter(_ character: PetCharacter) {
        PetCatalog.shared.refresh()
        guard PetCatalog.shared.contains(character) else { return }
        guard character != PetCharacterStore.shared.character else { return }
        PetCharacterStore.shared.setCharacter(character)
        keepActive()
        NativeBridge.shared.pushPetSettings()
    }

    deinit {
        lookTimer?.invalidate()
        if let downMonitor { NSEvent.removeMonitor(downMonitor) }
        if let dragMonitor { NSEvent.removeMonitor(dragMonitor) }
        if let upMonitor { NSEvent.removeMonitor(upMonitor) }
    }

    /// V2 packages add sixteen fixed look cells. Track the global cursor relative to
    /// the floating sprite so the pet can watch across the whole desktop, matching the
    /// Codex Pets cursor preview instead of only reacting while directly hovered.
    private func startLookTracking() {
        lookTimer?.invalidate()
        lookTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let panel = self.panel, panel.isVisible,
                      PetCharacterStore.shared.character.spriteVersionNumber == 2 else {
                    // Assign only on change: setting a @Published property fires
                    // objectWillChange even when the value is identical, which would
                    // re-render the sprite view 15×/s for every V1 pet.
                    if let self, self.uiState.lookDirectionIndex != nil {
                        self.uiState.lookDirectionIndex = nil
                    }
                    return
                }
                let mouse = NSEvent.mouseLocation
                let center = NSPoint(
                    x: panel.frame.midX,
                    y: panel.frame.minY + (64 * self.sizePreset.scale) / 2
                )
                let dx = mouse.x - center.x
                let dy = mouse.y - center.y
                let degrees = (atan2(dx, dy) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
                let next = Int((degrees / 22.5).rounded()) % 16
                if self.uiState.lookDirectionIndex != next { self.uiState.lookDirectionIndex = next }
            }
        }
        RunLoop.main.add(lookTimer!, forMode: .common)
    }
}

/// Borderless panels can't become key by default, which would swallow SwiftUI taps and
/// hover tracking. Allow key (so gestures work) while `.nonactivatingPanel` keeps a
/// click from ever stealing focus from the user's frontmost app.
private final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// The three desktop-pet sizes (parity with the Windows pet). `medium` is the original
/// default (scale 1.4 / 150pt panel) so existing users see no change. Width is shared
/// across all sizes — only the sprite scale and panel height vary.
enum PetSizePreset: String, CaseIterable {
    case small, medium, large

    /// Fixed panel width — wide enough for the longest bubble at any sprite scale.
    static let panelWidth: CGFloat = 540

    /// Sprite scale fed to ClawdCompanionView's floating layout.
    var scale: CGFloat {
        switch self {
        case .small:  return 1.0
        case .medium: return 1.4
        case .large:  return 1.85
        }
    }

    /// Panel height — must clear the scaled sprite (16 * px(4) * scale) plus the
    /// multi-row active-limit bubble slot above it, or the sprite/bubble clips.
    var panelHeight: CGFloat {
        switch self {
        case .small:  return 230
        case .medium: return 250
        case .large:  return 288
        }
    }

    var menuLabel: String {
        switch self {
        case .small:  return Strings.petSizeSmall
        case .medium: return Strings.petSizeMedium
        case .large:  return Strings.petSizeLarge
        }
    }

    /// Nearest preset for a given scale (used to check the active item in the menu).
    static func from(scale: CGFloat) -> PetSizePreset {
        allCases.min { abs($0.scale - scale) < abs($1.scale - scale) } ?? .medium
    }
}

/// A Codex-compatible companion identity. Built-ins and packages installed under
/// ~/.tokentracker/pets share the same value type so selecting a community pet never requires
/// adding a new enum case or rebuilding the app.
struct PetCharacter: RawRepresentable, Hashable, Identifiable, CaseIterable {
    let rawValue: String
    var id: String { rawValue }

    static let clawd = PetCharacter(rawValue: "clawd")!
    static let bot = PetCharacter(rawValue: "bot")!
    static let sprout = PetCharacter(rawValue: "sprout")!
    static let byte = PetCharacter(rawValue: "byte")!
    static let ember = PetCharacter(rawValue: "ember")!
    static var allCases: [PetCharacter] { PetCatalog.shared.characters }

    init?(rawValue: String) {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
        guard !value.isEmpty, value.count <= 64,
              value.unicodeScalars.allSatisfy({ allowed.contains($0) }),
              value.first?.isLetter == true || value.first?.isNumber == true,
              value.last?.isLetter == true || value.last?.isNumber == true else { return nil }
        self.rawValue = value
    }

    /// How this character is drawn. Explicit because it used to be inferred from a
    /// missing sprite atlas, which made "no atlas" mean "this is Clawd". `bot` has no
    /// atlas either — it draws vector paths — so that inference had to go.
    /// Mirrors `petRenderer()` in dashboard/src/lib/pet-personality.js.
    enum Renderer { case clawd, vector, atlas }

    var renderer: Renderer {
        if self == Self.clawd { return .clawd }
        if self == Self.bot { return .vector }
        return .atlas
    }

    /// SVG Clawd is tightly cropped; atlas pets carry transparent breathing room; bot
    /// draws into a 316-unit viewBox whose margin is headroom for its orbit rings.
    /// Normalize painted size without changing the selected window-size preset.
    /// Mirrors `petVisualScale()` in dashboard/src/lib/pet-appearance.js.
    var visualScale: CGFloat {
        switch renderer {
        case .clawd: return 0.84
        case .vector: return 1.35
        case .atlas: return 1.0
        }
    }

    var menuLabel: String {
        if self == Self.clawd { return Strings.petCharacterClawd }
        if self == Self.bot { return Strings.petCharacterBot }
        if self == Self.sprout { return Strings.petCharacterSprout }
        if self == Self.byte { return Strings.petCharacterByte }
        if self == Self.ember { return Strings.petCharacterEmber }
        return PetCatalog.shared.displayName(for: self) ?? rawValue
    }

    var spriteVersionNumber: Int { PetCatalog.shared.spriteVersion(for: self) }
    var atlasURL: URL? { PetCatalog.shared.atlasURL(for: self) }
    var atlasCacheKey: String { PetCatalog.shared.atlasCacheKey(for: self) }
}

final class PetCatalog: ObservableObject {
    static let shared = PetCatalog()
    private static let builtins: [PetCharacter] = [.clawd, .bot, .sprout, .byte, .ember]
    private static let hiddenBuiltinsFilename = ".hidden-builtins.json"
    private struct Metadata {
        let displayName: String
        let spriteVersionNumber: Int
        let atlasURL: URL
        let atlasCacheKey: String
    }

    @Published private(set) var characters: [PetCharacter] = builtins
    private var metadata: [String: Metadata] = [:]

    private init() { refresh() }

    func refresh() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let root = home
            .appendingPathComponent(".tokentracker/pets", isDirectory: true)
        let hiddenBuiltinIDs: Set<String> = {
            let url = root.appendingPathComponent(Self.hiddenBuiltinsFilename)
            guard let data = try? Data(contentsOf: url),
                  let ids = try? JSONSerialization.jsonObject(with: data) as? [String] else {
                return []
            }
            return Set(ids)
        }()
        let legacyRoot = home
            .appendingPathComponent(".codex/pets", isDirectory: true)
        let migrationComplete = FileManager.default.fileExists(
            atPath: root.appendingPathComponent(".migrated-v1").path
        )
        // The native catalog initializes before the embedded Node server. Until
        // Node has copied legacy packages and written its marker, retain a read-only
        // fallback so an existing selection is not reset during the upgrade.
        let roots = migrationComplete ? [root] : [root, legacyRoot]
        var discovered: [(PetCharacter, Metadata)] = []
        var seen = Set<String>()
        for sourceRoot in roots {
            let directories = (try? FileManager.default.contentsOfDirectory(
                at: sourceRoot,
                includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles]
            )) ?? []
            for directory in directories {
                let values = try? directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard values?.isDirectory == true, values?.isSymbolicLink != true,
                      let character = PetCharacter(rawValue: directory.lastPathComponent),
                      !Self.builtins.contains(character),
                      !seen.contains(character.rawValue) else { continue }
                let manifestURL = directory.appendingPathComponent("pet.json")
                let atlasURL = directory.appendingPathComponent("spritesheet.webp")
                guard FileManager.default.fileExists(atPath: atlasURL.path),
                      let data = try? Data(contentsOf: manifestURL),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      (object["id"] as? String)?.lowercased() == character.rawValue,
                      object["spritesheetPath"] as? String == "spritesheet.webp",
                      let displayName = object["displayName"] as? String,
                      !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                let version = (object["spriteVersionNumber"] as? NSNumber)?.intValue == 2 ? 2 : 1
                let attributes = try? FileManager.default.attributesOfItem(atPath: atlasURL.path)
                let modified = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
                let size = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
                seen.insert(character.rawValue)
                discovered.append((character, Metadata(
                    displayName: displayName,
                    spriteVersionNumber: version,
                    atlasURL: atlasURL,
                    atlasCacheKey: "\(character.rawValue)-\(modified)-\(size)"
                )))
            }
        }
        discovered.sort { $0.1.displayName.localizedCaseInsensitiveCompare($1.1.displayName) == .orderedAscending }
        metadata = Dictionary(uniqueKeysWithValues: discovered.map { ($0.0.rawValue, $0.1) })
        // Only atlas-backed builtins are hideable — that list exists to reclaim the
        // space a sheet takes. Keyed on the renderer rather than special-casing clawd,
        // so it matches REMOVABLE_BUILTIN_IDS in src/lib/pet-packages.js; otherwise a
        // hidden-builtins file naming `bot` would hide it here but not on the web.
        characters = Self.builtins.filter {
            $0.renderer != .atlas || !hiddenBuiltinIDs.contains($0.rawValue)
        } + discovered.map(\.0)
    }

    func contains(_ character: PetCharacter) -> Bool { characters.contains(character) }
    func displayName(for character: PetCharacter) -> String? { metadata[character.rawValue]?.displayName }
    func spriteVersion(for character: PetCharacter) -> Int { metadata[character.rawValue]?.spriteVersionNumber ?? 1 }
    func atlasURL(for character: PetCharacter) -> URL? {
        if let custom = metadata[character.rawValue]?.atlasURL { return custom }
        // Only atlas-rendered characters have a sheet to find.
        guard character.renderer == .atlas else { return nil }
        let name = "pet-\(character.rawValue)"
        return Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "PetSprites")
            ?? Bundle.main.url(forResource: name, withExtension: "png")
    }
    func atlasCacheKey(for character: PetCharacter) -> String {
        metadata[character.rawValue]?.atlasCacheKey ?? character.rawValue
    }
}

/// One persisted appearance source shared by the menu-bar popover, floating pet,
/// and Dashboard native bridge. Keeping this separate from `PetWindowState` avoids
/// leaking floating-only state (edge tuck, sleep, hover) into the popover.
@MainActor
final class PetCharacterStore: ObservableObject {
    static let shared = PetCharacterStore()
    private static let defaultsKey = "DesktopPetCharacter"
    private static let botColorKey = "DesktopPetBotColor"

    @Published private(set) var character: PetCharacter
    /// Body colour for the vector `bot` character: a palette id, or "auto" to follow
    /// the system appearance. Validated against the palette shipped in BotFrames.json,
    /// so a colour dropped from the picker degrades to "auto" instead of sticking.
    @Published private(set) var botColor: String

    private init() {
        botColor = Self.normalizeBotColor(UserDefaults.standard.string(forKey: Self.botColorKey))
        let raw = UserDefaults.standard.string(forKey: Self.defaultsKey)
        PetCatalog.shared.refresh()
        if let candidate = raw.flatMap(PetCharacter.init(rawValue:)),
           PetCatalog.shared.contains(candidate) {
            character = candidate
        } else {
            character = .clawd
            if raw != nil { UserDefaults.standard.removeObject(forKey: Self.defaultsKey) }
        }
    }

    private static func normalizeBotColor(_ raw: String?) -> String {
        guard let raw, raw != "auto",
              BotFrames.payload?.palette[raw] != nil else { return "auto" }
        return raw
    }

    func setBotColor(_ raw: String) {
        let next = Self.normalizeBotColor(raw)
        guard botColor != next else { return }
        botColor = next
        if next == "auto" {
            UserDefaults.standard.removeObject(forKey: Self.botColorKey)
        } else {
            UserDefaults.standard.set(next, forKey: Self.botColorKey)
        }
    }

    func setCharacter(_ character: PetCharacter) {
        PetCatalog.shared.refresh()
        guard PetCatalog.shared.contains(character) else { return }
        guard self.character != character else { return }
        self.character = character
        UserDefaults.standard.set(character.rawValue, forKey: Self.defaultsKey)
    }
}

/// Reactive wrapper so changing `petState.floatingScale` resizes the hosted SwiftUI
/// content (the panel itself is resized in step by `setSize`).
private struct DesktopPetHost: View {
    @ObservedObject var petState: PetWindowState
    let content: ClawdCompanionView

    var body: some View {
        content.frame(
            width: PetSizePreset.panelWidth,
            height: PetSizePreset.from(scale: petState.floatingScale).panelHeight
                + petState.bubbleHeight
                - PetWindowState.minimumBubbleHeight
        )
    }
}

/// Observable flag shared with the floating ClawdCompanionView: the bubble is only
/// shown when enough of the pet is on-screen (set by DesktopPetWindowController).
@MainActor
final class PetWindowState: ObservableObject {
    enum DragDirection { case left, right }

    static let minimumBubbleHeight: CGFloat = 138
    static let alwaysAllowed = PetWindowState()
    @Published var bubbleAllowed = true
    @Published var bubbleHeight = minimumBubbleHeight
    @Published var isWindowVisible = true
    @Published var isTucked = false
    @Published var isHovered = false
    @Published var isRightEdge = true
    @Published var isSnapped = false
    @Published var isDragging = false
    @Published var dragDirection: DragDirection = .right
    @Published var sleepState: ClawdCompanionView.ClawdState? = nil
    @Published var lookDirectionIndex: Int? = nil
    /// Sprite scale for the floating pet — driven by the chosen PetSizePreset.
    @Published var floatingScale: CGFloat = 1.4
}
