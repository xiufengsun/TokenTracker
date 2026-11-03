import XCTest

final class LoginLaunchPresentationPolicyTests: XCTestCase {
    func testFinderOrDockLaunchOpensDashboard() {
        XCTAssertTrue(
            LoginLaunchPresentationPolicy.shouldOpenDashboardOnLaunch(
                launchAppleEventPresent: true,
                launchedAsLoginItem: false,
                loginItemRegistered: false
            )
        )
        XCTAssertTrue(
            LoginLaunchPresentationPolicy.shouldOpenDashboardOnLaunch(
                launchAppleEventPresent: true,
                launchedAsLoginItem: false,
                loginItemRegistered: true
            )
        )
    }

    func testLegacyLoginItemAttributeStaysQuiet() {
        XCTAssertFalse(
            LoginLaunchPresentationPolicy.shouldOpenDashboardOnLaunch(
                launchAppleEventPresent: true,
                launchedAsLoginItem: true,
                loginItemRegistered: true
            )
        )
    }

    func testSMAppServiceLoginWithNoAppleEventStaysQuiet() {
        XCTAssertFalse(
            LoginLaunchPresentationPolicy.shouldOpenDashboardOnLaunch(
                launchAppleEventPresent: false,
                launchedAsLoginItem: false,
                loginItemRegistered: true
            )
        )
    }

    func testDirectLaunchWithNoAppleEventStillOpensDashboard() {
        XCTAssertTrue(
            LoginLaunchPresentationPolicy.shouldOpenDashboardOnLaunch(
                launchAppleEventPresent: false,
                launchedAsLoginItem: false,
                loginItemRegistered: false
            )
        )
    }
}
