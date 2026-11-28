import XCTest
@testable import TokenTracker

/// Routing state is MainActor-isolated; transport callbacks enqueue work there.
private final class OwnershipURLProtocol: URLProtocol {
    @MainActor static var handler: ((OwnershipURLProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Task { @MainActor in
            guard let handler = Self.handler else {
                client?.urlProtocol(self, didFailWithError: URLError(.cancelled)); return
            }
            handler(self)
        }
    }
    override func stopLoading() {}
    @MainActor func respond(_ status: Int, _ json: String = "{}") {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
final class CloudOwnershipTests: XCTestCase {
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [OwnershipURLProtocol.self]
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 2
        return URLSession(configuration: config)
    }
    private func signIn(_ store: SessionStore, user: String) throws {
        let json = "{\"accessToken\":\"new-token\",\"refreshToken\":\"new-refresh\",\"user\":{\"id\":\"\(user)\"}}"
        try store.signIn(with: JSONDecoder().decode(AuthResponse.self, from: Data(json.utf8)))
    }
    func testDelayedResponsesCannotReplayOrPublishAfterSwitchOrSameUserReauth() async throws {
        for user in ["A", "B"] {
            for status in [200, 401, 404] {
                let transport = session()
                let store = SessionStore(auth: CloudAuthClient(session: transport), restore: false,
                    initialSession: CloudSession(accessToken: "A-token", refreshToken: "A-refresh", user: CloudUser(id: "A")))
                let client = CloudAPIClient(sessions: store, urlSession: transport)
                let started = expectation(description: "A request started")
                let finished = expectation(description: "stale request cancelled")
                var held: OwnershipURLProtocol?
                var count = 0
                OwnershipURLProtocol.handler = { request in
                    count += 1
                    if count == 1 { held = request; started.fulfill() }
                    else { XCTFail("Stale request retried, refreshed or read a profile"); request.respond(500) }
                }
                let task = Task {
                    do { _ = try await client.updatePublicVisibility(PublicVisibilityPatch(enabled: true)); XCTFail("Stale success") }
                    catch { XCTAssertTrue(error is CancellationError, "\(error)") }
                    finished.fulfill()
                }
                await fulfillment(of: [started], timeout: 3)
                try signIn(store, user: user)
                held?.respond(status)
                await fulfillment(of: [finished], timeout: 3)
                XCTAssertEqual(count, 1)
                XCTAssertEqual(store.session?.user.id, user)
                task.cancel(); transport.invalidateAndCancel(); OwnershipURLProtocol.handler = nil
            }
        }
    }
    func testSameSession401RefreshAndLegacyFallbackKeepGeneration() async {
        let transport = session()
        defer { transport.invalidateAndCancel(); OwnershipURLProtocol.handler = nil }
        let store = SessionStore(auth: CloudAuthClient(session: transport), restore: false,
            initialSession: CloudSession(accessToken: "A-token", refreshToken: "A-refresh", user: CloudUser(id: "A")))
        let owner = store.sessionGeneration
        let client = CloudAPIClient(sessions: store, urlSession: transport)
        var calls = 0
        var posts: [URLRequest] = []
        OwnershipURLProtocol.handler = { request in
            calls += 1
            switch calls {
            case 1: posts.append(request.request); request.respond(404)
            case 2: posts.append(request.request); request.respond(401)
            case 3:
                XCTAssertTrue(request.request.url!.path.contains("/auth/refresh"))
                request.respond(200, "{\"accessToken\":\"refreshed\",\"refreshToken\":\"r2\"}")
            case 4: posts.append(request.request); request.respond(200)
            case 5: request.respond(200, "{\"display_name\":\"A\"}")
            default: XCTFail("Unexpected retry"); request.respond(500)
            }
        }
        let done = expectation(description: "retry finished")
        let task = Task {
            do {
                let profile = try await client.updatePublicVisibility(PublicVisibilityPatch(enabled: true))
                XCTAssertEqual(profile.displayName, "A")
            } catch { XCTFail("\(error)") }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 3); task.cancel()
        XCTAssertEqual(calls, 5)
        XCTAssertEqual(store.sessionGeneration, owner)
        XCTAssertEqual(posts.map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer A-token", "Bearer A-token", "Bearer refreshed"])
        XCTAssertEqual(posts.map(\.httpMethod), ["POST", "POST", "POST"])
    }
    func testSwitchDuringRefreshDoesNotSendMutationWithNewToken() async throws {
        let transport = session()
        defer { transport.invalidateAndCancel(); OwnershipURLProtocol.handler = nil }
        let store = SessionStore(auth: CloudAuthClient(session: transport), restore: false,
            initialSession: CloudSession(accessToken: "A", refreshToken: "refresh-A", user: CloudUser(id: "A")))
        let client = CloudAPIClient(sessions: store, urlSession: transport)
        let started = expectation(description: "refresh suspended")
        let done = expectation(description: "cancelled")
        var held: OwnershipURLProtocol?
        var count = 0
        OwnershipURLProtocol.handler = { request in
            count += 1
            if count == 1 { request.respond(401) }
            else if count == 2 { held = request; started.fulfill() }
            else { XCTFail("Replayed after switch"); request.respond(500) }
        }
        let task = Task {
            do { try await client.renameDevice(deviceId: "A", name: "old"); XCTFail("Expected cancellation") }
            catch { XCTAssertTrue(error is CancellationError, "\(error)") }
            done.fulfill()
        }
        await fulfillment(of: [started], timeout: 3)
        try signIn(store, user: "B")
        held?.respond(200, "{\"accessToken\":\"old-refreshed\"}")
        await fulfillment(of: [done], timeout: 3); task.cancel()
        XCTAssertEqual(count, 2)
        XCTAssertEqual(store.session?.accessToken, "new-token")
    }
    func testCancellationIsNotWrappedOrRetried() async {
        let transport = session()
        defer { transport.invalidateAndCancel(); OwnershipURLProtocol.handler = nil }
        let store = SessionStore(restore: false, initialSession: CloudSession(accessToken: "A", user: CloudUser(id: "A")))
        let client = CloudAPIClient(sessions: store, urlSession: transport)
        var count = 0
        OwnershipURLProtocol.handler = { request in count += 1; request.client?.urlProtocol(request, didFailWithError: URLError(.cancelled)) }
        let done = expectation(description: "cancelled")
        let task = Task {
            do { _ = try await client.publicVisibility(); XCTFail("Expected cancellation") }
            catch { XCTAssertTrue(error is CancellationError) }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 3); task.cancel()
        XCTAssertEqual(count, 1); XCTAssertTrue(store.isSignedIn)
    }
}

/// Every fake suspension has a deadline, even if a regression skips its release.
@MainActor
private final class OwnershipGate<T> {
    let entered = XCTestExpectation(description: "provider suspended")
    private var continuation: CheckedContinuation<T, Error>?
    func wait() async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation; entered.fulfill()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.finish(.failure(URLError(.timedOut))) }
        }
    }
    func finish(_ result: Result<T, Error>) { let pending = continuation; continuation = nil; pending?.resume(with: result) }
}
@MainActor
private final class OwnershipProvider: CloudDataProviding {
    var tokens = 1
    var failingDay: String?
    var failingBreakdownFrom: String?
    var failingHourlyDay: String?
    var observedDevices: [String?] = []
    var machinesGate: OwnershipGate<CloudMachineListResponse>?
    var actionGate: OwnershipGate<Void>?
    var profileGate: OwnershipGate<PublicVisibilityState>?
    var heatmapGate: OwnershipGate<HeatmapResponse>?
    var summaryGate: OwnershipGate<UsageSummaryResponse>?
    var accountCalls = 0
    var summaryCalls = 0
    func summary(from: String, to: String, deviceId: String?) async throws -> UsageSummaryResponse {
        summaryCalls += 1
        observedDevices.append(deviceId)
        if from == to, from == failingDay { throw URLError(.badServerResponse) }
        if let gate = summaryGate { summaryGate = nil; return try await gate.wait() }
        return UsageSummaryResponse(totals: TokenTotals(totalTokens: tokens))
    }
    func daily(from: String, to: String, deviceId: String?) async throws -> PhoneDailyUsageResponse { .init() }
    func hourly(day: String, deviceId: String?) async throws -> PhoneHourlyUsageResponse {
        observedDevices.append(deviceId)
        if day == failingHourlyDay { throw URLError(.badServerResponse) }
        return .init()
    }
    func modelBreakdown(from: String, to: String, deviceId: String?) async throws -> ModelBreakdownResponse {
        observedDevices.append(deviceId)
        if from == failingBreakdownFrom { throw URLError(.badServerResponse) }
        return .init()
    }
    func heatmap(weeks: Int, to: String, deviceId: String?) async throws -> HeatmapResponse {
        if let gate = heatmapGate { heatmapGate = nil; return try await gate.wait() }; return HeatmapResponse(weeks: [])
    }
    func accountDevices(from: String, to: String) async throws -> AccountDevicesResponse { .init() }
    func cloudAccountStatus() async throws -> CloudAccountStatusResponse { accountCalls += 1; return .init() }
    func cloudMachines() async throws -> CloudMachineListResponse {
        if let gate = machinesGate { machinesGate = nil; return try await gate.wait() }; return .init()
    }
    func publicVisibility() async throws -> PublicVisibilityState {
        if let gate = profileGate { profileGate = nil; return try await gate.wait() }; return .init(displayName: "current")
    }
    func updatePublicVisibility(_ patch: PublicVisibilityPatch) async throws -> PublicVisibilityState { try await publicVisibility() }
    func setMachinePaused(machineId: String, paused: Bool) async throws { try await action() }
    func renameDevice(deviceId: String, name: String) async throws { try await action() }
    func authorizeCLIDevice(userCode: String) async throws { try await action() }
    private func action() async throws { if let gate = actionGate { actionGate = nil; try await gate.wait() } }
}
@MainActor
final class WorkspaceOwnershipTests: XCTestCase {
    func testFailedTodayNeverBorrowsMonthAndPacingFailuresWarn() async {
        let now = DayKey.date("2026-11-15")!
        for failure in ["today", "week", "month", "yesterday"] {
            let provider = OwnershipProvider()
            provider.tokens = 120
            switch failure {
            case "today": provider.failingDay = DayKey.string(now)
            case "week": provider.failingBreakdownFrom = DayKey.daysAgo(6, now: now)
            case "month": provider.failingBreakdownFrom = DayKey.daysAgo(29, now: now)
            default: provider.failingHourlyDay = DayKey.daysAgo(1, now: now)
            }
            let model = WorkspaceModel(client: provider, nowProvider: { now })
            model.horizon = .month
            model.selectedDeviceId = "computer-A"
            await model.refresh()
            XCTAssertEqual(model.phase, .loaded)
            XCTAssertNotNil(model.warningBanner)
            XCTAssertEqual(model.snapshot?.pacingAvailable, false)
            XCTAssertEqual(model.snapshot?.periodSummary.totals.totalTokens, 120)
            if failure == "today" { XCTAssertNil(model.snapshot?.todaySummary) }
            XCTAssertTrue(provider.observedDevices.allSatisfy { $0 == "computer-A" })
        }
    }

