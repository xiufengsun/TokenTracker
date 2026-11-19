import Foundation

// MARK: - Daily Usage (Phone-complete: includes total_cost_usd & per-model breakdown)

struct PhoneDailyUsageResponse: Codable, Equatable {
    var from: String
    var to: String
    var data: [PhoneDailyEntry]

    init(from: String = "", to: String = "", data: [PhoneDailyEntry] = []) {
        self.from = from
        self.to = to
        self.data = data
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = try c.decodeIfPresent(String.self, forKey: .from) ?? ""
        to = try c.decodeIfPresent(String.self, forKey: .to) ?? ""
        data = try c.decodeIfPresent([PhoneDailyEntry].self, forKey: .data) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case from, to, data
    }
}

struct PhoneDailyEntry: Codable, Equatable, Identifiable {
    var id: String { day }
    var day: String
    var totalTokens: Int
    var billableTotalTokens: Int
    var totalCostUsd: Double
    var inputTokens: Int
    var outputTokens: Int
    var cachedInputTokens: Int
    var cacheCreationInputTokens: Int
    var reasoningOutputTokens: Int
    var conversationCount: Int
    var models: [String: Int]

    init(
        day: String = "",
        totalTokens: Int = 0,
        billableTotalTokens: Int = 0,
        totalCostUsd: Double = 0,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cachedInputTokens: Int = 0,
        cacheCreationInputTokens: Int = 0,
        reasoningOutputTokens: Int = 0,
        conversationCount: Int = 0,
        models: [String: Int] = [:]
    ) {
        self.day = day
        self.totalTokens = totalTokens
        self.billableTotalTokens = billableTotalTokens
        self.totalCostUsd = totalCostUsd
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cachedInputTokens = cachedInputTokens
        self.cacheCreationInputTokens = cacheCreationInputTokens
        self.reasoningOutputTokens = reasoningOutputTokens
        self.conversationCount = conversationCount
        self.models = models
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = try c.decodeIfPresent(String.self, forKey: .day) ?? ""
        totalTokens = try c.decodeIfPresent(Int.self, forKey: .totalTokens) ?? 0
        billableTotalTokens = try c.decodeIfPresent(Int.self, forKey: .billableTotalTokens) ?? 0
        if let costDouble = try? c.decodeIfPresent(Double.self, forKey: .totalCostUsd) {
            totalCostUsd = costDouble
        } else if let costString = try? c.decodeIfPresent(String.self, forKey: .totalCostUsd), let parsed = Double(costString) {
            totalCostUsd = parsed
        } else {
            totalCostUsd = 0
        }
        inputTokens = try c.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0
        outputTokens = try c.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
        cachedInputTokens = try c.decodeIfPresent(Int.self, forKey: .cachedInputTokens) ?? 0
        cacheCreationInputTokens = try c.decodeIfPresent(Int.self, forKey: .cacheCreationInputTokens) ?? 0
        reasoningOutputTokens = try c.decodeIfPresent(Int.self, forKey: .reasoningOutputTokens) ?? 0
        conversationCount = try c.decodeIfPresent(Int.self, forKey: .conversationCount) ?? 0
        models = try c.decodeIfPresent([String: Int].self, forKey: .models) ?? [:]
    }

    private enum CodingKeys: String, CodingKey {
        case day, models
        case totalTokens = "total_tokens"
        case billableTotalTokens = "billable_total_tokens"
        case totalCostUsd = "total_cost_usd"
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case cachedInputTokens = "cached_input_tokens"
        case cacheCreationInputTokens = "cache_creation_input_tokens"
        case reasoningOutputTokens = "reasoning_output_tokens"
        case conversationCount = "conversation_count"
    }
}

// MARK: - Hourly Usage (Today's pulse across 24 hours)

struct PhoneHourlyUsageResponse: Codable, Equatable {
    var day: String
    var data: [PhoneHourlyEntry]

    init(day: String = "", data: [PhoneHourlyEntry] = []) {
        self.day = day
        self.data = data
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = try c.decodeIfPresent(String.self, forKey: .day) ?? ""
        data = try c.decodeIfPresent([PhoneHourlyEntry].self, forKey: .data) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case day, data
    }
}

