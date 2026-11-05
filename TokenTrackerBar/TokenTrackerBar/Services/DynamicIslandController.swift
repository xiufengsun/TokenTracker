import AppKit
import SwiftUI

// MARK: - Background cursor override

// The window server silently ignores NSCursor changes from apps that are not
// frontmost — and this app never is while the island is hovered (the panel is
// non-activating, canBecomeKey == false). These private-but-long-stable CGS
// calls (same ones AltTab / Karabiner rely on) opt the process into setting
// the cursor from the background, which is what makes the pointing hand
// actually appear over island buttons.
private typealias CGSConnectionID = Int32

@_silgen_name("CGSMainConnectionID")
private func CGSMainConnectionID() -> CGSConnectionID

@_silgen_name("CGSSetConnectionProperty")
private func CGSSetConnectionProperty(
    _ cid: CGSConnectionID,
    _ targetCID: CGSConnectionID,
    _ key: CFString,
    _ value: CFTypeRef
) -> CGError

@MainActor
enum BackgroundCursorOverride {
    private static var enabled = false

    /// Idempotent; called when the island panel is first created.
    static func enable() {
        guard !enabled else { return }
        enabled = true
        let cid = CGSMainConnectionID()
        _ = CGSSetConnectionProperty(cid, cid, "SetsCursorInBackground" as CFString, kCFBooleanTrue)
    }
}

/// Geometry of the island, derived from the target screen's hardware notch
/// (or a simulated pill on notch-less screens). Published to the SwiftUI view
/// so the collapsed shape hugs the real notch dimensions.
struct DynamicIslandGeometry: Equatable {
    /// Width of the hardware notch — the collapsed island's opaque center that
    /// the notch itself occludes. On notch-less screens this is a small filler
    /// segment between the two text wings.
    var centerGapWidth: CGFloat
    /// Collapsed island height == the notch height (safe-area top inset) on
    /// notched screens; a menu-bar-ish height for the simulated island.
    var collapsedHeight: CGFloat
    /// Width of each text wing flanking the notch (tokens left, cost right).
    /// Content-driven: the view measures both labels and reports the tighter
    /// max(left, right) back through `onWingWidthChanged`, so the black wings
    /// hug the text instead of padding the island out. Both wings share one
    /// width to keep the island symmetric around the notch center.
    var wingWidth: CGFloat
    var hasNotch: Bool
    /// Horizontal center of the island in screen coordinates. The hardware
    /// notch is not always exactly at the screen's midX (auxiliary areas can
    /// differ by a point), so the island centers on the notch itself.
    var islandCenterX: CGFloat = 0

    /// Floor so a tiny value (e.g. "0") still reads as an island wing.
    static let minWingWidth: CGFloat = 44

    var collapsedWidth: CGFloat { centerGapWidth + wingWidth * 2 }

    static let expandedWidth = DynamicIslandLayoutPolicy.expandedWidth
    /// Extra space around the island shape so the drop shadow isn't clipped
    /// by the window server. Applied horizontally (each side) and vertically
    /// (bottom only — top is flush with the screen edge).
    static let shadowBleed = DynamicIslandLayoutPolicy.shadowBleed
    /// Maximum vertical space the panel reserves for island content.
    /// The panel is always this tall (plus shadowBleed); the island shape
    /// grows to fit its content up to this limit.
    static let maxExpandedHeight = DynamicIslandLayoutPolicy.maximumIslandHeight

    /// Simulated island for screens without a notch (external displays, older
    /// Macs): a compact pill at the top-center, boring.notch-style.
    static let simulated = DynamicIslandGeometry(
        centerGapWidth: 28,
        collapsedHeight: 30,
        wingWidth: 60,
        hasNotch: false
    )
}

