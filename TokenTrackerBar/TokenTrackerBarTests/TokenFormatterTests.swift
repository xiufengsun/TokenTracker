import XCTest

final class TokenFormatterTests: XCTestCase {

    // Same cases as dashboard/src/lib/token-format.test.js and format.test.ts so
    // the menu bar and the dashboard agree on every unit boundary.
    func testChineseUnitsMatchDashboard() {
        XCTAssertEqual(TokenFormatter.formatChinese(0), "0")
        XCTAssertEqual(TokenFormatter.formatChinese(9_999), "9999")
        XCTAssertEqual(TokenFormatter.formatChinese(10_000), "1万")
        XCTAssertEqual(TokenFormatter.formatChinese(12_345), "1.2万")
        XCTAssertEqual(TokenFormatter.formatChinese(123_456_789), "1.2亿")
        XCTAssertEqual(TokenFormatter.formatChinese(1_234_567_890_123), "1.2万亿")
        XCTAssertEqual(TokenFormatter.formatChinese(-12_345), "-1.2万")
    }

    func testChineseUnitsCarryWhenRoundingReachesTheNextUnit() {
        XCTAssertEqual(TokenFormatter.formatChinese(99_999_999), "1亿")
        XCTAssertEqual(TokenFormatter.formatChinese(999_999_999_999), "1万亿")
    }

    func testFormatCompactFollowsThePushedUnitSystem() {
        XCTAssertEqual(TokenFormatter.formatCompact(123_456_789, chineseUnits: true), "1.2亿")
        XCTAssertEqual(TokenFormatter.formatCompact(123_456_789, chineseUnits: false), "123.5M")
    }

    func testUnitSystemDefaultsToEnglishUntilTheDashboardPushesChinese() {
        let suite = "TokenFormatterTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertFalse(TokenFormatter.usesChineseUnits(defaults))
        defaults.set("chinese", forKey: TokenFormatter.unitSystemDefaultsKey)
        XCTAssertTrue(TokenFormatter.usesChineseUnits(defaults))
        defaults.set("english", forKey: TokenFormatter.unitSystemDefaultsKey)
        XCTAssertFalse(TokenFormatter.usesChineseUnits(defaults))
    }
}
