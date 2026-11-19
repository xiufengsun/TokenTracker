import SwiftUI

/// SwiftUI port of dashboard/src/ui/share/variants/BroadsheetCard.jsx at its
/// 1200 × 1630 canvas: ivory paper, warm ink, one vermillion accent. The
/// dashboard's serif stack is "Instrument Serif", "Times New Roman", Georgia;
/// iOS has no Instrument Serif, so the card uses the stack's next entry.
/// Colors are the sRGB values of the card's oklch() literals.
struct BroadsheetShareCard: View {
    let data: ShareCardData

    private static let paper = Color(hex: 0xF8F5EE)
    private static let ink = Color(hex: 0x161107)
    private static let inkSoft = Color(hex: 0x464239)
    private static let rule = Color(hex: 0x75716A)
    private static let vermillion = Color(hex: 0xD40924)
    private static let heatmapPalette: [Color] = [
        Color(hex: 0xECE7DE), Color(hex: 0xEACEBC), Color(hex: 0xE8A587), Color(hex: 0xE66B4D), Color(hex: 0xD40924),
    ]

    private static let contentWidth: CGFloat = 1200 - 88 * 2

    private func display(_ size: CGFloat, italic: Bool = false) -> Font {
        let font = Font.custom("Times New Roman", fixedSize: size)
        return italic ? font.italic() : font
    }

