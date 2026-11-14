import Foundation

// Swift port of dashboard/src/ui/share/build-share-card-data.ts and
// `buildTopModels` (dashboard/src/lib/model-breakdown.ts). Card text mirrors the
// `share.*` keys in dashboard/src/content/copy.csv. Every number comes from a
// Cloud response; there is no rank because the phone does not read the
// leaderboard, and the cards show the dashboard's own "—" fallback for it.

enum ShareCardPeriod: String, Equatable {
    case day, week, month, total

    init(_ horizon: UsageHorizon) {
        switch horizon {
        case .today: self = .day
        case .week: self = .week
        case .month: self = .month
        case .total: self = .total
        }
    }
}

enum ShareCardVariant: String, CaseIterable, Identifiable {
    case neon = "annual-report"
    case broadsheet

    var id: String { rawValue }

    /// `share.variant.*`
    var label: String {
        switch self {
        case .neon: return "Neon"
        case .broadsheet: return "Broadsheet"
        }
    }

    /// `VARIANT_SIZES` in share-card-constants.ts.
    var size: CGSize {
        switch self {
        case .neon: return CGSize(width: 1080, height: 1865)
        case .broadsheet: return CGSize(width: 1200, height: 1630)
        }
    }
}

struct ShareCardModel: Equatable {
    var id: String
    var name: String
    var tokens: Int
    var percent: String
}

struct ShareHeatmapCell: Equatable {
    var day: String
    var level: Int
    var value: Int
}

struct ShareCardData: Equatable {
    var handle: String
    var startDate: String?
    var activeDays: Int
    var totalTokens: Int
    /// nil when Mask Cost Figures is on, so no dollar amount can reach the PNG.
    var totalCostUsd: Double?
    var period: ShareCardPeriod
    var periodFrom: String
    var periodTo: String
    var topModels: [ShareCardModel]
    var heatmapWeeks: [[ShareHeatmapCell?]]
    var heatmapTotalDays: Int
    var heatmapActiveDays: Int
    var currency: PhoneCurrency

    /// Nothing to put on a poster: no tokens and no ranked model in the period.
    var isShareable: Bool { totalTokens > 0 || !topModels.isEmpty }

    static let placeholder = "--" // shared.placeholder.short
    static let anonymousHandle = "Anonymous" // dashboard.identity.fallback

    static func build(
        snapshot: PhoneWorkspaceSnapshot,
        heatmap: HeatmapResponse?,
        userName: String?,
        currency: PhoneCurrency,
        masksCost: Bool
    ) -> ShareCardData {
        let range = snapshot.horizon.range(now: snapshot.now)
        let grid = normalizeHeatmap(heatmap)
        let cost = Double(snapshot.periodSummary.totals.totalCostUsd ?? "") ?? 0
        return ShareCardData(
            handle: handle(from: userName),
            startDate: earliestActiveDay(heatmap),
            activeDays: max(0, heatmap?.activeDays ?? 0),
            totalTokens: snapshot.periodSummary.totals.displayTokens,
            totalCostUsd: masksCost ? nil : cost,
            period: ShareCardPeriod(snapshot.horizon),
            periodFrom: range.from,
            periodTo: range.to,
            topModels: topModels(from: snapshot.periodBreakdown),
            heatmapWeeks: grid.weeks,
            heatmapTotalDays: grid.totalDays,
            heatmapActiveDays: grid.activeDays,
            currency: currency
        )
    }

    // MARK: Identity (DashboardPage identityLabel / identityHandle)

