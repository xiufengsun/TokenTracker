import Foundation

/// Read-only client for the cloud `tokentracker-account-*` edge functions,
/// mirroring `fetchAccountFunction` in `dashboard/src/lib/api.ts`. Every call
/// is gated server-side by `cloud_account_access`, so a non-Cloud account gets
/// `CloudError.cloudAccessRequired`.
struct CloudUsageClient {
    let sessions: SessionStore
    var urlSession: URLSession = .shared

    func summary(from: String, to: String) async throws -> UsageSummaryResponse {
        try await get("tokentracker-account-summary", [
            "from": from, "to": to, "rolling": "1",
        ])
    }

    func daily(from: String, to: String) async throws -> DailyUsageResponse {
        try await get("tokentracker-account-daily", ["from": from, "to": to])
    }

    func modelBreakdown(from: String, to: String) async throws -> ModelBreakdownResponse {
        try await get("tokentracker-account-model-breakdown", ["from": from, "to": to])
    }

    func heatmap(weeks: Int, to: String) async throws -> HeatmapResponse {
        try await get("tokentracker-account-heatmap", [
            "weeks": String(weeks), "to": to, "week_starts_on": "sun",
        ])
    }

    // MARK: - Plumbing

    private func get<T: Decodable>(_ slug: String, _ params: [String: String]) async throws -> T {
        do {
            return try await attempt(slug, params, forceRefresh: false)
        } catch CloudError.signedOut {
            // One retry with a freshly refreshed token, like the SDK's 401 path.
            return try await attempt(slug, params, forceRefresh: true)
        }
    }

    private func attempt<T: Decodable>(_ slug: String, _ params: [String: String], forceRefresh: Bool) async throws -> T {
        let token = try await sessions.validAccessToken(forceRefresh: forceRefresh)
        var (data, status) = try await send(CloudConfig.functionURL(slug), params, token: token)
        if status == 404 {
            (data, status) = try await send(CloudConfig.legacyFunctionURL(slug), params, token: token)
        }
        guard (200...299).contains(status) else { throw CloudError.from(status: status, body: data) }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw CloudError.invalidResponse
        }
    }

    private func send(_ url: URL, _ params: [String: String], token: String) async throws -> (Data, Int) {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let zone = TimeZone.current
        let query = params.merging([
            "tz": zone.identifier,
            "tz_offset_minutes": String(zone.secondsFromGMT() / 60),
        ]) { current, _ in current }
        components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        var request = URLRequest(url: components.url!)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(CloudConfig.anonKey, forHTTPHeaderField: "apikey")
        do {
            let (data, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw CloudError.invalidResponse }
            return (data, http.statusCode)
        } catch let error as CloudError {
            throw error
        } catch {
            throw CloudError.transport(error.localizedDescription)
        }
    }
}
