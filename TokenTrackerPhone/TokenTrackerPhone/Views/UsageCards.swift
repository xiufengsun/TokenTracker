import Charts
import SwiftUI

struct Card<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(.secondarySystemGroupedBackground)))
    }
}

// MARK: - Summary

struct SummaryCard: View {
    let snapshot: UsageSnapshot

    private var totals: TokenTotals { snapshot.summary.totals }

    var body: some View {
        Card(title: title) {
            VStack(alignment: .leading, spacing: 4) {
                Text(TokenFormatter.formatCompact(totals.totalTokens))
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                    .contentTransition(.numericText())
                Text("\(totals.totalTokens.formatted()) tokens")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 0) {
                Stat(label: "Est. cost", value: TokenFormatter.formatCost(snapshot.totalCostUsd))
                Stat(label: "Conversations", value: totals.conversationCount.formatted())
            }

            Divider()

            HStack(spacing: 0) {
                Stat(label: "Last 7 days", value: TokenFormatter.formatCompact(snapshot.summary.rolling.last7d.totals.billableTotalTokens))
                Stat(label: "Last 30 days", value: TokenFormatter.formatCompact(snapshot.summary.rolling.last30d.totals.billableTotalTokens))
            }

            TokenMixBar(totals: totals)
        }
    }

    private var title: String {
        switch snapshot.period {
        case .day: return "Today"
        case .week: return "This week"
        case .month: return "This month"
        case .total: return "Last 24 months"
        }
    }
}

private struct Stat: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Input / output / cache split of the period's tokens.
private struct TokenMixBar: View {
    let totals: TokenTotals

    private var parts: [(String, Int, Color)] {
        [
            ("Input", totals.inputTokens, .blue),
            ("Output", totals.outputTokens, .purple),
            ("Cache read", totals.cachedInputTokens, .teal),
            ("Cache write", totals.cacheCreationInputTokens, .orange),
        ].filter { $0.1 > 0 }
    }

    var body: some View {
        let sum = max(parts.reduce(0) { $0 + $1.1 }, 1)
        if !parts.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                GeometryReader { geo in
                    HStack(spacing: 2) {
                        ForEach(parts, id: \.0) { part in
                            part.2.frame(width: max(2, geo.size.width * CGFloat(part.1) / CGFloat(sum) - 2))
                        }
                    }
                    .clipShape(Capsule())
                }
                .frame(height: 8)
                FlowLegend(items: parts.map { ($0.0, TokenFormatter.formatCompact($0.1), $0.2) })
            }
        }
    }
}

private struct FlowLegend: View {
    let items: [(String, String, Color)]

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], spacing: 4) {
            ForEach(items, id: \.0) { item in
                HStack(spacing: 6) {
                    Circle().fill(item.2).frame(width: 7, height: 7)
                    Text(item.0).foregroundStyle(.secondary)
                    Text(item.1).monospacedDigit()
                }
                .font(.caption)
            }
        }
    }
}

// MARK: - Trend

struct TrendCard: View {
    let daily: DailyUsageResponse

    private struct Point: Identifiable {
        let id: String
        let date: Date
        let tokens: Int
    }

    private var points: [Point] {
        daily.data.compactMap { entry in
            DayFormat.date(entry.day).map { Point(id: entry.day, date: $0, tokens: entry.totalTokens) }
        }
    }

    /// The endpoint omits days without usage, so pin the axis to the requested
    /// window instead of letting the chart shrink to the days it was given.
    private var domain: ClosedRange<Date> {
        let calendar = Calendar.localGregorian
        let end = DayFormat.date(daily.to) ?? calendar.startOfDay(for: Date())
        let start = DayFormat.date(daily.from)
            ?? calendar.date(byAdding: .day, value: -(DashboardModel.trendDays - 1), to: end) ?? end
        return start...(calendar.date(byAdding: .day, value: 1, to: end) ?? end)
    }

    var body: some View {
        Card(title: "Last \(DashboardModel.trendDays) days") {
            if points.allSatisfy({ $0.tokens == 0 }) {
                Text("No usage in this window.").font(.footnote).foregroundStyle(.secondary)
            } else {
                Chart(points) { point in
                    BarMark(x: .value("Day", point.date, unit: .day), y: .value("Tokens", point.tokens))
                        .foregroundStyle(Color.trendLine.gradient)
                        .cornerRadius(2)
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let v = value.as(Int.self) { Text(TokenFormatter.formatCompact(v)) }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .stride(by: .day, count: 7)) { _ in
                        AxisGridLine()
                        AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                    }
                }
                .chartXScale(domain: domain)
                .frame(height: 170)
            }
        }
    }
}

