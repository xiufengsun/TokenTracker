import Foundation
import XCTest

/// Port of `TokenTrackerWin.Tests/UpdateReleaseClientTests.cs` (PR #784) to the
/// macOS release client (issue #945): rate-limit cooldown, releases-page
/// fallback, and the guardrails around both.
final class UpdateReleaseClientTests: XCTestCase {

    private static let apiURL = "https://api.github.com/repos/xiufengsun/TokenTracker/releases/latest"
    private static let pageURL = "https://github.com/xiufengsun/TokenTracker/releases/latest"
    private static let tagURL = "https://github.com/xiufengsun/TokenTracker/releases/tag/v1.3.9"
    private static let dmgURL = "https://github.com/xiufengsun/TokenTracker/releases/download/v1.3.9/TokenTrackerBar.dmg"
    private static let epoch = Date(timeIntervalSince1970: 1_770_000_000)

    private final class Clock {
        var now: Date
        init(_ now: Date) { self.now = now }
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    // MARK: - Happy path

    func testSuccessfulApiDoesNotUseReleasePage() async throws {
        stub { request in
            Self.isAPI(request)
                ? Self.http(200, body: Self.apiReleaseJSON())
                : .networkError
        }
        let client = makeClient()

        let release = try await client.fetchLatestRelease()

        XCTAssertEqual(release.tag_name, "v1.3.9")
        XCTAssertEqual(release.tagVersion, "1.3.9")
        XCTAssertEqual(release.dmgAsset?.browser_download_url, Self.dmgURL)
        XCTAssertEqual(release.dmgAsset?.size, 900)
        XCTAssertEqual(StubURLProtocol.calls.map(\.url.absoluteString), [Self.apiURL])
        XCTAssertFalse(client.usedFallback)
        XCTAssertNil(client.apiRetryAt)
        XCTAssertFalse(client.isAPICoolingDown)
    }

    func testRateLimitedApiFallsBackAndPinsDMGToTag() async throws {
        stub { request in
            if Self.isAPI(request) {
                return Self.rateLimited(reset: Self.epoch.addingTimeInterval(3_600))
            }
            if request.url?.absoluteString == Self.pageURL {
                return .redirect(to: Self.tagURL)
            }
            if request.url?.absoluteString == Self.tagURL {
                return Self.http(200, headers: ["Content-Type": "text/html"])
            }
            if request.url?.absoluteString == Self.dmgURL {
                return Self.http(200, headers: ["Content-Length": "900"])
            }
            return .networkError
        }
        let client = makeClient()

        let release = try await client.fetchLatestRelease()

        XCTAssertTrue(client.usedFallback)
        XCTAssertEqual(client.apiRetryAt, Self.epoch.addingTimeInterval(3_600))
        XCTAssertEqual(release.tag_name, "v1.3.9")
        XCTAssertEqual(release.tagVersion, "1.3.9")
        XCTAssertEqual(release.html_url, Self.tagURL)
        XCTAssertEqual(release.dmgAsset?.name, "TokenTrackerBar.dmg")
        XCTAssertEqual(release.dmgAsset?.browser_download_url, Self.dmgURL)
        XCTAssertEqual(release.dmgAsset?.size, 900)
        XCTAssertEqual(StubURLProtocol.calls.map(\.url.absoluteString), [
            Self.apiURL,
            Self.pageURL,
            Self.tagURL,
            Self.dmgURL,
        ])
    }

    // MARK: - Cooldown

