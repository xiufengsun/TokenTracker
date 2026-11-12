import Foundation

@MainActor
final class DashboardModel: ObservableObject {
    enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case cloudAccessRequired(code: String)
        case failed(String)
    }

    @Published var period: UsagePeriod = .day
    @Published private(set) var phase: Phase = .idle
    /// Last good data, kept on screen while refreshing or after a failure.
    @Published private(set) var snapshot: UsageSnapshot?

    private let client: CloudUsageClient
    private var loadTask: Task<Void, Never>?

    /// Trend window and heatmap size that fit a phone screen.
    static let trendDays = 30
    static let heatmapWeeks = 17

    init(sessions: SessionStore) {
        self.client = CloudUsageClient(sessions: sessions)
    }

    func refresh() async {
        loadTask?.cancel()
        let task = Task { await load(period: period) }
        loadTask = task
        await task.value
    }

    func reset() {
        loadTask?.cancel()
        snapshot = nil
        phase = .idle
    }

    private func load(period: UsagePeriod) async {
        phase = .loading
        let range = period.range()
        let today = DayFormat.string(Date())
        let trendFrom = DayFormat.daysAgo(Self.trendDays - 1)
        let client = self.client
        // The summary is the screen's main content; the other sections load
        // independently so one failing endpoint can't hide the rest.
        async let summary = client.summary(from: range.from, to: range.to)
        async let daily = Self.capture { try await client.daily(from: trendFrom, to: today) }
        async let breakdown = Self.capture { try await client.modelBreakdown(from: range.from, to: range.to) }
        async let heatmap = Self.capture { try await client.heatmap(weeks: Self.heatmapWeeks, to: today) }
        do {
            let summaryValue = try await summary
            let sections = (daily: await daily, breakdown: await breakdown, heatmap: await heatmap)
            let failures = [sections.daily.error, sections.breakdown.error, sections.heatmap.error].compactMap { $0 }
            if let denied = failures.first(where: { if case .cloudAccessRequired = $0 as? CloudError { return true } else { return false } }) {
                throw denied
            }
            guard !Task.isCancelled else { return }
            snapshot = UsageSnapshot(
                period: period,
                summary: summaryValue,
                daily: sections.daily.value,
                breakdown: sections.breakdown.value,
                heatmap: sections.heatmap.value,
                fetchedAt: Date()
            )
            phase = failures.isEmpty ? .loaded : .failed("Some sections couldn't load. Pull down to try again.")
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
            phase = .cloudAccessRequired(code: code)
        case .signedOut:
            // A rejected refresh token already signed the app out. Reaching here
            // still signed in means the server refused a freshly refreshed token.
            phase = .failed("The server didn't accept this sign-in. Pull down to retry, or sign out and back in.")
        default:
            phase = .failed(error.localizedDescription)
        }
    }

    private static func capture<T>(_ operation: () async throws -> T) async -> SectionResult<T> {
        do {
            return SectionResult(value: try await operation(), error: nil)
        } catch {
            return SectionResult(value: nil, error: error)
        }
    }
}

struct SectionResult<T> {
    let value: T?
    let error: Error?
}
