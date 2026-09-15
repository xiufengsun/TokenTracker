import Foundation

// Lightweight, self-contained data model used by the desktop widgets.
//
// The main app produces this snapshot from `DashboardViewModel` after every
// refresh and writes it to a shared App Group container. The widget extension
// reads it from the same container, so widgets keep working even when the menu
// bar app is not currently running (they just show the last known data).
//
// Keep this file purely Foundation — no SwiftUI/AppKit/WidgetKit imports — so
// it can be compiled into both the main app target and the widget extension.

// MARK: - App Group constants

public enum WidgetSharedConstants {
    /// Shared App Group identifier. Must be added to *both* targets'
    /// entitlements (`com.apple.security.application-groups`).
    public static let appGroupIdentifier = "group.com.tokentracker.bar"

    /// Bundle identifier of the widget extension. Used by the host app to
    /// write snapshot files directly into the widget's sandbox container as
    /// a fallback path for ad-hoc / dev signed builds where the App Group
    /// container is not actually provisioned by the system.
    public static let widgetBundleIdentifier = "com.tokentracker.bar.widget"

    /// Filename of the snapshot inside the App Group container.
    public static let snapshotFilename = "widget-snapshot.json"

    /// Schema version — bump when the wire format changes incompatibly.
    public static let snapshotSchemaVersion = 2
}

// MARK: - Snapshot

public struct WidgetSnapshot: Codable, Equatable {
    public var schemaVersion: Int
    public var generatedAt: Date
    public var serverOnline: Bool

    public var today: PeriodTotals
    public var last7d: PeriodTotals
    public var last30d: PeriodTotals
    /// All-time total across every day the user has tracked. Populated from
    /// the dashboard's "Total" range so widgets can show the lifetime number
    /// alongside the all-time active-days count on the heatmap.
    public var total: PeriodTotals
    /// Whatever period the dashboard is currently showing (week / month / total)
    public var selected: PeriodTotals

    /// 30 most recent days, oldest first. Used by the trend chart widget and
    /// the small sparkline on the summary widget.
    public var dailyTrend: [DailyPoint]

    /// Top 5 models across the selected period (matches main app behaviour).
    public var topModels: [SnapshotModelEntry]

    /// Per-source roll-up (claude / codex / cursor / ...).
    public var sources: [SnapshotSourceEntry]

    /// Compressed activity heatmap. Outer array = weeks (oldest first). Inner
    /// array length is always 7 (Sun..Sat).
    public var heatmap: HeatmapPayload

    /// Per-provider rate-limit windows.
    public var limits: [LimitProvider]

    public init(
        schemaVersion: Int = WidgetSharedConstants.snapshotSchemaVersion,
        generatedAt: Date = Date(),
        serverOnline: Bool = false,
        today: PeriodTotals = .empty,
        last7d: PeriodTotals = .empty,
        last30d: PeriodTotals = .empty,
        total: PeriodTotals = .empty,
        selected: PeriodTotals = .empty,
        dailyTrend: [DailyPoint] = [],
        topModels: [SnapshotModelEntry] = [],
        sources: [SnapshotSourceEntry] = [],
        heatmap: HeatmapPayload = .empty,
        limits: [LimitProvider] = []
    ) {
        self.schemaVersion = schemaVersion
        self.generatedAt = generatedAt
        self.serverOnline = serverOnline
        self.today = today
        self.last7d = last7d
        self.last30d = last30d
        self.total = total
        self.selected = selected
        self.dailyTrend = dailyTrend
        self.topModels = topModels
        self.sources = sources
        self.heatmap = heatmap
        self.limits = limits
    }

    public static let empty = WidgetSnapshot()

    // MARK: - Derived

    /// Tokens used on the calendar day before this snapshot was generated.
    /// `dailyTrend` contains only active days, so array position cannot identify yesterday.
    public var yesterdayTokens: Int {
        let calendar = Calendar.current
        guard let yesterday = calendar.date(byAdding: .day, value: -1, to: generatedAt) else {
            return 0
        }
        return dailyTrend.first { calendar.isDate($0.day, inSameDayAs: yesterday) }?.totalTokens ?? 0
    }

    /// Delta (percent) between today and yesterday. Returns nil when there
    /// is no usable baseline (yesterday was zero or no history).
    public var todayDeltaPercent: Double? {
        let y = yesterdayTokens
        guard y > 0 else { return nil }
        return Double(today.tokens - y) / Double(y) * 100.0
    }

