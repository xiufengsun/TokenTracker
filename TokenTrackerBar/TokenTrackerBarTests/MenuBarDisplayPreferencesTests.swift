import XCTest

final class MenuBarDisplayPreferencesTests: XCTestCase {

    func testNoneCanOccupyEitherOrBothSlots() {
        XCTAssertEqual(
            MenuBarDisplayPreferences.normalize([
                MenuBarDisplayPreferences.noneID,
                MenuBarDisplayMetric.codex5h.rawValue,
            ]),
            [MenuBarDisplayPreferences.noneID, MenuBarDisplayMetric.codex5h.rawValue]
        )
        XCTAssertEqual(
            MenuBarDisplayPreferences.normalize([
                MenuBarDisplayPreferences.noneID,
                MenuBarDisplayPreferences.noneID,
            ]),
            [MenuBarDisplayPreferences.noneID, MenuBarDisplayPreferences.noneID]
        )
    }

    func testSingleNoneSlotIsPaddedWithARealDefault() {
        XCTAssertEqual(
            MenuBarDisplayPreferences.normalize([MenuBarDisplayPreferences.noneID]),
            [MenuBarDisplayPreferences.noneID, MenuBarDisplayMetric.todayTokens.rawValue]
        )
    }

    func testAvailablePayloadAlwaysStartsWithLocalizedNoneEntry() {
        let payload = MenuBarDisplayPreferences.availableItemsPayload()

        XCTAssertEqual(payload.first?["id"], MenuBarDisplayPreferences.noneID)
        XCTAssertEqual(payload.first?["category"], "none")
        XCTAssertFalse(payload.first?["label"]?.isEmpty ?? true)
    }

    func testSurfacePolicyNeverHidesIconWithoutIsland() {
        XCTAssertTrue(
            MenuBarSurfacePolicy.isIconVisible(hideRequested: true, islandEnabled: false)
        )
        XCTAssertFalse(
            MenuBarSurfacePolicy.isIconVisible(hideRequested: true, islandEnabled: true)
        )
        XCTAssertTrue(
            MenuBarSurfacePolicy.isIconVisible(hideRequested: false, islandEnabled: true)
        )
    }

    func testHideIconPromptOnlyAppearsForAVisibleIconAfterIslandEnable() {
        XCTAssertTrue(
            MenuBarSurfacePolicy.shouldOfferHidePrompt(
                promptShown: false,
                hideRequested: false,
                islandEnabled: true
            )
        )
        XCTAssertFalse(
            MenuBarSurfacePolicy.shouldOfferHidePrompt(
                promptShown: true,
                hideRequested: false,
                islandEnabled: true
            )
        )
        XCTAssertFalse(
            MenuBarSurfacePolicy.shouldOfferHidePrompt(
                promptShown: false,
                hideRequested: true,
                islandEnabled: true
            )
        )
        XCTAssertFalse(
            MenuBarSurfacePolicy.shouldOfferHidePrompt(
                promptShown: false,
                hideRequested: false,
                islandEnabled: false
            )
        )
    }

    func testHiddenProviderExcludedEvenWhenSelected() {
        let ids = MenuBarDisplayPreferences.availableItemIDs(
            keepingSelected: [MenuBarDisplayMetric.claude5h.rawValue],
            hiddenProviders: ["claude"]
        )

        XCTAssertFalse(ids.contains(MenuBarDisplayMetric.claude5h.rawValue))
        XCTAssertFalse(ids.contains(MenuBarDisplayMetric.claude7d.rawValue))
    }

    func testHiddenProviderDoesNotAffectTokenCostMetrics() {
        let ids = MenuBarDisplayPreferences.availableItemIDs(
            hiddenProviders: Set(LimitsSettingsStore.allProviders)
        )

        XCTAssertEqual(ids, [
            MenuBarDisplayMetric.todayTokens.rawValue,
            MenuBarDisplayMetric.todayCost.rawValue,
            MenuBarDisplayMetric.last7dTokens.rawValue,
            MenuBarDisplayMetric.totalTokens.rawValue,
            MenuBarDisplayMetric.totalCost.rawValue,
        ])
    }

    func testHiddenProviderOnlyRemovesItsOwnMetrics() {
        let withoutHidden = MenuBarDisplayPreferences.availableItemIDs(
            keepingSelected: [
                MenuBarDisplayMetric.claude5h.rawValue,
                MenuBarDisplayMetric.codex5h.rawValue,
            ]
        )
        let withHidden = MenuBarDisplayPreferences.availableItemIDs(
            keepingSelected: [
                MenuBarDisplayMetric.claude5h.rawValue,
                MenuBarDisplayMetric.codex5h.rawValue,
            ],
            hiddenProviders: ["claude"]
        )

        XCTAssertTrue(withoutHidden.contains(MenuBarDisplayMetric.claude5h.rawValue))
        XCTAssertEqual(
            withHidden,
            withoutHidden.filter { MenuBarDisplayMetric(rawValue: $0)?.providerKey != "claude" }
        )
        XCTAssertTrue(withHidden.contains(MenuBarDisplayMetric.codex5h.rawValue))
    }

    func testDefaultKeepsSelectedMetricWhileLimitsUnknown() {
        let ids = MenuBarDisplayPreferences.availableItemIDs(
            keepingSelected: [MenuBarDisplayMetric.claude5h.rawValue]
        )

        XCTAssertTrue(ids.contains(MenuBarDisplayMetric.claude5h.rawValue))
    }

