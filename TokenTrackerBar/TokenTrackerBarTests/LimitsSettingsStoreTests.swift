import XCTest
import Combine

final class LimitsSettingsStoreTests: XCTestCase {

    func testQoderCnUsesItsDedicatedIcon() {
        XCTAssertEqual(LimitsSettingsStore.iconNames["qoderCn"], "QoderCnLogo")
    }
    private var cancellables: Set<AnyCancellable> = []

    func testLegacyWorkbuddyEditionsMigrateIntoOneSwitch() {
        let (store, _) = makeStore()
        XCTAssertTrue(store.applyBridgeSnapshot([
            "providerOrder": ["workbuddyAi", "claude", "workbuddy"],
            "providerVisibility": ["workbuddy": false, "workbuddyAi": true],
            "updatedAt": 100,
        ]))
        XCTAssertEqual(Array(store.providerOrder.prefix(2)), ["workbuddy", "claude"])
        XCTAssertEqual(store.providerOrder.filter { $0.hasPrefix("workbuddy") }, ["workbuddy"])
        XCTAssertTrue(store.isVisible("workbuddy"))
        XCTAssertNil(store.providerVisibility["workbuddyAi"])
        store.setProviderVisibilityFromMenu("workbuddy", isVisible: false)
        XCTAssertFalse(store.isVisible("workbuddy"))
    }

    func testWorkbuddyCreditAmountsDecodeWithoutAffectingOlderWindows() throws {
        let data = Data(#"{"used_percent":50.586,"limit_credits":500,"used_credits":252.93,"remaining_credits":247.07}"#.utf8)
        let window = try JSONDecoder().decode(GenericLimitWindow.self, from: data)
        XCTAssertEqual(window.limitCredits, 500)
        XCTAssertEqual(window.usedCredits, 252.93)
        XCTAssertEqual(window.remainingCredits, 247.07)
        XCTAssertTrue(window.creditsDetail?.contains("252.93") == true)
        XCTAssertTrue(window.creditsDetail?.contains("247.07") == true)
        let old = try JSONDecoder().decode(GenericLimitWindow.self, from: Data(#"{"used_percent":20}"#.utf8))
        XCTAssertNil(old.creditsDetail)
    }

    override func tearDown() {
        cancellables.removeAll()
        super.tearDown()
    }

    func testReorderMovingDownUsesOriginalDestinationOffset() {
        let order = LimitsSettingsStore.allProviders

        let reordered = LimitsSettingsStore.reorderedProviderOrder(
            order,
            moving: IndexSet(integer: 0),
            to: 2
        )

        XCTAssertEqual(Array(reordered.prefix(3)), ["codex", "claude", "cursor"])
    }

    func testReorderMovingUpUsesOriginalDestinationOffset() {
        let order = LimitsSettingsStore.allProviders

        let reordered = LimitsSettingsStore.reorderedProviderOrder(
            order,
            moving: IndexSet(integer: 2),
            to: 1
        )

        XCTAssertEqual(Array(reordered.prefix(3)), ["claude", "cursor", "codex"])
    }

    func testBridgeSnapshotDoesNotPublishPreferenceChange() {
        let (store, _) = makeStore()
        let notPublished = expectation(description: "bridge snapshot does not republish to Dashboard")
        notPublished.isInverted = true
        store.preferencesDidChange
            .sink { notPublished.fulfill() }
            .store(in: &cancellables)

        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "remaining",
            "providerOrder": ["gemini", "claude"],
            "providerVisibility": ["claude": false],
            "updatedAt": NSNumber(value: 10),
        ]))

        wait(for: [notPublished], timeout: 0.05)
        XCTAssertEqual(store.displayMode, .remaining)
        XCTAssertEqual(Array(store.providerOrder.prefix(2)), ["gemini", "claude"])
        XCTAssertEqual(store.providerVisibility["claude"], false)
        XCTAssertEqual(store.updatedAt, 10)
    }

    func testMenuChangePublishesPreferenceChangeAndPersistsSnapshot() {
        let (store, defaults) = makeStore()
        let published = expectation(description: "menu changes publish to Dashboard")
        store.preferencesDidChange
            .sink { published.fulfill() }
            .store(in: &cancellables)

        store.setDisplayModeFromMenu(.remaining)

        wait(for: [published], timeout: 0.05)
        XCTAssertEqual(store.displayMode, .remaining)
        XCTAssertEqual(defaults.string(forKey: "LimitsDisplayMode"), "remaining")
        XCTAssertNotNil(defaults.object(forKey: "LimitsPreferencesUpdatedAt"))
    }