struct PhoneHourlyEntry: Codable, Equatable, Identifiable {
    var id: String { hour }
    var hour: String
    var totalTokens: Int
    var billableTotalTokens: Int
    var inputTokens: Int
    var outputTokens: Int
    var cachedInputTokens: Int
    var cacheCreationInputTokens: Int
    var reasoningOutputTokens: Int
    var conversationCount: Int
    var models: [String: Int]

    init(
        hour: String = "",
        totalTokens: Int = 0,
        billableTotalTokens: Int = 0,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cachedInputTokens: Int = 0,
        cacheCreationInputTokens: Int = 0,
        reasoningOutputTokens: Int = 0,
        conversationCount: Int = 0,
        models: [String: Int] = [:]
    ) {
        self.hour = hour
        self.totalTokens = totalTokens
        self.billableTotalTokens = billableTotalTokens
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cachedInputTokens = cachedInputTokens
        self.cacheCreationInputTokens = cacheCreationInputTokens
        self.reasoningOutputTokens = reasoningOutputTokens
        self.conversationCount = conversationCount
        self.models = models
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hour = try c.decodeIfPresent(String.self, forKey: .hour) ?? ""
        totalTokens = try c.decodeIfPresent(Int.self, forKey: .totalTokens) ?? 0
        billableTotalTokens = try c.decodeIfPresent(Int.self, forKey: .billableTotalTokens) ?? 0
        inputTokens = try c.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0
        outputTokens = try c.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
        cachedInputTokens = try c.decodeIfPresent(Int.self, forKey: .cachedInputTokens) ?? 0
        cacheCreationInputTokens = try c.decodeIfPresent(Int.self, forKey: .cacheCreationInputTokens) ?? 0
        reasoningOutputTokens = try c.decodeIfPresent(Int.self, forKey: .reasoningOutputTokens) ?? 0
        conversationCount = try c.decodeIfPresent(Int.self, forKey: .conversationCount) ?? 0
        models = try c.decodeIfPresent([String: Int].self, forKey: .models) ?? [:]
    }

    private enum CodingKeys: String, CodingKey {
        case hour, models
        case totalTokens = "total_tokens"
        case billableTotalTokens = "billable_total_tokens"
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case cachedInputTokens = "cached_input_tokens"
        case cacheCreationInputTokens = "cache_creation_input_tokens"
        case reasoningOutputTokens = "reasoning_output_tokens"
        case conversationCount = "conversation_count"
    }
}

// MARK: - Account Devices (`tokentracker-account-devices`)

struct AccountDevicesResponse: Codable, Equatable {
    var from: String
    var to: String
    var devices: [AccountDeviceRow]
    var accountSources: [AccountLevelSourceRow]

    init(
        from: String = "",
        to: String = "",
        devices: [AccountDeviceRow] = [],
        accountSources: [AccountLevelSourceRow] = []
    ) {
        self.from = from
        self.to = to
        self.devices = devices
        self.accountSources = accountSources
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = try c.decodeIfPresent(String.self, forKey: .from) ?? ""
        to = try c.decodeIfPresent(String.self, forKey: .to) ?? ""
        devices = try c.decodeIfPresent([AccountDeviceRow].self, forKey: .devices) ?? []
        accountSources = try c.decodeIfPresent([AccountLevelSourceRow].self, forKey: .accountSources) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case from, to, devices
        case accountSources = "account_sources"
    }
}

struct AccountDeviceRow: Codable, Equatable, Identifiable {
    var id: String
    var deviceName: String?
    var platform: String?
    var createdAt: String?
    var totalTokens: Int

    var displayName: String {
        let trimmed = deviceName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Computer" : trimmed
    }

    private enum CodingKeys: String, CodingKey {
        case id, platform
        case deviceName = "device_name"
        case createdAt = "created_at"
        case totalTokens = "total_tokens"
    }

    init(id: String, deviceName: String? = nil, platform: String? = nil, createdAt: String? = nil, totalTokens: Int = 0) {
        self.id = id
        self.deviceName = deviceName
        self.platform = platform
        self.createdAt = createdAt
        self.totalTokens = totalTokens
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        deviceName = try c.decodeIfPresent(String.self, forKey: .deviceName)
        platform = try c.decodeIfPresent(String.self, forKey: .platform)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        totalTokens = try c.decodeIfPresent(Int.self, forKey: .totalTokens) ?? 0
    }
}

