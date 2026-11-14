import Foundation

enum Constants {
    // The Native QA profile wins first: a QA build also compiles as Debug, so
    // the variant branch below would otherwise hijack its port.
    #if TOKENTRACKER_NATIVE_QA
    static let serverBaseURL = NativeQAProfile.current?.origin ?? "http://localhost:7680"
    static let serverPort = NativeQAProfile.current?.baseURL.port ?? 7680
    // Dev variant (Debug config) serves on 7681 so it can coexist with the
    // production app's 7680 server without killing each other (dev spec §4-1).
    #elseif DEBUG
    static let serverBaseURL = "http://localhost:7681"
    static let serverPort = 7681
    #else
    static let serverBaseURL = "http://localhost:7680"
    static let serverPort = 7680
    #endif
    static let autoRefreshInterval: TimeInterval = 300
    static let healthCheckInterval: TimeInterval = 30
    static let maxHeatmapWeeks = 52
}
