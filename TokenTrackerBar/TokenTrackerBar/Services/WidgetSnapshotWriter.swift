import Foundation
import WidgetKit
import os

/// Bridge between the live `DashboardViewModel` and the on-disk widget
/// snapshot file. Called from `DashboardViewModel.loadAll()` after every
/// successful refresh, and again after a manual sync.
///
/// Behavior:
///   1. Translates view model state into a `WidgetSnapshot`
///   2. Writes it atomically to the App Group container
///   3. Tells WidgetKit to reload all widget timelines
@MainActor
enum WidgetSnapshotWriter {

    private static let logger = Logger(subsystem: "com.tokentracker.bar", category: "WidgetSnapshotWriter")

    /// Immutable snapshot of the fields we read off `DashboardViewModel`.
    /// Captured synchronously on the main actor BEFORE we suspend on any
    /// async work. `capturedAt` is supplied by `loadAll()` so the queried data
    /// and the resulting widget snapshot share one calendar-day reference.
    private struct VMInputs {
        let capturedAt: Date
        let serverOnline: Bool
        let todaySummary: UsageSummaryResponse?
        let summary: UsageSummaryResponse?
        let rollingSummary: UsageSummaryResponse?
        let totalSummary: UsageSummaryResponse?
        let daily: [DailyEntry]
        let topModels: [TopModel]
        let fleetData: [FleetEntry]
        let heatmap: HeatmapResponse?
        let usageLimits: UsageLimitsResponse?
    }

    /// Preserve the pre-existing five-minute widget freshness contract only
    /// for users who actually placed a TokenTracker widget. Everyone else can
    /// stay on the lightweight hidden refresh path.
    static func hasConfiguredWidgets() async -> Bool {
        await withCheckedContinuation { continuation in
            WidgetCenter.shared.getCurrentConfigurations { result in
                switch result {
                case .success(let configurations):
                    continuation.resume(returning: !configurations.isEmpty)
                case .failure:
                    // Fail toward freshness: a transient WidgetKit query error
                    // must not leave an existing widget stale indefinitely.
                    continuation.resume(returning: true)
                }
            }
        }
    }

    static func update(from vm: DashboardViewModel, capturedAt: Date) async {
        // Monotonic ticket (main-actor serialized): if a newer update starts
        // while we're suspended on the range fetches below, this call is stale
        // and must not write — otherwise its older snapshot could land after
        // (and clobber) the newer one.
        updateGeneration += 1
        let ticket = updateGeneration

        // STEP 1 — synchronously freeze every VM field we will need. After
        // this point we never touch `vm` again. This is the fix for the
        // race where a second loadAll() could mutate the view model while
        // we're awaiting the range fetches below, producing a snapshot that
        // mixed two different refreshes.
        let inputs = VMInputs(
            capturedAt: capturedAt,
            serverOnline: vm.serverOnline,
            todaySummary: vm.todaySummary,
            summary: vm.summary,
            rollingSummary: vm.rollingSummary,
            totalSummary: vm.totalSummary,
            daily: vm.daily,
            topModels: vm.topModels,
            fleetData: vm.fleetData,
            heatmap: vm.heatmap,
            usageLimits: vm.usageLimits
        )

        // STEP 2 — `rolling.*` omits cost and is anchored to the server's live
        // clock. Fetch explicit captured ranges so every displayed field in
        // each period comes from one response and one calendar window.
        let last7dRange = DateHelpers.dayRange(daysBack: 6, endingAt: inputs.capturedAt)
        let last30dRange = DateHelpers.dayRange(daysBack: 29, endingAt: inputs.capturedAt)
        async let last7dSummary = fetchRangeSummary(last7dRange)
        async let last30dSummary = fetchRangeSummary(last30dRange)
        let (summary7d, summary30d) = await (last7dSummary, last30dSummary)

        // Superseded while awaiting the range fetches — drop this stale write.
        guard ticket == updateGeneration else { return }

        let snapshot = buildSnapshot(
            from: inputs,
            last7dSummary: summary7d,
            last30dSummary: summary30d,
            last7dRange: last7dRange,
            last30dRange: last30dRange
        )
        // Write off the main actor on a serial queue (no main-thread file IO,
        // no torn concurrent writes); the generation guard above is what
        // keeps stale snapshots from overwriting newer ones.
        let ok = await withCheckedContinuation { continuation in
            writeQueue.async {
                continuation.resume(returning: WidgetSnapshotStore.write(snapshot))
            }
        }
        if ok {
            WidgetCenter.shared.reloadAllTimelines()
            logger.debug("Widget snapshot written and timelines reloaded")
        } else {
            logger.warning("Failed to write widget snapshot")
        }
    }

