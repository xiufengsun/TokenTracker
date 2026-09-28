import AppKit
import SwiftUI
import WebKit

@MainActor
final class DashboardWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    /// Matches the `AppLayout` main content gutter `lg:pr-3 lg:pb-3` (12pt) in `dashboard`,
    /// used to approximate concentric rounding between the main card and the window.
    private enum DashboardChromeMetrics {
        /// AppKit does not expose the outer window corner radius. Use 28pt so
        /// `28 - 12pt gutter = 16px`, matching the previous `rounded-2xl` approximation.
        static let approxWindowOuterCornerRadius: CGFloat = 28
        static let mainGutterPoints: CGFloat = 12
        static var mainCardCornerRadiusPixels: Int {
            Int(max(8, approxWindowOuterCornerRadius - mainGutterPoints))
        }
    }

    static let shared = DashboardWindowController()

    private var window: NSWindow?
    /// True when `theme === "system"`: leave the window `appearance` nil to follow the system; otherwise pin light/dark.
    private var chromeFollowsSystem = false
    private var effectiveAppearanceObservation: NSKeyValueObservation?
    private var webView: WKWebView?
    private var loadingOverlay: NSView?
    private var loadingHostingController: NSHostingController<AnyView>?
    /// Non-nil while the window is parked on the "couldn't load" state, which is
    /// also how a reopen tells that the window needs a fresh load rather than a
    /// plain order-front.
    private var loadFailureOverlay: NSView?
    private var loadFailureHostingController: NSHostingController<AnyView>?
    /// A newly launched app may overlap the previous version briefly while the
    /// updater relaunches it. Keep every WKWebView request queued until
    /// ServerManager has replaced the listener on the fixed dashboard port.
    private var dashboardNavigationAllowed = false
    private var pendingDashboardURL: URL?
    /// Preserve the WebView's sessionStorage only while a native OAuth round trip
    /// needs its PKCE verifier. Normal dashboard closes release the browser runtime.
    private var oauthInFlight = false
    private var releaseDashboardAfterOAuth = false
    private var oauthTimeoutTask: Task<Void, Never>?
    private let oauthRetentionTimeoutNanoseconds: UInt64 = 10 * 60 * 1_000_000_000
    /// Retry count for load failures.
    private var retryCount = 0
    private let maxRetries = 5

    /// Shared process pool — ensures cookies are consistent across webView recreations
    private static let sharedProcessPool = WKProcessPool()

    private override init() {
        super.init()
    }

    // MARK: - Public

    /// Opens the process-lifetime navigation gate after local server startup has
    /// settled. The window can be visible behind its loading overlay before this
    /// point, but it must not receive HTML from the previous app version.
    func allowDashboardNavigation() {
        guard !dashboardNavigationAllowed else { return }
        dashboardNavigationAllowed = true
        guard let pendingDashboardURL else { return }
        self.pendingDashboardURL = nil
        loadDashboard(pendingDashboardURL)
    }

    /// Window-only presentation. App-wide activation/Dock policy is owned by
    /// `DashboardPresentationCoordinator` so every open/close entry shares the
    /// same lifecycle contract.
    func presentWindow() {
        // Close the menu bar popover.
        for window in NSApp.windows where window.className.contains("Popover") {
            window.close()
        }

        // Reuse existing window if possible
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            // Reopening a window that never loaded must start a new attempt,
            // otherwise the user keeps landing on the same dead overlay.
            if loadFailureOverlay != nil {
                reload()
                return
            }
            syncChromeAppearanceFromWebView()
            injectMainCardCornerRadius()
            return
        }

        // Create WKWebView with persistent data store and shared process pool
        let contentController = WKUserContentController()
        contentController.add(self, name: "nativeOAuth")
        contentController.add(self, name: "nativeBridge")
        // Earliest paint: transparent root so NSVisualEffectView is visible (index.html also sets native-app via nativeBridge).
        let transparencyBootstrap = """
        (function(){
          document.documentElement.classList.add('native-app');
          var s=document.createElement('style');
          s.textContent='html,html.dark{background:transparent!important}body{background:transparent!important}';
          (document.head||document.documentElement).appendChild(s);
        })();
        """
        let bootstrapScript = WKUserScript(
            source: transparencyBootstrap,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(bootstrapScript)
        let webConfig = WKWebViewConfiguration()
        webConfig.userContentController = contentController
        webConfig.processPool = Self.sharedProcessPool
        webConfig.websiteDataStore = WKWebsiteDataStore.default()
        let webView = WKWebView(frame: .zero, configuration: webConfig)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        self.webView = webView

        // Container: Liquid Glass (macOS 26+) or NSVisualEffectView under a transparent WKWebView (sidebar + chrome see through).
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.clear.cgColor

        let dashboardBackground = DashboardBackgroundView.makeFullWindowBackground()
        container.addSubview(dashboardBackground)

        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)

        NSLayoutConstraint.activate([
            dashboardBackground.topAnchor.constraint(equalTo: container.topAnchor),
            dashboardBackground.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            dashboardBackground.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            dashboardBackground.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])

        // Titlebar drag area — transparent, sits above webView so window is draggable
        let dragBar = TitlebarDragView()
        dragBar.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(dragBar)

        // Loading overlay with spinner
        installLoadingOverlay(in: container)

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            dragBar.topAnchor.constraint(equalTo: container.topAnchor),
            dragBar.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            dragBar.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            // Must match dashboard `AppLayout` top `h-7` (28pt) drag strip. A taller bar covers the
            // sidebar Sign in button, causing mouseDown to be consumed by performDrag.
            dragBar.heightAnchor.constraint(equalToConstant: 28),
        ])

        // Create window
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 1000),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.minSize = NSSize(width: 800, height: 600)
        window.title = "TokenTracker"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        let toolbar = NSToolbar(identifier: "DashboardToolbar")
        toolbar.showsBaselineSeparator = false
        window.toolbar = toolbar
        window.toolbarStyle = .unifiedCompact
        window.contentView = container
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("DashboardWindow")
        window.center()
        // Clear window so native glass / vibrancy + transparent WKWebView show material (not an opaque gray sheet).
        window.isOpaque = false
        window.backgroundColor = .clear
        // Dashboard is a primary work window: it can enter full screen, but must not attach to another app's full-screen Space.
        window.collectionBehavior = [.managed, .fullScreenPrimary]
        self.window = window

        // Wire bridge so SettingsPage can read/write menu-bar prefs
        NativeBridge.shared.webView = webView

        // Always observe NSApp.effectiveAppearance so the frontend module-level cache stays current,
        // avoiding an async round trip to know the current system light/dark value when switching light -> system.
        registerEffectiveAppearanceObserverIfNeeded()

        // Load dashboard
        retryCount = 0
        if let url = URL(string: Constants.serverBaseURL + "?app=1") {
            loadDashboard(url)
        }

        // Show window after switching to regular app (shows dock icon).
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Restart the dashboard load from a clean state: clears the failure view,
    /// resets the retry budget and puts the loading overlay back up. Shared by
    /// the in-window Retry button, the menu-bar Retry button and a reopen of a
    /// window parked on the failure state. A no-op when no window is open.
    func reload() {
        guard let container = window?.contentView else { return }
        dismissLoadFailureOverlay()
        retryCount = 0
        installLoadingOverlay(in: container)
        if let current = webView?.url, isLocalDashboardURL(current) {
            loadDashboard(current)
        } else if let url = URL(string: Constants.serverBaseURL + "?app=1") {
            loadDashboard(url)
        }
    }

    private func loadDashboard(_ url: URL) {
        guard dashboardNavigationAllowed else {
            pendingDashboardURL = url
            return
        }
        pendingDashboardURL = nil
        webView?.load(URLRequest(url: url))
    }

    /// Match dashboard light/dark so native glass / `NSVisualEffectView` + window chrome follow the web theme.
    /// - `theme`: `"system"` | `"light"` | `"dark"` (matches `tokentracker-theme` in `localStorage`).
    func applyChromeAppearance(theme: String, resolvedIsDark: Bool) {
        switch theme {
        case "system":
            chromeFollowsSystem = true
            window?.appearance = nil
        case "light":
            chromeFollowsSystem = false
            window?.appearance = NSAppearance(named: .aqua)
        case "dark":
            chromeFollowsSystem = false
            window?.appearance = NSAppearance(named: .darkAqua)
        default:
            chromeFollowsSystem = false
            window?.appearance = NSAppearance(named: resolvedIsDark ? .darkAqua : .aqua)
        }
        registerEffectiveAppearanceObserverIfNeeded()
        // When switching to system, immediately push the current system appearance to the frontend.
        // KVO only fires on appearance changes, so light/dark -> system does not fire if the system appearance is unchanged.
        if chromeFollowsSystem {
            DispatchQueue.main.async { [weak self] in
                self?.pushCurrentSystemAppearanceToWeb()
            }
        }
    }

    /// Pushes the current system appearance to the frontend regardless of `chromeFollowsSystem`,
    /// keeping the frontend module-level cache (`getCachedNativeSystemDark`) current.
    func pushCurrentSystemAppearanceToWeb() {
        let isDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        pushSystemAppearanceToWeb(isDark: isDark)
    }

    /// Always registers one KVO observer, independent of `chromeFollowsSystem`:
    /// - If the user changes system appearance while manually pinned to light/dark, the frontend cache still updates.
    /// - When switching back to system, the frontend already has the correct value without an async round trip.
    private func registerEffectiveAppearanceObserverIfNeeded() {
        guard effectiveAppearanceObservation == nil else { return }
        // `NSApp.effectiveAppearance` follows the system when NSApp.appearance is nil.
        // AppKit docs recommend observing it with KVO for light/dark changes.
        effectiveAppearanceObservation = NSApp.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.pushCurrentSystemAppearanceToWeb()
            }
        }
    }

    private func pushSystemAppearanceToWeb(isDark: Bool) {
        let js = """
        (function(){
          var d = \(isDark ? "true" : "false");
          if (d) { document.documentElement.classList.add('dark'); } else { document.documentElement.classList.remove('dark'); }
          window.dispatchEvent(new CustomEvent('native:systemAppearanceChanged', { detail: { isDark: d } }));
        })();
        """
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    private func syncChromeAppearanceFromWebView() {
        let js = """
        (function(){
          try {
            var t = localStorage.getItem('tokentracker-theme') || 'system';
            var d = document.documentElement.classList.contains('dark');
            return JSON.stringify({ theme: t, isDark: d });
          } catch (e) {
            return JSON.stringify({ theme: 'system', isDark: false });
          }
        })()
        """
        webView?.evaluateJavaScript(js) { [weak self] result, _ in
            guard let self,
                  let json = result as? String,
                  let data = json.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let theme = obj["theme"] as? String,
                  let isDark = obj["isDark"] as? Bool else { return }
            applyChromeAppearance(theme: theme, resolvedIsDark: isDark)
        }
    }

    /// Main content white-card radius: approximates concentric rounding with the visible window corner
    /// (outer radius minus gutter), then writes `--tt-main-card-radius`.
    private func injectMainCardCornerRadius() {
        let px = DashboardChromeMetrics.mainCardCornerRadiusPixels
        let js = "document.documentElement.style.setProperty('--tt-main-card-radius', '\(px)px');"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Loading Overlay

    private func makeLoadingOverlay() -> NSView {
        let overlay = PassthroughOverlayView()
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        // Base size is about 60x64pt; scaling by 1.2x gives about 72x76.8.
        let hosting = NSHostingController(
            rootView: AnyView(
                ClawdCompanionView.LoadingMascotView()
                    .scaleEffect(1.2)
                    .frame(width: 72, height: 76.8)
            )
        )
        self.loadingHostingController = hosting
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        hosting.view.wantsLayer = true
        hosting.view.layer?.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
        overlay.addSubview(hosting.view)

        let label = NSTextField(labelWithString: "Loading Dashboard…")
        label.font = .systemFont(ofSize: 13)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(label)

        NSLayoutConstraint.activate([
            hosting.view.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            hosting.view.centerYAnchor.constraint(equalTo: overlay.centerYAnchor, constant: -12),
            hosting.view.widthAnchor.constraint(equalToConstant: 72),
            hosting.view.heightAnchor.constraint(equalToConstant: 76.8),
            label.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            label.topAnchor.constraint(equalTo: hosting.view.bottomAnchor, constant: 8),
        ])
        return overlay
    }

    private func installLoadingOverlay(in container: NSView) {
        guard loadingOverlay == nil else { return }
        let overlay = makeLoadingOverlay()
        overlay.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.topAnchor.constraint(equalTo: container.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        loadingOverlay = overlay
    }

    private func dismissLoadingOverlay() {
        guard let overlay = loadingOverlay else { return }
        // Keep drawsBackground false so native glass / vibrancy shows through non-painted areas (sidebar + window chrome).
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.3
            overlay.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            overlay.removeFromSuperview()
            self?.loadingOverlay = nil
            self?.loadingHostingController = nil
        }
    }

    // MARK: - Load Failure

    /// Replaces the loading overlay with an actionable error once the retry
    /// budget is spent. The previous silent `return` left the mascot spinning
    /// forever with no way back inside the app (issue #557).
    private func presentLoadFailure(reason: String) {
        guard let container = window?.contentView else { return }
        dismissLoadingOverlay()
        dismissLoadFailureOverlay()

        let hosting = NSHostingController(
            rootView: AnyView(
                DashboardLoadFailureView(reason: reason) { [weak self] in
                    self?.reload()
                }
            )
        )
        let overlay = hosting.view
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        overlay.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.topAnchor.constraint(equalTo: container.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        loadFailureOverlay = overlay
        loadFailureHostingController = hosting
    }

    private func dismissLoadFailureOverlay() {
        loadFailureOverlay?.removeFromSuperview()
        loadFailureOverlay = nil
        loadFailureHostingController = nil
    }

    /// Single failure path for both provisional and committed navigation errors.
    private func handleNavigationFailure(_ error: Error) {
        // `stopLoading()` and ordinary navigation replacement report a cancel;
        // neither means the dashboard is unreachable.
        if (error as NSError).code == NSURLErrorCancelled { return }
        retryCount += 1
        guard retryCount <= maxRetries else {
            presentLoadFailure(reason: error.localizedDescription)
            return
        }
        let delay = min(Double(retryCount) * 2, 10)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let url = URL(string: Constants.serverBaseURL + "?app=1") else { return }
            self.loadDashboard(url)
        }
    }

    /// Requests a close only when the Dashboard is currently visible.
    /// Returning whether a close began lets Cmd+Q fall back to a real app quit
    /// when the menu-bar agent has no Dashboard window to close.
    @discardableResult
    func closeWindow() -> Bool {
        guard let window, window.isVisible else { return false }
        window.performClose(nil)
        return true
    }

    // MARK: - NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === window else { return true }
        return DashboardPresentationCoordinator.shared.dashboardWindowShouldClose()
    }

    func windowWillClose(_ notification: Notification) {
        guard let closingWindow = notification.object as? NSWindow,
              closingWindow === window else { return }
        DashboardPresentationCoordinator.shared.dashboardWindowWillClose()
        if oauthInFlight {
            // The PKCE verifier lives in this WebView's sessionStorage. Keep the
            // closed window temporarily so a browser callback can finish in the
            // same context; success or timeout will release it if still hidden.
            releaseDashboardAfterOAuth = true
            return
        }
        releaseDashboardResources(closingWindow: closingWindow)
    }

    private func releaseDashboardResources(closingWindow: NSWindow) {
        guard closingWindow === window else { return }

        oauthTimeoutTask?.cancel()
        oauthTimeoutTask = nil
        releaseDashboardAfterOAuth = false

        if let webView {
            webView.stopLoading()
            webView.navigationDelegate = nil
            webView.uiDelegate = nil
            webView.configuration.userContentController.removeScriptMessageHandler(forName: "nativeOAuth")
            webView.configuration.userContentController.removeScriptMessageHandler(forName: "nativeBridge")
            webView.removeFromSuperview()
        }
        NativeBridge.shared.webView = nil
        closingWindow.delegate = nil
        closingWindow.contentView = nil
        loadingOverlay = nil
        loadingHostingController = nil
        loadFailureOverlay = nil
        loadFailureHostingController = nil
        pendingDashboardURL = nil
        self.webView = nil
        self.window = nil
    }

    private func beginNativeOAuth() {
        oauthInFlight = true
        releaseDashboardAfterOAuth = false
        oauthTimeoutTask?.cancel()
        oauthTimeoutTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(nanoseconds: oauthRetentionTimeoutNanoseconds)
            } catch {
                return
            }
            expireNativeOAuth()
        }
    }

    private func completeNativeOAuth() {
        guard oauthInFlight else { return }
        oauthInFlight = false
        oauthTimeoutTask?.cancel()
        oauthTimeoutTask = nil
        if releaseDashboardAfterOAuth,
           let window,
           !window.isVisible {
            releaseDashboardResources(closingWindow: window)
        }
    }

    private func expireNativeOAuth() {
        completeNativeOAuth()
    }

    // MARK: - WKScriptMessageHandler

    nonisolated func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        let name = message.name
        let body = message.body
        Task { @MainActor [weak self] in
            self?.handleScriptMessage(name: name, body: body)
        }
    }

    private func handleScriptMessage(name: String, body: Any) {
        if name == "nativeBridge" {
            if let message = body as? [String: Any],
               let messageType = message["type"] as? String,
               messageType == "authCompleted" {
                completeNativeOAuth()
                return
            }
            NativeBridge.shared.handle(message: body)
            return
        }
        guard name == "nativeOAuth",
              let urlString = body as? String,
              let url = URL(string: urlString) else { return }
        // Open OAuth in system browser where user has saved Google/GitHub sessions
        beginNativeOAuth()
        NSWorkspace.shared.open(url)
    }

    /// Open the dashboard and navigate directly to the Settings page.
    func showSettings() {
        DashboardPresentationCoordinator.shared.showDashboard()
        if let url = URL(string: Constants.serverBaseURL + "/settings?app=1") {
            loadDashboard(url)
        }
    }

    /// Called when `tokentracker://auth/done` deep link is received after browser login.
    func handleAuthDone() {
        DashboardPresentationCoordinator.shared.showDashboard()
        // Reload dashboard so InsForge SDK picks up session from server-side cookie relay
        if let url = URL(string: Constants.serverBaseURL + "?app=1") {
            loadDashboard(url)
        }
    }

    /// Called when browser relays OAuth code back via `tokentracker://auth/callback?insforge_code=xxx`.
    /// Loads the callback page in the WebView so the SDK can exchange the code using the
    /// PKCE verifier that's already in WebView's sessionStorage.
    func handleAuthCallback(code: String) {
        DashboardPresentationCoordinator.shared.showDashboard()
        let encoded = code.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? code
        let callbackUrl = Constants.serverBaseURL + "/auth/callback?insforge_code=\(encoded)"
        if let url = URL(string: callbackUrl) {
            loadDashboard(url)
        }
    }

    // MARK: - WKUIDelegate

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    /// WKWebView never opens a picker for `<input type="file">` on its own — without
    /// this delegate method the dashboard's pet/skill import buttons silently no-op.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        let finish: (NSApplication.ModalResponse) -> Void = { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(panel.runModal())
        }
    }

    // MARK: - WKNavigationDelegate

    private func isLocalDashboardURL(_ url: URL) -> Bool {
        url.host == "localhost" || url.host == "127.0.0.1"
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        // Allow local dashboard navigation
        if isLocalDashboardURL(url) {
            decisionHandler(.allow)
            return
        }

        let isMainFrameNavigation = navigationAction.targetFrame?.isMainFrame ?? true
        // Only promote top-level user clicks to the system browser. Subframe
        // clicks (e.g. the Cloud IP Check iframe) should stay inside the
        // iframe so embedded tools can navigate normally.
        if (url.scheme == "http" || url.scheme == "https"),
           navigationAction.navigationType == .linkActivated,
           isMainFrameNavigation {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryCount = 0
        dismissLoadFailureOverlay()
        let completedNativeOAuth = webView.url?.path == "/dashboard" || webView.url?.path == "/"
        if oauthInFlight && completedNativeOAuth {
            completeNativeOAuth()
        }
        // Disable text selection and leave top spacing for the transparent titlebar.
        let css = """
            * { -webkit-user-select: none !important; } \
            input, textarea { -webkit-user-select: text !important; } \
            .native-app header { padding-top: 36px !important; } \
            ::-webkit-scrollbar { display: none !important; }
            """
        let escapedCSS = css
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: " ")
        let js = "document.documentElement.classList.add('native-app');var s=document.createElement('style');s.textContent='\(escapedCSS)';document.head.appendChild(s);"
        webView.evaluateJavaScript(js)

        // Wait for next animation frame so the page has actually painted before dismissing overlay
        let waitForPaint = "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => 'ready')"
        webView.evaluateJavaScript(waitForPaint) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.syncChromeAppearanceFromWebView()
                // After the page is ready, immediately push the current system appearance into the
                // module-level cache so switching to system later can read the correct value synchronously.
                self?.pushCurrentSystemAppearanceToWeb()
                self?.injectMainCardCornerRadius()
                self?.dismissLoadingOverlay()
            }
        }
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        handleNavigationFailure(error)
    }

    /// A main document that started loading and then failed leaves the loading
    /// overlay up just as a provisional failure does, so it takes the same path.
    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        handleNavigationFailure(error)
    }
}

// MARK: - Titlebar Drag View

/// Transparent view overlaying the titlebar area to enable window dragging
/// while WKWebView is fullSizeContentView.
private final class TitlebarDragView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

/// Visual-only overlay for the initial dashboard load.
///
/// WKWebView navigation can swap from the dashboard to an auth callback page
/// while this overlay is fading or waiting to be removed. Keeping it out of
/// hit-testing prevents a transparent stale overlay from swallowing button
/// clicks in the WebView.
private final class PassthroughOverlayView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }
}
