import Foundation

struct TokenTotals: Codable, Equatable {
    var totalTokens: Int
    var billableTotalTokens: Int
    var inputTokens: Int
    var outputTokens: Int
    var cachedInputTokens: Int
    var cacheCreationInputTokens: Int
    var reasoningOutputTokens: Int
    var conversationCount: Int
    var totalCostUsd: String?
    var unclassifiedInputTokens: Int = 0
    var costStatus: String? = nil

    init(
        totalTokens: Int = 0, billableTotalTokens: Int = 0,
        inputTokens: Int = 0, outputTokens: Int = 0,
        cachedInputTokens: Int = 0, cacheCreationInputTokens: Int = 0,
        reasoningOutputTokens: Int = 0, conversationCount: Int = 0,
        totalCostUsd: String? = nil
    ) {
        self.totalTokens = totalTokens
        self.billableTotalTokens = billableTotalTokens
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cachedInputTokens = cachedInputTokens
        self.cacheCreationInputTokens = cacheCreationInputTokens
        self.reasoningOutputTokens = reasoningOutputTokens
        self.conversationCount = conversationCount
        self.totalCostUsd = totalCostUsd
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalTokens = try c.decodeIfPresent(Int.self, forKey: .totalTokens) ?? 0
        billableTotalTokens = try c.decodeIfPresent(Int.self, forKey: .billableTotalTokens) ?? 0
        inputTokens = try c.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0
        outputTokens = try c.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
        cachedInputTokens = try c.decodeIfPresent(Int.self, forKey: .cachedInputTokens) ?? 0
        cacheCreationInputTokens = try c.decodeIfPresent(Int.self, forKey: .cacheCreationInputTokens) ?? 0
        reasoningOutputTokens = try c.decodeIfPresent(Int.self, forKey: .reasoningOutputTokens) ?? 0
        conversationCount = try c.decodeIfPresent(Int.self, forKey: .conversationCount) ?? 0
        totalCostUsd = try c.decodeIfPresent(String.self, forKey: .totalCostUsd)
        unclassifiedInputTokens = try c.decodeIfPresent(Int.self, forKey: .unclassifiedInputTokens) ?? 0
        costStatus = try c.decodeIfPresent(String.self, forKey: .costStatus)
    }

    private enum CodingKeys: String, CodingKey {
        case totalTokens = "total_tokens"
        case billableTotalTokens = "billable_total_tokens"
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case cachedInputTokens = "cached_input_tokens"
        case cacheCreationInputTokens = "cache_creation_input_tokens"
        case reasoningOutputTokens = "reasoning_output_tokens"
        case conversationCount = "conversation_count"
        case totalCostUsd = "total_cost_usd"
        case unclassifiedInputTokens = "unclassified_input_tokens"
        case costStatus = "cost_status"
    }
}