struct AccountLevelSourceRow: Codable, Equatable, Identifiable {
    var id: String { source }
    var source: String
    var totalTokens: Int

    private enum CodingKeys: String, CodingKey {
        case source
        case totalTokens = "total_tokens"
    }

    init(source: String, totalTokens: Int) {
        self.source = source
        self.totalTokens = totalTokens
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? ""
        totalTokens = try c.decodeIfPresent(Int.self, forKey: .totalTokens) ?? 0
    }
}

// MARK: - Cloud Account & Machine Status (`tokentracker-billing?action=account` & `action=devices`)

struct CloudAccountStatusResponse: Codable, Equatable {
    var environment: String?
    var membership: CloudMembershipInfo
    var machineCount: Int?
    var subscriptions: [CloudSubscriptionInfo]

    init(
        environment: String? = "live",
        membership: CloudMembershipInfo = CloudMembershipInfo(),
        machineCount: Int? = nil,
        subscriptions: [CloudSubscriptionInfo] = []
    ) {
        self.environment = environment
        self.membership = membership
        self.machineCount = machineCount
        self.subscriptions = subscriptions
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        environment = try c.decodeIfPresent(String.self, forKey: .environment)
        membership = try c.decodeIfPresent(CloudMembershipInfo.self, forKey: .membership) ?? CloudMembershipInfo()
        machineCount = try c.decodeIfPresent(Int.self, forKey: .machineCount)
        subscriptions = try c.decodeIfPresent([CloudSubscriptionInfo].self, forKey: .subscriptions) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case environment, membership, subscriptions
        case machineCount = "machine_count"
    }
}

struct CloudMembershipInfo: Codable, Equatable {
    var status: String
    var hostingMode: String?
    var expiresAt: String?
    var accessSource: String?
    var hasGift: Bool
    var giftExpiresAt: String?
    var trialEndsAt: String?
    var transitionEndsAt: String?
    var readOnlyUntil: String?
    var canReadCloud: Bool
    var canUploadCloud: Bool
    var machineLimit: Int?
    var syncIntervalSeconds: Int
    var hourlyHistoryDays: Int?
    var dailyHistoryMonths: Int?