    func testCooldownSkipsApiUntilResetThenReturnsToApi() async throws {
        let clock = Clock(Self.epoch)
        var apiCalls = 0
        stub { request in
            if !Self.isAPI(request) { return Self.releasePageChainResponse(request) }
            apiCalls += 1
            return apiCalls == 1
                ? Self.rateLimited(reset: Self.epoch.addingTimeInterval(3_600))
                : Self.http(200, body: Self.apiReleaseJSON())
        }
        let client = makeClient(clock: clock)

        _ = try await client.fetchLatestRelease()

        clock.now = Self.epoch.addingTimeInterval(59 * 60)
        let fallbackRelease = try await client.fetchLatestRelease()
        XCTAssertEqual(apiCalls, 1)
        XCTAssertTrue(client.usedFallback)
        XCTAssertEqual(fallbackRelease.tagVersion, "1.3.9")

        clock.now = Self.epoch.addingTimeInterval(3_600)
        _ = try await client.fetchLatestRelease()
        XCTAssertEqual(apiCalls, 2)
        XCTAssertFalse(client.usedFallback)
        XCTAssertNil(client.apiRetryAt)
        XCTAssertFalse(client.isAPICoolingDown)
    }

    func testLimitWithoutTimeWaitsOneMinuteWithoutInventingDisplayedTime() async throws {
        for status in [403, 429] {
            StubURLProtocol.reset()
            let clock = Clock(Self.epoch)
            var apiCalls = 0
            stub { request in
                if !Self.isAPI(request) { return Self.releasePageChainResponse(request) }
                apiCalls += 1
                return Self.http(status, body: Data("API rate limit exceeded".utf8))
            }
            let client = makeClient(clock: clock)

            _ = try await client.fetchLatestRelease()
            XCTAssertNil(client.apiRetryAt)

            clock.now = Self.epoch.addingTimeInterval(59)
            _ = try await client.fetchLatestRelease()
            XCTAssertEqual(apiCalls, 1)

            clock.now = Self.epoch.addingTimeInterval(60)
            _ = try await client.fetchLatestRelease()
            XCTAssertEqual(apiCalls, 2)
        }
    }

    func testSecondaryLimitHonorsRetryAfterDeltaOrDate() async throws {
        for retryAfter in [String(90), Self.httpDate(Self.epoch.addingTimeInterval(90))] {
            StubURLProtocol.reset()
            stub { request in
                if Self.isAPI(request) {
                    return Self.rateLimited(remaining: "5", retryAfter: retryAfter, reset: Self.epoch.addingTimeInterval(3_600))
                }
                return Self.releasePageChainResponse(request)
            }
            let client = makeClient()

            _ = try await client.fetchLatestRelease()

            XCTAssertEqual(client.apiRetryAt, Self.epoch.addingTimeInterval(90))
            XCTAssertTrue(client.usedFallback)
        }
    }

    func testExhaustedQuotaWaitsForLongerOfRetryAfterAndReset() async throws {
        stub { request in
            if Self.isAPI(request) {
                return Self.rateLimited(retryAfter: "180", reset: Self.epoch.addingTimeInterval(120))
            }
            return Self.releasePageChainResponse(request)
        }
        let client = makeClient()

        _ = try await client.fetchLatestRelease()

        XCTAssertEqual(client.apiRetryAt, Self.epoch.addingTimeInterval(180))
    }

    func testInvalidResetHeaderUsesCooldownWithoutClaimingARecoveryTime() async throws {
        for reset in ["not-a-number", "9223372036854775807", "0"] {
            StubURLProtocol.reset()
            var apiCalls = 0
            stub { request in
                if !Self.isAPI(request) { return Self.releasePageChainResponse(request) }
                apiCalls += 1
                return Self.rateLimited(resetHeader: reset)
            }
            let client = makeClient()

            _ = try await client.fetchLatestRelease()
            _ = try await client.fetchLatestRelease()

            XCTAssertEqual(apiCalls, 1)
            XCTAssertNil(client.apiRetryAt)
        }
    }

    // MARK: - Non-rate-limit errors stay non-rate-limit

