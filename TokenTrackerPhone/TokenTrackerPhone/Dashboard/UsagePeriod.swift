import Foundation

/// Same ranges as `DateHelpers.rangeForPeriod` in the macOS app.
enum UsagePeriod: String, CaseIterable, Identifiable {
    case day, week, month, total
    var id: String { rawValue }

    var label: String {
        switch self {
        case .day: return "Today"
        case .week: return "Week"
        case .month: return "Month"
        case .total: return "Total"
        }
    }

    func range(now: Date = Date(), calendar: Calendar = .localGregorian) -> (from: String, to: String) {
        let today = DayFormat.string(now, calendar: calendar)
        switch self {
        case .day:
            return (today, today)
        case .week:
            // Monday-start week
            let weekday = calendar.component(.weekday, from: now)
            let daysFromMonday = (weekday + 5) % 7
            let monday = calendar.date(byAdding: .day, value: -daysFromMonday, to: now) ?? now
            let sunday = calendar.date(byAdding: .day, value: 6, to: monday) ?? now
            return (DayFormat.string(monday, calendar: calendar), DayFormat.string(sunday, calendar: calendar))
        case .month:
            guard let start = calendar.date(from: calendar.dateComponents([.year, .month], from: now)),
                  let next = calendar.date(byAdding: .month, value: 1, to: start),
                  let end = calendar.date(byAdding: .day, value: -1, to: next) else { return (today, today) }
            return (DayFormat.string(start, calendar: calendar), DayFormat.string(end, calendar: calendar))
        case .total:
            // Cloud keeps 24 months of daily summaries.
            let back = calendar.date(byAdding: .month, value: -24, to: now) ?? now
            let start = calendar.date(from: calendar.dateComponents([.year, .month], from: back)) ?? back
            return (DayFormat.string(start, calendar: calendar), today)
        }
    }
}

enum DayFormat {
    static func string(_ date: Date, calendar: Calendar = .localGregorian) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    static func date(_ day: String, calendar: Calendar = .localGregorian) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: day)
    }

    static func daysAgo(_ n: Int, now: Date = Date(), calendar: Calendar = .localGregorian) -> String {
        string(calendar.date(byAdding: .day, value: -n, to: now) ?? now, calendar: calendar)
    }
}

extension Calendar {
    static var localGregorian: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }
}
