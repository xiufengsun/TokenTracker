import Foundation

extension Notification.Name {
    /// Posted when a usage-limit window rolls over after the user had been
    /// meaningfully constrained — the moment worth celebrating with confetti.
    /// `object` is the first `LimitResetEvent`.
    static let weeklyLimitReset = Notification.Name("WeeklyLimitReset")
}

/// One window that just reset after the user had climbed high in it.
struct LimitResetEvent: Equatable {
    let provider: String      // "claude", "codex", "cursor", …
    let windowKey: String     // e.g. "codex.primary"
    let windowLabel: String   // display name matching the popover row, e.g. "5h", "7d", "Gemini 5h"
    let previousPercent: Double
}

/// Brand artwork lookup shared by the reset event and its macOS celebration UI.
/// Asset-catalog providers and bundled-dashboard SVG providers are kept separate
/// because SwiftUI loads them through different APIs.
enum LimitResetProviderIconCatalog {
    static func assetName(for provider: String) -> String? {
        // These providers are monochrome in the existing asset catalog. Route
        // them through their SVG so the toast can request the dark-mode color.
        guard svgFilename(for: provider) == nil else { return nil }
        return LimitsSettingsStore.iconNames[provider]
    }

    static func svgFilename(for provider: String) -> String? {
        switch provider {
        case "cursor": return "cursor.svg"
        case "kimi": return "kimi.svg"
        case "kiro": return "kiro.svg"
        case "grok": return "grok.svg"
        case "copilot": return "copilot.svg"
        case "zcode": return "zcode.svg"
        case "opencodeGo": return "opencode.svg"
        case "commandCode": return "commandcode.svg"
        case "qoder": return "qoder.svg"
        case "codingPlan": return "volcano-ark.svg"
        case "agentPlan": return "volcano-ark.svg"
        case "devin": return "devin.svg"
        default: return nil
        }
    }
}

/// Detects when a usage-limit window "resets" (rolls over) *after* the user had
/// been meaningfully constrained. Mirrors the idea behind CodexBar's
/// weekly-limit-reset detector but generalized to any provider window.
///
/// The logic is pure and the memory lives in a persisted `Snapshot`, so it
/// survives relaunches and never double-fires (a cooldown suppresses repeats).
struct WeeklyLimitResetDetector {

    /// A real rollover must drop usage by at least this much — a small floor that
    /// confirms the window actually emptied, and guards providers (e.g. Kiro) whose
    /// `reset_at` slides forward continuously instead of jumping only on rollover.
    /// Not a "used enough to celebrate" gate: any genuine reset fires.
    var minDrop: Double = 5
    /// The window's `reset_at` must advance by at least this much to count as a real
    /// rollover — filters sub-second jitter in provider timestamps. A true rollover
    /// jumps hours-to-days ahead, so this never suppresses a genuine reset.
    var resetAdvanceTolerance: TimeInterval = 60
    /// After firing for a key, suppress re-fires for this long.
    var cooldown: TimeInterval = 3600

    struct Snapshot: Codable, Equatable {
        var lastPercent: [String: Double] = [:]
        var lastEventAt: [String: Double] = [:]   // unix seconds
        var lastResetAt: [String: Double] = [:]   // unix seconds — last seen window reset_at

        init() {}

        /// Tolerate older persisted snapshots that predate `lastResetAt` (or any
        /// missing field) so an upgrade keeps the existing baseline + cooldown
        /// memory instead of discarding it.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            lastPercent = try c.decodeIfPresent([String: Double].self, forKey: .lastPercent) ?? [:]
            lastEventAt = try c.decodeIfPresent([String: Double].self, forKey: .lastEventAt) ?? [:]
            lastResetAt = try c.decodeIfPresent([String: Double].self, forKey: .lastResetAt) ?? [:]
        }
    }

    /// Given the persisted snapshot and the current readings, return the events to
    /// celebrate plus the snapshot to persist for next time. The snapshot *is* the
    /// memory of the previous reading, so callers need not track the prior response.
    func evaluate(
        readings: [(provider: String, windowKey: String, windowLabel: String, usedPercent: Double, resetAt: Double?)],
        snapshot: Snapshot,
        now: Double
    ) -> (events: [LimitResetEvent], snapshot: Snapshot) {
        var updated = snapshot
        var events: [LimitResetEvent] = []

        for reading in readings {
            let key = reading.windowKey
            // A reading without a reset timestamp (e.g. Claude's 5h window sitting idle
            // after rollover reports 0% / null) carries no window identity, so it must
            // not touch the baseline: overwriting the percent with 0 here would make the
            // next real reading fail the minDrop check and silently lose the celebration.
            guard let curReset = reading.resetAt else { continue }
            let prevPercent = snapshot.lastPercent[key]
            let prevReset = snapshot.lastResetAt[key]
            updated.lastPercent[key] = reading.usedPercent
            updated.lastResetAt[key] = curReset

            // Need a full prior baseline (percent + reset time). First observation only
            // records a baseline — never celebrates.
            guard let prevPercent, let prevReset else { continue }
            // The window must have actually rolled over: its reset_at advanced to a
            // new period, not merely a percentage that dipped.
            guard curReset > prevReset + resetAdvanceTolerance else { continue }
            // … and the rollover actually emptied the window (also guards Kiro's
            // continuously-sliding reset_at from firing without a real drop).
            guard prevPercent - reading.usedPercent >= minDrop else { continue }
            if let last = snapshot.lastEventAt[key], now - last < cooldown { continue }

            updated.lastEventAt[key] = now
            events.append(LimitResetEvent(
                provider: reading.provider,
                windowKey: key,
                windowLabel: reading.windowLabel,
                previousPercent: prevPercent
            ))
        }

        return (events, updated)
    }
}