    static func handle(from rawName: String?) -> String {
        let trimmed = (rawName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let label = (trimmed.isEmpty || trimmed.contains("@")) ? anonymousHandle : trimmed
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        return String(label.map { allowed.contains($0) ? $0 : "_" })
    }

    // MARK: Top models (`buildTopModels`, limit 3)

    /// Token ranking across every source. Zero-token (request-only) models stay
    /// out, a `provider/model` name folds into its bare name when that bare name
    /// also appears, and `percent` is the share of all model tokens, one decimal.
    static func topModels(from breakdown: ModelBreakdownResponse?, limit: Int = 3) -> [ShareCardModel] {
        var rows: [(name: String, tokens: Int)] = []
        var allTokens = 0
        for source in breakdown?.sources ?? [] {
            for model in source.models {
                let tokens = model.totals.displayTokens
                guard tokens > 0 else { continue }
                allTokens += tokens
                rows.append((model.model.isEmpty ? placeholder : model.model, tokens))
            }
        }

        var bareNames: [String: String] = [:]
        var bareWeights: [String: Int] = [:]
        for row in rows {
            let key = row.name.trimmingCharacters(in: .whitespaces).lowercased()
            guard !key.isEmpty, !key.contains("/") else { continue }
            if bareNames[key] == nil || row.tokens >= (bareWeights[key] ?? 0) {
                bareNames[key] = row.name.trimmingCharacters(in: .whitespaces)
                bareWeights[key] = row.tokens
            }
        }

        var totals: [String: Int] = [:]
        var names: [String: String] = [:]
        var nameWeights: [String: Int] = [:]
        for row in rows {
            let normalized = row.name.trimmingCharacters(in: .whitespaces).lowercased()
            guard !normalized.isEmpty else { continue }
            var key = normalized
            if let slash = normalized.lastIndex(of: "/"), slash > normalized.startIndex {
                let suffix = String(normalized[normalized.index(after: slash)...])
                if bareNames[suffix] != nil { key = suffix }
            }
            totals[key, default: 0] += row.tokens
            if let bare = bareNames[key] {
                names[key] = bare
            } else if row.tokens >= (nameWeights[key] ?? 0) {
                nameWeights[key] = row.tokens
                names[key] = row.name
            }
        }

        let denominator = allTokens > 0 ? allTokens : totals.values.reduce(0, +)
        return totals
            .map { key, tokens in
                ShareCardModel(
                    id: key,
                    name: names[key] ?? placeholder,
                    tokens: tokens,
                    percent: denominator > 0 ? String(format: "%.1f", Double(tokens) / Double(denominator) * 100) : "0.0"
                )
            }
            .sorted { $0.tokens != $1.tokens ? $0.tokens > $1.tokens : $0.name < $1.name }
            .prefix(max(0, limit))
            .map { $0 }
    }

    private static func earliestActiveDay(_ heatmap: HeatmapResponse?) -> String? {
        heatmap?.weeks.flatMap { $0 }.compactMap { $0 }
            .filter { !$0.day.isEmpty && cellValue($0) > 0 }
            .map(\.day)
            .min()
    }

    private static func cellValue(_ cell: HeatmapCell) -> Int {
        max(0, cell.billableTotalTokens > 0 ? cell.billableTotalTokens : cell.totalTokens)
    }

    private static func normalizeHeatmap(_ heatmap: HeatmapResponse?) -> (weeks: [[ShareHeatmapCell?]], totalDays: Int, activeDays: Int) {
        var total = 0
        var active = 0
        let weeks: [[ShareHeatmapCell?]] = (heatmap?.weeks ?? []).map { week in
            week.prefix(7).map { cell in
                guard let cell else { return nil }
                let level = min(4, max(0, cell.level))
                if !cell.day.isEmpty {
                    total += 1
                    if level > 0 { active += 1 }
                }
                return ShareHeatmapCell(day: cell.day, level: level, value: cellValue(cell))
            }
        }
        return (weeks, total, active)
    }
}

// MARK: - Card text (formatters from build-share-card-data.ts)

extension ShareCardData {
    private static let months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

