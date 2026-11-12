import Foundation

/// Official hosted TokenTracker Cloud. Mirrors `PROD_INSFORGE_*` in
/// `dashboard/src/lib/insforge-config.ts` and `functionUrlFor` in
/// `dashboard/src/lib/function-url.ts`. The anon key is a public role=anon JWT.
enum CloudConfig {
    static let apiBaseURL = URL(string: "https://srctyff5.us-east.insforge.app")!
    static let functionsBaseURL = URL(string: "https://srctyff5.function2.insforge.app")!
    static let anonKey =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDU5NDd9.T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY"

    /// Same redirect the desktop apps register with InsForge.
    static let oauthCallbackScheme = "tokentracker"
    static let oauthRedirectURI = "tokentracker://auth/callback"

    static let cloudPlansURL = URL(string: "https://www.tokentracker.cc/cloud")!
    static let webDashboardURL = URL(string: "https://www.tokentracker.cc/dashboard")!

    /// The functions host serves `/<slug>`; the API host keeps a legacy
    /// `/functions/<slug>` route that `fetchFunctionResponse` falls back to on 404.
    static func functionURL(_ slug: String) -> URL {
        functionsBaseURL.appendingPathComponent(slug)
    }

    static func legacyFunctionURL(_ slug: String) -> URL {
        apiBaseURL.appendingPathComponent("functions").appendingPathComponent(slug)
    }
}
