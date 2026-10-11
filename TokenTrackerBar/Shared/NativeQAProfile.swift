import Foundation
import CryptoKit
import CoreFoundation

/// Only the separate native acceptance target can use this profile.
struct NativeQAProfile: Codable {
    static let bundleIdentifier = "com.tokentracker.bar.qa"
    static let urlScheme = "tokentracker-qa"
    static let sandboxRealm = "tokentracker-native-sandbox-v1"

    let version: Int
    let runID: UUID
    let origin: String
    let runDirectory: String
    let serverChallenge: String
    let realm: String
    let ownedOrderIDs: [String]

    enum Failure: Error { case invalidProfile, invalidDirectory, invalidReturn, invalidIdentity }

    static var isQABuild: Bool {
        #if TOKENTRACKER_NATIVE_QA
        return true
        #else
        return false
        #endif
    }

    static let current: NativeQAProfile? = {
        #if TOKENTRACKER_NATIVE_QA
        do {
            guard let path = ProcessInfo.processInfo.environment["TOKENTRACKER_NATIVE_QA_PROFILE"] else {
                throw Failure.invalidProfile
            }
            return try load(at: URL(fileURLWithPath: path), bundleID: Bundle.main.bundleIdentifier)
        } catch {
            fatalError("Native QA isolation profile rejected")
        }
        #else
        return nil
        #endif
    }()

