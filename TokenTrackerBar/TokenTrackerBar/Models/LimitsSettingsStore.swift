import Foundation
import Combine

extension Notification.Name {
    static let nativeSettingsChanged = Notification.Name("NativeSettingsChanged")
    static let menuBarIconFrameUpdated = Notification.Name("MenuBarIconFrameUpdated")
}

/// How the Usage Limits panel renders utilization values.
///
/// `used` is the historical default and matches the public API surface
/// (`utilization` / `used_percent` providers all report how much was burned).
/// `remaining` flips the rendering to "100 - used" so power users can read
/// limits as a countdown. Both modes still surface the same underlying number.
enum LimitDisplayMode: String, CaseIterable, Identifiable {
    case used
    case remaining

    var id: String { rawValue }

    /// Stable identifier used by the dashboard bridge payload.
    var bridgeKey: String { rawValue }
}

struct LimitsPreferencesSnapshot: Equatable {
    let displayMode: LimitDisplayMode
    let providerOrder: [String]
    let providerVisibility: [String: Bool]
    let showSubscriptions: Bool
    let updatedAt: Int64?
}

/// Persists provider visibility and display order for the Usage Limits panel.
final class LimitsSettingsStore: ObservableObject {

    static let shared = LimitsSettingsStore(userDefaults: .standard)

    /// All known provider identifiers, in default display order.
    static let allProviders: [String] = ["claude", "codex", "cursor", "gemini", "kimi", "kiro", "grok", "copilot", "antigravity", "zcode", "opencodeGo", "commandCode", "qoder", "qoderCn", "codingPlan", "agentPlan", "devin", "workbuddy"]

    static let displayNames: [String: String] = [
        "claude": "Claude",
        "codex": "Codex",
        "cursor": "Cursor",
        "gemini": "Gemini",
        "kimi": "Kimi",
        "kiro": "Kiro",
        "grok": "Grok Build",
        "copilot": "GitHub Copilot",
        "antigravity": "Antigravity",
        "zcode": "ZCode",
        "opencodeGo": "OpenCode Go",
        "commandCode": "Command Code",
        "qoder": "Qoder",
        "qoderCn": "Qoder CN",
        "codingPlan": "Ark Coding Plan",
        "agentPlan": "Ark Agent Plan",
        "devin": "Devin",
        "workbuddy": "WorkBuddy",
    ]

    /// Providers whose visibility switch is also the consent to fetch them.
    /// They default OFF: only an explicit stored `true` may enable the
    /// credential-reading quota request.
    static let optInProviders: Set<String> = ["devin"]

    static let iconNames: [String: String] = [
        "claude": "ClaudeLogo",
        "codex": "CodexLogo",
        "cursor": "CursorLogo",
        "gemini": "GeminiLogo",
        "kimi": "KimiLogo",
        "kiro": "KiroLogo",
        "copilot": "CopilotLogo",
        "antigravity": "AntigravityLogo",
        "qoder": "QoderLogo",
        "qoderCn": "QoderCnLogo",
    ]

    // MARK: - Published state

    /// Ordered list of provider IDs reflecting the user's preferred order.
    @Published private(set) var providerOrder: [String]

    /// Visibility per provider. `true` = shown.
    @Published private(set) var providerVisibility: [String: Bool]

    /// Global rendering mode for utilization values. Default `.used` so
    /// users on existing installs see no change after upgrade.
    @Published private(set) var displayMode: LimitDisplayMode

    /// Whether inline subscription renewal bars are shown alongside limits.
    @Published private(set) var showSubscriptions: Bool

    /// Millisecond Unix timestamp for the last user-authored preference change.
    @Published private(set) var updatedAt: Int64?

    private let preferencesChangedSubject = PassthroughSubject<Void, Never>()
    var preferencesDidChange: AnyPublisher<Void, Never> {
        preferencesChangedSubject.eraseToAnyPublisher()
    }

    // MARK: - UserDefaults keys

    private static let orderKey = "LimitsProviderOrder"
    private static let visibilityKey = "LimitsProviderVisibility"
    private static let displayModeKey = "LimitsDisplayMode"
    private static let showSubscriptionsKey = "LimitsShowSubscriptions"
    private static let updatedAtKey = "LimitsPreferencesUpdatedAt"
    private let userDefaults: UserDefaults

