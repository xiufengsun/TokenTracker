import XCTest
@testable import TokenTracker

final class ShareCardDataTests: XCTestCase {
    private let now: Date = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        return DateComponents(calendar: cal, year: 2026, month: 11, day: 13, hour: 16).date!
    }()

    private func breakdown(_ json: String) throws -> ModelBreakdownResponse {
        try JSONDecoder().decode(ModelBreakdownResponse.self, from: Data(json.utf8))
    }

    private func snapshot(
        horizon: UsageHorizon = .week,
        tokens: Int = 1_234_567,
        cost: String = "42.5",
        breakdown: ModelBreakdownResponse? = nil
    ) -> PhoneWorkspaceSnapshot {
        let totals = TokenTotals(totalTokens: tokens, billableTotalTokens: tokens, conversationCount: 3, totalCostUsd: cost)
        return PhoneWorkspaceSnapshot(
            horizon: horizon, selectedDeviceId: nil, now: now,
            periodSummary: UsageSummaryResponse(totals: totals),
            todaySummary: UsageSummaryResponse(totals: totals),
            periodBreakdown: breakdown
        )
    }

    func testPeriodMapsFromPulseHorizonWithDashboardIssueLabels() {
        XCTAssertEqual(ShareCardPeriod(.today), .day)
        XCTAssertEqual(ShareCardPeriod(.week), .week)
        XCTAssertEqual(ShareCardPeriod(.month), .month)
        XCTAssertEqual(ShareCardPeriod(.total), .total)

        func card(_ h: UsageHorizon) -> ShareCardData {
            .build(snapshot: snapshot(horizon: h), heatmap: nil, userName: "Alex", currency: .usd, masksCost: false)
        }
        XCTAssertEqual(card(.today).issueLabel, "2026.11.13")
        XCTAssertEqual(card(.week).periodFrom, "2026-11-09")
        XCTAssertEqual(card(.week).issueLabel, "NOV 2026")
        XCTAssertEqual(card(.month).periodTo, "2026-11-30")
        XCTAssertEqual(card(.total).issueLabel, "ALL TIME")
    }

    func testTotalsComeFromThePeriodSummaryOnly() {
        let data = ShareCardData.build(snapshot: snapshot(), heatmap: nil, userName: "Alex", currency: .usd, masksCost: false)
        XCTAssertEqual(data.totalTokens, 1_234_567)
        XCTAssertEqual(data.totalCostUsd ?? 0, 42.5, accuracy: 0.0001)
        XCTAssertEqual(data.costLabel, "$42.50")
        XCTAssertEqual(data.activeDays, 0, "no heatmap, no invented activity")
        XCTAssertNil(data.startDate)
        XCTAssertTrue(data.topModels.isEmpty)
        XCTAssertTrue(data.heatmapWeeks.isEmpty)
    }

    func testMaskCostFiguresRemovesTheAmountFromTheCard() {
        let data = ShareCardData.build(snapshot: snapshot(cost: "912.34"), heatmap: nil, userName: "Alex", currency: .eur, masksCost: true)
        XCTAssertNil(data.totalCostUsd)
        XCTAssertEqual(data.costLabel, "€•••")
        XCTAssertFalse(data.costLabel.contains(where: \.isNumber))
    }

    func testCostFollowsDashboardFormatCost() {
        func label(_ usd: String, _ currency: PhoneCurrency) -> String {
            ShareCardData.build(snapshot: snapshot(cost: usd), heatmap: nil, userName: nil, currency: currency, masksCost: false).costLabel
        }
        XCTAssertEqual(label("0", .usd), "$0.00")
        XCTAssertEqual(label("1234.6", .usd), "$1,235")
        XCTAssertEqual(label("10", .cny), "¥72.00")
    }

    func testTopModelsMatchBuildTopModels() throws {
        let bd = try breakdown("""
        {"sources":[
          {"source":"claude","totals":{"billable_total_tokens":700},"models":[
            {"model":"claude-opus-4-6","model_id":"claude-opus-4-6","totals":{"billable_total_tokens":500}},
            {"model":"auto","model_id":"auto","totals":{"conversation_count":4}}]},
          {"source":"opencode","totals":{"billable_total_tokens":500},"models":[
            {"model":"anthropic/claude-opus-4-6","model_id":"x","totals":{"billable_total_tokens":200}},
            {"model":"gpt-5.6","model_id":"gpt-5.6","totals":{"billable_total_tokens":250}},
            {"model":"kimi","model_id":"kimi","totals":{"billable_total_tokens":40}},
            {"model":"glm","model_id":"glm","totals":{"billable_total_tokens":10}}]}
        ]}
        """)
        let models = ShareCardData.topModels(from: bd)
        XCTAssertEqual(models.map(\.name), ["claude-opus-4-6", "gpt-5.6", "kimi"], "limit 3, request-only model left out")
        XCTAssertEqual(models.first?.tokens, 700, "provider/model folds into its bare name")
        XCTAssertEqual(models.map(\.percent), ["70.0", "25.0", "4.0"])
    }

    func testHandleMatchesDashboardIdentityHandle() {
        XCTAssertEqual(ShareCardData.handle(from: "Alex Chen"), "Alex_Chen")
        XCTAssertEqual(ShareCardData.handle(from: "me@example.com"), "Anonymous")
        XCTAssertEqual(ShareCardData.handle(from: nil), "Anonymous")
    }

    func testHeatmapUsesOnlyWhatCloudReturned() {
        let heatmap = HeatmapResponse(activeDays: 2, weeks: [[
            HeatmapCell(day: "2026-11-08", totalTokens: 0, level: 0),
            HeatmapCell(day: "2026-11-09", totalTokens: 50, billableTotalTokens: 50, level: 2),
            HeatmapCell(day: "2026-11-10", totalTokens: 90, billableTotalTokens: 90, level: 4),
            nil, nil, nil, nil,
        ]])
        let data = ShareCardData.build(snapshot: snapshot(), heatmap: heatmap, userName: "A", currency: .usd, masksCost: false)
        XCTAssertEqual(data.heatmapWeeks.count, 1)
        XCTAssertEqual(data.heatmapTotalDays, 3)
        XCTAssertEqual(data.heatmapActiveDays, 2)
        XCTAssertEqual(data.activeDays, 2)
        XCTAssertEqual(data.startDate, "2026-11-09")
        XCTAssertEqual(data.longestStreak, 2)
    }

    func testEmptyPeriodIsNotShareable() {
        let empty = ShareCardData.build(snapshot: snapshot(tokens: 0, cost: "0"), heatmap: nil, userName: "A", currency: .usd, masksCost: false)
        XCTAssertFalse(empty.isShareable)
        XCTAssertTrue(ShareCardData.build(snapshot: snapshot(), heatmap: nil, userName: "A", currency: .usd, masksCost: false).isShareable)
    }

    func testHookFollowsDashboardPriority() throws {
        var data = ShareCardData.build(snapshot: snapshot(), heatmap: nil, userName: "A", currency: .usd, masksCost: false)
        XCTAssertEqual(data.hookLine, "The beginning of a new chapter.")
        data.topModels = [ShareCardModel(id: "o", name: "opus", tokens: 9, percent: "72.4")]
        XCTAssertEqual(data.hookLine, "72% loyal to opus.")
        data.topModels[0].percent = "40.0"
        data.activeDays = 61
        XCTAssertEqual(data.hookLine, "61 days on the record.")
    }
}