    init(
        status: String = "active",
        hostingMode: String? = "hosted",
        expiresAt: String? = nil,
        accessSource: String? = nil,
        hasGift: Bool = false,
        giftExpiresAt: String? = nil,
        trialEndsAt: String? = nil,
        transitionEndsAt: String? = nil,
        readOnlyUntil: String? = nil,
        canReadCloud: Bool = true,
        canUploadCloud: Bool = true,
        machineLimit: Int? = 99,
        syncIntervalSeconds: Int = 900,
        hourlyHistoryDays: Int? = 90,
        dailyHistoryMonths: Int? = 24
    ) {
        self.status = status
        self.hostingMode = hostingMode
        self.expiresAt = expiresAt
        self.accessSource = accessSource
        self.hasGift = hasGift
        self.giftExpiresAt = giftExpiresAt
        self.trialEndsAt = trialEndsAt
        self.transitionEndsAt = transitionEndsAt
        self.readOnlyUntil = readOnlyUntil
        self.canReadCloud = canReadCloud
        self.canUploadCloud = canUploadCloud
        self.machineLimit = machineLimit
        self.syncIntervalSeconds = syncIntervalSeconds
        self.hourlyHistoryDays = hourlyHistoryDays
        self.dailyHistoryMonths = dailyHistoryMonths
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "free"
        hostingMode = try c.decodeIfPresent(String.self, forKey: .hostingMode)
        expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt)
        accessSource = try c.decodeIfPresent(String.self, forKey: .accessSource)
        hasGift = try c.decodeIfPresent(Bool.self, forKey: .hasGift) ?? false
        giftExpiresAt = try c.decodeIfPresent(String.self, forKey: .giftExpiresAt)
        trialEndsAt = try c.decodeIfPresent(String.self, forKey: .trialEndsAt)
        transitionEndsAt = try c.decodeIfPresent(String.self, forKey: .transitionEndsAt)
        readOnlyUntil = try c.decodeIfPresent(String.self, forKey: .readOnlyUntil)
        canReadCloud = try c.decodeIfPresent(Bool.self, forKey: .canReadCloud) ?? false
        canUploadCloud = try c.decodeIfPresent(Bool.self, forKey: .canUploadCloud) ?? false
        machineLimit = try c.decodeIfPresent(Int.self, forKey: .machineLimit)
        syncIntervalSeconds = try c.decodeIfPresent(Int.self, forKey: .syncIntervalSeconds) ?? 900
        hourlyHistoryDays = try c.decodeIfPresent(Int.self, forKey: .hourlyHistoryDays)
        dailyHistoryMonths = try c.decodeIfPresent(Int.self, forKey: .dailyHistoryMonths)
    }

    private enum CodingKeys: String, CodingKey {
        case status
        case hostingMode = "hosting_mode"
        case expiresAt = "expires_at"
        case accessSource = "access_source"
        case hasGift = "has_gift"
        case giftExpiresAt = "gift_expires_at"
        case trialEndsAt = "trial_ends_at"
        case transitionEndsAt = "transition_ends_at"
        case readOnlyUntil = "read_only_until"
        case canReadCloud = "can_read_cloud"
        case canUploadCloud = "can_upload_cloud"
        case machineLimit = "machine_limit"
        case syncIntervalSeconds = "sync_interval_seconds"
        case hourlyHistoryDays = "hourly_history_days"
        case dailyHistoryMonths = "daily_history_months"
    }

    var displayStatusTitle: String {
        if status == "self_hosted" || hostingMode == "self_hosted" { return "Self-Hosted" }
        if status == "active" && accessSource == "gift" { return "Cloud Gift" }
        switch status {
        case "active": return "Cloud Active"
        case "trial": return "Cloud Trial"
        case "transition": return "Cloud Transition"
        case "legacy_free": return "Cloud Legacy"
        case "expired": return canReadCloud ? "Read-Only Window" : "Cloud Ended"
        default: return "No Cloud Access"
        }
    }

    var relevantEndDateISO: String? {
        switch status {
        case "trial": return trialEndsAt
        case "transition": return transitionEndsAt
        case "expired": return canReadCloud ? readOnlyUntil : expiresAt
        default: return expiresAt
        }
    }
}

struct CloudSubscriptionInfo: Codable, Equatable {
    var provider: String?
    var providerSubscriptionId: String
    var status: String
    var cancelAtPeriodEnd: Bool
    var nextBilledAt: String?

    private enum CodingKeys: String, CodingKey {
        case provider, status
        case providerSubscriptionId = "provider_subscription_id"
        case cancelAtPeriodEnd = "cancel_at_period_end"
        case nextBilledAt = "next_billed_at"
    }

    init(
        provider: String? = nil,
        providerSubscriptionId: String = "",
        status: String = "active",
        cancelAtPeriodEnd: Bool = false,
        nextBilledAt: String? = nil
    ) {
        self.provider = provider
        self.providerSubscriptionId = providerSubscriptionId
        self.status = status
        self.cancelAtPeriodEnd = cancelAtPeriodEnd
        self.nextBilledAt = nextBilledAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decodeIfPresent(String.self, forKey: .provider)
        providerSubscriptionId = try c.decodeIfPresent(String.self, forKey: .providerSubscriptionId) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        cancelAtPeriodEnd = try c.decodeIfPresent(Bool.self, forKey: .cancelAtPeriodEnd) ?? false
        nextBilledAt = try c.decodeIfPresent(String.self, forKey: .nextBilledAt)
    }
}

struct CloudMachineListResponse: Codable, Equatable {
    var machines: [CloudMachineItem]
    var machineCount: Int?
    var machineLimit: Int?
    var overMachineLimit: Bool

    init(
        machines: [CloudMachineItem] = [],
        machineCount: Int? = nil,
        machineLimit: Int? = nil,
        overMachineLimit: Bool = false
    ) {
        self.machines = machines
        self.machineCount = machineCount
        self.machineLimit = machineLimit
        self.overMachineLimit = overMachineLimit
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machines = try c.decodeIfPresent([CloudMachineItem].self, forKey: .machines) ?? []
        machineCount = try c.decodeIfPresent(Int.self, forKey: .machineCount)
        machineLimit = try c.decodeIfPresent(Int.self, forKey: .machineLimit)
        overMachineLimit = try c.decodeIfPresent(Bool.self, forKey: .overMachineLimit) ?? false
    }

