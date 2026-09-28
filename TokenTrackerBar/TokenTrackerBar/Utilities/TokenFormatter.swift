import Foundation

enum TokenFormatter {

    /// Pushed by the dashboard (Settings → Appearance → Number units) via
    /// NativeBridge; "chinese" selects the Wan/Yi scale, anything else K/M/B.
    static let unitSystemDefaultsKey = "MenuBarTokenUnitSystem"

    static func usesChineseUnits(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.string(forKey: unitSystemDefaultsKey) == "chinese"
    }

    /// Formats a token count into a compact human-readable string.
    /// Examples: 789 -> "789", 1500 -> "1.5K", 2300000 -> "2.3M", 5000000000 -> "5.0B"
    static func formatCompact(_ value: Int) -> String {
        formatCompact(value, chineseUnits: usesChineseUnits())
    }

    static func formatCompact(_ value: Int, chineseUnits: Bool) -> String {
        if chineseUnits { return formatChinese(value) }
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

    /// Mirrors `formatChineseNumber` in dashboard/src/lib/format.ts: exact digits
    /// below 1万, then one decimal with a trailing ".0" dropped, carrying into the
    /// next unit when rounding reaches 10000 (99999999 -> "1亿", not "10000万").
    /// Examples: 9999 -> "9999", 12345 -> "1.2万", 123456789 -> "1.2亿"
    static func formatChinese(_ value: Int) -> String {
        let sign = value < 0 ? "-" : ""
        let absValue = Double(value.magnitude)
        if absValue < 10_000 { return "\(sign)\(value.magnitude)" }

        func rounded(_ v: Double) -> Double { (v * 10).rounded() / 10 }
        func text(_ v: Double, _ unit: String) -> String {
            var digits = String(format: "%.1f", rounded(v))
            if digits.hasSuffix(".0") { digits.removeLast(2) }
            return "\(sign)\(digits)\(unit)"
        }

        if absValue >= 1e12 { return text(absValue / 1e12, "万亿") }
        if absValue >= 1e8 {
            let yi = rounded(absValue / 1e8)
            return yi >= 10_000 ? text(yi / 10_000, "万亿") : text(yi, "亿")
        }
        let wan = rounded(absValue / 1e4)
        return wan >= 10_000 ? text(wan / 10_000, "亿") : text(wan, "万")
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
    /// Returns "<symbol>0.00" on failure.
    static func formatCostFromString(_ value: String?) -> String {
        guard let value, let parsed = Double(value) else {
            return "\(currentCurrencySymbol())0.00"
        }
        return formatCost(parsed)
    }

    /// Formats a ratio as a percentage string. Example: 0.425 -> "42.5%"
    static func formatPercent(_ value: Double) -> String {
        String(format: "%.1f%%", value * 100)
    }
}
