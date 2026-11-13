import Charts
import SwiftUI

struct PulseView: View {
    @EnvironmentObject private var prefs: PhonePreferences
    @EnvironmentObject private var sessions: SessionStore
    @ObservedObject var workspace: WorkspaceModel
    let onPairCLI: () -> Void

    @State private var selectedProvider: RankedProviderItem?
    @State private var shareRequest: ShareRequest?
    @State private var preparingShare = false

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackground()

                ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        controlStrip

                        if let warning = workspace.warningBanner {
                            InlineNoticeBanner(
                                icon: "exclamationmark.triangle.fill",
                                tint: Palette.warning,
                                message: warning,
                                actionTitle: "Retry"
                            ) {
                                Task { await workspace.refresh() }
                            }
                        }

                        if let snapshot = workspace.visibleSnapshot {
                            if isCompletelyEmpty(snapshot) {
                                EmptySyncedDataCard(onPairCLI: onPairCLI) {
                                    Task { await workspace.refresh() }
                                }
                            } else {
                                spendLedgerSection(snapshot)
                                pacingGlanceBridge(snapshot)
                                timelineChartSection(snapshot)
                                providerLedgerSection(snapshot)
                                    .id("tools")
                                modelBreakdownSection(snapshot)
                                    .id("models")
                                consistencyHeatmapSection(snapshot)
                                syncFootnote(snapshot)
                                    .id("footer")
                            }
                        } else if case .failed(let message) = workspace.phase {
                            WorkspaceFailureView(
                                message: message,
                                isBusy: workspace.isRefreshing,
                                onRetry: { Task { await workspace.refresh() } },
                                onOpenSettings: { workspace.selectedTab = .settings }
                            )
                        } else {
                            WorkspaceSkeletonView()
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 6)
                    .padding(.bottom, 28)
                }
                .refreshable {
                    await workspace.refresh()
                }
                .scrollEdgeEffectStyle(.hard, for: .bottom)
                .scenarioScrollAnchor(proxy)
                }
            }
            .navigationTitle("Pulse")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    deviceScopeMenu
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItem(placement: .topBarTrailing) {
                    shareButton
                }
            }
            .sheet(item: $selectedProvider) { provider in
                ProviderDetailSheet(provider: provider, horizonTitle: workspace.horizon.fullTitle)
            }
            .sheet(item: $shareRequest) { request in
                ShareCardSheet(
                    data: request.data,
                    caption: request.caption,
                    profileURL: request.url,
                    initialVariant: request.variant
                )
            }
            #if DEBUG
            .task(id: workspace.visibleSnapshot?.now) {
                guard let variant = SimulatorLaunchScenario.shareVariant, shareRequest == nil,
                      workspace.visibleSnapshot != nil else { return }
                await openShare(variant: variant)
            }
            #endif
        }
    }

    // MARK: - Share (dashboard ShareModal)

    struct ShareRequest: Identifiable {
        let id = UUID()
        let data: ShareCardData
        let caption: String
        let url: URL
        let variant: ShareCardVariant
    }

    /// Nothing to share until the current period has loaded with usage.
    private var shareableSnapshot: PhoneWorkspaceSnapshot? {
        guard let snapshot = workspace.visibleSnapshot, !isCompletelyEmpty(snapshot) else { return nil }
        return snapshot
    }

    private var shareButton: some View {
        Button {
            Task { await openShare(variant: .neon) }
        } label: {
            if preparingShare {
                ProgressView()
            } else {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        }
        .disabled(shareableSnapshot == nil || preparingShare)
        .accessibilityIdentifier("pulse.share")
    }

    private func openShare(variant: ShareCardVariant) async {
        guard let snapshot = shareableSnapshot else { return }
        preparingShare = true
        defer { preparingShare = false }
        let heatmap = await workspace.shareHeatmap()
        let data = ShareCardData.build(
            snapshot: snapshot,
            heatmap: heatmap,
            userName: sessions.session?.user.name,
            currency: prefs.currency,
            masksCost: prefs.discreteAmounts
        )
        guard data.isShareable else { return }
        shareRequest = ShareRequest(
            data: data,
            caption: ShareCaption.text(summaryTokens: data.totalTokens, breakdown: snapshot.periodBreakdown),
            url: ShareCaption.profileURL(userId: sessions.session?.user.id),
            variant: variant
        )
    }

    // MARK: - Top Liquid Glass Control Strip

    private var controlStrip: some View {
        GlassSegmentedControl(
            items: UsageHorizon.allCases,
            selection: $workspace.horizon,
            label: \.label,
            identifierPrefix: "pulse.horizon"
        )
    }

    private var deviceScopeMenu: some View {
        let devices = workspace.visibleSnapshot?.accountDevices?.devices ?? workspace.snapshot?.accountDevices?.devices ?? []
        let activeDevice = devices.first(where: { $0.id == workspace.selectedDeviceId })
        return Menu {
            Button {
                workspace.selectedDeviceId = nil
            } label: {
                Label(
                    "All Computers",
                    systemImage: workspace.selectedDeviceId == nil ? "checkmark.circle.fill" : "laptopcomputer.and.iphone"
                )
            }

            if !devices.isEmpty {
                Section("Filter by Computer") {
                    ForEach(devices) { device in
                        Button {
                            workspace.selectedDeviceId = device.id
                        } label: {
                            Label(
                                "\(device.displayName) (\(prefs.formatTokens(device.totalTokens)))",
                                systemImage: workspace.selectedDeviceId == device.id ? "checkmark.circle.fill" : "desktopcomputer"
                            )
                        }
                    }
                }
            }

            Divider()

            Button(action: onPairCLI) {
                Label("Approve CLI Code", systemImage: "terminal")
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: activeDevice == nil ? "laptopcomputer.and.iphone" : "desktopcomputer")
                    .font(.footnote.weight(.semibold))
                Text(activeDevice?.displayName ?? "All Computers")
                    .font(.footnote.weight(.medium))
                    .lineLimit(1)
            }
            .accessibilityIdentifier("pulse.deviceMenu")
        }
    }

    // MARK: - 1. Spend & Token Ledger

    private func spendLedgerSection(_ snapshot: PhoneWorkspaceSnapshot) -> some View {
        let totals = snapshot.periodSummary.totals
        let cost = snapshot.periodCostUsd
        let dailyAvg = snapshot.averageDailyCost30d
        let showTodayVsAvg = workspace.horizon == .today && dailyAvg > 0.01 && cost > 0

        return TelemetrySurface(padding: 20) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .firstTextBaseline) {
                    Text(workspace.horizon.fullTitle)
                        .font(.headline)
                    Spacer()
                    if showTodayVsAvg {
                        let ratio = cost / dailyAvg
                        let deltaText = ratio >= 1.05
                            ? "\(String(format: "%.1f×", ratio)) 30d avg"
                            : "\(Int((ratio * 100).rounded()))% of 30d avg"
                        Text(deltaText)
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(Color.primary.opacity(0.07), in: Capsule())
                    } else if let count = snapshot.cloudAccount?.machineCount, count > 0, workspace.selectedDeviceId == nil {
                        Text("\(count) \(count == 1 ? "computer" : "computers")")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                }

                HStack(alignment: .lastTextBaseline, spacing: 16) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(prefs.formatCost(cost))
                            .font(.system(.largeTitle, design: .rounded).weight(.bold))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                        Text("Estimated cost")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Spacer(minLength: 8)

                    VStack(alignment: .trailing, spacing: 3) {
                        Text(prefs.formatTokens(totals.displayTokens))
                            .font(.title2.weight(.semibold))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                        Text("\(totals.conversationCount.formatted()) sessions")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }

                if workspace.horizon == .today && prefs.dailySpendTargetUsd > 0 {
                    let fraction = cost / prefs.dailySpendTargetUsd
                    let remaining = prefs.windowMeterStyle == .remaining
                    let barPct = remaining ? max(0, (1 - fraction) * 100) : min(100, fraction * 100)
                    let endOfDay = Calendar.localGregorian.date(
                        byAdding: .day,
                        value: 1,
                        to: Calendar.localGregorian.startOfDay(for: snapshot.now)
                    ) ?? snapshot.now
                    let pace = LimitPace.compute(
                        usedFraction: min(max(fraction, 0), 1),
                        windowSeconds: 86_400,
                        secondsUntilReset: max(0, endOfDay.timeIntervalSince(snapshot.now)),
                        remainingMode: remaining
                    )

                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Daily target \(prefs.formatCost(prefs.dailySpendTargetUsd, masked: false))")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text(remaining
                                 ? "\(Int(max(0, (1 - fraction) * 100).rounded()))% left"
                                 : "\(Int((fraction * 100).rounded()))% used")
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .foregroundStyle(Palette.paceColor(fraction: fraction))
                        }

                        PaceMeterBar(
                            percent: barPct,
                            fillColor: Palette.paceColor(fraction: fraction),
                            pacePercent: pace.pacePercent,
                            paceOver: pace.paceOver,
                            height: 7
                        )
                    }
                }

                TokenCompositionStrip(totals: totals, prefs: prefs)
            }
        }
    }

    // MARK: - 2. Coherent Usage ↔ Pacing Bridge

    @ViewBuilder
    private func pacingGlanceBridge(_ snapshot: PhoneWorkspaceSnapshot) -> some View {
        let profiles = snapshot.providerPacingProfiles(budgets: prefs.toolBudgets)
        let hottest = profiles.first(where: { $0.hottestBudgetFraction != nil })
        let burst5h = snapshot.trailingFiveHourTokens

        if burst5h > 0 || hottest != nil || snapshot.sevenDayCostUsd > 0 {
            Button {
                workspace.selectedTab = .limits
            } label: {
                HStack(spacing: 12) {
                    Group {
                        if let hottest, hottest.hottestBudgetFraction != nil {
                            ProviderEmblem(source: hottest.source, size: 34)
                        } else {
                            Image(systemName: "gauge.with.dots.needle.67percent")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                                .frame(width: 34, height: 34)
                                .background(Color.primary.opacity(0.06), in: Circle())
                        }
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text(pacingHeadline(snapshot: snapshot, hottest: hottest, burst5h: burst5h))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let subtitle = pacingSubtitle(snapshot: snapshot, hottest: hottest, burst5h: burst5h) {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                    }

                    Spacer(minLength: 6)

                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("pulse.pacingBridge")
        }
    }

    private func pacingHeadline(snapshot: PhoneWorkspaceSnapshot, hottest: ProviderPacingProfile?, burst5h: Int) -> String {
        if let hottest, let frac = hottest.hottestBudgetFraction {
            return "\(hottest.displayName) · \(Int((frac * 100).rounded()))% of cap"
        }
        if burst5h > 0 {
            return "\(prefs.formatTokens(burst5h)) tokens · last 5h"
        }
        return "\(prefs.formatCost(snapshot.sevenDayCostUsd)) · last 7 days"
    }

    private func pacingSubtitle(snapshot: PhoneWorkspaceSnapshot, hottest: ProviderPacingProfile?, burst5h: Int) -> String? {
        if hottest?.hottestBudgetFraction != nil || burst5h > 0 {
            return "\(prefs.formatCost(snapshot.sevenDayCostUsd)) · last 7 days"
        }
        return nil
    }

    // MARK: - 3. Intraday / 30-Day Timeline Chart

    @ViewBuilder
    private func timelineChartSection(_ snapshot: PhoneWorkspaceSnapshot) -> some View {
        if workspace.horizon == .today, let hourly = snapshot.todayHourly, !hourly.data.isEmpty {
            HourlyPulseChartCard(hourly: hourly, now: snapshot.now, prefs: prefs)
        } else if let daily = snapshot.daily30d {
            DailyTrendChartCard(daily: daily, prefs: prefs)
        }
    }

    // MARK: - 4. Ranked Tools (Tap to Drill Into Provider Models)

    @ViewBuilder
    private func providerLedgerSection(_ snapshot: PhoneWorkspaceSnapshot) -> some View {
        let providers = snapshot.rankedProviders
        if !providers.isEmpty {
            TelemetrySurface(padding: 18) {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        Text("Coding Tools")
                            .font(.headline)
                        Spacer()
                        Text("\(providers.count) active")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    let maxTokens = max(providers.map(\.tokens).max() ?? 1, 1)
                    VStack(spacing: 14) {
                        ForEach(providers) { provider in
                            Button {
                                selectedProvider = provider
                            } label: {
                                ProviderShareRow(
                                    provider: provider,
                                    share: provider.tokens > 0 ? Double(provider.tokens) / Double(maxTokens) : 0.08,
                                    prefs: prefs
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    // MARK: - 5. Top Models

    @ViewBuilder
    private func modelBreakdownSection(_ snapshot: PhoneWorkspaceSnapshot) -> some View {
        let models = snapshot.rankedModels
        if !models.isEmpty {
            TelemetrySurface(padding: 18) {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        Text("Top Models")
                            .font(.headline)
                        Spacer()
                        Text("\(models.count) total")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    let totalTokens = max(models.reduce(0) { $0 + $1.tokens }, 1)
                    VStack(spacing: 13) {
                        ForEach(Array(models.prefix(6).enumerated()), id: \.element.id) { index, model in
                            ModelShareRow(
                                model: model,
                                rankIndex: index,
                                share: Double(model.tokens) / Double(totalTokens),
                                prefs: prefs
                            )
                        }
                    }
                }
            }
        }
    }

    // MARK: - 6. Activity Consistency Heatmap

    @ViewBuilder
    private func consistencyHeatmapSection(_ snapshot: PhoneWorkspaceSnapshot) -> some View {
        if let heatmap = snapshot.heatmap, !heatmap.weeks.isEmpty {
            HeatmapSurfaceCard(heatmap: heatmap, now: snapshot.now, prefs: prefs)
        }
    }

    private func syncFootnote(_ snapshot: PhoneWorkspaceSnapshot) -> some View {
        HStack {
            Image(systemName: "checkmark.icloud")
                .font(.caption2)
            Text("Updated \(snapshot.now, style: .time)")
                .font(.caption)
            Spacer()
            if workspace.selectedDeviceId != nil {
                Button("Clear Filter") {
                    workspace.selectedDeviceId = nil
                }
                .font(.caption.weight(.semibold))
            }
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
    }

    private func isCompletelyEmpty(_ snapshot: PhoneWorkspaceSnapshot) -> Bool {
        snapshot.periodSummary.totals.displayTokens == 0
            && snapshot.periodSummary.totals.conversationCount == 0
            && snapshot.todaySummary.rolling.last30d.totals.billableTotalTokens == 0
            && (snapshot.rankedProviders.isEmpty)
    }
}

// MARK: - Subviews

private struct TokenCompositionStrip: View {
    let totals: TokenTotals
    let prefs: PhonePreferences
    @Environment(\.dynamicTypeSize) private var typeSize

    private struct Segment: Identifiable {
        let id: String
        let tokens: Int
        let shade: Color
    }

    private var segments: [Segment] {
        [
            Segment(id: "Input", tokens: totals.inputTokens, shade: Palette.step(0)),
            Segment(id: "Output", tokens: totals.outputTokens, shade: Palette.step(1)),
            Segment(id: "Cache read", tokens: totals.cachedInputTokens, shade: Palette.step(2)),
            Segment(id: "Cache write", tokens: totals.cacheCreationInputTokens, shade: Palette.step(3)),
        ].filter { $0.tokens > 0 }
    }

    var body: some View {
        if !segments.isEmpty {
            let sum = max(segments.reduce(0) { $0 + $1.tokens }, 1)
            VStack(alignment: .leading, spacing: 10) {
                GeometryReader { geo in
                    let gaps = CGFloat(segments.count - 1) * 2
                    HStack(spacing: 2) {
                        ForEach(segments) { seg in
                            seg.shade
                                .frame(width: max(3, (geo.size.width - gaps) * CGFloat(seg.tokens) / CGFloat(sum)))
                        }
                    }
                    .clipShape(Capsule())
                }
                .frame(height: 6)

                // Two fixed columns; labels never shrink below their natural width.
                LazyVGrid(
                    columns: Array(
                        repeating: GridItem(.flexible(), spacing: 16, alignment: .leading),
                        count: typeSize >= .xxLarge ? 1 : 2
                    ),
                    alignment: .leading,
                    spacing: 6
                ) {
                    ForEach(segments) { seg in
                        HStack(spacing: 6) {
                            RoundedRectangle(cornerRadius: 2, style: .continuous)
                                .fill(seg.shade)
                                .frame(width: 8, height: 8)
                            Text(seg.id)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .fixedSize()
                            Spacer(minLength: 4)
                            Text(prefs.formatTokens(seg.tokens))
                                .fontWeight(.medium)
                                .monospacedDigit()
                                .lineLimit(1)
                        }
                        .font(.caption)
                    }
                }

                if totals.cacheHitRatio > 0.05 {
                    Text("Cache hit \(Int((totals.cacheHitRatio * 100).rounded()))%")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
        }
    }
}

private struct HourlyPulseChartCard: View {
    let hourly: PhoneHourlyUsageResponse
    let now: Date
    let prefs: PhonePreferences

    private var currentHour: Int {
        Calendar.localGregorian.component(.hour, from: now)
    }

    private struct HourBucketPoint: Identifiable {
        let id: Int
        let hour: Int
        let tokens: Int
    }

    private var points: [HourBucketPoint] {
        var map: [Int: Int] = [:]
        for item in hourly.data {
            if let hourPart = item.hour.split(separator: "T").last?.prefix(2),
               let hr = Int(hourPart) {
                map[hr, default: 0] += item.totalTokens
            }
        }
        return (0..<24).map { HourBucketPoint(id: $0, hour: $0, tokens: map[$0] ?? 0) }
    }

    var body: some View {
        TelemetrySurface(padding: 18) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Today by Hour")
                        .font(.headline)
                    Spacer()
                    if let peak = points.max(by: { $0.tokens < $1.tokens }), peak.tokens > 0 {
                        Text("Peak \(String(format: "%02d:00", peak.hour)) · \(prefs.formatTokens(peak.tokens))")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }

                Chart(points) { point in
                    BarMark(
                        x: .value("Hour", point.hour),
                        y: .value("Tokens", point.tokens)
                    )
                    .foregroundStyle(Color.primary.opacity(point.hour == currentHour ? 1 : 0.72))
                    .cornerRadius(3)
                }
                .chartXScale(domain: 0...23)
                .chartXAxis {
                    AxisMarks(values: [0, 6, 12, 18, 23]) { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let hr = value.as(Int.self) {
                                Text("\(hr)h")
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let v = value.as(Int.self) {
                                Text(prefs.formatTokens(v))
                            }
                        }
                    }
                }
                .frame(height: 155)
            }
        }
    }
}

private struct DailyTrendChartCard: View {
    let daily: PhoneDailyUsageResponse
    let prefs: PhonePreferences
    @State private var metricMode: TrendMetric = .cost

    private enum TrendMetric: String, CaseIterable {
        case cost = "Cost"
        case tokens = "Tokens"
    }

    private struct DayPoint: Identifiable {
        let id: String
        let date: Date
        let tokens: Int
        let cost: Double
    }

    private var points: [DayPoint] {
        daily.data.compactMap { row in
            DayKey.date(row.day).map {
                DayPoint(id: row.day, date: $0, tokens: row.totalTokens, cost: row.totalCostUsd)
            }
        }
    }

    private var domain: ClosedRange<Date> {
        let cal = Calendar.localGregorian
        let end = DayKey.date(daily.to) ?? cal.startOfDay(for: Date())
        let start = DayKey.date(daily.from) ?? cal.date(byAdding: .day, value: -29, to: end) ?? end
        return start...(cal.date(byAdding: .day, value: 1, to: end) ?? end)
    }

    var body: some View {
        TelemetrySurface(padding: 18) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Last 30 Days")
                        .font(.headline)
                    Spacer()
                    Picker("Metric", selection: $metricMode) {
                        ForEach(TrendMetric.allCases, id: \.self) { m in
                            Text(m.rawValue).tag(m)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 136)
                }

                if points.allSatisfy({ $0.tokens == 0 && $0.cost == 0 }) {
                    Text("No activity")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 20)
                } else {
                    Chart(points) { pt in
                        if metricMode == .cost {
                            BarMark(
                                x: .value("Day", pt.date, unit: .day),
                                y: .value("Cost", pt.cost * prefs.currency.defaultRate)
                            )
                            .foregroundStyle(Color.primary.opacity(0.8))
                            .cornerRadius(2.5)
                        } else {
                            BarMark(
                                x: .value("Day", pt.date, unit: .day),
                                y: .value("Tokens", pt.tokens)
                            )
                            .foregroundStyle(Color.primary.opacity(0.8))
                            .cornerRadius(2.5)
                        }
                    }
                    .chartXScale(domain: domain)
                    .chartXAxis {
                        AxisMarks(values: .stride(by: .day, count: 7)) { _ in
                            AxisGridLine()
                            AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                        }
                    }
                    .chartYAxis {
                        AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
                            AxisGridLine()
                            AxisValueLabel {
                                if metricMode == .cost, let d = value.as(Double.self) {
                                    Text(prefs.discreteAmounts ? "••" : "\(prefs.currency.symbol)\(Int(d.rounded()))")
                                } else if let v = value.as(Int.self) {
                                    Text(prefs.formatTokens(v))
                                }
                            }
                        }
                    }
                    .frame(height: 165)
                }
            }
        }
    }
}

private struct ProviderShareRow: View {
    let provider: RankedProviderItem
    let share: Double
    let prefs: PhonePreferences

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 10) {
                ProviderEmblem(source: provider.source, size: 32)

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(provider.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                        if ProviderIdentity.isAccountLevelSource(provider.source) {
                            Text("Account")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Color.primary.opacity(0.06), in: Capsule())
                        }
                    }
                    Text(provider.topModel ?? "\(provider.conversations) sessions")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 1) {
                    Text(prefs.formatCost(provider.costUsd))
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.primary)
                    Text(provider.tokens == 0 && provider.conversations > 0
                         ? "\(provider.conversations) req"
                         : prefs.formatTokens(provider.tokens))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }

            PaceMeterBar(
                percent: share * 100,
                fillColor: Color.primary.opacity(0.75),
                height: 5
            )
        }
    }
}

