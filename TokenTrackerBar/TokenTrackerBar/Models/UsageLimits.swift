import Foundation

struct UsageLimitsResponse: Codable, Equatable {
    let fetchedAt: String
    let claude: ClaudeLimits
    let codex: CodexLimits
    let cursor: CursorLimits
    let gemini: GeminiLimits
    let kimi: KimiLimits?
    let kiro: KiroLimits
    let grok: GrokLimits?
    let antigravity: AntigravityLimits
    let copilot: CopilotLimits?
    let zcode: ZcodeLimits?
    let opencodeGo: OpencodeGoLimits?
    let commandCode: CommandCodeLimits?
    let qoder: QoderLimits?
    let qoderCn: QoderLimits?
    let codingPlan: CodingPlanLimits?
    let agentPlan: AgentPlanLimits?
    let devin: DevinLimits?

    enum CodingKeys: String, CodingKey {
        case fetchedAt = "fetched_at"
        case claude, codex, cursor, gemini, kimi, kiro, grok, antigravity, copilot, zcode, qoder, qoderCn, codingPlan, agentPlan, devin
        case opencodeGo = "opencodeGo"
        case commandCode = "commandCode"
    }
}

extension UsageLimitsResponse {
    /// Raw utilization percent for a menu-bar metric, with the same
    /// configured / no-error guards the menu bar applies — so the Dynamic
    /// Island never shows a stale value for an unconfigured or erroring
    /// provider. Callers format the number (display mode, rounding) via
    /// `LimitsSettingsStore.formatPercentText`.
    func utilizationPercent(for metric: MenuBarDisplayMetric) -> Double? {
        func guarded(_ configured: Bool?, _ error: String?, _ value: Double?) -> Double? {
            guard configured == true, error == nil else { return nil }
            return value
        }
        switch metric {
        case .todayTokens, .todayCost, .last7dTokens, .totalTokens, .totalCost:
            return nil
        case .claude5h:
            return guarded(claude.configured, claude.error, claude.fiveHour?.utilization)
        case .claude7d:
            return guarded(claude.configured, claude.error, claude.sevenDay?.utilization)
        case .codex5h:
            return guarded(codex.configured, codex.error, codex.primaryWindow.map { Double($0.usedPercent) })
        case .codex7d:
            return guarded(codex.configured, codex.error, codex.secondaryWindow.map { Double($0.usedPercent) })
        case .codexCredits:
            return guarded(codex.configured, codex.error, codex.creditWindow?.usedPercent)
        case .codexSpark5h:
            return guarded(codex.configured, codex.error, codex.sparkPrimaryWindow.map { Double($0.usedPercent) })
        case .codexSpark7d:
            return guarded(codex.configured, codex.error, codex.sparkSecondaryWindow.map { Double($0.usedPercent) })
        case .cursorPlan:
            return guarded(cursor.configured, cursor.error, cursor.primaryWindow?.usedPercent)
        case .cursorAuto:
            return guarded(cursor.configured, cursor.error, cursor.secondaryWindow?.usedPercent)
        case .cursorAPI:
            return guarded(cursor.configured, cursor.error, cursor.tertiaryWindow?.usedPercent)
        case .geminiPro:
            return guarded(gemini.configured, gemini.error, gemini.primaryWindow?.usedPercent)
        case .geminiFlash:
            return guarded(gemini.configured, gemini.error, gemini.secondaryWindow?.usedPercent)
        case .geminiLite:
            return guarded(gemini.configured, gemini.error, gemini.tertiaryWindow?.usedPercent)
        case .kimiWeekly:
            return guarded(kimi?.configured, kimi?.error, kimi?.primaryWindow?.usedPercent)
        case .kimi5h:
            return guarded(kimi?.configured, kimi?.error, kimi?.secondaryWindow?.usedPercent)
        case .kimiTotal:
            return guarded(kimi?.configured, kimi?.error, kimi?.tertiaryWindow?.usedPercent)
        case .kiroMonth:
            return guarded(kiro.configured, kiro.error, kiro.primaryWindow?.usedPercent)
        case .kiroBonus:
            return guarded(kiro.configured, kiro.error, kiro.secondaryWindow?.usedPercent)
        case .grokMonth:
            return guarded(grok?.configured, grok?.error, grok?.primaryWindow?.usedPercent)
        case .grokOndemand:
            return guarded(grok?.configured, grok?.error, grok?.secondaryWindow?.usedPercent)
        case .copilotPremium:
            return guarded(copilot?.configured, copilot?.error, copilot?.primaryWindow?.usedPercent)
        case .copilotChat:
            return guarded(copilot?.configured, copilot?.error, copilot?.secondaryWindow?.usedPercent)
        case .antigravityClaudeWeekly:
            return guarded(antigravity.configured, antigravity.error, antigravity.primaryWindow?.usedPercent)
        case .antigravityClaude5h:
            return guarded(antigravity.configured, antigravity.error, antigravity.secondaryWindow?.usedPercent)
        case .antigravityGeminiWeekly:
            return guarded(antigravity.configured, antigravity.error, antigravity.tertiaryWindow?.usedPercent)
        case .antigravityGemini5h:
            return guarded(antigravity.configured, antigravity.error, antigravity.quaternaryWindow?.usedPercent)
        case .zcodeGlm52:
            return guarded(zcode?.configured, zcode?.error, zcode?.primaryWindow?.usedPercent)
        case .zcodeGlm5Turbo:
            return guarded(zcode?.configured, zcode?.error, zcode?.secondaryWindow?.usedPercent)
        case .opencodeGo5h:
            return guarded(opencodeGo?.configured, opencodeGo?.error, opencodeGo?.primaryWindow?.usedPercent)
        case .opencodeGoWeekly:
            return guarded(opencodeGo?.configured, opencodeGo?.error, opencodeGo?.secondaryWindow?.usedPercent)
        case .opencodeGoMonthly:
            return guarded(opencodeGo?.configured, opencodeGo?.error, opencodeGo?.tertiaryWindow?.usedPercent)
        case .commandCode5h:
            return guarded(commandCode?.configured, commandCode?.error, commandCode?.primaryWindow?.usedPercent)
        case .commandCodeWeekly:
            return guarded(commandCode?.configured, commandCode?.error, commandCode?.secondaryWindow?.usedPercent)
        case .qoderQuota:
            return guarded(qoder?.configured, qoder?.error, qoder?.primaryWindow?.usedPercent)
        case .qoderUltimate:
            return guarded(qoder?.configured, qoder?.error, qoder?.secondaryWindow?.usedPercent)
        case .devinDaily:
            return guarded(devin?.configured, devin?.error, devin?.primaryWindow?.usedPercent)
        case .devinWeekly:
            return guarded(devin?.configured, devin?.error, devin?.secondaryWindow?.usedPercent)
        }
    }
}

