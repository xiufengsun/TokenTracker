import SwiftUI

/// SwiftUI port of dashboard/src/ui/share/variants/AnnualReportCard.jsx
/// (style id `annual-report`, label "Neon"), laid out at its 1080 × 1865
/// canvas. Same background art (`neon_bg.png`), palette, month heatmap,
/// stats, facts and footer. The CSS backdrop blur is approximated with the
/// card's own translucent fill and inset hairline.
struct NeonShareCard: View {
    let data: ShareCardData

    private static let white = Color.white.opacity(0xEE / 255)
    private static let dim = Color.white.opacity(0.45)
    private static let accent = Color(hex: 0xA78BFA)
    private static let glassFill = Color(red: 20 / 255, green: 15 / 255, blue: 50 / 255).opacity(0.38)
    private static let palette: [Color] = [
        Color.white.opacity(0.06), Color(hex: 0x4A3D8F), Color(hex: 0x6B5CBE), Color(hex: 0x9060E0), Color(hex: 0xD946EF),
    ]

    // Layout constants from the JSX: PAD 48, card padding 28, cell gap 4, month gap 20.
    private static let pad: CGFloat = 48
    private static let cellGap: CGFloat = 4
    private static let monthGap: CGFloat = 20
    private static let cell: CGFloat = {
        let inner: CGFloat = 1080 - 48 * 2 - 28 * 2
        let column = (inner - 20 * 2) / 3
        return min(((column - 4 * 6) / 7).rounded(.down), 40)
    }()
    private static let columnWidth: CGFloat = cell * 7 + cellGap * 6

    var body: some View {
        ZStack {
            Color(hex: 0x0A0820)
            Image("ShareNeonBackground")
                .resizable()
                .aspectRatio(contentMode: .fill)

            VStack(spacing: 0) {
                header.padding(.bottom, 48)
                heatmapCard.padding(.bottom, 16)
                stats.padding(.bottom, 16)
                VStack(spacing: 16) {
                    fact(icon: "ShareNeonStreak", label: "Longest Streak", value: "\(data.longestStreak) days")
                    fact(icon: "ShareNeonTopModel", label: "Top Model", value: data.topModels.first?.name ?? "—")
                }
                Spacer(minLength: 0)
                footer
            }
            .padding(Self.pad)
        }
        .frame(width: ShareCardVariant.neon.size.width, height: ShareCardVariant.neon.size.height)
        .clipped()
        .environment(\.colorScheme, .dark)
    }

    private var header: some View {
        HStack {
            HStack(spacing: 16) {
                productMark(64, radius: 16)
                VStack(alignment: .leading, spacing: 0) {
                    Text("Token Tracker")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(Self.dim)
                    Text("Token Report")
                        .font(.system(size: 36, weight: .bold))
                        .foregroundStyle(Self.white)
                }
            }
            Spacer(minLength: 24)
            HStack(spacing: 10) {
                Circle()
                    .fill(LinearGradient(colors: [Color(hex: 0x4C1D95), Color(hex: 0x7C3AED)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.15), lineWidth: 2))
                    .overlay(
                        Text(String(data.handle.prefix(1)).uppercased())
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(Self.white)
                    )
                    .frame(width: 48, height: 48)
                Text(data.handle)
                    .font(.system(size: 32, weight: .bold))
                    .foregroundStyle(Self.white)
                    .lineLimit(1)
            }
        }
    }

