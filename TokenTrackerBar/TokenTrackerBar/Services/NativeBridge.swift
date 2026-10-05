import AppKit
import Combine
import ServiceManagement
import WebKit
import WidgetKit
import UserNotifications

/// Bridges menu-bar app preferences and actions to the embedded dashboard WebView.
///
/// The dashboard SettingsPage posts JSON messages via `window.webkit.messageHandlers.nativeBridge.postMessage(...)`.
/// We dispatch `getSettings` / `setSetting` / `action` and push current state back to JS by
/// firing a `native:settings` CustomEvent on the page's window.
@MainActor
final class NativeBridge {

    static let shared = NativeBridge()

    weak var webView: WKWebView?
    private weak var viewModel: DashboardViewModel?
    private weak var launchAtLoginManager: LaunchAtLoginManager?
    private weak var desktopPetController: DesktopPetWindowController?
    private weak var dynamicIslandController: DynamicIslandController?
    private var cancellables = Set<AnyCancellable>()

    private init() {}

    func configure(
        viewModel: DashboardViewModel,
        launchAtLoginManager: LaunchAtLoginManager,
        desktopPetController: DesktopPetWindowController,
        dynamicIslandController: DynamicIslandController? = nil
    ) {
        self.viewModel = viewModel
        self.launchAtLoginManager = launchAtLoginManager
        self.desktopPetController = desktopPetController
        self.dynamicIslandController = dynamicIslandController

        cancellables.removeAll()
        // Re-push settings whenever selectable menu-bar items change so the
        // dropdown tracks provider availability and per-window data presence.
        viewModel.$usageLimits
            .map { Self.availableItemsFingerprint(for: $0) }
            .removeDuplicates()
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.pushSettings() }
            .store(in: &cancellables)