    private func complete(_ operation: @escaping @MainActor () async throws -> Void, cancelled: Bool = false) -> (Task<Void, Never>, XCTestExpectation) {
        let done = expectation(description: "operation finished")
        let task = Task { @MainActor in
            do { try await operation(); if cancelled { XCTFail("Expected cancellation") } }
            catch { if cancelled { XCTAssertTrue(error is CancellationError, "\(error)") } else { XCTFail("\(error)") } }
            done.fulfill()
        }
        return (task, done)
    }
    func testDeviceAndPairingMergeCurrentPeriodAndRejectResetOrAccountSwitch() async {
        for pairing in [false, true] {
            for change in ["period", "reset", "account"] {
                var generation = 0
                let provider = OwnershipProvider()
                let model = WorkspaceModel(client: provider, generationProvider: { generation })
                await model.refresh()
                let gate = OwnershipGate<CloudMachineListResponse>(); provider.machinesGate = gate
                let (task, done) = complete({
                    if pairing { try await model.authorizeCLIDevice(code: "ABCD-EFGH") }
                    else { try await model.setMachinePaused("A", paused: true) }
                }, cancelled: change != "period")
                await fulfillment(of: [gate.entered], timeout: 3)
                if change == "reset" { model.reset() }
                if change == "account" { generation += 1 }
                provider.tokens = 99; await model.refresh()
                model.horizon = .month; model.selectedDeviceId = "new-filter"; await model.refresh()
                let calls = provider.accountCalls
                gate.finish(.success(CloudMachineListResponse(machineCount: 7)))
                await fulfillment(of: [done], timeout: 3); task.cancel()
                XCTAssertEqual(model.snapshot?.periodSummary.totals.totalTokens, 99)
                XCTAssertEqual(model.snapshot?.horizon, .month)
                XCTAssertEqual(model.snapshot?.selectedDeviceId, "new-filter")
                if change == "period" { XCTAssertEqual(model.snapshot?.cloudMachines?.machineCount, 7) }
                else { XCTAssertEqual(provider.accountCalls, calls) }
            }
        }
    }
    func testActionAndRenameNeverStartFollowupsForNewAccount() async {
        for operation in ["pause", "pair", "rename"] {
            var generation = 0
            let provider = OwnershipProvider(); let model = WorkspaceModel(client: provider, generationProvider: { generation })
            await model.refresh()
            let gate = OwnershipGate<Void>(); provider.actionGate = gate
            let (task, done) = complete({
                switch operation {
                case "pause": try await model.setMachinePaused("A", paused: true)
                case "pair": try await model.authorizeCLIDevice(code: "ABCD-EFGH")
                default: try await model.renameDevice("A", name: "old")
                }
            }, cancelled: true)
            await fulfillment(of: [gate.entered], timeout: 3); generation += 1
            let calls = (provider.accountCalls, provider.summaryCalls)
            gate.finish(.success(())); await fulfillment(of: [done], timeout: 3); task.cancel()
            XCTAssertEqual(provider.accountCalls, calls.0); XCTAssertEqual(provider.summaryCalls, calls.1)
        }
    }
    func testStaleProfileLoadAndMutationCannotPublish() async {
        for mutation in [false, true] {
            var generation = 0
            let provider = OwnershipProvider(); let model = WorkspaceModel(client: provider, generationProvider: { generation })
            let gate = OwnershipGate<PublicVisibilityState>(); provider.profileGate = gate
            let (task, done) = complete({
                if mutation { try await model.updatePublicProfile(PublicVisibilityPatch(enabled: true)) }
                else { await model.loadPublicProfileIfNeeded() }
            }, cancelled: mutation)
            await fulfillment(of: [gate.entered], timeout: 3); generation += 1; await model.refresh()
            gate.finish(.success(PublicVisibilityState(displayName: "old A")))
            await fulfillment(of: [done], timeout: 3); task.cancel()
            XCTAssertEqual(model.publicProfile?.displayName, "current")
        }
    }
    func testShareRejectsStaleResponsesAndCancellationInsteadOfFallback() async {
        for outcome in ["success", "failure", "cancel"] {
            var generation = 0
            let provider = OwnershipProvider(); let model = WorkspaceModel(client: provider, generationProvider: { generation })
            await model.refresh()
            let gate = OwnershipGate<HeatmapResponse>(); provider.heatmapGate = gate
            let (task, done) = complete({ _ = try await model.shareHeatmap() }, cancelled: true)
            await fulfillment(of: [gate.entered], timeout: 3)
            if outcome != "cancel" { generation += 1 }
            if outcome == "success" { gate.finish(.success(HeatmapResponse(weeks: []))) }
            else if outcome == "cancel" { gate.finish(.failure(CancellationError())) }
            else { gate.finish(.failure(URLError(.notConnectedToInternet))) }
            await fulfillment(of: [done], timeout: 3); task.cancel()
        }
    }
    func testReplacedLoadCannotPublishOrClearNewRefreshingFlag() async {
        var generation = 0
        let provider = OwnershipProvider(); let model = WorkspaceModel(client: provider, generationProvider: { generation })
        let old = OwnershipGate<UsageSummaryResponse>(); provider.summaryGate = old
        let (oldTask, oldDone) = complete { await model.refresh() }
        await fulfillment(of: [old.entered], timeout: 3); generation += 1
        let newer = OwnershipGate<UsageSummaryResponse>(); provider.summaryGate = newer
        let (newTask, newDone) = complete { await model.refresh() }
        await fulfillment(of: [newer.entered], timeout: 3)
        old.finish(.success(UsageSummaryResponse(totals: TokenTotals(totalTokens: 1))))
        await fulfillment(of: [oldDone], timeout: 3)
        XCTAssertTrue(model.isRefreshing); XCTAssertNil(model.snapshot)
        newer.finish(.success(UsageSummaryResponse(totals: TokenTotals(totalTokens: 99))))
        await fulfillment(of: [newDone], timeout: 3); oldTask.cancel(); newTask.cancel()
        XCTAssertFalse(model.isRefreshing); XCTAssertEqual(model.phase, .loaded)
    }
}