enum UsageLimitsCache {
    static let defaultsKey = "UsageLimitsLastGoodResponse"
    private static let maximumFutureSkew: TimeInterval = 5 * 60

    static func load(
        defaults: UserDefaults = .standard,
        now: Date = Date()
    ) -> UsageLimitsResponse? {
        guard let data = defaults.data(forKey: defaultsKey) else { return nil }
        guard let limits = try? JSONDecoder().decode(UsageLimitsResponse.self, from: data) else {
            return nil
        }
        if let fetchedAt = parseTimestamp(limits.fetchedAt),
           fetchedAt.timeIntervalSince(now) > maximumFutureSkew {
            return nil
        }
        return limits
    }

    static func save(
        _ limits: UsageLimitsResponse,
        defaults: UserDefaults = .standard,
        devinSelected: Bool? = nil
    ) {
        let adjusted = devinSelected.map { limits.applyingDevinSelection($0) } ?? limits
        // Opting out must remove persisted quota even when it was the only
        // usable provider. Ordinary all-error refreshes still keep their cache.
        if devinSelected == false && !adjusted.hasAnyProviderWithoutError {
            defaults.removeObject(forKey: defaultsKey)
            return
        }
        guard adjusted.hasAnyProviderWithoutError,
              let data = try? JSONEncoder().encode(adjusted) else { return }
        defaults.set(data, forKey: defaultsKey)
    }