    /// Placeholder data used by widget previews and the gallery.
    public static let placeholder: WidgetSnapshot = {
        let trend: [DailyPoint] = (0..<30).map { i in
            let day = Calendar.current.date(byAdding: .day, value: -29 + i, to: Date()) ?? Date()
            let base = 200_000 + Int.random(in: 0...600_000)
            return DailyPoint(day: day, totalTokens: base, costUsd: Double(base) / 1_500_000.0)
        }
        let weeks: [[Int]] = (0..<26).map { _ in (0..<7).map { _ in Int.random(in: 0...4) } }
        return WidgetSnapshot(
            generatedAt: Date(),
            serverOnline: true,
            today: PeriodTotals(tokens: 1_240_000, costUsd: 0.83, conversations: 12),
            last7d: PeriodTotals(tokens: 8_320_000, costUsd: 5.41, conversations: 64, activeDays: 6),
            last30d: PeriodTotals(tokens: 31_700_000, costUsd: 21.22, conversations: 248, activeDays: 22),
            total: PeriodTotals(tokens: 4_900_000_000, costUsd: 3_210.55, conversations: 1_820, activeDays: 202),
            selected: PeriodTotals(tokens: 22_900_000, costUsd: 15.10, conversations: 180),
            dailyTrend: trend,
            topModels: [
                SnapshotModelEntry(id: "claude-opus-4-6", name: "claude-opus-4-6", source: "claude", tokens: 12_400_000, sharePercent: 38.2),
                SnapshotModelEntry(id: "gpt-5.4", name: "gpt-5.4", source: "codex", tokens: 9_100_000, sharePercent: 28.0),
                SnapshotModelEntry(id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", source: "claude", tokens: 5_800_000, sharePercent: 17.9),
                SnapshotModelEntry(id: "gemini-2.5-pro", name: "gemini-2.5-pro", source: "gemini", tokens: 3_200_000, sharePercent: 9.9),
                SnapshotModelEntry(id: "cursor-fast", name: "cursor-fast", source: "cursor", tokens: 1_900_000, sharePercent: 5.9)
            ],
            sources: [
                SnapshotSourceEntry(source: "claude", tokens: 18_200_000, costUsd: 12.40, sharePercent: 56.0),
                SnapshotSourceEntry(source: "codex", tokens: 9_100_000, costUsd: 6.20, sharePercent: 28.0),
                SnapshotSourceEntry(source: "gemini", tokens: 3_200_000, costUsd: 1.10, sharePercent: 9.9),
                SnapshotSourceEntry(source: "cursor", tokens: 1_900_000, costUsd: 1.52, sharePercent: 5.9)
            ],
            heatmap: HeatmapPayload(weeks: weeks, activeDays: 110, streakDays: 14),
            limits: [
                LimitProvider(source: "claude", label: "Claude · 5h",  fraction: 0.42, resetsAt: nil),
                LimitProvider(source: "claude", label: "Claude · 7d",  fraction: 0.71, resetsAt: nil),
                LimitProvider(source: "codex",  label: "Codex · 5h",   fraction: 0.18, resetsAt: nil),
                LimitProvider(source: "cursor", label: "Cursor",       fraction: 0.55, resetsAt: nil),
                LimitProvider(source: "gemini", label: "Gemini",       fraction: 0.32, resetsAt: nil)
            ]
        )
    }()
}

// MARK: - Sub-models

public struct PeriodTotals: Codable, Equatable {
    public var tokens: Int
    public var costUsd: Double?
    public var conversations: Int
    public var activeDays: Int

    public init(tokens: Int = 0, costUsd: Double? = 0, conversations: Int = 0, activeDays: Int = 0) {
        self.tokens = tokens
        self.costUsd = costUsd
        self.conversations = conversations
        self.activeDays = activeDays
    }

    public static let empty = PeriodTotals()
}

public struct DailyPoint: Codable, Equatable {
    public var day: Date
    public var totalTokens: Int
    public var costUsd: Double?

    public init(day: Date, totalTokens: Int, costUsd: Double?) {
        self.day = day
        self.totalTokens = totalTokens
        self.costUsd = costUsd
    }
}

public struct SnapshotModelEntry: Codable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var source: String
    public var tokens: Int
    public var sharePercent: Double

    public init(id: String, name: String, source: String, tokens: Int, sharePercent: Double) {
        self.id = id
        self.name = name
        self.source = source
        self.tokens = tokens
        self.sharePercent = sharePercent
    }
}

public struct SnapshotSourceEntry: Codable, Equatable, Identifiable {
    public var id: String { source }
    public var source: String
    public var tokens: Int
    public var costUsd: Double?
    public var sharePercent: Double

    public init(source: String, tokens: Int, costUsd: Double?, sharePercent: Double) {
        self.source = source
        self.tokens = tokens
        self.costUsd = costUsd
        self.sharePercent = sharePercent
    }
}

