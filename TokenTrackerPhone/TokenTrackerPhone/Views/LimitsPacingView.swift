import SwiftUI

struct LimitsPacingView: View {
    @EnvironmentObject private var prefs: PhonePreferences
    @ObservedObject var workspace: WorkspaceModel

    @State private var showAccountTargetSheet = false
    @State private var editingToolSource: String?

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackground()

                ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        headerControlBar

                        if let snapshot = workspace.visibleSnapshot ?? workspace.snapshot {
                            accountRollingWindowsCard(snapshot)
                            providerWindowsSection(snapshot)
                                .id("tools")
                            cloudArchitectureBoundaryCard
                                .id("footer")
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
            .navigationTitle("Pacing & Limits")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showAccountTargetSheet = true
                    } label: {
                        Label("Spend Targets", systemImage: "target")
                    }
                    .accessibilityIdentifier("limits.editTargets")
                }
            }
            .sheet(isPresented: $showAccountTargetSheet) {
                AccountSpendTargetsSheet()
            }
            .sheet(item: Binding(
                get: { editingToolSource.map { EditableSourceWrapper(source: $0) } },
                set: { editingToolSource = $0?.source }
            )) { item in
                ToolBudgetEditorSheet(source: item.source)
            }
        }
    }

    private struct EditableSourceWrapper: Identifiable {
        var id: String { source }
        let source: String
    }

    // MARK: - Used / Remaining toggle (same semantics as the macOS menu bar)

    private var headerControlBar: some View {
        HStack {
            GlassSegmentedControl(
                items: WindowMeterStyle.allCases,
                selection: $prefs.windowMeterStyle,
                label: \.label,
                identifierPrefix: "limits.meter",
                fillsWidth: false
            )
            Spacer()
        }
    }

    private var hasAnySpendTarget: Bool {
        prefs.dailySpendTargetUsd > 0 || prefs.weeklySpendTargetUsd > 0 || prefs.monthlySpendTargetUsd > 0
    }

    // MARK: - 1. Account Rolling Windows & Pace

    private func accountRollingWindowsCard(_ snapshot: PhoneWorkspaceSnapshot) -> some View {
        let remaining = prefs.windowMeterStyle == .remaining
        let cal = Calendar.localGregorian
        let endOfToday = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: snapshot.now)) ?? snapshot.now
        let rolling = snapshot.todaySummary.rolling

        return TelemetrySurface(padding: 18) {
            VStack(alignment: .leading, spacing: 16) {
                Text("Account")
                    .font(.headline)

                windowRow(
                    title: "Last 5 hours",
                    value: prefs.formatTokens(snapshot.trailingFiveHourTokens),
                    detail: snapshot.trailingFiveHourTokens > 0 ? "Tokens · this hour + previous 4" : "No activity",
                    target: nil,
                    used: 0,
                    pace: nil,
                    remainingMode: false
                )

                Divider()

                windowRow(
                    title: "Today",
                    value: prefs.formatCost(snapshot.todayCostUsd),
                    detail: "\(prefs.formatTokens(snapshot.todaySummary.totals.displayTokens)) tokens · resets midnight",
                    target: prefs.dailySpendTargetUsd,
                    used: snapshot.todayCostUsd,
                    pace: (window: 86_400, reset: endOfToday, now: snapshot.now),
                    remainingMode: remaining
                )

                Divider()

                windowRow(
                    title: "Last 7 days",
                    value: prefs.formatCost(snapshot.sevenDayCostUsd),
                    detail: "\(prefs.formatTokens(rolling.last7d.totals.billableTotalTokens)) tokens · \(rolling.last7d.activeDays)/7 days active",
                    target: prefs.weeklySpendTargetUsd,
                    used: snapshot.sevenDayCostUsd,
                    pace: nil,
                    remainingMode: remaining
                )

                Divider()

                windowRow(
                    title: "Last 30 days",
                    value: prefs.formatCost(snapshot.thirtyDayCostUsd),
                    detail: "\(prefs.formatCost(snapshot.averageDailyCost30d))/active day · \(rolling.last30d.activeDays)/30 days active",
                    target: prefs.monthlySpendTargetUsd,
                    used: snapshot.thirtyDayCostUsd,
                    pace: nil,
                    remainingMode: remaining
                )

                if !hasAnySpendTarget {
                    Button {
                        showAccountTargetSheet = true
                    } label: {
                        Label("Set Targets", systemImage: "target")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                    }
                    .buttonStyle(.glass)
                }
            }
        }
    }

    /// One window. A bar is drawn only against a target the user set; without
    /// one there is no meaningful denominator, so the row shows numbers only.
    private func windowRow(
        title: String,
        value: String,
        detail: String,
        target: Double?,
        used: Double,
        pace: (window: Double, reset: Date, now: Date)?,
        remainingMode: Bool
    ) -> some View {
        let hasTarget = (target ?? 0) > 0
        let fraction = hasTarget ? used / (target ?? 1) : 0
        let clampedUsed = min(max(fraction, 0), 1)
        let displayPercent = remainingMode ? (1 - clampedUsed) * 100 : clampedUsed * 100

        var paceResult: LimitPace.Result? = nil
        if hasTarget, let pace {
            paceResult = LimitPace.compute(
                usedFraction: clampedUsed,
                windowSeconds: pace.window,
                secondsUntilReset: max(0, pace.reset.timeIntervalSince(pace.now)),
                remainingMode: remainingMode
            )
        }

        return VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 8)
                Text(value)
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .contentTransition(.numericText())
            }

            if hasTarget, let target {
                PaceMeterBar(
                    percent: displayPercent,
                    fillColor: Palette.paceColor(fraction: fraction),
                    pacePercent: paceResult?.pacePercent,
                    paceOver: paceResult?.paceOver ?? false,
                    height: 8
                )

                HStack(alignment: .firstTextBaseline) {
                    targetCaption(target: target, fraction: fraction, remainingMode: remainingMode)
                    Spacer(minLength: 8)
                    paceCaption(paceResult)
                }
            }

            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }

    private func targetCaption(target: Double, fraction: Double, remainingMode: Bool) -> some View {
        let pct = Int(((remainingMode ? max(0, 1 - fraction) : fraction) * 100).rounded())
        return Text("\(pct)% \(remainingMode ? "left" : "used") of \(prefs.formatCost(target, masked: false))")
            .font(.caption.weight(.semibold).monospacedDigit())
            .foregroundStyle(Palette.paceColor(fraction: fraction))
            .lineLimit(1)
    }

    @ViewBuilder
    private func paceCaption(_ result: LimitPace.Result?) -> some View {
        if let result {
            if let eta = result.runsOutEta {
                Text("Target in ~\(eta)")
                    .font(.caption)
                    .foregroundStyle(Palette.critical)
                    .lineLimit(1)
            } else if let projected = result.projectedEnd {
                Text("\(projected)% by midnight")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    // MARK: - 2. Per-Tool Spend & Plan Cycles

    private func providerWindowsSection(_ snapshot: PhoneWorkspaceSnapshot) -> some View {
        let profiles = snapshot.providerPacingProfiles(budgets: prefs.toolBudgets)
        return VStack(alignment: .leading, spacing: 12) {
            Text("Coding Tools")
                .font(.headline)
                .padding(.horizontal, 4)

            if profiles.isEmpty {
                TelemetrySurface(padding: 18) {
                    Text("No tool activity in the last 30 days")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } else {
                ForEach(profiles) { profile in
                    providerPacingCard(profile, now: snapshot.now)
                }
            }
        }
    }

    private func providerPacingCard(_ profile: ProviderPacingProfile, now: Date) -> some View {
        let remaining = prefs.windowMeterStyle == .remaining
        let budget = profile.budget

        return Button {
            editingToolSource = profile.source
        } label: {
            TelemetrySurface(padding: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 12) {
                        ProviderEmblem(source: profile.source, size: 36)

                        Text(profile.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        Spacer(minLength: 8)

                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }

                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 2) {
                        GridRow {
                            statLabel("Last 7 days")
                            statLabel("Last 30 days")
                        }
                        GridRow {
                            statValue(prefs.formatCost(profile.sevenDayCostUsd))
                            statValue(prefs.formatCost(profile.thirtyDayCostUsd))
                        }
                        GridRow {
                            statDetail("\(prefs.formatTokens(profile.sevenDayTokens)) tokens")
                            statDetail("\(prefs.formatTokens(profile.thirtyDayTokens)) tokens")
                        }
                    }

                    if let weeklyCap = budget?.weeklyBudgetUsd, weeklyCap > 0 {
                        capMeter(title: "7-day cap", used: profile.sevenDayCostUsd, cap: weeklyCap, remaining: remaining)
                    }

                    if let monthlyCap = budget?.monthlyBudgetUsd, monthlyCap > 0 {
                        capMeter(title: "30-day cap", used: profile.thirtyDayCostUsd, cap: monthlyCap, remaining: remaining)
                    }

                    if let budget, let renewalDate = budget.upcomingRenewal(now: now) {
                        renewalRow(renewalDate, cycle: budget.billingCycle, autoRenew: budget.autoRenew, now: now, remaining: remaining)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("limits.tool.\(profile.source)")
    }

    private func statLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statValue(_ text: String) -> some View {
        Text(text)
            .font(.title3.weight(.semibold).monospacedDigit())
            .foregroundStyle(.primary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    private func statDetail(_ text: String) -> some View {
        Text(text)
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }

    private func capMeter(title: String, used: Double, cap: Double, remaining: Bool) -> some View {
        let frac = used / cap
        let pct = remaining ? max(0, (1 - frac) * 100) : min(100, frac * 100)
        return VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("\(title) \(prefs.formatCost(cap, masked: false))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(Int(pct.rounded()))% \(remaining ? "left" : "used")")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Palette.paceColor(fraction: frac))
            }
            PaceMeterBar(percent: pct, fillColor: Palette.paceColor(fraction: frac), height: 6)
        }
    }

    private func renewalRow(_ date: Date, cycle: String?, autoRenew: Bool, now: Date, remaining: Bool) -> some View {
        let cal = Calendar.localGregorian
        let cycleStart = cal.date(byAdding: cycle == "yearly" ? .year : .month, value: -1, to: date) ?? date
        let cycleLength = max(date.timeIntervalSince(cycleStart), 1)
        let secondsLeft = date.timeIntervalSince(now)
        let elapsedFrac = min(1, max(0, 1 - secondsLeft / cycleLength))
        let displayPct = remaining ? (1 - elapsedFrac) * 100 : elapsedFrac * 100
        let verb = autoRenew ? "Renews" : "Ends"
        return VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("\(cycle == "yearly" ? "Yearly" : "Monthly") plan")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(secondsLeft > 0
                     ? "\(verb) \(date.formatted(date: .abbreviated, time: .omitted)) · \(LimitPace.durationString(secondsLeft))"
                     : (autoRenew ? "\(verb) today" : "Ended"))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(secondsLeft <= 3 * 86_400 ? Palette.warning : Color.secondary)
            }
            PaceMeterBar(percent: displayPct, fillColor: Color.primary.opacity(0.45), height: 6)
        }
    }

    // MARK: - 3. Where provider rate limits live

    private var cloudArchitectureBoundaryCard: some View {
        Label("Provider rate limits show on your computer.", systemImage: "lock.laptopcomputer")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
    }
}

// MARK: - Sheets for Spend Targets & Tool Plan Cycles

private struct AccountSpendTargetsSheet: View {
    @EnvironmentObject private var prefs: PhonePreferences
    @Environment(\.dismiss) private var dismiss

    @State private var dailyText = ""
    @State private var weeklyText = ""
    @State private var monthlyText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    targetField(title: "Daily (USD)", placeholder: "Off", text: $dailyText)
                    targetField(title: "7 Days (USD)", placeholder: "Off", text: $weeklyText)
                    targetField(title: "30 Days (USD)", placeholder: "Off", text: $monthlyText)
                } header: {
                    Text("Account")
                } footer: {
                    Text("Stored on this iPhone. Leave blank to turn off.")
                }

                if prefs.dailySpendTargetUsd > 0 || prefs.weeklySpendTargetUsd > 0 || prefs.monthlySpendTargetUsd > 0 {
                    Section {
                        Button("Clear Targets", role: .destructive) {
                            prefs.dailySpendTargetUsd = 0
                            prefs.weeklySpendTargetUsd = 0
                            prefs.monthlySpendTargetUsd = 0
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle("Spend Targets")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        prefs.dailySpendTargetUsd = max(0, Double(dailyText) ?? 0)
                        prefs.weeklySpendTargetUsd = max(0, Double(weeklyText) ?? 0)
                        prefs.monthlySpendTargetUsd = max(0, Double(monthlyText) ?? 0)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
            .onAppear {
                dailyText = prefs.dailySpendTargetUsd > 0 ? String(format: "%.0f", prefs.dailySpendTargetUsd) : ""
                weeklyText = prefs.weeklySpendTargetUsd > 0 ? String(format: "%.0f", prefs.weeklySpendTargetUsd) : ""
                monthlyText = prefs.monthlySpendTargetUsd > 0 ? String(format: "%.0f", prefs.monthlySpendTargetUsd) : ""
            }
        }
        .presentationDetents([.medium])
    }

    private func targetField(title: String, placeholder: String, text: Binding<String>) -> some View {
        HStack {
            Text(title)
            Spacer()
            TextField(placeholder, text: text)
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 130)
        }
    }
}

private struct ToolBudgetEditorSheet: View {
    @EnvironmentObject private var prefs: PhonePreferences
    @Environment(\.dismiss) private var dismiss
    let source: String

    @State private var weeklyUsd = ""
    @State private var monthlyUsd = ""
    @State private var trackRenewal = false
    @State private var billingCycle = "monthly"
    @State private var renewalDate = Calendar.current.date(byAdding: .day, value: 14, to: Date()) ?? Date()
    @State private var autoRenew = true

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Text("7-Day Cap (USD)")
                        Spacer()
                        TextField("Optional", text: $weeklyUsd)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 110)
                    }
                    HStack {
                        Text("30-Day Cap (USD)")
                        Spacer()
                        TextField("Optional", text: $monthlyUsd)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 110)
                    }
                } header: {
                    Text("Spend Caps")
                }

                Section {
                    Toggle("Track Renewal", isOn: $trackRenewal)
                    if trackRenewal {
                        Picker("Billing Cycle", selection: $billingCycle) {
                            Text("Monthly").tag("monthly")
                            Text("Yearly").tag("yearly")
                        }
                        DatePicker("Next Renewal", selection: $renewalDate, displayedComponents: .date)
                        Toggle("Auto-Renews", isOn: $autoRenew)
                    }
                } header: {
                    Text("Plan Cycle")
                }

                if prefs.toolBudgets[source.lowercased()] != nil {
                    Section {
                        Button("Remove Caps and Renewal", role: .destructive) {
                            prefs.updateToolBudget(TrackedToolBudget(source: source))
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle(ProviderIdentity.displayName(source))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let iso = trackRenewal ? ISO8601DateFormatter().string(from: renewalDate) : nil
                        let updated = TrackedToolBudget(
                            source: source.lowercased(),
                            fiveHourBudgetUsd: nil,
                            weeklyBudgetUsd: (Double(weeklyUsd) ?? 0) > 0 ? Double(weeklyUsd) : nil,
                            monthlyBudgetUsd: (Double(monthlyUsd) ?? 0) > 0 ? Double(monthlyUsd) : nil,
                            billingCycle: trackRenewal ? billingCycle : nil,
                            nextRenewalISO: iso,
                            autoRenew: autoRenew
                        )
                        prefs.updateToolBudget(updated)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
            .onAppear {
                if let existing = prefs.toolBudgets[source.lowercased()] {
                    weeklyUsd = existing.weeklyBudgetUsd.map { String(format: "%.0f", $0) } ?? ""
                    monthlyUsd = existing.monthlyBudgetUsd.map { String(format: "%.0f", $0) } ?? ""
                    if let iso = existing.nextRenewalISO, let d = ISO8601DateFormatter().date(from: iso) {
                        trackRenewal = true
                        renewalDate = d
                        billingCycle = existing.billingCycle ?? "monthly"
                        autoRenew = existing.autoRenew
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
