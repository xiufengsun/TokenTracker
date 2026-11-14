import Foundation

enum CloudError: LocalizedError, Equatable {
    /// No session, or the refresh token was rejected — the user must sign in again.
    case signedOut
    /// The account has no Cloud read access (no membership, or its read window
    /// ended). Carries the server's `code`, e.g. `cloud_membership_required`.
    case cloudAccessRequired(code: String)
    case server(status: Int, code: String?, message: String?)
    case invalidResponse
    case transport(String)

    /// Codes that `cloud_account_access` returns when reads are not allowed.
    /// Matches `CLOUD_FAILURE_CODES` handling in `dashboard/src/lib/cloud-prompt-policy.js`.
    static let accessDeniedCodes: Set<String> = [
        "cloud_membership_required",
        "cloud_read_only_expired",
        "cloud_history_window_exceeded",
        "cloud_access_denied",
    ]

    static func from(status: Int, body: Data) -> CloudError {
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let code = (json?["code"] as? String) ?? (json?["error"] as? String)
        let message = (json?["message"] as? String) ?? (json?["error"] as? String)
        if let code, accessDeniedCodes.contains(code) { return .cloudAccessRequired(code: code) }
        if status == 401 { return .signedOut }
        return .server(status: status, code: code, message: message)
    }

    /// Codes from `cloud_set_machine_status`, `cloud_grant_device_code` and
    /// `cloud_account_access` (see migrations/20261004120000_cloud-machine-access.sql).
    static let friendlyMessages: [String: String] = [
        "cloud_machine_limit": "Every Cloud sync slot is in use. Pause another computer first, then resume this one.",
        "cloud_machine_not_found": "That computer is no longer linked to this account. Pull to refresh.",
        "cloud_machine_paused": "This computer is paused. Resume it under Synced Computers, then try again.",
        "cloud_device_code_unknown": "That code wasn't found. Check it matches the one in your terminal.",
        "cloud_device_code_expired": "That code has expired. Run tokentracker login again for a new one.",
        "cloud_device_code_claimed": "That code was already approved by another account.",
        "cloud_access_unavailable": "TokenTracker Cloud is temporarily unavailable. Try again shortly.",
        "cloud_sync_throttled": "Too many requests. Wait a moment and try again.",
    ]

    var errorDescription: String? {
        switch self {
        case .signedOut:
            return "Your session expired. Sign in again."
        case .cloudAccessRequired(let code):
            switch code {
            case "cloud_read_only_expired":
                return "This account's Cloud read window has ended."
            case "cloud_history_window_exceeded":
                return "The requested range is outside your Cloud history window."
            default:
                return "This account does not have active TokenTracker Cloud access."
            }
        case .server(let status, let code, let message):
            if code == "invalid user_code format" || status == 400 && message?.contains("user_code") == true {
                return "Enter an 8-character CLI pairing code in XXXX-XXXX format."
            }
            if let code, let friendly = Self.friendlyMessages[code] { return friendly }
            // Edge functions put the machine code in `error`; never show it raw.
            if let message, !message.isEmpty, message != code, !message.hasPrefix("cloud_") { return message }
            return "TokenTracker Cloud couldn't complete this (HTTP \(status))."
        case .invalidResponse:
            return "The server sent an unexpected response."
        case .transport(let message):
            return message
        }
    }
}