// MARK: - Models & sources

struct TopModelsCard: View {
    let models: [RankedModel]
    private let limit = 6

    var body: some View {
        Card(title: "Top models") {
            if models.isEmpty {
                Text("No model usage in this period.").font(.footnote).foregroundStyle(.secondary)
            } else {
                let total = max(models.reduce(0) { $0 + $1.tokens }, 1)
                VStack(spacing: 12) {
                    ForEach(Array(models.prefix(limit).enumerated()), id: \.element.id) { index, model in
                        ShareRow(
                            color: .modelDot(index: index),
                            title: model.name,
                            subtitle: model.sources.map(RankedSource.displayName).joined(separator: ", "),
                            tokens: model.tokens,
                            conversations: model.conversations,
                            costUsd: model.costUsd,
                            share: Double(model.tokens) / Double(total)
                        )
                    }
                }
            }
        }
    }
}

struct SourcesCard: View {
    let sources: [RankedSource]

    var body: some View {
        if !sources.isEmpty {
            Card(title: "By tool") {
                let total = max(sources.reduce(0) { $0 + $1.tokens }, 1)
                VStack(spacing: 12) {
                    ForEach(sources) { source in
                        ShareRow(
                            color: .sourceColor(source.source),
                            title: source.displayName,
                            subtitle: nil,
                            tokens: source.tokens,
                            conversations: source.conversations,
                            costUsd: source.costUsd,
                            share: Double(source.tokens) / Double(total)
                        )
                    }
                }
            }
        }
    }
}

private struct ShareRow: View {
    let color: Color
    let title: String
    let subtitle: String?
    let tokens: Int
    let conversations: Int
    let costUsd: Double
    let share: Double

    /// Request-only entries report no tokens, only a request count.
    private var amount: String {
        tokens == 0 && conversations > 0
            ? "\(conversations.formatted()) req"
            : TokenFormatter.formatCompact(tokens)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Circle().fill(color).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.subheadline.weight(.medium)).lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 1) {
                    Text(amount).font(.subheadline.weight(.semibold)).monospacedDigit()
                    Text(TokenFormatter.formatCost(costUsd)).font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.limitTrack)
                    Capsule().fill(color).frame(width: max(3, geo.size.width * share))
                }
            }
            .frame(height: 4)
        }
    }
}

// MARK: - Heatmap

struct HeatmapCard: View {
    let heatmap: HeatmapResponse

    private var streak: Int { heatmap.currentStreak(today: DayFormat.string(Date())) }

    private func accessibilityLabel(for cell: HeatmapCell) -> String {
        let date = DayFormat.date(cell.day)?.formatted(date: .abbreviated, time: .omitted) ?? cell.day
        return cell.totalTokens > 0 ? "\(date): \(TokenFormatter.formatCompact(cell.totalTokens)) tokens" : "\(date): no usage"
    }

    var body: some View {
        Card(title: "Activity") {
            GeometryReader { geo in
                let columns = max(heatmap.weeks.count, 1)
                let spacing: CGFloat = 3
                let size = min(18, (geo.size.width - spacing * CGFloat(columns - 1)) / CGFloat(columns))
                HStack(alignment: .top, spacing: spacing) {
                    ForEach(Array(heatmap.weeks.enumerated()), id: \.offset) { _, week in
                        VStack(spacing: spacing) {
                            ForEach(0..<7, id: \.self) { row in
                                let cell = row < week.count ? week[row] : nil
                                RoundedRectangle(cornerRadius: 3, style: .continuous)
                                    .fill(cell.map { Color.heatmapLevels[min(max($0.level, 0), 4)] } ?? .clear)
                                    .frame(width: size, height: size)
                                    .accessibilityElement()
                                    .accessibilityLabel(cell.map(accessibilityLabel(for:)) ?? "")
                                    .accessibilityHidden(cell == nil)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .frame(height: 7 * 18 + 6 * 3)

            HStack {
                Label("\(streak)-day streak", systemImage: "flame")
                Spacer()
                Text("\(heatmap.activeDays) active days")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}