    private static func parseTimestamp(_ rawValue: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: rawValue) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: rawValue)
    }
}

struct ClaudeLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let fiveHour: ClaudeWindow?
    let sevenDay: ClaudeWindow?
    let sevenDayOpus: ClaudeWindow?
    let weeklyScoped: [ClaudeScopedWindow]?
    let extraUsage: ClaudeExtraUsage?
    /// When this data was last successfully fetched from the provider, and whether
    /// it is being served from the stale disk-cache fallback (e.g. during a 429
    /// cool-down when the live usage endpoint is rate-limited). Both are optional so
    /// responses from older server builds still decode; a missing `stale` reads as fresh.
    let cachedAt: String?
    let stale: Bool?
    /// Expiry of an active 429 cool-down (ISO-8601), when one is in effect. Absent in
    /// the happy path. Lets the UI show when the next refresh is due and lets the app
    /// schedule a one-shot refresh the moment the cool-down lifts.
    let retryAt: String?
    /// Active status-page incident (status.anthropic.com), present only while the
    /// provider reports a non-"none" indicator. Optional so responses from older
    /// server builds (and the incident-free happy path) still decode.
    let serviceStatus: ProviderServiceStatus?

    enum CodingKeys: String, CodingKey {
        case configured, error, stale
        case planLabel = "plan_label"
        case fiveHour = "five_hour"
        case sevenDay = "seven_day"
        case sevenDayOpus = "seven_day_opus"
        case weeklyScoped = "weekly_scoped"
        case extraUsage = "extra_usage"
        case cachedAt = "cached_at"
        case retryAt = "retry_at"
        case serviceStatus = "service_status"
    }
}

/// A provider's public status-page reading (Statuspage.io shape), attached by the
/// local server only while an incident is active. `indicator` is one of
/// minor/major/critical ("none" is filtered server-side).
struct ProviderServiceStatus: Codable, Equatable {
    let indicator: String
    let description: String?
    let updatedAt: String?
    let url: String?

    enum CodingKeys: String, CodingKey {
        case indicator, description, url
        case updatedAt = "updated_at"
    }
}

struct ClaudeWindow: Codable, Equatable {
    let utilization: Double
    let resetsAt: String?

    enum CodingKeys: String, CodingKey {
        case utilization
        case resetsAt = "resets_at"
    }
}

/// Model-scoped weekly window (e.g. Fable): the label is server-provided
/// (`scope.model.display_name` upstream), so rows render dynamically.
struct ClaudeScopedWindow: Codable, Equatable {
    let label: String
    let utilization: Double
    let resetsAt: String?

    enum CodingKeys: String, CodingKey {
        case label, utilization
        case resetsAt = "resets_at"
    }
}

struct ClaudeExtraUsage: Codable, Equatable {
    let isEnabled: Bool
    let monthlyLimit: Int?
    let usedCredits: Int?
    let currency: String?

    enum CodingKeys: String, CodingKey {
        case isEnabled = "is_enabled"
        case monthlyLimit = "monthly_limit"
        case usedCredits = "used_credits"
        case currency
    }
}