    // MARK: - Init

    init(userDefaults: UserDefaults) {
        self.userDefaults = userDefaults
        let savedOrder = userDefaults.stringArray(forKey: Self.orderKey)
        let savedVis = userDefaults.dictionary(forKey: Self.visibilityKey)

        self.providerOrder = Self.normalizeProviderOrder(savedOrder)
        self.providerVisibility = Self.normalizeProviderVisibility(savedVis)
        self.displayMode = Self.readDisplayMode(from: userDefaults)
        self.showSubscriptions = Self.readShowSubscriptions(from: userDefaults)
        self.updatedAt = Self.readUpdatedAt(from: userDefaults)

        save()
    }

    private static func readDisplayMode(from userDefaults: UserDefaults) -> LimitDisplayMode {
        guard let raw = userDefaults.string(forKey: displayModeKey),
              let parsed = LimitDisplayMode(rawValue: raw) else {
            return .used
        }
        return parsed
    }

    private static func readUpdatedAt(from userDefaults: UserDefaults) -> Int64? {
        parseUpdatedAt(userDefaults.object(forKey: updatedAtKey))
    }

    private static func readShowSubscriptions(from userDefaults: UserDefaults) -> Bool {
        guard userDefaults.object(forKey: showSubscriptionsKey) != nil else {
            return true
        }
        return userDefaults.bool(forKey: showSubscriptionsKey)
    }

    private static func normalizeShowSubscriptions(_ raw: Any?) -> Bool {
        guard let number = raw as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else {
            return true
        }
        return number.boolValue
    }

    // MARK: - Helpers

    var limitsPreferencesPayload: [String: Any] {
        [
            "displayMode": displayMode.bridgeKey,
            "providerOrder": providerOrder,
            "providerVisibility": providerVisibility,
            "showSubscriptions": showSubscriptions,
            "updatedAt": updatedAt.map { NSNumber(value: $0) } ?? NSNull(),
        ]
    }

    func isVisible(_ id: String) -> Bool {
        providerVisibility[id] ?? Self.defaultVisibility(forProvider: id)
    }

    /// Devin is opt-in (see `optInProviders`); every other provider defaults on.
    static func defaultVisibility(forProvider id: String) -> Bool {
        !optInProviders.contains(id)
    }

    /// Providers the user explicitly hid. Hiding is user-authored intent, so it
    /// also removes that provider's metrics from the menu bar — unlike a
    /// transient provider outage, which keeps an already-selected metric.
    var hiddenProviders: Set<String> {
        Set(providerVisibility.filter { !$0.value }.keys)
    }

    /// Formats a raw utilization percent for compact surfaces (menu bar,
    /// Dynamic Island wings), honoring the shared used/remaining display mode
    /// and rounding to the nearest integer so both surfaces always agree.
    static func formatPercentText(_ utilization: Double, defaults: UserDefaults = .standard) -> String {
        let raw = min(max(utilization, 0), 100)
        let displayed = readDisplayMode(from: defaults) == .remaining ? (100 - raw) : raw
        return "\(Int(displayed.rounded()))%"
    }

    func setDisplayModeFromMenu(_ mode: LimitDisplayMode) {
        guard mode != displayMode else { return }
        applySnapshot(LimitsPreferencesSnapshot(
            displayMode: mode,
            providerOrder: providerOrder,
            providerVisibility: providerVisibility,
            showSubscriptions: showSubscriptions,
            updatedAt: nextLocalUpdatedAt()
        ), notifyBridge: true)
    }

    func setProviderVisibilityFromMenu(_ id: String, isVisible: Bool) {
        guard Self.allProviders.contains(id), providerVisibility[id] != isVisible else { return }
        var updated = providerVisibility
        updated[id] = isVisible
        applySnapshot(LimitsPreferencesSnapshot(
            displayMode: displayMode,
            providerOrder: providerOrder,
            providerVisibility: Self.normalizeProviderVisibility(updated),
            showSubscriptions: showSubscriptions,
            updatedAt: nextLocalUpdatedAt()
        ), notifyBridge: true)
    }

