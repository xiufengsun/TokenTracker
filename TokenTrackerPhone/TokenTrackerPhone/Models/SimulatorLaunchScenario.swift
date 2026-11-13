#if DEBUG
import Foundation

/// Debug-only Simulator launch configurations used to verify every screen and state
/// (Sign-In, Active Usage, Limits & Pacing, Settings, Empty Sync, Cloud Required, Offline Error)
/// without inventing fake capabilities or altering production runtime paths.
enum SimulatorLaunchScenario: String {
    case signIn = "signin"
    case active = "active"
    case limits = "limits"
    case settings = "settings"
    case empty = "empty"
    case cloudRequired = "cloud-required"
    case cloudExpired = "cloud-expired"
    case error = "error"

    static var current: SimulatorLaunchScenario? {
        let args = ProcessInfo.processInfo.arguments
        if let idx = args.firstIndex(of: "--scenario"), idx + 1 < args.count {
            return SimulatorLaunchScenario(rawValue: args[idx + 1])
        }
        if let env = ProcessInfo.processInfo.environment["TOKENTRACKER_SIM_SCENARIO"] {
            return SimulatorLaunchScenario(rawValue: env)
        }
        return nil
    }

    var fixedNow: Date {
        var cal = Calendar.localGregorian
        cal.timeZone = .current
        return DateComponents(calendar: cal, year: 2026, month: 11, day: 13, hour: 16, minute: 20).date ?? Date()
    }

    var initialSession: CloudSession? {
        guard self != .signIn else { return nil }
        let exp = Int(fixedNow.addingTimeInterval(3600).timeIntervalSince1970)
        let payload = Data(#"{"sub":"8f21c04a-77e9-49a2-91ab-284f0199a01b","exp":\#(exp)}"#.utf8).base64URLEncodedString()
        return CloudSession(
            accessToken: "eyJhbGciOiJIUzI1NiJ9.\(payload).sim",
            refreshToken: "rt_sim",
            user: CloudUser(
                id: "8f21c04a-77e9-49a2-91ab-284f0199a01b",
                email: "alex.chen@devmail.io",
                name: "Alex Chen"
            )
        )
    }

    var initialTab: AppTab {
        switch self {
        case .limits: return .limits
        case .settings: return .settings
        default: return .pulse
        }
    }

    @MainActor
    func configurePreferences(_ prefs: PhonePreferences) {
        switch self {
        case .active, .limits, .settings:
            prefs.dailySpendTargetUsd = 25
            prefs.weeklySpendTargetUsd = 140
            prefs.monthlySpendTargetUsd = 480
            prefs.updateToolBudget(TrackedToolBudget(
                source: "claude",
                weeklyBudgetUsd: 80,
                monthlyBudgetUsd: 280,
                billingCycle: "monthly",
                nextRenewalISO: ISO8601DateFormatter().string(from: fixedNow.addingTimeInterval(11 * 86_400)),
                autoRenew: true
            ))
            prefs.updateToolBudget(TrackedToolBudget(
                source: "codex",
                weeklyBudgetUsd: 45,
                monthlyBudgetUsd: 160,
                billingCycle: "monthly",
                nextRenewalISO: ISO8601DateFormatter().string(from: fixedNow.addingTimeInterval(18 * 86_400)),
                autoRenew: true
            ))
        default:
            break
        }
    }
}

struct ScenarioCloudClient: CloudDataProviding {
    let scenario: SimulatorLaunchScenario

    private var now: Date { scenario.fixedNow }

