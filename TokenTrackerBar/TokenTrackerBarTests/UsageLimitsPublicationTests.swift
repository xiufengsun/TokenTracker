import XCTest

/// Exercises the production publication seam — `UsageLimitsPublicationAuthority`
/// plus `displayRecord`/`applyingDevinSelection`, the same functions
/// `DashboardViewModel.refreshUsageLimits` calls — across completion orderings:
/// a late response issued under a superseded Devin selection must never
/// publish, cache or reschedule.
final class UsageLimitsPublicationTests: XCTestCase {

    /// A refresh issued while Devin was off must not overwrite the newer
    /// enabled publication when it lands late.
    func testLateOffResponseCannotOverwriteNewerOnPublication() throws {
        var authority = UsageLimitsPublicationAuthority()
        var published: UsageLimitsResponse? = nil

        let offTicket = authority.beginRequest()
        authority.invalidateForSelectionChange() // user turned Devin on
        let onTicket = authority.beginRequest()

        // The enabled refresh resolves first.
        let onResponse = try decodeResponse(overrides: [
            "devin": ["configured": true, "primary_window": ["used_percent": 40]],
        ])
        published = authority.publish(
            ticket: onTicket,
            incoming: onResponse,
            devinSelected: true,
            current: published
        )
        XCTAssertEqual(published?.devin?.configured, true)

        // The older off-selection response lands late — it carries another
        // usable provider but unconfigured Devin, and must be dropped whole.
        let lateOffResponse = try decodeResponse(overrides: [
            "kimi": ["configured": true, "primary_window": ["used_percent": 55]],
        ])
        XCTAssertNil(authority.publish(
            ticket: offTicket,
            incoming: lateOffResponse,
            devinSelected: true,
            current: published
        ))
        XCTAssertEqual(published?.devin?.configured, true)
    }

    /// The mirror race: a refresh issued while Devin was on must not restore
    /// Devin rows after the user turned the switch off.
    func testLateOnResponseCannotRepublishAfterDisable() throws {
        var authority = UsageLimitsPublicationAuthority()
        var published: UsageLimitsResponse? = nil

        let onTicket = authority.beginRequest()
        authority.invalidateForSelectionChange() // user turned Devin off
        let offTicket = authority.beginRequest()

        // Disable strips retained rows immediately; the off refresh publishes.
        let offResponse = try decodeResponse(overrides: [
            "kimi": ["configured": true, "primary_window": ["used_percent": 55]],
        ])
        published = authority.publish(
            ticket: offTicket,
            incoming: offResponse,
            devinSelected: false,
            current: published
        )
        XCTAssertNil(published?.devin?.primaryWindow)

        // The superseded enabled response lands late and is rejected whole —
        // its Devin rows never reach display or cache.
        let staleOnResponse = try decodeResponse(overrides: [
            "devin": ["configured": true, "primary_window": ["used_percent": 40]],
        ])
        XCTAssertNil(authority.publish(
            ticket: onTicket,
            incoming: staleOnResponse,
            devinSelected: false,
            current: published
        ))
        XCTAssertEqual(published, offResponse)
    }

    /// on→off→on: a boolean comparison would let the middle request pass
    /// because the selection matches again; only the newest ticket may publish.
    func testOnOffOnCycleDropsEverySupersededCompletion() throws {
        var authority = UsageLimitsPublicationAuthority()
        var published: UsageLimitsResponse? = nil

        let first = authority.beginRequest()     // issued while on
        authority.invalidateForSelectionChange() // off
        let middle = authority.beginRequest()    // off refresh
        authority.invalidateForSelectionChange() // on again
        let latest = authority.beginRequest()    // on refresh

        // Middle completion lands first and is superseded.
        XCTAssertNil(authority.publish(
            ticket: middle,
            incoming: try decodeResponse(),
            devinSelected: true,
            current: published
        ))

        // The newest refresh publishes.
        let latestResponse = try decodeResponse(overrides: [
            "devin": ["configured": true, "secondary_window": ["used_percent": 72]],
        ])
        published = authority.publish(
            ticket: latest,
            incoming: latestResponse,
            devinSelected: true,
            current: published
        )
        XCTAssertEqual(published?.devin?.secondaryWindow?.usedPercent, 72)

        // The original request arrives last — still superseded.
        XCTAssertNil(authority.publish(
            ticket: first,
            incoming: try decodeResponse(),
            devinSelected: true,
            current: published
        ))
        XCTAssertEqual(published, latestResponse)
    }

    /// Two refreshes under the same selection: the earlier completion must not
    /// overwrite the later one (latest-wins for identical selections).
    func testOverlappingSameSelectionRefreshesPublishOnlyTheNewest() throws {
        var authority = UsageLimitsPublicationAuthority()
        var published: UsageLimitsResponse? = nil

        let older = authority.beginRequest()
        let newer = authority.beginRequest()

        XCTAssertNil(authority.publish(
            ticket: older,
            incoming: try decodeResponse(overrides: [
                "kimi": ["configured": true, "primary_window": ["used_percent": 10]],
            ]),
            devinSelected: false,
            current: published
        ))

        let newest = try decodeResponse(overrides: [
            "kimi": ["configured": true, "primary_window": ["used_percent": 20]],
        ])
        published = authority.publish(
            ticket: newer,
            incoming: newest,
            devinSelected: false,
            current: published
        )
        XCTAssertEqual(published, newest)
    }