    func moveProviderFromMenu(from source: IndexSet, to destination: Int) {
        let normalized = Self.reorderedProviderOrder(providerOrder, moving: source, to: destination)
        guard normalized != providerOrder else { return }

        applySnapshot(LimitsPreferencesSnapshot(
            displayMode: displayMode,
            providerOrder: normalized,
            providerVisibility: providerVisibility,
            showSubscriptions: showSubscriptions,
            updatedAt: nextLocalUpdatedAt()
        ), notifyBridge: true)
    }

    func setShowSubscriptionsFromMenu(_ show: Bool) {
        guard show != showSubscriptions else { return }
        applySnapshot(LimitsPreferencesSnapshot(
            displayMode: displayMode,
            providerOrder: providerOrder,
            providerVisibility: providerVisibility,
            showSubscriptions: show,
            updatedAt: nextLocalUpdatedAt()
        ), notifyBridge: true)
    }

    /// `destination` follows SwiftUI `move(fromOffsets:toOffset:)` semantics on the original array.
    static func reorderedProviderOrder(_ currentOrder: [String], moving source: IndexSet, to destination: Int) -> [String] {
        var updated = normalizeProviderOrder(currentOrder)
        let indexes = source.filter { $0 >= 0 && $0 < updated.count }
        guard !indexes.isEmpty else { return updated }

        let items = indexes.map { updated[$0] }
        for index in indexes.sorted().reversed() {
            updated.remove(at: index)
        }

        let removedBeforeDestination = indexes.filter { $0 < destination }.count
        let insertAt = max(0, min(destination - removedBeforeDestination, updated.count))
        updated.insert(contentsOf: items, at: insertAt)
        return normalizeProviderOrder(updated)
    }

    func applyBridgeSnapshot(_ raw: [String: Any]) -> Bool {
        let snapshot = LimitsPreferencesSnapshot(
            displayMode: Self.normalizeDisplayMode(raw["displayMode"]),
            providerOrder: Self.normalizeProviderOrder(Self.rawProviderOrder(raw["providerOrder"])),
            providerVisibility: Self.normalizeProviderVisibility(raw["providerVisibility"] as? [String: Any]),
            showSubscriptions: Self.normalizeShowSubscriptions(raw["showSubscriptions"]),
            updatedAt: Self.parseUpdatedAt(raw["updatedAt"])
        )
        guard shouldApplyBridgeSnapshot(snapshot) else {
            return false
        }
        applySnapshot(snapshot, notifyBridge: false)
        return true
    }

    func applyBridgeDisplayMode(_ raw: Any?) -> Bool {
        guard let raw = raw as? String,
              let mode = LimitDisplayMode(rawValue: raw) else {
            return false
        }
        guard updatedAt == nil else {
            return false
        }
        return applySnapshot(LimitsPreferencesSnapshot(
            displayMode: mode,
            providerOrder: providerOrder,
            providerVisibility: providerVisibility,
            showSubscriptions: showSubscriptions,
            updatedAt: nil
        ), notifyBridge: false)
    }

    @discardableResult
    private func applySnapshot(_ snapshot: LimitsPreferencesSnapshot, notifyBridge: Bool) -> Bool {
        let normalized = LimitsPreferencesSnapshot(
            displayMode: snapshot.displayMode,
            providerOrder: Self.normalizeProviderOrder(snapshot.providerOrder),
            providerVisibility: Self.normalizeProviderVisibility(snapshot.providerVisibility),
            showSubscriptions: snapshot.showSubscriptions,
            updatedAt: snapshot.updatedAt
        )
        guard normalized.displayMode != displayMode ||
            normalized.providerOrder != providerOrder ||
            normalized.providerVisibility != providerVisibility ||
            normalized.showSubscriptions != showSubscriptions ||
            normalized.updatedAt != updatedAt else {
            return false
        }

        providerOrder = normalized.providerOrder
        providerVisibility = normalized.providerVisibility
        displayMode = normalized.displayMode
        showSubscriptions = normalized.showSubscriptions
        updatedAt = normalized.updatedAt
        save()

        // StatusBarController listens for this to refresh the composite image.
        NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
        if notifyBridge {
            preferencesChangedSubject.send()
        }
        return true
    }