// MARK: - Persistence + settings keys

extension WeeklyLimitResetDetector {
    static let snapshotKey = "WeeklyLimitResetSnapshot"
    static let toastEnabledKey = "LimitsToastOnResetEnabled"
    static let confettiEnabledKey = "LimitsConfettiOnResetEnabled"
    /// Reset information and its celebratory effect are separate opt-outs.
    static let toastEnabledDefault = true
    static let confettiEnabledDefault = true

    /// Whether the informative reset toast is enabled, honoring the shared default.
    static func toastEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: toastEnabledKey) as? Bool ?? toastEnabledDefault
    }

    /// Whether the celebration confetti is enabled, honoring the shared default.
    static func confettiEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: confettiEnabledKey) as? Bool ?? confettiEnabledDefault
    }

    static func loadSnapshot(_ defaults: UserDefaults = .standard) -> Snapshot {
        guard let data = defaults.data(forKey: snapshotKey),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            return Snapshot()
        }
        return snapshot
    }

    static func saveSnapshot(_ snapshot: Snapshot, _ defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: snapshotKey)
    }
}

// MARK: - Reading extraction

/// Parse an ISO-8601 reset timestamp into unix seconds, tolerating the
/// fractional-seconds variant. Mirrors the display-side parser in `UsageLimitsView`.
private func parseResetSeconds(iso: String?) -> Double? {
    guard let iso else { return nil }
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fmt.date(from: iso) { return date.timeIntervalSince1970 }
    fmt.formatOptions = [.withInternetDateTime]
    return fmt.date(from: iso)?.timeIntervalSince1970
}

extension UsageLimitsResponse {
    /// Soonest active rate-limit cool-down expiry (unix seconds) across providers that
    /// expose one, or nil if none is pending. The app wakes at this instant to refresh
    /// the moment the cool-down lifts, instead of waiting out the regular poll interval.
    func soonestCooldownExpiry() -> Double? {
        [parseResetSeconds(iso: claude.retryAt)].compactMap { $0 }.min()
    }
}