    var baseURL: URL { URL(string: origin)! }
    var suiteName: String { Self.bundleIdentifier + "." + runID.uuidString.lowercased() }
    var defaults: UserDefaults {
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            fatalError("Native QA preference suite unavailable")
        }
        return defaults
    }
    var challengeProof: String {
        SHA256.hash(data: Data((serverChallenge + "\n" + runID.uuidString.lowercased() + "\n" + runDirectory).utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
    private static func canonicalPath(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
    func transportScript() throws -> String {
        let file = URL(fileURLWithPath: runDirectory).appendingPathComponent("bootstrap.js")
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard file.path == Self.canonicalPath(file.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let size = attributes[.size] as? NSNumber, size.intValue <= 256 * 1024 else { throw Failure.invalidProfile }
        return try String(contentsOf: file, encoding: .utf8)
    }
    var transportSHA256: String {
        guard let script = try? transportScript() else { return "" }
        return SHA256.hash(data: Data(script.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func load(at file: URL, bundleID: String?) throws -> NativeQAProfile {
        guard bundleID == bundleIdentifier, file.isFileURL, file.lastPathComponent == "profile.json" else {
            throw Failure.invalidProfile
        }
        let directory = file.deletingLastPathComponent()
        guard file.path == Self.canonicalPath(file.path),
              directory.deletingLastPathComponent().path == Self.canonicalPath(FileManager.default.temporaryDirectory.path),
              directory.lastPathComponent.range(of: "^tokentracker-native-qa-[0-9a-f-]{36}$", options: .regularExpression) != nil else {
            throw Failure.invalidDirectory
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        let directoryAttributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              directoryAttributes[.type] as? FileAttributeType == .typeDirectory,
              (directoryAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o700,
              (directoryAttributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else { throw Failure.invalidDirectory }
        let bytes = try Data(contentsOf: file)
        guard bytes.count <= 8192,
              let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(object.keys) == Set(["version", "runID", "origin", "runDirectory", "serverChallenge", "realm", "ownedOrderIDs"]) else {
            throw Failure.invalidProfile
        }
        let profile = try JSONDecoder().decode(Self.self, from: bytes)
        try profile.validate()
        guard file.deletingLastPathComponent().path == profile.runDirectory else { throw Failure.invalidDirectory }
        return profile
    }

    func validate() throws {
        guard version == 1,
              let components = URLComponents(string: origin), components.scheme == "http",
              components.host == "127.0.0.1", let port = components.port,
              (1024...65535).contains(port), port != 7680, port != 7681,
              components.user == nil, components.password == nil, components.query == nil,
              components.fragment == nil, components.path.isEmpty,
              origin == "http://127.0.0.1:\(port)",
              serverChallenge.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              realm == Self.sandboxRealm,
              !ownedOrderIDs.isEmpty, ownedOrderIDs.count <= 8,
              Set(ownedOrderIDs).count == ownedOrderIDs.count,
              ownedOrderIDs.allSatisfy({ UUID(uuidString: $0)?.uuidString.lowercased() == $0 }) else {
            throw Failure.invalidProfile
        }
        let directory = URL(fileURLWithPath: runDirectory, isDirectory: true)
        let parent = Self.canonicalPath(FileManager.default.temporaryDirectory.path)
        guard directory.path == Self.canonicalPath(directory.path),
              directory.deletingLastPathComponent().path == parent,
              directory.lastPathComponent == "tokentracker-native-qa-" + runID.uuidString.lowercased() else {
            throw Failure.invalidDirectory
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else { throw Failure.invalidDirectory }
    }

    func verifyIdentity(_ data: Data) throws {
        guard data.count <= 4096 else { throw Failure.invalidIdentity }
        struct Identity: Decodable {
            let runID: String; let runDirectory: String; let challengeProof: String
            let realm: String; let environment: String; let scansDisabled: Bool; let bootstrapSHA256: String
        }
        let value = try JSONDecoder().decode(Identity.self, from: data)
        guard data.count <= 4096,
              value.runID == runID.uuidString.lowercased(), value.runDirectory == runDirectory,
              value.challengeProof == challengeProof, value.realm == realm, value.environment == "sandbox",
              value.scansDisabled, !transportSHA256.isEmpty, value.bootstrapSHA256 == transportSHA256 else { throw Failure.invalidIdentity }
    }

    func verifyServer() async -> Bool {
        var request = URLRequest(url: baseURL.appendingPathComponent("__native-qa/identity"))
        request.setValue(serverChallenge, forHTTPHeaderField: "X-TokenTracker-QA-Challenge")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0, "ProxyAutoConfigEnable": 0]
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 3
        let session = URLSession(configuration: configuration, delegate: NativeQAIdentityDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            try verifyIdentity(data)
            return true
        } catch { return false }
    }

    func billingReturnOrder(_ url: URL) throws -> String {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == Self.urlScheme, parts.host == "billing", parts.path == "/return",
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              let query = parts.queryItems, query.count == 2,
              query.filter({ $0.name == "realm" }).first?.value == realm,
              let order = query.filter({ $0.name == "order" }).first?.value,
              ownedOrderIDs.contains(order) else { throw Failure.invalidReturn }
        return order
    }

    func permitsExternalURL(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil else { return false }
        let testItems = parts.queryItems?.filter { $0.name == "test" } ?? []
        return parts.scheme == "https" && parts.host == "pancake.waffo.ai" &&
            testItems.count == 1 && testItems.first?.value == "true" &&
            parts.path.range(of: "^/store/[0-9A-Za-z_-]+/checkout/cs_[0-9A-Za-z_-]+$", options: .regularExpression) != nil &&
            !(parts.queryItems ?? []).contains(where: { ["csId", "cs_id"].contains($0.name) })
    }

    func permitsNativeMessage(_ message: [String: Any]) -> Bool {
        let fields = Set(message.keys)
        switch message["type"] as? String {
        case "getSettings", "getSystemAppearance", "getPetSettings", "getNotificationStatus":
            return fields == ["type"]
        case "setChromeAppearance":
            guard let boolean = message["isDark"] as? NSNumber else { return false }
            return fields == ["type", "theme", "isDark"] && CFGetTypeID(boolean) == CFBooleanGetTypeID() &&
                ["system", "light", "dark"].contains(message["theme"] as? String ?? "")
        case "setSetting":
            guard fields == ["type", "key", "value"], let key = message["key"] as? String else { return false }
            if key == "exchangeRate" {
                guard let value = message["value"] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return false }
                let number = value.doubleValue
                return number.isFinite && number > 0 && number <= 10000
            }
            guard ["locale", "currency", "currencySymbol", "tokenUnitSystem"].contains(key),
                  let value = message["value"] as? String else { return false }
            return !value.isEmpty && value.count <= 20
        case "action":
            if message["name"] as? String == "quit" { return fields == ["type", "name"] }
            guard fields == ["type", "name", "value"], message["name"] as? String == "openURL",
                  let raw = message["value"] as? String, let url = URL(string: raw) else { return false }
            return permitsExternalURL(url)
        default: return false
        }
    }

    func approveOwnedOrder(_ order: String) async -> Bool {
        guard ownedOrderIDs.contains(order) else { return false }
        return await requestApproval(path: "__native-qa/validate-order", payload: ["order": order, "realm": realm])
    }

    func approveExternalURL(_ url: URL) async -> Bool {
        guard permitsExternalURL(url) else { return false }
        return await requestApproval(path: "__native-qa/validate-external", payload: ["url": url.absoluteString, "realm": realm])
    }

    private func requestApproval(path: String, payload: [String: String]) async -> Bool {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(serverChallenge, forHTTPHeaderField: "X-TokenTracker-QA-Challenge")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0, "ProxyAutoConfigEnable": 0]
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        let session = URLSession(configuration: configuration, delegate: NativeQAIdentityDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            try verifyIdentity(data)
            let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard value?["allowed"] as? Bool == true,
                  let actor = value?["actor"] as? String, UUID(uuidString: actor) != nil,
                  let actorEpoch = value?["actorEpoch"] as? Int, actorEpoch > 0 else { return false }
            if let order = payload["order"], value?["order"] as? String != order { return false }
            if let url = payload["url"] {
                let digest = SHA256.hash(data: Data(url.utf8)).map { String(format: "%02x", $0) }.joined()
                guard value?["urlSHA256"] as? String == digest else { return false }
            }
            var check = URLRequest(url: baseURL.appendingPathComponent("__native-qa/validate-actor"))
            check.httpMethod = "POST"
            check.httpBody = try JSONSerialization.data(withJSONObject: ["actor": actor, "actorEpoch": actorEpoch, "realm": realm])
            check.setValue("application/json", forHTTPHeaderField: "Content-Type")
            check.setValue(serverChallenge, forHTTPHeaderField: "X-TokenTracker-QA-Challenge")
            let (checked, checkedResponse) = try await session.data(for: check)
            guard (checkedResponse as? HTTPURLResponse)?.statusCode == 200 else { return false }
            try verifyIdentity(checked)
            let confirmed = try JSONSerialization.jsonObject(with: checked) as? [String: Any]
            return confirmed?["allowed"] as? Bool == true && confirmed?["actor"] as? String == actor &&
                confirmed?["actorEpoch"] as? Int == actorEpoch
        } catch { return false }
    }
}

private final class NativeQAIdentityDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
