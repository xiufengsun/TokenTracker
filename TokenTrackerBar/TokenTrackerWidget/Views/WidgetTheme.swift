import SwiftUI

// Self-contained styling so the widget extension does not need to import the
// main app's `Colors`/`TokenFormatter` files. The widget extension is a
// separate target with its own compilation unit and tight binary-size budget.

enum WidgetTheme {

    // MARK: - Heatmap palette
    static let heatmapLevels: [Color] = [
        Color(.sRGB, red: 0.5, green: 0.5, blue: 0.5, opacity: 0.10),
        Color.accentColor.opacity(0.25),
        Color.accentColor.opacity(0.50),
        Color.accentColor.opacity(0.75),
        Color.accentColor
    ]

    // MARK: - Limit bars
    static func limitBarColor(_ fraction: Double) -> Color {
        if fraction >= 0.9 { return Color(.sRGB, red: 0.90, green: 0.30, blue: 0.30, opacity: 1) }
        if fraction >= 0.7 { return Color(.sRGB, red: 0.85, green: 0.65, blue: 0.20, opacity: 1) }
        return Color(.sRGB, red: 0.20, green: 0.72, blue: 0.40, opacity: 1)
    }

    static let limitTrack = Color.gray.opacity(0.18)

    // MARK: - Source colors
    static func sourceColor(_ source: String) -> Color {
        switch source.lowercased() {
        case "claude":      return .purple
        case "codex":       return .green
        case "gemini":      return .blue
        case "opencode":    return .orange
        case "openclaw":    return .pink
        case "cursor":      return .yellow
        case "kimi":        return .purple
        case "everycode":   return .cyan
        case "kiro":        return .mint
        case "grok":        return .primary
        case "antigravity": return .indigo
        case "copilot":     return .teal
        default:            return .gray
        }
    }

    static func modelDot(_ idx: Int) -> Color {
        let palette: [Color] = [
            Color(.sRGB, red: 0.35, green: 0.55, blue: 0.95, opacity: 1),
            Color(.sRGB, red: 0.60, green: 0.45, blue: 0.90, opacity: 1),
            Color(.sRGB, red: 0.30, green: 0.72, blue: 0.65, opacity: 1),
            Color(.sRGB, red: 0.90, green: 0.55, blue: 0.35, opacity: 1),
            Color(.sRGB, red: 0.70, green: 0.50, blue: 0.75, opacity: 1)
        ]
        return palette[idx % palette.count]
    }
}

enum WidgetFormat {

    static func compact(_ value: Int) -> String {
        let absVal = abs(value)
        let sign = value < 0 ? "-" : ""
        switch absVal {
        case 1_000_000_000...:
            return "\(sign)\(String(format: "%.1f", Double(absVal) / 1_000_000_000.0))B"
        case 1_000_000...:
            return "\(sign)\(String(format: "%.1f", Double(absVal) / 1_000_000.0))M"
        case 1_000...:
            return "\(sign)\(String(format: "%.1f", Double(absVal) / 1_000.0))K"
        default:
            return "\(value)"
        }
    }

    static func cost(_ value: Double?) -> String {
        guard let value else { return "—" }
        if value >= 1_000 {
            return String(format: "$%.0f", value)
        }
        return String(format: "$%.2f", value)
    }

    static func percent(_ value: Double, decimals: Int = 1) -> String {
        String(format: "%.\(decimals)f%%", value)
    }

    static func relativeUpdated(_ date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        if interval < 60 { return WidgetStrings.justNow }
        if interval < 3600 { return WidgetStrings.minutesAgo(Int(interval / 60)) }
        if interval < 86400 { return WidgetStrings.hoursAgo(Int(interval / 3600)) }
        return WidgetStrings.daysAgo(Int(interval / 86400))
    }

    /// "▲ 12%" / "▼ 5%" / "—" — short signed delta string for hero numbers.
    static func delta(_ percent: Double?) -> String {
        guard let p = percent else { return "—" }
        let rounded = Int(p.rounded())
        if rounded == 0 { return "±0%" }
        let arrow = rounded > 0 ? "▲" : "▼"
        return "\(arrow) \(abs(rounded))%"
    }

    /// Color for a delta arrow. Up = green (more usage isn't strictly bad,
    /// but matches "going up"), down = neutral secondary, zero = secondary.
    static func deltaColor(_ percent: Double?) -> Color {
        guard let p = percent, Int(p.rounded()) != 0 else { return .secondary }
        return p > 0
            ? Color(.sRGB, red: 0.20, green: 0.72, blue: 0.40, opacity: 1)
            : Color(.sRGB, red: 0.55, green: 0.55, blue: 0.55, opacity: 1)
    }

    /// "in 2h 14m" / "in 4d" — concise countdown to a future reset date.
    /// Returns nil when no date is provided or it has already passed.
    static func relativeReset(_ date: Date?) -> String? {
        guard let date else { return nil }
        let interval = date.timeIntervalSince(Date())
        if interval <= 0 { return nil }
        if interval < 3600 {
            return WidgetStrings.resetInMinutes(Int(interval / 60))
        }
        if interval < 86400 {
            let h = Int(interval / 3600)
            let m = Int((interval.truncatingRemainder(dividingBy: 3600)) / 60)
            return WidgetStrings.resetInHours(h, minutes: m)
        }
        return WidgetStrings.resetInDays(Int(interval / 86400))
    }
}
