import Foundation

enum Constants {
    static let serverBaseURL = NativeQAProfile.current?.origin ?? "http://localhost:7680"
    static let serverPort = NativeQAProfile.current?.baseURL.port ?? 7680
    static let autoRefreshInterval: TimeInterval = 300
    static let healthCheckInterval: TimeInterval = 30
    static let maxHeatmapWeeks = 52
}
