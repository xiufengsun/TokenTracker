import Foundation

// MARK: - Usage Scope & Time Horizon

enum UsageHorizon: String, CaseIterable, Identifiable {
    case today
    case week
    case month
    case total

    var id: String { rawValue }

    var label: String {
        switch self {
        case .today: return "Today"
        case .week: return "Week"
        case .month: return "Month"
        case .total: return "24M"
        }
    }

    var fullTitle: String {
        switch self {
        case .today: return "Today"
        case .week: return "This Week"
        case .month: return "This Month"
        case .total: return "Last 24 Months"
        }
    }

    func range(now: Date = Date(), calendar: Calendar = .localGregorian) -> (from: String, to: String) {
        let today = DayKey.string(now, calendar: calendar)
        switch self {
        case .today:
            return (today, today)
        case .week:
            let weekday = calendar.component(.weekday, from: now)
            let daysFromMonday = (weekday + 5) % 7
            let monday = calendar.date(byAdding: .day, value: -daysFromMonday, to: now) ?? now
            let sunday = calendar.date(byAdding: .day, value: 6, to: monday) ?? now
            return (DayKey.string(monday, calendar: calendar), DayKey.string(sunday, calendar: calendar))
        case .month:
            guard let start = calendar.date(from: calendar.dateComponents([.year, .month], from: now)),
                  let next = calendar.date(byAdding: .month, value: 1, to: start),
                  let end = calendar.date(byAdding: .day, value: -1, to: next) else {
                return (today, today)
            }
            return (DayKey.string(start, calendar: calendar), DayKey.string(end, calendar: calendar))
        case .total:
            let back = calendar.date(byAdding: .month, value: -24, to: now) ?? now
            let start = calendar.date(from: calendar.dateComponents([.year, .month], from: back)) ?? back
            return (DayKey.string(start, calendar: calendar), today)
        }
    }
}

enum DayKey {
    static func string(_ date: Date, calendar: Calendar = .localGregorian) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    static func date(_ day: String, calendar: Calendar = .localGregorian) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: day)
    }

    static func daysAgo(_ n: Int, now: Date = Date(), calendar: Calendar = .localGregorian) -> String {
        string(calendar.date(byAdding: .day, value: -n, to: now) ?? now, calendar: calendar)
    }
}

extension Calendar {
    static var localGregorian: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }
}

// MARK: - Provider Catalog

