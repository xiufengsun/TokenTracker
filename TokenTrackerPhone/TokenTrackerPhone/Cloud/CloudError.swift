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

    var errorDescription: String? {
        switch self {
        case .signedOut:
            return "Your session expired. Sign in again."
        case .cloudAccessRequired:
            return "This account doesn't have TokenTracker Cloud access."
        case .server(let status, _, let message):
            if let message, !message.isEmpty { return message }
            return "The server returned HTTP \(status)."
        case .invalidResponse:
            return "The server sent an unexpected response."
        case .transport(let message):
            return message
        }
    }
}
