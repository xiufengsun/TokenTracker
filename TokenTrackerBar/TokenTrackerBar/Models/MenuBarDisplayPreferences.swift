import Foundation

enum MenuBarDisplayMetric: String, CaseIterable {
    case todayTokens
    case todayCost
    case last7dTokens
    case totalTokens
    case totalCost
    case claude5h
    case claude7d
    case codex5h
    case codex7d
    case codexCredits
    case codexSpark5h
    case codexSpark7d
    case cursorPlan
    case cursorAuto
    case cursorAPI
    case geminiPro
    case geminiFlash
    case geminiLite
    case kimiWeekly
    case kimi5h
    case kimiTotal
    case kiroMonth
    case kiroBonus
    case grokMonth
    case grokOndemand
    case copilotPremium
    case copilotChat
    case antigravityClaudeWeekly
    case antigravityClaude5h
    case antigravityGeminiWeekly
    case antigravityGemini5h
    case zcodeGlm52
    case zcodeGlm5Turbo
    case opencodeGo5h
    case opencodeGoWeekly
    case opencodeGoMonthly
    case commandCode5h
    case commandCodeWeekly
    case qoderQuota
    case qoderUltimate
    case devinDaily
    case devinWeekly

    var menuLabel: String {
        switch self {
        case .todayTokens: return "Tokens"
        case .todayCost: return "Cost"
        case .last7dTokens: return "7d"
        case .totalTokens: return "Total"
        case .totalCost: return "All $"
        case .claude5h: return "Cl 5h"
        case .claude7d: return "Cl 7d"
        case .codex5h: return "Cx 5h"
        case .codex7d: return "Cx 7d"
        case .codexCredits: return "Cx Cred"
        case .codexSpark5h: return "Cx Spark 5h"
        case .codexSpark7d: return "Cx Spark 7d"
        case .cursorPlan: return "Cu Plan"
        case .cursorAuto: return "Cu Auto"
        case .cursorAPI: return "Cu API"
        case .geminiPro: return "Gm Pro"
        case .geminiFlash: return "Gm Flash"
        case .geminiLite: return "Gm Lite"
        case .kimiWeekly: return "Km Wk"
        case .kimi5h: return "Km 5h"
        case .kimiTotal: return "Km Tot"
        case .kiroMonth: return "Kr Mo"
        case .kiroBonus: return "Kr Bn"
        // Preference id stays `grokMonth` for storage stability; label is period-agnostic
        // because SuperGrok accounts use a weekly pool while legacy is monthly.
        case .grokMonth: return "Gk"
        case .grokOndemand: return "Gk OD"
        case .copilotPremium: return "Co Prem"
        case .copilotChat: return "Co Chat"
        case .antigravityClaudeWeekly: return "Ag Cl 7d"
        case .antigravityClaude5h: return "Ag Cl 5h"
        case .antigravityGeminiWeekly: return "Ag Gm 7d"
        case .antigravityGemini5h: return "Ag Gm 5h"
        case .zcodeGlm52: return "ZC Pri"
        case .zcodeGlm5Turbo: return "ZC Sec"
        case .opencodeGo5h: return "OG 5h"
        case .opencodeGoWeekly: return "OG Wk"
        case .opencodeGoMonthly: return "OG Mo"
        case .commandCode5h: return "CC 5h"
        case .commandCodeWeekly: return "CC Wk"
        case .qoderQuota: return "Qd Cred"
        case .qoderUltimate: return "Qd Ult"
        case .devinDaily: return "Dv Day"
        case .devinWeekly: return "Dv Wk"
        }
    }

