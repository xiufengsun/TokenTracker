import LocalAuthentication
import SwiftUI

enum AppAppearanceMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

enum PhoneCurrency: String, CaseIterable, Identifiable {
    case usd = "USD"
    case eur = "EUR"
    case gbp = "GBP"
    case cny = "CNY"
    case jpy = "JPY"
    case hkd = "HKD"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .usd: return "$"
        case .eur: return "€"
        case .gbp: return "£"
        case .cny: return "¥"
        case .jpy: return "¥"
        case .hkd: return "HK$"
        }
    }

    /// Mirrors `DEFAULT_RATES` in `dashboard/src/lib/currency.ts`.
    var defaultRate: Double {
        switch self {
        case .usd: return 1.0
        case .eur: return 0.92
        case .gbp: return 0.79
        case .cny: return 7.20
        case .jpy: return 155.0
        case .hkd: return 7.80
        }
    }

    var displayLabel: String {
        switch self {
        case .usd: return "USD ($)"
        case .eur: return "EUR (€)"
        case .gbp: return "GBP (£)"
        case .cny: return "CNY (¥)"
        case .jpy: return "JPY (¥)"
        case .hkd: return "HKD (HK$)"
        }
    }
}

enum TokenNumberFormat: String, CaseIterable, Identifiable {
    case compact
    case exact

    var id: String { rawValue }

    var label: String {
        switch self {
        case .compact: return "Compact (1.4M)"
        case .exact: return "Exact (1,420,000)"
        }
    }
}

enum TokenUnitScale: String, CaseIterable, Identifiable {
    case english
    case chinese

    var id: String { rawValue }

    var label: String {
        switch self {
        case .english: return "K / M / B"
        case .chinese: return "万 / 亿"
        }
    }
}

enum WindowMeterStyle: String, CaseIterable, Identifiable {
    case used
    case remaining

    var id: String { rawValue }

    var label: String {
        switch self {
        case .used: return "Used"
        case .remaining: return "Remaining"
        }
    }
}

enum BackgroundRefreshPolicyOption: String, CaseIterable, Identifiable {
    case onOpen
    case fiveMinutes
    case fifteenMinutes

    var id: String { rawValue }

    var label: String {
        switch self {
        case .onOpen: return "On app open"
        case .fiveMinutes: return "Every 5 min while active"
        case .fifteenMinutes: return "Every 15 min (Cloud cadence)"
        }
    }

    var intervalSeconds: TimeInterval? {
        switch self {
        case .onOpen: return nil
        case .fiveMinutes: return 300
        case .fifteenMinutes: return 900
        }
    }
}

/// User-configured spend targets and subscription renewal dates stored locally on iPhone.
/// Spend targets evaluate Cloud-synced estimated costs; subscription cycles mirror the
/// macOS `SubscriptionCycle` renewal math without claiming live local CLI quota reads.
struct TrackedToolBudget: Codable, Equatable, Identifiable {
    var id: String { source }
    var source: String
    var fiveHourBudgetUsd: Double?
    var weeklyBudgetUsd: Double?
    var monthlyBudgetUsd: Double?
    var billingCycle: String? // "monthly" | "yearly"
    var nextRenewalISO: String?
    var autoRenew: Bool

    init(
        source: String,
        fiveHourBudgetUsd: Double? = nil,
        weeklyBudgetUsd: Double? = nil,
        monthlyBudgetUsd: Double? = nil,
        billingCycle: String? = nil,
        nextRenewalISO: String? = nil,
        autoRenew: Bool = true
    ) {
        self.source = source
        self.fiveHourBudgetUsd = fiveHourBudgetUsd
        self.weeklyBudgetUsd = weeklyBudgetUsd
        self.monthlyBudgetUsd = monthlyBudgetUsd
        self.billingCycle = billingCycle
        self.nextRenewalISO = nextRenewalISO
        self.autoRenew = autoRenew
    }

    var hasAnyRule: Bool {
        (fiveHourBudgetUsd ?? 0) > 0
            || (weeklyBudgetUsd ?? 0) > 0
            || (monthlyBudgetUsd ?? 0) > 0
            || (nextRenewalISO != nil && !(nextRenewalISO?.isEmpty ?? true))
    }
}

@MainActor
final class PhonePreferences: ObservableObject {
    @Published var appearance: AppAppearanceMode {
        didSet { defaults.set(appearance.rawValue, forKey: Keys.appearance) }
    }
    @Published var currency: PhoneCurrency {
        didSet {
            defaults.set(currency.rawValue, forKey: Keys.currency)
            syncSharedTokenFormatterDefaults()
        }
    }
    @Published var tokenNumberFormat: TokenNumberFormat {
        didSet { defaults.set(tokenNumberFormat.rawValue, forKey: Keys.tokenNumberFormat) }
    }
    @Published var tokenUnitScale: TokenUnitScale {
        didSet {
            defaults.set(tokenUnitScale.rawValue, forKey: Keys.tokenUnitScale)
            syncSharedTokenFormatterDefaults()
        }
    }
    @Published var windowMeterStyle: WindowMeterStyle {
        didSet { defaults.set(windowMeterStyle.rawValue, forKey: Keys.windowMeterStyle) }
    }
    @Published var refreshPolicy: BackgroundRefreshPolicyOption {
        didSet { defaults.set(refreshPolicy.rawValue, forKey: Keys.refreshPolicy) }
    }
    @Published var dailySpendTargetUsd: Double {
        didSet { defaults.set(dailySpendTargetUsd, forKey: Keys.dailySpendTargetUsd) }
    }
    @Published var weeklySpendTargetUsd: Double {
        didSet { defaults.set(weeklySpendTargetUsd, forKey: Keys.weeklySpendTargetUsd) }
    }
    @Published var monthlySpendTargetUsd: Double {
        didSet { defaults.set(monthlySpendTargetUsd, forKey: Keys.monthlySpendTargetUsd) }
    }
    @Published var discreteAmounts: Bool {
        didSet { defaults.set(discreteAmounts, forKey: Keys.discreteAmounts) }
    }
    @Published var hideSwitcherSnapshot: Bool {
        didSet { defaults.set(hideSwitcherSnapshot, forKey: Keys.hideSwitcherSnapshot) }
    }
    @Published var requireBiometricUnlock: Bool {
        didSet { defaults.set(requireBiometricUnlock, forKey: Keys.requireBiometricUnlock) }
    }
    @Published var toolBudgets: [String: TrackedToolBudget] {
        didSet { persistToolBudgets() }
    }

