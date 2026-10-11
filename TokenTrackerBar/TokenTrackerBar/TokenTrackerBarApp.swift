import SwiftUI

@main
struct TokenTrackerBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // The system "Settings…" (⌘,) item opens this scene. The real settings
        // live in the dashboard WebView, so this placeholder immediately closes
        // itself and routes to the dashboard settings page instead.
        Settings { SettingsRedirectView() }
            .commands {
                // Declarative overrides survive SwiftUI's main-menu rebuilds.
                // (AppKit-level retargeting/insertion gets wiped every time
                // SwiftUI re-syncs the menu, e.g. on activation policy flips.)
                // Replace the system About item (which gets a default icon on
                // macOS 26) with a plain button, so it matches the iconless
                // custom items below; "Check for Updates…" sits right after it.
                CommandGroup(replacing: .appInfo) {
                    Button(Strings.menuAbout) {
                        NSApp.activate(ignoringOtherApps: true)
                        NSApp.orderFrontStandardAboutPanel(nil)
                    }
                    #if !TOKENTRACKER_NATIVE_QA
                    Button(Strings.menuCheckForUpdates) {
                        UpdateChecker.shared.check(silent: false)
                    }
                    #endif
                }
                CommandGroup(replacing: .appSettings) {
                    Button(Strings.menuSettings + "…") {
                        DashboardWindowController.shared.showSettings()
                    }
                    .keyboardShortcut(",", modifiers: .command)
                }
                // Default Help menu shows "Help isn't available" — open the website.
                #if !TOKENTRACKER_NATIVE_QA
                CommandGroup(replacing: .help) {
                    Button(Strings.menuHelp) {
                        if let url = URL(string: "https://www.tokentracker.cc") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                }
                #endif
            }
    }
}

/// Zero-size placeholder for the SwiftUI Settings scene: as soon as its window
/// appears it closes itself and opens the dashboard settings page. Acts as a
/// fallback in case the scene is ever opened programmatically.
private struct SettingsRedirectView: View {
    var body: some View {
        SettingsRedirector()
            .frame(width: 0, height: 0)
    }
}

