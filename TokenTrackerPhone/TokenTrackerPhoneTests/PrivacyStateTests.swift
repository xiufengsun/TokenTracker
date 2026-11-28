import XCTest
import SwiftUI
import UIKit
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

@MainActor
private final class HeldAuthentication: PhoneAuthenticationPolicy {
    var isAvailable = true
    var started: (() -> Void)?
    var pending: [Int: CheckedContinuation<Bool, Never>] = [:]
    private var next = 0
    func authenticate() async -> Bool {
        let id = next; next += 1
        return await withCheckedContinuation { continuation in
            pending[id] = continuation
            started?()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.finish(id, false) }
        }
    }
    func finish(_ id: Int, _ result: Bool) { pending.removeValue(forKey: id)?.resume(returning: result) }
}

extension PrivacyStateTests {
    func testNewerLockIntentOwnsSettingAndError() async {
        for oldResult in [true, false] {
            let suite = "PrivacyOrdering.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            let auth = HeldAuthentication()
            let prefs = PhonePreferences(defaults: defaults, authentication: auth)
            let oldStarted = expectation(description: "old auth")
            auth.started = { oldStarted.fulfill() }
            let old = Task { await prefs.setLockEnabled(true) }
            await fulfillment(of: [oldStarted], timeout: 3)
            let newStarted = expectation(description: "new auth")
            auth.started = { newStarted.fulfill() }
            let newer = Task { await prefs.setLockEnabled(false) }
            await fulfillment(of: [newStarted], timeout: 3)
            auth.finish(1, true); await newer.value
            auth.finish(0, oldResult); await old.value
            XCTAssertFalse(prefs.requireBiometricUnlock)
            XCTAssertNil(prefs.authenticationError)
        }
    }

    func testMaskSuppressesSpendComparisonBadge() {
        let suite = "PrivacyMask.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let prefs = PhonePreferences(defaults: defaults, authentication: UnavailableAuthentication())
        prefs.discreteAmounts = false; XCTAssertTrue(prefs.showsSpendComparisons)
        prefs.discreteAmounts = true; XCTAssertFalse(prefs.showsSpendComparisons)
    }

    func testStaleDismissalCannotRevealBeforeMatchingContent() {
        let coordinator = PresentationPrivacyGuard<EmptyView>.Coordinator()
        coordinator.generation = 2
        coordinator.pendingGeneration = 2
        coordinator.renderedGeneration = 1
        coordinator.completeDismissal(for: 1)
        XCTAssertTrue(coordinator.transitioning)
        coordinator.completeDismissal(for: 2)
        XCTAssertTrue(coordinator.transitioning)
        coordinator.renderedGeneration = 2
        XCTAssertFalse(coordinator.transitioning)
        coordinator.pendingGeneration = 3
        coordinator.generation = 3
        coordinator.completeDismissal(for: 2)
        XCTAssertTrue(coordinator.transitioning)
    }

    func testCoverOwnsKeyboardAndAccessibilityAndRestoresPriorState() throws {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
            throw XCTSkip("App host has no window scene")
        }
        let originalKey = scene.windows.first(where: \.isKeyWindow)
        let source = UIWindow(windowScene: scene)
        let controller = UIViewController()
        source.rootViewController = controller
        source.makeKeyAndVisible()
        let field = UITextField(frame: CGRect(x: 20, y: 40, width: 160, height: 40))
        controller.view.addSubview(field)
        XCTAssertTrue(field.becomeFirstResponder())
        let other = UIWindow(windowScene: scene)
        other.rootViewController = UIViewController()
        other.windowLevel = .alert + 10
        other.accessibilityElementsHidden = true
        other.isHidden = false
        let coordinator = PresentationPrivacyGuard<EmptyView>.Coordinator()
        defer {
            coordinator.hideCover(); source.isHidden = true; other.isHidden = true
            originalKey?.makeKey()
        }
        coordinator.desired = true
        coordinator.attach(source)
        XCTAssertTrue(coordinator.cover?.isKeyWindow == true)
        XCTAssertFalse(field.isFirstResponder)
        XCTAssertTrue(source.accessibilityElementsHidden)
        XCTAssertTrue(coordinator.host.view.accessibilityViewIsModal)
        XCTAssertGreaterThan(coordinator.cover!.windowLevel.rawValue, other.windowLevel.rawValue)
        coordinator.desired = false
        coordinator.updateVisibility()
        XCTAssertFalse(source.accessibilityElementsHidden)
        XCTAssertTrue(other.accessibilityElementsHidden)
        XCTAssertTrue(source.isKeyWindow)
    }
}

#if DEBUG
extension PrivacyStateTests {
    func testScenarioSignOutReleasesCoverOnlyAfterCurrentContentReset() async {
        let scenario = SimulatorLaunchScenario.settings
        let sessions = SessionStore(restore: false, initialSession: scenario.initialSession)
        let model = WorkspaceModel(sessions: sessions, client: ScenarioCloudClient(scenario: scenario), nowProvider: { scenario.fixedNow })
        await model.refresh()
        let coordinator = PresentationPrivacyGuard<EmptyView>.Coordinator()
        coordinator.observe(sessions)
        sessions.signOutLocally()
        XCTAssertTrue(coordinator.transitioning)
        model.reset()
        coordinator.renderedGeneration = model.contentGeneration
        coordinator.completeDismissal(for: sessions.sessionGeneration)
        XCTAssertEqual(model.contentGeneration, sessions.sessionGeneration)
        XCTAssertFalse(coordinator.transitioning)
    }
}
#endif
