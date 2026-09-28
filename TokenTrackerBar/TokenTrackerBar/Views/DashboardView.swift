import SwiftUI

struct DashboardView: View {
    @ObservedObject var viewModel: DashboardViewModel
    @ObservedObject var serverManager: ServerManager
    @ObservedObject private var localization = LocalizationObserver.shared

    var body: some View {
        VStack(spacing: 0) {
            // Clawd companion replaces the old header + Today card
            ClawdCompanionView(viewModel: viewModel)

            switch serverManager.status {
            case .idle, .starting:
                ServerStartingView()
            case .running:
                if viewModel.isSyncing && viewModel.summary == nil {
                    syncingView
                } else if viewModel.isLoading && viewModel.summary == nil {
                    loadingView
                } else {
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVStack(spacing: 16) {
                            SummaryCardsView(
                                todayTokens: viewModel.todayTokens,
                                todayCost: viewModel.todayCost,
                                last7dTokens: viewModel.last7dTokens,
                                last7dActiveDays: viewModel.last7dActiveDays,
                                last30dTokens: viewModel.last30dTokens,
                                last30dAvgPerDay: viewModel.last30dAvgPerDay,
                                totalTokens: viewModel.totalTokens,
                                totalCost: viewModel.totalCost
                            )
                            UsageLimitsView(limits: viewModel.usageLimits, subscriptions: viewModel.subscriptions)
                            ActivityHeatmapView(
                                heatmap: viewModel.heatmap,
                                showsTransientLocalData: viewModel.activityShowsTransientLocalData
                            )
                            UsageTrendChartWrapper(
                                daily: viewModel.daily,
                                monthly: viewModel.monthly,
                                hourly: viewModel.hourly,
                                period: $viewModel.period,
                                onPeriodChange: { viewModel.switchPeriod($0) }
                            )
                            TopModelsView(models: viewModel.topModels)
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 4)
                        .padding(.bottom, 12)
                    }
                }
            case .failed(let message):
                ServerOfflineView(message: message) {
                    await serverManager.retry()
                    if serverManager.isServerRunning {
                        // A Dashboard window that gave up while the server was
                        // down keeps its stale overlay unless it is told to
                        // reload too. No-op when no window is open.
                        DashboardWindowController.shared.reload()
                        await viewModel.loadAll()
                    }
                }
            }

            Divider()
            FooterView()
        }
        .modifier(PopoverSurfaceBackground())
        .id(localization.revision)
    }

    private var syncingView: some View {
        VStack(spacing: 10) {
            Spacer()
            ProgressView()
                .controlSize(.regular)
            Text(Strings.syncingUsageData)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(Strings.syncingFirstLaunchHint)
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private var loadingView: some View {
        VStack(spacing: 10) {
            Spacer()
            ProgressView()
                .controlSize(.regular)
            Text(Strings.loadingData)
                .font(.caption)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

/// Popover backdrop. On macOS 26+ the content stays transparent so the system
/// `NSPopover` chrome's automatic Liquid Glass shows through (the popover hosts the
/// content over `NSGlassEffectView` — see `StatusBarController.setupPopover`). Older
/// systems keep the classic `.regularMaterial`.
private struct PopoverSurfaceBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26, *) {
            content
        } else {
            content.background(.regularMaterial)
        }
    }
}