private struct ModelShareRow: View {
    let model: RankedModelItem
    let rankIndex: Int
    let share: Double
    let prefs: PhonePreferences

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(rankIndex + 1)")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 16, alignment: .leading)

                VStack(alignment: .leading, spacing: 1) {
                    Text(model.name)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Text(model.sources.map(ProviderIdentity.shortName).joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 1) {
                    Text(model.tokens == 0 && model.conversations > 0
                         ? "\(model.conversations) req"
                         : prefs.formatTokens(model.tokens))
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                    Text(prefs.formatCost(model.costUsd))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            PaceMeterBar(percent: share * 100, fillColor: Color.primary.opacity(0.7), height: 4)
        }
    }
}

private struct HeatmapSurfaceCard: View {
    let heatmap: HeatmapResponse
    let now: Date
    let prefs: PhonePreferences

    private var streak: ActivityStreak {
        heatmap.currentStreak(today: DayKey.string(now))
    }

    private func levelColor(_ level: Int) -> Color {
        switch min(max(level, 0), 4) {
        case 0: return Color.primary.opacity(0.06)
        case 1: return Color.primary.opacity(0.22)
        case 2: return Color.primary.opacity(0.42)
        case 3: return Color.primary.opacity(0.66)
        default: return Color.primary.opacity(0.92)
        }
    }

