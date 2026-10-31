import Foundation

/// A GitHub release as reported by the REST API, or reconstructed from the
/// official releases page when the API is rate limited. Shared between the
/// release client and `UpdateChecker`'s UI flow.
struct GitHubRelease: Decodable {
    let tag_name: String
    let name: String?
    let body: String?
    let html_url: String
    let assets: [Asset]

    struct Asset: Decodable {
        let name: String
        let browser_download_url: String
        let size: Int
    }

    var tagVersion: String {
        tag_name.hasPrefix("v") ? String(tag_name.dropFirst()) : tag_name
    }

    var dmgAsset: Asset? {
        let isArm64: Bool = {
            var sysinfo = utsname()
            uname(&sysinfo)
            let machine = withUnsafePointer(to: &sysinfo.machine) {
                $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
            }
            return machine == "arm64"
        }()
        let suffix = isArm64 ? "arm64.dmg" : "x64.dmg"
        // Prefer arch-specific DMG, fall back to any .dmg
        return assets.first { $0.name.hasSuffix(suffix) }
            ?? assets.first { $0.name.hasSuffix(".dmg") }
    }
}

/// Resolves the latest release without UI, downloads or installs. Ports the
/// Windows updater's rate-limit handling (PR #784, `TokenTrackerWin/UpdateReleaseClient.cs`)
/// to macOS (issue #945): the anonymous REST API shares a 60 req/h per-IP quota,
/// so a throttled check cools down and falls back to the official releases-page
/// redirect, with the DMG asset pinned to the resolved tag. Kept UI-free so the
/// HTTP flow can be tested without launching the app.
final class UpdateReleaseClient {

    static let releasePageURL = "https://github.com/xiufengsun/TokenTracker/releases/latest"
    private static let apiURL = "https://api.github.com/repos/xiufengsun/TokenTracker/releases/latest"
    private static let tagPath = "/xiufengsun/TokenTracker/releases/tag/"
    private static let downloadBase = "https://github.com/xiufengsun/TokenTracker/releases/download/"
    /// Single universal DMG built by release-dmg.yml; download URLs depend on
    /// this stable name (see the PRODUCT_NAME comment in project.yml).
    private static let dmgAssetName = "TokenTrackerBar.dmg"
    /// Fixed cooldown when GitHub reports throttling without any recovery time.
    private static let defaultCooldown: TimeInterval = 60

    enum FetchError: LocalizedError {
        case httpStatus(Int)
        case emptyResponse
        case invalidReleasePage
        case assetSizeUnavailable

        var errorDescription: String? {
            switch self {
            case .httpStatus(let code): return Strings.networkRequestFailed(code: code)
            case .emptyResponse: return Strings.emptyServerResponse
            case .invalidReleasePage: return Strings.updateUnexpectedRedirect
            case .assetSizeUnavailable: return Strings.updateAssetSizeUnavailable
            }
        }
    }

    private let session: URLSession
    private let now: () -> Date

    /// When GitHub said the API quota recovers, if it named a time. Nil during
    /// cooldown means "cooling down without a displayed time".
    private(set) var apiRetryAt: Date?
    /// Set for any fetch served (or attempted) via the releases page.
    private(set) var usedFallback = false
    private var apiNotBefore: Date?

    init(session: URLSession = .shared, now: @escaping () -> Date = Date.init) {
        self.session = session
        self.now = now
    }

    /// Whether the API is currently cooling down after a throttled attempt.
    var isAPICoolingDown: Bool {
        apiNotBefore.map { $0 > now() } ?? false
    }

    func fetchLatestRelease() async throws -> GitHubRelease {
        usedFallback = false
        if let retryAt = apiNotBefore {
            guard retryAt <= now() else {
                // Cooldown from an earlier throttled attempt: skip the API and
                // re-check the releases page, which sits outside the quota.
                usedFallback = true
                return try await fetchViaReleasePage()
            }
            apiNotBefore = nil
            apiRetryAt = nil
        }

        var request = URLRequest(url: URL(string: Self.apiURL)!, timeoutInterval: 15)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw FetchError.emptyResponse }

        if http.statusCode == 200 {
            guard !data.isEmpty else { throw FetchError.emptyResponse }
            return try JSONDecoder().decode(GitHubRelease.self, from: data)
        }