extension UsageLimitsResponse {
    /// Flatten every provider's windows into `(provider, windowKey, windowLabel, usedPercent, resetAt)`
    /// tuples (percent on a 0–100 scale, resetAt in unix seconds), skipping providers
    /// that errored or are unconfigured.
    ///
    /// `windowKey` is the persistence identity (snapshot baselines + cooldowns) and must
    /// never change; `windowLabel` is the human name shown in the celebration toast and
    /// mirrors the popover row labels in `UsageLimitsView` (spelled out where the popover
    /// abbreviates for space, e.g. "Gemini 5h" instead of "Gm 5h").
    func limitWindowReadings() -> [(provider: String, windowKey: String, windowLabel: String, usedPercent: Double, resetAt: Double?)] {
        var out: [(provider: String, windowKey: String, windowLabel: String, usedPercent: Double, resetAt: Double?)] = []

        func addGeneric(_ provider: String, _ configured: Bool, _ error: String?, _ windows: [(String, String, GenericLimitWindow?)]) {
            guard configured, error == nil else { return }
            for (name, label, window) in windows {
                guard let window else { continue }
                out.append((provider, "\(provider).\(name)", label, window.usedPercent, parseResetSeconds(iso: window.resetAt)))
            }
        }

        if claude.configured, claude.error == nil {
            for (name, label, window) in [("5h", "5h", claude.fiveHour), ("7d", "7d", claude.sevenDay), ("opus", "Opus", claude.sevenDayOpus)] {
                guard let window else { continue }
                out.append(("claude", "claude.\(name)", label, window.utilization, parseResetSeconds(iso: window.resetsAt)))
            }
            for window in claude.weeklyScoped ?? [] {
                out.append(("claude", "claude.scoped.\(window.label.lowercased())", window.label, window.utilization, parseResetSeconds(iso: window.resetsAt)))
            }
        }

        if codex.configured, codex.error == nil {
            let windows: [(String, String, CodexWindow?)] = [
                ("primary", "5h", codex.primaryWindow), ("secondary", "7d", codex.secondaryWindow),
                ("sparkPrimary", "Spark 5h", codex.sparkPrimaryWindow), ("sparkSecondary", "Spark 7d", codex.sparkSecondaryWindow),
            ]
            for (name, label, window) in windows {
                guard let window else { continue }
                out.append(("codex", "codex.\(name)", label, Double(window.usedPercent), window.resetAt.map(Double.init)))
            }
        }

        addGeneric("cursor", cursor.configured, cursor.error, [("primary", Strings.cursorPlanLabel, cursor.primaryWindow), ("secondary", Strings.cursorAutoLabel, cursor.secondaryWindow), ("tertiary", "API", cursor.tertiaryWindow), ("quaternary", Strings.cursorGrokBotLabel, cursor.quaternaryWindow)])
        addGeneric("gemini", gemini.configured, gemini.error, [("primary", "Pro", gemini.primaryWindow), ("secondary", "Flash", gemini.secondaryWindow), ("tertiary", "Lite", gemini.tertiaryWindow)])
        addGeneric("kiro", kiro.configured, kiro.error, [("primary", Strings.kiroMonthLabel, kiro.primaryWindow), ("secondary", Strings.kiroBonusLabel, kiro.secondaryWindow)])
        addGeneric("antigravity", antigravity.configured, antigravity.error, [("primary", "Claude 7d", antigravity.primaryWindow), ("secondary", "Claude 5h", antigravity.secondaryWindow), ("tertiary", "Gemini 7d", antigravity.tertiaryWindow), ("quaternary", "Gemini 5h", antigravity.quaternaryWindow)])
        if let kimi { addGeneric("kimi", kimi.configured, kimi.error, [("primary", Strings.kimiWeeklyLabel, kimi.primaryWindow), ("secondary", Strings.kimiFiveHourLabel, kimi.secondaryWindow), ("tertiary", Strings.kimiTotalLabel, kimi.tertiaryWindow)]) }
        if let grok { addGeneric("grok", grok.configured, grok.error, [("primary", Strings.grokPrimaryLabel(periodType: grok.periodType), grok.primaryWindow), ("secondary", Strings.grokOndemandLabel, grok.secondaryWindow)]) }
        if let copilot { addGeneric("copilot", copilot.configured, copilot.error, [("primary", "Premium", copilot.primaryWindow), ("secondary", "Chat", copilot.secondaryWindow)]) }
        if let zcode, zcode.planKind != "coding-plan", let buckets = zcode.labeledBuckets {
            // Start plans: one reading per server-labelled bucket, keyed by entitlement so
            // promotional grants and daily allowances stay distinct across polls.
            addGeneric("zcode", zcode.configured, zcode.error, buckets.map { ("bucket.\($0.key)", $0.label, $0.window) })
        } else if let zcode {
            let labels = zcode.planKind == "coding-plan"
                ? [("primary", "5h", zcode.primaryWindow), ("secondary", "Weekly", zcode.secondaryWindow), ("tertiary", "Tools", zcode.tertiaryWindow)]
                : [("primary", "GLM-5.2", zcode.primaryWindow), ("secondary", "GLM-5-Turbo", zcode.secondaryWindow), ("tertiary", "Tools", zcode.tertiaryWindow)]
            addGeneric("zcode", zcode.configured, zcode.error, labels)
        }
        if let opencodeGo {
            addGeneric("opencodeGo", opencodeGo.configured, opencodeGo.error, [
                ("primary", "5h", opencodeGo.primaryWindow),
                ("secondary", "Weekly", opencodeGo.secondaryWindow),
                ("tertiary", "Monthly", opencodeGo.tertiaryWindow),
            ])
        }
        if let commandCode {
            addGeneric("commandCode", commandCode.configured, commandCode.error, [
                ("primary", "5h", commandCode.primaryWindow),
                ("secondary", "Weekly", commandCode.secondaryWindow),
            ])
        }
        if let qoder {
            addGeneric("qoder", qoder.configured, qoder.error, [
                ("primary", Strings.qoderPlanLabel, qoder.primaryWindow),
                ("secondary", Strings.qoderBonusLabel, qoder.secondaryWindow),
            ])
        }
        if let qoderCn {
            addGeneric("qoderCn", qoderCn.configured, qoderCn.error, [
                ("primary", Strings.qoderPlanLabel, qoderCn.primaryWindow),
                ("secondary", Strings.qoderBonusLabel, qoderCn.secondaryWindow),
            ])
        }
        if let codingPlan {
            addGeneric("codingPlan", codingPlan.configured, codingPlan.error, [
                ("primary", "5h", codingPlan.primaryWindow),
                ("secondary", "Weekly", codingPlan.secondaryWindow),
                ("tertiary", "Monthly", codingPlan.tertiaryWindow),
            ])
        }
        if let agentPlan {
            addGeneric("agentPlan", agentPlan.configured, agentPlan.error, [
                ("primary", "5h", agentPlan.primaryWindow),
                ("secondary", "Weekly", agentPlan.secondaryWindow),
                ("tertiary", "Monthly", agentPlan.tertiaryWindow),
            ])
        }
        if let devin {
            addGeneric("devin", devin.configured, devin.error, [
                ("primary", "Daily", devin.primaryWindow),
                ("secondary", "Weekly", devin.secondaryWindow),
            ])
        }

        return out
    }
}
