import XCTest

final class ServerLaunchConfigTests: XCTestCase {

    func testBuildArgumentsIncludesOptimizeForSizeAndPort() {
        let args = ServerLaunchConfig.buildArguments(entryPath: "/path/to/bin/tracker.js", port: 7680)
        XCTAssertEqual(args, [
            "--optimize-for-size",
            "--expose-gc",
            "/path/to/bin/tracker.js",
            "serve",
            "--port",
            "7680",
            "--no-sync",
            "--no-open"
        ])
    }

    func testMergeNodeOptionsWithNilOrEmpty() {
        XCTAssertEqual(ServerLaunchConfig.mergeNodeOptions(existing: nil), "--max-old-space-size=48")
        XCTAssertEqual(ServerLaunchConfig.mergeNodeOptions(existing: ""), "--max-old-space-size=48")
        XCTAssertEqual(ServerLaunchConfig.mergeNodeOptions(existing: "   "), "--max-old-space-size=48")
    }

    func testMergeNodeOptionsWithExistingFlags() {
        let merged = ServerLaunchConfig.mergeNodeOptions(existing: "--trace-warnings")
        XCTAssertEqual(merged, "--trace-warnings --max-old-space-size=48")
    }

    func testMergeNodeOptionsPreservesUserOldSpaceSize() {
        let merged = ServerLaunchConfig.mergeNodeOptions(existing: "--max-old-space-size=128 --trace-warnings")
        XCTAssertEqual(merged, "--max-old-space-size=128 --trace-warnings")
    }
}