    /// Serializes snapshot writes off the main actor.
    private static let writeQueue = DispatchQueue(label: "com.tokentracker.widget-snapshot-write", qos: .utility)

    /// Bumped at the start of every `update`; stale calls bail before writing.
    private static var updateGeneration = 0

    /// Fetches all totals for an explicit captured range. Returns nil on any
    /// failure so the widget can fall back to matching dashboard rolling fields.
    private static func fetchRangeSummary(
        _ range: (from: String, to: String)
    ) async -> UsageSummaryResponse? {
        do {
            return try await APIClient.shared.fetchSummary(from: range.from, to: range.to)
        } catch {
            logger.warning(
                "widget range fetch \(range.from)-\(range.to) failed: \(error.localizedDescription)"
            )
            return nil
        }
    }

    // MARK: - Translation

    private static func buildSnapshot(
        from inputs: VMInputs,
        last7dSummary: UsageSummaryResponse?,
        last30dSummary: UsageSummaryResponse?,
        last7dRange: (from: String, to: String),
        last30dRange: (from: String, to: String)
    ) -> WidgetSnapshot {
        let last7d = rangeTotals(
            from: last7dSummary,
            fallback: inputs.rollingSummary?.rolling.last7d,
            expectedRange: last7dRange
        )
        let last30d = rangeTotals(
            from: last30dSummary,
            fallback: inputs.rollingSummary?.rolling.last30d,
            expectedRange: last30dRange
        )

        // All-time total — pair the tokens/cost with the heatmap's all-time
        // active-days so widgets can show a consistent "lifetime" row.
        var total = periodTotals(from: inputs.totalSummary)
        total.activeDays = inputs.heatmap?.activeDays ?? total.activeDays

        return WidgetSnapshot(
            generatedAt: inputs.capturedAt,
            serverOnline: inputs.serverOnline,
            today: periodTotals(from: inputs.todaySummary),
            last7d: last7d,
            last30d: last30d,
            total: total,
            selected: periodTotals(from: inputs.summary),
            dailyTrend: trendPoints(from: inputs.daily),
            topModels: topModelEntries(from: inputs.topModels),
            sources: sourceEntries(from: inputs.fleetData),
            heatmap: heatmapPayload(from: inputs.heatmap),
            limits: limitProviders(from: inputs.usageLimits)
        )
    }

    // MARK: - Helpers

    private static func parseCost(_ s: String?) -> Double? {
        guard let s, let v = Double(s) else { return nil }
        return v
    }

    private static func periodTotals(from summary: UsageSummaryResponse?) -> PeriodTotals {
        guard let t = summary?.totals else { return .empty }
        let billable = t.billableTotalTokens > 0 ? t.billableTotalTokens : t.totalTokens
        return PeriodTotals(
            tokens: billable,
            costUsd: parseCost(t.totalCostUsd),
            conversations: t.conversationCount,
            activeDays: 0
        )
    }

    private static func rollingTotals(from window: RollingPeriod?) -> PeriodTotals {
        guard let window else { return .empty }
        return PeriodTotals(
            tokens: window.totals.billableTotalTokens,
            costUsd: 0, // rolling endpoint does not return cost
            conversations: window.totals.conversationCount,
            activeDays: window.activeDays
        )
    }

    private static func rangeTotals(
        from summary: UsageSummaryResponse?,
        fallback: RollingPeriod?,
        expectedRange: (from: String, to: String)
    ) -> PeriodTotals {
        if let summary,
           summary.from == expectedRange.from,
           summary.to == expectedRange.to {
            var totals = periodTotals(from: summary)
            totals.activeDays = summary.days
            return totals
        }
        // A server-clock fallback from another day would recreate the same
        // cross-midnight tear, so fail closed unless its range matches exactly.
        guard let fallback,
              fallback.from == expectedRange.from,
              fallback.to == expectedRange.to else {
            return .empty
        }
        return rollingTotals(from: fallback)
    }

