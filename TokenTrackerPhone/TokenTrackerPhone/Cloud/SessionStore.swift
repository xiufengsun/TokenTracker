import Foundation

/// Owns the signed-in cloud session: persistence, token refresh, sign-out.
@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var session: CloudSession?

    private let auth: CloudAuthClient
    private var refreshTask: Task<CloudSession, Error>?

    init(auth: CloudAuthClient = CloudAuthClient(), restore: Bool = true) {
        self.auth = auth
        self.session = restore ? KeychainStore.load() : nil
    }

    var isSignedIn: Bool { session != nil }

    func adopt(_ response: AuthResponse) throws {
        guard let user = response.user ?? session?.user else { throw CloudError.invalidResponse }
        let next = CloudSession(
            accessToken: response.accessToken,
            refreshToken: response.refreshToken ?? session?.refreshToken,
            user: user
        )
        session = next
        KeychainStore.save(next)
    }

    /// A non-expiring access token, refreshing first when needed.
    func validAccessToken(forceRefresh: Bool = false) async throws -> String {
        guard let current = session else { throw CloudError.signedOut }
        if !forceRefresh && !current.accessTokenNeedsRefresh() { return current.accessToken }
        return try await refresh().accessToken
    }

    private func refresh() async throws -> CloudSession {
        if let refreshTask { return try await refreshTask.value }
        guard let refreshToken = session?.refreshToken else {
            signOutLocally()
            throw CloudError.signedOut
        }
        let task = Task { [auth] () throws -> CloudSession in
            let response = try await auth.refresh(refreshToken: refreshToken)
            try self.adopt(response)
            guard let session = self.session else { throw CloudError.signedOut }
            return session
        }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            return try await task.value
        } catch let error as CloudError {
            // A rejected refresh token is final; outages and network failures are not.
            switch error {
            case .transport, .invalidResponse:
                throw error
            case .server(let status, _, _) where status >= 500:
                throw error
            default:
                signOutLocally()
                throw CloudError.signedOut
            }
        }
    }

    func signOut() async {
        let token = session?.accessToken
        signOutLocally()
        if let token { await auth.signOut(accessToken: token) }
    }

    func signOutLocally() {
        session = nil
        KeychainStore.clear()
    }
}
