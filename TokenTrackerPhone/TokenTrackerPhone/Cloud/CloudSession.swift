import Foundation

struct CloudUser: Codable, Equatable {
    var id: String
    var email: String?
    var name: String?
}

struct CloudSession: Codable, Equatable {
    var accessToken: String
    var refreshToken: String?
    var user: CloudUser

    /// `exp` claim of the access token, when present.
    var accessTokenExpiry: Date? { JWT.expiry(of: accessToken) }

    func accessTokenNeedsRefresh(now: Date = Date(), leeway: TimeInterval = 60) -> Bool {
        guard let expiry = accessTokenExpiry else { return false }
        return expiry.timeIntervalSince(now) <= leeway
    }
}

/// `/api/auth/sessions`, `/api/auth/oauth/exchange` and `/api/auth/refresh`
/// responses. With `client_type=mobile` the refresh token comes back in the
/// body instead of an httpOnly cookie.
struct AuthResponse: Decodable {
    let accessToken: String
    let refreshToken: String?
    let user: CloudUser?

    private enum CodingKeys: String, CodingKey { case accessToken, refreshToken, user }
    private enum UserKeys: String, CodingKey { case id, email, name, profile }
    private enum ProfileKeys: String, CodingKey { case name, nickname }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try c.decode(String.self, forKey: .accessToken)
        refreshToken = try c.decodeIfPresent(String.self, forKey: .refreshToken)
        guard c.contains(.user), (try? c.decodeNil(forKey: .user)) == false else {
            user = nil
            return
        }
        let u = try c.nestedContainer(keyedBy: UserKeys.self, forKey: .user)
        let profileName: String? = {
            guard let p = try? u.nestedContainer(keyedBy: ProfileKeys.self, forKey: .profile) else { return nil }
            return (try? p.decodeIfPresent(String.self, forKey: .name)) ?? (try? p.decodeIfPresent(String.self, forKey: .nickname)) ?? nil
        }()
        user = CloudUser(
            id: try u.decode(String.self, forKey: .id),
            email: try u.decodeIfPresent(String.self, forKey: .email),
            name: profileName ?? (try? u.decodeIfPresent(String.self, forKey: .name)) ?? nil
        )
    }
}

enum JWT {
    static func payload(of token: String) -> [String: Any]? {
        let parts = token.split(separator: ".")
        guard parts.count == 3, let data = Data(base64URLEncoded: String(parts[1])) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    static func expiry(of token: String) -> Date? {
        guard let exp = payload(of: token)?["exp"] as? NSNumber else { return nil }
        return Date(timeIntervalSince1970: exp.doubleValue)
    }
}
