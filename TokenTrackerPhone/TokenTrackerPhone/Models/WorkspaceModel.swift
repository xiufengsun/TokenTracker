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

    static let trendDays = 30
    static let heatmapWeeks = 18

    init(client: any CloudDataProviding, nowProvider: @escaping () -> Date = Date.init) {
        self.client = client
        self.nowProvider = nowProvider
    }

    convenience init(sessions: SessionStore) {
        self.init(client: CloudAPIClient(sessions: sessions))
    }

    func refresh() async {
        loadTask?.cancel()
        let targetHorizon = horizon
        let targetDevice = selectedDeviceId
        let task = Task {
            await load(horizon: targetHorizon, deviceId: targetDevice)
        }
        loadTask = task
        await task.value
    }

    func reset() {
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
        guard publicProfile == nil else { return }
        publicProfile = try? await client.publicVisibility()
    }

    func updatePublicProfile(_ patch: PublicVisibilityPatch) async throws {
        let updated = try await client.updatePublicVisibility(patch)
        publicProfile = updated
    }

    func setMachinePaused(_ machineId: String, paused: Bool) async throws {
        try await client.setMachinePaused(machineId: machineId, paused: paused)
        if var snap = snapshot {
            snap.cloudMachines = try? await client.cloudMachines()
            snap.cloudAccount = try? await client.cloudAccountStatus()
            snapshot = snap
        }
    }

    func renameDevice(_ deviceId: String, name: String) async throws {
        try await client.renameDevice(deviceId: deviceId, name: name)
        await refresh()
    }

    func authorizeCLIDevice(code: String) async throws {
        try await client.authorizeCLIDevice(userCode: code)
        if var snap = snapshot {
            snap.cloudMachines = try? await client.cloudMachines()
            snap.cloudAccount = try? await client.cloudAccountStatus()
            snapshot = snap
        }
    }

    private func load(horizon: UsageHorizon, deviceId: String?) async {
        let hadMatchingSnapshot = visibleSnapshot != nil
        if !hadMatchingSnapshot {
            phase = .loading
        }
        isRefreshing = true
        defer { isRefreshing = false }

        let now = nowProvider()
        let today = DayKey.string(now)
        let yesterday = DayKey.daysAgo(1, now: now)
        let range = horizon.range(now: now)
        let sevenAgo = DayKey.daysAgo(6, now: now)
        let thirtyAgo = DayKey.daysAgo(Self.trendDays - 1, now: now)
        let client = self.client

        async let periodSummaryCall = client.summary(from: range.from, to: range.to, deviceId: deviceId)
        async let todaySummaryCall = Self.capture { try await client.summary(from: today, to: today, deviceId: deviceId) }
        async let dailyCall = Self.capture { try await client.daily(from: thirtyAgo, to: today, deviceId: deviceId) }
        async let todayHourlyCall = Self.capture { try await client.hourly(day: today, deviceId: deviceId) }
        async let yesterdayHourlyCall = Self.capture { try await client.hourly(day: yesterday, deviceId: deviceId) }
        async let periodBreakdownCall = Self.capture { try await client.modelBreakdown(from: range.from, to: range.to, deviceId: deviceId) }
        async let weeklyBreakdownCall = Self.capture { try await client.modelBreakdown(from: sevenAgo, to: today, deviceId: deviceId) }
        async let monthlyBreakdownCall = Self.capture { try await client.modelBreakdown(from: thirtyAgo, to: today, deviceId: deviceId) }
        async let heatmapCall = Self.capture { try await client.heatmap(weeks: Self.heatmapWeeks, to: today, deviceId: deviceId) }
        async let devicesCall = Self.capture { try await client.accountDevices(from: thirtyAgo, to: today) }
        async let cloudAccountCall = Self.capture { try await client.cloudAccountStatus() }
        async let cloudMachinesCall = Self.capture { try await client.cloudMachines() }
        async let profileCall = Self.capture { try await client.publicVisibility() }

        do {
            let periodSummary = try await periodSummaryCall
            let todaySummaryRes = await todaySummaryCall
            let dailyRes = await dailyCall
            let todayHourlyRes = await todayHourlyCall
            let yesterdayHourlyRes = await yesterdayHourlyCall
            let periodBreakdownRes = await periodBreakdownCall
            let weeklyBreakdownRes = await weeklyBreakdownCall
            let monthlyBreakdownRes = await monthlyBreakdownCall
            let heatmapRes = await heatmapCall
            let devicesRes = await devicesCall
            let cloudAccountRes = await cloudAccountCall
            let cloudMachinesRes = await cloudMachinesCall
            let profileRes = await profileCall

            let coreErrors = [
                todaySummaryRes.error,
                dailyRes.error,
                todayHourlyRes.error,
                periodBreakdownRes.error,
                heatmapRes.error,
            ].compactMap { $0 }

            if let denied = coreErrors.first(where: {
                if case .cloudAccessRequired = $0 as? CloudError { return true }
                return false
            }) {
                throw denied
            }

            guard !Task.isCancelled else { return }

            if let profileValue = profileRes.value {
                publicProfile = profileValue
            }

            let resolvedTodaySummary = (horizon == .today)
                ? periodSummary
                : (todaySummaryRes.value ?? periodSummary)

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
            guard !Task.isCancelled else { return }
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

    private static func capture<T>(_ op: () async throws -> T) async -> SectionCapture<T> {
        do {
            return SectionCapture(value: try await op(), error: nil)
        } catch {
            return SectionCapture(value: nil, error: error)
        }
    }
}
