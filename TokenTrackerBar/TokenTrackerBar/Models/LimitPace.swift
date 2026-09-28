import Foundation

/// Time-aware pace math for usage-limit windows.
///
/// "Pace" answers a question a flat percentage cannot: *by this point in the
/// window, how much should already be used if consumption were perfectly even?*
/// Comparing actual usage against that even-burn expectation tells the user
/// whether they are burning too fast (over pace) or have headroom (under pace).
///
/// This is pure math so it can be unit-tested without any UI or clock.
enum LimitPace {

    /// Fraction (0...1) of the window that has elapsed, derived from the nominal
    /// window length and how long remains until it resets. Returns `nil` when the
    /// inputs cannot yield a meaningful value.
    static func expectedUsedFraction(windowSeconds: Double, secondsUntilReset: Double) -> Double? {
        guard windowSeconds > 0 else { return nil }
        let elapsed = windowSeconds - secondsUntilReset
        let fraction = elapsed / windowSeconds
        guard fraction.isFinite else { return nil }
        return min(max(fraction, 0), 1)
    }

    /// True when actual usage is meaningfully ahead of the even-burn pace.
    /// `tolerance` (in fraction units, default 3 percentage points) keeps the
    /// signal from flapping right at the line.
    static func isOverPace(usedFraction: Double, expectedFraction: Double, tolerance: Double = 0.03) -> Bool {
        usedFraction > expectedFraction + tolerance
    }

    /// Everything a row needs to draw + explain its pace. Single source of truth,
    /// mirroring the dashboard's `computePace` in `limit-pace.js`.
    struct Result {
        var pacePercent: Double?   // display-space marker position (0…100), nil = no mark
        var paceOver = false       // ahead of pace (deficit) → red, else green
        var expectedPercent: Int?  // even-burn % by now
        var runsOutEta: String?    // "~3h" when projected to exhaust before reset
        var projectedEnd: Int?     // projected % by reset when it won't run out
    }

    /// Compute the pace mark + current-rate projection for one window.
    /// The mark is shown once usage is nonzero; an unused window has no mark.
    /// Projection uses rate = used / elapsed.
    static func compute(usedFraction: Double, windowSeconds: Double, secondsUntilReset: Double, remainingMode: Bool) -> Result {
        var result = Result()
        guard windowSeconds > 0,
              let expected = expectedUsedFraction(windowSeconds: windowSeconds, secondsUntilReset: secondsUntilReset) else {
            return result
        }
        result.expectedPercent = Int((expected * 100).rounded())
        result.paceOver = isOverPace(usedFraction: usedFraction, expectedFraction: expected)
        if usedFraction > 0 {
            result.pacePercent = (remainingMode ? (1 - expected) : expected) * 100
        }
        if expected > 0.02, usedFraction > 0 {
            let elapsedSeconds = windowSeconds * expected
            let ratePerSecond = usedFraction / elapsedSeconds
            let projectedAtReset = usedFraction / expected
            if projectedAtReset >= 1, ratePerSecond > 0 {
                result.runsOutEta = durationString((1 - usedFraction) / ratePerSecond)
            } else {
                result.projectedEnd = Int((min(projectedAtReset, 1) * 100).rounded())
            }
        }
        return result
    }

    /// Compact "2d" / "3h" / "45m" duration label.
    static func durationString(_ seconds: TimeInterval) -> String {
        let s = Int(max(0, seconds))
        let h = s / 3600
        if h > 24 { return "\(h / 24)d" }
        if h > 0 { return "\(h)h" }
        return "\(s / 60)m"
    }
}