final class ShareCaptionTests: XCTestCase {
    func testProfileURLUsesAccountIdWhenKnown() {
        XCTAssertEqual(
            ShareCaption.profileURL(userId: "8f21c04a-77e9-49a2-91ab-284f0199a01b").absoluteString,
            "https://www.tokentracker.cc/u/8f21c04a-77e9-49a2-91ab-284f0199a01b?ref=share"
        )
        XCTAssertEqual(ShareCaption.profileURL(userId: nil).absoluteString, "https://www.tokentracker.cc/?ref=share")
        XCTAssertEqual(ShareCaption.profileURL(userId: "  ").absoluteString, "https://www.tokentracker.cc/?ref=share")
    }

    func testCaptionIsTheDashboardTwitterText() throws {
        let bd = try JSONDecoder().decode(ModelBreakdownResponse.self, from: Data("""
        {"sources":[
          {"source":"codex","totals":{"billable_total_tokens":100},"models":[
            {"model":"gpt-5.6","model_id":"gpt-5.6","totals":{"billable_total_tokens":100}}]},
          {"source":"claude","totals":{"billable_total_tokens":800},"models":[
            {"model":"opus","model_id":"opus","totals":{"billable_total_tokens":600}},
            {"model":"sonnet","model_id":"sonnet","totals":{"billable_total_tokens":200}}]}
        ]}
        """.utf8))
        let text = ShareCaption.text(summaryTokens: 1_500_000, breakdown: bd)
        XCTAssertEqual(text, "1,500,000 tokens on the record.\nopus led with 75.0%.\n\nMy AI usage, unaudited →")
        XCTAssertFalse(text.contains("$"), "caption never carries spend, pricing or purchase links")
    }
}

@MainActor
final class ShareRendererTests: XCTestCase {
    func testBothVariantsRenderPNGsAtTwiceTheDashboardCanvas() {
        let data = ShareCardData(
            handle: "Alex_Chen", startDate: "2025-11-14", activeDays: 12, totalTokens: 4_860_000, totalCostUsd: nil,
            period: .week, periodFrom: "2026-11-09", periodTo: "2026-11-15",
            topModels: [ShareCardModel(id: "opus", name: "opus", tokens: 10, percent: "100.0")],
            heatmapWeeks: [[ShareHeatmapCell(day: "2026-11-09", level: 3, value: 10)]],
            heatmapTotalDays: 1, heatmapActiveDays: 1, currency: .usd
        )
        for variant in ShareCardVariant.allCases {
            let png = ShareCardRenderer.render(data, variant: variant)
            XCTAssertNotNil(png, variant.rawValue)
            XCTAssertEqual(png?.image.size.width, variant.size.width, variant.rawValue)
            XCTAssertEqual(png?.image.scale, 2)
            XCTAssertEqual(png?.png.prefix(4), Data([0x89, 0x50, 0x4E, 0x47]))
        }
    }
}