        // 403/429 are throttling only when GitHub says so — a quota exhaustion
        // (x-ratelimit-remaining: 0), a Retry-After, or a "rate limit" body.
        // Every other status, and unmarked 403s, fail as-is rather than
        // masquerading as rate limits (Windows: OtherHttpErrorsDoNotPretendToBeRateLimits).
        let body = String(data: data, encoding: .utf8) ?? ""
        let exhausted = http.value(forHTTPHeaderField: "x-ratelimit-remaining") == "0"
        let throttled = http.statusCode == 429
            || exhausted
            || http.value(forHTTPHeaderField: "Retry-After") != nil
            || body.localizedCaseInsensitiveContains("rate limit")
        guard http.statusCode == 403 || http.statusCode == 429, throttled else {
            throw FetchError.httpStatus(http.statusCode)
        }

        let resolved = resolveRetryAt(http, exhausted: exhausted)
        apiRetryAt = resolved
        apiNotBefore = resolved ?? now().addingTimeInterval(Self.defaultCooldown)
        usedFallback = true
        return try await fetchViaReleasePage()
    }

    // MARK: - Releases-page fallback (non-API path, outside the anonymous quota)

    private func fetchViaReleasePage() async throws -> GitHubRelease {
        var request = URLRequest(url: URL(string: Self.releasePageURL)!, timeoutInterval: 15)
        request.httpMethod = "HEAD"
        request.setValue("text/html", forHTTPHeaderField: "Accept")
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw FetchError.httpStatus((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        // The redirect target must be the official version-tag page: https,
        // github.com, default port, no credentials/query/fragment.
        guard let final = response.url, Self.isOfficialTagURL(final), final.path.hasPrefix(Self.tagPath) else {
            throw FetchError.invalidReleasePage
        }
        let tag = String(final.path.dropFirst(Self.tagPath.count))
        guard Self.stableVersion(from: tag) != nil else { throw FetchError.invalidReleasePage }

        let downloadURL = Self.downloadBase + tag + "/" + Self.dmgAssetName
        let size = try await headAssetSize(downloadURL)
        return GitHubRelease(
            tag_name: tag,
            name: nil,
            body: nil,
            html_url: final.absoluteString,
            assets: [GitHubRelease.Asset(name: Self.dmgAssetName, browser_download_url: downloadURL, size: size)]
        )
    }

    private func headAssetSize(_ urlString: String) async throws -> Int {
        var request = URLRequest(url: URL(string: urlString)!, timeoutInterval: 15)
        request.httpMethod = "HEAD"
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw FetchError.httpStatus((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        let size = Int(http.expectedContentLength)
        guard size > 0 else { throw FetchError.assetSizeUnavailable }
        return size
    }

    private static func isOfficialTagURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https"
            && url.host?.lowercased() == "github.com"
            && (url.port == nil || url.port == 443)
            && url.user == nil && url.password == nil
            && url.query == nil
            && url.fragment == nil
    }

    /// Mirrors the Windows client's `Version.TryParse` gate: exactly three
    /// numeric parts, so prerelease/build metadata tags are rejected.
    private static func stableVersion(from tag: String) -> String? {
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        let parts = version.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) else {
            return nil
        }
        return version
    }

    // MARK: - Cooldown resolution

    /// Longest of Retry-After (delta or date) and — when the quota is exhausted —
    /// x-ratelimit-reset. Past timestamps yield nil so no recovery time is claimed.
    private func resolveRetryAt(_ http: HTTPURLResponse, exhausted: Bool) -> Date? {
        let current = now()
        var retryAt: Date?
        if let retryAfter = http.value(forHTTPHeaderField: "Retry-After")?.trimmingCharacters(in: .whitespaces) {
            if let seconds = TimeInterval(retryAfter) {
                retryAt = current.addingTimeInterval(seconds)
            } else if let date = Self.httpDateFormatter.date(from: retryAfter) {
                retryAt = date
            }
        }
        if exhausted, let reset = http.value(forHTTPHeaderField: "x-ratelimit-reset")?.trimmingCharacters(in: .whitespaces),
           let epoch = TimeInterval(reset), epoch >= 0, epoch <= 253_402_300_799 {
            let resetAt = Date(timeIntervalSince1970: epoch)
            if retryAt == nil || resetAt > retryAt! {
                retryAt = resetAt
            }
        }
        return retryAt.flatMap { $0 > current ? $0 : nil }
    }

    private static let httpDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return formatter
    }()
}
