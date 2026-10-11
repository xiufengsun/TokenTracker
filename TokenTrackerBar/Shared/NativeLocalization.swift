import Foundation

public enum NativeLocalization {
    public static let preferenceKey = "tokentracker-locale"
    public static let systemPreference = "system"
    public static let englishLocale = "en"
    public static let chineseLocale = "zh-CN"
    public static let traditionalChineseLocale = "zh-TW"
    public static let japaneseLocale = "ja"
    public static let koreanLocale = "ko"

    private static var sharedDefaults: UserDefaults? {
        UserDefaults(suiteName: WidgetSharedConstants.appGroupIdentifier)
    }

    /// Map a BCP-47-ish language tag to one of the supported resolved locales.
    /// Traditional Chinese covers the Hant script and the Taiwan/Hong Kong/Macau
    /// regions; everything else under zh-* (zh, zh-Hans, zh-CN, zh-SG, …) is Simplified.
    /// Unrecognized tags fall back to English.
    private static func classify(_ tag: String) -> String {
        let lower = tag.lowercased()
        if lower.range(of: #"^zh([-_]|$)"#, options: .regularExpression) != nil {
            if lower.range(of: #"^zh[-_](hant|tw|hk|mo)([-_]|$)"#, options: .regularExpression) != nil {
                return traditionalChineseLocale
            }
            return chineseLocale
        }
        if lower.range(of: #"^ja([-_]|$)"#, options: .regularExpression) != nil { return japaneseLocale }
        if lower.range(of: #"^ko([-_]|$)"#, options: .regularExpression) != nil { return koreanLocale }
        return englishLocale
    }

    public static func normalizePreference(_ value: Any?) -> String {
        guard let raw = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return systemPreference }
        if raw == systemPreference { return systemPreference }
        return classify(raw)
    }

    public static var currentPreference: String {
        if let profile = NativeQAProfile.current {
            return normalizePreference(profile.defaults.string(forKey: preferenceKey))
        }
        // The dashboard writes the main-app preference. Prefer it when present
        // so an old widget App Group value cannot force the menu bar back to a
        // previous language after an update.
        if let local = UserDefaults.standard.string(forKey: preferenceKey) {
            return normalizePreference(local)
        }
        return normalizePreference(sharedDefaults?.string(forKey: preferenceKey))
    }

    public static var currentResolvedLocale: String {
        resolveLocale(preference: currentPreference)
    }

    public static var usesChinese: Bool {
        let resolved = currentResolvedLocale
        return resolved == chineseLocale || resolved == traditionalChineseLocale
    }

    public static func resolveLocale(
        preference: String? = nil,
        preferredLanguages: [String] = Locale.preferredLanguages
    ) -> String {
        let normalized = normalizePreference(preference ?? currentPreference)
        guard normalized == systemPreference else { return normalized }
        // Use only the primary (most preferred) language, not any zh entry in the list.
        // Many English macOS users keep zh-Hans-CN as a secondary preferred language for
        // input methods or fallback menus — scanning the whole array mis-resolves their
        // primary "en" to Chinese. See issue #54.
        let primary = preferredLanguages
            .lazy
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        guard let primary else { return englishLocale }
        return classify(primary)
    }

    public static func storePreference(_ value: Any?) {
        let normalized = normalizePreference(value)
        if let profile = NativeQAProfile.current {
            profile.defaults.set(normalized, forKey: preferenceKey)
            return
        }
        UserDefaults.standard.set(normalized, forKey: preferenceKey)
        sharedDefaults?.set(normalized, forKey: preferenceKey)
    }

    /// Repair an App Group preference left behind by an older build.
    public static func synchronizeSharedPreference() {
        guard NativeQAProfile.current == nil else { return }
        guard let local = UserDefaults.standard.string(forKey: preferenceKey) else { return }
        sharedDefaults?.set(normalizePreference(local), forKey: preferenceKey)
    }
}