    /// A superseded ticket is dead the moment the selection flips — even when
    /// its replacement refresh has not begun yet.
    func testSelectionChangeInvalidatesBeforeReplacementBegins() throws {
        var authority = UsageLimitsPublicationAuthority()

        let inFlight = authority.beginRequest()
        authority.invalidateForSelectionChange()

        XCTAssertNil(authority.publish(
            ticket: inFlight,
            incoming: try decodeResponse(overrides: [
                "devin": ["configured": true, "primary_window": ["used_percent": 40]],
            ]),
            devinSelected: false,
            current: nil
        ))
    }

    /// Retention is preserved through the seam: an all-error incoming response
    /// for the CURRENT ticket still yields the last good record, and a stale
    /// ticket can never smuggle one in.
    func testAllErrorIncomingRetainsTheGoodCurrentRecord() throws {
        var authority = UsageLimitsPublicationAuthority()
        let good = try decodeResponse(overrides: [
            "kimi": ["configured": true, "primary_window": ["used_percent": 30]],
        ])

        let ticket = authority.beginRequest()
        let allError = try decodeResponse(overrides: [
            "claude": ["configured": true, "error": "boom"],
            "kimi": ["configured": true, "error": "boom"],
        ])

        XCTAssertEqual(
            authority.publish(
                ticket: ticket,
                incoming: allError,
                devinSelected: false,
                current: good
            ),
            good
        )
    }

    func testDisabledDevinCannotDisplaceAnotherProvidersGoodRecord() throws {
        var authority = UsageLimitsPublicationAuthority()
        let current = try decodeResponse(overrides: [
            "kimi": ["configured": true, "primary_window": ["used_percent": 30]],
        ])
        let incoming = try decodeResponse(overrides: [
            "devin": ["configured": true, "primary_window": ["used_percent": 40]],
            "kimi": ["configured": true, "error": "offline"],
        ])
        let ticket = authority.beginRequest()
        let result = authority.publish(ticket: ticket, incoming: incoming,
                                       devinSelected: false, current: current)
        XCTAssertEqual(result?.kimi, current.kimi)
        XCTAssertNil(result?.devin?.primaryWindow)
    }

    func testDisablingOnlyGoodProviderRemovesItsPersistedQuota() throws {
        let suite = "DevinCacheTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let response = try decodeResponse(overrides: [
            "devin": ["configured": true, "primary_window": ["used_percent": 40]],
        ])
        UsageLimitsCache.save(response, defaults: defaults)
        XCTAssertNotNil(UsageLimitsCache.load(defaults: defaults)?.devin?.primaryWindow)
        UsageLimitsCache.save(response, defaults: defaults, devinSelected: false)
        XCTAssertNil(UsageLimitsCache.load(defaults: defaults)?.devin?.primaryWindow)
    }

    // MARK: - Fixtures

    /// The Node API publishes the Qoder add-on pack as `tertiary_window`; the
    /// popover can only mirror the dashboard's add-on row if that key decodes,
    /// and the last-good cache must round-trip it through JSONEncoder.
    func testQoderAddOnWindowDecodesAndRoundTrips() throws {
        let withAddOn = try decodeResponse(overrides: [
            "qoder": [
                "configured": true,
                "error": NSNull(),
                "primary_window": ["used_percent": 0, "used_credits": 0, "limit_credits": 0, "remaining_credits": 0],
                "tertiary_window": ["used_percent": 6, "used_credits": 67, "limit_credits": 1100, "remaining_credits": 1033],
            ],
        ])
        XCTAssertEqual(withAddOn.qoder?.tertiaryWindow?.limitCredits, 1100)
        XCTAssertEqual(withAddOn.qoder?.tertiaryWindow?.remainingCredits, 1033)

        // Payloads from older builds carry no add-on key at all.
        let withoutAddOn = try decodeResponse(overrides: [
            "qoder": ["configured": true, "error": NSNull()],
        ])
        XCTAssertNil(withoutAddOn.qoder?.tertiaryWindow)
        XCTAssertNil(withoutAddOn.qoder?.secondaryWindow)

        let restored = try JSONDecoder().decode(
            UsageLimitsResponse.self,
            from: JSONEncoder().encode(withAddOn)
        )
        XCTAssertEqual(restored, withAddOn)
    }

    private func decodeResponse(overrides: [String: Any] = [:]) throws -> UsageLimitsResponse {
        var payload: [String: Any] = [
            "fetched_at": "2026-06-10T00:00:00Z",
            "claude": ["configured": false],
            "codex": ["configured": false],
            "cursor": ["configured": false],
            "gemini": ["configured": false],
            "kiro": ["configured": false],
            "antigravity": ["configured": false],
        ]
        for (key, value) in overrides { payload[key] = value }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(UsageLimitsResponse.self, from: data)
    }
}