private struct SettingsRedirector: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { RedirectingView() }
    func updateNSView(_ nsView: NSView, context: Context) {}

    private final class RedirectingView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window else { return }
            DispatchQueue.main.async { [weak window] in
                window?.close()
                DashboardWindowController.shared.showSettings()
            }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    private var statusBarController: StatusBarController?
    private var lastWakeCatchUpAttemptAt: Date?
    private lazy var viewModel = DashboardViewModel()
    private lazy var serverManager = ServerManager()
    private lazy var launchAtLoginManager = LaunchAtLoginManager()
    private lazy var desktopPetController = DesktopPetWindowController(viewModel: viewModel)
    private lazy var dynamicIslandController = DynamicIslandController(viewModel: viewModel)
    private static var userInitiatedQuit = false
    private static let wakeCatchUpDebounceInterval: TimeInterval = 60

    /// Real quit path: popover/Footer Quit buttons, NativeBridge "quit", UpdateChecker relaunch.
    /// Cmd+Q from the dashboard window goes through `applicationShouldTerminate` and is downgraded
    /// to a window-close so the menu bar item stays alive.
    static func requestQuit() {
        userInitiatedQuit = true
        DashboardPresentationCoordinator.shared.prepareForTermination()
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if Self.userInitiatedQuit { return .terminateNow }
        // Only downgrade an explicit Cmd+Q keypress to a window-close. System
        // shutdown/restart/logout arrives with no current event and must be
        // allowed through, otherwise macOS reports the app as blocking shutdown.
        guard let event = NSApp.currentEvent,
              event.type == .keyDown,
              event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
              event.charactersIgnoringModifiers?.lowercased() == "q"
        else {
            DashboardPresentationCoordinator.shared.prepareForTermination()
            return .terminateNow
        }
        if DashboardPresentationCoordinator.shared.closeDashboard() {
            return .terminateCancel
        }
        DashboardPresentationCoordinator.shared.prepareForTermination()
        return .terminateNow
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // TokenTracker normally lives as an LSUIElement menu bar app, so a
        // Finder/Dock reopen must explicitly restore the dashboard window.
        // Do not rely on `flag`: the desktop pet or Dynamic Island may count as
        // visible even while the dashboard itself is closed.
        DashboardPresentationCoordinator.shared.showDashboard()
        return false
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let profile = NativeQAProfile.current {
            Task { @MainActor in
                guard await profile.verifyServer() else { fatalError("Native QA server identity rejected") }
                DashboardWindowController.shared.allowDashboardNavigation()
                DashboardPresentationCoordinator.shared.showDashboard()
            }
            return
        }
        removeLegacyAppBundleIfNeeded()
        NativeLocalization.synchronizeSharedPreference()

        statusBarController = StatusBarController(
            viewModel: viewModel,
            serverManager: serverManager,
            launchAtLoginManager: launchAtLoginManager,
            desktopPetController: desktopPetController,
            dynamicIslandController: dynamicIslandController
        )

        // Bring the desktop pet back if it was showing when the app last quit.
        desktopPetController.restoreIfNeeded()

        // Bring the Dynamic Island back if it was enabled when the app last quit.
        dynamicIslandController.restoreIfNeeded()

        NativeBridge.shared.configure(
            viewModel: viewModel,
            launchAtLoginManager: launchAtLoginManager,
            desktopPetController: desktopPetController,
            dynamicIslandController: dynamicIslandController
        )
        registerWakeCatchUpObservers()

        // A normal Finder/Dock launch should behave like opening an app, while
        // an SMAppService login launch should remain a quiet menu bar startup.
        if NSAppleEventManager.shared().currentAppleEvent?
            .attributeDescriptor(forKeyword: keyAELaunchedAsLogInItem) == nil {
            DashboardPresentationCoordinator.shared.showDashboard()
        }

        Task { @MainActor in
            await serverManager.ensureServerRunning()
            DashboardWindowController.shared.allowDashboardNavigation()
            let serverHealthy = await APIClient.shared.checkServerHealth()
            let isOnline = serverManager.isServerRunning || serverHealthy
            if isOnline {
                await viewModel.syncThenLoad()
            }
            viewModel.startAutoRefresh()

            UpdateChecker.shared.check(silent: true)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        DashboardPresentationCoordinator.shared.prepareForTermination()
        if NativeQAProfile.current != nil { return }
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        serverManager.stopServer()
    }

    private func registerWakeCatchUpObservers() {
        let notificationCenter = NSWorkspace.shared.notificationCenter
        notificationCenter.addObserver(
            self,
            selector: #selector(scheduleWakeCatchUp(_:)),
            name: NSWorkspace.didWakeNotification,
            object: nil
        )
        notificationCenter.addObserver(
            self,
            selector: #selector(scheduleWakeCatchUp(_:)),
            name: NSWorkspace.screensDidWakeNotification,
            object: nil
        )
        notificationCenter.addObserver(
            self,
            selector: #selector(scheduleWakeCatchUp(_:)),
            name: NSWorkspace.sessionDidBecomeActiveNotification,
            object: nil
        )
    }

    /// One-time migration: PRODUCT_NAME changed `TokenTrackerBar.app` → `TokenTracker.app`.
    /// Auto-update (or a manual drag-install) puts the renamed bundle alongside the
    /// old one, so terminate any still-running legacy instance and remove the
    /// orphaned legacy copy (same bundle id) when running from a standard install path.
    private func removeLegacyAppBundleIfNeeded() {
        let appDirs = ["/Applications", "/Users/\(NSUserName())/Applications"]
        guard appDirs.contains(where: { Bundle.main.bundlePath == "\($0)/TokenTracker.app" }) else { return }
        for legacyPath in appDirs.map({ "\($0)/TokenTrackerBar.app" }) {
            guard let legacyBundle = Bundle(path: legacyPath),
                  legacyBundle.bundleIdentifier == Bundle.main.bundleIdentifier
            else { continue }
            // A legacy instance may still be sitting in the menu bar (manual
            // drag-install case) — two instances would fight over the server port.
            NSWorkspace.shared.runningApplications
                .filter { $0.bundleIdentifier == Bundle.main.bundleIdentifier && $0.bundleURL?.path == legacyPath }
                .forEach { $0.terminate() }
            try? FileManager.default.removeItem(atPath: legacyPath)
        }
    }

    @objc private func scheduleWakeCatchUp(_ notification: Notification) {
        guard NativeQAProfile.current == nil else { return }
        let now = Date()
        if let lastWakeCatchUpAttemptAt,
           now.timeIntervalSince(lastWakeCatchUpAttemptAt) < Self.wakeCatchUpDebounceInterval {
            return
        }
        lastWakeCatchUpAttemptAt = now

        Task { @MainActor in
            await serverManager.ensureServerRunning()
            await viewModel.catchUpAfterWakeOrSessionActive(now: now)
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        if let profile = NativeQAProfile.current {
            for url in urls {
                guard let order = try? profile.billingReturnOrder(url) else {
                    fatalError("Native QA billing return rejected")
                }
                Task { @MainActor in
                    guard await profile.approveOwnedOrder(order) else { fatalError("Native QA order ownership rejected") }
                    DashboardWindowController.shared.handleNativeQABillingReturn(order: order)
                }
            }
            return
        }
        for url in urls {
            guard url.scheme == "tokentracker" else { continue }
            if let order = NativeBillingReturn.orderID(from: url) {
                DashboardWindowController.shared.handleBillingReturn(order: order)
            } else if url.host == "auth" && url.path.hasPrefix("/done") {
                DashboardWindowController.shared.handleAuthDone()
            } else if url.host == "auth" && url.path.hasPrefix("/callback") {
                // Browser relays OAuth code back via tokentracker://auth/callback?insforge_code=xxx
                let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
                let code = components?.queryItems?.first(where: { $0.name == "insforge_code" })?.value
                if let code {
                    DashboardWindowController.shared.handleAuthCallback(code: code)
                }
            } else if url.host == "open" || url.host == "dashboard" {
                // The web app's local-only pages (Limits / Skills on
                // tokentracker.cc) deep-link here via tokentracker://open to
                // surface the local dashboard window.
                DashboardPresentationCoordinator.shared.showDashboard()
            }
        }
    }
}
