import XCTest
import WebKit

private final class MockScriptMessageHandler: NSObject, WKScriptMessageHandler {
    var receivedMessages: [WKScriptMessage] = []

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        receivedMessages.append(message)
    }
}

final class DashboardLifecycleTests: XCTestCase {

    func testWeakScriptMessageHandlerDoesNotRetainTarget() {
        var mock: MockScriptMessageHandler? = MockScriptMessageHandler()
        let weakHandler = WeakScriptMessageHandler(mock!)

        XCTAssertNotNil(weakHandler.handler)
        mock = nil
        XCTAssertNil(weakHandler.handler)
    }

    func testUserContentControllerLifecycleAddAndRemove() {
        let contentController = WKUserContentController()
        let mock = MockScriptMessageHandler()
        let weakOAuth = WeakScriptMessageHandler(mock)
        let weakBridge = WeakScriptMessageHandler(mock)

        contentController.add(weakOAuth, name: "nativeOAuth")
        contentController.add(weakBridge, name: "nativeBridge")

        // Removing handlers on window close
        contentController.removeScriptMessageHandler(forName: "nativeOAuth")
        contentController.removeScriptMessageHandler(forName: "nativeBridge")

        // Re-creating fresh controller on reopen does not conflict
        let freshController = WKUserContentController()
        let newMock = MockScriptMessageHandler()
        freshController.add(WeakScriptMessageHandler(newMock), name: "nativeOAuth")
        freshController.add(WeakScriptMessageHandler(newMock), name: "nativeBridge")
        freshController.removeScriptMessageHandler(forName: "nativeOAuth")
        freshController.removeScriptMessageHandler(forName: "nativeBridge")
    }

    func testDashboardPresentationPolicyReopenCycle() {
        var policy = DashboardPresentationPolicy()

        // Initial presentation
        let openCommands = policy.presentDashboard()
        XCTAssertEqual(openCommands, [.useRegularActivationPolicy, .showDashboardWindow])
        XCTAssertEqual(policy.state, .dashboard)

        // Window closes
        let closeCommands = policy.prepareToCloseDashboard()
        XCTAssertEqual(closeCommands, [.useAccessoryActivationPolicy])
        XCTAssertEqual(policy.state, .dashboardClosing)

        let completedCommands = policy.completeDashboardClose()
        XCTAssertTrue(completedCommands.isEmpty)
        XCTAssertEqual(policy.state, .menuBar)

        // Second open
        let reopenCommands = policy.presentDashboard()
        XCTAssertEqual(reopenCommands, [.useRegularActivationPolicy, .showDashboardWindow])
        XCTAssertEqual(policy.state, .dashboard)
    }

    func testDashboardPresentationPolicyRapidReopenWhileClosing() {
        var policy = DashboardPresentationPolicy()

        _ = policy.presentDashboard()
        _ = policy.prepareToCloseDashboard()
        XCTAssertEqual(policy.state, .dashboardClosing)

        // User clicks open dashboard while closing animation is in flight
        let interCommands = policy.presentDashboard()
        XCTAssertEqual(interCommands, [.useRegularActivationPolicy])
        XCTAssertEqual(policy.state, .dashboardClosing)

        // When close completes, it automatically reopens
        let resumeCommands = policy.completeDashboardClose()
        XCTAssertEqual(resumeCommands, [.useRegularActivationPolicy, .showDashboardWindow])
        XCTAssertEqual(policy.state, .dashboard)
    }
}