    var settingsTitle: String {
        switch self {
        case .todayTokens: return "Today Tokens"
        case .todayCost: return "Today Cost"
        case .last7dTokens: return "Last 7 Days"
        case .totalTokens: return "Total Tokens"
        case .totalCost: return "Total Cost"
        case .claude5h: return "Claude 5h Limit"
        case .claude7d: return "Claude 7d Limit"
        case .codex5h: return "Codex 5h Limit"
        case .codex7d: return "Codex 7d Limit"
        case .codexCredits: return "Codex Credit Limit"
        case .codexSpark5h: return "Codex Spark 5h Limit"
        case .codexSpark7d: return "Codex Spark 7d Limit"
        case .cursorPlan: return "Cursor Plan Limit"
        case .cursorAuto: return "Cursor Auto Limit"
        case .cursorAPI: return "Cursor API Limit"
        case .geminiPro: return "Gemini Pro Limit"
        case .geminiFlash: return "Gemini Flash Limit"
        case .geminiLite: return "Gemini Lite Limit"
        case .kimiWeekly: return "Kimi Weekly Limit"
        case .kimi5h: return "Kimi 5h Limit"
        case .kimiTotal: return "Kimi Total Limit"
        case .kiroMonth: return "Kiro Monthly Limit"
        case .kiroBonus: return "Kiro Bonus Limit"
        case .grokMonth: return "Grok Build Limit"
        case .grokOndemand: return "Grok Build On-demand Limit"
        case .copilotPremium: return "Copilot Premium Limit"
        case .copilotChat: return "Copilot Chat Limit"
        case .antigravityClaudeWeekly: return "Antigravity Claude 7d Limit"
        case .antigravityClaude5h: return "Antigravity Claude 5h Limit"
        case .antigravityGeminiWeekly: return "Antigravity Gemini 7d Limit"
        case .antigravityGemini5h: return "Antigravity Gemini 5h Limit"
        case .zcodeGlm52: return "ZCode Primary Limit"
        case .zcodeGlm5Turbo: return "ZCode Secondary Limit"
        case .opencodeGo5h: return "OpenCode Go 5h Limit"
        case .opencodeGoWeekly: return "OpenCode Go Weekly Limit"
        case .opencodeGoMonthly: return "OpenCode Go Monthly Limit"
        case .commandCode5h: return "Command Code 5h Limit"
        case .commandCodeWeekly: return "Command Code Weekly Limit"
        case .qoderQuota: return "Qoder Credits Limit"
        case .qoderUltimate: return "Qoder Ultimate Free Calls"
        case .devinDaily: return "Devin Daily Limit"
        case .devinWeekly: return "Devin Weekly Limit"
        }
    }

    var settingsCategory: String {
        switch self {
        case .todayTokens, .last7dTokens, .totalTokens:
            return "tokens"
        case .todayCost, .totalCost:
            return "cost"
        case .claude5h, .claude7d, .codex5h, .codex7d, .codexCredits, .codexSpark5h, .codexSpark7d,
             .cursorPlan, .cursorAuto, .cursorAPI,
             .geminiPro, .geminiFlash, .geminiLite,
             .kimiWeekly, .kimi5h, .kimiTotal,
             .kiroMonth, .kiroBonus,
             .grokMonth, .grokOndemand,
             .copilotPremium, .copilotChat,
             .antigravityClaudeWeekly, .antigravityClaude5h, .antigravityGeminiWeekly, .antigravityGemini5h,
             .zcodeGlm52, .zcodeGlm5Turbo,
             .opencodeGo5h, .opencodeGoWeekly, .opencodeGoMonthly,
             .commandCode5h, .commandCodeWeekly,
             .qoderQuota, .qoderUltimate,
             .devinDaily, .devinWeekly:
            return "limits"
        }
    }