    var body: some View {
        TelemetrySurface(padding: 18) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Activity")
                        .font(.headline)
                    Spacer()
                    Label(streak.displayLabel, systemImage: "flame.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(streak.days > 0 ? Color.primary : Color.secondary)
                }

                GeometryReader { geo in
                    let cols = max(heatmap.weeks.count, 1)
                    let gap: CGFloat = 3
                    let cellSize = min(17, (geo.size.width - gap * CGFloat(cols - 1)) / CGFloat(cols))
                    HStack(alignment: .top, spacing: gap) {
                        ForEach(Array(heatmap.weeks.enumerated()), id: \.offset) { _, week in
                            VStack(spacing: gap) {
                                ForEach(0..<7, id: \.self) { row in
                                    let cell = row < week.count ? week[row] : nil
                                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                                        .fill(cell.map { levelColor($0.level) } ?? .clear)
                                        .frame(width: cellSize, height: cellSize)
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .frame(height: 7 * 16 + 6 * 3)

                HStack {
                    Text("\(heatmap.activeDays) active days")
                    Spacer()
                    HStack(spacing: 3) {
                        Text("Less")
                        ForEach(0..<5, id: \.self) { lv in
                            RoundedRectangle(cornerRadius: 2)
                                .fill(levelColor(lv))
                                .frame(width: 9, height: 9)
                        }
                        Text("More")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        }
    }
}

private struct ProviderDetailSheet: View {
    @EnvironmentObject private var prefs: PhonePreferences
    @Environment(\.dismiss) private var dismiss
    let provider: RankedProviderItem
    let horizonTitle: String

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        ProviderEmblem(source: provider.source, size: 44)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(provider.displayName)
                                .font(.title3.weight(.bold))
                            Text(horizonTitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)

                    LabeledContent("Estimated Cost", value: prefs.formatCost(provider.costUsd))
                        .monospacedDigit()
                    LabeledContent("Total Tokens", value: prefs.formatTokens(provider.tokens))
                        .monospacedDigit()
                    LabeledContent("Sessions", value: provider.conversations.formatted())
                        .monospacedDigit()
                }

                Section("Models") {
                    ForEach(provider.models) { model in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(model.name)
                                    .font(.subheadline.weight(.semibold))
                                Spacer()
                                Text(prefs.formatCost(model.costUsd))
                                    .font(.subheadline.weight(.semibold).monospacedDigit())
                            }
                            HStack(spacing: 12) {
                                Text("\(prefs.formatTokens(model.tokens)) tokens")
                                if model.cachedInputTokens > 0 {
                                    Text("\(prefs.formatTokens(model.cachedInputTokens)) cached")
                                }
                                if model.reasoningTokens > 0 {
                                    Text("\(prefs.formatTokens(model.reasoningTokens)) reasoning")
                                }
                                Spacer()
                                Text("\(model.conversations) sess")
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                        }
                        .padding(.vertical, 3)
                    }
                }
            }
            .navigationTitle(provider.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