struct CodexLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let primaryWindow: CodexWindow?
    let secondaryWindow: CodexWindow?
    let creditWindow: CodexCreditWindow?
    let sparkPrimaryWindow: CodexWindow?
    let sparkSecondaryWindow: CodexWindow?
    let resetCredits: ResetCredits?
    /// Data-age fields, mirroring `ClaudeLimits` — Codex serves its last-successful
    /// disk cache (`stale: true`) when the live wham read times out.
    let cachedAt: String?
    let stale: Bool?

    enum CodingKeys: String, CodingKey {
        case configured, error, stale
        case planLabel = "plan_label"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case creditWindow = "credit_window"
        case sparkPrimaryWindow = "spark_primary_window"
        case sparkSecondaryWindow = "spark_secondary_window"
        case resetCredits = "reset_credits"
        case cachedAt = "cached_at"
    }

    struct ResetCredits: Codable, Equatable {
        let availableCount: Int?
        let totalEarnedCount: Int?
        let credits: [ResetCredit]

        enum CodingKeys: String, CodingKey {
            case availableCount = "available_count"
            case totalEarnedCount = "total_earned_count"
            case credits
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            availableCount = try container.decodeIfPresent(Int.self, forKey: .availableCount)
            totalEarnedCount = try container.decodeIfPresent(Int.self, forKey: .totalEarnedCount)
            credits = try container.decodeIfPresent([ResetCredit].self, forKey: .credits) ?? []
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encodeIfPresent(availableCount, forKey: .availableCount)
            try container.encodeIfPresent(totalEarnedCount, forKey: .totalEarnedCount)
            try container.encode(credits, forKey: .credits)
        }
    }

    struct ResetCredit: Codable, Equatable {
        let status: String
        let resetType: String?
        let grantedAt: String?
        let expiresAt: String

        enum CodingKeys: String, CodingKey {
            case status
            case resetType = "reset_type"
            case grantedAt = "granted_at"
            case expiresAt = "expires_at"
        }
    }
}

struct CodexWindow: Codable, Equatable {
    let usedPercent: Int
    let resetAt: Int?
    let limitWindowSeconds: Int?

    enum CodingKeys: String, CodingKey {
        case usedPercent = "used_percent"
        case resetAt = "reset_at"
        case limitWindowSeconds = "limit_window_seconds"
    }
}

struct CodexCreditWindow: Codable, Equatable {
    let source: String?
    let usedPercent: Double
    let remainingPercent: Double?
    let resetAt: Int?
    let limitCredits: Double?
    let usedCredits: Double?
    let remainingCredits: Double?

    enum CodingKeys: String, CodingKey {
        case source
        case usedPercent = "used_percent"
        case remainingPercent = "remaining_percent"
        case resetAt = "reset_at"
        case limitCredits = "limit_credits"
        case usedCredits = "used_credits"
        case remainingCredits = "remaining_credits"
    }
}

struct GenericLimitWindow: Codable, Equatable {
    let usedPercent: Double
    let resetAt: String?
    let limitWindowSeconds: Double?

    enum CodingKeys: String, CodingKey {
        case usedPercent = "used_percent"
        case resetAt = "reset_at"
        case limitWindowSeconds = "limit_window_seconds"
    }
}

struct CursorLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let membershipType: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?
    let quaternaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case membershipType = "membership_type"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
        case quaternaryWindow = "quaternary_window"
    }
}

struct KimiLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let membershipLevel: String?
    let subscriptionType: String?
    let parallelLimit: Int?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case membershipLevel = "membership_level"
        case subscriptionType = "subscription_type"
        case parallelLimit = "parallel_limit"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
    }
}

struct KiroLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let planName: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case planName = "plan_name"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
    }
}

struct GeminiLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let accountEmail: String?
    let accountPlan: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case accountEmail = "account_email"
        case accountPlan = "account_plan"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
    }
}

struct GrokLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    /// "weekly" | "monthly" | "daily" from the billing API period type (null if unknown).
    let periodType: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case periodType = "period_type"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
    }
}

struct CopilotLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let planName: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case planName = "plan_name"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
    }
}

struct ZcodeLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let planKind: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?
    let buckets: [ZcodeBucket]?

    enum CodingKeys: String, CodingKey {
        case configured, error, buckets
        case planLabel = "plan_label"
        case planKind = "plan_kind"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
    }
}