/// Observable UI state shared between the controller (which owns the panel
/// frame) and the SwiftUI content (which animates the island shape).
@MainActor
final class DynamicIslandState: ObservableObject {
    @Published var isExpanded = false
    /// 0 = hidden, 1 = fully revealed through a centered mask.
    @Published var visibilityProgress: CGFloat = 0
    /// Selects the center-point endpoint while closing.
    @Published var isVisibilityDismissing = false
    @Published var geometry = DynamicIslandGeometry.simulated
    /// Actual rendered height of the expanded island, reported by the SwiftUI
    /// view's GeometryReader after layout. Drives the expanded hit-test rect so
    /// the transparent chrome below the island never swallows clicks.
    @Published var expandedHeight: CGFloat = 400
    /// Whether the island panel is currently on screen. Lets the view skip
    /// work (icon-frame notifications) while the feature is toggled off.
    @Published var isPanelVisible = false
    /// Mirrors the panel's current content size. Fixed at the generous maximum
    /// so the panel never needs to resize.
    @Published var panelSize: CGSize = {
        let w = DynamicIslandGeometry.expandedWidth + DynamicIslandGeometry.shadowBleed * 2
        let h = DynamicIslandGeometry.maxExpandedHeight + DynamicIslandGeometry.shadowBleed
        return CGSize(width: w, height: h)
    }()
    /// Bumped on `.nativeSettingsChanged` so currency/locale changes re-render
    /// the cost strings without waiting for the next data refresh.
    @Published var settingsTick = 0
}

/// Notch-hugging "Dynamic Island" (boring.notch-style): a transparent,
/// always-on-top, non-activating panel pinned to the top-center of the screen.
/// Collapsed it shows today's tokens (left wing) and today's cost (right wing)
/// around the hardware notch; hovering expands it into a spend + limits detail
/// card. Shares the app's single `DashboardViewModel` — no independent polling.
@MainActor
final class DynamicIslandController: NSObject {
    static let enabledDefaultsKey = "DynamicIslandEnabled"

    /// Delay before collapsing after the pointer leaves, so grazing the island
    /// edge doesn't flap it shut.
    private static let collapseDelay: TimeInterval = 0.25

    private let viewModel: DashboardViewModel
    private let state = DynamicIslandState()
    private var panel: IslandPanel?
    /// Retained separately because we host its view inside `IslandHitView`
    /// rather than assigning `contentViewController` (which would replace our
    /// hit-test wrapper).
    private var hostingController: NSHostingController<DynamicIslandView>?
    private var collapseWorkItem: DispatchWorkItem?
    private var visibilityWorkItem: DispatchWorkItem?
    private var visibilityTransitions = DynamicIslandVisibilityTransitionTracker()
    /// Keeps the transparent panel click-through during transitions.
    private var acceptsIslandInteraction = false
    private var observers: [NSObjectProtocol] = []
    /// Same-space / legacy full-screen often changes presentation options
    /// without a Space or app-activation notification.
    private var presentationObservation: NSKeyValueObservation?
    /// While > 0 a tray menu spawned from the island is open; hover-out must
    /// not collapse the island under the menu.
    private var menuHoldCount = 0
    /// True when a full-screen app occupies the island's screen. Independent
    /// of `isEnabled` so turning the island off while full-screen does not
    /// re-show it on exit.
    private var fullscreenActive = false
    /// Pending settle tick that re-reads the window list after an environment
    /// change. Non-nil while a settle burst is running.
    private var fullscreenSettleWorkItem: DispatchWorkItem?
    /// Index into `fullscreenSettleDelays` for the next scheduled tick.
    private var fullscreenSettleAttempt = 0

    /// Bounded settle-burst delays — read from the policy so unit tests that
    /// change the policy also change the schedule.
    private static let fullscreenSettleDelays: [TimeInterval] =
        DynamicIslandFullscreenRetryPolicy.settleDelays

