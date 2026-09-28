import CFNetwork
import Foundation

enum LocalAPIConfiguration {
    /// The local dashboard API lives on `http://localhost:7680`. A system-wide
    /// proxy — or a VPN in TUN / "enhanced" mode whose bypass list omits
    /// localhost — otherwise intercepts these loopback requests and the app
    /// declares the server unreachable while `curl` (which reads `no_proxy`)
    /// and browsers (which bypass proxies for localhost) reach it fine.
    /// A non-nil dictionary makes URLSession ignore the system proxy settings
    /// for this session. See issue #557.
    private static var loopbackProxyBypass: [AnyHashable: Any] {
        [
            kCFNetworkProxiesHTTPEnable as AnyHashable: 0,
            kCFNetworkProxiesHTTPSEnable as AnyHashable: 0,
            kCFNetworkProxiesSOCKSEnable as AnyHashable: 0,
            kCFNetworkProxiesProxyAutoConfigEnable as AnyHashable: 0,
        ]
    }

    static func makeSessionConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 30
        // Local API responses are live state, including after a clock rollback.
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.connectionProxyDictionary = loopbackProxyBypass
        return config
    }
}
