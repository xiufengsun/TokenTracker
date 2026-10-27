import XCTest

/// ZCode menu-bar parity (#888): `reset_credits` / `start_plan` must decode so the
/// popover can mirror the dashboard Limits card instead of silently dropping them.
final class ZcodeLimitsParityTests: XCTestCase {
    func testDecodesResetCreditsAndStartPlan() throws {
        let json = """
        {
          "fetched_at": "2030-10-27T12:00:00.000Z",
          "claude": { "configured": false, "error": null },
          "codex": { "configured": false, "error": null },
          "cursor": { "configured": false, "error": null },
          "gemini": { "configured": false, "error": null },
          "kiro": { "configured": false, "error": null },
          "antigravity": { "configured": false, "error": null },
          "zcode": {
            "configured": true,
            "error": null,
            "plan_label": "Pro",
            "plan_kind": "coding-plan",
            "primary_window": { "used_percent": 2, "reset_at": "2030-10-28T03:12:00.000Z" },
            "secondary_window": { "used_percent": 10, "reset_at": "2030-11-01T00:00:00.000Z" },
            "reset_credits": {
              "five_hour": [
                { "expires_at": "2030-10-28T03:12:00.000Z" },
                { "expires_at": "2030-10-29T03:12:00.000Z" },
                { "expires_at": "2000-01-01T00:00:00.000Z" }
              ],
              "weekly": [
                { "expires_at": "2030-11-02T00:00:00.000Z" }
              ]
            },
            "start_plan": {
              "configured": true,
              "error": null,
              "plan_label": "Start",
              "buckets": [
                {
                  "label": "GLM-5.3-Flash · ZCODE GLOBAL BUILD",
                  "plan_name": "ZCODE GLOBAL BUILD",
                  "period": "one_time",
                  "entitlement_id": "grant-1",
                  "remaining_units": 156793254,
                  "total_units": 300000000,
                  "window": { "used_percent": 47.7, "reset_at": "2030-12-01T00:00:00.000Z" }
                }
              ]
            }
          }
        }
        """
        let response = try JSONDecoder().decode(UsageLimitsResponse.self, from: Data(json.utf8))
        let zcode = try XCTUnwrap(response.zcode)
        XCTAssertEqual(zcode.planKind, "coding-plan")
        let reset = try XCTUnwrap(zcode.resetCredits)
        XCTAssertEqual(reset.fiveHour?.count, 3)
        XCTAssertEqual(reset.weekly?.count, 1)
        let start = try XCTUnwrap(zcode.startPlan)
        XCTAssertTrue(start.configured)
        XCTAssertEqual(start.buckets?.count, 1)
        XCTAssertEqual(start.buckets?.first?.planName, "ZCODE GLOBAL BUILD")
        XCTAssertEqual(start.buckets?.first?.remainingUnits, 156793254)
        XCTAssertEqual(start.buckets?.first?.window?.usedPercent ?? -1, 47.7, accuracy: 0.01)
    }

    func testLegacyZcodePayloadWithoutNewFieldsStillDecodes() throws {
        let json = """
        {
          "fetched_at": "2030-10-27T12:00:00.000Z",
          "claude": { "configured": false, "error": null },
          "codex": { "configured": false, "error": null },
          "cursor": { "configured": false, "error": null },
          "gemini": { "configured": false, "error": null },
          "kiro": { "configured": false, "error": null },
          "antigravity": { "configured": false, "error": null },
          "zcode": {
            "configured": true,
            "error": null,
            "plan_label": "Pro",
            "plan_kind": "coding-plan",
            "primary_window": { "used_percent": 2 }
          }
        }
        """
        let response = try JSONDecoder().decode(UsageLimitsResponse.self, from: Data(json.utf8))
        let zcode = try XCTUnwrap(response.zcode)
        XCTAssertNil(zcode.resetCredits)
        XCTAssertNil(zcode.startPlan)
        XCTAssertEqual(zcode.primaryWindow?.usedPercent, 2)
    }
}
