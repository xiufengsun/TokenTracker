import SwiftUI
import WidgetKit

// Hero-number summary widget. No header chrome, no "updated" footer — the
// widget gallery already labels the tile and the OS already shows reload
// state. Each size promotes ONE primary number and lets the rest of the
// information serve it. Static configuration: each widget kind has a
// fixed, focused job (no period/metric switcher).

struct SummaryWidget: Widget {
    let kind: String = "TokenTrackerSummaryWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: StaticSnapshotProvider()) { entry in
            SummaryWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName(WidgetStrings.usageName)
        .description(WidgetStrings.usageDescription)
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
    }
}

struct SummaryWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: StaticEntry

    var body: some View {
        switch family {
        case .systemSmall:      SmallView(snap: entry.snapshot)
        case .systemMedium:     MediumView(snap: entry.snapshot)
        case .systemLarge:      LargeView(snap: entry.snapshot)
        case .systemExtraLarge: LargeView(snap: entry.snapshot)
        default:                MediumView(snap: entry.snapshot)
        }
    }
}

// MARK: - Small (2x2): Today only

private struct SmallView: View {
    let snap: WidgetSnapshot

    var body: some View {
        let hasData = snap.today.tokens > 0

        VStack(alignment: .leading, spacing: 0) {
            Text(WidgetStrings.today)
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.6)
                .foregroundColor(.secondary)

            Spacer(minLength: 0)

            Text(hasData ? WidgetFormat.compact(snap.today.tokens) : "—")
                .font(.system(size: 38, weight: .bold, design: .rounded))
                .foregroundColor(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .padding(.bottom, 2)

            Text(WidgetFormat.delta(snap.todayDeltaPercent))
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(WidgetFormat.deltaColor(snap.todayDeltaPercent))

            Spacer(minLength: 0)

            Text(WidgetStrings.vsYesterday)
                .font(.system(size: 10))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - Medium (4x2): Today + 7d, with sparkline

private struct MediumView: View {
    let snap: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                HeroBlock(
                    label: WidgetStrings.today,
                    value: WidgetFormat.compact(snap.today.tokens),
                    subText: todaySubText(snap: snap)
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                HeroBlock(
                    label: WidgetStrings.sevenDays,
                    value: WidgetFormat.compact(snap.last7d.tokens),
                    subText: costSubText(snap.last7d.costUsd)
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Spacer(minLength: 8)

            SparklineView(points: Array(snap.dailyTrend.suffix(14)))
                .frame(height: 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - Large (4x4): Today + 7d + 30d + bar chart + top 3 models

private struct LargeView: View {
    let snap: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                HeroBlock(
                    label: WidgetStrings.today,
                    value: WidgetFormat.compact(snap.today.tokens),
                    subText: todaySubText(snap: snap),
                    size: .compact
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                HeroBlock(
                    label: WidgetStrings.sevenDays,
                    value: WidgetFormat.compact(snap.last7d.tokens),
                    subText: costSubText(snap.last7d.costUsd),
                    size: .compact
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                HeroBlock(
                    label: WidgetStrings.thirtyDays,
                    value: WidgetFormat.compact(snap.last30d.tokens),
                    subText: costSubText(snap.last30d.costUsd),
                    size: .compact
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            BarTrendChart(points: snap.dailyTrend)
                .frame(maxWidth: .infinity, minHeight: 56)

            VStack(spacing: 6) {
                ForEach(Array(snap.topModels.prefix(3).enumerated()), id: \.element.id) { idx, m in
                    InlineModelRow(rank: idx, model: m)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Hero number block

private struct HeroBlock: View {
    let label: String
    let value: String
    /// Pre-built `Text` so callers can mix colors inline (e.g. `$12.34 ▼33%`
    /// where the cost is gray and the delta is colored). Single-line.
    let subText: Text
    var size: HeroSize = .large

    enum HeroSize {
        case large   // medium widget: 2 blocks side by side
        case compact // large widget: 3 blocks side by side

        var valueFont: CGFloat { self == .large ? 28 : 24 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.6)
                .foregroundColor(.secondary)
            Text(value)
                .font(.system(size: size.valueFont, weight: .bold, design: .rounded))
                .foregroundColor(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            subText
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .lineLimit(1)
        }
    }
}

// MARK: - Sub-line builders

/// Today's sub line: gray cost + colored delta side by side, e.g.
/// `$12.34  ▼33%`. Concatenated as a single `Text` so it stays one line and
/// shares the parent's font / size with the other hero blocks.
private func todaySubText(snap: WidgetSnapshot) -> Text {
    let cost = WidgetFormat.cost(snap.today.costUsd)
    let delta = WidgetFormat.delta(snap.todayDeltaPercent)
    let deltaColor = WidgetFormat.deltaColor(snap.todayDeltaPercent)
    return Text("\(cost)  ").foregroundColor(.secondary)
         + Text(delta).foregroundColor(deltaColor)
}

/// Plain gray cost line for the 7d / 30d hero blocks.
private func costSubText(_ usd: Double?) -> Text {
    Text(WidgetFormat.cost(usd)).foregroundColor(.secondary)
}

// Simple inline row used by Large to surface top models without the
// separate Top Models widget being installed.
private struct InlineModelRow: View {
    let rank: Int
    let model: SnapshotModelEntry

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(WidgetTheme.modelDot(rank))
                .frame(width: 6, height: 6)
            Text(model.name)
                .font(.system(size: 11, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 6)
            Text(WidgetFormat.compact(model.tokens))
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundColor(.secondary)
                .monospacedDigit()
            Text(String(format: "%.0f%%", model.sharePercent))
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundColor(Color.secondary.opacity(0.55))
                .monospacedDigit()
                .frame(width: 30, alignment: .trailing)
        }
    }
}
