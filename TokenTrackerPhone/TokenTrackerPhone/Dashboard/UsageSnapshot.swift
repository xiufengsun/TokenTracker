import Foundation

/// Everything one dashboard screen shows. Only the summary is required; the
/// other sections are nil when their endpoint failed.
struct UsageSnapshot: Equatable {
    var period: UsagePeriod
    var summary: UsageSummaryResponse
    var daily: DailyUsageResponse?
    var breakdown: ModelBreakdownResponse?
    var heatmap: HeatmapResponse?
    var fetchedAt: Date

    var totalCostUsd: Double { Double(summary.totals.totalCostUsd ?? "") ?? 0 }

    /// Models merged across sources (the same model can run in several CLIs),
    /// largest first. Request-only models (credit-billed sources that report no
    /// tokens, #990) stay in the list by their request count.
    var topModels: [RankedModel] {
        var byName: [String: RankedModel] = [:]
        for source in breakdown?.sources ?? [] {
            for model in source.models {
                let name = model.model.isEmpty ? model.modelId : model.model
                var entry = byName[name] ?? RankedModel(name: name, sources: [], tokens: 0, conversations: 0, costUsd: 0)
                entry.tokens += model.totals.displayTokens
                entry.conversations += model.totals.conversationCount
                entry.costUsd += Double(model.totals.totalCostUsd ?? "") ?? 0
                if !entry.sources.contains(source.source) { entry.sources.append(source.source) }
                byName[name] = entry
            }
        }
        return byName.values
            .filter { $0.tokens > 0 || $0.conversations > 0 }
            .sorted { ($0.tokens, $0.conversations) > ($1.tokens, $1.conversations) }
    }

    var sources: [RankedSource] {
        (breakdown?.sources ?? [])
            .map { RankedSource(source: $0.source, tokens: $0.totals.displayTokens,
                                conversations: $0.totals.conversationCount,
                                costUsd: Double($0.totals.totalCostUsd ?? "") ?? 0) }
            .filter { $0.tokens > 0 || $0.conversations > 0 }
            .sorted { ($0.tokens, $0.conversations) > ($1.tokens, $1.conversations) }
    }
}

struct RankedModel: Identifiable, Equatable {
    var id: String { name }
    var name: String
    var sources: [String]
    var tokens: Int
    var conversations: Int
    var costUsd: Double
}

struct RankedSource: Identifiable, Equatable {
    var id: String { source }
    var source: String
    var tokens: Int
    var conversations: Int
    var costUsd: Double

    /// `claude` → `Claude`, `every-code` → `Every Code`.
    var displayName: String { Self.displayName(source) }

    static func displayName(_ source: String) -> String {
        source.split(whereSeparator: { $0 == "-" || $0 == "_" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

extension TokenTotals {
    /// Same choice as the macOS popover's model list: billable when reported.
    var displayTokens: Int { billableTotalTokens > 0 ? billableTotalTokens : totalTokens }
}

extension HeatmapResponse {
    /// The account endpoint always sends `streak_days: 0`, so the streak is
    /// derived here: consecutive active days ending today, or ending yesterday
    /// while today has no usage yet.
    func currentStreak(today: String) -> Int {
        let active = Set(weeks.flatMap { $0 }.compactMap { $0 }
            .filter { $0.totalTokens > 0 || $0.level > 0 }
            .map(\.day))
        guard var cursor = DayFormat.date(today) else { return 0 }
        let calendar = Calendar.localGregorian
        if !active.contains(today) {
            cursor = calendar.date(byAdding: .day, value: -1, to: cursor) ?? cursor
        }
        var streak = 0
        while active.contains(DayFormat.string(cursor)) {
            streak += 1
            guard let previous = calendar.date(byAdding: .day, value: -1, to: cursor) else { break }
            cursor = previous
        }
        return streak
    }
}