    private let defaults: UserDefaults

    private enum Keys {
        static let appearance = "tt.phone.appearance"
        static let currency = "tt.phone.currency"
        static let tokenNumberFormat = "tt.phone.tokenFormat"
        static let tokenUnitScale = "tt.phone.tokenUnitScale"
        static let windowMeterStyle = "tt.phone.windowMeterStyle"
        static let refreshPolicy = "tt.phone.refreshPolicy"
        static let dailySpendTargetUsd = "tt.phone.dailySpendTargetUsd"
        static let weeklySpendTargetUsd = "tt.phone.weeklySpendTargetUsd"
        static let monthlySpendTargetUsd = "tt.phone.monthlySpendTargetUsd"
        static let discreteAmounts = "tt.phone.discreteAmounts"
        static let hideSwitcherSnapshot = "tt.phone.hideSwitcherSnapshot"
        static let requireBiometricUnlock = "tt.phone.requireBiometricUnlock"
        static let toolBudgets = "tt.phone.toolBudgets"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.appearance = AppAppearanceMode(rawValue: defaults.string(forKey: Keys.appearance) ?? "") ?? .system
        self.currency = PhoneCurrency(rawValue: defaults.string(forKey: Keys.currency) ?? "") ?? .usd
        self.tokenNumberFormat = TokenNumberFormat(rawValue: defaults.string(forKey: Keys.tokenNumberFormat) ?? "") ?? .compact
        self.tokenUnitScale = TokenUnitScale(rawValue: defaults.string(forKey: Keys.tokenUnitScale) ?? "") ?? .english
        self.windowMeterStyle = WindowMeterStyle(rawValue: defaults.string(forKey: Keys.windowMeterStyle) ?? "") ?? .used
        self.refreshPolicy = BackgroundRefreshPolicyOption(rawValue: defaults.string(forKey: Keys.refreshPolicy) ?? "") ?? .fifteenMinutes
        self.dailySpendTargetUsd = defaults.object(forKey: Keys.dailySpendTargetUsd) as? Double ?? 0
        self.weeklySpendTargetUsd = defaults.object(forKey: Keys.weeklySpendTargetUsd) as? Double ?? 0
        self.monthlySpendTargetUsd = defaults.object(forKey: Keys.monthlySpendTargetUsd) as? Double ?? 0
        self.discreteAmounts = defaults.bool(forKey: Keys.discreteAmounts)
        self.hideSwitcherSnapshot = defaults.object(forKey: Keys.hideSwitcherSnapshot) as? Bool ?? true
        self.requireBiometricUnlock = defaults.bool(forKey: Keys.requireBiometricUnlock)
        if let data = defaults.data(forKey: Keys.toolBudgets),
           let decoded = try? JSONDecoder().decode([String: TrackedToolBudget].self, from: data) {
            self.toolBudgets = decoded
        } else {
            self.toolBudgets = [:]
        }
        syncSharedTokenFormatterDefaults()
    }

    func formatTokens(_ count: Int) -> String {
        switch tokenNumberFormat {
        case .exact:
            return count.formatted(.number)
        case .compact:
            return TokenFormatter.formatCompact(count, chineseUnits: tokenUnitScale == .chinese)
        }
    }

    func formatCost(_ usd: Double, masked: Bool? = nil) -> String {
        let shouldMask = masked ?? discreteAmounts
        if shouldMask {
            return "\(currency.symbol)•••"
        }
        let converted = usd * currency.defaultRate
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = true
        formatter.minimumFractionDigits = currency == .jpy ? 0 : 2
        formatter.maximumFractionDigits = currency == .jpy ? 0 : 2
        let digits = formatter.string(from: NSNumber(value: converted)) ?? String(format: "%.2f", converted)
        return "\(currency.symbol)\(digits)"
    }

    func updateToolBudget(_ budget: TrackedToolBudget) {
        let key = budget.source.lowercased()
        if budget.hasAnyRule {
            toolBudgets[key] = budget
        } else {
            toolBudgets.removeValue(forKey: key)
        }
    }

    private func persistToolBudgets() {
        guard let data = try? JSONEncoder().encode(toolBudgets) else { return }
        defaults.set(data, forKey: Keys.toolBudgets)
    }

    private func syncSharedTokenFormatterDefaults() {
        UserDefaults.standard.set(currency.symbol, forKey: "MenuBarCurrencySymbol")
        UserDefaults.standard.set(currency.defaultRate, forKey: "MenuBarExchangeRate")
        UserDefaults.standard.set(tokenUnitScale.rawValue, forKey: TokenFormatter.unitSystemDefaultsKey)
    }

    func authenticateWithBiometrics() async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return true
        }
        do {
            return try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Unlock TokenTracker to view your synced usage and spend."
            )
        } catch {
            return false
        }
    }
}