    private enum CodingKeys: String, CodingKey {
        case machines
        case machineCount = "machine_count"
        case machineLimit = "machine_limit"
        case overMachineLimit = "over_machine_limit"
    }
}

struct CloudMachineItem: Codable, Equatable, Identifiable {
    var id: String { machineId }
    var machineId: String
    var name: String?
    var platform: String?
    var status: String?
    var lastSeenAt: String?

    var displayName: String {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Unnamed computer" : trimmed
    }

    var isPaused: Bool {
        status == "paused"
    }

    var platformLabel: String {
        guard let raw = platform?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return "Desktop"
        }
        let lower = raw.lowercased()
        if lower.hasPrefix("mac") || lower.hasPrefix("darwin") { return "macOS" }
        if lower.hasPrefix("win") { return "Windows" }
        if lower.hasPrefix("linux") { return "Linux" }
        if lower.contains("cli") { return "CLI" }
        return raw
    }

    var platformSymbol: String {
        let lower = (platform ?? "").lowercased()
        if lower.hasPrefix("mac") || lower.hasPrefix("darwin") { return "laptopcomputer" }
        if lower.hasPrefix("win") { return "pc" }
        if lower.hasPrefix("linux") || lower.contains("cli") { return "terminal" }
        return "desktopcomputer"
    }

    init(
        machineId: String,
        name: String? = nil,
        platform: String? = nil,
        status: String? = "active",
        lastSeenAt: String? = nil
    ) {
        self.machineId = machineId
        self.name = name
        self.platform = platform
        self.status = status
        self.lastSeenAt = lastSeenAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machineId = try c.decodeIfPresent(String.self, forKey: .machineId) ?? UUID().uuidString
        name = try c.decodeIfPresent(String.self, forKey: .name)
        platform = try c.decodeIfPresent(String.self, forKey: .platform)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt)
    }

    private enum CodingKeys: String, CodingKey {
        case name, platform, status
        case machineId = "machine_id"
        case lastSeenAt = "last_seen_at"
    }
}

// MARK: - Public Visibility (`tokentracker-public-visibility`)

struct PublicVisibilityState: Codable, Equatable {
    var enabled: Bool
    var anonymous: Bool
    var displayName: String?
    var githubUrl: String?
    var showGithubUrl: Bool
    var updatedAt: String?

    init(
        enabled: Bool = false,
        anonymous: Bool = false,
        displayName: String? = nil,
        githubUrl: String? = nil,
        showGithubUrl: Bool = false,
        updatedAt: String? = nil
    ) {
        self.enabled = enabled
        self.anonymous = anonymous
        self.displayName = displayName
        self.githubUrl = githubUrl
        self.showGithubUrl = showGithubUrl
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        anonymous = try c.decodeIfPresent(Bool.self, forKey: .anonymous) ?? false
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        githubUrl = try c.decodeIfPresent(String.self, forKey: .githubUrl)
        showGithubUrl = try c.decodeIfPresent(Bool.self, forKey: .showGithubUrl) ?? false
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, anonymous
        case displayName = "display_name"
        case githubUrl = "github_url"
        case showGithubUrl = "show_github_url"
        case updatedAt = "updated_at"
    }
}

struct PublicVisibilityPatch: Encodable, Equatable {
    var enabled: Bool?
    var anonymous: Bool?
    var displayName: String?
    var githubUrl: String?
    var clearGithubUrl: Bool = false
    var showGithubUrl: Bool?

    private enum CodingKeys: String, CodingKey {
        case enabled, anonymous
        case displayName = "display_name"
        case githubUrl = "github_url"
        case showGithubUrl = "show_github_url"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(enabled, forKey: .enabled)
        try c.encodeIfPresent(anonymous, forKey: .anonymous)
        try c.encodeIfPresent(displayName, forKey: .displayName)
        if clearGithubUrl {
            try c.encodeNil(forKey: .githubUrl)
        } else {
            try c.encodeIfPresent(githubUrl, forKey: .githubUrl)
        }
        try c.encodeIfPresent(showGithubUrl, forKey: .showGithubUrl)
    }
}

struct DeviceGrantResult: Decodable, Equatable {
    var ok: Bool
    var code: String?
}
