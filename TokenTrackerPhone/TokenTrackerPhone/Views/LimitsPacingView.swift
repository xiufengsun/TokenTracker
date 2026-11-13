import SwiftUI

struct LimitsPacingView: View {
    @EnvironmentObject private var prefs: PhonePreferences
    @ObservedObject var workspace: WorkspaceModel

    @State private var showAccountTargetSheet = false
    @State private var editingToolSource: String?

    var body: some View {
        NavigationStack {
            ZStack {
                AtmosphericGlassCanvas()

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        headerControlBar

                        if let snapshot = workspace.visibleSnapshot ?? workspace.snapshot {
                            accountRollingWindowsCard(snapshot)
                            providerWindowsSection(snapshot)
                            cloudArchitectureBoundaryCard
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
            }
            .navigationTitle("Pacing & Limits")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showAccountTargetSheet = true
                    } label: {
                        Label("Targets", systemImage: "slider.horizontal.3")
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

    // MARK: - Top Glass Mode Toggle (Used vs Remaining — Mirrors macOS Menu Bar)

    private var headerControlBar: some View {
        HStack(spacing: 10) {
            GlassEffectContainer(spacing: 6) {
                HStack(spacing: 6) {
                    ForEach(WindowMeterStyle.allCases) { mode in
                        let selected = prefs.windowMeterStyle == mode
                        Button {
                            withAnimation(.easeOut(duration: 0.2)) {
                                prefs.windowMeterStyle = mode
                            }
                        } label: {
                            Text(mode.label)
                                .font(.subheadline.weight(selected ? .semibold : .medium))
                                .foregroundStyle(selected ? Color.primary : Color.secondary)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                        }
                        .buttonStyle(.plain)
                        .glassEffect(
                            selected
                                ? .regular.tint(BrandPalette.emerald.opacity(0.28)).interactive()
                                : .regular.interactive(),
                            in: .capsule
                        )
                    }
                }
            }

            Spacer()

            Button {
                showAccountTargetSheet = true
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "target")
                    Text(hasAnySpendTarget ? "Targets On" : "Set Targets")
                }
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .buttonStyle(.glass)
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

        return TelemetrySurface(padding: 18) {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Rolling Account Windows")
                            .font(.headline)
                        Text("Synced Cloud activity & spend pace across your computers")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }

                // 5-Hour Burst Window
                rollingWindowRow(
                    title: "5h Burst Window",
                    primaryMetric: prefs.formatTokens(snapshot.trailingFiveHourTokens),
                    secondaryMetric: snapshot.trailingFiveHourWindowReset.map {
                        "rolls over in \(LimitPace.durationString(max(0, $0.timeIntervalSince(snapshot.now))))"
                    } ?? "idle window",
                    fraction: fiveHourBurstIntensity(snapshot),
                    windowSeconds: nil,
                    resetDate: nil,
                    now: snapshot.now,
                    remainingMode: false,
                    isTargetBased: false
                )

                Divider()

                // Today's Spend Window
                rollingWindowRow(
                    title: "Today (24h)",
                    primaryMetric: prefs.formatCost(snapshot.todayCostUsd),
                    secondaryMetric: prefs.dailySpendTargetUsd > 0
                        ? "of \(prefs.formatCost(prefs.dailySpendTargetUsd, masked: false)) target"
                        : "\(prefs.formatTokens(snapshot.todaySummary.totals.displayTokens)) tokens",
                    fraction: prefs.dailySpendTargetUsd > 0
                        ? snapshot.todayCostUsd / prefs.dailySpendTargetUsd
                        : (snapshot.averageDailyCost30d > 0 ? min(1, snapshot.todayCostUsd / (snapshot.averageDailyCost30d * 1.5)) : 0),
                    windowSeconds: prefs.dailySpendTargetUsd > 0 ? 86_400 : nil,
                    resetDate: prefs.dailySpendTargetUsd > 0 ? endOfToday : nil,
                    now: snapshot.now,
                    remainingMode: remaining && prefs.dailySpendTargetUsd > 0,
                    isTargetBased: prefs.dailySpendTargetUsd > 0
                )

                Divider()

                // 7-Day Rolling Window
                rollingWindowRow(
                    title: "7d Rolling",
                    primaryMetric: prefs.formatCost(snapshot.sevenDayCostUsd),
                    secondaryMetric: prefs.weeklySpendTargetUsd > 0
                        ? "of \(prefs.formatCost(prefs.weeklySpendTargetUsd, masked: false)) target"
                        : "\(prefs.formatTokens(snapshot.todaySummary.rolling.last7d.totals.billableTotalTokens)) · \(snapshot.todaySummary.rolling.last7d.activeDays)/7d active",
                    fraction: prefs.weeklySpendTargetUsd > 0
                        ? snapshot.sevenDayCostUsd / prefs.weeklySpendTargetUsd
                        : thirtyDayNormalized7dFraction(snapshot),
                    windowSeconds: nil,
                    resetDate: nil,
                    now: snapshot.now,
                    remainingMode: remaining && prefs.weeklySpendTargetUsd > 0,
                    isTargetBased: prefs.weeklySpendTargetUsd > 0
                )

                Divider()

                // 30-Day Rolling Window
                rollingWindowRow(
                    title: "30d Rolling",
                    primaryMetric: prefs.formatCost(snapshot.thirtyDayCostUsd),
                    secondaryMetric: prefs.monthlySpendTargetUsd > 0
                        ? "of \(prefs.formatCost(prefs.monthlySpendTargetUsd, masked: false)) target"
                        : "avg \(prefs.formatCost(snapshot.averageDailyCost30d))/active day",
                    fraction: prefs.monthlySpendTargetUsd > 0
                        ? snapshot.thirtyDayCostUsd / prefs.monthlySpendTargetUsd
                        : (snapshot.thirtyDayCostUsd > 0 ? 0.55 : 0),
                    windowSeconds: nil,
                    resetDate: nil,
                    now: snapshot.now,
                    remainingMode: remaining && prefs.monthlySpendTargetUsd > 0,
                    isTargetBased: prefs.monthlySpendTargetUsd > 0
                )

                if prefs.dailySpendTargetUsd > 0 {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(BrandPalette.emerald)
                            .frame(width: 6, height: 6)
                        Text("The notch on target bars marks even-burn pace through the window.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func fiveHourBurstIntensity(_ snapshot: PhoneWorkspaceSnapshot) -> Double {
        let burst = Double(snapshot.trailingFiveHourTokens)
        guard burst > 0 else { return 0 }
        let avgDailyTokens = Double(snapshot.todaySummary.rolling.last30d.avgPerActiveDay ?? 0)
        guard avgDailyTokens > 0 else { return 0.35 }
        return min(1.0, burst / max(avgDailyTokens * 0.75, 1))
    }

    private func thirtyDayNormalized7dFraction(_ snapshot: PhoneWorkspaceSnapshot) -> Double {
        guard snapshot.thirtyDayCostUsd > 0 else { return 0 }
        let expectedWeekly = snapshot.thirtyDayCostUsd * (7.0 / 30.0)
        guard expectedWeekly > 0 else { return 0 }
        return min(1.0, (snapshot.sevenDayCostUsd / expectedWeekly) * 0.5)
    }

    private func rollingWindowRow(
        title: String,
        primaryMetric: String,
        secondaryMetric: String,
        fraction: Double,
        windowSeconds: Double?,
        resetDate: Date?,
        now: Date,
        remainingMode: Bool,
        isTargetBased: Bool
    ) -> some View {
        let clampedUsed = min(max(fraction, 0), 1)
        let displayPercent = remainingMode ? (1 - clampedUsed) * 100 : clampedUsed * 100
        let fillColor = isTargetBased ? BrandPalette.paceColor(fraction: fraction) : BrandPalette.emerald.opacity(0.82)

        var paceResult: LimitPace.Result? = nil
        if isTargetBased, let windowSeconds, let resetDate {
            paceResult = LimitPace.compute(
                usedFraction: clampedUsed,
                windowSeconds: windowSeconds,
                secondsUntilReset: max(0, resetDate.timeIntervalSince(now)),
                remainingMode: remainingMode
            )
        }

        return VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(primaryMetric)
                    .font(.subheadline.weight(.bold).monospacedDigit())
                if isTargetBased {
                    let pctInt = Int((remainingMode ? max(0, (1 - fraction) * 100) : fraction * 100).rounded())
                    Text("· \(pctInt)% \(remainingMode ? "left" : "used")")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(BrandPalette.paceColor(fraction: fraction))
                }
            }

            PaceMeterBar(
                percent: displayPercent,
                fillColor: fillColor,
                pacePercent: paceResult?.pacePercent,
                paceOver: paceResult?.paceOver ?? false,
                height: 8
            )

            HStack {
                Text(secondaryMetric)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let paceResult {
                    if let eta = paceResult.runsOutEta {
                        Text("Hits target in ~\(eta) at current pace")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(BrandPalette.coral)
                    } else if let projected = paceResult.projectedEnd {
                        Text("Projected \(projected)% by reset")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    // MARK: - 2. Per-Provider Window Activity & Plan Budgets

    private func providerWindowsSection(_ snapshot: PhoneWorkspaceSnapshot) -> some View {
        let profiles = snapshot.providerPacingProfiles(budgets: prefs.toolBudgets)
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Tool Windows & Plan Cycles")
                    .font(.headline)
                Spacer()
                Text("Tap a tool to set cap / cycle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 2)

            if profiles.isEmpty {
                TelemetrySurface(padding: 18) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("No Active Tool Windows Yet")
                            .font(.subheadline.weight(.semibold))
                        Text("Once Claude, Codex, Cursor, Muse, or another CLI syncs usage to Cloud, its 5-hour burst, 7-day, and 30-day windows appear here.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
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
                    HStack(spacing: 10) {
                        ProviderEmblem(source: profile.source, size: 34)

                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(profile.displayName)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.primary)
                                if let cycle = budget?.billingCycle, budget?.nextRenewalISO != nil {
                                    Image(systemName: budget?.autoRenew == false ? "clock" : "infinity")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(BrandPalette.emerald)
                                        .accessibilityLabel(cycle)
                                }
                            }
                            Text(ProviderIdentity.rollingCadenceNote(profile.source))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        Image(systemName: "slider.horizontal.3")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(7)
                            .background(Color.primary.opacity(0.06), in: Circle())
                    }

                    // Window Metrics Strip (5h / 7d / 30d synced from Cloud)
                    HStack(spacing: 0) {
                        miniWindowStat(
                            label: "5h Burst",
                            value: profile.fiveHourTokens > 0 ? prefs.formatTokens(profile.fiveHourTokens) : "Quiet",
                            sub: profile.nextWindowReset.map {
                                "\(LimitPace.durationString(max(0, $0.timeIntervalSince(now)))) left"
                            } ?? "rolling"
                        )
                        miniWindowStat(
                            label: "7d Window",
                            value: prefs.formatCost(profile.sevenDayCostUsd),
                            sub: prefs.formatTokens(profile.sevenDayTokens)
                        )
                        miniWindowStat(
                            label: "30d Window",
                            value: prefs.formatCost(profile.thirtyDayCostUsd),
                            sub: prefs.formatTokens(profile.thirtyDayTokens)
                        )
                    }

                    // Optional User-Configured Weekly / Monthly Tool Budget Bar
                    if let weeklyCap = budget?.weeklyBudgetUsd, weeklyCap > 0 {
                        let frac = profile.sevenDayCostUsd / weeklyCap
                        let pct = remaining ? max(0, (1 - frac) * 100) : min(100, frac * 100)
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text("7d Budget (\(prefs.formatCost(weeklyCap, masked: false)))")
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text("\(Int((remaining ? max(0, (1 - frac) * 100) : frac * 100).rounded()))% \(remaining ? "left" : "used")")
                                    .font(.caption2.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(BrandPalette.paceColor(fraction: frac))
                            }
                            PaceMeterBar(percent: pct, fillColor: BrandPalette.paceColor(fraction: frac), height: 6)
                        }
                    }

                    if let monthlyCap = budget?.monthlyBudgetUsd, monthlyCap > 0 {
                        let frac = profile.thirtyDayCostUsd / monthlyCap
                        let pct = remaining ? max(0, (1 - frac) * 100) : min(100, frac * 100)
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text("30d Budget (\(prefs.formatCost(monthlyCap, masked: false)))")
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text("\(Int((remaining ? max(0, (1 - frac) * 100) : frac * 100).rounded()))% \(remaining ? "left" : "used")")
                                    .font(.caption2.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(BrandPalette.paceColor(fraction: frac))
                            }
                            PaceMeterBar(percent: pct, fillColor: BrandPalette.paceColor(fraction: frac), height: 6)
                        }
                    }

                    // Optional Plan Renewal Cycle Bar
                    if let renewalISO = budget?.nextRenewalISO,
                       let renewalDate = ISO8601DateFormatter().date(from: renewalISO) {
                        let cycleDays: Double = budget?.billingCycle == "yearly" ? 365 : 30
                        let secondsLeft = renewalDate.timeIntervalSince(now)
                        let elapsedFrac = min(1, max(0, 1 - (secondsLeft / (cycleDays * 86_400))))
                        let displayPct = remaining ? (1 - elapsedFrac) * 100 : elapsedFrac * 100
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text("Plan Renewal Cycle")
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text(secondsLeft > 0 ? "renews in \(LimitPace.durationString(secondsLeft))" : "renews today")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                            PaceMeterBar(
                                percent: displayPct,
                                fillColor: secondsLeft <= 3 * 86_400 ? BrandPalette.amber : .blue,
                                height: 6
                            )
                        }
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func miniWindowStat(label: String, value: String, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(.primary)
                .lineLimit(1)
            Text(sub)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - 3. Honest Architecture Disclosure (Local Credentials vs Cloud Sync)

    private var cloudArchitectureBoundaryCard: some View {
        TelemetrySurface(padding: 16) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "lock.laptopcomputer")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(BrandPalette.emerald)
                    .frame(width: 32, height: 32)
                    .background(BrandPalette.emerald.opacity(0.14), in: RoundedRectangle(cornerRadius: 9, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text("Why Live Provider Rate Caps Stay on Desktop")
                        .font(.footnote.weight(.semibold))

                    Text("Exact provider rate-limit percentages (such as Claude OAuth utilization, Codex reset-credit banks, or DeepSeek wallet balances) are read directly from local CLI credentials on your Mac, Windows, or Linux machine and are never uploaded to TokenTracker Cloud for security. On iPhone, Pacing & Limits tracks your Cloud-synced 5h/7d/30d token & cost windows alongside any spend caps or renewal dates you set here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
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
                    targetField(title: "Daily Target (USD)", placeholder: "Off (e.g. 25)", text: $dailyText)
                    targetField(title: "7-Day Target (USD)", placeholder: "Off (e.g. 120)", text: $weeklyText)
                    targetField(title: "30-Day Target (USD)", placeholder: "Off (e.g. 400)", text: $monthlyText)
                } header: {
                    Text("Account Spend Targets")
                } footer: {
                    Text("Targets are stored privately on this iPhone and compared against your Cloud-synced estimated USD spend. Leave blank or 0 to disable a bar.")
                }

                if prefs.dailySpendTargetUsd > 0 || prefs.weeklySpendTargetUsd > 0 || prefs.monthlySpendTargetUsd > 0 {
                    Section {
                        Button("Clear All Account Targets", role: .destructive) {
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
                        Text("7-Day Spend Cap (USD)")
                        Spacer()
                        TextField("Optional", text: $weeklyUsd)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 110)
                    }
                    HStack {
                        Text("30-Day Spend Cap (USD)")
                        Spacer()
                        TextField("Optional", text: $monthlyUsd)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 110)
                    }
                } header: {
                    Text("\(ProviderIdentity.displayName(source)) Spend Caps")
                } footer: {
                    Text("Evaluated against Cloud-synced estimated model spend for \(ProviderIdentity.displayName(source)).")
                }

                Section {
                    Toggle("Track Subscription Renewal", isOn: $trackRenewal)
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
                        Button("Remove \(ProviderIdentity.shortName(source)) Rules", role: .destructive) {
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
