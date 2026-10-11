import Foundation
import ServiceManagement

@MainActor
final class LaunchAtLoginManager: ObservableObject {

    @Published var isEnabled: Bool = false

    /// Whether the current macOS version supports SMAppService (macOS 13+).
    /// When false, the "Launch at Login" UI should be hidden entirely.
    var isSupported: Bool {
        if #available(macOS 13, *) { return true }
        return false
    }

    private static let didAutoEnableKey = "LaunchAtLoginAutoEnabled"

    init() {
        guard !NativeQAProfile.isQABuild else { fatalError("Native QA cannot construct login-item services") }
        guard #available(macOS 13, *) else { return }

        isEnabled = SMAppService.mainApp.status == .enabled

        // First-run default: enable launch-at-login so users see usage
        // updates without re-opening the app. Only set the persistence flag
        // once registration has actually settled, so a transient failure
        // (e.g. signing issue on a dev build) retries on next launch instead
        // of being permanently swallowed.
        if !UserDefaults.standard.bool(forKey: Self.didAutoEnableKey) {
            if !isEnabled {
                try? SMAppService.mainApp.register()
                isEnabled = SMAppService.mainApp.status == .enabled
            }
            if isEnabled {
                UserDefaults.standard.set(true, forKey: Self.didAutoEnableKey)
            }
        }
    }

    func toggle() {
        guard #available(macOS 13, *) else { return }

        do {
            if isEnabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            // Registration failed — revert the UI state
        }
        isEnabled = SMAppService.mainApp.status == .enabled
    }

    /// Re-read the SMAppService status. Useful when an external code path
    /// (e.g. NativeBridge) toggles registration directly.
    func refresh() {
        guard #available(macOS 13, *) else { return }
        isEnabled = SMAppService.mainApp.status == .enabled
    }
}
