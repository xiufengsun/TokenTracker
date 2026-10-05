import AppKit
import Combine
import SwiftUI

private struct MenuBarDisplayValue {
    let id: String
    let label: String
    let value: String
}

@MainActor
final class StatusBarController: NSObject {

    private static weak var instance: StatusBarController?

    /// 在显示 `NSAlert` / sheet 前调用：收起菜单栏 Popover，否则其 `NSPanel` 常会盖住更新提示。
    static func prepareForSystemAlert() {
        instance?.closePopoverForModalAlert()
    }

    /// Popover height adapts to content: shorter on macOS < 13 where the Charts module is unavailable.
    private static let popoverHeight: CGFloat = {
        if #available(macOS 13, *) { return 720 }
        return 560
    }()

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private var popoverAnchorWindow: NSWindow?
    private var popoverDismissMonitor: Any?
    /// systemUptime when the popover was last shown — the debounce reference for
    /// duplicated status-button action dispatches (full-screen menu bar reveal).
    private var popoverShownAt: TimeInterval = 0
    /// One-shot latch so the full-screen activation recovery never loops.
    private var popoverReshowAttempted = false
    private let viewModel: DashboardViewModel
    private let serverManager: ServerManager
    private let launchAtLoginManager: LaunchAtLoginManager
    private let desktopPetController: DesktopPetWindowController
    private let dynamicIslandController: DynamicIslandController
    private var animator: MenuBarAnimator?
    private let queueActivityMonitor = QueueActivityMonitor()
    private let accountUploadMonitor = QueueActivityMonitor(
        queueURL: FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".tokentracker/tracker/queue.state.json"),
        settleDelay: BackgroundRefreshPolicy.defaultAccountUploadVisibilityDelay,
        publishInitialState: true
    )
    private let confettiController = ScreenConfettiOverlayController()
    private var cancellables = Set<AnyCancellable>()
    /// While the status-item menu is open, refreshes the “Check for Updates” row when download/check status changes.
    private var updateMenuStatusObserver: NSObjectProtocol?
    private weak var trackedStatusMenu: NSMenu?
    private static let updateMenuItemTag = 4_242

    private let menuBarHeight: CGFloat = 22
    private let menuBarIconSize = NSSize(width: 22, height: 22)
    private let emptyAttributedTitle = NSAttributedString(string: "")
    private var isUpdatingDisplay = false
    private var isHideIconPromptPending = false

    private static let showStatsKey = "MenuBarShowStats"
    private var showStats: Bool {
        get { UserDefaults.standard.object(forKey: Self.showStatsKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.showStatsKey)
            updateStatsDisplay()
        }
    }

    // MARK: - Init

    init(viewModel: DashboardViewModel,
         serverManager: ServerManager,
         launchAtLoginManager: LaunchAtLoginManager,
         desktopPetController: DesktopPetWindowController,
         dynamicIslandController: DynamicIslandController) {
        self.viewModel = viewModel
        self.serverManager = serverManager
        self.launchAtLoginManager = launchAtLoginManager
        self.desktopPetController = desktopPetController
        self.dynamicIslandController = dynamicIslandController
        super.init()

        Self.instance = self

        setupStatusItem()
        setupPopover()
        observeSyncState()
        observeNativeBridgeSettings()
        observeApplicationActivity()
        observeWeeklyLimitReset()
        scheduleDebugLimitResetCelebrationIfRequested()
    }

    // MARK: - Limit-reset celebration

    /// Listen for reset detection and present the independently enabled feedback.
    private func observeWeeklyLimitReset() {
        NotificationCenter.default.addObserver(
            forName: .weeklyLimitReset,
            object: nil,
            queue: .main
        ) { [weak self] note in
            let event = note.object as? LimitResetEvent
            MainActor.assumeIsolated { self?.celebrateLimitReset(event: event) }
        }
    }

    private func celebrateLimitReset(event: LimitResetEvent?) {
        let showsToast = WeeklyLimitResetDetector.toastEnabled()
        let showsConfetti = WeeklyLimitResetDetector.confettiEnabled()
        guard showsToast || showsConfetti else { return }
        let name = event.map { LimitsSettingsStore.displayNames[$0.provider] ?? $0.provider.capitalized }
        confettiController.play(
            message: Strings.limitResetCelebration(provider: name, window: event?.windowLabel),
            provider: event?.provider,
            showsToast: showsToast,
            showsConfetti: showsConfetti
        )
    }

    /// Debug-only launch hook for exercising the real multi-display overlay without
    /// waiting hours or days for a provider quota to roll over.
    private func scheduleDebugLimitResetCelebrationIfRequested() {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        guard environment["TOKENTRACKER_DEBUG_LIMIT_RESET_CELEBRATION"] == "1" else { return }
        let provider = environment["TOKENTRACKER_DEBUG_LIMIT_RESET_PROVIDER"] ?? "antigravity"
        let providerName = LimitsSettingsStore.displayNames[provider] ?? provider.capitalized
        let delay = environment["TOKENTRACKER_DEBUG_LIMIT_RESET_DELAY"].flatMap(Double.init) ?? 2
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            let showsToast = WeeklyLimitResetDetector.toastEnabled()
            let showsConfetti = WeeklyLimitResetDetector.confettiEnabled()
            self?.confettiController.play(
                message: Strings.limitResetCelebration(provider: providerName, window: "Weekly"),
                provider: provider,
                showsToast: showsToast,
                showsConfetti: showsConfetti
            )
        }
        #endif
    }

    private func closePopoverForModalAlert() {
        closePopoverIfShown()
    }

    private func closePopoverIfShown() {
        viewModel.setPopoverVisible(false)
        if popover.isShown {
            popover.performClose(nil)
        }
        popoverAnchorWindow?.orderOut(nil)
    }

    /// React to setting changes pushed by the dashboard SettingsPage via NativeBridge.
    /// Re-reads UserDefaults and refreshes the menu-bar visuals (stats badge + animation state).
    private func observeNativeBridgeSettings() {
        NotificationCenter.default.addObserver(
            forName: .nativeSettingsChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.animator?.applyCurrentState()
                self.updateStatsDisplay()
                self.updateMenuBarIconVisibility()
            }
        }
    }

    static let hideMenuBarIconKey = "HideMenuBarIcon"
    private static let hideIconPromptShownKey = "HideMenuBarIconPromptShown"

    static func setMenuBarIconHidden(_ hidden: Bool) {
        instance?.updateMenuBarIconVisibility(userRequestedHide: hidden)
    }

    /// One-time native prompt after the island is enabled: offer to hide the
    /// menu bar icon so both surfaces don't crowd the menu bar.
    static func offerHideIconPromptAfterIslandEnabled() {
        instance?.maybeOfferHidingMenuBarIcon()
    }

    private func maybeOfferHidingMenuBarIcon() {
        let defaults = UserDefaults.standard
        let islandEnabled = defaults.bool(forKey: DynamicIslandController.enabledDefaultsKey)
        let hideRequested = defaults.bool(forKey: Self.hideMenuBarIconKey)
        guard !isHideIconPromptPending,
              MenuBarSurfacePolicy.shouldOfferHidePrompt(
                  promptShown: defaults.bool(forKey: Self.hideIconPromptShownKey),
                  hideRequested: hideRequested,
                  islandEnabled: islandEnabled
              ) else { return }

        // Let the island appear first so the prompt refers to something visible.
        isHideIconPromptPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self else { return }
            self.isHideIconPromptPending = false

            let islandEnabled = defaults.bool(forKey: DynamicIslandController.enabledDefaultsKey)
            let hideRequested = defaults.bool(forKey: Self.hideMenuBarIconKey)
            guard MenuBarSurfacePolicy.shouldOfferHidePrompt(
                promptShown: defaults.bool(forKey: Self.hideIconPromptShownKey),
                hideRequested: hideRequested,
                islandEnabled: islandEnabled
            ) else { return }

            defaults.set(true, forKey: Self.hideIconPromptShownKey)
            let alert = NSAlert()
            alert.messageText = Strings.alertHideIconTitle
            alert.informativeText = Strings.alertHideIconMessage
            alert.alertStyle = .informational
            alert.addButton(withTitle: Strings.alertHideIconConfirm)
            alert.addButton(withTitle: Strings.alertHideIconKeep)
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn {
                self.updateMenuBarIconVisibility(userRequestedHide: true)
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
                NativeBridge.shared.pushSettings()
            }
        }
    }

    func updateMenuBarIconVisibility(userRequestedHide: Bool? = nil) {
        let hideRequested = userRequestedHide ?? UserDefaults.standard.bool(forKey: Self.hideMenuBarIconKey)
        if let userRequestedHide {
            UserDefaults.standard.set(userRequestedHide, forKey: Self.hideMenuBarIconKey)
        }
        let islandEnabled = UserDefaults.standard.bool(forKey: DynamicIslandController.enabledDefaultsKey)
        // Never leave the user with zero UI: only hide menu bar icon if Dynamic Island is active.
        let wasVisible = statusItem.isVisible
        statusItem.isVisible = MenuBarSurfacePolicy.isIconVisible(
            hideRequested: hideRequested,
            islandEnabled: islandEnabled
        )
        animator?.updatesButton = statusItem.isVisible
        // Frames skipped the button while hidden; catch it up so a paused
        // animation (sleeping, reduced motion) doesn't show a stale icon.
        if animator != nil, statusItem.isVisible, !wasVisible {
            updateStatsDisplay()
        }
    }

    private func observeApplicationActivity() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: NSApp,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.closePopoverIfShown() }
        }
    }

    // MARK: - Status Item

    static var currentMenuBarIcon: NSImage? {
        instance?.animator?.currentImage
    }

    private func setupStatusItem() {
        guard let button = statusItem.button else { return }

        let image = NSImage(named: "MenuBarIcon")
        image?.isTemplate = true
        button.image = image

        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.action = #selector(handleClick(_:))
        button.target = self
        updateMenuBarIconVisibility()

        animator = MenuBarAnimator(button: button)
        animator?.updatesButton = statusItem.isVisible
        animator?.onImageUpdated = { [weak self] image in
            guard let self else { return }
            // Hidden status item (island-only setup): the composite is never
            // seen, so skip rebuilding it every frame. `updateMenuBarIconVisibility`
            // re-composites when the item comes back.
            if self.statusItem.isVisible, self.showStats, !self.buildMenuBarDisplayValues().isEmpty {
                self.updateStatsDisplay()
            }
            NotificationCenter.default.post(name: .menuBarIconFrameUpdated, object: image)
        }

        // Real-time activity: queue.jsonl appends make the runner icon sprint.
        queueActivityMonitor.onActivity = { [weak self] in
            self?.animator?.noteActivity()
        }
        // Publish committed usage without turning every queue write into a full
        // dashboard + widget refresh. QueueActivityMonitor coalesces bursts.
        queueActivityMonitor.onSettledActivity = { [weak self] in
            guard let self else { return }
            let summaries = self.selectedMenuBarSummaries()
            Task { @MainActor [weak self] in
                await self?.viewModel.refreshAfterQueueChange(menuBarSummaries: summaries)
            }
        }
        queueActivityMonitor.start()

        // Cross-device account summaries are authoritative only after upload
        // advances queue.state.json. Local queue writes happen earlier.
        accountUploadMonitor.onSettledActivity = { [weak self] in
            guard let self else { return }
            let summaries = self.selectedMenuBarSummaries()
            Task { @MainActor [weak self] in
                await self?.viewModel.refreshAfterAccountUpload(menuBarSummaries: summaries)
            }
        }
        accountUploadMonitor.start()

        updateStatsDisplay()
    }

    private func selectedMenuBarSummaries() -> MenuBarSummarySelection {
        var summaries = showStats
            ? MenuBarDisplayPreferences.summarySelection(for: MenuBarDisplayPreferences.read())
            : MenuBarSummarySelection()
        // The floating pet is another always-visible consumer of today and
        // rolling usage. When menu-bar stats are hidden, returning an empty
        // selection here made queue writes animate the pet but left its usage
        // numbers stale until the dashboard opened or Sync Now was clicked.
        if desktopPetController.isVisible {
            summaries.formUnion([.today, .rolling])
        }
        return summaries
    }

    /// Single derivation of the animator state from the view model.
    /// Priority: syncing > disconnected > sleeping (no tokens today) > idle.
    private func refreshAnimatorState() {
        let state: MenuBarAnimator.State
        if viewModel.isSyncing {
            state = .syncing
        } else if !viewModel.serverOnline {
            state = .disconnected
        } else if viewModel.todayTokens == 0 {
            state = .sleeping
        } else {
            state = .idle
        }
        animator?.setState(state)
    }

    private func observeSyncState() {
        viewModel.$isSyncing
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshAnimatorState() }
            .store(in: &cancellables)

        // Observe server online status for disconnected icon
        viewModel.$serverOnline
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshAnimatorState() }
            .store(in: &cancellables)

        // Update stats text when today data changes (also drives the
        // sleeping/idle split for the runner icons)
        viewModel.$todaySummary
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.refreshAnimatorState()
                self?.updateStatsDisplay()
            }
            .store(in: &cancellables)

        // Re-render pet frames when the selected character changes
        PetCharacterStore.shared.$character
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.animator?.applyCurrentState() }
            .store(in: &cancellables)

        viewModel.$rollingSummary
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateStatsDisplay() }
            .store(in: &cancellables)

        viewModel.$totalSummary
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateStatsDisplay() }
            .store(in: &cancellables)

        viewModel.$usageLimits
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateStatsDisplay() }
            .store(in: &cancellables)
    }

    private func updateStatsDisplay() {
        guard !isUpdatingDisplay else { return }
        isUpdatingDisplay = true
        defer { isUpdatingDisplay = false }
        guard let button = statusItem.button else { return }
        let displayItems = buildMenuBarDisplayValues()

        // Freeze statusItem.length while the popover is shown: stats publishers and
        // animator frames both call this method, and a flicker in length drags the
        // popover anchor sideways. The didCloseNotification observer realigns width
        // after the popover closes.
        let canResizeStatusItem = !popover.isShown

        if showStats && !displayItems.isEmpty {
            let signature = statsTextSignature(displayItems)
            let textLayer: (image: NSImage, width: CGFloat)
            if let cached = statsTextCache, cached.signature == signature {
                textLayer = (cached.image, cached.width)
            } else {
                let rendered = makeStatsTextImage(items: displayItems)
                statsTextCache = (signature, rendered.image, rendered.width)
                textLayer = rendered
            }
            let compositeImage = makeDisplayMenuBarImage(
                icon: animator?.currentImage ?? button.image,
                textImage: textLayer.image,
                textWidth: textLayer.width
            )

            button.title = ""
            button.attributedTitle = emptyAttributedTitle
            button.imagePosition = .imageOnly
            button.image = compositeImage
            if canResizeStatusItem {
                statusItem.length = compositeImage.size.width
            }
        } else {
            button.title = ""
            button.attributedTitle = emptyAttributedTitle
            button.imagePosition = .imageOnly
            if canResizeStatusItem {
                statusItem.length = NSStatusItem.squareLength
            }
            animator?.applyCurrentState()
        }
    }

    private func buildMenuBarDisplayValues() -> [MenuBarDisplayValue] {
        // Filter here as well as in `availableItemIDs`: a dashboard-applied
        // snapshot re-renders via `.nativeSettingsChanged` before the stored
        // selection is re-normalized, so the stored ids can still contain a
        // freshly hidden provider at this point.
        let hiddenProviders = LimitsSettingsStore.shared.hiddenProviders
        return MenuBarDisplayPreferences.read().compactMap { id -> MenuBarDisplayValue? in
            guard let metric = MenuBarDisplayMetric(rawValue: id) else { return nil }
            if let provider = metric.providerKey, hiddenProviders.contains(provider) { return nil }

            switch metric {
            case .todayTokens:
                guard viewModel.todaySummary != nil else { return nil }
                return MenuBarDisplayValue(
                    id: id,
                    label: metric.menuLabel,
                    value: TokenFormatter.formatCompact(viewModel.todayTokens)
                )
            case .todayCost:
                guard viewModel.todaySummary != nil else { return nil }
                return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: viewModel.todayCost)
            case .last7dTokens:
                guard viewModel.rollingSummary != nil else { return nil }
                return MenuBarDisplayValue(
                    id: id,
                    label: metric.menuLabel,
                    value: TokenFormatter.formatCompact(viewModel.last7dTokens)
                )
            case .totalTokens:
                guard viewModel.totalSummary != nil else { return nil }
                return MenuBarDisplayValue(
                    id: id,
                    label: metric.menuLabel,
                    value: TokenFormatter.formatCompact(viewModel.totalTokens)
                )
            case .totalCost:
                guard viewModel.totalSummary != nil else { return nil }
                return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: viewModel.totalCost)
            case .claude5h:
                guard let window = viewModel.usageLimits?.claude.fiveHour,
                      viewModel.usageLimits?.claude.configured == true,
                      viewModel.usageLimits?.claude.error == nil else { return nil }
                return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: formatLimitWithReset(window.utilization, resetIso: window.resetsAt))
            case .claude7d:
                guard let window = viewModel.usageLimits?.claude.sevenDay,
                      viewModel.usageLimits?.claude.configured == true,
                      viewModel.usageLimits?.claude.error == nil else { return nil }
                return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: formatLimitWithReset(window.utilization, resetIso: window.resetsAt))
            case .codex5h:
                return codexLimitValue(id: id, metric: metric, window: viewModel.usageLimits?.codex.primaryWindow)
            case .codex7d:
                return codexLimitValue(id: id, metric: metric, window: viewModel.usageLimits?.codex.secondaryWindow)
            case .codexCredits:
                return codexCreditLimitValue(id: id, metric: metric, window: viewModel.usageLimits?.codex.creditWindow)
            case .codexSpark5h:
                return codexLimitValue(id: id, metric: metric, window: viewModel.usageLimits?.codex.sparkPrimaryWindow)
            case .codexSpark7d:
                return codexLimitValue(id: id, metric: metric, window: viewModel.usageLimits?.codex.sparkSecondaryWindow)
            case .cursorPlan:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.cursor.configured, error: viewModel.usageLimits?.cursor.error, window: viewModel.usageLimits?.cursor.primaryWindow)
            case .cursorAuto:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.cursor.configured, error: viewModel.usageLimits?.cursor.error, window: viewModel.usageLimits?.cursor.secondaryWindow)
            case .cursorAPI:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.cursor.configured, error: viewModel.usageLimits?.cursor.error, window: viewModel.usageLimits?.cursor.tertiaryWindow)
            case .geminiPro:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.gemini.configured, error: viewModel.usageLimits?.gemini.error, window: viewModel.usageLimits?.gemini.primaryWindow)
            case .geminiFlash:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.gemini.configured, error: viewModel.usageLimits?.gemini.error, window: viewModel.usageLimits?.gemini.secondaryWindow)
            case .geminiLite:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.gemini.configured, error: viewModel.usageLimits?.gemini.error, window: viewModel.usageLimits?.gemini.tertiaryWindow)
            case .kimiWeekly:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.kimi?.configured, error: viewModel.usageLimits?.kimi?.error, window: viewModel.usageLimits?.kimi?.primaryWindow)
            case .kimi5h:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.kimi?.configured, error: viewModel.usageLimits?.kimi?.error, window: viewModel.usageLimits?.kimi?.secondaryWindow)
            case .kimiTotal:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.kimi?.configured, error: viewModel.usageLimits?.kimi?.error, window: viewModel.usageLimits?.kimi?.tertiaryWindow)
            case .kiroMonth:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.kiro.configured, error: viewModel.usageLimits?.kiro.error, window: viewModel.usageLimits?.kiro.primaryWindow)
            case .kiroBonus:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.kiro.configured, error: viewModel.usageLimits?.kiro.error, window: viewModel.usageLimits?.kiro.secondaryWindow)
            case .grokMonth:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.grok?.configured, error: viewModel.usageLimits?.grok?.error, window: viewModel.usageLimits?.grok?.primaryWindow)
            case .grokOndemand:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.grok?.configured, error: viewModel.usageLimits?.grok?.error, window: viewModel.usageLimits?.grok?.secondaryWindow)
            case .copilotPremium:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.copilot?.configured, error: viewModel.usageLimits?.copilot?.error, window: viewModel.usageLimits?.copilot?.primaryWindow)
            case .copilotChat:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.copilot?.configured, error: viewModel.usageLimits?.copilot?.error, window: viewModel.usageLimits?.copilot?.secondaryWindow)
            case .antigravityClaudeWeekly:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.antigravity.configured, error: viewModel.usageLimits?.antigravity.error, window: viewModel.usageLimits?.antigravity.primaryWindow)
            case .antigravityClaude5h:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.antigravity.configured, error: viewModel.usageLimits?.antigravity.error, window: viewModel.usageLimits?.antigravity.secondaryWindow)
            case .antigravityGeminiWeekly:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.antigravity.configured, error: viewModel.usageLimits?.antigravity.error, window: viewModel.usageLimits?.antigravity.tertiaryWindow)
            case .antigravityGemini5h:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.antigravity.configured, error: viewModel.usageLimits?.antigravity.error, window: viewModel.usageLimits?.antigravity.quaternaryWindow)
            case .zcodeGlm52:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.zcode?.configured, error: viewModel.usageLimits?.zcode?.error, window: viewModel.usageLimits?.zcode?.primaryWindow)
            case .zcodeGlm5Turbo:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.zcode?.configured, error: viewModel.usageLimits?.zcode?.error, window: viewModel.usageLimits?.zcode?.secondaryWindow)
            case .opencodeGo5h:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.opencodeGo?.configured, error: viewModel.usageLimits?.opencodeGo?.error, window: viewModel.usageLimits?.opencodeGo?.primaryWindow)
            case .opencodeGoWeekly:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.opencodeGo?.configured, error: viewModel.usageLimits?.opencodeGo?.error, window: viewModel.usageLimits?.opencodeGo?.secondaryWindow)
            case .opencodeGoMonthly:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.opencodeGo?.configured, error: viewModel.usageLimits?.opencodeGo?.error, window: viewModel.usageLimits?.opencodeGo?.tertiaryWindow)
            case .commandCode5h:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.commandCode?.configured, error: viewModel.usageLimits?.commandCode?.error, window: viewModel.usageLimits?.commandCode?.primaryWindow)
            case .commandCodeWeekly:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.commandCode?.configured, error: viewModel.usageLimits?.commandCode?.error, window: viewModel.usageLimits?.commandCode?.secondaryWindow)
            case .qoderQuota:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.qoder?.configured, error: viewModel.usageLimits?.qoder?.error, window: viewModel.usageLimits?.qoder?.primaryWindow)
            case .qoderUltimate:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.qoder?.configured, error: viewModel.usageLimits?.qoder?.error, window: viewModel.usageLimits?.qoder?.secondaryWindow)
            case .devinDaily:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.devin?.configured, error: viewModel.usageLimits?.devin?.error, window: viewModel.usageLimits?.devin?.primaryWindow)
            case .devinWeekly:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.devin?.configured, error: viewModel.usageLimits?.devin?.error, window: viewModel.usageLimits?.devin?.secondaryWindow)
            }
        }
    }

    private func codexLimitValue(id: String, metric: MenuBarDisplayMetric, window: CodexWindow?) -> MenuBarDisplayValue? {
        let value = window.map { formatIntPercentWithReset($0.usedPercent, resetEpoch: $0.resetAt) }
        return genericLimitValue(
            id: id,
            metric: metric,
            configured: viewModel.usageLimits?.codex.configured,
            error: viewModel.usageLimits?.codex.error,
            value: value
        )
    }

    private func codexCreditLimitValue(id: String, metric: MenuBarDisplayMetric, window: CodexCreditWindow?) -> MenuBarDisplayValue? {
        let value = window.map { formatLimitWithReset($0.usedPercent, resetEpoch: $0.resetAt) }
        return genericLimitValue(
            id: id,
            metric: metric,
            configured: viewModel.usageLimits?.codex.configured,
            error: viewModel.usageLimits?.codex.error,
            value: value
        )
    }

    private func genericLimitValue(id: String, metric: MenuBarDisplayMetric, configured: Bool?, error: String?, window: GenericLimitWindow?) -> MenuBarDisplayValue? {
        let value = window.map { formatLimitWithReset($0.usedPercent, resetIso: $0.resetAt) }
        return genericLimitValue(id: id, metric: metric, configured: configured, error: error, value: value)
    }

    private func genericLimitValue(id: String, metric: MenuBarDisplayMetric, configured: Bool?, error: String?, value: String?) -> MenuBarDisplayValue? {
        guard configured == true, error == nil, let value else { return nil }
        return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: value)
    }

    private func formatLimitPercent(_ value: Double) -> String {
        // Shared with the Dynamic Island wings so both surfaces render the
        // same number for the same window (display mode + rounding).
        LimitsSettingsStore.formatPercentText(value)
    }

    // ISO8601DateFormatter is expensive to allocate, and updateStatsDisplay
    // reaches this once per limit item — up to ~12x/s while a runner icon
    // sprints with stats visible. Share immutable instances instead.
    private static let iso8601FractionalFormatter: ISO8601DateFormatter = {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fmt
    }()
    private static let iso8601PlainFormatter: ISO8601DateFormatter = {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime]
        return fmt
    }()

    private func formatResetTime(iso: String?) -> String? {
        guard let iso else { return nil }
        let date = Self.iso8601FractionalFormatter.date(from: iso)
            ?? Self.iso8601PlainFormatter.date(from: iso)
        guard let date else { return nil }
        let s = date.timeIntervalSince(Date())
        guard s > 0 else { return "now" }
        let d = Int(s) / 86400
        if d > 0 { return "\(d)d" }
        let h = Int(s) / 3600
        if h > 0 { return "\(h)h" }
        return "\(Int(s) / 60)m"
    }

    private func formatLimitWithReset(_ utilization: Double, resetIso: String?) -> String {
        let pct = formatLimitPercent(utilization)
        guard let reset = formatResetTime(iso: resetIso) else { return pct }
        return "\(pct) · \(reset)"
    }

    private func formatLimitWithReset(_ utilization: Double, resetEpoch: Int?) -> String {
        let pct = formatLimitPercent(utilization)
        guard let reset = formatResetTime(epoch: resetEpoch) else { return pct }
        return "\(pct) · \(reset)"
    }

    private func formatResetTime(epoch: Int?) -> String? {
        guard let epoch else { return nil }
        let date = Date(timeIntervalSince1970: TimeInterval(epoch))
        let s = date.timeIntervalSince(Date())
        guard s > 0 else { return "now" }
        let d = Int(s) / 86400
        if d > 0 { return "\(d)d" }
        let h = Int(s) / 3600
        if h > 0 { return "\(h)h" }
        return "\(Int(s) / 60)m"
    }

    private func formatIntPercentWithReset(_ usedPercent: Int, resetEpoch: Int?) -> String {
        let clamped = min(max(usedPercent, 0), 100)
        let displayed = LimitsSettingsStore.shared.displayMode == .remaining ? (100 - clamped) : clamped
        let pct = "\(displayed)%"
        guard let reset = formatResetTime(epoch: resetEpoch) else { return pct }
        return "\(pct) · \(reset)"
    }

    /// Cache for the stats text layer. The icon animates (runner sprint is
    /// 12.5fps) and every frame re-composites the menu bar image, but the text
    /// only changes when a displayed value does — re-laying it out per frame
    /// was the menu bar's steady-state main-thread cost.
    private var statsTextCache: (signature: String, image: NSImage, width: CGFloat)?

    private func statsTextSignature(_ items: [MenuBarDisplayValue]) -> String {
        items.map { "\($0.id)\u{1f}\($0.label)\u{1f}\($0.value)" }.joined(separator: "\u{1e}")
    }

    /// Renders just the label/value columns. Geometry matches the previous
    /// single-pass composite: full menu-bar height, columns laid out from x=0.
    private func makeStatsTextImage(items: [MenuBarDisplayValue]) -> (image: NSImage, width: CGFloat) {
        let valueFont = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        let labelFont = NSFont.systemFont(ofSize: 7, weight: .regular)
        let valueColor = NSColor.labelColor
        let labelColor = NSColor.labelColor

        let columns = items.map { item in
            let value = NSAttributedString(string: item.value, attributes: [
                .font: valueFont,
                .foregroundColor: valueColor,
            ])
            let label = NSAttributedString(string: item.label, attributes: [
                .font: labelFont,
                .foregroundColor: labelColor,
            ])
            let width = ceil(max(value.size().width, label.size().width))
            return (value: value, label: label, width: width)
        }

        let trailingPadding: CGFloat = 3
        let lineGap: CGFloat = -1
        let sepGap: CGFloat = 4

        let valueHeight = ceil(max(valueFont.ascender - valueFont.descender, columns.map { $0.value.size().height }.max() ?? 0))
        let labelHeight = ceil(max(labelFont.ascender - labelFont.descender, columns.map { $0.label.size().height }.max() ?? 0))
        let textBlockHeight = valueHeight + lineGap + labelHeight
        let textOriginY = floor((menuBarHeight - textBlockHeight) / 2)
        let labelOriginY = textOriginY
        let valueOriginY = labelOriginY + labelHeight + lineGap

        let columnsWidth = columns.enumerated().reduce(CGFloat(0)) { total, pair in
            let separatorWidth: CGFloat = pair.offset == 0 ? 0 : (sepGap + 1 + sepGap)
            return total + separatorWidth + pair.element.width
        }
        let imageWidth = ceil(columnsWidth + trailingPadding)
        let imageSize = NSSize(width: imageWidth, height: menuBarHeight)

        let image = NSImage(size: imageSize, flipped: false) { [weak self] _ in
            guard let self else { return false }
            var cursorX: CGFloat = 0
            for (index, column) in columns.enumerated() {
                if index > 0 {
                    let sepX = cursorX + sepGap
                    NSColor.labelColor.withAlphaComponent(0.5).setFill()
                    NSRect(x: sepX, y: labelOriginY + 1, width: 0.5, height: textBlockHeight - 2).fill()
                    cursorX = sepX + 1 + sepGap
                }

                let valueRect = NSRect(x: cursorX, y: valueOriginY, width: column.width, height: valueHeight)
                let labelRect = NSRect(x: cursorX, y: labelOriginY, width: column.width, height: labelHeight)
                column.value.draw(in: self.centeredRect(for: column.value, in: valueRect))
                column.label.draw(in: self.centeredRect(for: column.label, in: labelRect))
                cursorX += column.width
            }
            return true
        }
        image.isTemplate = false
        return (image, imageWidth)
    }

    private func makeDisplayMenuBarImage(icon: NSImage?, textImage: NSImage, textWidth: CGFloat) -> NSImage {
        let iconTrailingPadding: CGFloat = 6

        // Respect the icon's own aspect ratio: Clawd frames are 22×22 but the
        // runner cat is 28×18 — squeezing it into the square slot distorts it.
        let iconSize: NSSize = {
            guard let icon, icon.size.width > 0, icon.size.height > 0 else { return menuBarIconSize }
            return icon.size
        }()
        let iconWidth = iconSize.width
        let textOriginX = iconWidth + iconTrailingPadding
        let totalWidth = ceil(textOriginX + textWidth)
        let imageSize = NSSize(width: totalWidth, height: menuBarHeight)

        let image = NSImage(size: imageSize, flipped: false) { [weak self] _ in
            guard let self else { return false }

            if let icon {
                let iconRect = NSRect(
                    origin: NSPoint(x: 0, y: floor((self.menuBarHeight - iconSize.height) / 2)),
                    size: iconSize
                )
                // Pixel-art frames (cat / pet silhouettes) must not be smoothed.
                NSGraphicsContext.current?.imageInterpolation = .none
                // Template icons are black alpha — tint to labelColor for compositing
                if icon.isTemplate {
                    icon.draw(in: iconRect, from: .zero, operation: .sourceOver, fraction: 1)
                    NSColor.labelColor.setFill()
                    iconRect.fill(using: .sourceAtop)
                } else {
                    icon.draw(in: iconRect, from: .zero, operation: .sourceOver, fraction: 1)
                }
                NSGraphicsContext.current?.imageInterpolation = .default
            }

            textImage.draw(at: NSPoint(x: textOriginX, y: 0), from: .zero, operation: .sourceOver, fraction: 1)
            return true
        }

        image.isTemplate = false
        return image
    }

    private func centeredRect(for string: NSAttributedString, in rect: NSRect) -> NSRect {
        let size = string.size()
        return NSRect(
            x: rect.minX + floor((rect.width - size.width) / 2),
            y: rect.minY + floor((rect.height - size.height) / 2),
            width: ceil(size.width),
            height: ceil(size.height)
        )
    }

    // MARK: - Popover

    private func setupPopover() {
        let rootView = DashboardView(viewModel: viewModel, serverManager: serverManager)
            .frame(width: 480, height: Self.popoverHeight)

        // macOS 26+: keep the SwiftUI content transparent (see `PopoverSurfaceBackground`) so the
        // system `NSPopover` chrome's automatic Liquid Glass (`NSGlassEffectView`, verified in the
        // popover's view tree) shows through. Do NOT mount a glass/material backdrop in the content
        // layer — HIG reserves Liquid Glass for the control/navigation layer, and a content-layer
        // fill here only covers the real glass. Older systems keep classic `.regularMaterial`.
        popover.contentViewController = NSHostingController(rootView: rootView)
        popover.behavior = .transient

        // popover 关闭后把 statusItem.length 对齐到最新合成图宽度（显示期间被冻结）。
        NotificationCenter.default.addObserver(
            forName: NSPopover.didCloseNotification,
            object: popover,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.handlePopoverDidClose() }
        }
    }

    private func handlePopoverDidClose() {
        if let popoverDismissMonitor {
            NSEvent.removeMonitor(popoverDismissMonitor)
            self.popoverDismissMonitor = nil
        }
        // Detach the reused popover window from the anchor before hiding the
        // anchor, or the next show inherits a stale child relationship.
        if let popoverWindow = popover.contentViewController?.view.window,
           popoverWindow.parent === popoverAnchorWindow {
            popoverAnchorWindow?.removeChildWindow(popoverWindow)
        }
        viewModel.setPopoverVisible(false)
        popoverAnchorWindow?.orderOut(nil)
        updateStatsDisplay()
    }

    // MARK: - Click Handling

    @objc private func handleClick(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else { return }

        if event.type == .rightMouseUp {
            showMenu()
        } else {
            popoverReshowAttempted = false
            togglePopover()
        }
    }

    private func togglePopover() {
        guard let button = statusItem.button else { return }

        if popover.isShown {
            // The revealed auto-hiding menu bar over a full-screen Space can
            // dispatch the status button's action twice for one physical click
            // (macOS 26), which closed the popover before the user ever saw it.
            // Swallow a "close" toggle arriving right after the popover opened.
            if ProcessInfo.processInfo.systemUptime - popoverShownAt > 0.5 {
                closePopoverIfShown()
            }
            return
        }

        guard let anchorView = positionPopoverAnchorWindow(under: button) else { return }
        // The window's Space assignment happens inside popover.show(). The
        // reused _NSPopoverWindow keeps the desktop it was first ordered in on,
        // and on macOS 26 the post-show insert below is applied too late — the
        // popover then renders only on that one desktop (#506). Mark the reused
        // window for all Spaces *before* showing so the assignment made during
        // show already sees .canJoinAllSpaces.
        if let reusedWindow = popover.contentViewController?.view.window {
            reusedWindow.collectionBehavior.insert([.canJoinAllSpaces, .fullScreenAuxiliary])
        }
        popover.show(relativeTo: anchorView.bounds, of: anchorView, preferredEdge: .minY)
        popoverShownAt = ProcessInfo.processInfo.systemUptime
        viewModel.setPopoverVisible(true)

        // Keep keyboard focus inside the popover while it is visible.
        if let window = popover.contentViewController?.view.window {
            // The _NSPopoverWindow is reused across shows and its default
            // collectionBehavior is only .ignoresCycle — it does NOT inherit the
            // anchor window's .canJoinAllSpaces, so it stays pinned to the Space it
            // was first ordered in on and reopens on the wrong desktop (#372).
            // Use .canJoinAllSpaces (not .moveToActiveSpace, which only migrates on
            // app *activation* and is a no-op when the app is already active, e.g.
            // while the Dashboard window is frontmost). .fullScreenAuxiliary matches
            // the anchor window so the popover also shows over full-screen Spaces.
            window.collectionBehavior.insert([.canJoinAllSpaces, .fullScreenAuxiliary])
            // Over another app's full-screen Space, an inactive app's popover is
            // not admitted onto the Space and never becomes visible even though
            // isVisible reports true (collectionBehavior alone doesn't help — the
            // Space assignment already happened during show). Attach the popover
            // window as a child of the status-bar-level anchor window, which is
            // admitted everywhere, so the popover inherits its Space placement.
            window.level = .statusBar
            if let anchorWindow = popoverAnchorWindow, window.parent == nil {
                anchorWindow.addChildWindow(window, ordered: .above)
            }
            window.orderFrontRegardless()
            window.makeKey()

            // Tahoe renders the automatic NSPopover Liquid Glass subdued while the
            // owning app is inactive, so the full material needs app activation.
            // Activating in the same runloop pass as popover.show() can switch the
            // app's Space/window association mid-anchor and strand the popover on
            // another display (#481), so defer activation until the popover has
            // anchored, gate it on no other window being able to steal key focus,
            // then realign the popover with its anchor if activation displaced it.
            // Older systems use the classic material and stay non-activating
            // unless the popover missed the active Space.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.popover.isShown else { return }
                // Check the popover window itself, not the anchor: the anchor
                // is .canJoinAllSpaces, so it reports admitted on every regular
                // Space even when the popover window stayed pinned to another
                // desktop (#506).
                let popoverAdmitted = self.popover.contentViewController?.view.window?.isOnActiveSpace ?? true
                if popoverAdmitted {
                    if #available(macOS 26, *) {
                        guard self.canActivateForPopoverGlass() else { return }
                        NSApp.activate(ignoringOtherApps: true)
                        DispatchQueue.main.async { [weak self] in
                            self?.realignPopoverWithAnchorIfDisplaced()
                        }
                    }
                } else {
                    // The popover is shown but not admitted onto the active
                    // Space — either that Space is another app's full-screen
                    // Space (admits no window of an inactive app), or the
                    // reused popover window stayed pinned to the desktop it
                    // was first ordered in on (#506). Activation is the only
                    // way in; then re-show it once at the same anchor. This
                    // runs on every macOS version: the child-window attach
                    // alone does not get it onto a full-screen Space on
                    // macOS 15 (#681).
                    NSApp.activate(ignoringOtherApps: true)
                    DispatchQueue.main.async { [weak self] in
                        self?.reshowPopoverOnActiveSpace()
                    }
                }
            }
        }

        // Edge guard: a panel opened under an icon near a screen edge can end
        // up off-screen. Re-check once the window server has committed the
        // show; a correctly placed popover is a no-op.
        DispatchQueue.main.async { [weak self] in
            self?.realignPopoverWithAnchorIfDisplaced()
        }

        popoverDismissMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] _ in
            Task { @MainActor in self?.closePopoverIfShown() }
        }

        // Opportunistically sync stale local data before refreshing the popover.
        Task { await viewModel.refreshForPopoverOpen() }
    }

    // After activating to get admitted onto the active Space, the transient
    // popover may have been dismissed (another app window grabbed key during
    // activation). Re-open it once at the same anchor now that the app is active.
    // If it survived but is still stranded on another desktop (#506), close it
    // first — the fresh show lands on the now-active Space. If it survived on
    // the right Space, just realign it.
    private func reshowPopoverOnActiveSpace() {
        if popover.isShown {
            if popover.contentViewController?.view.window?.isOnActiveSpace == false {
                guard !popoverReshowAttempted else { return }
                popoverReshowAttempted = true
                closePopoverIfShown()
                // Re-show on the next tick, not inline: the reused
                // _NSPopoverWindow has to actually order out before a fresh
                // show can pick up the active Space, and `popover.isShown` is
                // still settling — an inline toggle would be swallowed by the
                // double-click guard and leave nothing on screen.
                DispatchQueue.main.async { [weak self] in self?.togglePopover() }
                return
            }
            realignPopoverWithAnchorIfDisplaced()
            return
        }
        guard !popoverReshowAttempted else { return }
        popoverReshowAttempted = true
        togglePopover()
    }

    // Activation hands key focus to the app's regular windows. When one of them
    // (typically the Dashboard) is visible on another screen or Space, activating
    // steals key from the popover and dismisses the transient popover outright, or
    // drags it across displays (#481). Only report it safe to activate when every
    // key-capable visible window already lives on the anchor's screen and Space —
    // otherwise keep Tahoe's subdued glass and the guaranteed correct placement.
    private func canActivateForPopoverGlass() -> Bool {
        guard let anchorScreen = popoverAnchorWindow?.screen else { return false }
        let popoverWindow = popover.contentViewController?.view.window
        for window in NSApp.windows {
            guard window.isVisible,
                  window.canBecomeKey,
                  !(window is NSPanel),
                  window !== popoverAnchorWindow,
                  window !== popoverWindow else { continue }
            if window.screen !== anchorScreen || !window.isOnActiveSpace {
                return false
            }
        }
        return true
    }

    // App-wide activation can still yank the reused _NSPopoverWindow onto another
    // display's Space (#481). The anchor window is canJoinAllSpaces and pinned in
    // screen coordinates under the clicked status item, so it is the ground truth:
    // if the popover window strayed from it, move the popover window back. The
    // restored position is screen-clamped — hard-centering under the anchor pushes
    // the panel off-screen when the icon sits near a screen edge.
    private func realignPopoverWithAnchorIfDisplaced() {
        guard popover.isShown,
              let popoverWindow = popover.contentViewController?.view.window,
              let anchorWindow = popoverAnchorWindow else { return }
        guard let screen = anchorWindow.screen
            ?? NSScreen.screens.first(where: { $0.frame.intersects(anchorWindow.frame) })
            ?? NSScreen.main else { return }
        let anchor = anchorWindow.frame
        var frame = popoverWindow.frame
        let displaced = popoverWindow.screen !== anchorWindow.screen
            || PopoverPlacementPolicy.isDisplaced(
                popoverFrame: frame,
                anchorFrame: anchor,
                screenFrame: screen.frame
            )
        guard displaced else { return }
        frame.origin.x = PopoverPlacementPolicy.originX(
            bodyWidth: frame.width,
            anchorMidX: anchor.midX,
            screenFrame: screen.frame
        )
        frame.origin.y = anchor.minY - frame.height
        popoverWindow.setFrame(frame, display: true)
    }

    private func makePopoverAnchorWindow() -> NSWindow {
        let anchorSize = NSSize(width: 2, height: 1)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: anchorSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = NSView(frame: NSRect(origin: .zero, size: anchorSize))
        window.backgroundColor = .clear
        window.alphaValue = 0
        window.isOpaque = false
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
        window.isReleasedWhenClosed = false
        return window
    }

    private func positionPopoverAnchorWindow(under button: NSStatusBarButton) -> NSView? {
        guard let buttonWindow = button.window else { return nil }
        let buttonRectInWindow = button.convert(button.bounds, to: nil)
        var buttonRectOnScreen = buttonWindow.convertToScreen(buttonRectInWindow)

        // The status item is rendered on every display's menu bar, but its real
        // window lives on only one of them. When the click happened on another
        // display's mirrored copy, anchor under the cursor on that display —
        // anchoring to the real window would open the popover on the wrong
        // display (#481).
        let mouse = NSEvent.mouseLocation
        if let buttonScreen = buttonWindow.screen,
           let clickScreen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }),
           clickScreen != buttonScreen {
            let menuBarTopOffset = buttonScreen.frame.maxY - buttonRectOnScreen.minY
            buttonRectOnScreen.origin.x = mouse.x - buttonRectOnScreen.width / 2
            buttonRectOnScreen.origin.y = clickScreen.frame.maxY - menuBarTopOffset
        }

        let anchorSize = NSSize(width: 2, height: 1)
        let anchorFrame = NSRect(
            x: buttonRectOnScreen.midX - anchorSize.width / 2,
            y: buttonRectOnScreen.minY,
            width: anchorSize.width,
            height: anchorSize.height
        )
        let window = popoverAnchorWindow ?? makePopoverAnchorWindow()
        popoverAnchorWindow = window
        window.setFrame(anchorFrame, display: false)
        window.orderFrontRegardless()
        return window.contentView
    }

    // MARK: - Right-Click Menu

    static func showContextMenuFromIsland(event: NSEvent, view: NSView) {
        guard let instance else { return }
        let menu = instance.buildMenu()
        // popUpContextMenu blocks in a tracking run loop until dismissal —
        // hold the island open for the whole interaction.
        instance.dynamicIslandController.beginMenuHold()
        NSMenu.popUpContextMenu(menu, with: event, for: view)
        instance.dynamicIslandController.endMenuHold()
    }

    /// Click-invoked variant for the island's gear button (no right-click
    /// NSEvent available): pops the same tray menu at the pointer.
    static func showContextMenuFromIslandGear() {
        guard let instance else { return }
        let menu = instance.buildMenu()
        instance.dynamicIslandController.beginMenuHold()
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
        instance.dynamicIslandController.endMenuHold()
    }

    private func showMenu() {
        let menu = buildMenu()
        trackedStatusMenu = menu
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()

        // ── Group 1: Core Actions ──
        let todayText = buildTodaySummary()
        let todayItem = NSMenuItem(title: "", action: #selector(openPopover), keyEquivalent: "")
        todayItem.target = self
        todayItem.attributedTitle = NSAttributedString(
            string: todayText,
            attributes: [
                .font: NSFont.menuFont(ofSize: 13),
                .foregroundColor: NSColor.labelColor
            ]
        )
        menu.addItem(todayItem)

        menu.addItem(.separator())

        let syncItem = NSMenuItem(title: Strings.menuSyncNow, action: #selector(syncNow), keyEquivalent: "r")
        syncItem.target = self
        syncItem.isEnabled = !viewModel.isSyncing
        menu.addItem(syncItem)

        let dashboardItem = NSMenuItem(title: Strings.openDashboard, action: #selector(openDashboard), keyEquivalent: "d")
        dashboardItem.target = self
        menu.addItem(dashboardItem)

        let settingsItem = NSMenuItem(title: Strings.menuSettings, action: #selector(openDashboardSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        menu.addItem(.separator())

        // ── Group 2: Display Surfaces & Components ──
        let islandEnabled = UserDefaults.standard.bool(forKey: DynamicIslandController.enabledDefaultsKey)
        let isIconHidden = UserDefaults.standard.bool(forKey: Self.hideMenuBarIconKey)
        let iconVisible = MenuBarSurfacePolicy.isIconVisible(
            hideRequested: isIconHidden,
            islandEnabled: islandEnabled
        )

        // Dynamic Island
        let islandItem = NSMenuItem(title: Strings.menuDynamicIsland, action: #selector(toggleDynamicIsland), keyEquivalent: "")
        islandItem.target = self
        islandItem.state = islandEnabled ? .on : .off
        menu.addItem(islandItem)

        // Menu Bar Icon
        let menuBarIconItem = NSMenuItem(title: Strings.menuMenuBarIcon, action: #selector(toggleMenuBarIcon), keyEquivalent: "")
        menuBarIconItem.target = self
        menuBarIconItem.state = iconVisible ? .on : .off
        menu.addItem(menuBarIconItem)

        if iconVisible || islandEnabled {
            // Icon Style Submenu — the style drives both the menu bar icon and
            // the Dynamic Island's left wing glyph, so keep it reachable
            // whenever either surface is showing (not just the menu bar icon).
            let iconStyleItem = NSMenuItem(title: Strings.menuIconStyle, action: nil, keyEquivalent: "")
            let iconStyleMenu = NSMenu()
            let currentStyle = animator?.iconStyle ?? .clawd
            for style in MenuBarIconStyle.allCases {
                let item = NSMenuItem(title: iconStyleLabel(style), action: #selector(selectIconStyle(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = style.rawValue
                item.state = style == currentStyle ? .on : .off
                iconStyleMenu.addItem(item)
            }
            iconStyleItem.submenu = iconStyleMenu
            menu.addItem(iconStyleItem)
        }

        // Display Metrics Submenu (affects both Dynamic Island & Menu Bar Icon)
        let displayItem = NSMenuItem(title: Strings.menuDisplayMetrics, action: nil, keyEquivalent: "")
        let displayMenu = NSMenu()
        displayMenu.autoenablesItems = false

        let statsItem = NSMenuItem(title: Strings.menuShowStats, action: #selector(toggleStats), keyEquivalent: "")
        statsItem.target = self
        statsItem.state = showStats ? .on : .off
        displayMenu.addItem(statsItem)

        let compactItem = NSMenuItem(title: Strings.menuDynamicIslandCompactMode, action: #selector(toggleDynamicIslandCompact), keyEquivalent: "")
        compactItem.target = self
        compactItem.state = DynamicIslandCompactPolicy.isEnabled() ? .on : .off
        compactItem.isEnabled = islandEnabled
        displayMenu.addItem(compactItem)

        let remainingItem = NSMenuItem(title: Strings.menuRingShowsRemaining, action: #selector(selectRingDisplayMode(_:)), keyEquivalent: "")
        remainingItem.target = self
        remainingItem.state = LimitsSettingsStore.shared.displayMode == .remaining ? .on : .off
        displayMenu.addItem(remainingItem)

        if showStats || islandEnabled {
            displayMenu.addItem(.separator())
            let selectedIDs = MenuBarDisplayPreferences.read()
            let payload = MenuBarDisplayPreferences.availableItemsPayload(
                for: viewModel.usageLimits,
                keepingSelected: selectedIDs,
                hiddenProviders: LimitsSettingsStore.shared.hiddenProviders
            )
            for slot in 0..<MenuBarDisplayPreferences.maxVisibleItems {
                let currentID = slot < selectedIDs.count ? selectedIDs[slot] : nil
                let currentLabel = payload.first { $0["id"] == currentID }?["label"] ?? ""
                let slotTitle = slot == 0 ? Strings.menuPrimarySlot : Strings.menuSecondarySlot
                let slotItem = NSMenuItem(
                    title: currentLabel.isEmpty ? slotTitle : "\(slotTitle): \(currentLabel)",
                    action: nil,
                    keyEquivalent: ""
                )
                let slotMenu = NSMenu()
                for entry in payload {
                    guard let id = entry["id"], let label = entry["label"] else { continue }
                    let metricItem = NSMenuItem(
                        title: label,
                        action: #selector(selectMenuBarSlotMetric(_:)),
                        keyEquivalent: ""
                    )
                    metricItem.target = self
                    metricItem.representedObject = ["slot": slot, "id": id] as [String: Any]
                    metricItem.state = id == currentID ? .on : .off
                    slotMenu.addItem(metricItem)
                }
                slotItem.submenu = slotMenu
                displayMenu.addItem(slotItem)
            }
        }

        displayItem.submenu = displayMenu
        menu.addItem(displayItem)

        // Desktop Pet
        let petItem = NSMenuItem(title: Strings.menuDesktopPet, action: #selector(toggleDesktopPet), keyEquivalent: "")
        petItem.target = self
        petItem.state = desktopPetController.isVisible ? .on : .off
        menu.addItem(petItem)

        menu.addItem(.separator())

        // ── Group 3: Preferences & Notifications ──
        let loginItem = NSMenuItem(title: Strings.menuLaunchAtLogin, action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        loginItem.target = self
        loginItem.state = launchAtLoginManager.isEnabled ? .on : .off
        menu.addItem(loginItem)

        let toastItem = NSMenuItem(title: Strings.toastOnResetLabel, action: #selector(toggleResetToast), keyEquivalent: "")
        toastItem.target = self
        toastItem.state = WeeklyLimitResetDetector.toastEnabled() ? .on : .off
        menu.addItem(toastItem)

        let confettiItem = NSMenuItem(title: Strings.confettiOnResetLabel, action: #selector(toggleConfetti), keyEquivalent: "")
        confettiItem.target = self
        confettiItem.state = WeeklyLimitResetDetector.confettiEnabled() ? .on : .off
        menu.addItem(confettiItem)

        menu.addItem(.separator())

        // ── Group 4: System & App Info ──
        let updateTitle = UpdateChecker.shared.statusText ?? Strings.menuCheckForUpdates
        let updateItem = NSMenuItem(title: updateTitle, action: #selector(checkForUpdates), keyEquivalent: "u")
        updateItem.tag = Self.updateMenuItemTag
        updateItem.target = self
        updateItem.isEnabled = !UpdateChecker.shared.isBusy
        menu.addItem(updateItem)

        let version = UpdateChecker.shared.currentVersion()
        let aboutItem = NSMenuItem(title: "TokenTracker v\(version)", action: #selector(openAbout), keyEquivalent: "")
        aboutItem.target = self
        menu.addItem(aboutItem)

        let starItem = NSMenuItem(title: Strings.menuStarOnGitHub, action: #selector(openGitHub), keyEquivalent: "")
        starItem.target = self
        menu.addItem(starItem)

        menu.delegate = self

        menu.addItem(.separator())

        // Quit
        let quitItem = NSMenuItem(title: Strings.quitButton, action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        return menu
    }

    // MARK: - Surface Toggles (Dynamic Island & Menu Bar Icon)

    @objc private func toggleDynamicIsland() {
        let current = UserDefaults.standard.bool(forKey: DynamicIslandController.enabledDefaultsKey)
        let next = !current
        if !next {
            // Turning OFF Dynamic Island: MUST unhide Menu Bar Icon so user is not left with zero UI!
            updateMenuBarIconVisibility(userRequestedHide: false)
        }
        dynamicIslandController.setEnabled(next)
        NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
        // Keep an open dashboard Settings page in sync with the new state.
        NativeBridge.shared.pushSettings()
        if next {
            maybeOfferHidingMenuBarIcon()
        }
    }

    @objc private func toggleMenuBarIcon() {
        let isIconHidden = UserDefaults.standard.bool(forKey: Self.hideMenuBarIconKey)
        let islandEnabled = UserDefaults.standard.bool(forKey: DynamicIslandController.enabledDefaultsKey)
        let iconVisible = MenuBarSurfacePolicy.isIconVisible(
            hideRequested: isIconHidden,
            islandEnabled: islandEnabled
        )
        if iconVisible {
            // User wants to HIDE Menu Bar Icon (turn icon OFF)
            if !islandEnabled {
                // If Dynamic Island is currently OFF, enable it FIRST so App is never hidden!
                dynamicIslandController.setEnabled(true)
            }
            updateMenuBarIconVisibility(userRequestedHide: true)
        } else {
            // User wants to SHOW Menu Bar Icon (turn icon ON)
            updateMenuBarIconVisibility(userRequestedHide: false)
        }
        NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
        // Keep an open dashboard Settings page in sync with the new state.
        NativeBridge.shared.pushSettings()
    }

    // MARK: - Menu Actions

    @objc private func openPopover() {
        popoverReshowAttempted = false
        // Small delay to let the menu dismiss before showing popover
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.togglePopover()
        }
    }

    @objc private func syncNow() {
        Task { await viewModel.triggerSync() }
    }

    @objc private func openDashboard() {
        DashboardPresentationCoordinator.shared.showDashboard()
    }

    @objc private func openDashboardSettings() {
        DashboardWindowController.shared.showSettings()
    }

    @objc private func checkForUpdates() {
        UpdateChecker.shared.check(silent: false)
    }

    @objc private func openGitHub() {
        if let url = URL(string: "https://github.com/xiufengsun/TokenTracker") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func openAbout() {
        // Standard About panel (icon + version); GitHub already has its own "Star" item.
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(nil)
    }

    @objc private func toggleStats() {
        showStats.toggle()
    }

    @objc private func toggleDynamicIslandCompact() {
        DynamicIslandCompactPolicy.write(!DynamicIslandCompactPolicy.isEnabled())
        NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
    }

    @objc private func selectRingDisplayMode(_ sender: NSMenuItem) {
        let next: LimitDisplayMode =
            LimitsSettingsStore.shared.displayMode == .remaining ? .used : .remaining
        LimitsSettingsStore.shared.setDisplayModeFromMenu(next)
    }

    @objc private func selectMenuBarSlotMetric(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: Any],
              let slot = info["slot"] as? Int,
              let id = info["id"] as? String else { return }
        var ids = MenuBarDisplayPreferences.read()
        guard ids.indices.contains(slot) else { return }
        let other = slot == 0 ? 1 : 0
        // "None" may occupy both slots; only real metrics must stay distinct.
        if id != MenuBarDisplayPreferences.noneID,
           ids.indices.contains(other), ids[other] == id {
            // Keep both slots distinct by swapping instead of rejecting.
            ids[other] = ids[slot]
        }
        ids[slot] = id
        MenuBarDisplayPreferences.write(ids)
        NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
        NativeBridge.shared.pushSettings()
    }

    private func iconStyleLabel(_ style: MenuBarIconStyle) -> String {
        switch style {
        case .clawd: return Strings.petCharacterClawd
        case .bot: return Strings.petCharacterBot
        case .cat: return Strings.iconStyleCat
        case .pet: return Strings.iconStyleMyPet
        case .static: return Strings.iconStyleStatic
        }
    }

    @objc private func selectIconStyle(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let style = MenuBarIconStyle(rawValue: raw) else { return }
        animator?.iconStyle = style
        NativeBridge.shared.pushSettings()
    }

    @objc private func toggleResetToast() {
        let current = WeeklyLimitResetDetector.toastEnabled()
        UserDefaults.standard.set(!current, forKey: WeeklyLimitResetDetector.toastEnabledKey)
        NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
        NativeBridge.shared.pushSettings()
    }

    @objc private func toggleConfetti() {
        let current = WeeklyLimitResetDetector.confettiEnabled()
        UserDefaults.standard.set(!current, forKey: WeeklyLimitResetDetector.confettiEnabledKey)
        NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
        NativeBridge.shared.pushSettings()
    }

    @objc private func toggleLaunchAtLogin() {
        launchAtLoginManager.toggle()
    }

    @objc private func toggleDesktopPet() {
        desktopPetController.toggle()
    }

    @objc private func quit() {
        AppDelegate.requestQuit()
    }

    // MARK: - Helpers

    private func buildTodaySummary() -> String {
        let tokens = viewModel.todayTokens
        let cost = viewModel.todayCost

        if tokens == 0 {
            return "\(Strings.todayTitle): \(Strings.noData)"
        }

        let formatted = TokenFormatter.formatCompact(tokens)
        return "\(Strings.todayTitle): \(formatted) \(Strings.tokensUnit) · \(cost)"
    }

    private func applyUpdateMenuItemState(in menu: NSMenu) {
        guard let item = menu.item(withTag: Self.updateMenuItemTag) else { return }
        let title = UpdateChecker.shared.statusText ?? Strings.menuCheckForUpdates
        if item.title != title {
            item.title = title
        }
        let enabled = !UpdateChecker.shared.isBusy
        if item.isEnabled != enabled {
            item.isEnabled = enabled
        }
    }
}

// MARK: - NSMenuDelegate (live update row while menu is open)

@MainActor
extension StatusBarController: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) {
        trackedStatusMenu = menu
        updateMenuStatusObserver = NotificationCenter.default.addObserver(
            forName: .updateCheckerStatusDidChange,
            object: UpdateChecker.shared,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, let menu = self.trackedStatusMenu else { return }
                self.applyUpdateMenuItemState(in: menu)
            }
        }
        applyUpdateMenuItemState(in: menu)
    }

    func menuDidClose(_ menu: NSMenu) {
        trackedStatusMenu = nil
        if let observer = updateMenuStatusObserver {
            NotificationCenter.default.removeObserver(observer)
            updateMenuStatusObserver = nil
        }
    }
}
