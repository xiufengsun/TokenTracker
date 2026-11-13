import XCTest
@testable import TokenTracker

final class PKCETests: XCTestCase {
    func testS256ChallengeMatchesRFCVector() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testGeneratedVerifierIsUnpaddedBase64URL() {
        let verifier = PKCE.generate().verifier
        XCTAssertEqual(verifier.count, 43)
        XCTAssertNil(verifier.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
    }
}

final class SessionDecodingTests: XCTestCase {
    func testDecodesMobileSessionResponse() throws {
        let json = """
        {"accessToken":"a.b.c","refreshToken":"r1","csrfToken":"x",
         "user":{"id":"u1","email":"me@example.com","profile":{"name":"Me","avatar_url":null}}}
        """
        let response = try JSONDecoder().decode(AuthResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.accessToken, "a.b.c")
        XCTAssertEqual(response.refreshToken, "r1")
        XCTAssertEqual(response.user, CloudUser(id: "u1", email: "me@example.com", name: "Me"))
    }

    func testRefreshResponseWithoutUserKeepsTokens() throws {
        let response = try JSONDecoder().decode(AuthResponse.self, from: Data(#"{"accessToken":"t"}"#.utf8))
        XCTAssertNil(response.user)
        XCTAssertNil(response.refreshToken)
    }

    func testAccessTokenExpiryComesFromJWTExpClaim() {
        let payload = Data(#"{"sub":"u1","exp":2000000000}"#.utf8).base64URLEncodedString()
        let session = CloudSession(accessToken: "h.\(payload).s", refreshToken: nil, user: CloudUser(id: "u1"))
        XCTAssertEqual(session.accessTokenExpiry, Date(timeIntervalSince1970: 2_000_000_000))
        XCTAssertFalse(session.accessTokenNeedsRefresh(now: Date(timeIntervalSince1970: 1_999_999_000)))
        XCTAssertTrue(session.accessTokenNeedsRefresh(now: Date(timeIntervalSince1970: 1_999_999_950)))
    }
}

final class CloudErrorTests: XCTestCase {
    func testMembershipDenialMapsToCloudAccessRequired() {
        let body = Data(#"{"ok":false,"code":"cloud_membership_required","error":"cloud_membership_required"}"#.utf8)
        XCTAssertEqual(CloudError.from(status: 403, body: body), .cloudAccessRequired(code: "cloud_membership_required"))
    }

    func testUnauthorizedMapsToSignedOut() {
        XCTAssertEqual(CloudError.from(status: 401, body: Data(#"{"error":"Unauthorized"}"#.utf8)), .signedOut)
    }

    func testMachineSlotFailuresGetReadableCopyNotRawCodes() {
        // tokentracker-billing remove/resume failure: `error` carries the code.
        let billing = CloudError.from(status: 409, body: Data(#"{"error":"cloud_machine_limit","membership":{}}"#.utf8))
        XCTAssertEqual(billing, .server(status: 409, code: "cloud_machine_limit", message: "cloud_machine_limit"))
        XCTAssertFalse(billing.localizedDescription.contains("cloud_"))
        XCTAssertTrue(billing.localizedDescription.contains("sync slot"))

        // cloudFailure(): `{...result, error: code}` for an expired pairing code.
        let grant = CloudError.from(status: 410, body: Data(#"{"ok":false,"code":"cloud_device_code_expired","status":410,"error":"cloud_device_code_expired"}"#.utf8))
        XCTAssertTrue(grant.localizedDescription.contains("expired"))

        let unknown = CloudError.from(status: 409, body: Data(#"{"error":"cloud_something_new"}"#.utf8))
        XCTAssertFalse(unknown.localizedDescription.contains("cloud_something_new"))
    }

    func testOtherFailuresKeepStatusAndMessage() {
        let error = CloudError.from(status: 503, body: Data(#"{"error":"Cloud access unavailable","code":"cloud_access_unavailable"}"#.utf8))
        XCTAssertEqual(error, .server(status: 503, code: "cloud_access_unavailable", message: "Cloud access unavailable"))
    }
}

final class WorkspaceSnapshotTests: XCTestCase {
    func testTopModelsMergeAcrossSourcesAndSortStably() throws {
        let json = """
        {"from":"2026-11-01","to":"2026-11-12","days":12,"sources":[
          {"source":"claude","totals":{"billable_total_tokens":300,"total_cost_usd":"3"},
           "models":[{"model":"opus","model_id":"opus","totals":{"billable_total_tokens":300,"total_cost_usd":"3"}}]},
          {"source":"opencode","totals":{"billable_total_tokens":500,"total_cost_usd":"2"},
           "models":[{"model":"opus","model_id":"opus","totals":{"billable_total_tokens":150,"total_cost_usd":"1"}},
                     {"model":"gpt","model_id":"gpt","totals":{"total_tokens":400,"total_cost_usd":"1"}}]}
        ]}
        """
        let breakdown = try JSONDecoder().decode(ModelBreakdownResponse.self, from: Data(json.utf8))
        let models = PhoneWorkspaceSnapshot.rankModels(from: breakdown)
        let providers = PhoneWorkspaceSnapshot.rankProviders(from: breakdown)
        XCTAssertEqual(models.map(\.name), ["opus", "gpt"])
        XCTAssertEqual(models.first?.tokens, 450)
        XCTAssertEqual(models.first?.sources, ["claude", "opencode"])
        XCTAssertEqual(models.first?.costUsd ?? 0, 4, accuracy: 0.0001)
        XCTAssertEqual(providers.map(\.source), ["opencode", "claude"])
    }

    func testWeekRangeStartsMonday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = DateComponents(calendar: calendar, year: 2026, month: 11, day: 12, hour: 9).date!
        let range = UsageHorizon.week.range(now: now, calendar: calendar)
        XCTAssertEqual(range.from, "2026-11-09")
        XCTAssertEqual(range.to, "2026-11-15")
    }

    func testDailyEntryDecodesCostAndModelPairs() throws {
        let json = """
        {"from":"2026-11-13","to":"2026-11-13","data":[
          {"day":"2026-11-13","total_tokens":1500,"billable_total_tokens":1500,
           "total_cost_usd":4.25,"conversation_count":3,"models":{"claude-opus-4-6":1000,"gpt-5.6-sol":500}}
        ]}
        """
        let decoded = try JSONDecoder().decode(PhoneDailyUsageResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.data.first?.totalCostUsd ?? 0, 4.25, accuracy: 0.001)
        XCTAssertEqual(decoded.data.first?.models["claude-opus-4-6"], 1000)
    }

    func testCLICodeNormalizationFormatsDash() {
        XCTAssertEqual(CloudAPIClient.normalizeCLICode("ab23cd45"), "AB23-CD45")
        XCTAssertEqual(CloudAPIClient.normalizeCLICode("AB23-CD45"), "AB23-CD45")
    }
}

final class RefreshFailureTests: XCTestCase {
    func testOnlyRejectedRefreshTokensEndTheSession() {
        XCTAssertTrue(SessionStore.isRejectedRefresh(.signedOut))
        XCTAssertTrue(SessionStore.isRejectedRefresh(.server(status: 401, code: nil, message: nil)))
        XCTAssertFalse(SessionStore.isRejectedRefresh(.server(status: 400, code: "INVALID_INPUT", message: nil)))
        XCTAssertFalse(SessionStore.isRejectedRefresh(.server(status: 403, code: nil, message: nil)))
        XCTAssertFalse(SessionStore.isRejectedRefresh(.server(status: 429, code: nil, message: nil)))
        XCTAssertFalse(SessionStore.isRejectedRefresh(.server(status: 503, code: nil, message: nil)))
        XCTAssertFalse(SessionStore.isRejectedRefresh(.transport("offline")))
        XCTAssertFalse(SessionStore.isRejectedRefresh(.invalidResponse))
    }
}

final class RequestOnlyAndStreakTests: XCTestCase {
    func testRequestOnlySourcesStayRanked() throws {
        let json = """
        {"sources":[
          {"source":"claude","totals":{"billable_total_tokens":300},
           "models":[{"model":"opus","model_id":"opus","totals":{"billable_total_tokens":300}}]},
          {"source":"qoder","totals":{"conversation_count":7},
           "models":[{"model":"auto","model_id":"auto","totals":{"conversation_count":7}}]}
        ]}
        """
        let breakdown = try JSONDecoder().decode(ModelBreakdownResponse.self, from: Data(json.utf8))
        let providers = PhoneWorkspaceSnapshot.rankProviders(from: breakdown)
        let models = PhoneWorkspaceSnapshot.rankModels(from: breakdown)
        XCTAssertEqual(providers.map(\.source), ["claude", "qoder"])
        XCTAssertEqual(models.last?.name, "auto")
        XCTAssertEqual(models.last?.conversations, 7)
    }

    func testCurrentStreakCountsBackFromTodayOrYesterday() {
        func cell(_ day: String, _ tokens: Int) -> HeatmapCell? {
            HeatmapCell(day: day, totalTokens: tokens, billableTotalTokens: tokens, level: tokens > 0 ? 2 : 0)
        }
        let heatmap = HeatmapResponse(weeks: [[
            cell("2026-11-08", 5), cell("2026-11-09", 0), cell("2026-11-10", 9),
            cell("2026-11-11", 4), cell("2026-11-12", 0), nil, nil,
        ]])
        XCTAssertEqual(heatmap.currentStreak(today: "2026-11-12"), ActivityStreak(days: 2, reachesHistoryStart: false))
        XCTAssertEqual(heatmap.currentStreak(today: "2026-11-11"), ActivityStreak(days: 2, reachesHistoryStart: false))
        XCTAssertEqual(heatmap.currentStreak(today: "2026-11-14"), ActivityStreak(days: 0, reachesHistoryStart: false))
    }

    func testStreakReachingTheFirstFetchedDayIsALowerBound() {
        let heatmap = HeatmapResponse(weeks: [[
            HeatmapCell(day: "2026-11-08", totalTokens: 5, level: 2),
            HeatmapCell(day: "2026-11-09", totalTokens: 9, level: 2),
            HeatmapCell(day: "2026-11-10", totalTokens: 4, level: 2),
            nil, nil, nil, nil,
        ]])
        XCTAssertEqual(heatmap.currentStreak(today: "2026-11-10"), ActivityStreak(days: 3, reachesHistoryStart: true))
    }
}

final class ProviderMarkTests: XCTestCase {
    func testKnownSourcesResolveToRealBrandAssets() {
        XCTAssertEqual(ProviderMarks.entry(for: "claude")?.asset, "ProviderMark-claude-code")
        XCTAssertEqual(ProviderMarks.entry(for: "codex")?.asset, "ProviderMark-codex")
        XCTAssertEqual(ProviderMarks.entry(for: "cursor")?.isTemplate, true)
        XCTAssertEqual(ProviderMarks.entry(for: "copilot")?.isTemplate, true)
    }

    func testPiRoutedSourcesFallBackToPiLogoLikeDashboard() {
        XCTAssertEqual(ProviderMarks.entry(for: "pi-xai")?.asset, ProviderMarks.entry(for: "pi")?.asset)
        XCTAssertEqual(ProviderMarks.entry(for: "pi-dots")?.asset, "ProviderMark-dots")
    }

    func testUnknownSourceHasNoInventedMark() {
        XCTAssertNil(ProviderMarks.entry(for: "muse"))
        XCTAssertNil(ProviderMarks.entry(for: "some-new-tool"))
    }

    func testEveryCatalogAssetExistsInTheAppBundle() {
        let bundle = Bundle(for: SessionStore.self)
        for (key, entry) in ProviderMarkCatalog.entries {
            XCTAssertNotNil(UIImage(named: entry.asset, in: bundle, with: nil), "missing asset for \(key)")
        }
        XCTAssertNotNil(UIImage(named: "TokenTrackerMark", in: bundle, with: nil))
    }
}

final class PacingModelTests: XCTestCase {
    private var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        return cal
    }

    func testTrailingFiveHoursCountsCurrentHourAndFourBefore() {
        let now = DateComponents(calendar: calendar, year: 2026, month: 11, day: 13, hour: 2, minute: 30).date!
        let today = PhoneHourlyUsageResponse(day: "2026-11-13", data: [
            PhoneHourlyEntry(hour: "2026-11-13T00:00:00", totalTokens: 10),
            PhoneHourlyEntry(hour: "2026-11-13T02:00:00", totalTokens: 20),
        ])
        let yesterday = PhoneHourlyUsageResponse(day: "2026-11-12", data: [
            PhoneHourlyEntry(hour: "2026-11-12T21:00:00", totalTokens: 1000), // 5 hours back: excluded
            PhoneHourlyEntry(hour: "2026-11-12T22:00:00", totalTokens: 300),
        ])
        let snapshot = PhoneWorkspaceSnapshot(
            horizon: .today, selectedDeviceId: nil, now: now,
            periodSummary: UsageSummaryResponse(), todaySummary: UsageSummaryResponse(),
            todayHourly: today, yesterdayHourly: yesterday
        )
        XCTAssertEqual(snapshot.trailingFiveHourTokens, 330)
    }

    func testProviderProfilesUseSevenAndThirtyDayBreakdownsPerSource() throws {
        func breakdown(_ claude: Int, _ codex: Int) throws -> ModelBreakdownResponse {
            let json = """
            {"sources":[
              {"source":"claude","totals":{"billable_total_tokens":\(claude),"total_cost_usd":"\(claude / 100)"},"models":[]},
              {"source":"codex","totals":{"billable_total_tokens":\(codex),"total_cost_usd":"\(codex / 100)"},"models":[]}
            ]}
            """
            return try JSONDecoder().decode(ModelBreakdownResponse.self, from: Data(json.utf8))
        }
        let snapshot = PhoneWorkspaceSnapshot(
            horizon: .today, selectedDeviceId: nil, now: Date(),
            periodSummary: UsageSummaryResponse(), todaySummary: UsageSummaryResponse(),
            weeklyBreakdown: try breakdown(1000, 3000),
            monthlyBreakdown: try breakdown(9000, 4000)
        )
        let budgets = ["codex": TrackedToolBudget(source: "codex", weeklyBudgetUsd: 40)]
        let profiles = snapshot.providerPacingProfiles(budgets: budgets)
        XCTAssertEqual(profiles.map(\.source), ["codex", "claude"])
        XCTAssertEqual(profiles.first?.hottestBudgetFraction ?? 0, 0.75, accuracy: 0.0001)
        XCTAssertEqual(profiles.last?.thirtyDayCostUsd ?? 0, 90, accuracy: 0.0001)
    }

    func testAutoRenewingPlanRollsForwardPastStoredDate() {
        let iso = ISO8601DateFormatter()
        let stored = iso.date(from: "2026-09-05T12:00:00Z")!
        let now = iso.date(from: "2026-11-13T12:00:00Z")!
        let renewing = TrackedToolBudget(source: "claude", billingCycle: "monthly", nextRenewalISO: iso.string(from: stored), autoRenew: true)
        let next = renewing.upcomingRenewal(now: now, calendar: calendar)!
        XCTAssertGreaterThanOrEqual(next, now)
        XCTAssertLessThan(next.timeIntervalSince(now), 32 * 86_400)

        let ending = TrackedToolBudget(source: "claude", billingCycle: "monthly", nextRenewalISO: iso.string(from: stored), autoRenew: false)
        XCTAssertEqual(ending.upcomingRenewal(now: now), stored)
    }
}