    private static func trendPoints(from daily: [DailyEntry]) -> [DailyPoint] {
        // Take last 30 days, parse the YYYY-MM-DD string into a Date.
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current

        return daily.suffix(30).compactMap { entry in
            guard let date = formatter.date(from: entry.day) else { return nil }
            let tokens = entry.billableTotalTokens > 0 ? entry.billableTotalTokens : entry.totalTokens
            return DailyPoint(day: date, totalTokens: tokens, costUsd: 0)
        }
    }

    private static func topModelEntries(from models: [TopModel]) -> [SnapshotModelEntry] {
        models.prefix(5).map { m in
            SnapshotModelEntry(
                id: m.id,
                name: m.name,
                source: m.source,
                tokens: m.tokens,
                sharePercent: Double(m.percent) ?? 0
            )
        }
    }

    private static func sourceEntries(from fleet: [FleetEntry]) -> [SnapshotSourceEntry] {
        fleet.map { entry in
            SnapshotSourceEntry(
                source: entry.label.lowercased(),
                tokens: entry.usage,
                costUsd: entry.usd,
                sharePercent: Double(entry.totalPercent) ?? 0
            )
        }
    }

    private static func heatmapPayload(from heatmap: HeatmapResponse?) -> HeatmapPayload {
        guard let heatmap else { return .empty }
        // Compress to a 2D Int matrix of levels — one entry per day, 7 per week.
        // Missing days become level 0.
        let weeks: [[Int]] = heatmap.weeks.map { week in
            var row = Array(repeating: 0, count: 7)
            for (idx, cell) in week.enumerated() where idx < 7 {
                if let cell {
                    row[idx] = max(0, min(4, cell.level))
                }
            }
            return row
        }
        return HeatmapPayload(
            weeks: weeks,
            activeDays: heatmap.activeDays,
            streakDays: heatmap.streakDays
        )
    }

    // MARK: - Limits flattening
    //
    // The native limits API exposes per-provider structs with several
    // optional windows each. We flatten them into a uniform list so the
    // widget can render generically.