public struct HeatmapPayload: Codable, Equatable {
    /// Levels 0–4. Outer = weeks (oldest first), inner length is always 7.
    public var weeks: [[Int]]
    public var activeDays: Int
    public var streakDays: Int

    public init(weeks: [[Int]] = [], activeDays: Int = 0, streakDays: Int = 0) {
        self.weeks = weeks
        self.activeDays = activeDays
        self.streakDays = streakDays
    }

    public static let empty = HeatmapPayload()
}

public struct LimitProvider: Codable, Equatable, Identifiable {
    public var id: String { label }
    public var source: String
    public var label: String
    /// 0.0 – 1.0+ (clamped at render time).
    public var fraction: Double
    public var resetsAt: Date?

    public init(source: String, label: String, fraction: Double, resetsAt: Date?) {
        self.source = source
        self.label = label
        self.fraction = fraction
        self.resetsAt = resetsAt
    }
}

// MARK: - Container IO

public enum WidgetSnapshotStore {

    /// URL of the shared snapshot file inside the App Group container.
    /// Returns `nil` if the App Group is not provisioned (e.g. unsigned dev
    /// build) — callers should fall back to the per-user Application Support
    /// directory in that case.
    public static func sharedSnapshotURL() -> URL? {
        let fm = FileManager.default
        guard let dir = fm.containerURL(
            forSecurityApplicationGroupIdentifier: WidgetSharedConstants.appGroupIdentifier
        ) else {
            return nil
        }
        return dir.appendingPathComponent(WidgetSharedConstants.snapshotFilename)
    }

    /// Per-target Application Support fallback used when the App Group
    /// container is unavailable. The host (unsandboxed) resolves this to
    /// `~/Library/Application Support/TokenTrackerBar/`; a sandboxed widget
    /// extension resolves it inside its own container.
    public static func fallbackSnapshotURL() -> URL? {
        let fm = FileManager.default
        guard let support = try? fm.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) else { return nil }
        let dir = support.appendingPathComponent("TokenTrackerBar", isDirectory: true)
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir.appendingPathComponent(WidgetSharedConstants.snapshotFilename)
    }

    /// Absolute path of the snapshot inside the widget extension's sandbox
    /// container. The host writes here as a third fallback so ad-hoc /
    /// Developer-ID-less dev builds can still feed the widget without
    /// relying on a provisioned App Group. The sandboxed widget extension
    /// reads this same path via `fallbackSnapshotURL()` (resolves to its
    /// own container).
    ///
    /// Returns `nil` when called from inside a sandbox — only the
    /// unsandboxed host should ever write here.
    public static func widgetContainerSnapshotURL() -> URL? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        // Detect sandbox: a sandboxed process's home is inside ~/Library/Containers
        if home.path.contains("/Library/Containers/") { return nil }
        let dir = home
            .appendingPathComponent("Library/Containers", isDirectory: true)
            .appendingPathComponent(WidgetSharedConstants.widgetBundleIdentifier, isDirectory: true)
            .appendingPathComponent("Data/Library/Application Support/TokenTrackerBar", isDirectory: true)
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir.appendingPathComponent(WidgetSharedConstants.snapshotFilename)
    }

    private static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }

    private static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }

    /// Atomically writes the snapshot. Tries the App Group container first,
    /// falls back to Application Support. Returns `true` on success.
    @discardableResult
    public static func write(_ snapshot: WidgetSnapshot) -> Bool {
        do {
            let data = try encoder().encode(snapshot)
            let urls = [
                sharedSnapshotURL(),
                fallbackSnapshotURL(),
                widgetContainerSnapshotURL()
            ].compactMap { $0 }
            guard !urls.isEmpty else { return false }
            var anySuccess = false
            for url in urls {
                do {
                    try data.write(to: url, options: [.atomic])
                    anySuccess = true
                } catch {
                    // Try the next location
                }
            }
            return anySuccess
        } catch {
            return false
        }
    }

    /// Reads the most recent snapshot. Tries shared container first, then
    /// the per-user fallback. Returns `nil` if neither file exists or
    /// decoding fails (e.g. schema mismatch from an old install).
    public static func read() -> WidgetSnapshot? {
        let candidates = [sharedSnapshotURL(), fallbackSnapshotURL()].compactMap { $0 }
        for url in candidates {
            guard let data = try? Data(contentsOf: url),
                  let snapshot = try? decoder().decode(WidgetSnapshot.self, from: data),
                  snapshot.schemaVersion == WidgetSharedConstants.snapshotSchemaVersion
            else { continue }
            return snapshot
        }
        return nil
    }
}
