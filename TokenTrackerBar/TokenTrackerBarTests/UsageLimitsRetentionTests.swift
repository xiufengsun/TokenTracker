import CFNetwork
import XCTest

/// Covers the "retain last usage limits record" feature: the
/// `hasAnyProviderWithoutError` predicate and the `displayRecord` retention
/// rule used by DashboardViewModel after a successful limits fetch.
final class UsageLimitsRetentionTests: XCTestCase {
    func testLocalAPISessionDisablesResponseCaching() {
        let session = URLSession(configuration: LocalAPIConfiguration.makeSessionConfiguration())
        defer { session.invalidateAndCancel() }
        XCTAssertEqual(session.configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertNil(session.configuration.urlCache)
        XCTAssertEqual(session.configuration.timeoutIntervalForRequest, 10)
        XCTAssertEqual(session.configuration.timeoutIntervalForResource, 30)
    }

    /// A system proxy that does not bypass localhost otherwise swallows every
    /// loopback request and the app reports the local server as unreachable.
    func testLocalAPISessionBypassesSystemProxies() {
        let proxies = LocalAPIConfiguration.makeSessionConfiguration().connectionProxyDictionary
        XCTAssertNotNil(proxies)
        for key in [
            kCFNetworkProxiesHTTPEnable,
            kCFNetworkProxiesHTTPSEnable,
            kCFNetworkProxiesSOCKSEnable,
            kCFNetworkProxiesProxyAutoConfigEnable,
        ] {
            XCTAssertEqual(proxies?[key as AnyHashable] as? Int, 0, "\(key) should be disabled")
        }
    }

    func testLastGoodCacheRoundTripsAcrossAppRestarts() throws {
        let suiteName = "UsageLimitsRetentionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let response = try decodeResponse(overrides: [
            "claude": [
                "configured": true,
                "five_hour": ["utilization": 42.0],
            ],
        ])

        UsageLimitsCache.save(response, defaults: defaults)