    /// Provider this metric is sourced from. `nil` for token/cost metrics that
    /// are always selectable. Used to filter the dropdown so users only see
    /// limit slots for providers they've configured.
    var providerKey: String? {
        switch self {
        case .todayTokens, .todayCost, .last7dTokens, .totalTokens, .totalCost:
            return nil
        case .claude5h, .claude7d: return "claude"
        case .codex5h, .codex7d, .codexCredits, .codexSpark5h, .codexSpark7d: return "codex"
        case .cursorPlan, .cursorAuto, .cursorAPI: return "cursor"
        case .geminiPro, .geminiFlash, .geminiLite: return "gemini"
        case .kimiWeekly, .kimi5h, .kimiTotal: return "kimi"
        case .kiroMonth, .kiroBonus: return "kiro"
        case .grokMonth, .grokOndemand: return "grok"
        case .copilotPremium, .copilotChat: return "copilot"
        case .antigravityClaudeWeekly, .antigravityClaude5h, .antigravityGeminiWeekly, .antigravityGemini5h: return "antigravity"
        case .zcodeGlm52, .zcodeGlm5Turbo: return "zcode"
        case .opencodeGo5h, .opencodeGoWeekly, .opencodeGoMonthly: return "opencodeGo"
        case .commandCode5h, .commandCodeWeekly: return "commandCode"
        case .qoderQuota, .qoderUltimate: return "qoder"
        case .devinDaily, .devinWeekly: return "devin"
        }
    }
}

struct MenuBarSummarySelection: OptionSet, Equatable {
    let rawValue: Int

    static let today = MenuBarSummarySelection(rawValue: 1 << 0)
    static let rolling = MenuBarSummarySelection(rawValue: 1 << 1)
    static let total = MenuBarSummarySelection(rawValue: 1 << 2)
    static let all: MenuBarSummarySelection = [.today, .rolling, .total]
}

private extension UsageLimitsResponse {
    /// Whether a provider is currently usable (configured with no error).
    /// Optional providers (kimi, copilot) treated as unavailable when nil.
    func isProviderAvailable(_ key: String) -> Bool {
        switch key {
        case "claude": return claude.configured && claude.error == nil
        case "codex": return codex.configured && codex.error == nil
        case "cursor": return cursor.configured && cursor.error == nil
        case "gemini": return gemini.configured && gemini.error == nil
        case "kimi": return (kimi?.configured == true) && (kimi?.error == nil)
        case "kiro": return kiro.configured && kiro.error == nil
        case "grok": return (grok?.configured == true) && (grok?.error == nil)
        case "copilot": return (copilot?.configured == true) && (copilot?.error == nil)
        case "antigravity": return antigravity.configured && antigravity.error == nil
        case "zcode": return (zcode?.configured == true) && (zcode?.error == nil)
        case "opencodeGo": return (opencodeGo?.configured == true) && (opencodeGo?.error == nil)
        case "commandCode": return (commandCode?.configured == true) && (commandCode?.error == nil)
        case "qoder": return (qoder?.configured == true) && (qoder?.error == nil)
        case "devin": return (devin?.configured == true) && (devin?.error == nil)
        default: return false
        }
    }

    func hasWindow(for metric: MenuBarDisplayMetric) -> Bool {
        switch metric {
        case .todayTokens, .todayCost, .last7dTokens, .totalTokens, .totalCost:
            return true
        case .claude5h: return claude.fiveHour != nil
        case .claude7d: return claude.sevenDay != nil
        case .codex5h: return codex.primaryWindow != nil
        case .codex7d: return codex.secondaryWindow != nil
        case .codexCredits: return codex.creditWindow != nil
        case .codexSpark5h: return codex.sparkPrimaryWindow != nil
        case .codexSpark7d: return codex.sparkSecondaryWindow != nil
        case .cursorPlan: return cursor.primaryWindow != nil
        case .cursorAuto: return cursor.secondaryWindow != nil
        case .cursorAPI: return cursor.tertiaryWindow != nil
        case .geminiPro: return gemini.primaryWindow != nil
        case .geminiFlash: return gemini.secondaryWindow != nil
        case .geminiLite: return gemini.tertiaryWindow != nil
        case .kimiWeekly: return kimi?.primaryWindow != nil
        case .kimi5h: return kimi?.secondaryWindow != nil
        case .kimiTotal: return kimi?.tertiaryWindow != nil
        case .kiroMonth: return kiro.primaryWindow != nil
        case .kiroBonus: return kiro.secondaryWindow != nil
        case .grokMonth: return grok?.primaryWindow != nil
        case .grokOndemand: return grok?.secondaryWindow != nil
        case .copilotPremium: return copilot?.primaryWindow != nil
        case .copilotChat: return copilot?.secondaryWindow != nil
        case .antigravityClaudeWeekly: return antigravity.primaryWindow != nil
        case .antigravityClaude5h: return antigravity.secondaryWindow != nil
        case .antigravityGeminiWeekly: return antigravity.tertiaryWindow != nil
        case .antigravityGemini5h: return antigravity.quaternaryWindow != nil
        case .zcodeGlm52: return zcode?.primaryWindow != nil
        case .zcodeGlm5Turbo: return zcode?.secondaryWindow != nil
        case .opencodeGo5h: return opencodeGo?.primaryWindow != nil
        case .opencodeGoWeekly: return opencodeGo?.secondaryWindow != nil
        case .opencodeGoMonthly: return opencodeGo?.tertiaryWindow != nil
        case .commandCode5h: return commandCode?.primaryWindow != nil
        case .commandCodeWeekly: return commandCode?.secondaryWindow != nil
        case .qoderQuota: return qoder?.primaryWindow != nil
        case .qoderUltimate: return qoder?.secondaryWindow != nil
        case .devinDaily: return devin?.primaryWindow != nil
        case .devinWeekly: return devin?.secondaryWindow != nil
        }
    }
}