    private static func limitProviders(from limits: UsageLimitsResponse?) -> [LimitProvider] {
        guard let limits else { return [] }
        // Honor the user's Limits Display visibility preferences — the
        // dashboard, popover and menu bar all hide these providers, so the
        // desktop widget must not keep showing them (PR #168 follow-up).
        let hiddenProviders = LimitsSettingsStore.shared.hiddenProviders
        var out: [LimitProvider] = []

        // Claude — `utilization` from /tokentracker-usage-limits is a 0–100
        // percentage, not a 0–1 fraction. Divide by 100 to match the
        // LimitProvider contract (and what every other provider here does).
        if limits.claude.configured {
            if let w = limits.claude.fiveHour {
                out.append(LimitProvider(source: "claude", label: "Claude · 5h",
                                         fraction: w.utilization / 100.0,
                                         resetsAt: parseISO(w.resetsAt)))
            }
            if let w = limits.claude.sevenDay {
                out.append(LimitProvider(source: "claude", label: "Claude · 7d",
                                         fraction: w.utilization / 100.0,
                                         resetsAt: parseISO(w.resetsAt)))
            }
            if let w = limits.claude.sevenDayOpus {
                out.append(LimitProvider(source: "claude", label: "Claude · 7d Opus",
                                         fraction: w.utilization / 100.0,
                                         resetsAt: parseISO(w.resetsAt)))
            }
            for w in limits.claude.weeklyScoped ?? [] {
                out.append(LimitProvider(source: "claude", label: "Claude · 7d \(w.label)",
                                         fraction: w.utilization / 100.0,
                                         resetsAt: parseISO(w.resetsAt)))
            }
        }

        // Codex
        if limits.codex.configured {
            if let w = limits.codex.primaryWindow {
                out.append(LimitProvider(source: "codex", label: "Codex · 5h",
                                         fraction: Double(w.usedPercent) / 100.0,
                                         resetsAt: parseEpoch(w.resetAt)))
            }
            if let w = limits.codex.secondaryWindow {
                out.append(LimitProvider(source: "codex", label: "Codex · weekly",
                                         fraction: Double(w.usedPercent) / 100.0,
                                         resetsAt: parseEpoch(w.resetAt)))
            }
            if let w = limits.codex.sparkPrimaryWindow {
                out.append(LimitProvider(source: "codex", label: "Codex · Spark 5h",
                                         fraction: Double(w.usedPercent) / 100.0,
                                         resetsAt: parseEpoch(w.resetAt)))
            }
            if let w = limits.codex.sparkSecondaryWindow {
                out.append(LimitProvider(source: "codex", label: "Codex · Spark 7d",
                                         fraction: Double(w.usedPercent) / 100.0,
                                         resetsAt: parseEpoch(w.resetAt)))
            }
        }

        // Cursor
        if limits.cursor.configured {
            if let w = limits.cursor.primaryWindow {
                out.append(LimitProvider(source: "cursor", label: "Cursor",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // Gemini
        if limits.gemini.configured {
            if let w = limits.gemini.primaryWindow {
                out.append(LimitProvider(source: "gemini", label: "Gemini",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // Kimi
        if let kimi = limits.kimi, kimi.configured {
            if let w = kimi.primaryWindow {
                out.append(LimitProvider(source: "kimi", label: "Kimi · weekly",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
            if let w = kimi.secondaryWindow {
                out.append(LimitProvider(source: "kimi", label: "Kimi · 5h",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
            if let w = kimi.tertiaryWindow {
                out.append(LimitProvider(source: "kimi", label: "Kimi · total",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // Kiro
        if limits.kiro.configured {
            if let w = limits.kiro.primaryWindow {
                out.append(LimitProvider(source: "kiro", label: "Kiro",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // Grok Build
        if let grok = limits.grok, grok.configured {
            if let w = grok.primaryWindow {
                let periodLabel: String
                switch grok.periodType {
                case "weekly": periodLabel = "Weekly"
                case "daily": periodLabel = "Daily"
                default: periodLabel = "Month"
                }
                out.append(LimitProvider(source: "grok", label: "Grok Build · \(periodLabel)",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
            if let w = grok.secondaryWindow {
                out.append(LimitProvider(source: "grok", label: "Grok Build · On-demand",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // Antigravity
        if limits.antigravity.configured {
            if let w = limits.antigravity.primaryWindow {
                out.append(LimitProvider(source: "antigravity", label: "Antigravity",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // OpenCode Go
        if let opencodeGo = limits.opencodeGo, opencodeGo.configured {
            if let w = opencodeGo.primaryWindow {
                out.append(LimitProvider(source: "opencodeGo", label: "OpenCode Go",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
            if let w = opencodeGo.secondaryWindow {
                out.append(LimitProvider(source: "opencodeGo", label: "OpenCode Go · Weekly",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
            if let w = opencodeGo.tertiaryWindow {
                out.append(LimitProvider(source: "opencodeGo", label: "OpenCode Go · Monthly",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // Command Code
        if let commandCode = limits.commandCode, commandCode.configured {
            if let w = commandCode.primaryWindow {
                out.append(LimitProvider(source: "commandCode", label: "Command Code",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
            if let w = commandCode.secondaryWindow {
                out.append(LimitProvider(source: "commandCode", label: "Command Code · Weekly",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // Devin
        if let devin = limits.devin, devin.configured {
            if let w = devin.primaryWindow {
                out.append(LimitProvider(source: "devin", label: "Devin · Daily",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
            if let w = devin.secondaryWindow {
                out.append(LimitProvider(source: "devin", label: "Devin · Weekly",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // GitHub Copilot
        if let copilot = limits.copilot, copilot.configured {
            if let w = copilot.primaryWindow {
                out.append(LimitProvider(source: "copilot", label: "Copilot",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        return out.filter { !hiddenProviders.contains($0.source) }
    }

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func parseISO(_ s: String?) -> Date? {
        guard let s else { return nil }
        if let d = iso8601.date(from: s) { return d }
        // Retry without fractional seconds
        let alt = ISO8601DateFormatter()
        alt.formatOptions = [.withInternetDateTime]
        return alt.date(from: s)
    }

    private static func parseEpoch(_ epoch: Int?) -> Date? {
        guard let epoch else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(epoch))
    }
}