    func summary(from: String, to: String, deviceId: String?) async throws -> UsageSummaryResponse {
        try checkGate()
        let today = DayKey.string(now)
        if scenario == .empty {
            return UsageSummaryResponse(
                from: from,
                to: to,
                days: 0,
                totals: TokenTotals(),
                rolling: RollingData(
                    last7d: RollingPeriod(from: DayKey.daysAgo(6, now: now), to: today, activeDays: 0, totals: RollingTotals()),
                    last30d: RollingPeriod(from: DayKey.daysAgo(29, now: now), to: today, activeDays: 0, totals: RollingTotals(), avgPerActiveDay: 0)
                )
            )
        }

        let scale = deviceId == nil ? 1.0 : 0.68
        let isToday = (from == to)
        let tokens = Int(Double(isToday ? 4_860_000 : 34_210_000) * scale)
        let cost = (isToday ? 18.42 : 112.85) * scale
        let conv = max(1, Int(Double(isToday ? 19 : 134) * scale))

        return UsageSummaryResponse(
            from: from,
            to: to,
            days: isToday ? 1 : 7,
            totals: TokenTotals(
                totalTokens: tokens,
                billableTotalTokens: tokens,
                inputTokens: Int(Double(tokens) * 0.14),
                outputTokens: Int(Double(tokens) * 0.09),
                cachedInputTokens: Int(Double(tokens) * 0.67),
                cacheCreationInputTokens: Int(Double(tokens) * 0.10),
                reasoningOutputTokens: Int(Double(tokens) * 0.03),
                conversationCount: conv,
                totalCostUsd: String(format: "%.6f", cost)
            ),
            rolling: RollingData(
                last7d: RollingPeriod(
                    from: DayKey.daysAgo(6, now: now),
                    to: today,
                    activeDays: 7,
                    totals: RollingTotals(billableTotalTokens: Int(34_210_000 * scale), conversationCount: Int(134 * scale))
                ),
                last30d: RollingPeriod(
                    from: DayKey.daysAgo(29, now: now),
                    to: today,
                    activeDays: 26,
                    totals: RollingTotals(billableTotalTokens: Int(128_400_000 * scale), conversationCount: Int(512 * scale)),
                    avgPerActiveDay: Int(4_938_461 * scale)
                )
            )
        )
    }

    func daily(from: String, to: String, deviceId: String?) async throws -> PhoneDailyUsageResponse {
        try checkGate()
        if scenario == .empty {
            return PhoneDailyUsageResponse(from: from, to: to, data: [])
        }
        let scale = deviceId == nil ? 1.0 : 0.68
        let weights: [Double] = [
            0.55, 0.72, 0.80, 0.45, 0.22, 0.64, 0.92, 1.05, 0.88, 0.76,
            0.35, 0.18, 0.85, 1.12, 0.96, 1.04, 0.79, 0.30, 0.42, 0.91,
            1.18, 1.02, 0.87, 0.95, 0.40, 0.58, 1.08, 1.24, 0.98, 1.32
        ]
        let entries: [PhoneDailyEntry] = weights.enumerated().map { idx, w in
            let day = DayKey.daysAgo(29 - idx, now: now)
            let tok = Int(3_700_000 * w * scale)
            let cost = 13.95 * w * scale
            return PhoneDailyEntry(
                day: day,
                totalTokens: tok,
                billableTotalTokens: tok,
                totalCostUsd: cost,
                inputTokens: Int(Double(tok) * 0.15),
                outputTokens: Int(Double(tok) * 0.09),
                cachedInputTokens: Int(Double(tok) * 0.66),
                cacheCreationInputTokens: Int(Double(tok) * 0.10),
                reasoningOutputTokens: Int(Double(tok) * 0.03),
                conversationCount: max(2, Int(14 * w * scale))
            )
        }
        return PhoneDailyUsageResponse(from: DayKey.daysAgo(29, now: now), to: DayKey.string(now), data: entries)
    }

    func hourly(day: String, deviceId: String?) async throws -> PhoneHourlyUsageResponse {
        try checkGate()
        if scenario == .empty {
            return PhoneHourlyUsageResponse(day: day, data: [])
        }
        let today = DayKey.string(now)
        guard day == today else {
            return PhoneHourlyUsageResponse(day: day, data: [])
        }
        let hourlyProfile: [(Int, Int, [String: Int])] = [
            (8, 240_000, ["claude-opus-4-6": 160_000, "composer-2.5": 80_000]),
            (9, 610_000, ["claude-opus-4-6": 410_000, "gpt-5.6-sol": 200_000]),
            (10, 820_000, ["claude-opus-4-6": 520_000, "gpt-5.6-sol": 300_000]),
            (11, 540_000, ["composer-2.5": 290_000, "claude-sonnet-4-6": 250_000]),
            (13, 730_000, ["claude-opus-4-6": 480_000, "muse-spark-1.3-contributor": 250_000]),
            (14, 980_000, ["claude-opus-4-6": 620_000, "gpt-5.6-sol": 360_000]),
            (15, 620_000, ["gpt-5.6-sol": 340_000, "composer-2.5": 280_000]),
            (16, 320_000, ["claude-opus-4-6": 220_000, "muse-spark-1.3-contributor": 100_000]),
        ]
        let rows = hourlyProfile.map { hr, tok, models in
            PhoneHourlyEntry(
                hour: String(format: "%@T%02d:00:00", day, hr),
                totalTokens: tok,
                billableTotalTokens: tok,
                conversationCount: max(1, tok / 220_000),
                models: models
            )
        }
        return PhoneHourlyUsageResponse(day: day, data: rows)
    }

