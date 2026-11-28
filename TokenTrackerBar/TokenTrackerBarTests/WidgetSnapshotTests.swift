import XCTest

final class WidgetSnapshotTests: XCTestCase {

    func testYesterdayDeltaIsUnavailableWhenDailyTrendSkipsYesterday() {
        let snapshot = WidgetSnapshot(
            generatedAt: date(year: 2026, month: 8, day: 10),
            today: PeriodTotals(tokens: 200),
            dailyTrend: [
                DailyPoint(
                    day: date(year: 2026, month: 8, day: 7),
                    totalTokens: 100,
                    costUsd: 0
                ),
                DailyPoint(
                    day: date(year: 2026, month: 8, day: 10),
                    totalTokens: 200,
                    costUsd: 0
                ),
            ]
        )

        XCTAssertEqual(snapshot.yesterdayTokens, 0)
        XCTAssertNil(snapshot.todayDeltaPercent)
    }

    func testYesterdayUsesTheSnapshotGenerationDate() {
        let snapshot = WidgetSnapshot(
            generatedAt: date(year: 2024, month: 2, day: 10),
            today: PeriodTotals(tokens: 150),
            dailyTrend: [
                DailyPoint(
                    day: date(year: 2024, month: 2, day: 9),
                    totalTokens: 75,
                    costUsd: 0
                ),
                DailyPoint(
                    day: date(year: 2024, month: 2, day: 10),
                    totalTokens: 150,
                    costUsd: 0
                ),
            ]
        )

        XCTAssertEqual(snapshot.yesterdayTokens, 75)
        XCTAssertEqual(snapshot.todayDeltaPercent, 100)
    }

    // MARK: - Antigravity widget limit projection

    func testAntigravityWidgetEmitsNothingWhenUnconfigured() {
        let limits = makeAntigravityLimits(
            configured: false,
            quaternary: GenericLimitWindow(usedPercent: 45, resetAt: "2026-11-27T17:00:00Z")
        )
        XCTAssertEqual(limits.widgetLimitProviders(now: fixedNow, parseReset: parseISO), [])
    }

    func testAntigravityWidgetShowsOnlyGemini5hAnd7dWhenClaudeIsIdle() {
        let limits = makeAntigravityLimits(
            primary: GenericLimitWindow(usedPercent: 0),
            secondary: GenericLimitWindow(usedPercent: 0),
            tertiary: GenericLimitWindow(usedPercent: 16, resetAt: "2026-12-03T23:49:38Z"),
            quaternary: GenericLimitWindow(usedPercent: 45, resetAt: "2026-11-27T16:41:32Z")
        )

        let rows = limits.widgetLimitProviders(now: fixedNow, parseReset: parseISO)

        XCTAssertEqual(rows.map(\.label), [
            "Antigravity · Gemini 5h",
            "Antigravity · Gemini 7d",
        ])
        XCTAssertEqual(rows.map(\.source), ["antigravity", "antigravity"])
        XCTAssertEqual(rows[0].fraction, 0.45, accuracy: 0.0001)
        XCTAssertEqual(rows[0].resetsAt, parseISO("2026-11-27T16:41:32Z"))
        XCTAssertEqual(rows[1].fraction, 0.16, accuracy: 0.0001)
        XCTAssertEqual(rows[1].resetsAt, parseISO("2026-12-03T23:49:38Z"))
    }

    func testAntigravityWidgetPrefersUsedGeminiOverZeroClaudeEvenWithFallbackResetTime() {
        let limits = makeAntigravityLimits(
            primary: GenericLimitWindow(usedPercent: 0, resetAt: "2026-12-03T00:00:00Z"),
            secondary: GenericLimitWindow(usedPercent: 0, resetAt: "2026-11-27T20:00:00Z"),
            tertiary: GenericLimitWindow(usedPercent: 20, resetAt: "2026-12-03T00:00:00Z"),
            quaternary: GenericLimitWindow(usedPercent: 0, resetAt: "2026-11-27T20:00:00Z")
        )

        let rows = limits.widgetLimitProviders(now: fixedNow, parseReset: parseISO)

        XCTAssertEqual(rows.map(\.label), [
            "Antigravity · Gemini 5h",
            "Antigravity · Gemini 7d",
        ])
        XCTAssertEqual(rows[0].fraction, 0.0, accuracy: 0.0001)
        XCTAssertEqual(rows[1].fraction, 0.20, accuracy: 0.0001)
    }