    private var heatmapCard: some View {
        VStack(spacing: 12) {
            HStack {
                HStack(spacing: 6) {
                    Text("Less")
                    ForEach(0..<5, id: \.self) { level in
                        RoundedRectangle(cornerRadius: 3).fill(Self.palette[level]).frame(width: 16, height: 16)
                    }
                    Text("More")
                }
                .font(.system(size: 14))
                .foregroundStyle(Self.dim)
                Spacer()
                Text("TOKEN USAGE HEATMAP")
                    .font(.system(size: 16, weight: .bold))
                    .tracking(16 * 0.14)
                    .foregroundStyle(Color.white.opacity(0.22))
            }

            let months = NeonMonthGrid.months(from: data.heatmapWeeks)
            LazyVGrid(
                columns: Array(repeating: GridItem(.fixed(Self.columnWidth), spacing: Self.monthGap), count: 3),
                alignment: .center,
                spacing: 8
            ) {
                ForEach(months) { month in
                    monthView(month)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(28)
        .background(glass(radius: 22, hairline: 0.05))
    }

    private func monthView(_ month: NeonMonthGrid.Month) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(month.label)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Self.dim)
            VStack(spacing: Self.cellGap) {
                ForEach(Array(month.rows.enumerated()), id: \.offset) { _, row in
                    HStack(spacing: Self.cellGap) {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, level in
                            RoundedRectangle(cornerRadius: 4)
                                .fill(level.map { Self.palette[$0] } ?? .clear)
                                .frame(width: Self.cell, height: Self.cell)
                        }
                    }
                }
            }
        }
        .frame(width: Self.columnWidth, alignment: .topLeading)
    }

    private var stats: some View {
        HStack(spacing: 16) {
            stat(value: ShareCardData.formatTokens(data.totalTokens), label: "Total Tokens")
            stat(value: data.costLabel, label: "Estimated Cost")
        }
    }

    private func stat(value: String, label: String) -> some View {
        VStack(spacing: 12) {
            Text(value)
                .font(.system(size: 52, weight: .bold))
                .tracking(-52 * 0.02)
                .monospacedDigit()
                .foregroundStyle(Self.white)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            Text(label)
                .font(.system(size: 22))
                .foregroundStyle(Self.dim)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .padding(.horizontal, 16)
        .background(glass(radius: 22, hairline: 0.06))
    }

    private func fact(icon: String, label: String, value: String) -> some View {
        HStack {
            HStack(spacing: 10) {
                Image(icon).resizable().frame(width: 22, height: 22)
                Text(label).font(.system(size: 20)).foregroundStyle(Self.dim)
            }
            Spacer(minLength: 16)
            Text(value)
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(Self.white)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .padding(.vertical, 18)
        .padding(.horizontal, 24)
        .background(glass(radius: 22, hairline: 0.06))
    }

    private var footer: some View {
        HStack {
            HStack(spacing: 10) {
                productMark(44, radius: 8)
                Text("Token Tracker")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Self.white)
            }
            Spacer()
            Text("tokentracker.cc")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Self.accent)
        }
    }

    private func productMark(_ size: CGFloat, radius: CGFloat) -> some View {
        Image("TokenTrackerMark")
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    private func glass(radius: CGFloat, hairline: Double) -> some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Self.glassFill)
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(LinearGradient(colors: [Color.white.opacity(0.08), .clear], startPoint: .top, endPoint: .center))
            )
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Color.white.opacity(hairline), lineWidth: 1)
            )
    }
}

/// `rebucket`, `groupMonths` and `monthGrid` from AnnualReportCard.jsx.
enum NeonMonthGrid {
    struct Month: Identifiable, Equatable {
        var id: String { key }
        let key: String
        let label: String
        /// Up to 6 rows of 7 levels (0...4); nil is a blank cell.
        let rows: [[Int?]]
    }

    private static let names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// Levels re-bucketed on the 50th / 75th / 90th percentile of active days,
    /// grouped by calendar month, last 12 months.
    static func months(from weeks: [[ShareHeatmapCell?]]) -> [Month] {
        let cells = weeks.flatMap { $0 }.compactMap { $0 }.filter { !$0.day.isEmpty }
        let values = cells.map(\.value).filter { $0 > 0 }.sorted()
        func quantile(_ f: Double) -> Int {
            guard !values.isEmpty else { return 0 }
            let p = Double(values.count - 1) * f
            let b = Int(p.rounded(.down))
            let lo = Double(values[b])
            let hi = Double(values[min(values.count - 1, b + 1)])
            return Int((lo + (hi - lo) * (p - Double(b))).rounded())
        }
        let (t1, t2, t3) = (quantile(0.5), quantile(0.75), quantile(0.9))
        func level(_ cell: ShareHeatmapCell) -> Int {
            guard !values.isEmpty else { return cell.level }
            let v = cell.value
            if v <= 0 { return 0 }
            if v <= t1 { return 1 }
            if v <= t2 { return 2 }
            if v <= t3 { return 3 }
            return 4
        }

        var byMonth: [String: [ShareHeatmapCell]] = [:]
        for cell in cells {
            let parts = cell.day.split(separator: "-")
            guard parts.count >= 2 else { continue }
            byMonth["\(parts[0])-\(parts[1])", default: []].append(cell)
        }

        return byMonth.keys.sorted().suffix(12).compactMap { key in
            guard let month = Int(key.split(separator: "-")[1]), (1...12).contains(month),
                  let monthCells = byMonth[key]?.sorted(by: { $0.day < $1.day }),
                  let first = monthCells.first else { return nil }
            var grid: [Int?] = Array(repeating: nil, count: weekdayIndex(first.day))
            grid += monthCells.map { Optional(min(4, max(0, level($0)))) }
            var rows: [[Int?]] = stride(from: 0, to: grid.count, by: 7).map { Array(grid[$0..<min($0 + 7, grid.count)]) }
            if var last = rows.popLast() {
                while last.count < 7 { last.append(nil) }
                rows.append(last)
            }
            return Month(key: key, label: names[month - 1], rows: Array(rows.prefix(6)))
        }
    }

    /// 0 = Sunday, from the UTC calendar like `getUTCDay()`.
    private static func weekdayIndex(_ day: String) -> Int {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let formatter = DateFormatter()
        formatter.calendar = cal
        formatter.timeZone = cal.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: day) else { return 0 }
        return cal.component(.weekday, from: date) - 1
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}
