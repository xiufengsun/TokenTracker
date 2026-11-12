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
        do {
            async let summary = client.summary(from: range.from, to: range.to)
            async let daily = client.daily(from: trendFrom, to: today)
            async let breakdown = client.modelBreakdown(from: range.from, to: range.to)
            async let heatmap = client.heatmap(weeks: Self.heatmapWeeks, to: today)
            let next = UsageSnapshot(
                period: period,
                summary: try await summary,
                daily: try await daily,
                breakdown: try await breakdown,
                heatmap: try await heatmap,
                fetchedAt: Date()
            )
            guard !Task.isCancelled else { return }
            snapshot = next
            phase = .loaded
        } catch is CancellationError {
            return
        } catch let error as CloudError {
            guard !Task.isCancelled else { return }
            switch error {
            case .cloudAccessRequired(let code):
                snapshot = nil
                phase = .cloudAccessRequired(code: code)
            case .signedOut:
                phase = .idle
            default:
                phase = .failed(error.localizedDescription)
            }
        } catch {
            guard !Task.isCancelled else { return }
            if (error as? URLError)?.code == .cancelled { return }
            phase = .failed(error.localizedDescription)
        }
    }
}
