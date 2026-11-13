import Foundation

/// Protocol seam so the live Cloud client and deterministic Simulator showcase
/// scenarios drive the exact same product view models without inventing fake endpoints.
protocol CloudDataProviding {
    func summary(from: String, to: String, deviceId: String?) async throws -> UsageSummaryResponse
    func daily(from: String, to: String, deviceId: String?) async throws -> PhoneDailyUsageResponse
    func hourly(day: String, deviceId: String?) async throws -> PhoneHourlyUsageResponse
    func modelBreakdown(from: String, to: String, deviceId: String?) async throws -> ModelBreakdownResponse
    func heatmap(weeks: Int, to: String, deviceId: String?) async throws -> HeatmapResponse
    func accountDevices(from: String, to: String) async throws -> AccountDevicesResponse
    func renameDevice(deviceId: String, name: String) async throws
    func cloudAccountStatus() async throws -> CloudAccountStatusResponse
    func cloudMachines() async throws -> CloudMachineListResponse
    func setMachinePaused(machineId: String, paused: Bool) async throws
    func publicVisibility() async throws -> PublicVisibilityState
    func updatePublicVisibility(_ patch: PublicVisibilityPatch) async throws -> PublicVisibilityState
    func authorizeCLIDevice(userCode: String) async throws
}

/// Client for existing TokenTracker Cloud edge functions.
/// Every usage read is gated server-side by `cloud_account_access`.
struct CloudAPIClient: CloudDataProviding {
    let sessions: SessionStore
    var urlSession: URLSession = .shared

    func summary(from: String, to: String, deviceId: String? = nil) async throws -> UsageSummaryResponse {
        var params = ["from": from, "to": to, "rolling": "1"]
        if let deviceId, !deviceId.isEmpty { params["device_id"] = deviceId }
        return try await request("tokentracker-account-summary", params: params)
    }

    func daily(from: String, to: String, deviceId: String? = nil) async throws -> PhoneDailyUsageResponse {
        var params = ["from": from, "to": to]
        if let deviceId, !deviceId.isEmpty { params["device_id"] = deviceId }
        return try await request("tokentracker-account-daily", params: params)
    }

    func hourly(day: String, deviceId: String? = nil) async throws -> PhoneHourlyUsageResponse {
        var params = ["day": day]
        if let deviceId, !deviceId.isEmpty { params["device_id"] = deviceId }
        return try await request("tokentracker-account-hourly", params: params)
    }

    func modelBreakdown(from: String, to: String, deviceId: String? = nil) async throws -> ModelBreakdownResponse {
        var params = ["from": from, "to": to]
        if let deviceId, !deviceId.isEmpty { params["device_id"] = deviceId }
        return try await request("tokentracker-account-model-breakdown", params: params)
    }

    func heatmap(weeks: Int, to: String, deviceId: String? = nil) async throws -> HeatmapResponse {
        var params = ["weeks": String(weeks), "to": to, "week_starts_on": "sun"]
        if let deviceId, !deviceId.isEmpty { params["device_id"] = deviceId }
        return try await request("tokentracker-account-heatmap", params: params)
    }

    func accountDevices(from: String, to: String) async throws -> AccountDevicesResponse {
        try await request("tokentracker-account-devices", params: ["from": from, "to": to])
    }

    func renameDevice(deviceId: String, name: String) async throws {
        struct Response: Decodable { let ok: Bool? }
        let body = try JSONEncoder().encode(["device_id": deviceId, "device_name": name])
        let _: Response = try await request(
            "tokentracker-device-rename",
            method: "POST",
            params: [:],
            includeTimeZone: false,
            body: body
        )
    }

    func cloudAccountStatus() async throws -> CloudAccountStatusResponse {
        try await request(
            "tokentracker-billing",
            params: ["action": "account"],
            includeTimeZone: false
        )
    }

    func cloudMachines() async throws -> CloudMachineListResponse {
        try await request(
            "tokentracker-billing",
            params: ["action": "devices"],
            includeTimeZone: false
        )
    }

    func setMachinePaused(machineId: String, paused: Bool) async throws {
        struct Ack: Decodable {}
        let action = paused ? "remove-device" : "resume-device"
        let body = try JSONEncoder().encode(["machine_id": machineId])
        let _: Ack = try await request(
            "tokentracker-billing",
            method: "POST",
            params: ["action": action],
            includeTimeZone: false,
            body: body
        )
    }

    func publicVisibility() async throws -> PublicVisibilityState {
        try await request("tokentracker-public-visibility", params: [:], includeTimeZone: false)
    }

    func updatePublicVisibility(_ patch: PublicVisibilityPatch) async throws -> PublicVisibilityState {
        let body = try JSONEncoder().encode(patch)
        let _: PublicVisibilityState = try await request(
            "tokentracker-public-visibility",
            method: "POST",
            params: [:],
            includeTimeZone: false,
            body: body
        )
        return try await publicVisibility()
    }

    func authorizeCLIDevice(userCode: String) async throws {
        let normalized = Self.normalizeCLICode(userCode)
        let body = try JSONEncoder().encode(["user_code": normalized])
        let _: DeviceGrantResult = try await request(
            "tokentracker-device-flow-grant",
            method: "POST",
            params: [:],
            includeTimeZone: false,
            body: body
        )
    }

    static func normalizeCLICode(_ raw: String) -> String {
        let alnum = raw.uppercased().filter { $0.isLetter || $0.isNumber }
        guard alnum.count == 8 else { return raw.uppercased().trimmingCharacters(in: .whitespacesAndNewlines) }
        return "\(alnum.prefix(4))-\(alnum.suffix(4))"
    }

    // MARK: - Plumbing

    private func request<T: Decodable>(
        _ slug: String,
        method: String = "GET",
        params: [String: String],
        includeTimeZone: Bool = true,
        body: Data? = nil
    ) async throws -> T {
        do {
            return try await attempt(
                slug,
                method: method,
                params: params,
                includeTimeZone: includeTimeZone,
                body: body,
                forceRefresh: false
            )
        } catch CloudError.signedOut {
            return try await attempt(
                slug,
                method: method,
                params: params,
                includeTimeZone: includeTimeZone,
                body: body,
                forceRefresh: true
            )
        }
    }

    private func attempt<T: Decodable>(
        _ slug: String,
        method: String,
        params: [String: String],
        includeTimeZone: Bool,
        body: Data?,
        forceRefresh: Bool
    ) async throws -> T {
        let token = try await sessions.validAccessToken(forceRefresh: forceRefresh)
        var (data, status) = try await send(
            CloudConfig.functionURL(slug),
            method: method,
            params: params,
            includeTimeZone: includeTimeZone,
            body: body,
            token: token
        )
        if status == 404 {
            (data, status) = try await send(
                CloudConfig.legacyFunctionURL(slug),
                method: method,
                params: params,
                includeTimeZone: includeTimeZone,
                body: body,
                token: token
            )
        }
        guard (200...299).contains(status) else {
            throw CloudError.from(status: status, body: data)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw CloudError.invalidResponse
        }
    }

    private func send(
        _ url: URL,
        method: String,
        params: [String: String],
        includeTimeZone: Bool,
        body: Data?,
        token: String
    ) async throws -> (Data, Int) {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        var query = params
        if includeTimeZone {
            let zone = TimeZone.current
            query.merge([
                "tz": zone.identifier,
                "tz_offset_minutes": String(zone.secondsFromGMT() / 60),
            ]) { current, _ in current }
        }
        if !query.isEmpty {
            components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(CloudConfig.anonKey, forHTTPHeaderField: "apikey")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
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