    /// `formatTokens`: whole number, en-US grouping.
    static func formatTokens(_ n: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: n)) ?? String(n)
    }

    /// `formatCost`, or the app's masked form when Mask Cost Figures is on.
    var costLabel: String {
        let symbol = currency.symbol
        guard let usd = totalCostUsd else { return "\(symbol)•••" }
        guard usd > 0, usd.isFinite else { return "\(symbol)0.00" }
        let converted = usd * currency.defaultRate
        if converted >= 1000 { return "\(symbol)\(Self.formatTokens(Int(converted.rounded())))" }
        return "\(symbol)\(String(format: "%.2f", converted))"
    }

    /// `formatShortDate`: "NOV 2026".
    static func shortDate(_ isoDay: String?) -> String {
        guard let isoDay else { return "—" }
        let parts = isoDay.split(separator: "-")
        guard parts.count == 3, let m = Int(parts[1]), (1...12).contains(m) else { return isoDay }
        return "\(months[m - 1]) \(parts[0])"
    }

    /// `formatIssueLabel`.
    var issueLabel: String {
        switch period {
        case .total: return "ALL TIME"
        case .day: return periodTo.replacingOccurrences(of: "-", with: ".")
        case .week, .month: return Self.shortDate(periodTo)
        }
    }

    /// `buildShareHook`: loyalty, then record, then lead, then diversity.
    var hookLine: String {
        if let top = topModels.first {
            let pct = Double(top.percent) ?? 0
            if pct >= 60 { return "\(Int(pct.rounded()))% loyal to \(top.name)." }
            if activeDays >= 60 { return "\(activeDays) days on the record." }
            if pct >= 30 { return "Led by \(top.name) (\(Int(pct.rounded()))%)." }
            if topModels.count > 1 { return "Across \(topModels.count) models, \(activeDays) days." }
            return "\(activeDays) days with \(top.name)."
        }
        if activeDays > 0 { return "\(activeDays) days on the record." }
        return "The beginning of a new chapter."
    }

    /// Longest run of active days in the returned grid (AnnualReportCard `streak`).
    var longestStreak: Int {
        let days = heatmapWeeks.flatMap { $0 }.compactMap { $0 }.filter { !$0.day.isEmpty }.sorted { $0.day < $1.day }
        var best = 0
        var run = 0
        for cell in days {
            run = cell.level > 0 ? run + 1 : 0
            best = max(best, run)
        }
        return best
    }

    /// `heroFontSize`: shrink linearly once the number passes `baseChars`.
    static func heroFontSize(_ text: String, base: CGFloat, baseChars: Int, shrinkPerChar: CGFloat, min minSize: CGFloat) -> CGFloat {
        guard text.count > baseChars else { return base }
        return max(minSize, base - CGFloat(text.count - baseChars) * shrinkPerChar)
    }
}

// MARK: - Share caption and link (ShareModal.handleShareX)

enum ShareCaption {
    /// `https://www.tokentracker.cc/u/{userId}?ref=share`, or the homepage when
    /// the account id is unknown.
    static func profileURL(userId: String?) -> URL {
        let id = (userId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))
        if !id.isEmpty, let encoded = id.addingPercentEncoding(withAllowedCharacters: allowed),
           let url = URL(string: "https://www.tokentracker.cc/u/\(encoded)?ref=share") {
            return url
        }
        return URL(string: "https://www.tokentracker.cc/?ref=share")!
    }

    /// `dashboard.screenshot.twitter_text`, filled the way DashboardPage does:
    /// the period's billable tokens, then the top model of the top tool and its
    /// share of that tool's tokens.
    static func text(summaryTokens: Int, breakdown: ModelBreakdownResponse?) -> String {
        let placeholder = ShareCardData.placeholder
        var modelName = placeholder
        var modelPercent = "0.0"

        let topSource = (breakdown?.sources ?? [])
            .filter { $0.totals.displayTokens > 0 }
            .reduce(nil as SourceEntry?) { best, next in
                guard let best else { return next }
                return next.totals.displayTokens > best.totals.displayTokens ? next : best
            }
        if let topSource {
            let sourceTokens = topSource.totals.displayTokens
            var topTokens = 0
            for model in topSource.models where model.totals.displayTokens > topTokens {
                topTokens = model.totals.displayTokens
                modelName = model.model.isEmpty ? placeholder : model.model
            }
            if topTokens > 0 {
                modelPercent = String(format: "%.1f", Double(topTokens) / Double(sourceTokens) * 100)
            }
        }

        let tokens = summaryTokens > 0 || breakdown != nil ? ShareCardData.formatTokens(summaryTokens) : placeholder
        return "\(tokens) tokens on the record.\n\(modelName) led with \(modelPercent)%.\n\nMy AI usage, unaudited →"
    }
}
