import XCTest

final class NativeBillingReturnTests: XCTestCase {
    private let order = "00112233-4455-4677-8899-aabbccddeeff"

    func testBillingReturnOnlyProvidesACanonicalOrderReference() {
        for value in [order, order.uppercased()] {
            let url = URL(string: "tokentracker://billing/return?order=" + value)!
            XCTAssertEqual(NativeBillingReturn.orderID(from: url), order)
        }
    }

    func testReturnCannotSelectAnAccountEnvironmentOrProviderUrl() {
        let base = "tokentracker://billing/return?order=" + order
        for suffix in ["&order=" + order, "&user=peer", "&environment=live", "&realm=tokentracker-native-sandbox-v1",
                       "&checkout=https://pancake.waffo.ai", "&status=paid", "#fragment"] {
            XCTAssertNil(NativeBillingReturn.orderID(from: URL(string: base + suffix)!))
        }
        for value in ["tokentracker-qa://billing/return?order=" + order,
                      "https://billing/return?order=" + order,
                      "tokentracker://user@billing/return?order=" + order,
                      "tokentracker://billing:80/return?order=" + order,
                      "tokentracker://billing/return/extra?order=" + order,
                      "tokentracker://auth/callback?insforge_code=fixture-only"] {
            XCTAssertNil(NativeBillingReturn.orderID(from: URL(string: value)!))
        }
    }

    func testOrderFormatMatchesTheFrontendUuidVersionAndVariantContract() {
        for value in ["00000000-0000-0000-0000-000000000000", order.replacingOccurrences(of: "4677", with: "6677"),
                      order.replacingOccurrences(of: "8899", with: "7899"), order.replacingOccurrences(of: "-", with: ""), "fixture"] {
            XCTAssertNil(NativeBillingReturn.canonicalOrderID(value))
        }
    }
}
