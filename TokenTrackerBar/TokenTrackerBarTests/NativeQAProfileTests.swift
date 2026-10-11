import XCTest

final class NativeQAProfileTests: XCTestCase {
    private let order = "00000000-0000-4000-8000-000000000001"

    private func withProfile(_ test: (NativeQAProfile, URL) throws -> Void) throws {
        let runID = UUID()
        let temporaryPath = try XCTUnwrap(realpath(FileManager.default.temporaryDirectory.path, nil))
        defer { free(temporaryPath) }
        let directory = URL(fileURLWithPath: String(cString: temporaryPath), isDirectory: true)
            .appendingPathComponent("tokentracker-native-qa-" + runID.uuidString.lowercased())
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let profile = NativeQAProfile(version: 1, runID: runID, origin: "http://127.0.0.1:51999",
                                      runDirectory: directory.path, serverChallenge: String(repeating: "a", count: 64),
                                      realm: NativeQAProfile.sandboxRealm, ownedOrderIDs: [order])
        let file = directory.appendingPathComponent("profile.json")
        try JSONEncoder().encode(profile).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let bootstrap = directory.appendingPathComponent("bootstrap.js")
        try "/* unit fixture, not a browser acceptance */".write(to: bootstrap, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: bootstrap.path)
        try test(profile, file)
    }

    func testOrdinaryBuildCannotEnableTheProfile() {
        XCTAssertFalse(NativeQAProfile.isQABuild)
        XCTAssertNil(NativeQAProfile.current)
    }

    func testAcceptsOnlyTheSeparateBundleAndPrivateOwnedDirectory() throws {
        try withProfile { profile, file in
            let loaded = try NativeQAProfile.load(at: file, bundleID: NativeQAProfile.bundleIdentifier)
            XCTAssertEqual(loaded.runID, profile.runID)
            XCTAssertThrowsError(try NativeQAProfile.load(at: file, bundleID: "com.tokentracker.bar"))
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
            XCTAssertThrowsError(try NativeQAProfile.load(at: file, bundleID: NativeQAProfile.bundleIdentifier))
        }
    }

    func testNodePosixCanonicalDirectoryDoesNotAcceptFoundationAliases() throws {
        try withProfile { profile, file in
            XCTAssertNoThrow(try NativeQAProfile.load(at: file, bundleID: NativeQAProfile.bundleIdentifier))
            XCTAssertFalse(try profile.transportScript().isEmpty)
            let alias = file.resolvingSymlinksInPath()
            if alias.path != file.path {
                XCTAssertThrowsError(try NativeQAProfile.load(at: alias, bundleID: NativeQAProfile.bundleIdentifier))
            }
        }
    }

    func testRejectsAnotherRunNamespaceAndBroaderDirectoryPermissions() throws {
        try withProfile { _, file in
            let directory = file.deletingLastPathComponent()
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
            XCTAssertThrowsError(try NativeQAProfile.load(at: file, bundleID: NativeQAProfile.bundleIdentifier))
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            var object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
            object["runID"] = UUID().uuidString.lowercased()
            try JSONSerialization.data(withJSONObject: object).write(to: file)
            XCTAssertThrowsError(try NativeQAProfile.load(at: file, bundleID: NativeQAProfile.bundleIdentifier))
        }
    }

    func testRejectsPrimaryPortAndNonLoopbackOrAmbiguousOrigins() throws {
        try withProfile { profile, _ in
            for origin in ["http://127.0.0.1:7680", "http://127.0.0.1:7681", "http://localhost:51999",
                           "https://127.0.0.1:51999", "http://127.0.0.1:51999/path",
                           "http://127.0.0.1:51999?x=1", "http://name@127.0.0.1:51999"] {
                let invalid = NativeQAProfile(version: 1, runID: profile.runID, origin: origin,
                                              runDirectory: profile.runDirectory, serverChallenge: profile.serverChallenge,
                                              realm: profile.realm, ownedOrderIDs: profile.ownedOrderIDs)
                XCTAssertThrowsError(try invalid.validate(), origin)
            }
        }
    }

    func testRejectsUnknownFieldsAndSymlinkedProfilesBeforeLoadingThem() throws {
        try withProfile { _, file in
            var object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
            object["disableGuard"] = true
            try JSONSerialization.data(withJSONObject: object).write(to: file)
            XCTAssertThrowsError(try NativeQAProfile.load(at: file, bundleID: NativeQAProfile.bundleIdentifier))
            let alternate = file.deletingLastPathComponent().appendingPathComponent("other.json")
            try FileManager.default.moveItem(at: file, to: alternate)
            try FileManager.default.createSymbolicLink(at: file, withDestinationURL: alternate)
            XCTAssertThrowsError(try NativeQAProfile.load(at: file, bundleID: NativeQAProfile.bundleIdentifier))
        }
    }

    func testServerChallengeBindsRunDirectoryRealmAndSandboxGuards() throws {
        try withProfile { profile, _ in
            let identity: [String: Any] = ["runID": profile.runID.uuidString.lowercased(),
                "runDirectory": profile.runDirectory, "realm": profile.realm,
                "challengeProof": profile.challengeProof, "environment": "sandbox", "scansDisabled": true,
                "bootstrapSHA256": profile.transportSHA256]
            try profile.verifyIdentity(JSONSerialization.data(withJSONObject: identity))
            for (key, value) in [("runID", "another-run"), ("runDirectory", "/tmp/another"),
                                 ("realm", "another-realm"), ("challengeProof", "wrong"), ("environment", "live")] {
                var invalid = identity; invalid[key] = value
                XCTAssertThrowsError(try profile.verifyIdentity(JSONSerialization.data(withJSONObject: invalid)))
            }
            var invalid = identity; invalid["scansDisabled"] = false
            XCTAssertThrowsError(try profile.verifyIdentity(JSONSerialization.data(withJSONObject: invalid)))
        }
    }

