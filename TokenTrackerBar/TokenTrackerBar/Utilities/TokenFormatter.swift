import Foundation

enum TokenFormatter {

    /// Formats a token count into a compact human-readable string.
    /// Examples: 789 -> "789", 1500 -> "1.5K", 2300000 -> "2.3M", 5000000000 -> "5.0B"
    static func formatCompact(_ value: Int) -> String {
        let abs = abs(value)
        let sign = value < 0 ? "-" : ""

        switch abs {
        case 1_000_000_000...:
            let v = Double(abs) / 1_000_000_000.0
            return "\(sign)\(String(format: "%.1f", v))B"
        case 1_000_000...:
            let v = Double(abs) / 1_000_000.0
            return "\(sign)\(String(format: "%.1f", v))M"
        case 1_000...:
            let v = Double(abs) / 1_000.0
            return "\(sign)\(String(format: "%.1f", v))K"
        default:
            return "\(value)"
        }
    }

    /// Symbol + rate are pushed by the dashboard via NativeBridge. Swift never
    /// hardcodes per-currency knowledge — single source of truth lives in
    /// dashboard/src/lib/currency.ts (`SUPPORTED_CURRENCIES`).
    /// Defaults below render plain USD when no preference has been pushed yet.
    static let defaultCurrencySymbol = "$"
    static let defaultExchangeRate: Double = 1.0

    /// Returns the symbol for the current currency preference. Falls back to "$"
    /// when no setting has been pushed by the dashboard.
    static func currentCurrencySymbol() -> String {
        let stored = UserDefaults.standard.string(forKey: "MenuBarCurrencySymbol")
        if let stored, !stored.isEmpty { return stored }
        return defaultCurrencySymbol
    }

    /// Reads the current USD→target rate. Prefers a rate pushed by the dashboard,
    /// falls back to 1.0 (USD identity) when none exists or the value is invalid.
    static func currentExchangeRate() -> Double {
        if let stored = UserDefaults.standard.object(forKey: "MenuBarExchangeRate") as? Double,
           stored.isFinite, stored > 0 {
            return stored
        }
        return defaultExchangeRate
    }

    /// Grouped decimal with exactly two fraction digits (14941.83 -> "14,941.83").
    /// Fixed POSIX locale so the menu bar / popover render identically everywhere.
    private static let costNumberFormatter: NumberFormatter = {
        let fmt = NumberFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.numberStyle = .decimal
        fmt.usesGroupingSeparator = true
        fmt.minimumFractionDigits = 2
        fmt.maximumFractionDigits = 2
        return fmt
    }()

    /// Formats a cost value using the active currency. Example: 1.5 -> "$1.50" (USD)
    /// or "¥10.80" (CNY @ 7.2) or "€1.38" (EUR @ 0.92). Large values gain a
    /// thousands separator: "$14,941.83".
    static func formatCost(_ value: Double) -> String {
        let symbol = currentCurrencySymbol()
        let rate = currentExchangeRate()
        let converted = value * rate
        let number = costNumberFormatter.string(from: NSNumber(value: converted))
            ?? String(format: "%.2f", converted)
        return "\(symbol)\(number)"
    }

    /// Parses a cost string (e.g. "1.234567") and formats per the current currency.
    /// Missing cost remains unavailable rather than becoming a zero bill.
    static func formatCostFromString(_ value: String?) -> String {
        guard let value, let parsed = Double(value) else {
            return "—"
        }
        return formatCost(parsed)
    }

    /// Formats a ratio as a percentage string. Example: 0.425 -> "42.5%"
    static func formatPercent(_ value: Double) -> String {
        String(format: "%.1f%%", value * 100)
    }
}