    init(viewModel: DashboardViewModel) {
        self.viewModel = viewModel
        super.init()

        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handleFullscreenEnvironmentChange()
                self?.repositionPanel()
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // Necessary but not sufficient: activation settles the window list
            // and presentation options, so it catches the case where the other
            // notifications never fired while the app was in the background.
            Task { @MainActor [weak self] in self?.handleFullscreenEnvironmentChange() }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .nativeSettingsChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.state.settingsTick += 1 }
        })
        let workspace = NSWorkspace.shared.notificationCenter
        observers.append(workspace.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.handleFullscreenEnvironmentChange() }
        })
        observers.append(workspace.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.handleFullscreenEnvironmentChange() }
        })
        presentationObservation = NSApp.observe(
            \.currentSystemPresentationOptions,
            options: [.new]
        ) { [weak self] _, _ in
            Task { @MainActor [weak self] in self?.handleFullscreenEnvironmentChange() }
        }
    }

    deinit {
        visibilityWorkItem?.cancel()
        fullscreenSettleWorkItem?.cancel()
        presentationObservation?.invalidate()
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
    }

    var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: Self.enabledDefaultsKey)
    }

    func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: Self.enabledDefaultsKey)
        cancelFullscreenSettleRetries()
        fullscreenActive = readFullscreenActive()
        applyPresence()
        // Only arm a settle burst when the feature is both enabled and
        // currently suppressed by full-screen. Disabling while full-screen
        // must not leave a tick scheduled to re-read the window list for no
        // reason.
        if enabled && fullscreenActive {
            armFullscreenSettleRetries()
        }
    }

    /// Re-show the island on launch if it was enabled when the app last quit.
    func restoreIfNeeded() {
        fullscreenActive = readFullscreenActive()
        applyPresence()
        if fullscreenActive {
            armFullscreenSettleRetries()
        }
    }

    func show() {
        guard shouldShowPanel else { return }
        let panel = panel ?? makePanel()
        self.panel = panel
        let wasVisible = state.isPanelVisible && panel.isVisible
        let transition = beginVisibilityTransition()

        // Always reveal from the compact, non-interactive state.
        state.isVisibilityDismissing = false
        state.isExpanded = false
        state.isPanelVisible = true
        acceptsIslandInteraction = false
        repositionPanel()

        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            state.visibilityProgress = 1
            panel.alphaValue = 1
            panel.orderFrontRegardless()
            acceptsIslandInteraction = true
            panel.updateHitRegion()
            return
        }

        if !wasVisible {
            // Avoid a full-width flash before SwiftUI renders the start mask.
            state.visibilityProgress = 0
            panel.alphaValue = 0
        }
        panel.orderFrontRegardless()

        // Commit the start mask before revealing a newly shown panel.
        DispatchQueue.main.async { [weak self, weak panel] in
            guard let self, let panel,
                  self.visibilityTransitions.owns(transition),
                  self.shouldShowPanel
            else { return }
            panel.alphaValue = 1
            withAnimation(.timingCurve(0.16, 1, 0.3, 1, duration: DynamicIslandVisibilityPolicy.showDuration)) {
                self.state.visibilityProgress = 1
            }
            self.scheduleVisibilityCompletion(
                after: DynamicIslandVisibilityPolicy.showDuration,
                transition: transition
            ) { controller in
                guard controller.shouldShowPanel else { return }
                controller.acceptsIslandInteraction = true
                controller.panel?.updateHitRegion()
            }
        }
    }

    func hide() {
        collapseWorkItem?.cancel()
        collapseWorkItem = nil
        let transition = beginVisibilityTransition()
        acceptsIslandInteraction = false
        panel?.updateHitRegion()
        state.isVisibilityDismissing = true

        guard let panel, state.isPanelVisible, panel.isVisible else {
            state.isExpanded = false
            state.visibilityProgress = 0
            state.isPanelVisible = false
            panel?.orderOut(nil)
            return
        }

        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            state.isExpanded = false
            state.visibilityProgress = 0
            state.isPanelVisible = false
            panel.orderOut(nil)
            return
        }

        withAnimation(.timingCurve(0.4, 0, 0.2, 1, duration: DynamicIslandVisibilityPolicy.hideDuration)) {
            state.isExpanded = false
            state.visibilityProgress = 0
        }
        scheduleVisibilityCompletion(
            after: DynamicIslandVisibilityPolicy.hideCompletionDelay,
            transition: transition
        ) { controller in
            guard !controller.shouldShowPanel else { return }
            controller.state.isPanelVisible = false
            controller.panel?.orderOut(nil)
        }
    }

    private func beginVisibilityTransition() -> Int {
        visibilityWorkItem?.cancel()
        visibilityWorkItem = nil
        return visibilityTransitions.begin()
    }

    private func scheduleVisibilityCompletion(
        after delay: TimeInterval,
        transition: Int,
        completion: @escaping @MainActor (DynamicIslandController) -> Void
    ) {
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.visibilityTransitions.owns(transition) else { return }
            self.visibilityWorkItem = nil
            completion(self)
        }
        visibilityWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    // MARK: - Hover-driven expand / collapse

    fileprivate func handleHover(_ hovering: Bool) {
        if hovering {
            // Tracking areas are rebuilt as the island expands/collapses.
            // Ignore a stale enter from the previous area unless the pointer
            // is physically inside the CURRENT AppKit hit rect.
            guard DynamicIslandInteractionPolicy.shouldExpand(
                hovering: true,
                pointerInsideInteractiveRegion: isPointerOverIsland()
            ) else { return }
            collapseWorkItem?.cancel()
            collapseWorkItem = nil
            expand()
        } else {
            collapseWorkItem?.cancel()
            collapseWorkItem = nil
            // A menu is tracking — keep the island open; endMenuHold decides.
            guard menuHoldCount == 0 else { return }
            let item = DispatchWorkItem { [weak self] in self?.collapse() }
            collapseWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.collapseDelay, execute: item)
        }
    }

    /// Menu tracking started from the island (gear button / right-click).
    /// Blocks hover-driven collapse for the menu's lifetime.
    func beginMenuHold() {
        menuHoldCount += 1
        collapseWorkItem?.cancel()
        collapseWorkItem = nil
    }

    /// Menu dismissed — collapse unless the pointer came back to the island.
    /// Even then, schedule the standard delayed collapse as a fallback: the
    /// menu's tracking run loop can swallow the SwiftUI hover re-entry, in
    /// which case no hover-out would ever fire and the island would hang
    /// open. A live hover cancels this via the next handleHover(true).
    func endMenuHold() {
        menuHoldCount = max(0, menuHoldCount - 1)
        guard menuHoldCount == 0 else { return }
        if isPointerOverIsland() {
            handleHover(true)
            let item = DispatchWorkItem { [weak self] in
                guard let self, !self.isPointerOverIsland() else { return }
                self.collapse()
            }
            collapseWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: item)
        } else {
            collapse()
        }
    }

    private func isPointerOverIsland() -> Bool {
        guard let panel else { return false }
        let local = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        return hitRectInPanel().contains(local)
    }

    private func expand() {
        guard !state.isExpanded else { return }
        // Panel frame stays put — only the black shape springs open from the
        // top. Resizing the window mid-animation was what opened the seam.
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            state.isExpanded = true
        } else {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                state.isExpanded = true
            }
        }
        panel?.updateHitRegion()
    }

    private func collapse() {
        guard state.isExpanded else { return }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            state.isExpanded = false
        } else {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) {
                state.isExpanded = false
            }
        }
        // Collapse the AppKit hit region immediately. The SwiftUI shape may
        // continue its spring animation visually, but its transparent former
        // bounds must become click-through and hover-inert at once.
        panel?.updateHitRegion()
        // Re-assert after the spring settles in case measured geometry changed
        // during the transition.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self, !self.state.isExpanded else { return }
            self.panel?.updateHitRegion()
        }
    }

    // MARK: - Screen + geometry

    /// Prefer a screen with a hardware notch; otherwise fall back to the main
    /// screen with a simulated island.
    private func targetScreen() -> NSScreen? {
        NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 })
            ?? NSScreen.main
            ?? NSScreen.screens.first
    }

    private func geometry(for screen: NSScreen) -> DynamicIslandGeometry {
        // Carry the current content-measured wing width across screen changes;
        // the view re-measures and corrects it if the labels differ.
        let wingWidth = max(DynamicIslandGeometry.minWingWidth, state.geometry.wingWidth)
        let inset = screen.safeAreaInsets.top
        guard inset > 0 else {
            var geo = DynamicIslandGeometry.simulated
            geo.wingWidth = wingWidth
            geo.islandCenterX = screen.frame.midX
            return geo
        }
        let leftWidth = screen.auxiliaryTopLeftArea?.width ?? 0
        let rightWidth = screen.auxiliaryTopRightArea?.width ?? 0
        let notchWidth = screen.frame.width - leftWidth - rightWidth
        guard notchWidth > 0, notchWidth < screen.frame.width / 2 else {
            var geo = DynamicIslandGeometry.simulated
            geo.wingWidth = wingWidth
            geo.islandCenterX = screen.frame.midX
            return geo
        }
        return DynamicIslandGeometry(
            centerGapWidth: notchWidth,
            collapsedHeight: inset,
            wingWidth: wingWidth,
            hasNotch: true,
            // Center on the physical notch (aux areas can be asymmetric by a
            // point), not the screen midpoint.
            islandCenterX: screen.frame.minX + leftWidth + notchWidth / 2
        )
    }

    /// The view measured its wing labels; adopt the tight width so the
    /// collapsed hit-test pill stays snug around the text.
    private func applyWingWidth(_ width: CGFloat) {
        let clamped = max(DynamicIslandGeometry.minWingWidth, width)
        guard abs(clamped - state.geometry.wingWidth) > 0.5 else { return }
        state.geometry.wingWidth = clamped
        panel?.updateHitRegion()
    }

    /// The view measured its rendered island height; adopt it so the expanded
    /// hit-test rect hugs the actual black shape instead of the whole panel
    /// (which would swallow clicks meant for windows below the island).
    /// Collapsed-state reports are ignored — they'd overwrite the remembered
    /// expanded height with the notch height and churn the hit region.
    private func applyExpandedHeight(_ height: CGFloat) {
        guard state.isExpanded else { return }
        guard height > 0, abs(height - state.expandedHeight) > 1 else { return }
        state.expandedHeight = height
        panel?.updateHitRegion()
    }

    /// Fixed generous panel frame — the panel is always this size. The island
    /// shape inside grows/shrinks freely; the transparent chrome around it
    /// passes clicks through via IslandHitView. Wider and taller than the
    /// island so the drop shadow isn't clipped by the window server.
    private func panelFrame(on screen: NSScreen) -> NSRect {
        let bleed = DynamicIslandGeometry.shadowBleed
        let panelW = max(DynamicIslandGeometry.expandedWidth, state.geometry.collapsedWidth) + bleed * 2
        let panelH = DynamicIslandLayoutPolicy.panelHeight(
            screenTop: screen.frame.maxY,
            visibleBottom: screen.visibleFrame.minY
        )
        let centerX = state.geometry.islandCenterX > 0 ? state.geometry.islandCenterX : screen.frame.midX
        return NSRect(
            x: centerX - panelW / 2,
            y: screen.frame.maxY - panelH,
            width: panelW,
            height: panelH
        )
    }

    /// Interactive rect of the black shape, in panel contentView coordinates
    /// (AppKit: origin bottom-left). Used so transparent chrome click-throughs.
    fileprivate func hitRectInPanel() -> NSRect {
        guard acceptsIslandInteraction, let panel else { return .zero }
        let geo = state.geometry
        let panelW = panel.frame.width
        let panelH = panel.frame.height
        let width = state.isExpanded
            ? max(DynamicIslandGeometry.expandedWidth, geo.collapsedWidth)
            : geo.collapsedWidth
        // Expanded: the measured island height (clamped to the panel), so the
        // transparent area below the island stays click-through.
        let height = state.isExpanded
            ? min(max(state.expandedHeight, geo.collapsedHeight), panelH)
            : geo.collapsedHeight
        // Centered horizontally, top-aligned vertically in the panel.
        let x = (panelW - width) / 2
        let y = panelH - height
        return NSRect(x: x, y: y, width: width, height: height)
    }

    // MARK: - Full-screen presence

    private var shouldShowPanel: Bool {
        DynamicIslandFullscreenPolicy.shouldShowPanel(
            featureEnabled: isEnabled,
            fullscreenActive: fullscreenActive
        )
    }

    private func applyPresence() {
        if shouldShowPanel {
            // If a hide animation is mid-flight, cancel the pending completion
            // and reverse it. The panel is still on screen mid-collapse, so
            // we must call show() directly — the isPanelVisible guard below
            // would skip it and the island would stay hidden.
            if DynamicIslandRestorePolicy.mustForceShowDuringDismissal(
                shouldShowPanel: shouldShowPanel,
                isVisibilityDismissing: state.isVisibilityDismissing
            ) {
                beginVisibilityTransition()
                show()
                cancelFullscreenSettleRetries()
                return
            }
            guard !(state.isPanelVisible && panel?.isVisible == true) else { return }
            show()
            // A successful show means the island is restored; no need to keep
            // settling.
            cancelFullscreenSettleRetries()
        } else {
            hide()
        }
    }

    private func handleFullscreenEnvironmentChange() {
        fullscreenActive = readFullscreenActive()
        applyPresence()
        // A space-change / activation / presentation-options notification can
        // fire before the covering window is dropped from the window list, so
        // the first read can still report fullscreen. Arm a short, bounded
        // settle burst to catch up — native full-screen enter/exit both fire
        // an observer, so restore never has to survive a silent gap; it only
        // has to outlast the window list's own catch-up delay after a signal
        // already fired.
        if fullscreenActive {
            armFullscreenSettleRetries()
        } else {
            cancelFullscreenSettleRetries()
        }
    }

    /// Arms a bounded, coalesced settle burst after an environment signal.
    /// Cancels any burst already in flight and restarts the delay sequence
    /// from the top — a new signal supersedes a stale one rather than
    /// stacking with it.
    private func armFullscreenSettleRetries() {
        fullscreenSettleWorkItem?.cancel()
        fullscreenSettleWorkItem = nil
        fullscreenSettleAttempt = 0
        scheduleNextFullscreenSettle()
    }

    /// Schedules the next `DynamicIslandFullscreenRetryPolicy.settleDelays`
    /// tick. Each tick re-reads the window list and calls `applyPresence()`;
    /// if still full-screen and delays remain it schedules the next one, and
    /// after the last delay it simply stops — this is a bounded burst, not a
    /// loop.
    private func scheduleNextFullscreenSettle() {
        guard fullscreenSettleAttempt < Self.fullscreenSettleDelays.count else { return }
        let delay = Self.fullscreenSettleDelays[fullscreenSettleAttempt]
        fullscreenSettleAttempt += 1
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.fullscreenSettleWorkItem = nil
            guard self.isEnabled else { return }
            self.fullscreenActive = self.readFullscreenActive()
            self.applyPresence()
            guard self.fullscreenActive else { return }
            self.scheduleNextFullscreenSettle()
        }
        fullscreenSettleWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    private func cancelFullscreenSettleRetries() {
        fullscreenSettleWorkItem?.cancel()
        fullscreenSettleWorkItem = nil
        fullscreenSettleAttempt = 0
    }

    /// Hide only when a full-screen app occupies the island's own screen.
    /// Presentation options are the single-display fallback.
    private func readFullscreenActive() -> Bool {
        let options = NSApp.currentSystemPresentationOptions
        let presentation = DynamicIslandFullscreenPolicy.presentationLooksFullscreen(
            containsFullScreen: options.contains(.fullScreen),
            hidesMenuBar: options.contains(.hideMenuBar),
            hidesDock: options.contains(.hideDock)
        )
        return DynamicIslandFullscreenPolicy.isFullscreenAppActive(
            windowCoversIslandScreen: islandScreenHasFullscreenWindow(),
            presentationLooksFullscreen: presentation,
            screenCount: NSScreen.screens.count
        )
    }

    private static let fullscreenIgnoredWindowOwners: Set<String> = [
        "Dock", "Window Server", "WindowServer", "SystemUIServer",
        "Control Center", "Notification Centre", "Notification Center",
    ]

    /// `nil` when the window list is unavailable so the caller can fall back.
    private func islandScreenHasFullscreenWindow() -> Bool? {
        guard let screen = targetScreen(),
              let primary = NSScreen.screens.first
        else { return false }
        let cgOptions = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
        guard let infoList = CGWindowListCopyWindowInfo(cgOptions, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }

        let screenFrame = screen.frame
        let primaryMaxY = primary.frame.maxY
        // With the menu bar set to auto-hide, `visibleFrame` reaches the
        // physical top edge and every maximized window "covers the screen
        // including the menu bar". Geometry alone can then no longer prove
        // full-screen — pass the reserved strip height through so the policy
        // can reject the false positive (issue #507).
        let menuBarHeight = screenFrame.maxY - screen.visibleFrame.maxY

        for info in infoList {
            if let alpha = info[kCGWindowAlpha as String] as? NSNumber, alpha.doubleValue <= 0 {
                continue
            }
            // Dock (20) / menu bar (24) / Control Center (25) can report
            // screen-sized frames, and so can the negative-layer surfaces
            // behind the desktop. Screensaver (>= 1000) should still hide the
            // island. The owner check below is a belt-and-braces English-only
            // fallback — the layer is what actually filters (issue #507).
            let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            guard DynamicIslandFullscreenPolicy.windowLayerCanCoverIslandScreen(layer) else { continue }
            if let owner = info[kCGWindowOwnerName as String] as? String,
               Self.fullscreenIgnoredWindowOwners.contains(owner) {
                continue
            }
            // kCGWindowBounds is a CFDictionary of NSNumbers; a Swift
            // `[String: CGFloat]` cast drops every real window.
            guard let boundsDict = info[kCGWindowBounds as String] as? NSDictionary else { continue }
            var quartzRect = CGRect.zero
            guard CGRectMakeWithDictionaryRepresentation(boundsDict, &quartzRect) else { continue }

            let windowBounds = DynamicIslandFullscreenPolicy.appKitRect(
                fromQuartz: quartzRect,
                primaryMaxY: primaryMaxY
            )
            if DynamicIslandFullscreenPolicy.windowCoversScreenIncludingMenuBar(
                windowBounds: windowBounds,
                screenFrame: screenFrame,
                menuBarHeight: menuBarHeight
            ) {
                return true
            }
        }
        return false
    }

    /// Recompute geometry and re-pin to the current target screen (display
    /// plug/unplug, lid close, resolution change).
    private func repositionPanel() {
        guard let panel, let screen = targetScreen() else { return }
        let geo = geometry(for: screen)
        if geo != state.geometry { state.geometry = geo }
        let frame = panelFrame(on: screen)
        if state.panelSize != frame.size { state.panelSize = frame.size }
        panel.setFrame(frame, display: true)
        panel.updateHitRegion()
    }

    // MARK: - Panel

    private func makePanel() -> IslandPanel {
        // Without this the window server drops every NSCursor change we make
        // while another app is frontmost — hover cursors would never show.
        BackgroundCursorOverride.enable()

        // Hosting *controller* (not a bare NSHostingView as contentView): on a
        // borderless panel the latter routes SwiftUI invalidations into
        // NSWindow constraint updates, which throws and crashes (see
        // DesktopPetWindowController for the original diagnosis).
        let hostingController = NSHostingController(
            rootView: DynamicIslandView(
                viewModel: viewModel,
                state: state,
                onWingWidthChanged: { [weak self] width in
                    Task { @MainActor [weak self] in self?.applyWingWidth(width) }
                },
                onExpandedHeightChanged: { [weak self] height in
                    Task { @MainActor [weak self] in self?.applyExpandedHeight(height) }
                }
            )
        )

        // Never let the hosting controller drive the window size — the
        // controller owns the frame exclusively.
        if #available(macOS 13.0, *) {
            hostingController.sizingOptions = []
        } else {
            // Before `sizingOptions` existed, keep the hosted view on the
            // explicit frame/autoresizing path instead of Auto Layout trying
            // to resize the borderless panel to SwiftUI's intrinsic content.
            hostingController.view.translatesAutoresizingMaskIntoConstraints = true
        }
        self.hostingController = hostingController

        let panelSize = state.panelSize
        let panel = IslandPanel(
            contentRect: NSRect(origin: .zero, size: panelSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.islandController = self

        // Wrap the hosting view in a hit-test filter: the panel stays at the
        // expanded size, but only the black shape accepts mouse events so the
        // transparent chrome doesn't block the menu bar underneath.
        let hitView = IslandHitView(frame: NSRect(origin: .zero, size: panelSize))
        hitView.autoresizingMask = [.width, .height]
        hitView.islandController = self
        hostingController.view.frame = hitView.bounds
        hostingController.view.autoresizingMask = [.width, .height]
        hitView.addSubview(hostingController.view)
        panel.contentView = hitView
        panel.hitView = hitView

        panel.isOpaque = false
        panel.backgroundColor = .clear
        // The island draws its own SwiftUI shadow when expanded; a window
        // shadow would trace the transparent frame rect instead.
        panel.hasShadow = false
        // Sit above the menu bar so the island hugs the notch, ride along to
        // every regular Space, stay out of Cmd-Tab. Omit .fullScreenAuxiliary
        // so the island does not overlay another app's full-screen Space.
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.acceptsMouseMovedEvents = true
        panel.isMovableByWindowBackground = false
        return panel
    }
}

