import Foundation

/// Owns the signed-in cloud session: persistence, token refresh, sign-out.
@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var session: CloudSession?
    /// Set when sign-out couldn't remove the stored credentials.
    @Published private(set) var signOutError: String?

    private let auth: CloudAuthClient
    private var refreshTask: Task<CloudSession, Error>?
    /// Bumped on every sign-in and sign-out, so a refresh started for an
    /// earlier session can never apply its result to (or clear) a newer one.
    private var generation = 0

    init(auth: CloudAuthClient = CloudAuthClient(), restore: Bool = true) {
        self.auth = auth
        self.session = restore ? KeychainStore.load() : nil
    }

    var isSignedIn: Bool { session != nil }

    /// Starts a new session from a sign-in response.
    func signIn(with response: AuthResponse) throws {
        guard let user = response.user else { throw CloudError.invalidResponse }
        let next = CloudSession(accessToken: response.accessToken, refreshToken: response.refreshToken, user: user)
        try KeychainStore.save(next)
        invalidateInFlightRefresh()
        signOutError = nil
        session = next
    }

    /// A non-expiring access token, refreshing first when needed.
    func validAccessToken(forceRefresh: Bool = false) async throws -> String {
        guard let current = session else { throw CloudError.signedOut }
        if !forceRefresh && !current.accessTokenNeedsRefresh() { return current.accessToken }
        return try await refresh().accessToken
    }

    private func refresh() async throws -> CloudSession {
        if let refreshTask { return try await refreshTask.value }
        guard let current = session, let refreshToken = current.refreshToken else {
            signOutLocally()
            throw CloudError.signedOut
        }
        let owner = generation
        let task = Task<CloudSession, Error> { @MainActor [auth] in
            do {
                let response = try await auth.refresh(refreshToken: refreshToken)
                // Signed out or switched accounts while this was in flight.
                guard self.generation == owner else { throw CloudError.signedOut }
                let next = CloudSession(
                    accessToken: response.accessToken,
                    refreshToken: response.refreshToken ?? refreshToken,
                    user: response.user ?? current.user
                )
                try KeychainStore.save(next)
                self.session = next
                return next
            } catch let error as CloudError where Self.isRejectedRefresh(error) {
                if self.generation == owner { self.signOutLocally() }
                throw CloudError.signedOut
            }
        }
        refreshTask = task
        defer { if generation == owner { refreshTask = nil } }
        return try await task.value
    }

    /// Only a refresh token the server refuses ends the session; rate limits,
    /// outages and network failures keep it for the next attempt.
    nonisolated static func isRejectedRefresh(_ error: CloudError) -> Bool {
        switch error {
        case .signedOut:
            return true
        case .server(let status, _, _):
            return [400, 401, 403].contains(status)
        default:
            return false
        }
    }

    func signOut() async {
        let token = session?.accessToken
        signOutLocally()
        if let token { await auth.signOut(accessToken: token) }
    }

    func signOutLocally() {
        invalidateInFlightRefresh()
        session = nil
        do {
            try KeychainStore.clear()
            signOutError = nil
        } catch {
            signOutError = "Signed out, but the saved sign-in couldn't be removed from this device. \(error.localizedDescription)"
        }
    }

    private func invalidateInFlightRefresh() {
        generation += 1
        refreshTask?.cancel()
        refreshTask = nil
    }
}
