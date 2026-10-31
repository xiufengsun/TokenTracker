import Foundation

enum WidgetStrings {
    private static var loc: String { NativeLocalization.currentResolvedLocale }
    private static func t(_ en: String, _ zhCN: String, _ zhTW: String, _ ja: String, _ ko: String) -> String {
        switch loc {
        case NativeLocalization.chineseLocale: return zhCN
        case NativeLocalization.traditionalChineseLocale: return zhTW
        case NativeLocalization.japaneseLocale: return ja
        case NativeLocalization.koreanLocale: return ko
        default: return en
        }
    }

    static var usageName: String { t("Usage", "使用情况", "使用情況", "使用状況", "사용량") }
    static var usageDescription: String { t("Today's tokens at a glance, with trend.", "快速查看今日 tokens 和趋势。", "快速檢視今日 tokens 和趨勢。", "今日のトークンとトレンドをひと目で。", "오늘의 토큰과 추세를 한눈에.") }
    static var today: String { t("TODAY", "今日", "今日", "今日", "오늘") }
    static var sevenDays: String { t("7 DAYS", "7 天", "7 天", "7日間", "7일") }
    static var thirtyDays: String { t("30 DAYS", "30 天", "30 天", "30日間", "30일") }
    static var vsYesterday: String { t("vs. yesterday", "较昨日", "較昨日", "前日比", "어제 대비") }

    static var heatmapName: String { t("Activity Heatmap", "活跃热力图", "活躍熱力圖", "アクティビティヒートマップ", "활동 히트맵") }
    static var heatmapDescription: String { t("GitHub-style daily activity calendar.", "类似 GitHub 的每日活跃日历。", "類似 GitHub 的每日活躍日曆。", "GitHub 風の日次アクティビティカレンダー。", "GitHub 스타일의 일일 활동 캘린더.") }
    static func streak(_ days: Int) -> String { t("\(days)d streak", "连续 \(days) 天", "連續 \(days) 天", "\(days)日連続", "\(days)일 연속") }
    static func tokensActiveDays(activeDays: Int) -> String {
        t("tokens · \(activeDays) active days", "tokens · \(activeDays) 个活跃日", "tokens · \(activeDays) 個活躍日", "tokens · \(activeDays) アクティブ日", "tokens · 활동일 \(activeDays)일")
    }

    static var limitsName: String { t("Usage Limits", "使用限额", "使用限額", "使用上限", "사용 한도") }
    static var limitsDescription: String { t("Rate limits for Claude, Codex, Cursor, Gemini, and more.", "Claude、Codex、Cursor、Gemini 等工具的速率限额。", "Claude、Codex、Cursor、Gemini 等工具的速率限額。", "Claude、Codex、Cursor、Gemini などのレート上限。", "Claude, Codex, Cursor, Gemini 등의 사용 한도.") }
    static var noConfiguredProviders: String { t("No configured providers", "暂无已配置提供方", "暫無已配置提供方", "設定済みのプロバイダーがありません", "구성된 제공자가 없습니다") }

    static var topModelsName: String { t("Top Models", "热门模型", "熱門模型", "トップモデル", "인기 모델") }
    static var topModelsDescription: String { t("Models with the highest token usage.", "Token 用量最高的模型。", "Token 用量最高的模型。", "トークン使用量が最も多いモデル。", "토큰 사용량이 가장 많은 모델.") }
    static var noModelUsage: String { t("No model usage yet", "暂无模型使用数据", "暫無模型使用資料", "まだモデル使用データがありません", "아직 모델 사용 데이터가 없습니다") }

    static func updated(_ relative: String) -> String {
        t("Updated \(relative)", "更新于 \(relative)", "更新於 \(relative)", "更新：\(relative)", "업데이트: \(relative)")
    }

    static var justNow: String { t("just now", "刚刚", "剛剛", "たった今", "방금") }
    static func minutesAgo(_ minutes: Int) -> String { t("\(minutes)m ago", "\(minutes) 分钟前", "\(minutes) 分鐘前", "\(minutes)分前", "\(minutes)분 전") }
    static func hoursAgo(_ hours: Int) -> String { t("\(hours)h ago", "\(hours) 小时前", "\(hours) 小時前", "\(hours)時間前", "\(hours)시간 전") }
    static func daysAgo(_ days: Int) -> String { t("\(days)d ago", "\(days) 天前", "\(days) 天前", "\(days)日前", "\(days)일 전") }
    static func resetInMinutes(_ minutes: Int) -> String { t("in \(minutes)m", "\(minutes) 分钟后", "\(minutes) 分鐘後", "\(minutes)分後", "\(minutes)분 후") }
    static func resetInHours(_ hours: Int, minutes: Int) -> String {
        if minutes > 0 {
            return t("in \(hours)h \(minutes)m", "\(hours) 小时 \(minutes) 分钟后", "\(hours) 小時 \(minutes) 分鐘後", "\(hours)時間\(minutes)分後", "\(hours)시간 \(minutes)분 후")
        }
        return t("in \(hours)h", "\(hours) 小时后", "\(hours) 小時後", "\(hours)時間後", "\(hours)시간 후")
    }
    static func resetInDays(_ days: Int) -> String { t("in \(days)d", "\(days) 天后", "\(days) 天後", "\(days)日後", "\(days)일 후") }

    private static func limitKind(_ label: String) -> String {
        let parts = label.components(separatedBy: "·")
        return (parts.last ?? label).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Formats the localized display label for a widget rate-limit bar.
    static func limitLabel(_ limit: LimitProvider) -> String {
        let label = limit.label
        let kind = limitKind(limit.label)
        let source = limit.source == "antigravity"
            ? (label.components(separatedBy: "·").first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? limit.source.capitalized)
            : limit.source.capitalized
        switch loc {
        case NativeLocalization.chineseLocale:
            switch kind {
            case "Spark 5h": return "\(source) · Spark 5小时"
            case "Spark 7d": return "\(source) · Spark 7天"
            case "5h": return "\(source) · 5小时"
            case "7d Opus": return "\(source) · 7天 Opus"
            case "7d", "weekly": return "\(source) · 7天"
            case "Cursor": return "Cursor · 套餐"
            default: return label
            }
        case NativeLocalization.traditionalChineseLocale:
            switch kind {
            case "Spark 5h": return "\(source) · Spark 5小時"
            case "Spark 7d": return "\(source) · Spark 7天"
            case "5h": return "\(source) · 5小時"
            case "7d Opus": return "\(source) · 7天 Opus"
            case "7d", "weekly": return "\(source) · 7天"
            case "Cursor": return "Cursor · 套餐"
            default: return label
            }
        case NativeLocalization.japaneseLocale:
            switch kind {
            case "Spark 5h": return "\(source) · Spark 5時間"
            case "Spark 7d": return "\(source) · Spark 7日"
            case "5h": return "\(source) · 5時間"
            case "7d Opus": return "\(source) · 7日 Opus"
            case "7d", "weekly": return "\(source) · 7日"
            case "Cursor": return "Cursor · プラン"
            default: return label
            }
        case NativeLocalization.koreanLocale:
            switch kind {
            case "Spark 5h": return "\(source) · Spark 5시간"
            case "Spark 7d": return "\(source) · Spark 7일"
            case "5h": return "\(source) · 5시간"
            case "7d Opus": return "\(source) · 7일 Opus"
            case "7d", "weekly": return "\(source) · 7일"
            case "Cursor": return "Cursor · 플랜"
            default: return label
            }
        default:
            return label
        }
    }
}