    func testCodexCreditMetricAppearsWhenCreditWindowExists() throws {
        let limits = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "credit_window": [
                    "used_percent": 0.14,
                    "limit_credits": 37_500,
                    "used_credits": 51.03,
                    "remaining_credits": 37_448.97,
                    "reset_at": 1_785_542_400,
                ],
            ],
        ])

        let ids = MenuBarDisplayPreferences.availableItemIDs(for: limits)

        XCTAssertTrue(ids.contains(MenuBarDisplayMetric.codexCredits.rawValue))
        XCTAssertFalse(ids.contains(MenuBarDisplayMetric.codex5h.rawValue))
        XCTAssertFalse(ids.contains(MenuBarDisplayMetric.codex7d.rawValue))
    }

    func testAntigravityArgonMetricRequiresItsOwnWindow() throws {
        let missing = try decodeResponse(overrides: ["antigravity": ["configured": true]])
        XCTAssertFalse(MenuBarDisplayPreferences.availableItemIDs(for: missing).contains(MenuBarDisplayMetric.antigravityArgonWeekly.rawValue))
        let present = try decodeResponse(overrides: ["antigravity": [
            "configured": true,
            "argon_weekly_window": ["used_percent": 34, "reset_at": "2030-01-01T00:00:00Z"],
        ]])
        XCTAssertTrue(MenuBarDisplayPreferences.availableItemIDs(for: present).contains(MenuBarDisplayMetric.antigravityArgonWeekly.rawValue))
        XCTAssertEqual(present.utilizationPercent(for: .antigravityArgonWeekly), 34)
        let reading = present.limitWindowReadings().first { $0.windowKey == "antigravity.argonWeekly" }
        XCTAssertEqual(reading?.windowLabel, "Argon 7d")
        XCTAssertEqual(reading?.usedPercent, 34)
        XCTAssertNotNil(reading?.resetAt)
    }

    func testDevinMetricsAppearOnlyForPresentWindows() throws {
        let limits = try decodeResponse(overrides: [
            "devin": [
                "configured": true,
                "primary_window": ["used_percent": 40, "reset_at": "2026-09-13T08:00:00Z", "limit_window_seconds": 86_400],
                "secondary_window": ["used_percent": 90, "reset_at": "2026-09-20T08:00:00Z", "limit_window_seconds": 604_800],
            ],
        ])

        let ids = MenuBarDisplayPreferences.availableItemIDs(for: limits)

        XCTAssertTrue(ids.contains(MenuBarDisplayMetric.devinDaily.rawValue))
        XCTAssertTrue(ids.contains(MenuBarDisplayMetric.devinWeekly.rawValue))
    }

    func testDevinDailyMetricHiddenWhenDailyWindowAbsent() throws {
        // A weekly-only plan reports primary_window: null — the menu-bar slot
        // for a missing window must not be selectable.
        let limits = try decodeResponse(overrides: [
            "devin": [
                "configured": true,
                "secondary_window": ["used_percent": 90, "reset_at": "2026-09-20T08:00:00Z"],
            ],
        ])

        let ids = MenuBarDisplayPreferences.availableItemIDs(for: limits)

        XCTAssertFalse(ids.contains(MenuBarDisplayMetric.devinDaily.rawValue))
        XCTAssertTrue(ids.contains(MenuBarDisplayMetric.devinWeekly.rawValue))
    }

    /// Every limit metric's providerKey must be a known LimitsSettingsStore
    /// provider id, or visibility filtering silently never matches it.
    func testProviderKeysMatchLimitsSettingsStoreProviders() {
        let known = Set(LimitsSettingsStore.allProviders)
        for metric in MenuBarDisplayMetric.allCases {
            guard let provider = metric.providerKey else { continue }
            XCTAssertTrue(
                known.contains(provider),
                "providerKey \(provider) for \(metric.rawValue) missing from LimitsSettingsStore.allProviders"
            )
        }
    }

    func testDefaultMetricsNeedOnlyTodaySummary() {
        XCTAssertEqual(
            MenuBarDisplayPreferences.summarySelection(for: MenuBarDisplayPreferences.defaultIDs),
            [.today]
        )
    }

    func testSummarySelectionCoalescesMetricsByEndpoint() {
        let selection = MenuBarDisplayPreferences.summarySelection(for: [
            MenuBarDisplayMetric.todayTokens.rawValue,
            MenuBarDisplayMetric.todayCost.rawValue,
            MenuBarDisplayMetric.last7dTokens.rawValue,
            MenuBarDisplayMetric.totalCost.rawValue,
        ])

        XCTAssertEqual(selection, [.today, .rolling, .total])
    }

    func testLimitOnlyMetricsNeedNoUsageSummary() {
        XCTAssertTrue(
            MenuBarDisplayPreferences.summarySelection(for: [
                MenuBarDisplayMetric.codex5h.rawValue,
                MenuBarDisplayMetric.codex7d.rawValue,
            ]).isEmpty
        )
    }

    func testNoneSlotsNeedNoUsageSummary() {
        XCTAssertTrue(
            MenuBarDisplayPreferences.summarySelection(for: [
                MenuBarDisplayPreferences.noneID,
                MenuBarDisplayPreferences.noneID,
            ]).isEmpty
        )
    }

    private func decodeResponse(overrides: [String: Any] = [:]) throws -> UsageLimitsResponse {
        var payload: [String: Any] = [
            "fetched_at": "2026-07-01T00:00:00Z",
            "claude": ["configured": false],
            "codex": ["configured": false],
            "cursor": ["configured": false],
            "gemini": ["configured": false],
            "kiro": ["configured": false],
            "antigravity": ["configured": false],
        ]
        for (key, value) in overrides {
            payload[key] = value
        }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(UsageLimitsResponse.self, from: data)
    }
}
