import XCTest

final class LimitPaceTests: XCTestCase {

    func testExpectedFractionAtHalfElapsed() {
        // A 100s window with 50s remaining → half elapsed.
        let f = LimitPace.expectedUsedFraction(windowSeconds: 100, secondsUntilReset: 50)
        XCTAssertEqual(f ?? -1, 0.5, accuracy: 0.0001)
    }

    func testExpectedFractionClampsToRange() {
        // No time remaining → fully elapsed (1.0).
        XCTAssertEqual(LimitPace.expectedUsedFraction(windowSeconds: 100, secondsUntilReset: 0) ?? -1, 1.0, accuracy: 0.0001)
        // More remaining than the window length (clock skew) → clamps to 0.
        XCTAssertEqual(LimitPace.expectedUsedFraction(windowSeconds: 100, secondsUntilReset: 200) ?? -1, 0.0, accuracy: 0.0001)
    }

    func testInvalidWindowReturnsNil() {
        XCTAssertNil(LimitPace.expectedUsedFraction(windowSeconds: 0, secondsUntilReset: 10))
        XCTAssertNil(LimitPace.expectedUsedFraction(windowSeconds: -5, secondsUntilReset: 10))
    }

    func testOverPaceRespectsTolerance() {
        // 60% used at 50% expected, default 3% tolerance → over pace.
        XCTAssertTrue(LimitPace.isOverPace(usedFraction: 0.60, expectedFraction: 0.50))
        // Just 2% ahead → within tolerance, not flagged.
        XCTAssertFalse(LimitPace.isOverPace(usedFraction: 0.52, expectedFraction: 0.50))
        // Behind pace → never flagged.
        XCTAssertFalse(LimitPace.isOverPace(usedFraction: 0.30, expectedFraction: 0.50))
    }

    func testExpiredWindowsHaveNoPaceOrProjection() {
        for remainingMode in [false, true] {
            for secondsUntilReset in [0.0, -1.0] {
                let pace = LimitPace.compute(
                    usedFraction: 0.42,
                    windowSeconds: 5 * 3600,
                    secondsUntilReset: secondsUntilReset,
                    remainingMode: remainingMode
                )
                XCTAssertNil(pace.pacePercent)
                XCTAssertFalse(pace.paceOver)
                XCTAssertNil(pace.expectedPercent)
                XCTAssertNil(pace.runsOutEta)
                XCTAssertNil(pace.projectedEnd)
            }
        }
    }

    func testActiveLowUsageKeepsUsedAndRemainingMarkers() {
        for remainingMode in [false, true] {
            let pace = LimitPace.compute(
                usedFraction: 0.03,
                windowSeconds: 100,
                secondsUntilReset: 60,
                remainingMode: remainingMode
            )
            XCTAssertEqual(pace.pacePercent ?? -1, remainingMode ? 60 : 40, accuracy: 0.0001)
            XCTAssertEqual(pace.expectedPercent, 40)
            XCTAssertFalse(pace.paceOver)
            XCTAssertNil(pace.runsOutEta)
            XCTAssertNotNil(pace.projectedEnd)
        }
    }

    func testNearlyExpiredWindowStillHasAMarker() {
        let pace = LimitPace.compute(
            usedFraction: 0.03,
            windowSeconds: 100,
            secondsUntilReset: 0.001,
            remainingMode: false
        )
        XCTAssertNotNil(pace.pacePercent)
    }

    func testUnusedActiveWindowHasNoMarkerOrProjection() {
        let pace = LimitPace.compute(
            usedFraction: 0,
            windowSeconds: 100,
            secondsUntilReset: 60,
            remainingMode: false
        )
        XCTAssertNil(pace.pacePercent)
        XCTAssertNil(pace.runsOutEta)
        XCTAssertNil(pace.projectedEnd)
        XCTAssertEqual(pace.expectedPercent, 40)
    }
}