    func testBridgeSnapshotRejectsOlderUpdatedAt() {
        let (store, _) = makeStore()

        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "remaining",
            "updatedAt": NSNumber(value: 20),
        ]))
        XCTAssertFalse(store.applyBridgeSnapshot([
            "displayMode": "used",
            "updatedAt": NSNumber(value: 19),
        ]))

        XCTAssertEqual(store.displayMode, .remaining)
        XCTAssertEqual(store.updatedAt, 20)
    }

    func testBridgeSnapshotWithSameUpdatedAtAppliesDashboardTieBreak() {
        let (store, _) = makeStore()

        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "used",
            "providerOrder": ["claude", "codex"],
            "updatedAt": NSNumber(value: 30),
        ]))
        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "remaining",
            "providerOrder": ["gemini", "claude"],
            "providerVisibility": ["gemini": false],
            "updatedAt": NSNumber(value: 30),
        ]))

        XCTAssertEqual(store.displayMode, .remaining)
        XCTAssertEqual(Array(store.providerOrder.prefix(2)), ["gemini", "claude"])
        XCTAssertEqual(store.providerVisibility["gemini"], false)
        XCTAssertEqual(store.updatedAt, 30)
    }

    func testBridgeSnapshotWithoutUpdatedAtOnlyAppliesBeforeMigration() {
        let (unmigrated, _) = makeStore()
        XCTAssertTrue(unmigrated.applyBridgeSnapshot([
            "displayMode": "remaining",
        ]))
        XCTAssertEqual(unmigrated.displayMode, .remaining)
        XCTAssertNil(unmigrated.updatedAt)

        let (migrated, _) = makeStore()
        XCTAssertTrue(migrated.applyBridgeSnapshot([
            "displayMode": "used",
            "updatedAt": NSNumber(value: 40),
        ]))
        XCTAssertFalse(migrated.applyBridgeSnapshot([
            "displayMode": "remaining",
        ]))
        XCTAssertEqual(migrated.displayMode, .used)
        XCTAssertEqual(migrated.updatedAt, 40)
    }

    func testBridgeSnapshotNormalizesProvidersAndUpdatedAt() {
        let (store, _) = makeStore()

        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "remaining",
            "providerOrder": ["gemini", "unknown", "claude", "gemini"],
            "providerVisibility": [
                "claude": false,
                "codex": NSNumber(value: 1),
                "unknown": false,
            ],
            "updatedAt": NSNumber(value: 42.5),
        ]))

        XCTAssertEqual(Array(store.providerOrder.prefix(2)), ["gemini", "claude"])
        XCTAssertEqual(store.providerOrder.count, LimitsSettingsStore.allProviders.count)
        XCTAssertEqual(store.providerVisibility["claude"], false)
        XCTAssertEqual(store.providerVisibility["codex"], true)
        XCTAssertNil(store.providerVisibility["unknown"])
        XCTAssertNil(store.updatedAt)
    }

    func testBridgeSnapshotPersistsUserDefaultsMirror() {
        let (store, defaults) = makeStore()

        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "remaining",
            "providerOrder": ["codex", "claude"],
            "providerVisibility": ["claude": false],
            "updatedAt": NSNumber(value: 50),
        ]))

        XCTAssertEqual(defaults.string(forKey: "LimitsDisplayMode"), "remaining")
        XCTAssertEqual(defaults.stringArray(forKey: "LimitsProviderOrder")?.prefix(2), ["codex", "claude"])
        XCTAssertEqual(defaults.dictionary(forKey: "LimitsProviderVisibility")?["claude"] as? Bool, false)
        XCTAssertEqual(defaults.object(forKey: "LimitsPreferencesUpdatedAt") as? Int64, 50)
    }

    // MARK: - Devin opt-in selection

    /// Devin's visibility switch doubles as the consent to read CLI
    /// credentials: it must default OFF while every other provider stays on.
    func testDevinDefaultsOffWhileOtherProvidersStayOn() {
        let (store, _) = makeStore()

        XCTAssertFalse(store.isVisible("devin"))
        XCTAssertEqual(store.providerVisibility["devin"], false)
        for id in LimitsSettingsStore.allProviders where id != "devin" {
            XCTAssertTrue(store.isVisible(id), "\(id) must stay on")
        }
        XCTAssertTrue(LimitsSettingsStore.optInProviders.contains("devin"))
    }

    func testStoredDevinTrueSurvivesReloadAsTheExplicitSelection() {
        let (store, defaults) = makeStore()
        XCTAssertFalse(store.isVisible("devin"))

        defaults.set(["devin": true], forKey: "LimitsProviderVisibility")
        let reloaded = LimitsSettingsStore(userDefaults: defaults)

        XCTAssertTrue(reloaded.isVisible("devin"))
        XCTAssertEqual(reloaded.providerVisibility["devin"], true)
    }

    func testBridgeSnapshotWithoutDevinKeepsItOff() {
        let (store, _) = makeStore()

        XCTAssertTrue(store.applyBridgeSnapshot([
            "providerVisibility": ["claude": true],
            "updatedAt": NSNumber(value: 1),
        ]))

        XCTAssertFalse(store.isVisible("devin"))
        XCTAssertEqual(store.providerVisibility["devin"], false)
    }

    func testMenuTogglePersistsTheSingleSelectionFact() {
        let (store, defaults) = makeStore()

        store.setProviderVisibilityFromMenu("devin", isVisible: true)
        XCTAssertTrue(store.isVisible("devin"))
        XCTAssertEqual(
            defaults.dictionary(forKey: "LimitsProviderVisibility")?["devin"] as? Bool,
            true
        )

        store.setProviderVisibilityFromMenu("devin", isVisible: false)
        XCTAssertFalse(store.isVisible("devin"))
    }

    private func makeStore(
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> (LimitsSettingsStore, UserDefaults) {
        let suiteName = "LimitsSettingsStoreTests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            XCTFail("Unable to create test UserDefaults suite", file: file, line: line)
            return (LimitsSettingsStore(userDefaults: .standard), .standard)
        }
        defaults.removePersistentDomain(forName: suiteName)
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suiteName)
        }
        return (LimitsSettingsStore(userDefaults: defaults), defaults)
    }
}