    func testOtherHttpErrorsDoNotPretendToBeRateLimits() async throws {
        for status in [403, 500] {
            StubURLProtocol.reset()
            var calls = 0
            stub { _ in
                calls += 1
                return Self.http(status, body: Data("Access denied".utf8))
            }
            let client = makeClient()

            do {
                _ = try await client.fetchLatestRelease()
                XCTFail("expected failure for HTTP \(status)")
            } catch {
                guard case UpdateReleaseClient.FetchError.httpStatus(let code) = error else {
                    XCTFail("unexpected error: \(error)")
                    return
                }
                XCTAssertEqual(code, status)
            }
            XCTAssertEqual(calls, 1)
            XCTAssertFalse(client.usedFallback)
            XCTAssertNil(client.apiRetryAt)
        }
    }

    // MARK: - Fallback redirect validation

    func testFallbackRejectsUnexpectedRedirectsAndInvalidTags() async throws {
        let badRedirects = [
            "https://example.test/xiufengsun/TokenTracker/releases/tag/v1.3.9",
            "http://github.com/xiufengsun/TokenTracker/releases/tag/v1.3.9",
            "https://github.com/another/repo/releases/tag/v1.3.9",
            // Same path as the entry point but with a query, so the stub serves
            // it as a terminal 200 (a literal self-redirect would loop); the
            // client must still reject it because it is not a tag page.
            "https://github.com/xiufengsun/TokenTracker/releases/latest?ref=x",
            "https://github.com/xiufengsun/TokenTracker/releases/tag/v1.3.9-rc.1",
            "https://github.com/xiufengsun/TokenTracker/releases/tag/v1.3.9/extra",
        ]
        for redirect in badRedirects {
            StubURLProtocol.reset()
            var calls = 0
            stub { request in
                calls += 1
                if Self.isAPI(request) { return Self.rateLimited() }
                if request.url?.absoluteString == Self.pageURL { return .redirect(to: redirect) }
                return Self.http(200)
            }
            let client = makeClient()

            do {
                _ = try await client.fetchLatestRelease()
                XCTFail("expected invalidReleasePage for \(redirect)")
            } catch {
                guard case UpdateReleaseClient.FetchError.invalidReleasePage = error else {
                    XCTFail("unexpected error for \(redirect): \(error)")
                    return
                }
            }
            // API + releases page + followed redirect target.
            XCTAssertEqual(calls, 3, "redirect target: \(redirect)")
        }
    }

    func testFallbackFailsWhenDMGUnavailable() async throws {
        for failure in ["dmg-missing", "size-missing"] {
            StubURLProtocol.reset()
            stub { request in
                if Self.isAPI(request) { return Self.rateLimited() }
                if request.url?.absoluteString == Self.pageURL { return .redirect(to: Self.tagURL) }
                if request.url?.absoluteString == Self.tagURL { return Self.http(200) }
                if request.url?.absoluteString == Self.dmgURL {
                    return failure == "dmg-missing"
                        ? Self.http(404)
                        : Self.http(200)
                }
                return .networkError
            }
            let client = makeClient()

            do {
                _ = try await client.fetchLatestRelease()
                XCTFail("expected failure for \(failure)")
            } catch let error as UpdateReleaseClient.FetchError {
                if failure == "dmg-missing" {
                    guard case .httpStatus(404) = error else { XCTFail("unexpected: \(error)"); return }
                } else {
                    guard case .assetSizeUnavailable = error else { XCTFail("unexpected: \(error)"); return }
                }
            }
            XCTAssertTrue(client.usedFallback)
        }
    }

    func testFallbackFailureKeepsApiCooldownForNextCheck() async throws {
        var apiCalls = 0
        stub { request in
            if !Self.isAPI(request) { return Self.http(503) }
            apiCalls += 1
            return Self.rateLimited(reset: Self.epoch.addingTimeInterval(3_600))
        }
        let client = makeClient()

        for _ in 0..<2 {
            do {
                _ = try await client.fetchLatestRelease()
                XCTFail("expected failure")
            } catch {
                guard case UpdateReleaseClient.FetchError.httpStatus(503) = error else {
                    XCTFail("unexpected error: \(error)")
                    return
                }
            }
        }
        XCTAssertEqual(apiCalls, 1)
        XCTAssertEqual(client.apiRetryAt, Self.epoch.addingTimeInterval(3_600))
        XCTAssertTrue(client.isAPICoolingDown)
    }