enum MenuBarDisplayPreferences {
    static let key = "MenuBarDisplayItems"
    static let defaultIDs = [MenuBarDisplayMetric.todayTokens.rawValue, MenuBarDisplayMetric.todayCost.rawValue]
    static let maxVisibleItems = 2
    /// Sentinel slot id meaning "show nothing in this slot" (issue #379:
    /// laptops are tight on menu-bar space; users want a single metric).
    /// Deliberately not a `MenuBarDisplayMetric` case — every consumer that
    /// does `MenuBarDisplayMetric(rawValue:)` naturally skips it.
    static let noneID = "none"

    /// Selectable metric ids for the dashboard dropdown.
    /// Token/cost metrics are always included. Limit slots require a healthy
    /// provider and that slot's concrete window. A selected slot is kept during
    /// loading or provider outage, but not when a healthy provider reports the
    /// specific window absent. Providers hidden in Limits Display preferences
    /// are excluded even when selected — hiding is user-authored intent.
    static func availableItemIDs(
        for limits: UsageLimitsResponse? = nil,
        keepingSelected selected: [String] = [],
        hiddenProviders: Set<String> = []
    ) -> [String] {
        let selectedSet = Set(selected)
        return MenuBarDisplayMetric.allCases
            .filter { metric in
                guard let provider = metric.providerKey else { return true }
                if hiddenProviders.contains(provider) { return false }
                if selectedSet.contains(metric.rawValue) {
                    guard let limits else { return true }
                    if limits.isProviderAvailable(provider) {
                        return limits.hasWindow(for: metric)
                    }
                    return true
                }
                guard let limits else { return false }
                return limits.isProviderAvailable(provider) && limits.hasWindow(for: metric)
            }
            .map(\.rawValue)
    }

    /// Payload of selectable metrics for the dashboard dropdown. Starts with
    /// the "None" sentinel so either slot can be emptied.
    static func availableItemsPayload(
        for limits: UsageLimitsResponse? = nil,
        keepingSelected selected: [String] = [],
        hiddenProviders: Set<String> = []
    ) -> [[String: String]] {
        let noneEntry: [String: String] = [
            "id": noneID,
            "label": Strings.menuSlotNone,
            "shortLabel": "",
            "category": "none",
        ]
        return [noneEntry] + availableItemIDs(for: limits, keepingSelected: selected, hiddenProviders: hiddenProviders)
            .compactMap { MenuBarDisplayMetric(rawValue: $0) }
            .map {
                [
                    "id": $0.rawValue,
                    "label": $0.settingsTitle,
                    "shortLabel": $0.menuLabel,
                    "category": $0.settingsCategory,
                ]
            }
    }