    private func shouldApplyBridgeSnapshot(_ snapshot: LimitsPreferencesSnapshot) -> Bool {
        switch (snapshot.updatedAt, updatedAt) {
        case let (incoming?, current?):
            return incoming >= current
        case (_?, nil):
            return true
        case (nil, nil):
            return true
        case (nil, _?):
            return false
        }
    }

    private func nextLocalUpdatedAt() -> Int64 {
        let now = Self.currentTimeMillis()
        guard let current = updatedAt, now <= current else {
            return now
        }
        return current == Int64.max ? current : current + 1
    }

    private static func currentTimeMillis() -> Int64 {
        Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
    }

    private static func normalizeProviderOrder(_ raw: [String]?) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        for rawId in raw ?? [] {
            let id = rawId == "workbuddyAi" ? "workbuddy" : rawId
            guard allProviders.contains(id), !seen.contains(id) else { continue }
            ordered.append(id)
            seen.insert(id)
        }
        for id in allProviders where !seen.contains(id) {
            ordered.append(id)
        }
        return ordered
    }

    private static func normalizeProviderVisibility(_ raw: [String: Any]?) -> [String: Bool] {
        var visibility = Dictionary(uniqueKeysWithValues: allProviders.map { id in
            (id, rawBool(raw?[id]) ?? defaultVisibility(forProvider: id))
        })
        if let legacy = rawBool(raw?["workbuddyAi"]) {
            visibility["workbuddy"] = rawBool(raw?["workbuddy"]) == true || legacy
        }
        return visibility
    }

    private static func normalizeProviderVisibility(_ raw: [String: Bool]) -> [String: Bool] {
        normalizeProviderVisibility(raw.mapValues { $0 as Any })
    }

    private static func normalizeDisplayMode(_ raw: Any?) -> LimitDisplayMode {
        guard let raw = raw as? String,
              let parsed = LimitDisplayMode(rawValue: raw) else {
            return .used
        }
        return parsed
    }

    private static func rawProviderOrder(_ raw: Any?) -> [String]? {
        if let ids = raw as? [String] {
            return ids
        }
        if let values = raw as? [Any] {
            return values.compactMap { $0 as? String }
        }
        return nil
    }

    private static func rawBool(_ raw: Any?) -> Bool? {
        guard let number = raw as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else {
            return nil
        }
        return number.boolValue
    }

    private static func parseUpdatedAt(_ raw: Any?) -> Int64? {
        guard let raw, !(raw is NSNull) else {
            return nil
        }

        guard let number = raw as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return nil
        }

        switch String(cString: number.objCType) {
        case "c", "s", "i", "l", "q":
            return safeUpdatedAt(number.int64Value)
        case "C", "S", "I", "L", "Q":
            let value = number.uint64Value
            guard value <= UInt64(maxSafeUpdatedAt) else { return nil }
            return Int64(value)
        default:
            let value = number.doubleValue
            guard value.isFinite,
                  value.rounded(.towardZero) == value,
                  value >= Double(-maxSafeUpdatedAt),
                  value <= Double(maxSafeUpdatedAt) else {
                return nil
            }
            return Int64(value)
        }
    }

    private static let maxSafeUpdatedAt: Int64 = 9_007_199_254_740_991

    private static func safeUpdatedAt(_ value: Int64) -> Int64? {
        guard value >= -maxSafeUpdatedAt, value <= maxSafeUpdatedAt else {
            return nil
        }
        return value
    }

    private func save() {
        userDefaults.set(providerOrder, forKey: Self.orderKey)
        userDefaults.set(providerVisibility, forKey: Self.visibilityKey)
        userDefaults.set(displayMode.rawValue, forKey: Self.displayModeKey)
        userDefaults.set(showSubscriptions, forKey: Self.showSubscriptionsKey)
        if let updatedAt {
            userDefaults.set(updatedAt, forKey: Self.updatedAtKey)
        } else {
            userDefaults.removeObject(forKey: Self.updatedAtKey)
        }
    }
}