        viewModel.$isSyncing
            .removeDuplicates()
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.pushSettings() }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .updateCheckerStatusDidChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.pushSettings() }
            .store(in: &cancellables)

        // Mirror local limits preference changes (e.g. toggled in the
        // menu-bar popover) so the embedded dashboard reflects them without a
        // page reload.
        let limitsSettings = LimitsSettingsStore.shared
        limitsSettings.preferencesDidChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.pushSettings() }
            .store(in: &cancellables)
    }

    /// Compact selectable item fingerprint used only for `usageLimits`
    /// publisher de-duplication. It mirrors the available id list without
    /// constructing the full dashboard payload dictionaries.
    private static func availableItemsFingerprint(for limits: UsageLimitsResponse?) -> String {
        MenuBarDisplayPreferences.availableItemIDs(
            for: limits,
            keepingSelected: MenuBarDisplayPreferences.read(),
            hiddenProviders: LimitsSettingsStore.shared.hiddenProviders
        )
            .joined(separator: "|")
    }

    // MARK: - Message dispatch

    func handle(message: Any) {
        guard let dict = message as? [String: Any],
              let type = dict["type"] as? String else { return }

        switch type {
        case "getSettings":
            pushSettings()
        case "getPetSettings":
            pushPetSettings()
        case "refreshPetCatalog":
            PetCatalog.shared.refresh()
        case "getSystemAppearance":
            DashboardWindowController.shared.pushCurrentSystemAppearanceToWeb()
        case "setChromeAppearance":
            if let theme = dict["theme"] as? String {
                let isDark = dict["isDark"] as? Bool ?? false
                DashboardWindowController.shared.applyChromeAppearance(theme: theme, resolvedIsDark: isDark)
            } else if let isDark = dict["isDark"] as? Bool {
                DashboardWindowController.shared.applyChromeAppearance(theme: isDark ? "dark" : "light", resolvedIsDark: isDark)
            }
        case "setSetting":
            if let key = dict["key"] as? String {
                applySetting(key: key, value: dict["value"])
            }
        case "setPetSetting":
            if let key = dict["key"] as? String {
                applyPetSetting(key: key, value: dict["value"])
            }
        case "notify":
            if let title = dict["title"] as? String,
               let body = dict["body"] as? String {
                postNotification(
                    title: String(title.prefix(120)),
                    body: String(body.prefix(500)),
                    identifier: (dict["id"] as? String).map { String($0.prefix(160)) }
                )
            }
        case "getNotificationStatus":
            syncNotificationPermission(requestIfNeeded: false)
        case "requestNotificationPermission":
            // Sent when the user switches limit alerts on, so the system
            // permission dialog appears in direct response to that gesture
            // instead of surprising them when the first alert fires.
            syncNotificationPermission(requestIfNeeded: true)
        case "action":
            if let name = dict["name"] as? String {
                if name == "saveImageToDownloads" {
                    saveImageToDownloads(payload: dict)
                } else if name == "copyImageToClipboard" {
                    copyImageToClipboard(payload: dict)
                } else if name == "openURL", let urlStr = dict["value"] as? String,
                          let url = URL(string: urlStr) {
                    NSWorkspace.shared.open(url)
                } else {
                    runAction(name)
                }
            }
        default:
            break
        }
    }

    private func syncNotificationPermission(requestIfNeeded: Bool) {
        let center = UNUserNotificationCenter.current()
        Task {
            var settings = await center.notificationSettings()
            if requestIfNeeded && settings.authorizationStatus == .notDetermined {
                _ = try? await center.requestAuthorization(options: [.alert, .sound])
                settings = await center.notificationSettings()
            }
            let status: String
            switch settings.authorizationStatus {
            case .authorized, .provisional:
                status = "granted"
            case .denied:
                status = "denied"
            default:
                status = "notDetermined"
            }
            let js = "window.dispatchEvent(new CustomEvent('native:notificationPermission', { detail: { status: \"\(status)\" } }));"
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func postNotification(title: String, body: String, identifier: String?) {
        let center = UNUserNotificationCenter.current()
        Task {
            let settings = await center.notificationSettings()
            var allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            if settings.authorizationStatus == .notDetermined {
                allowed = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
            }
            guard allowed else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            let request = UNNotificationRequest(
                identifier: identifier ?? UUID().uuidString,
                content: content,
                trigger: nil
            )
            try? await center.add(request)
        }
    }

    // MARK: - State push

    func pushSettings() {
        let launchAtLoginValue: Bool
        let launchAtLoginSupported: Bool
        if #available(macOS 13, *) {
            launchAtLoginValue = SMAppService.mainApp.status == .enabled
            launchAtLoginSupported = true
        } else {
            launchAtLoginValue = false
            launchAtLoginSupported = false
        }
        let limitsSettings = LimitsSettingsStore.shared
        let hiddenProviders = limitsSettings.hiddenProviders
        let menuBarItems = MenuBarDisplayPreferences.read()
        let availableItemIDs = MenuBarDisplayPreferences.availableItemIDs(
            for: viewModel?.usageLimits,
            keepingSelected: menuBarItems,
            hiddenProviders: hiddenProviders
        )
        // Filter the PAYLOAD against currently-available ids, but never persist
        // the pruned list. Availability is transient state: a single 4xx from a
        // provider (e.g. Codex wham during token refresh) yields a "healthy but
        // windowless" response, and persisting the prune permanently erased the
        // user's saved metric selection — it never came back when the provider
        // recovered. Junk/duplicate ids are still self-healed by
        // MenuBarDisplayPreferences.read(), which normalizes against the full
        // metric universe; rendering defensively skips unavailable metrics.
        let normalizedMenuBarItems = MenuBarDisplayPreferences.normalize(
            menuBarItems,
            allowedIDs: Set(availableItemIDs)
        )
        let payload: [String: Any] = [
            "showStats": UserDefaults.standard.object(forKey: "MenuBarShowStats") as? Bool ?? true,
            "menuBarItems": normalizedMenuBarItems,
            "menuBarAvailableItems": MenuBarDisplayPreferences.availableItemsPayload(
                for: viewModel?.usageLimits,
                keepingSelected: normalizedMenuBarItems,
                hiddenProviders: hiddenProviders
            ),
            "menuBarMaxItems": MenuBarDisplayPreferences.maxVisibleItems,
            "menuBarIconStyle": MenuBarIconStyle.current().rawValue,
            // Legacy field kept so an older bundled dashboard still renders a
            // sensible toggle state.
            "animatedIcon": MenuBarIconStyle.current() != .static,
            "toastOnReset": WeeklyLimitResetDetector.toastEnabled(),
            "confettiOnReset": WeeklyLimitResetDetector.confettiEnabled(),
            "autoUpdateEnabled": UpdateChecker.shared.autoUpdateEnabled,
            "launchAtLogin": launchAtLoginValue,
            "launchAtLoginSupported": launchAtLoginSupported,
            "dynamicIslandEnabled": UserDefaults.standard.bool(forKey: DynamicIslandController.enabledDefaultsKey),
            "hideMenuBarIcon": UserDefaults.standard.bool(forKey: StatusBarController.hideMenuBarIconKey),
            // macOS-only feature flag: the Windows bridge never sends this, so
            // the dashboard can gate the Labs toggle on its presence.
            "dynamicIslandSupported": true,
            "version": UpdateChecker.shared.currentVersion(),
            "updateStatus": UpdateChecker.shared.statusText ?? NSNull(),
            "updateBusy": UpdateChecker.shared.isBusy,
            "isSyncing": viewModel?.isSyncing ?? false,
            "locale": NativeLocalization.currentPreference,
            "currency": UserDefaults.standard.string(forKey: "MenuBarCurrency") ?? "USD",
            "currencySymbol": UserDefaults.standard.string(forKey: "MenuBarCurrencySymbol") ?? "$",
            "exchangeRate": UserDefaults.standard.object(forKey: "MenuBarExchangeRate") as? Double ?? 1.0,
            "limitsDisplayMode": limitsSettings.displayMode.bridgeKey,
            "limitsPreferences": limitsSettings.limitsPreferencesPayload,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.dispatchEvent(new CustomEvent('native:settings', { detail: \(json) }));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    func pushPetSettings() {
        guard let controller = desktopPetController else { return }
        let payload: [String: Any] = [
            "visible": controller.isVisible,
            "character": PetCharacterStore.shared.character.rawValue,
            "botColor": PetCharacterStore.shared.botColor,
            "size": PetSizePreset.from(scale: controller.uiState.floatingScale).rawValue,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.dispatchEvent(new CustomEvent('native:petSettings', { detail: \(json) }));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Setters

    private func applySetting(key: String, value: Any?) {
        switch key {
        case "showStats":
            if let bool = value as? Bool {
                UserDefaults.standard.set(bool, forKey: "MenuBarShowStats")
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "menuBarItems":
            if let ids = value as? [String] {
                MenuBarDisplayPreferences.write(ids)
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            } else if let raw = value as? [Any] {
                MenuBarDisplayPreferences.write(raw.compactMap { $0 as? String })
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "menuBarIconStyle":
            if let raw = value as? String, let style = MenuBarIconStyle(rawValue: raw) {
                MenuBarIconStyle.setCurrent(style)
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "animatedIcon":
            // Legacy toggle from older dashboards: true restores the default
            // character, false maps to the static icon.
            if let bool = value as? Bool {
                MenuBarIconStyle.setCurrent(bool ? .clawd : .static)
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "toastOnReset":
            if let bool = value as? Bool {
                UserDefaults.standard.set(bool, forKey: WeeklyLimitResetDetector.toastEnabledKey)
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "confettiOnReset":
            if let bool = value as? Bool {
                UserDefaults.standard.set(bool, forKey: WeeklyLimitResetDetector.confettiEnabledKey)
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "autoUpdateEnabled":
            if let bool = value as? Bool {
                UpdateChecker.shared.autoUpdateEnabled = bool
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "launchAtLogin":
            if let bool = value as? Bool {
                setLaunchAtLogin(bool)
            }
        case "dynamicIslandEnabled":
            if let bool = value as? Bool {
                let wasEnabled = dynamicIslandController?.isEnabled == true
                // Controller persists the flag itself (single write path shared
                // with the popover menu), then shows/hides the island panel.
                dynamicIslandController?.setEnabled(bool)
                if !bool {
                    // Match the native menu path: disabling the island also
                    // clears the hide-icon flag, so re-enabling the island
                    // never silently re-hides the menu bar icon.
                    StatusBarController.setMenuBarIconHidden(false)
                } else if !wasEnabled {
                    StatusBarController.offerHideIconPromptAfterIslandEnabled()
                }
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "hideMenuBarIcon":
            if let bool = value as? Bool {
                // A direct bridge message must obey the same never-zero-surface
                // invariant as the native menu, even if an older dashboard
                // sends this setting while the island is disabled.
                if bool, dynamicIslandController?.isEnabled != true {
                    dynamicIslandController?.setEnabled(true)
                }
                StatusBarController.setMenuBarIconHidden(bool)
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "locale":
            LocalizationObserver.shared.storePreference(value)
            NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            WidgetCenter.shared.reloadAllTimelines()
        case "currency":
            if let str = value as? String {
                UserDefaults.standard.set(str, forKey: "MenuBarCurrency")
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
                WidgetCenter.shared.reloadAllTimelines()
            }
        case "tokenUnitSystem":
            if let str = value as? String {
                UserDefaults.standard.set(str, forKey: TokenFormatter.unitSystemDefaultsKey)
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
            }
        case "currencySymbol":
            if let str = value as? String, !str.isEmpty {
                UserDefaults.standard.set(str, forKey: "MenuBarCurrencySymbol")
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
                WidgetCenter.shared.reloadAllTimelines()
            }
        case "exchangeRate":
            let rate: Double?
            if let d = value as? Double {
                rate = d
            } else if let n = value as? NSNumber {
                rate = n.doubleValue
            } else if let s = value as? String {
                rate = Double(s)
            } else {
                rate = nil
            }
            if let rate, rate.isFinite, rate > 0 {
                UserDefaults.standard.set(rate, forKey: "MenuBarExchangeRate")
                NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
                WidgetCenter.shared.reloadAllTimelines()
            }
        case "limitsPreferences":
            // Fall through to pushSettings even when the snapshot applies:
            // provider visibility affects the selectable menu-bar metrics, so
            // the stored selection must self-heal and the dropdown payload
            // refresh. The echo is convergent — the dashboard receives its own
            // snapshot back and does not write again.
            if let raw = value as? [String: Any] {
                _ = LimitsSettingsStore.shared.applyBridgeSnapshot(raw)
            }
        case "limitsDisplayMode":
            if LimitsSettingsStore.shared.applyBridgeDisplayMode(value) {
                return
            }
        default:
            break
        }
        pushSettings()
    }

    private func applyPetSetting(key: String, value: Any?) {
        guard let controller = desktopPetController else { return }
        // No trailing pushPetSettings() here: every mutation path below already pushes
        // (show/hide/setSize/setCharacter), and their same-value guards only skip the
        // echo when the dashboard's optimistic state already matches.
        switch key {
        case "visible":
            if let visible = value as? Bool {
                visible ? controller.show() : controller.hide()
            }
        case "character":
            if let raw = value as? String, let character = PetCharacter(rawValue: raw) {
                controller.setCharacter(character)
            }
        case "botColor":
            if let raw = value as? String {
                // Unlike the paths above, the store has no dashboard-visible side effect
                // to echo, so push explicitly after it settles.
                PetCharacterStore.shared.setBotColor(raw)
                pushPetSettings()
            }
        case "size":
            if let raw = value as? String, let size = PetSizePreset(rawValue: raw) {
                controller.setSize(size)
            }
        default:
            break
        }
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        guard #available(macOS 13, *) else { return }
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            // Registration failed — keep previous state
        }
        // Refresh manager so popover menu reflects the new state
        launchAtLoginManager?.refresh()
    }

    // MARK: - Actions

    private func runAction(_ name: String) {
        switch name {
        case "syncNow":
            if let viewModel {
                Task { await viewModel.triggerSync() }
            }
        case "checkForUpdates":
            UpdateChecker.shared.check(silent: false)
            // UpdateChecker mutates statusText synchronously; push a follow-up snapshot
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.pushSettings()
            }
        case "openAbout":
            if let url = URL(string: "https://github.com/xiufengsun/TokenTracker") {
                NSWorkspace.shared.open(url)
            }
        case "openWidgetGallery":
            // There is no public macOS API to open the Edit Widgets UI
            // directly — neither NSWorkspace URL schemes nor AppKit expose
            // the widget picker. The most honest + reliable response is a
            // native alert that explains the two-step flow (right-click
            // desktop → Edit Widgets → search TokenTracker).
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = Strings.addWidgetsTitle
                alert.informativeText = Strings.addWidgetsMessage
                alert.alertStyle = .informational
                alert.addButton(withTitle: Strings.gotItButton)
                alert.runModal()
            }
        case "quit":
            AppDelegate.requestQuit()
        default:
            break
        }
    }

    // MARK: - Clipboard image copy

    private func copyImageToClipboard(payload: [String: Any]) {
        let requestId = (payload["requestId"] as? String) ?? ""
        guard let dataUrl = payload["dataUrl"] as? String else {
            postCopyImageResult(requestId: requestId, ok: false, error: "missing dataUrl")
            return
        }
        guard let commaIdx = dataUrl.firstIndex(of: ",") else {
            postCopyImageResult(requestId: requestId, ok: false, error: "invalid data URL")
            return
        }
        let base64 = String(dataUrl[dataUrl.index(after: commaIdx)...])
        guard let imageData = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
              let image = NSImage(data: imageData) else {
            postCopyImageResult(requestId: requestId, ok: false, error: "decode failed")
            return
        }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.writeObjects([image])
        postCopyImageResult(requestId: requestId, ok: true, error: nil)
    }

    private func postCopyImageResult(requestId: String, ok: Bool, error: String?) {
        var detail: [String: Any] = [
            "requestId": requestId,
            "ok": ok,
        ]
        if let error { detail["error"] = error }
        guard
            let data = try? JSONSerialization.data(withJSONObject: detail, options: []),
            let json = String(data: data, encoding: .utf8)
        else { return }
        let js = "window.dispatchEvent(new CustomEvent('native:copyImageResult', { detail: \(json) }));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Image saving

    private func saveImageToDownloads(payload: [String: Any]) {
        let requestId = (payload["requestId"] as? String) ?? ""
        guard let dataUrl = payload["dataUrl"] as? String else {
            postSaveImageResult(requestId: requestId, ok: false, path: nil, error: "missing dataUrl")
            return
        }
        let rawName = (payload["filename"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? "tokentracker-share-\(Int(Date().timeIntervalSince1970)).png"
        let filename = sanitizeFilename(rawName)

        guard let commaIdx = dataUrl.firstIndex(of: ",") else {
            postSaveImageResult(requestId: requestId, ok: false, path: nil, error: "invalid data URL")
            return
        }
        let base64 = String(dataUrl[dataUrl.index(after: commaIdx)...])
        guard let imageData = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            postSaveImageResult(requestId: requestId, ok: false, path: nil, error: "base64 decode failed")
            return
        }

        let downloadsDir: URL
        do {
            downloadsDir = try FileManager.default.url(
                for: .downloadsDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
        } catch {
            postSaveImageResult(requestId: requestId, ok: false, path: nil, error: error.localizedDescription)
            return
        }

        let target = uniqueFileURL(base: downloadsDir.appendingPathComponent(filename))
        do {
            try imageData.write(to: target, options: .atomic)
        } catch {
            postSaveImageResult(requestId: requestId, ok: false, path: nil, error: error.localizedDescription)
            return
        }

        NSWorkspace.shared.activateFileViewerSelecting([target])
        postSaveImageResult(requestId: requestId, ok: true, path: target.path, error: nil)
    }

    private func sanitizeFilename(_ raw: String) -> String {
        let invalidChars = CharacterSet(charactersIn: "/\\:*?\"<>|")
        let cleaned = raw.components(separatedBy: invalidChars).joined()
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "tokentracker-share.png" : trimmed
    }

    private func uniqueFileURL(base: URL) -> URL {
        var candidate = base
        var index = 1
        let fileManager = FileManager.default
        let directory = base.deletingLastPathComponent()
        let stem = base.deletingPathExtension().lastPathComponent
        let ext = base.pathExtension
        while fileManager.fileExists(atPath: candidate.path) {
            let nextName = ext.isEmpty ? "\(stem)-\(index)" : "\(stem)-\(index).\(ext)"
            candidate = directory.appendingPathComponent(nextName)
            index += 1
        }
        return candidate
    }

    private func postSaveImageResult(requestId: String, ok: Bool, path: String?, error: String?) {
        var detail: [String: Any] = [
            "requestId": requestId,
            "ok": ok,
        ]
        if let path { detail["path"] = path }
        if let error { detail["error"] = error }
        guard
            let data = try? JSONSerialization.data(withJSONObject: detail, options: []),
            let json = String(data: data, encoding: .utf8)
        else { return }
        let js = "window.dispatchEvent(new CustomEvent('native:saveImageResult', { detail: \(json) }));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }
}
