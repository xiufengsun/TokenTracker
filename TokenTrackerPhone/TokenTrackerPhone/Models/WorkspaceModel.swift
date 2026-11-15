import Foundation
import SwiftUI

enum AppTab: String, CaseIterable, Identifiable {
    case pulse
    case limits
    case settings

    var id: String { rawValue }
}

@MainActor
final class WorkspaceModel: ObservableObject {
    enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case cloudAccessRequired(code: String)
        case failed(String)
    }

    @Published var selectedTab: AppTab = .pulse
    @Published var horizon: UsageHorizon = .today
    @Published var selectedDeviceId: String? = nil

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var snapshot: PhoneWorkspaceSnapshot?
    @Published private(set) var publicProfile: PublicVisibilityState?
    @Published private(set) var warningBanner: String?
    @Published private(set) var isRefreshing: Bool = false

    var visibleSnapshot: PhoneWorkspaceSnapshot? {
        guard let snapshot else { return nil }
        return snapshot.horizon == horizon && snapshot.selectedDeviceId == selectedDeviceId ? snapshot : nil
    }

    private let client: any CloudDataProviding
    private var loadTask: Task<Void, Never>?
    private let nowProvider: () -> Date
    private let generationProvider: @MainActor () -> Int
    var contentGeneration: Int { modelGeneration }
    private var modelGeneration: Int
    private var resetEpoch = 0
    private var loadEpoch = 0

    struct Ownership: Equatable {
        fileprivate let generation: Int
        fileprivate let epoch: Int
    }

    func operationOwnership() -> Ownership {
        if modelGeneration != generationProvider() { reset() }
        return Ownership(generation: generationProvider(), epoch: resetEpoch)
    }

    func validateOwnership(_ owner: Ownership) throws {
        try Task.checkCancellation()
        guard owner.generation == generationProvider(), owner.epoch == resetEpoch else {
            throw CancellationError()
        }
    }

    private func owned<T>(_ owner: Ownership, _ op: () async throws -> T) async throws -> T {
        try validateOwnership(owner)
        do {
            let value = try await op()
            try validateOwnership(owner)
            return value
        } catch {
            try validateOwnership(owner)
            if (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw error
        }
    }

    static let trendDays = 30
    static let heatmapWeeks = 18

    init(client: any CloudDataProviding, nowProvider: @escaping () -> Date = Date.init, generationProvider: @escaping @MainActor () -> Int = { 0 }) {
        self.client = client
        self.nowProvider = nowProvider
        self.generationProvider = generationProvider
        self.modelGeneration = generationProvider()
    }

    convenience init(sessions: SessionStore) {
        self.init(client: CloudAPIClient(sessions: sessions), generationProvider: { sessions.sessionGeneration })
    }

    func refresh() async {
        guard !Task.isCancelled else { return }
        let owner = operationOwnership()
        loadEpoch += 1
        let epoch = loadEpoch
        loadTask?.cancel()
        let targetHorizon = horizon
        let targetDevice = selectedDeviceId
        let task = Task {
            await load(horizon: targetHorizon, deviceId: targetDevice, owner: owner, epoch: epoch)
        }
        loadTask = task
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }

    func reset() {
        resetEpoch += 1
        loadEpoch += 1
        modelGeneration = generationProvider()
        isRefreshing = false
        loadTask?.cancel()
        snapshot = nil
        publicProfile = nil
        warningBanner = nil
        phase = .idle
        selectedDeviceId = nil
        horizon = .today
        selectedTab = .pulse
    }

    func loadPublicProfileIfNeeded() async {
        let owner = operationOwnership()
        guard publicProfile == nil else { return }
        do {
            let value = try await owned(owner) { try await client.publicVisibility() }
            publicProfile = value
        } catch { /* Optional profile; cancelled ownership never publishes. */ }
    }

    func updatePublicProfile(_ patch: PublicVisibilityPatch) async throws {
        let owner = operationOwnership()
        publicProfile = try await owned(owner) { try await client.updatePublicVisibility(patch) }
    }

    func setMachinePaused(_ machineId: String, paused: Bool) async throws {
        let owner = operationOwnership()
        try await owned(owner) { try await client.setMachinePaused(machineId: machineId, paused: paused) }
        try await reloadMachineFields(owner)
    }

    private func reloadMachineFields(_ owner: Ownership) async throws {
        try validateOwnership(owner)
        guard snapshot != nil else { return }
        let machines = try await Self.capture { try await owned(owner) { try await client.cloudMachines() } }
        let account = try await Self.capture { try await owned(owner) { try await client.cloudAccountStatus() } }
        try validateOwnership(owner)
        // Read the current snapshot only after suspension: period/filter loads may have finished.
        snapshot?.cloudMachines = machines.value
        snapshot?.cloudAccount = account.value
    }

    func renameDevice(_ deviceId: String, name: String) async throws {
        let owner = operationOwnership()
        try await owned(owner) { try await client.renameDevice(deviceId: deviceId, name: name) }
        try validateOwnership(owner)
        await refresh()
    }

    /// Ordinary Cloud failures may use the Pulse heatmap; cancellation never does.
    func shareHeatmap() async throws -> HeatmapResponse? {
        let owner = operationOwnership()
        guard let snapshot else { return nil }
        let year = try await Self.capture {
            try await owned(owner) {
                try await client.heatmap(weeks: Self.shareHeatmapWeeks,
                    to: DayKey.string(snapshot.now), deviceId: snapshot.selectedDeviceId)
            }
        }
        try validateOwnership(owner)
        return year.value ?? snapshot.heatmap
    }

    static let shareHeatmapWeeks = 52

    func authorizeCLIDevice(code: String) async throws {
        let owner = operationOwnership()
        try await owned(owner) { try await client.authorizeCLIDevice(userCode: code) }
        try await reloadMachineFields(owner)
    }

    private func load(horizon: UsageHorizon, deviceId: String?, owner: Ownership, epoch: Int) async {
        guard (try? validateOwnership(owner)) != nil, epoch == loadEpoch else { return }
        let hadMatchingSnapshot = visibleSnapshot != nil
        if !hadMatchingSnapshot {
            phase = .loading
        }
        isRefreshing = true
        defer { if epoch == loadEpoch && owner.generation == generationProvider() { isRefreshing = false } }

        let now = nowProvider()
        let today = DayKey.string(now)
        let yesterday = DayKey.daysAgo(1, now: now)
        let range = horizon.range(now: now)
        let sevenAgo = DayKey.daysAgo(6, now: now)
        let thirtyAgo = DayKey.daysAgo(Self.trendDays - 1, now: now)
        let client = self.client

        async let periodSummaryCall = owned(owner) { try await client.summary(from: range.from, to: range.to, deviceId: deviceId) }
        async let todaySummaryCall = Self.capture { try await owned(owner) { try await client.summary(from: today, to: today, deviceId: deviceId) } }
        async let dailyCall = Self.capture { try await owned(owner) { try await client.daily(from: thirtyAgo, to: today, deviceId: deviceId) } }
        async let todayHourlyCall = Self.capture { try await owned(owner) { try await client.hourly(day: today, deviceId: deviceId) } }
        async let yesterdayHourlyCall = Self.capture { try await owned(owner) { try await client.hourly(day: yesterday, deviceId: deviceId) } }
        async let periodBreakdownCall = Self.capture { try await owned(owner) { try await client.modelBreakdown(from: range.from, to: range.to, deviceId: deviceId) } }
        async let weeklyBreakdownCall = Self.capture { try await owned(owner) { try await client.modelBreakdown(from: sevenAgo, to: today, deviceId: deviceId) } }
        async let monthlyBreakdownCall = Self.capture { try await owned(owner) { try await client.modelBreakdown(from: thirtyAgo, to: today, deviceId: deviceId) } }
        async let heatmapCall = Self.capture { try await owned(owner) { try await client.heatmap(weeks: Self.heatmapWeeks, to: today, deviceId: deviceId) } }
        async let devicesCall = Self.capture { try await owned(owner) { try await client.accountDevices(from: thirtyAgo, to: today) } }
        async let cloudAccountCall = Self.capture { try await owned(owner) { try await client.cloudAccountStatus() } }
        async let cloudMachinesCall = Self.capture { try await owned(owner) { try await client.cloudMachines() } }
        async let profileCall = Self.capture { try await owned(owner) { try await client.publicVisibility() } }

        do {
            let periodSummary = try await periodSummaryCall
            let todaySummaryRes = try await todaySummaryCall
            let dailyRes = try await dailyCall
            let todayHourlyRes = try await todayHourlyCall
            let yesterdayHourlyRes = try await yesterdayHourlyCall
            let periodBreakdownRes = try await periodBreakdownCall
            let weeklyBreakdownRes = try await weeklyBreakdownCall
            let monthlyBreakdownRes = try await monthlyBreakdownCall
            let heatmapRes = try await heatmapCall
            let devicesRes = try await devicesCall
            let cloudAccountRes = try await cloudAccountCall
            let cloudMachinesRes = try await cloudMachinesCall
            let profileRes = try await profileCall

            let coreErrors = [
                todaySummaryRes.error,
                dailyRes.error,
                todayHourlyRes.error,
                yesterdayHourlyRes.error,
                weeklyBreakdownRes.error,
                monthlyBreakdownRes.error,
                periodBreakdownRes.error,
                heatmapRes.error,
            ].compactMap { $0 }

            if let denied = coreErrors.first(where: {
                if case .cloudAccessRequired = $0 as? CloudError { return true }
                return false
            }) {
                throw denied
            }

            try validateOwnership(owner)
            guard epoch == loadEpoch else { return }

            if let profileValue = profileRes.value {
                publicProfile = profileValue
            }

            let resolvedTodaySummary = (horizon == .today)
                ? periodSummary
                : todaySummaryRes.value

            snapshot = PhoneWorkspaceSnapshot(
                horizon: horizon,
                selectedDeviceId: deviceId,
                now: now,
                periodSummary: periodSummary,
                todaySummary: resolvedTodaySummary,
                daily30d: dailyRes.value,
                todayHourly: todayHourlyRes.value,
                yesterdayHourly: yesterdayHourlyRes.value,
                periodBreakdown: periodBreakdownRes.value,
                weeklyBreakdown: weeklyBreakdownRes.value,
                monthlyBreakdown: monthlyBreakdownRes.value,
                heatmap: heatmapRes.value,
                accountDevices: devicesRes.value,
                cloudAccount: cloudAccountRes.value,
                cloudMachines: cloudMachinesRes.value
            )

            warningBanner = coreErrors.isEmpty
                ? nil
                : "Some details couldn't load. Pull down to refresh."
            phase = .loaded
        } catch {
            guard (try? validateOwnership(owner)) != nil, epoch == loadEpoch else { return }
            apply(error)
        }
    }

    private func apply(_ error: Error) {
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
        switch error as? CloudError {
        case .cloudAccessRequired(let code):
            snapshot = nil
            warningBanner = nil
            phase = .cloudAccessRequired(code: code)
        case .signedOut:
            phase = .failed("Session expired or rejected. Pull to retry, or sign out in Settings.")
        default:
            if visibleSnapshot != nil {
                warningBanner = error.localizedDescription
                phase = .loaded
            } else {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    private struct SectionCapture<T> {
        let value: T?
        let error: Error?
    }

    private static func capture<T>(_ op: () async throws -> T) async throws -> SectionCapture<T> {
        do {
            return SectionCapture(value: try await op(), error: nil)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            return SectionCapture(value: nil, error: error)
        }
    }
}