    static func read(from defaults: UserDefaults = .standard) -> [String] {
        let raw = defaults.stringArray(forKey: key) ?? defaultIDs
        let normalized = normalize(raw)
        // Self-heal: if stored data drifted (legacy >2-item arrays from earlier
        // dev builds, duplicates, or unknown ids), persist the cleaned version
        // back so the next read doesn't have to keep trimming.
        if raw != normalized {
            defaults.set(normalized, forKey: key)
        }
        return normalized
    }

    static func write(_ ids: [String], to defaults: UserDefaults = .standard) {
        defaults.set(normalize(ids), forKey: key)
    }

    /// Queue writes only affect token and cost summaries. Limit-only menu bar
    /// configurations need no local usage request when the queue changes.
    static func summarySelection(for ids: [String]) -> MenuBarSummarySelection {
        ids.reduce(into: MenuBarSummarySelection()) { selection, id in
            guard let metric = MenuBarDisplayMetric(rawValue: id) else { return }
            switch metric {
            case .todayTokens, .todayCost:
                selection.insert(.today)
            case .last7dTokens:
                selection.insert(.rolling)
            case .totalTokens, .totalCost:
                selection.insert(.total)
            case .claude5h, .claude7d,
                 .codex5h, .codex7d, .codexCredits, .codexSpark5h, .codexSpark7d,
                 .cursorPlan, .cursorAuto, .cursorAPI,
                 .geminiPro, .geminiFlash, .geminiLite,
                 .kimiWeekly, .kimi5h, .kimiTotal,
                 .kiroMonth, .kiroBonus,
                 .grokMonth, .grokOndemand,
                 .copilotPremium, .copilotChat,
                 .antigravityClaudeWeekly, .antigravityClaude5h,
                 .antigravityGeminiWeekly, .antigravityGemini5h,
                 .zcodeGlm52, .zcodeGlm5Turbo,
                 .opencodeGo5h, .opencodeGoWeekly, .opencodeGoMonthly,
                 .commandCode5h, .commandCodeWeekly,
                 .qoderQuota, .qoderUltimate,
                 .devinDaily, .devinWeekly:
                break
            }
        }
    }

    static func normalize(_ ids: [String]) -> [String] {
        normalize(ids, allowedIDs: Set(MenuBarDisplayMetric.allCases.map(\.rawValue)))
    }

    static func normalize(_ ids: [String], allowedIDs: Set<String>) -> [String] {
        var seen = Set<String>()
        var normalized = ids.compactMap { raw -> String? in
            // "none" is always a legal slot value and may appear in BOTH
            // slots (a user hiding everything), so it is exempt from the
            // allowed-set filter and from de-duplication.
            if raw == noneID { return raw }
            guard allowedIDs.contains(raw), !seen.contains(raw) else { return nil }
            seen.insert(raw)
            return raw
        }
        // Pad up to `maxVisibleItems` with defaults that haven't been picked yet.
        // Guards against legacy UserDefaults written by earlier dev builds
        // (e.g. only `["todayTokens"]` would otherwise leave the second slot empty).
        for fallbackID in defaultIDs where normalized.count < maxVisibleItems {
            guard allowedIDs.contains(fallbackID), !seen.contains(fallbackID) else { continue }
            normalized.append(fallbackID)
            seen.insert(fallbackID)
        }
        return Array(normalized.prefix(maxVisibleItems))
    }
}

/// Keeps menu-bar visibility decisions consistent across the native menu,
/// settings bridge, and status-item renderer.
enum MenuBarSurfacePolicy {
    static func isIconVisible(hideRequested: Bool, islandEnabled: Bool) -> Bool {
        !(hideRequested && islandEnabled)
    }

    static func shouldOfferHidePrompt(
        promptShown: Bool,
        hideRequested: Bool,
        islandEnabled: Bool
    ) -> Bool {
        !promptShown
            && islandEnabled
            && isIconVisible(hideRequested: hideRequested, islandEnabled: islandEnabled)
    }
}
