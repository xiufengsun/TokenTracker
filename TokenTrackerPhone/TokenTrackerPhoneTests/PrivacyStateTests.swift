import XCTest
@testable import TokenTracker

@MainActor
private final class UnavailableAuthentication: PhoneAuthenticationPolicy {
    var isAvailable = false
    var attempts = 0
    func authenticate() async -> Bool { attempts += 1; return true }
}

@MainActor
final class PrivacyStateTests: XCTestCase {
    func testUnavailableCannotEnableOrUnlockPersistedLock() async {
        let suite = "PrivacyStateTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let auth = UnavailableAuthentication()
        let prefs = PhonePreferences(defaults: defaults, authentication: auth)
        await prefs.setLockEnabled(true)
        XCTAssertFalse(prefs.requireBiometricUnlock)
        XCTAssertNotNil(prefs.authenticationError)
        defaults.set(true, forKey: "tt.phone.requireBiometricUnlock")
        let restored = PhonePreferences(defaults: defaults, authentication: auth)
        let unlocked = await restored.authenticateWithBiometrics()
        XCTAssertFalse(unlocked)
        XCTAssertTrue(restored.requireBiometricUnlock)
        XCTAssertNotNil(restored.authenticationError)
        XCTAssertEqual(auth.attempts, 0)
    }

    func testColdLaunchBackgroundAndAccountChangeRequireAuthentication() {
        XCTAssertTrue(PrivacyLockPolicy.isLocked(enabled: true, generation: 1, unlockedGeneration: nil))
        XCTAssertFalse(PrivacyLockPolicy.isLocked(enabled: true, generation: 1, unlockedGeneration: 1))
        XCTAssertTrue(PrivacyLockPolicy.isLocked(enabled: true, generation: 2, unlockedGeneration: 1))
        XCTAssertTrue(PrivacyLockPolicy.isLocked(enabled: true, generation: 1, unlockedGeneration: nil))
        XCTAssertFalse(PrivacyLockPolicy.isLocked(enabled: false, generation: 2, unlockedGeneration: nil))
    }

    func testDecimalEditorRoundTripsSmallAndFractionalTargets() {
        for value in [0.25, 0.001, 12.34567, 100.0] {
            XCTAssertEqual(Double(PhonePreferences.targetText(value)), value)
        }
    }

    func testLocalDSTDayDuration() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        for (month, day, hours) in [(3, 8, 23), (11, 1, 25), (3, 9, 24)] {
            let now = cal.date(from: DateComponents(year: 2026, month: month, day: day, hour: 0, minute: 30))!
            XCTAssertEqual(DayKey.dayDuration(now, calendar: cal), Double(hours * 3600))
        }
    }

    func testMissingPacingInputsAndComputerScopeAreNotAccountZero() {
        var snapshot = PhoneWorkspaceSnapshot(horizon: .month, selectedDeviceId: nil, now: Date(timeIntervalSince1970: 0),
            periodSummary: .init(), todaySummary: .init(), daily30d: .init(), todayHourly: .init(),
            yesterdayHourly: .init(), weeklyBreakdown: .init(), monthlyBreakdown: .init())
        XCTAssertTrue(snapshot.pacingAvailable)
        XCTAssertTrue(snapshot.accountTargetsAvailable)
        snapshot.selectedDeviceId = "computer-A"
        XCTAssertFalse(snapshot.accountTargetsAvailable)
        let complete = snapshot
        snapshot.todaySummary = nil
        XCTAssertFalse(snapshot.pacingAvailable)
        snapshot = complete; snapshot.yesterdayHourly = nil
        XCTAssertFalse(snapshot.pacingAvailable)
        snapshot = complete; snapshot.weeklyBreakdown = nil
        XCTAssertFalse(snapshot.pacingAvailable)
        XCTAssertTrue(snapshot.providerPacingProfiles(budgets: ["claude": .init(source: "claude", weeklyBudgetUsd: 100)]).isEmpty)
        snapshot = complete; snapshot.monthlyBreakdown = nil
        XCTAssertFalse(snapshot.pacingAvailable)
    }
}