    func modelBreakdown(from: String, to: String, deviceId: String?) async throws -> ModelBreakdownResponse {
        try checkGate()
        if scenario == .empty {
            return ModelBreakdownResponse(from: from, to: to, days: 0, sources: [])
        }
        let isToday = (from == to)
        let isMonth = (DayKey.date(to)?.timeIntervalSince(DayKey.date(from) ?? now) ?? 0) > 10 * 86_400
        let mult: Double = isToday ? 1.0 : (isMonth ? 21.5 : 6.2)

        func makeTotals(_ tokens: Int, _ cost: Double, _ conv: Int, cachedRatio: Double = 0.68, reasoning: Int = 0) -> TokenTotals {
            let t = Int(Double(tokens) * mult)
            let c = cost * mult
            return TokenTotals(
                totalTokens: t,
                billableTotalTokens: t,
                inputTokens: Int(Double(t) * 0.14),
                outputTokens: Int(Double(t) * 0.09),
                cachedInputTokens: Int(Double(t) * cachedRatio),
                cacheCreationInputTokens: Int(Double(t) * 0.09),
                reasoningOutputTokens: Int(Double(reasoning) * mult),
                conversationCount: max(1, Int(Double(conv) * mult)),
                totalCostUsd: String(format: "%.6f", c)
            )
        }

        let claudeOpus = ModelEntry(model: "claude-opus-4-6", modelId: "claude-opus-4-6", totals: makeTotals(2_180_000, 9.65, 8))
        let claudeSonnet = ModelEntry(model: "claude-sonnet-4-6", modelId: "claude-sonnet-4-6", totals: makeTotals(640_000, 1.48, 4))
        let codexSol = ModelEntry(model: "gpt-5.6-sol", modelId: "gpt-5.6-sol", totals: makeTotals(1_150_000, 4.92, 5, reasoning: 180_000))
        let cursorComp = ModelEntry(model: "composer-2.5", modelId: "composer-2.5", totals: makeTotals(590_000, 1.94, 4))
        let museSpark = ModelEntry(model: "muse-spark-1.3-contributor", modelId: "muse-spark-1.3-contributor", totals: makeTotals(300_000, 0.43, 2, reasoning: 42_000))

        let sources: [SourceEntry] = [
            SourceEntry(
                source: "claude",
                totals: makeTotals(2_820_000, 11.13, 12),
                models: [claudeOpus, claudeSonnet]
            ),
            SourceEntry(
                source: "codex",
                totals: makeTotals(1_150_000, 4.92, 5, reasoning: 180_000),
                models: [codexSol]
            ),
            SourceEntry(
                source: "cursor",
                totals: makeTotals(590_000, 1.94, 4),
                models: [cursorComp]
            ),
            SourceEntry(
                source: "muse",
                totals: makeTotals(300_000, 0.43, 2),
                models: [museSpark]
            ),
        ]
        return ModelBreakdownResponse(from: from, to: to, days: isToday ? 1 : 7, sources: sources)
    }

    func heatmap(weeks: Int, to: String, deviceId: String?) async throws -> HeatmapResponse {
        try checkGate()
        let cal = Calendar.localGregorian
        let end = DayKey.date(to) ?? now
        var grid: [[HeatmapCell?]] = []
        var activeCount = 0

        for w in (0..<weeks).reversed() {
            var col: [HeatmapCell?] = []
            for d in 0..<7 {
                let offset = -(w * 7 + (6 - d))
                let date = cal.date(byAdding: .day, value: offset, to: end) ?? end
                let key = DayKey.string(date)
                if scenario == .empty {
                    col.append(HeatmapCell(day: key, totalTokens: 0, billableTotalTokens: 0, level: 0))
                } else {
                    let seed = (w * 7 + d * 13) % 11
                    let isRecentStreak = (w == 0 && d >= 1) || (w == 1)
                    let level = isRecentStreak ? ((d % 3) + 2) : (seed <= 2 ? 0 : (seed % 4) + 1)
                    let tok = level * 1_250_000
                    if level > 0 { activeCount += 1 }
                    col.append(HeatmapCell(day: key, totalTokens: tok, billableTotalTokens: tok, level: level))
                }
            }
            grid.append(col)
        }
        return HeatmapResponse(
            from: DayKey.daysAgo(weeks * 7 - 1, now: now),
            to: to,
            weekStartsOn: "sun",
            activeDays: activeCount,
            streakDays: 0,
            weeks: grid
        )
    }