    private func caps(_ text: String, size: CGFloat, tracking: CGFloat, color: Color, weight: Font.Weight = .regular) -> some View {
        Text(text.uppercased())
            .font(.system(size: size, weight: weight))
            .tracking(size * tracking)
            .foregroundStyle(color)
            .lineLimit(1)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            masthead
            byline.padding(.top, 24)
            hero.padding(.top, 40)
            if !data.heatmapWeeks.isEmpty {
                heatmap.padding(.top, 40)
            }
            roster.padding(.top, 30)
            Spacer(minLength: 0)
            footer.padding(.top, 18)
        }
        .padding(EdgeInsets(top: 80, leading: 88, bottom: 68, trailing: 88))
        .frame(width: ShareCardVariant.broadsheet.size.width, height: ShareCardVariant.broadsheet.size.height, alignment: .topLeading)
        .background(Self.paper)
        .environment(\.colorScheme, .light)
    }

    private var masthead: some View {
        VStack(spacing: 14) {
            HStack(spacing: 24) {
                HStack(spacing: 14) {
                    Circle().fill(Self.vermillion).frame(width: 10, height: 10)
                    caps("The Token Tracker", size: 14, tracking: 0.22, color: Self.ink, weight: .medium)
                }
                Spacer()
                caps("Issue № \(data.issueLabel)", size: 12, tracking: 0.22, color: Self.inkSoft)
            }
            Self.rule.frame(height: 1)
        }
    }

    private var byline: some View {
        HStack(alignment: .bottom, spacing: 24) {
            VStack(alignment: .leading, spacing: 6) {
                caps("By", size: 12, tracking: 0.2, color: Self.inkSoft)
                Text(data.handle)
                    .font(display(52, italic: true))
                    .tracking(-52 * 0.01)
                    .foregroundStyle(Self.ink)
                    .lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                caps("Tracked since", size: 12, tracking: 0.18, color: Self.inkSoft)
                caps(ShareCardData.shortDate(data.startDate), size: 12, tracking: 0.18, color: Self.ink)
            }
        }
    }

    private var hero: some View {
        let number = ShareCardData.formatTokens(data.totalTokens)
        let size = ShareCardData.heroFontSize(number, base: 188, baseChars: 9, shrinkPerChar: 14, min: 104)
        return VStack(alignment: .leading, spacing: 0) {
            caps("Total tokens", size: 13, tracking: 0.3, color: Self.vermillion)
                .padding(.bottom, 10)
            Text(number)
                .font(display(size))
                .tracking(-size * 0.032)
                .monospacedDigit()
                .foregroundStyle(Self.ink)
                .lineLimit(1)
                .frame(height: size * 0.86, alignment: .center)
            Text("\u{201C}\(data.hookLine)\u{201D}")
                .font(display(34, italic: true))
                .foregroundStyle(Self.ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.top, 14)
            Self.vermillion.frame(height: 1).padding(.top, 14)
            HStack {
                caps("Estimated spend · \(data.costLabel)", size: 13, tracking: 0.16, color: Self.inkSoft)
                Spacer()
                caps("\(data.activeDays) billable days", size: 13, tracking: 0.16, color: Self.inkSoft)
            }
            .padding(.top, 10)
        }
    }

    private var heatmap: some View {
        let weeks = data.heatmapWeeks
        let gap: CGFloat = 3
        let cell = max(4, (Self.contentWidth - CGFloat(weeks.count - 1) * gap) / CGFloat(max(weeks.count, 1)))
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                caps("The Year in Print", size: 12, tracking: 0.3, color: Self.ink, weight: .semibold)
                Spacer()
                caps("\(data.heatmapActiveDays) / \(data.heatmapTotalDays) days on record", size: 11, tracking: 0.18, color: Self.inkSoft)
            }
            // HeatmapStrip: cell size fills the width exactly; a missing cell gets the empty color.
            HStack(alignment: .top, spacing: gap) {
                ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                    VStack(spacing: gap) {
                        ForEach(Array(week.prefix(7).enumerated()), id: \.offset) { _, day in
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Self.heatmapPalette[day?.level ?? 0])
                                .frame(width: cell, height: cell)
                        }
                    }
                }
            }
            .frame(width: Self.contentWidth, height: 7 * cell + 6 * gap, alignment: .topLeading)
        }
    }

    private var roster: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                caps("The Roster", size: 12, tracking: 0.3, color: Self.ink, weight: .semibold)
                Spacer()
                caps("Models in regular rotation", size: 11, tracking: 0.18, color: Self.inkSoft)
            }
            .padding(.bottom, 10)
            Self.ink.frame(height: 1).padding(.bottom, 6)

            if data.topModels.isEmpty {
                Text("An empty week \u{2014} the press was quiet.")
                    .font(display(26, italic: true))
                    .foregroundStyle(Self.inkSoft)
                    .padding(.top, 14)
            } else {
                ForEach(Array(data.topModels.enumerated()), id: \.element.id) { index, model in
                    VStack(spacing: 0) {
                        HStack(alignment: .firstTextBaseline, spacing: 16) {
                            Text(String(format: "%02d", index + 1))
                                .font(display(34, italic: true))
                                .foregroundStyle(Self.vermillion)
                                .frame(width: 52, alignment: .leading)
                            Text(model.name)
                                .font(display(32))
                                .tracking(-32 * 0.01)
                                .foregroundStyle(Self.ink)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(ShareCardData.formatTokens(model.tokens))
                                .font(display(28))
                                .monospacedDigit()
                                .foregroundStyle(Self.ink)
                                .lineLimit(1)
                                .fixedSize()
                            Text("\(model.percent)%")
                                .font(.system(size: 13))
                                .tracking(13 * 0.1)
                                .monospacedDigit()
                                .foregroundStyle(Self.inkSoft)
                                .frame(width: 68, alignment: .trailing)
                        }
                        .padding(.vertical, 13)
                        Self.rule.frame(height: 1)
                    }
                }
            }
        }
    }

    private var footer: some View {
        VStack(spacing: 12) {
            Self.ink.frame(height: 1)
            HStack {
                HStack(spacing: 28) {
                    HStack(spacing: 6) {
                        caps("Global rank", size: 12, tracking: 0.22, color: Self.ink)
                        // The phone does not read the leaderboard; the dashboard prints "—" for a missing rank.
                        caps("№ —", size: 12, tracking: 0.22, color: Self.vermillion)
                    }
                    HStack(spacing: 6) {
                        caps("Active", size: 12, tracking: 0.22, color: Self.ink)
                        caps("\(data.activeDays) days", size: 12, tracking: 0.22, color: Self.vermillion)
                    }
                }
                Spacer()
                HStack(spacing: 6) {
                    caps("Track yours", size: 12, tracking: 0.22, color: Self.ink)
                    caps("→ tokentracker.cc", size: 12, tracking: 0.22, color: Self.vermillion)
                }
            }
        }
    }
}