/// One ZCode start-plan balance (daily allowance or one-time promotional grant).
struct ZcodeBucket: Codable, Equatable {
    let label: String?
    let entitlementId: String?
    let window: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case label, window
        case entitlementId = "entitlement_id"
    }
}

extension ZcodeLimits {
    /// Start-plan buckets that carry a server label, de-duplicated by label; nil when the
    /// payload predates bucket labels so callers keep their fixed GLM fallback.
    var labeledBuckets: [(key: String, label: String, window: GenericLimitWindow)]? {
        var out: [(key: String, label: String, window: GenericLimitWindow)] = []
        for b in buckets ?? [] {
            guard let label = b.label, !label.isEmpty, let window = b.window,
                  !out.contains(where: { $0.label == label }) else { continue }
            let entitlement = b.entitlementId ?? ""
            out.append((entitlement.isEmpty ? label : entitlement, label, window))
        }
        return out.isEmpty ? nil : out
    }
}

// OpenCode Go: $12/5h + $30/week + $60/month rolling usage scraped from
// https://opencode.ai/workspace/<id>/go. No public REST API yet (tracked at
// anomalyco/opencode#16017), so the backend HTML-parses the workspace page.
struct OpencodeGoLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
    }
}

/// Command Code (commandcode.ai): subscription windows (5h + weekly rolling
/// caps over included monthly credits) read from the CLI's own alpha endpoints
/// by the local server. Mirror of OpencodeGoLimits minus the monthly window.
struct CommandCodeLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let subscriptionStatus: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let cachedAt: String?
    let stale: Bool?
    let authActionRequired: String?

    enum CodingKeys: String, CodingKey {
        case configured, error, stale
        case planLabel = "plan_label"
        case subscriptionStatus = "subscription_status"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case cachedAt = "cached_at"
        case authActionRequired = "auth_action_required"
    }
}

struct QoderLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let cachedAt: String?
    let stale: Bool?

    enum CodingKeys: String, CodingKey {
        case configured, error, stale
        case planLabel = "plan_label"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case cachedAt = "cached_at"
    }
}

struct CodingPlanLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?
    let cachedAt: String?
    let stale: Bool?

    enum CodingKeys: String, CodingKey {
        case configured, error, stale
        case planLabel = "plan_label"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
        case cachedAt = "cached_at"
    }
}

typealias AgentPlanLimits = CodingPlanLimits

/// Devin (devin.ai): daily + weekly subscription quota read from the official
/// GetPlanStatus RPC by the local server, keyed by the Devin CLI's saved
/// sign-in. Mirror of CommandCodeLimits minus the subscription status.
struct DevinLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let cachedAt: String?
    let stale: Bool?
    let authActionRequired: String?

    enum CodingKeys: String, CodingKey {
        case configured, error, stale
        case planLabel = "plan_label"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case cachedAt = "cached_at"
        case authActionRequired = "auth_action_required"
    }

    /// The shape published while the Devin provider switch is off — no
    /// previously fetched windows may outlive the user's selection.
    static let unconfigured = DevinLimits(
        configured: false,
        error: nil,
        planLabel: nil,
        primaryWindow: nil,
        secondaryWindow: nil,
        cachedAt: nil,
        stale: nil,
        authActionRequired: nil
    )
}

struct AntigravityLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let accountEmail: String?
    let accountPlan: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?
    let quaternaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case accountEmail = "account_email"
        case accountPlan = "account_plan"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
        case quaternaryWindow = "quaternary_window"
    }
}