    func accountDevices(from: String, to: String) async throws -> AccountDevicesResponse {
        try checkGate()
        if scenario == .empty {
            return AccountDevicesResponse(from: from, to: to, devices: [], accountSources: [])
        }
        return AccountDevicesResponse(
            from: from,
            to: to,
            devices: [
                AccountDeviceRow(id: "d4c19a10-33b2-45e0-8812-001122334455", deviceName: "MacBook Pro M4 Max", platform: "darwin", totalTokens: 86_400_000),
                AccountDeviceRow(id: "a982e120-9012-4c11-9120-556677889900", deviceName: "Linux Devbox (hetzner-01)", platform: "linux", totalTokens: 29_800_000),
            ],
            accountSources: [
                AccountLevelSourceRow(source: "cursor", totalTokens: 12_200_000)
            ]
        )
    }

    func renameDevice(deviceId: String, name: String) async throws {}

    func cloudAccountStatus() async throws -> CloudAccountStatusResponse {
        try checkGate()
        let expires = ISO8601DateFormatter().string(from: now.addingTimeInterval(240 * 86_400))
        return CloudAccountStatusResponse(
            environment: "live",
            membership: CloudMembershipInfo(
                status: "active",
                hostingMode: "hosted",
                expiresAt: expires,
                accessSource: "payment",
                canReadCloud: true,
                canUploadCloud: true,
                machineLimit: 99,
                syncIntervalSeconds: 900,
                hourlyHistoryDays: 90,
                dailyHistoryMonths: 24
            ),
            machineCount: scenario == .empty ? 0 : 2,
            subscriptions: []
        )
    }

    func cloudMachines() async throws -> CloudMachineListResponse {
        try checkGate()
        if scenario == .empty {
            return CloudMachineListResponse(machines: [], machineCount: 0, machineLimit: 99, overMachineLimit: false)
        }
        let iso = ISO8601DateFormatter()
        return CloudMachineListResponse(
            machines: [
                CloudMachineItem(
                    machineId: "d4c19a10-33b2-45e0-8812-001122334455",
                    name: "MacBook Pro M4 Max",
                    platform: "darwin",
                    status: "active",
                    lastSeenAt: iso.string(from: now.addingTimeInterval(-420))
                ),
                CloudMachineItem(
                    machineId: "a982e120-9012-4c11-9120-556677889900",
                    name: "Linux Devbox (hetzner-01)",
                    platform: "linux",
                    status: "active",
                    lastSeenAt: iso.string(from: now.addingTimeInterval(-2_100))
                ),
            ],
            machineCount: 2,
            machineLimit: 99,
            overMachineLimit: false
        )
    }

    func setMachinePaused(machineId: String, paused: Bool) async throws {}

    func publicVisibility() async throws -> PublicVisibilityState {
        PublicVisibilityState(
            enabled: true,
            anonymous: false,
            displayName: "Alex Chen",
            githubUrl: "https://github.com/alexchen",
            showGithubUrl: true
        )
    }

    func updatePublicVisibility(_ patch: PublicVisibilityPatch) async throws -> PublicVisibilityState {
        PublicVisibilityState(
            enabled: patch.enabled ?? true,
            anonymous: patch.anonymous ?? false,
            displayName: patch.displayName ?? "Alex Chen",
            githubUrl: patch.clearGithubUrl ? nil : (patch.githubUrl ?? "https://github.com/alexchen"),
            showGithubUrl: patch.showGithubUrl ?? true
        )
    }

    func authorizeCLIDevice(userCode: String) async throws {}

    private func checkGate() throws {
        switch scenario {
        case .cloudRequired:
            throw CloudError.cloudAccessRequired(code: "cloud_membership_required")
        case .cloudExpired:
            throw CloudError.cloudAccessRequired(code: "cloud_read_only_expired")
        case .error:
            throw CloudError.transport("The network connection was lost while syncing with TokenTracker Cloud.")
        default:
            break
        }
    }
}
#endif
