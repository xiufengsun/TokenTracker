import Foundation

enum NativeBillingReturn {
    static func canonicalOrderID(_ value: String) -> String? {
        guard value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: [.regularExpression, .caseInsensitive]) != nil,
              let uuid = UUID(uuidString: value) else { return nil }
        return uuid.uuidString.lowercased()
    }

    static func orderID(from url: URL) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "tokentracker", components.host == "billing", components.path == "/return",
              components.user == nil, components.password == nil, components.port == nil, components.fragment == nil,
              let query = components.queryItems, query.count == 1, query[0].name == "order",
              let value = query[0].value else { return nil }
        return canonicalOrderID(value)
    }
}
