import Foundation

/// Decides whether a macOS process launch should open the Dashboard window.
///
/// Finder/Dock opens arrive with a launch Apple Event and should present the
/// Dashboard. Legacy login items set `keyAELaunchedAsLogInItem` on that event
/// and must stay quiet. `SMAppService.mainApp` login launches have **no**
/// launch Apple Event at all (`currentAppleEvent` is nil), which previously
/// collapsed to the "open Dashboard" branch (#989). Direct/dev launches with
/// no event and no registered login item still open the Dashboard so local
/// runs stay convenient.
enum LoginLaunchPresentationPolicy {
    static func shouldOpenDashboardOnLaunch(
        launchAppleEventPresent: Bool,
        launchedAsLoginItem: Bool,
        loginItemRegistered: Bool
    ) -> Bool {
        if launchedAsLoginItem {
            return false
        }
        if launchAppleEventPresent {
            return true
        }
        // No launch Apple Event: quiet only when Launch at Login is registered
        // (the SMAppService login path). Otherwise treat as a direct/dev open.
        return !loginItemRegistered
    }
}