    func testBillingReturnRestoresOnlyTheOwnedOrderInTheQaRealm() throws {
        try withProfile { profile, _ in
            let url = URL(string: "tokentracker-qa://billing/return?order=\(order)&realm=\(profile.realm)")!
            XCTAssertEqual(try profile.billingReturnOrder(url), order)
            for raw in [url.absoluteString.replacingOccurrences(of: "tokentracker-qa:", with: "tokentracker:"),
                        url.absoluteString.replacingOccurrences(of: profile.realm, with: "another-realm"),
                        url.absoluteString.replacingOccurrences(of: order, with: "00000000-0000-4000-8000-000000000002"),
                        url.absoluteString + "&order=" + order, url.absoluteString + "#fragment"] {
                XCTAssertThrowsError(try profile.billingReturnOrder(URL(string: raw)!))
            }
        }
    }

    func testCheckoutExternalUrlRequiresTheExactSandboxOriginAndSingleTestFlag() throws {
        try withProfile { profile, _ in
            XCTAssertTrue(profile.permitsExternalURL(URL(string: "https://pancake.waffo.ai/store/unit/checkout/cs_fixture?test=true")!))
            for raw in ["https://pancake.waffo.ai/store/unit/checkout/cs_fixture",
                        "https://pancake.waffo.ai/store/unit/checkout/cs_fixture?test=false",
                        "https://pancake.waffo.ai/store/unit/checkout/cs_fixture?test=true&test=false",
                        "https://pancake.waffo.ai.attacker.test/store/unit/checkout/cs_fixture?test=true",
                        "http://pancake.waffo.ai/store/unit/checkout/cs_fixture?test=true",
                        "https://pancake.waffo.ai/checkout/example?test=true&csId=a",
                        "https://pancake.waffo.ai/store/unit/checkout/cs_fixture?test=true&csId=a"] {
                XCTAssertFalse(profile.permitsExternalURL(URL(string: raw)!))
            }
        }
    }

    func testDelayedValidLoopbackApprovalCompletesBothOwnershipChecks() throws {
        try withProfile { profile, file in
            let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().appendingPathComponent("test/fixtures/native-qa-approval-delay.cjs")
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node", script.path, profile.runDirectory]
            let output = Pipe()
            process.standardOutput = output
            try process.run()
            defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
            let response = try JSONSerialization.jsonObject(with: output.fileHandleForReading.availableData) as! [String: Any]
            let port = try XCTUnwrap(response["port"] as? Int)
            let actual = NativeQAProfile(version: profile.version, runID: profile.runID, origin: "http://127.0.0.1:\(port)",
                                         runDirectory: profile.runDirectory, serverChallenge: profile.serverChallenge,
                                         realm: profile.realm, ownedOrderIDs: profile.ownedOrderIDs)
            try JSONEncoder().encode(actual).write(to: file)
            let finished = expectation(description: "Delayed order and current actor approved through actual loopback HTTP")
            Task {
                let approved = await actual.approveOwnedOrder(order)
                XCTAssertTrue(approved)
                finished.fulfill()
            }
            wait(for: [finished], timeout: 20)
        }
    }

    func testWebKitNumbersAndBooleansRetainTheirDistinctBridgeTypes() throws {
        try withProfile { profile, _ in
            XCTAssertTrue(profile.permitsNativeMessage(["type": "setSetting", "key": "exchangeRate", "value": NSNumber(value: 1.0)]))
            XCTAssertFalse(profile.permitsNativeMessage(["type": "setSetting", "key": "exchangeRate", "value": NSNumber(value: true)]))
            XCTAssertFalse(profile.permitsNativeMessage(["type": "setSetting", "key": "exchangeRate", "value": "1"]))
            XCTAssertTrue(profile.permitsNativeMessage(["type": "setChromeAppearance", "theme": "light", "isDark": NSNumber(value: false)]))
            XCTAssertFalse(profile.permitsNativeMessage(["type": "setChromeAppearance", "theme": "light", "isDark": NSNumber(value: 1.0)]))
        }
    }

    func testOnlyBoundedQaNativeMessagesCanReachTheRealBridge() throws {
        try withProfile { profile, _ in
            XCTAssertTrue(profile.permitsNativeMessage(["type": "getSettings"]))
            XCTAssertTrue(profile.permitsNativeMessage(["type": "setChromeAppearance", "theme": "dark", "isDark": true]))
            XCTAssertTrue(profile.permitsNativeMessage(["type": "action", "name": "quit"]))
            for message: [String: Any] in [
                ["type": "action", "name": "syncNow"], ["type": "requestNotificationPermission"],
                ["type": "setSetting", "key": "launchAtLogin", "value": true],
                ["type": "setSetting", "key": "currency", "value": NSNull()],
                ["type": "setSetting", "key": "currency", "value": String(repeating: "a", count: 21)],
                ["type": "setSetting", "key": "exchangeRate", "value": true],
                ["type": "setSetting", "key": "exchangeRate", "value": Double.infinity],
                ["type": "getSettings", "baseURL": "https://attacker.test"],
                ["type": "nativeOAuth"], ["type": "unknown"]
            ] {
                XCTAssertFalse(profile.permitsNativeMessage(message))
            }
        }
    }
}
