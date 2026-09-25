import XCTest

final class WeeklyLimitResetDetectorTests: XCTestCase {

    private let detector = WeeklyLimitResetDetector()   // defaults: drop 5, tolerance 60, cooldown 3600

    private func reading(_ pct: Double, resetAt: Double?) -> [(provider: String, windowKey: String, windowLabel: String, usedPercent: Double, resetAt: Double?)] {
        [("codex", "codex.primary", "5h", pct, resetAt)]
    }

    func testFirstObservationRecordsBaselineWithoutEvent() {
        let (events, snap) = detector.evaluate(readings: reading(90, resetAt: 5000), snapshot: .init(), now: 1000)
        XCTAssertTrue(events.isEmpty, "first observation should never celebrate")
        XCTAssertEqual(snap.lastPercent["codex.primary"], 90)
        XCTAssertEqual(snap.lastResetAt["codex.primary"], 5000)
    }

    func testHighThenResetFires() {
        // High usage, then the window rolls over: reset_at jumps to a new period and usage empties.
        let (_, baseline) = detector.evaluate(readings: reading(90, resetAt: 5000), snapshot: .init(), now: 1000)
        let (events, _) = detector.evaluate(readings: reading(4, resetAt: 9000), snapshot: baseline, now: 2000)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.provider, "codex")
        XCTAssertEqual(events.first?.windowLabel, "5h")
        XCTAssertEqual(events.first?.previousPercent, 90)
    }

    func testModerateUsageResetFires() {
        // No "used enough" gate: a window used to only 20% still celebrates when it
        // genuinely rolls over (reset_at advances + usage empties).
        let (_, baseline) = detector.evaluate(readings: reading(20, resetAt: 5000), snapshot: .init(), now: 1000)
        let (events, _) = detector.evaluate(readings: reading(0, resetAt: 9000), snapshot: baseline, now: 2000)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.previousPercent, 20)
    }

    func testNegligibleDropDoesNotFire() {
        // reset_at advanced, but usage barely moved (4 → 1): below the minDrop floor,
        // so it's treated as noise rather than a real empty-out and stays quiet.
        let (_, baseline) = detector.evaluate(readings: reading(4, resetAt: 5000), snapshot: .init(), now: 1000)
        let (events, _) = detector.evaluate(readings: reading(1, resetAt: 9000), snapshot: baseline, now: 2000)
        XCTAssertTrue(events.isEmpty)
    }

    func testPercentDropWithoutResetAdvanceDoesNotFire() {
        // Regression for the reported bug: on cold launch the percent reads lower than
        // last time, but the window's reset_at has NOT advanced (still "4h from now").
        // That is not a reset and must not celebrate.
        let (_, baseline) = detector.evaluate(readings: reading(80, resetAt: 5000), snapshot: .init(), now: 1000)
        let (events, _) = detector.evaluate(readings: reading(30, resetAt: 5000), snapshot: baseline, now: 2000)
        XCTAssertTrue(events.isEmpty, "a percent drop without a reset_at rollover must not celebrate")
    }

    func testMissingResetTimeDoesNotFire() {
        // Windows without a reset timestamp can't be judged reliably → never celebrate.
        let (_, baseline) = detector.evaluate(readings: reading(90, resetAt: nil), snapshot: .init(), now: 1000)
        let (events, _) = detector.evaluate(readings: reading(4, resetAt: nil), snapshot: baseline, now: 2000)
        XCTAssertTrue(events.isEmpty)
    }

    func testIdleReadingWithoutResetTimeKeepsBaseline() {
        // Claude 5h after rollover with no active session reports 0% and no reset_at.
        // That reading must not overwrite the baseline, otherwise the next real reading
        // (new reset_at, low usage) sees prevPercent == 0 and never celebrates.
        let (_, baseline) = detector.evaluate(readings: reading(60, resetAt: 5000), snapshot: .init(), now: 1000)
        let (idleEvents, idle) = detector.evaluate(readings: reading(0, resetAt: nil), snapshot: baseline, now: 1500)
        XCTAssertTrue(idleEvents.isEmpty)
        XCTAssertEqual(idle.lastPercent["codex.primary"], 60, "nil reset_at must not clobber the percent baseline")

        let (events, _) = detector.evaluate(readings: reading(3, resetAt: 9000), snapshot: idle, now: 2000)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.previousPercent, 60)
    }

    func testSlidingResetWithoutUsageDropDoesNotFire() {
        // Kiro-style: reset_at slides forward every poll, but usage stayed high.
        // The minDrop guard prevents a false celebration.
        let (_, baseline) = detector.evaluate(readings: reading(80, resetAt: 5000), snapshot: .init(), now: 1000)
        let (events, _) = detector.evaluate(readings: reading(82, resetAt: 5300), snapshot: baseline, now: 1300)
        XCTAssertTrue(events.isEmpty, "advancing reset_at without a usage drop must not celebrate")
    }

    func testCooldownSuppressesRepeat() {
        let (_, baseline) = detector.evaluate(readings: reading(90, resetAt: 5000), snapshot: .init(), now: 1000)
        let (firstEvents, afterFirst) = detector.evaluate(readings: reading(2, resetAt: 9000), snapshot: baseline, now: 2000)
        XCTAssertEqual(firstEvents.count, 1)

        // Climb high again within the same window (reset_at unchanged), then roll over
        // again within the cooldown window → suppressed.
        let (_, climbed) = detector.evaluate(readings: reading(95, resetAt: 9000), snapshot: afterFirst, now: 2500)
        let (repeatEvents, _) = detector.evaluate(readings: reading(1, resetAt: 13000), snapshot: climbed, now: 3000)
        XCTAssertTrue(repeatEvents.isEmpty, "within cooldown the same window must not re-fire")
    }

    func testLegacySnapshotWithoutResetFieldDecodes() throws {
        // Snapshots persisted before `lastResetAt` existed must still decode and keep
        // their percent + cooldown memory instead of being discarded on upgrade.
        let legacy = """
        { "lastPercent": { "codex.primary": 70 }, "lastEventAt": { "codex.primary": 1000 } }
        """
        let snap = try JSONDecoder().decode(WeeklyLimitResetDetector.Snapshot.self, from: Data(legacy.utf8))
        XCTAssertEqual(snap.lastPercent["codex.primary"], 70)
        XCTAssertEqual(snap.lastEventAt["codex.primary"], 1000)
        XCTAssertTrue(snap.lastResetAt.isEmpty)
    }

    func testReadingsExtractionFromResponse() throws {
        // Minimal response: Codex at 80% primary, Claude errored (must be skipped).
        let json = """
        {
          "fetched_at": "2026-06-14T00:00:00Z",
          "claude": { "configured": true, "error": "boom" },
          "codex": { "configured": true, "error": null, "primary_window": { "used_percent": 80, "reset_at": 1000, "limit_window_seconds": 18000 } },
          "cursor": { "configured": false, "error": null },
          "gemini": { "configured": false, "error": null },
          "kiro": { "configured": false, "error": null },
          "antigravity": { "configured": false, "error": null }
        }
        """
        let response = try JSONDecoder().decode(UsageLimitsResponse.self, from: Data(json.utf8))
        let readings = response.limitWindowReadings()
        XCTAssertEqual(readings.count, 1)
        XCTAssertEqual(readings.first?.windowKey, "codex.primary")
        XCTAssertEqual(readings.first?.windowLabel, "5h")
        XCTAssertEqual(readings.first?.usedPercent, 80)
        XCTAssertEqual(readings.first?.resetAt, 1000)
    }

    func testReadingsIncludeZCodeAndOpenCodeGoWindows() throws {
        let json = """
        {
          "fetched_at": "2026-07-22T00:00:00Z",
          "claude": { "configured": false, "error": null },
          "codex": { "configured": false, "error": null },
          "cursor": { "configured": false, "error": null },
          "gemini": { "configured": false, "error": null },
          "kiro": { "configured": false, "error": null },
          "antigravity": { "configured": false, "error": null },
          "zcode": {
            "configured": true,
            "error": null,
            "plan_kind": "coding-plan",
            "primary_window": { "used_percent": 24, "reset_at": "2026-07-22T05:00:00Z" },
            "secondary_window": { "used_percent": 35, "reset_at": "2026-07-29T00:00:00Z" },
            "tertiary_window": { "used_percent": 9, "reset_at": "2026-07-23T00:00:00Z" }
          },
          "opencodeGo": {
            "configured": true,
            "error": null,
            "primary_window": { "used_percent": 10, "reset_at": "2026-07-22T05:00:00Z" },
            "secondary_window": { "used_percent": 20, "reset_at": "2026-07-29T00:00:00Z" },
            "tertiary_window": { "used_percent": 30, "reset_at": "2026-08-22T00:00:00Z" }
          },
          "commandCode": {
            "configured": true,
            "error": null,
            "plan_label": "GOAT",
            "subscription_status": "active",
            "primary_window": { "used_percent": 15, "reset_at": "2026-07-22T05:00:00Z" },
            "secondary_window": { "used_percent": 25, "reset_at": "2026-07-29T00:00:00Z" }
          }
        }
        """
        let response = try JSONDecoder().decode(UsageLimitsResponse.self, from: Data(json.utf8))
        let readings = response.limitWindowReadings()

        XCTAssertEqual(
            readings.map { "\($0.provider).\($0.windowLabel)" },
            [
                "zcode.5h", "zcode.Weekly", "zcode.Tools",
                "opencodeGo.5h", "opencodeGo.Weekly", "opencodeGo.Monthly",
                "commandCode.5h", "commandCode.Weekly",
            ]
        )
    }

    func testZCodeStartPlanReadingsUseLabelledBuckets() throws {
        let json = """
        {
          "fetched_at": "2026-09-25T00:00:00Z",
          "claude": { "configured": false },
          "codex": { "configured": false },
          "cursor": { "configured": false },
          "gemini": { "configured": false },
          "kiro": { "configured": false },
          "antigravity": { "configured": false },
          "zcode": {
            "configured": true,
            "error": null,
            "plan_kind": "start-plan",
            "primary_window": { "used_percent": 100, "reset_at": "2026-09-25T16:00:00Z" },
            "secondary_window": { "used_percent": 20, "reset_at": "2026-09-25T16:00:00Z" },
            "buckets": [
              { "label": "GLM-5.3", "entitlement_id": "ent_glm_5p3", "window": { "used_percent": 100, "reset_at": "2026-09-25T16:00:00Z" } },
              { "label": "GLM-5.3-Flash", "entitlement_id": "ent_glm_5p3f", "window": { "used_percent": 20, "reset_at": "2026-09-25T16:00:00Z" } },
              { "label": "GLM-5.3-Flash · ZCode Weekend Build", "entitlement_id": "ent-wk-1", "window": { "used_percent": 1, "reset_at": "2026-09-28T01:00:00Z" } }
            ]
          }
        }
        """
        let response = try JSONDecoder().decode(UsageLimitsResponse.self, from: Data(json.utf8))
        let readings = response.limitWindowReadings()

        XCTAssertEqual(
            readings.map { "\($0.windowKey)|\($0.windowLabel)" },
            [
                "zcode.bucket.ent_glm_5p3|GLM-5.3",
                "zcode.bucket.ent_glm_5p3f|GLM-5.3-Flash",
                "zcode.bucket.ent-wk-1|GLM-5.3-Flash · ZCode Weekend Build",
            ]
        )
    }

    func testZCodeStartPlanReadingsKeepFixedLabelsWithoutBuckets() throws {
        let json = """
        {
          "fetched_at": "2026-09-25T00:00:00Z",
          "claude": { "configured": false },
          "codex": { "configured": false },
          "cursor": { "configured": false },
          "gemini": { "configured": false },
          "kiro": { "configured": false },
          "antigravity": { "configured": false },
          "zcode": {
            "configured": true,
            "plan_kind": "start-plan",
            "primary_window": { "used_percent": 10, "reset_at": "2026-09-25T16:00:00Z" },
            "secondary_window": { "used_percent": 20, "reset_at": "2026-09-25T16:00:00Z" }
          }
        }
        """
        let response = try JSONDecoder().decode(UsageLimitsResponse.self, from: Data(json.utf8))

        XCTAssertEqual(response.limitWindowReadings().map(\.windowLabel), ["GLM-5.2", "GLM-5-Turbo"])
    }

    func testArkPlansDecodeAndKeepIndependentResetWindows() throws {
        let json = """
        {
          "fetched_at": "2026-09-05T00:00:00Z",
          "claude": { "configured": false },
          "codex": { "configured": false },
          "cursor": { "configured": false },
          "gemini": { "configured": false },
          "kiro": { "configured": false },
          "antigravity": { "configured": false },
          "codingPlan": {
            "configured": true, "plan_label": "Lite",
            "primary_window": { "used_percent": 10, "reset_at": "2026-09-05T05:00:00Z" }
          },
          "agentPlan": {
            "configured": true, "plan_label": "Medium",
            "primary_window": { "used_percent": 25, "reset_at": "2026-09-05T05:00:00Z" },
            "secondary_window": { "used_percent": 40, "reset_at": "2026-09-07T00:00:00Z" },
            "tertiary_window": { "used_percent": 60, "reset_at": "2026-10-01T00:00:00Z" }
          }
        }
        """
        let response = try JSONDecoder().decode(UsageLimitsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.codingPlan?.planLabel, "Lite")
        XCTAssertEqual(response.agentPlan?.planLabel, "Medium")
        let readings = response.limitWindowReadings()
        XCTAssertEqual(readings.map { $0.windowKey }, [
            "codingPlan.primary", "agentPlan.primary", "agentPlan.secondary", "agentPlan.tertiary"
        ])
        XCTAssertEqual(readings.map { $0.usedPercent }, [10, 25, 40, 60])
        XCTAssertEqual(LimitResetProviderIconCatalog.svgFilename(for: "agentPlan"), "volcano-ark.svg")
    }

    func testReadingsUsePlanAndBonusLabelsForQoderAndQoderCn() throws {
        // The menu-bar panel renders these windows as "Plan" / "Bonus"
        // (Strings.qoderPlanLabel / qoderBonusLabel); the reset detector must
        // use the same labels so notification copy matches the UI.
        let json = """
        {
          "fetched_at": "2026-08-14T00:00:00Z",
          "claude": { "configured": false, "error": null },
          "codex": { "configured": false, "error": null },
          "cursor": { "configured": false, "error": null },
          "gemini": { "configured": false, "error": null },
          "kiro": { "configured": false, "error": null },
          "antigravity": { "configured": false, "error": null },
          "qoder": {
            "configured": true,
            "error": null,
            "primary_window": { "used_percent": 12, "reset_at": "2026-08-14T05:00:00Z" },
            "secondary_window": { "used_percent": 3, "reset_at": "2026-08-20T00:00:00Z" }
          },
          "qoderCn": {
            "configured": true,
            "error": null,
            "primary_window": { "used_percent": 40, "reset_at": "2026-08-14T05:00:00Z" },
            "secondary_window": { "used_percent": 8, "reset_at": "2026-08-20T00:00:00Z" }
          }
        }
        """
        let response = try JSONDecoder().decode(UsageLimitsResponse.self, from: Data(json.utf8))
        let readings = response.limitWindowReadings()

        XCTAssertEqual(
            readings.map { $0.windowKey },
            ["qoder.primary", "qoder.secondary", "qoderCn.primary", "qoderCn.secondary"]
        )
        XCTAssertEqual(
            readings.map { "\($0.provider).\($0.windowLabel)" },
            ["qoder.Plan", "qoder.Bonus", "qoderCn.Plan", "qoderCn.Bonus"]
        )
    }

    func testDevinDecodesOptionalWindowsAndEmitsReadings() throws {
        // Devin windows are optional: a weekly-only plan must not fabricate a
        // daily reading, and a hidden/absent window must never fire.
        let json = """
        {
          "fetched_at": "2026-09-12T00:00:00Z",
          "claude": { "configured": false },
          "codex": { "configured": false },
          "cursor": { "configured": false },
          "gemini": { "configured": false },
          "kiro": { "configured": false },
          "antigravity": { "configured": false },
          "devin": {
            "configured": true,
            "error": null,
            "plan_label": "Pro",
            "primary_window": { "used_percent": 40, "reset_at": "2026-09-13T08:00:00Z", "limit_window_seconds": 86400 },
            "secondary_window": { "used_percent": 90, "reset_at": "2026-09-20T08:00:00Z", "limit_window_seconds": 604800 }
          }
        }
        """
        let response = try JSONDecoder().decode(UsageLimitsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.devin?.planLabel, "Pro")
        XCTAssertEqual(response.devin?.primaryWindow?.limitWindowSeconds, 86400)

        let readings = response.limitWindowReadings()
        XCTAssertEqual(readings.map { $0.windowKey }, ["devin.primary", "devin.secondary"])
        XCTAssertEqual(readings.map { $0.windowLabel }, ["Daily", "Weekly"])
        XCTAssertEqual(readings.map { $0.usedPercent }, [40, 90])
        XCTAssertEqual(LimitResetProviderIconCatalog.svgFilename(for: "devin"), "devin.svg")
    }

    func testDevinWeeklyOnlyPlanSkipsAbsentDailyWindow() throws {
        let json = """
        {
          "fetched_at": "2026-09-12T00:00:00Z",
          "claude": { "configured": false },
          "codex": { "configured": false },
          "cursor": { "configured": false },
          "gemini": { "configured": false },
          "kiro": { "configured": false },
          "antigravity": { "configured": false },
          "devin": {
            "configured": true,
            "error": null,
            "primary_window": null,
            "secondary_window": { "used_percent": 25, "reset_at": "2026-09-20T08:00:00Z" }
          }
        }
        """
        let response = try JSONDecoder().decode(UsageLimitsResponse.self, from: Data(json.utf8))
        XCTAssertNil(response.devin?.primaryWindow ?? nil)
        let readings = response.limitWindowReadings()
        XCTAssertEqual(readings.map { $0.windowKey }, ["devin.secondary"])
    }

    func testCelebrationProviderIconMappingsCoverAssetAndSVGProviders() {
        XCTAssertEqual(LimitResetProviderIconCatalog.assetName(for: "claude"), "ClaudeLogo")
        XCTAssertEqual(LimitResetProviderIconCatalog.assetName(for: "antigravity"), "AntigravityLogo")
        XCTAssertEqual(LimitResetProviderIconCatalog.svgFilename(for: "cursor"), "cursor.svg")
        XCTAssertNil(LimitResetProviderIconCatalog.assetName(for: "cursor"))
        XCTAssertEqual(LimitResetProviderIconCatalog.svgFilename(for: "kimi"), "kimi.svg")
        XCTAssertEqual(LimitResetProviderIconCatalog.svgFilename(for: "opencodeGo"), "opencode.svg")
        XCTAssertEqual(LimitResetProviderIconCatalog.svgFilename(for: "qoder"), "qoder.svg")
        XCTAssertNil(LimitResetProviderIconCatalog.assetName(for: "unknown"))
        XCTAssertNil(LimitResetProviderIconCatalog.svgFilename(for: "unknown"))
    }

    func testToastAndConfettiPreferencesAreIndependentAndDefaultOn() {
        let suiteName = "WeeklyLimitResetDetectorTests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            return XCTFail("Could not create isolated UserDefaults suite")
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertTrue(WeeklyLimitResetDetector.toastEnabled(defaults))
        XCTAssertTrue(WeeklyLimitResetDetector.confettiEnabled(defaults))

        defaults.set(false, forKey: WeeklyLimitResetDetector.confettiEnabledKey)
        XCTAssertTrue(WeeklyLimitResetDetector.toastEnabled(defaults))
        XCTAssertFalse(WeeklyLimitResetDetector.confettiEnabled(defaults))

        defaults.set(false, forKey: WeeklyLimitResetDetector.toastEnabledKey)
        defaults.set(true, forKey: WeeklyLimitResetDetector.confettiEnabledKey)
        XCTAssertFalse(WeeklyLimitResetDetector.toastEnabled(defaults))
        XCTAssertTrue(WeeklyLimitResetDetector.confettiEnabled(defaults))
    }
}