    func testAntigravityWidgetShowsOnlyClaude5hAnd7dWhenGeminiIsIdle() {
        let limits = makeAntigravityLimits(
            primary: GenericLimitWindow(usedPercent: 32, resetAt: "2026-12-03T00:00:00Z"),
            secondary: GenericLimitWindow(usedPercent: 55, resetAt: "2026-11-27T19:00:00Z"),
            tertiary: GenericLimitWindow(usedPercent: 0),
            quaternary: GenericLimitWindow(usedPercent: 0)
        )

        let rows = limits.widgetLimitProviders(now: fixedNow, parseReset: parseISO)

        XCTAssertEqual(rows.map(\.label), [
            "Antigravity · Claude 5h",
            "Antigravity · Claude 7d",
        ])
        XCTAssertEqual(rows[0].fraction, 0.55, accuracy: 0.0001)
        XCTAssertEqual(rows[1].fraction, 0.32, accuracy: 0.0001)
    }

    func testAntigravityWidgetOrdersHotterFamilyFirstWhenBothFamiliesAreUsed() {
        let geminiHotter = makeAntigravityLimits(
            primary: GenericLimitWindow(usedPercent: 25),
            secondary: GenericLimitWindow(usedPercent: 10),
            tertiary: GenericLimitWindow(usedPercent: 40),
            quaternary: GenericLimitWindow(usedPercent: 75)
        )
        XCTAssertEqual(
            geminiHotter.widgetLimitProviders(now: fixedNow, parseReset: parseISO).map(\.label),
            [
                "Antigravity · Gemini 5h",
                "Antigravity · Gemini 7d",
                "Antigravity · Claude 5h",
                "Antigravity · Claude 7d",
            ]
        )

        let claudeHotterOrTied = makeAntigravityLimits(
            primary: GenericLimitWindow(usedPercent: 40),
            secondary: GenericLimitWindow(usedPercent: 10),
            tertiary: GenericLimitWindow(usedPercent: 40),
            quaternary: GenericLimitWindow(usedPercent: 20)
        )
        XCTAssertEqual(
            claudeHotterOrTied.widgetLimitProviders(now: fixedNow, parseReset: parseISO).map(\.label),
            [
                "Antigravity · Claude 5h",
                "Antigravity · Claude 7d",
                "Antigravity · Gemini 5h",
                "Antigravity · Gemini 7d",
            ]
        )
    }

    func testAntigravityWidgetUsesActiveFutureResetTieBreakerWhenBothFamiliesAreAtZero() {
        let limits = makeAntigravityLimits(
            primary: GenericLimitWindow(usedPercent: 0),
            secondary: GenericLimitWindow(usedPercent: 0),
            tertiary: GenericLimitWindow(usedPercent: 0, resetAt: "2026-12-03T23:49:38Z"),
            quaternary: GenericLimitWindow(usedPercent: 0, resetAt: "2026-11-27T17:00:00Z")
        )

        let rows = limits.widgetLimitProviders(now: fixedNow, parseReset: parseISO)

        XCTAssertEqual(rows.map(\.label), [
            "Antigravity · Gemini 5h",
            "Antigravity · Gemini 7d",
        ])
    }

    func testAntigravityWidgetFallsBackToAllWindowsWhenBothFamiliesAreIdle() {
        let limits = makeAntigravityLimits(
            primary: GenericLimitWindow(usedPercent: 0),
            secondary: GenericLimitWindow(usedPercent: 0),
            tertiary: GenericLimitWindow(usedPercent: 0, resetAt: "2026-11-20T00:00:00Z"), // expired
            quaternary: GenericLimitWindow(usedPercent: 0)
        )

        let rows = limits.widgetLimitProviders(now: fixedNow, parseReset: parseISO)

        XCTAssertEqual(rows.map(\.label), [
            "Antigravity · Claude 5h",
            "Antigravity · Claude 7d",
            "Antigravity · Gemini 5h",
            "Antigravity · Gemini 7d",
        ])
    }

    func testAntigravityWidgetHandlesSingleFamilyPayload() {
        let geminiOnlyPayload = makeAntigravityLimits(
            tertiary: GenericLimitWindow(usedPercent: 12),
            quaternary: GenericLimitWindow(usedPercent: 34)
        )
        XCTAssertEqual(
            geminiOnlyPayload.widgetLimitProviders(now: fixedNow, parseReset: parseISO).map(\.label),
            [
                "Antigravity · Gemini 5h",
                "Antigravity · Gemini 7d",
            ]
        )
    }

    private var fixedNow: Date {
        parseISO("2026-11-27T16:30:00Z")!
    }

    private func parseISO(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: raw)
    }

    private func makeAntigravityLimits(
        configured: Bool = true,
        primary: GenericLimitWindow? = nil,
        secondary: GenericLimitWindow? = nil,
        tertiary: GenericLimitWindow? = nil,
        quaternary: GenericLimitWindow? = nil
    ) -> AntigravityLimits {
        AntigravityLimits(
            configured: configured,
            error: nil,
            planLabel: "Google AI Pro",
            accountEmail: nil,
            accountPlan: "Google AI Pro",
            primaryWindow: primary,
            secondaryWindow: secondary,
            tertiaryWindow: tertiary,
            quaternaryWindow: quaternary
        )
    }

    private func date(year: Int, month: Int, day: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
    }
}
