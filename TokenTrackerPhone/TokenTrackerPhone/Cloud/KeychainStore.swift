import Foundation
import Security

/// Persists the cloud session (access + refresh token) in the device keychain.
enum KeychainStore {
    struct Failure: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "Couldn't update the keychain (OSStatus \(status))." }
    }

    private static let service = "tokentracker.phone.cloud-session"
    private static let account = "default"

    static func load() -> CloudSession? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(CloudSession.self, from: data)
    }

    static func save(_ session: CloudSession) throws {
        try write(try JSONEncoder().encode(session))
    }

    /// Removes the stored session. If the item can't be deleted it is
    /// overwritten with an undecodable tombstone, so `load()` still returns nil.
    static func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status != errSecSuccess, status != errSecItemNotFound else { return }
        try write(Data())
    }

    private static func write(_ data: Data) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(baseQuery.merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Failure(status: status) }
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
