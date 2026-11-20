import Foundation

/// InsForge auth REST calls, matching what `@insforge/sdk` sends in server
/// ("mobile") mode: tokens travel in JSON bodies, never in cookies.
struct CloudAuthClient {
    var session: URLSession = .shared

    struct PublicConfig: Decodable {
        var oAuthProviders: [String]
    }

    func publicConfig() async throws -> PublicConfig {
        try await send(get("/api/auth/public-config"))
    }

    /// Step 1 of PKCE OAuth: InsForge returns the provider's authorize URL.
    func oauthAuthorizeURL(provider: String, pkce: PKCE) async throws -> URL {
        struct Response: Decodable { let authUrl: String }
        var request = get("/api/auth/oauth/\(provider.lowercased())", query: [
            URLQueryItem(name: "redirect_uri", value: CloudConfig.oauthRedirectURI),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
        ])
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let response: Response = try await send(request)
        guard let url = URL(string: response.authUrl) else { throw CloudError.invalidResponse }
        return url
    }

    /// Step 2: trade the `insforge_code` from the redirect for a session.
    func exchangeOAuthCode(_ code: String, pkce: PKCE) async throws -> AuthResponse {
        try await send(post("/api/auth/oauth/exchange", body: ["code": code, "code_verifier": pkce.verifier]))
    }

    func signIn(email: String, password: String) async throws -> AuthResponse {
        try await send(post("/api/auth/sessions", body: ["email": email, "password": password]))
    }

    func refresh(refreshToken: String) async throws -> AuthResponse {
        // The SDK has sent both spellings across versions; the server reads one.
        try await send(post("/api/auth/refresh", body: ["refresh_token": refreshToken, "refreshToken": refreshToken]))
    }

    func signOut(accessToken: String) async {
        var request = post("/api/auth/logout", body: [:])
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: request)
    }

    // MARK: - Plumbing

    private func get(_ path: String, query: [URLQueryItem] = []) -> URLRequest {
        var components = URLComponents(url: CloudConfig.apiBaseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(CloudConfig.anonKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func post(_ path: String, body: [String: String]) -> URLRequest {
        var components = URLComponents(url: CloudConfig.apiBaseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "client_type", value: "mobile")]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(CloudConfig.anonKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw CloudError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw CloudError.invalidResponse }
        guard (200...299).contains(http.statusCode) else {
            throw CloudError.from(status: http.statusCode, body: data)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw CloudError.invalidResponse
        }
    }
}