enum ProviderIdentity {
    static func displayName(_ source: String) -> String {
        switch source.lowercased() {
        case "claude": return "Claude Code"
        case "codex": return "Codex"
        case "cursor": return "Cursor"
        case "gemini": return "Gemini CLI"
        case "kimi": return "Kimi Code"
        case "kiro": return "Kiro"
        case "grok": return "Grok Build"
        case "copilot", "pi-copilot", "pi-github-copilot": return "GitHub Copilot"
        case "antigravity": return "Antigravity"
        case "opencode": return "OpenCode"
        case "opencodego", "opencode-go": return "OpenCode Go"
        case "muse": return "Muse Code"
        case "deepseek": return "DeepSeek"
        case "zcode": return "ZCode"
        case "qoder": return "Qoder"
        case "qoder-cn", "qodercn": return "Qoder CN"
        case "devin": return "Devin"
        case "cline": return "Cline"
        case "trae": return "TRAE"
        case "trae-cn": return "TRAE CN"
        case "every-code", "everycode": return "Every Code"
        default:
            return source
                .split(whereSeparator: { $0 == "-" || $0 == "_" })
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    static func shortName(_ source: String) -> String {
        switch source.lowercased() {
        case "claude": return "Claude"
        case "gemini": return "Gemini"
        case "kimi": return "Kimi"
        case "grok": return "Grok"
        case "copilot", "pi-copilot", "pi-github-copilot": return "Copilot"
        case "muse": return "Muse"
        default: return displayName(source)
        }
    }

    /// True when the source comes from an account-wide cloud API rather than per-machine logs.
    static func isAccountLevelSource(_ source: String) -> Bool {
        let lower = source.lowercased()
        return lower == "cursor" || lower == "trae-cn"
    }
}

// MARK: - Ranked Usage Aggregates

extension TokenTotals {
    var displayTokens: Int {
        billableTotalTokens > 0 ? billableTotalTokens : totalTokens
    }

    var cacheHitRatio: Double {
        let totalPrompt = inputTokens + cachedInputTokens + cacheCreationInputTokens
        guard totalPrompt > 0 else { return 0 }
        return Double(cachedInputTokens) / Double(totalPrompt)
    }
}

struct RankedModelItem: Identifiable, Equatable {
    var id: String { name }
    var name: String
    var sources: [String]
    var tokens: Int
    var inputTokens: Int
    var outputTokens: Int
    var cachedInputTokens: Int
    var reasoningTokens: Int
    var conversations: Int
    var costUsd: Double
}

struct RankedProviderItem: Identifiable, Equatable {
    var id: String { source }
    var source: String
    var tokens: Int
    var conversations: Int
    var costUsd: Double
    var topModel: String?
    var models: [RankedModelItem]

    var displayName: String { ProviderIdentity.displayName(source) }
}

// MARK: - Rolling Window & Pacing Snapshot (Limits & Pacing Tab + Pulse Glance)

struct WindowTelemetryBar: Identifiable, Equatable {
    var id: String
    var label: String
    var windowSeconds: Double
    var resetDate: Date?
    var tokensUsed: Int
    var costUsedUsd: Double
    var budgetUsd: Double?
    var baselineTokens: Int?

    /// Fraction 0...1.5 when a user budget is configured; nil when purely observational.
    var budgetFraction: Double? {
        guard let budgetUsd, budgetUsd > 0 else { return nil }
        return costUsedUsd / budgetUsd
    }

    /// Pace computation using the shared macOS `LimitPace` engine when a target exists.
    func paceResult(now: Date = Date(), remainingMode: Bool) -> LimitPace.Result? {
        guard let fraction = budgetFraction, let resetDate else { return nil }
        let clamped = min(max(fraction, 0), 1)
        let untilReset = resetDate.timeIntervalSince(now)
        guard untilReset > 0 else { return nil }
        return LimitPace.compute(
            usedFraction: clamped,
            windowSeconds: windowSeconds,
            secondsUntilReset: untilReset,
            remainingMode: remainingMode
        )
    }
}

struct ProviderPacingProfile: Identifiable, Equatable {
    var id: String { source }
    var source: String
    var sevenDayTokens: Int
    var sevenDayCostUsd: Double
    var thirtyDayTokens: Int
    var thirtyDayCostUsd: Double
    var sevenDayConversations: Int
    var budget: TrackedToolBudget?

    var displayName: String { ProviderIdentity.displayName(source) }

    /// Highest share of a user-set cap (7d or 30d) this tool has used, if any.
    var hottestBudgetFraction: Double? {
        guard let budget else { return nil }
        var candidates: [Double] = []
        if let bw = budget.weeklyBudgetUsd, bw > 0 {
            candidates.append(sevenDayCostUsd / bw)
        }
        if let bm = budget.monthlyBudgetUsd, bm > 0 {
            candidates.append(thirtyDayCostUsd / bm)
        }
        return candidates.max()
    }
}

struct ActivityStreak: Equatable {
    var days: Int
    var reachesHistoryStart: Bool

    var displayLabel: String {
        if days == 0 { return "No streak" }
        return reachesHistoryStart ? "\(days)+ day streak" : "\(days)d streak"
    }
}

extension HeatmapResponse {
    func currentStreak(today: String) -> ActivityStreak {
        let cells = weeks.flatMap { $0 }.compactMap { $0 }
        let fetched = Set(cells.map(\.day))
        let active = Set(cells.filter { $0.totalTokens > 0 || $0.level > 0 }.map(\.day))
        guard var cursor = DayKey.date(today) else { return ActivityStreak(days: 0, reachesHistoryStart: false) }
        let calendar = Calendar.localGregorian
        if !active.contains(today) {
            cursor = calendar.date(byAdding: .day, value: -1, to: cursor) ?? cursor
        }
        var days = 0
        while active.contains(DayKey.string(cursor)) {
            days += 1
            guard let previous = calendar.date(byAdding: .day, value: -1, to: cursor) else { break }
            cursor = previous
        }
        return ActivityStreak(days: days, reachesHistoryStart: days > 0 && !fetched.contains(DayKey.string(cursor)))
    }
}

// MARK: - Unified Workspace Snapshot

struct PhoneWorkspaceSnapshot: Equatable {
    var horizon: UsageHorizon
    var selectedDeviceId: String?
    var now: Date

    var periodSummary: UsageSummaryResponse
    var todaySummary: UsageSummaryResponse
    var daily30d: PhoneDailyUsageResponse? = nil
    var todayHourly: PhoneHourlyUsageResponse? = nil
    var yesterdayHourly: PhoneHourlyUsageResponse? = nil
    var periodBreakdown: ModelBreakdownResponse? = nil
    var weeklyBreakdown: ModelBreakdownResponse? = nil
    var monthlyBreakdown: ModelBreakdownResponse? = nil
    var heatmap: HeatmapResponse? = nil
    var accountDevices: AccountDevicesResponse? = nil
    var cloudAccount: CloudAccountStatusResponse? = nil
    var cloudMachines: CloudMachineListResponse? = nil

    var periodCostUsd: Double {
        Double(periodSummary.totals.totalCostUsd ?? "") ?? 0
    }

    var todayCostUsd: Double {
        Double(todaySummary.totals.totalCostUsd ?? "") ?? 0
    }

    var sevenDayCostUsd: Double {
        guard let days = daily30d?.data else { return 0 }
        let cutoff = DayKey.daysAgo(6, now: now)
        let today = DayKey.string(now)
        return days
            .filter { $0.day >= cutoff && $0.day <= today }
            .reduce(0) { $0 + $1.totalCostUsd }
    }

    var thirtyDayCostUsd: Double {
        guard let days = daily30d?.data else { return 0 }
        let cutoff = DayKey.daysAgo(29, now: now)
        let today = DayKey.string(now)
        return days
            .filter { $0.day >= cutoff && $0.day <= today }
            .reduce(0) { $0 + $1.totalCostUsd }
    }

    var averageDailyCost30d: Double {
        let active = max(todaySummary.rolling.last30d.activeDays, 1)
        return thirtyDayCostUsd / Double(active)
    }

    /// Tokens in the hourly buckets that overlap the last 5 hours: the current
    /// hour plus the four before it (`account-hourly`, today + yesterday). The
    /// API reports whole local hours, so this can include up to 59 minutes more.
    var trailingFiveHourTokens: Int {
        trailingFiveHourBuckets.reduce(0) { $0 + $1.totalTokens }
    }

    private var trailingFiveHourBuckets: [PhoneHourlyEntry] {
        let all = (yesterdayHourly?.data ?? []) + (todayHourly?.data ?? [])
        let cal = Calendar.localGregorian
        let currentHourStart = cal.dateInterval(of: .hour, for: now)?.start ?? now
        let firstHourStart = currentHourStart.addingTimeInterval(-4 * 3600)
        return all.filter { entry in
            guard let date = Self.parseLocalHour(entry.hour, calendar: cal) else { return false }
            return date >= firstHourStart && date <= currentHourStart
        }
    }

    static func parseLocalHour(_ raw: String, calendar: Calendar = .localGregorian) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        if let d = formatter.date(from: raw) { return d }
        let iso = ISO8601DateFormatter()
        return iso.date(from: raw)
    }

    var rankedModels: [RankedModelItem] {
        Self.rankModels(from: periodBreakdown)
    }

    var rankedProviders: [RankedProviderItem] {
        Self.rankProviders(from: periodBreakdown)
    }

    func providerPacingProfiles(budgets: [String: TrackedToolBudget]) -> [ProviderPacingProfile] {
        let weeklyBySource = Dictionary(uniqueKeysWithValues: Self.rankProviders(from: weeklyBreakdown).map { ($0.source.lowercased(), $0) })
        let monthlyBySource = Dictionary(uniqueKeysWithValues: Self.rankProviders(from: monthlyBreakdown).map { ($0.source.lowercased(), $0) })

        let allSources = Set(weeklyBySource.keys).union(monthlyBySource.keys).union(budgets.keys)
            .filter { !$0.isEmpty }

        let profiles: [ProviderPacingProfile] = allSources.map { source in
            let w = weeklyBySource[source]
            let m = monthlyBySource[source]
            return ProviderPacingProfile(
                source: w?.source ?? m?.source ?? source,
                sevenDayTokens: w?.tokens ?? 0,
                sevenDayCostUsd: w?.costUsd ?? 0,
                thirtyDayTokens: m?.tokens ?? 0,
                thirtyDayCostUsd: m?.costUsd ?? 0,
                sevenDayConversations: w?.conversations ?? 0,
                budget: budgets[source]
            )
        }

        return profiles
            .filter { $0.thirtyDayTokens > 0 || $0.sevenDayConversations > 0 || $0.budget?.hasAnyRule == true }
            .sorted { lhs, rhs in
                let lf = lhs.hottestBudgetFraction ?? -1
                let rf = rhs.hottestBudgetFraction ?? -1
                if lf != rf { return lf > rf }
                if lhs.thirtyDayCostUsd != rhs.thirtyDayCostUsd { return lhs.thirtyDayCostUsd > rhs.thirtyDayCostUsd }
                return lhs.source < rhs.source
            }
    }

    static func rankModels(from breakdown: ModelBreakdownResponse?) -> [RankedModelItem] {
        var byName: [String: RankedModelItem] = [:]
        for source in breakdown?.sources ?? [] {
            for model in source.models {
                let name = model.model.isEmpty ? model.modelId : model.model
                var item = byName[name] ?? RankedModelItem(
                    name: name,
                    sources: [],
                    tokens: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedInputTokens: 0,
                    reasoningTokens: 0,
                    conversations: 0,
                    costUsd: 0
                )
                item.tokens += model.totals.displayTokens
                item.inputTokens += model.totals.inputTokens
                item.outputTokens += model.totals.outputTokens
                item.cachedInputTokens += model.totals.cachedInputTokens
                item.reasoningTokens += model.totals.reasoningOutputTokens
                item.conversations += model.totals.conversationCount
                item.costUsd += Double(model.totals.totalCostUsd ?? "") ?? 0
                if !item.sources.contains(source.source) {
                    item.sources.append(source.source)
                }
                byName[name] = item
            }
        }
        return byName.values
            .filter { $0.tokens > 0 || $0.conversations > 0 }
            .sorted { ($0.tokens, $0.conversations, $1.name) > ($1.tokens, $1.conversations, $0.name) }
    }

    static func rankProviders(from breakdown: ModelBreakdownResponse?) -> [RankedProviderItem] {
        (breakdown?.sources ?? [])
            .map { entry in
                let models = entry.models
                    .map { m in
                        let name = m.model.isEmpty ? m.modelId : m.model
                        return RankedModelItem(
                            name: name,
                            sources: [entry.source],
                            tokens: m.totals.displayTokens,
                            inputTokens: m.totals.inputTokens,
                            outputTokens: m.totals.outputTokens,
                            cachedInputTokens: m.totals.cachedInputTokens,
                            reasoningTokens: m.totals.reasoningOutputTokens,
                            conversations: m.totals.conversationCount,
                            costUsd: Double(m.totals.totalCostUsd ?? "") ?? 0
                        )
                    }
                    .filter { $0.tokens > 0 || $0.conversations > 0 }
                    .sorted { ($0.tokens, $0.conversations, $1.name) > ($1.tokens, $1.conversations, $0.name) }

                return RankedProviderItem(
                    source: entry.source,
                    tokens: entry.totals.displayTokens,
                    conversations: entry.totals.conversationCount,
                    costUsd: Double(entry.totals.totalCostUsd ?? "") ?? 0,
                    topModel: models.first?.name,
                    models: models
                )
            }
            .filter { $0.tokens > 0 || $0.conversations > 0 }
            .sorted { ($0.tokens, $0.conversations, $1.source) > ($1.tokens, $1.conversations, $0.source) }
    }
}
