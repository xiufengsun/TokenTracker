import Foundation

enum BackgroundRefreshPolicy {
    static let defaultRefreshInterval: TimeInterval = 300
    static let defaultSyncInterval: TimeInterval = 300
    static let defaultCatchUpStaleInterval: TimeInterval = 300
    static let defaultPopoverOpenSyncInterval: TimeInterval = 300
    static let defaultPopoverOpenLoadInterval: TimeInterval = 30
    // Account edge functions cache grouped rows for 30 seconds. A successful
    // ingest can also precede read-model visibility, so publish after the cache
    // window plus a small guard instead of preserving a stale total for five
    // more minutes.
    static let defaultAccountUploadVisibilityDelay: TimeInterval = 35

    static func shouldRunSync(
        now: Date,
        lastSyncAt: Date?,
        syncInterval: TimeInterval = defaultSyncInterval
    ) -> Bool {
        guard syncInterval > 0 else { return false }
        guard let lastSyncAt else { return true }
        return now.timeIntervalSince(lastSyncAt) >= syncInterval
    }

    static func shouldRunCatchUpSync(
        now: Date,
        lastSyncAt: Date?,
        staleInterval: TimeInterval = defaultCatchUpStaleInterval
    ) -> Bool {
        guard staleInterval > 0 else { return false }
        guard let lastSyncAt else { return true }
        return now.timeIntervalSince(lastSyncAt) >= staleInterval
    }

    static func shouldRunPopoverOpenSync(
        now: Date,
        lastAttemptAt: Date?,
        lastSyncAt: Date?,
        syncInterval: TimeInterval = defaultPopoverOpenSyncInterval
    ) -> Bool {
        guard syncInterval > 0 else { return false }
        if let lastAttemptAt, now.timeIntervalSince(lastAttemptAt) < syncInterval {
            return false
        }
        if let lastSyncAt, now.timeIntervalSince(lastSyncAt) < syncInterval {
            return false
        }
        return true
    }

    static func shouldRunPopoverOpenLoad(
        now: Date,
        lastRefreshedAt: Date?,
        loadInterval: TimeInterval = defaultPopoverOpenLoadInterval
    ) -> Bool {
        guard loadInterval > 0 else { return false }
        guard let lastRefreshedAt else { return true }
        return now.timeIntervalSince(lastRefreshedAt) >= loadInterval
    }
}