/// Helper to decide whether a response from the limits API contains at least one
/// usable (configured + no error) provider record. Used by the ViewModel to
/// protect the "last good record" on partial failures (do not overwrite a
/// previously successful snapshot with an all-error response).
extension UsageLimitsResponse {
    var hasAnyProviderWithoutError: Bool {
        let providers: [(Bool, String?)] = [
            (claude.configured, claude.error),
            (codex.configured, codex.error),
            (cursor.configured, cursor.error),
            (gemini.configured, gemini.error),
            (kimi?.configured ?? false, kimi?.error),
            (kiro.configured, kiro.error),
            (grok?.configured ?? false, grok?.error),
            (antigravity.configured, antigravity.error),
            (copilot?.configured ?? false, copilot?.error),
            (zcode?.configured ?? false, zcode?.error),
            (opencodeGo?.configured ?? false, opencodeGo?.error),
            (commandCode?.configured ?? false, commandCode?.error),
            (qoder?.configured ?? false, qoder?.error),
            (qoderCn?.configured ?? false, qoderCn?.error),
            (codingPlan?.configured ?? false, codingPlan?.error),
            (agentPlan?.configured ?? false, agentPlan?.error),
            (devin?.configured ?? false, devin?.error),
        ]
        return providers.contains { $0.0 && $0.1 == nil }
    }

    /// Decide which record the UI should display after a successful fetch:
    /// adopt the incoming response unless it has no usable provider data while a
    /// previous record exists (keeps the last good snapshot on an all-error response).
    static func displayRecord(
        current: UsageLimitsResponse?,
        incoming: UsageLimitsResponse
    ) -> UsageLimitsResponse {
        guard let current, !incoming.hasAnyProviderWithoutError else { return incoming }
        return current
    }

    /// Devin rows must never outlive the user's provider selection. While the
    /// switch is off, retained/cached payloads are rewritten to the
    /// not-configured shape so views, widgets and reset detection all agree.
    func applyingDevinSelection(_ selected: Bool) -> UsageLimitsResponse {
        guard !selected, let devin, devin != .unconfigured else { return self }
        return UsageLimitsResponse(
            fetchedAt: fetchedAt,
            claude: claude,
            codex: codex,
            cursor: cursor,
            gemini: gemini,
            kimi: kimi,
            kiro: kiro,
            grok: grok,
            antigravity: antigravity,
            copilot: copilot,
            zcode: zcode,
            opencodeGo: opencodeGo,
            commandCode: commandCode,
            qoder: qoder,
            qoderCn: qoderCn,
            codingPlan: codingPlan,
            agentPlan: agentPlan,
            devin: .unconfigured
        )
    }
}

/// Latest-request authority for usage-limits publications. Every refresh takes
/// a ticket when it starts and a Devin selection transition invalidates every
/// outstanding ticket immediately — even before the replacement refresh has
/// begun. Only the newest ticket may publish, so a late response fetched under
/// a superseded selection (including on→off→on cycles) can never overwrite the
/// display record, the disk cache, reset detection or boundary scheduling.
struct UsageLimitsPublicationAuthority {
    private var generation = 0

    /// Ticket identifying a new refresh. Overlapping same-selection requests
    /// resolve latest-wins because every begin supersedes the previous ticket.
    mutating func beginRequest() -> Int {
        generation += 1
        return generation
    }

    /// A selection transition supersedes in-flight work before its replacement
    /// refresh has even started.
    mutating func invalidateForSelectionChange() {
        generation += 1
    }

    /// `ticket` still owns the publication right only while no newer refresh
    /// or selection change has superseded it.
    func isCurrent(_ ticket: Int) -> Bool {
        ticket == generation
    }

    /// The publication decision every completed refresh must pass: superseded
    /// work returns nil and may not touch display, cache, reset detection or
    /// scheduling; current work returns the display record — incoming unless
    /// it carries no usable provider while a good record exists — with Devin
    /// rows rewritten when the selection is off.
    func publish(
        ticket: Int,
        incoming: UsageLimitsResponse,
        devinSelected: Bool,
        current: UsageLimitsResponse?
    ) -> UsageLimitsResponse? {
        guard isCurrent(ticket) else { return nil }
        return UsageLimitsResponse.displayRecord(
            current: current?.applyingDevinSelection(devinSelected),
            incoming: incoming.applyingDevinSelection(devinSelected)
        )
    }
}