/// Never steals key/main status — the island is display-only chrome.
private final class IslandPanel: NSPanel, CursorHitScoping {
    weak var islandController: DynamicIslandController?
    weak var hitView: IslandHitView?

    /// Only the black island shape counts as "ours" for cursor arbitration —
    /// the panel frame is mostly transparent click-through chrome overhanging
    /// other apps' windows.
    func containsInteractiveScreenPoint(_ screenPoint: NSPoint) -> Bool {
        let local = convertPoint(fromScreen: screenPoint)
        return (islandController?.hitRectInPanel() ?? .zero).contains(local)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// AppKit answers `.cursorUpdate` events by resetting to the arrow cursor.
    /// On a non-activating panel that reset always wins over `NSCursor.set()`
    /// calls from SwiftUI hover handlers, so the pointing hand never shows.
    /// Swallow the event and re-assert whatever the hover coordinator wants.
    override func sendEvent(_ event: NSEvent) {
        if event.type == .cursorUpdate {
            PointerCursorCoordinator.shared.apply()
            return
        }
        super.sendEvent(event)
    }

    func updateHitRegion() {
        hitView?.hitRegion = islandController?.hitRectInPanel() ?? .zero
    }
}

/// Filters hit-testing to the black island rect. Points outside return nil so
/// AppKit delivers the event to whatever is underneath (menu bar, desktop).
private final class IslandHitView: NSView {
    weak var islandController: DynamicIslandController?
    var hitRegion: NSRect = .zero {
        didSet {
            guard hitRegion != oldValue else { return }
            rebuildHoverTrackingArea()
        }
    }

    private var hoverTrackingArea: NSTrackingArea?

    private func rebuildHoverTrackingArea() {
        if let hoverTrackingArea {
            removeTrackingArea(hoverTrackingArea)
            self.hoverTrackingArea = nil
        }
        guard !hitRegion.isEmpty else { return }

        let trackingArea = NSTrackingArea(
            rect: hitRegion,
            options: [.mouseEnteredAndExited, .activeAlways, .enabledDuringMouseDrag],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(trackingArea)
        hoverTrackingArea = trackingArea
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // `point` is in this view's coordinate system (origin bottom-left).
        guard hitRegion.contains(point) else { return nil }
        // The hardware-notch gap has no SwiftUI child content. Claim it at
        // the AppKit container level so it is just as interactive as either
        // populated metric wing, while outer transparent chrome still passes
        // through to the menu bar.
        return super.hitTest(point) ?? self
    }

    override func mouseEntered(with event: NSEvent) {
        islandController?.handleHover(true)
    }

    override func mouseExited(with event: NSEvent) {
        islandController?.handleHover(false)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func rightMouseDown(with event: NSEvent) {
        StatusBarController.showContextMenuFromIsland(event: event, view: self)
    }
}
