import XCTest
@testable import TokenTracker

final class PKCETests: XCTestCase {
    /// RFC 7636 Appendix B test vector.
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

    func testOtherFailuresKeepStatusAndMessage() {
        let error = CloudError.from(status: 503, body: Data(#"{"error":"Cloud access unavailable","code":"cloud_access_unavailable"}"#.utf8))
        XCTAssertEqual(error, .server(status: 503, code: "cloud_access_unavailable", message: "Cloud access unavailable"))
    }
}

final class UsageSnapshotTests: XCTestCase {
    func testTopModelsMergeAcrossSourcesAndSortByTokens() throws {
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
        let snapshot = UsageSnapshot(period: .week, summary: UsageSummaryResponse(), breakdown: breakdown, fetchedAt: Date())
        XCTAssertEqual(snapshot.topModels.map(\.name), ["opus", "gpt"])
        XCTAssertEqual(snapshot.topModels.first?.tokens, 450)
        XCTAssertEqual(snapshot.topModels.first?.sources, ["claude", "opencode"])
        XCTAssertEqual(snapshot.topModels.first?.costUsd ?? 0, 4, accuracy: 0.0001)
        XCTAssertEqual(snapshot.sources.map(\.source), ["opencode", "claude"])
    }

    func testWeekRangeStartsMonday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        // Thursday 2026-11-12
        let now = DateComponents(calendar: calendar, year: 2026, month: 11, day: 12, hour: 9).date!
        let range = UsagePeriod.week.range(now: now, calendar: calendar)
        XCTAssertEqual(range.from, "2026-11-09")
        XCTAssertEqual(range.to, "2026-11-15")
    }
}

final class RefreshFailureTests: XCTestCase {
    func testOnlyRejectedRefreshTokensEndTheSession() {
        XCTAssertTrue(SessionStore.isRejectedRefresh(.signedOut))
        XCTAssertTrue(SessionStore.isRejectedRefresh(.server(status: 401, code: nil, message: nil)))
        XCTAssertTrue(SessionStore.isRejectedRefresh(.server(status: 400, code: "INVALID_REFRESH_TOKEN", message: nil)))
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
        let snapshot = UsageSnapshot(period: .day, summary: UsageSummaryResponse(), breakdown: breakdown, fetchedAt: Date())
        XCTAssertEqual(snapshot.sources.map(\.source), ["claude", "qoder"])
        XCTAssertEqual(snapshot.topModels.last?.name, "auto")
        XCTAssertEqual(snapshot.topModels.last?.conversations, 7)
    }

    func testCurrentStreakCountsBackFromTodayOrYesterday() {
        func cell(_ day: String, _ tokens: Int) -> HeatmapCell? {
            HeatmapCell(day: day, totalTokens: tokens, billableTotalTokens: tokens, level: tokens > 0 ? 2 : 0)
        }
        let heatmap = HeatmapResponse(weeks: [[
            cell("2026-11-08", 5), cell("2026-11-09", 0), cell("2026-11-10", 9),
            cell("2026-11-11", 4), cell("2026-11-12", 0), nil, nil,
        ]])
        XCTAssertEqual(heatmap.currentStreak(today: "2026-11-12"), 2, "today empty: count from yesterday")
        XCTAssertEqual(heatmap.currentStreak(today: "2026-11-11"), 2)
        XCTAssertEqual(heatmap.currentStreak(today: "2026-11-14"), 0)
    }
}

final class RankingTieTests: XCTestCase {
    func testEqualTotalsSortByName() throws {
        let json = """
        {"sources":[{"source":"codex","totals":{"billable_total_tokens":200},"models":[
          {"model":"zeta","model_id":"zeta","totals":{"billable_total_tokens":100}},
          {"model":"alpha","model_id":"alpha","totals":{"billable_total_tokens":100}}]}]}
        """
        let breakdown = try JSONDecoder().decode(ModelBreakdownResponse.self, from: Data(json.utf8))
        let snapshot = UsageSnapshot(period: .day, summary: UsageSummaryResponse(), breakdown: breakdown, fetchedAt: Date())
        for _ in 0..<20 { XCTAssertEqual(snapshot.topModels.map(\.name), ["alpha", "zeta"]) }
    }
}
