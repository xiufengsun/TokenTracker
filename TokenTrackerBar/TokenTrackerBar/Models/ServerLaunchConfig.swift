import Foundation

struct ServerLaunchConfig {
    static let maxOldSpaceSize = 48
    static let extraNodeOption = "--max-old-space-size=\(maxOldSpaceSize)"
    static let optimizeForSizeArg = "--optimize-for-size"
    static let exposeGcArg = "--expose-gc"

    static func buildArguments(entryPath: String, port: Int) -> [String] {
        [optimizeForSizeArg, exposeGcArg, entryPath, "serve", "--port", "\(port)", "--no-sync", "--no-open"]
    }

    static func mergeNodeOptions(existing: String?) -> String {
        guard let existing = existing?.trimmingCharacters(in: .whitespaces), !existing.isEmpty else {
            return extraNodeOption
        }
        if existing.contains("--max-old-space-size=") {
            return existing
        }
        return "\(existing) \(extraNodeOption)"
    }
}
