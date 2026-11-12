import Foundation

/// Everything one dashboard screen shows, fetched together.
struct UsageSnapshot: Equatable {
    var period: UsagePeriod
    var summary: UsageSummaryResponse
    var daily: DailyUsageResponse
    var breakdown: ModelBreakdownResponse
    var heatmap: HeatmapResponse
    var fetchedAt: Date

    var totalCostUsd: Double { Double(summary.totals.totalCostUsd ?? "") ?? 0 }

    /// Models merged across sources (the same model can run in several CLIs),
    /// largest first.
    var topModels: [RankedModel] {
        var byName: [String: RankedModel] = [:]
        for source in breakdown.sources {
            for model in source.models {
                let name = model.model.isEmpty ? model.modelId : model.model
                var entry = byName[name] ?? RankedModel(name: name, sources: [], tokens: 0, costUsd: 0)
                entry.tokens += model.totals.displayTokens
                entry.costUsd += Double(model.totals.totalCostUsd ?? "") ?? 0
                if !entry.sources.contains(source.source) { entry.sources.append(source.source) }
                byName[name] = entry
            }
        }
        return byName.values.filter { $0.tokens > 0 }.sorted { $0.tokens > $1.tokens }
    }

    var sources: [RankedSource] {
        breakdown.sources
            .map { RankedSource(source: $0.source, tokens: $0.totals.displayTokens,
                                costUsd: Double($0.totals.totalCostUsd ?? "") ?? 0) }
            .filter { $0.tokens > 0 }
            .sorted { $0.tokens > $1.tokens }
    }
}

struct RankedModel: Identifiable, Equatable {
    var id: String { name }
    var name: String
    var sources: [String]
    var tokens: Int
    var costUsd: Double
}

struct RankedSource: Identifiable, Equatable {
    var id: String { source }
    var source: String
    var tokens: Int
    var costUsd: Double

    /// `claude` → `Claude`, `every-code` → `Every Code`.
    var displayName: String {
        source.split(whereSeparator: { $0 == "-" || $0 == "_" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

extension TokenTotals {
    /// Same choice as the macOS popover's model list: billable when reported.
    var displayTokens: Int { billableTotalTokens > 0 ? billableTotalTokens : totalTokens }
}