    // MARK: - Helpers

    private func stub(_ handler: @escaping (URLRequest) -> StubURLProtocol.StubResponse) {
        StubURLProtocol.handler = handler
    }

    private func makeClient(clock: Clock = Clock(UpdateReleaseClientTests.epoch)) -> UpdateReleaseClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return UpdateReleaseClient(session: URLSession(configuration: configuration), now: { clock.now })
    }

    private static func isAPI(_ request: URLRequest) -> Bool {
        request.url?.host == "api.github.com"
    }

    /// Anything on github.com that is neither the releases page nor the tag
    /// page (redirect target HEAD, DMG metadata) gets a generic 200.
    private static func releasePageChainResponse(_ request: URLRequest) -> StubURLProtocol.StubResponse {
        let url = request.url?.absoluteString ?? ""
        if url == Self.pageURL { return .redirect(to: Self.tagURL) }
        if url == Self.dmgURL { return Self.http(200, headers: ["Content-Length": "900"]) }
        return Self.http(200)
    }

    private static func http(_ status: Int, headers: [String: String] = [:], body: Data = Data()) -> StubURLProtocol.StubResponse {
        .response(statusCode: status, headers: headers, body: body)
    }

    private static func rateLimited(
        remaining: String = "0",
        retryAfter: String? = nil,
        reset resetAt: Date? = nil,
        resetHeader: String? = nil
    ) -> StubURLProtocol.StubResponse {
        var headers = ["x-ratelimit-remaining": remaining]
        if let retryAfter { headers["Retry-After"] = retryAfter }
        if let resetAt { headers["x-ratelimit-reset"] = String(Int(resetAt.timeIntervalSince1970)) }
        if let resetHeader { headers["x-ratelimit-reset"] = resetHeader }
        return .response(statusCode: 403, headers: headers, body: Data("API rate limit exceeded".utf8))
    }

    private static func apiReleaseJSON() -> Data {
        Data("""
        {
          "tag_name": "v1.3.9",
          "name": "v1.3.9",
          "html_url": "\(tagURL)",
          "assets": [
            {
              "name": "TokenTrackerBar.dmg",
              "browser_download_url": "\(dmgURL)",
              "size": 900
            }
          ]
        }
        """.utf8)
    }

    private static func httpDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return formatter.string(from: date)
    }
}

private final class StubURLProtocol: URLProtocol {

    enum StubResponse {
        case response(statusCode: Int, headers: [String: String], body: Data)
        case redirect(to: String)
        case networkError
    }

    struct Call {
        let method: String
        let url: URL
    }

    static var handler: ((URLRequest) -> StubResponse)?
    static private(set) var calls: [Call] = []

    static func reset() {
        handler = nil
        calls = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.calls.append(Call(method: request.httpMethod ?? "GET", url: request.url!))
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        switch handler(request) {
        case .response(let statusCode, let headers, let body):
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !body.isEmpty {
                client?.urlProtocol(self, didLoad: body)
            }
            client?.urlProtocolDidFinishLoading(self)
        case .redirect(let location):
            // URLProtocol stubs sit past the CFNetwork auto-follow layer, so
            // the redirect must be reported explicitly via wasRedirectedTo;
            // the loading system then dispatches the follow-up request here.
            let redirectResponse = HTTPURLResponse(
                url: request.url!,
                statusCode: 302,
                httpVersion: "HTTP/1.1",
                headerFields: ["Location": location]
            )!
            var next = URLRequest(url: URL(string: location)!)
            next.httpMethod = request.httpMethod
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: redirectResponse)
        case .networkError:
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
        }
    }

    override func stopLoading() {}
}