        XCTAssertEqual(UsageLimitsCache.load(defaults: defaults), response)
    }

    func testCorruptLastGoodCacheIsIgnored() throws {
        let suiteName = "UsageLimitsRetentionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(Data("not-json".utf8), forKey: UsageLimitsCache.defaultsKey)

        XCTAssertNil(UsageLimitsCache.load(defaults: defaults))
    }

    func testFutureDatedLastGoodCacheIsIgnoredAfterClockRollback() throws {
        let suiteName = "UsageLimitsRetentionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let futureResponse = try decodeResponse(overrides: [
            "fetched_at": "2026-11-01T00:59:36.105Z",
            "codex": ["configured": true],
        ])
        let now = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-09-07T00:00:00Z")
        )

        UsageLimitsCache.save(futureResponse, defaults: defaults)

        XCTAssertNil(UsageLimitsCache.load(defaults: defaults, now: now))
    }

    // MARK: - hasAnyProviderWithoutError

    func testAllProvidersUnconfiguredHasNoUsableProvider() throws {
        let response = try decodeResponse()

        XCTAssertFalse(response.hasAnyProviderWithoutError)
    }

    func testAllConfiguredProvidersErroredHasNoUsableProvider() throws {
        let response = try decodeResponse(overrides: [
            "claude": ["configured": true, "error": "401 unauthorized"],
            "codex": ["configured": true, "error": "timeout"],
        ])

        XCTAssertFalse(response.hasAnyProviderWithoutError)
    }

    func testSingleConfiguredErrorFreeProviderIsUsable() throws {
        let response = try decodeResponse(overrides: [
            "claude": ["configured": true],
        ])

        XCTAssertTrue(response.hasAnyProviderWithoutError)
    }

    func testUsableProviderAmongErroredOnesIsStillUsable() throws {
        let response = try decodeResponse(overrides: [
            "claude": ["configured": true, "error": "401 unauthorized"],
            "kiro": ["configured": true],
        ])

        XCTAssertTrue(response.hasAnyProviderWithoutError)
    }

    func testOptionalProviderCountsWhenUsable() throws {
        let response = try decodeResponse(overrides: [
            "grok": ["configured": true],
        ])

        XCTAssertTrue(response.hasAnyProviderWithoutError)
    }

    func testQoderCnCountsWhenUsable() throws {
        let response = try decodeResponse(overrides: [
            "qoderCn": ["configured": true],
        ])

        XCTAssertTrue(response.hasAnyProviderWithoutError)
    }

    func testOptionalProviderWithErrorDoesNotCount() throws {
        let response = try decodeResponse(overrides: [
            "copilot": ["configured": true, "error": "rate limited"],
        ])

        XCTAssertFalse(response.hasAnyProviderWithoutError)
    }

    func testDevinCountsWhenUsable() throws {
        let response = try decodeResponse(overrides: [
            "devin": ["configured": true],
        ])

        XCTAssertTrue(response.hasAnyProviderWithoutError)
    }

    // MARK: - displayRecord retention rule

    func testDisplayRecordAdoptsIncomingWhenNoCurrentRecord() throws {
        let incoming = try decodeResponse(overrides: [
            "claude": ["configured": true, "error": "401 unauthorized"],
        ])

        let displayed = UsageLimitsResponse.displayRecord(current: nil, incoming: incoming)

        XCTAssertEqual(displayed, incoming)
    }

    func testDisplayRecordAdoptsUsableIncomingOverCurrent() throws {
        let current = try decodeResponse(overrides: [
            "claude": ["configured": true],
        ])
        let incoming = try decodeResponse(overrides: [
            "claude": ["configured": true, "plan_label": "Max"],
        ])

        let displayed = UsageLimitsResponse.displayRecord(current: current, incoming: incoming)

        XCTAssertEqual(displayed, incoming)
    }

    func testDisplayRecordKeepsCurrentWhenIncomingHasNoUsableProvider() throws {
        let current = try decodeResponse(overrides: [
            "claude": ["configured": true],
        ])
        let incoming = try decodeResponse(overrides: [
            "claude": ["configured": true, "error": "connection refused"],
            "codex": ["configured": true, "error": "connection refused"],
        ])

        let displayed = UsageLimitsResponse.displayRecord(current: current, incoming: incoming)

        XCTAssertEqual(displayed, current)
    }

    func testDisplayRecordAdoptsPartiallyUsableIncoming() throws {
        let current = try decodeResponse(overrides: [
            "claude": ["configured": true],
            "codex": ["configured": true],
        ])
        let incoming = try decodeResponse(overrides: [
            "claude": ["configured": true, "error": "401 unauthorized"],
            "codex": ["configured": true],
        ])

        let displayed = UsageLimitsResponse.displayRecord(current: current, incoming: incoming)

        XCTAssertEqual(displayed, incoming)
    }

    func testCodexResetCreditsMissingFromOldPayloadDecodesAsNil() throws {
        let response = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "plan_label": "Plus",
                "primary_window": [
                    "used_percent": 42,
                    "reset_at": 1_782_000_000,
                    "limit_window_seconds": 18_000,
                ],
            ],
        ])

        XCTAssertEqual(response.codex.planLabel, "Plus")
        XCTAssertEqual(response.codex.primaryWindow?.usedPercent, 42)
        XCTAssertNil(response.codex.creditWindow)
        XCTAssertNil(response.codex.resetCredits)
    }

    func testCursorWindowDecodesBillingCycleDurationForPaceMarker() throws {
        let response = try decodeResponse(overrides: [
            "cursor": [
                "configured": true,
                "primary_window": [
                    "used_percent": 42.4,
                    "reset_at": "2026-09-04T03:32:21.000Z",
                    "limit_window_seconds": 2_678_400,
                ],
                "quaternary_window": [
                    "used_percent": 0,
                    "reset_at": "2026-08-31T10:37:44.547Z",
                    "limit_window_seconds": 407_741,
                ],
            ],
        ])

        XCTAssertEqual(response.cursor.primaryWindow?.limitWindowSeconds, 2_678_400)
        XCTAssertEqual(response.cursor.quaternaryWindow?.usedPercent, 0)
        XCTAssertEqual(response.cursor.quaternaryWindow?.resetAt, "2026-08-31T10:37:44.547Z")
        XCTAssertEqual(response.cursor.quaternaryWindow?.limitWindowSeconds, 407_741)
    }

    func testCodexCreditWindowDecodesSpendControlFields() throws {
        let response = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "credit_window": [
                    "source": "group_based_spend_controls",
                    "used_percent": 0.13609159692128498,
                    "remaining_percent": 99.86390840307871,
                    "reset_at": 1_785_542_400,
                    "limit_credits": 37_500,
                    "used_credits": 51.03434884548187,
                    "remaining_credits": 37_448.96565115452,
                ],
            ],
        ])

        let credit = try XCTUnwrap(response.codex.creditWindow)
        XCTAssertEqual(credit.source, "group_based_spend_controls")
        XCTAssertEqual(credit.resetAt, 1_785_542_400)
        XCTAssertEqual(credit.limitCredits, 37_500)
        XCTAssertEqual(try XCTUnwrap(credit.usedCredits), 51.03434884548187, accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(credit.remainingCredits), 37_448.96565115452, accuracy: 1e-12)
        XCTAssertEqual(credit.usedPercent, 0.13609159692128498, accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(credit.remainingPercent), 99.86390840307871, accuracy: 1e-12)
    }

    func testCodexResetCreditsFullPayloadDecodesWhitelistedFields() throws {
        let response = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "reset_credits": [
                    "available_count": 2,
                    "total_earned_count": 5,
                    "private_note": "ignored",
                    "credits": [
                        [
                            "status": "available",
                            "reset_type": "weekly",
                            "granted_at": "2026-06-20T08:00:00.123456Z",
                            "expires_at": "2026-06-27T08:00:00.654321Z",
                            "internal_id": "ignored",
                        ],
                        [
                            "status": "expired",
                            "expires_at": "2026-06-19T08:00:00.000001Z",
                        ],
                    ],
                ],
            ],
        ])

        let resetCredits = try XCTUnwrap(response.codex.resetCredits)
        XCTAssertEqual(resetCredits.availableCount, 2)
        XCTAssertEqual(resetCredits.totalEarnedCount, 5)
        XCTAssertEqual(resetCredits.credits.count, 2)
        XCTAssertEqual(resetCredits.credits[0].status, "available")
        XCTAssertEqual(resetCredits.credits[0].resetType, "weekly")
        XCTAssertEqual(resetCredits.credits[0].grantedAt, "2026-06-20T08:00:00.123456Z")
        XCTAssertEqual(resetCredits.credits[0].expiresAt, "2026-06-27T08:00:00.654321Z")
        XCTAssertEqual(resetCredits.credits[1].status, "expired")
        XCTAssertNil(resetCredits.credits[1].resetType)
        XCTAssertNil(resetCredits.credits[1].grantedAt)
        XCTAssertEqual(resetCredits.credits[1].expiresAt, "2026-06-19T08:00:00.000001Z")
    }

    func testCodexResetCreditsCountOnlyPayloadDecodesWithEmptyCredits() throws {
        let response = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "reset_credits": [
                    "available_count": 1,
                    "total_earned_count": NSNull(),
                ],
            ],
        ])

        let resetCredits = try XCTUnwrap(response.codex.resetCredits)
        XCTAssertEqual(resetCredits.availableCount, 1)
        XCTAssertNil(resetCredits.totalEarnedCount)
        XCTAssertEqual(resetCredits.credits, [])
    }

    func testCodexResetCreditsZeroPayloadDecodesEmptyCredits() throws {
        let response = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "reset_credits": [
                    "available_count": 0,
                    "total_earned_count": 0,
                    "credits": [],
                ],
            ],
        ])

        let resetCredits = try XCTUnwrap(response.codex.resetCredits)
        XCTAssertEqual(resetCredits.availableCount, 0)
        XCTAssertEqual(resetCredits.totalEarnedCount, 0)
        XCTAssertEqual(resetCredits.credits, [])
    }

    func testCodexResetCreditsMicrosecondPayloadDecodesRawExpiry() throws {
        let response = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "reset_credits": [
                    "available_count": 1,
                    "credits": [
                        [
                            "status": "available",
                            "expires_at": "2026-07-12T02:13:21.590541Z",
                        ],
                    ],
                ],
            ],
        ])

        let resetCredits = try XCTUnwrap(response.codex.resetCredits)
        XCTAssertEqual(resetCredits.credits.count, 1)
        XCTAssertEqual(resetCredits.credits[0].expiresAt, "2026-07-12T02:13:21.590541Z")
    }

    // MARK: - Devin opt-in publication

    func testDevinSelectionOffRewritesRetainedRowsToUnconfigured() throws {
        let withDevin = try decodeResponse(overrides: [
            "devin": [
                "configured": true,
                "plan_label": "Pro",
                "primary_window": ["used_percent": 40, "reset_at": "2026-06-11T08:00:00Z"],
            ],
        ])

        let adjusted = withDevin.applyingDevinSelection(false)

        XCTAssertEqual(adjusted.devin, .unconfigured)
        XCTAssertFalse(adjusted.devin?.configured ?? true)
        XCTAssertNil(adjusted.devin?.primaryWindow)
        XCTAssertTrue(adjusted.hasAnyProviderWithoutError == false)
    }

    func testDevinSelectionOnKeepsFetchedRows() throws {
        let withDevin = try decodeResponse(overrides: [
            "devin": [
                "configured": true,
                "primary_window": ["used_percent": 40],
            ],
        ])

        XCTAssertEqual(withDevin.applyingDevinSelection(true), withDevin)
    }

    func testDevinSelectionOffIsIdentityWhenNothingToStrip() throws {
        let withoutDevin = try decodeResponse()

        XCTAssertEqual(withoutDevin.applyingDevinSelection(false), withoutDevin)
    }

    func testDevinReadingsDisappearFromResetDetectionWhenOff() throws {
        let withDevin = try decodeResponse(overrides: [
            "devin": [
                "configured": true,
                "primary_window": ["used_percent": 90, "reset_at": "2026-06-11T08:00:00Z"],
            ],
        ])

        XCTAssertTrue(withDevin.limitWindowReadings().contains { $0.provider == "devin" })
        let adjusted = withDevin.applyingDevinSelection(false)
        XCTAssertFalse(adjusted.limitWindowReadings().contains { $0.provider == "devin" })
    }

    // MARK: - Fixtures

    /// Builds a UsageLimitsResponse via JSON decoding (the same path production
    /// data takes). All required providers default to unconfigured; pass
    /// per-provider dictionaries to override or to add optional providers
    /// (kimi / grok / copilot).
    private func decodeResponse(overrides: [String: Any] = [:]) throws -> UsageLimitsResponse {
        var payload: [String: Any] = [
            "fetched_at": "2026-06-10T00:00:00Z",
            "claude": ["configured": false],
            "codex": ["configured": false],
            "cursor": ["configured": false],
            "gemini": ["configured": false],
            "kiro": ["configured": false],
            "antigravity": ["configured": false],
        ]
        for (key, value) in overrides { payload[key] = value }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(UsageLimitsResponse.self, from: data)
    }
}
