import XCTest

final class CloudUsageExportTests: XCTestCase {
    private let filename = "tokentracker-cloud-usage-2026-10-10.csv"
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("tokentracker-cloud-export-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }

    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }

    private func message(filename: String? = nil, format: String = "csv", content: String = "date,tokens\n2026-10-10,4\n") -> [String: Any] {
        ["type": "saveCloudUsageExport", "requestId": UUID().uuidString, "filename": filename ?? self.filename,
         "format": format, "content": content]
    }

    func testActualUTF8BytesAndPrivatePermissions() throws {
        let export = try CloudUsageExport(message: message(content: "date,tokens\n合成,4\n"))
        let saved = try export.save(in: directory)
        XCTAssertEqual(saved, filename)
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent(saved)), export.bytes)
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent(saved).path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testCollisionDoesNotOverwriteAnExistingFile() throws {
        let existing = directory.appendingPathComponent(filename)
        try Data("keep".utf8).write(to: existing)
        let saved = try CloudUsageExport(message: message()).save(in: directory)
        XCTAssertEqual(saved, "tokentracker-cloud-usage-2026-10-10-1.csv")
        XCTAssertEqual(try String(contentsOf: existing, encoding: .utf8), "keep")
    }

    func testSymlinkDoesNotWriteThroughToItsTarget() throws {
        let outside = directory.appendingPathComponent("retained.txt")
        try Data("keep".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent(filename), withDestinationURL: outside)
        XCTAssertNotEqual(try CloudUsageExport(message: message()).save(in: directory), filename)
        XCTAssertEqual(try String(contentsOf: outside, encoding: .utf8), "keep")
    }

    func testInvalidFilenamesAndExtensionsHaveNoFilesystemEffect() throws {
        for name in ["../" + filename, "/" + filename, "tokentracker-cloud-a\\b.csv", "tokentracker-cloud-a.csv\n",
                     "other.csv", "tokentracker-cloud-a.exe", "tokentracker-cloud-a.json"] {
            XCTAssertThrowsError(try CloudUsageExport(message: message(filename: name)))
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 0)
    }

    func testByteLimitIncludesMultibyteUTF8AndRejectsNUL() throws {
        XCTAssertThrowsError(try CloudUsageExport(message: message(content: String(repeating: "字", count: CloudUsageExport.maximumBytes / 3 + 1))))
        XCTAssertThrowsError(try CloudUsageExport(message: message(content: "a\0b")))
        XCTAssertNoThrow(try CloudUsageExport(message: message(content: String(repeating: "a", count: CloudUsageExport.maximumBytes))))
    }

    func testOnlyObjectJSONAndKnownFieldsAreAccepted() throws {
        XCTAssertNoThrow(try CloudUsageExport(message: message(filename: "tokentracker-cloud-usage.json", format: "json", content: "{\"synthetic\":true}")))
        for value in ["[]", "broken", "null"] {
            XCTAssertThrowsError(try CloudUsageExport(message: message(filename: "tokentracker-cloud-usage.json", format: "json", content: value)))
        }
        var request = message(); request["directory"] = "/tmp"
        XCTAssertThrowsError(try CloudUsageExport(message: request))
    }

    func testMissingDirectoryReportsFailure() throws {
        XCTAssertThrowsError(try CloudUsageExport(message: message()).save(in: directory.appendingPathComponent("missing")))
    }

    func testSourceRequiresTheCurrentMainWebViewAndExactManagedOrigin() {
        let expected = URL(string: "http://127.0.0.1:51956")!
        let current = URL(string: "http://127.0.0.1:51956/dashboard")!
        XCTAssertTrue(CloudUsageExport.permitsSource(current, current: current, expected: expected, mainFrame: true, ownWebView: true))
        XCTAssertFalse(CloudUsageExport.permitsSource(current, current: current, expected: expected, mainFrame: false, ownWebView: true))
        XCTAssertFalse(CloudUsageExport.permitsSource(current, current: current, expected: expected, mainFrame: true, ownWebView: false))
        for url in ["http://127.0.0.1:7680", "http://localhost:51956", "https://127.0.0.1:51956", "http://user@127.0.0.1:51956", "https://hosted.example"] {
            XCTAssertFalse(CloudUsageExport.permitsSource(URL(string: url), current: current, expected: expected, mainFrame: true, ownWebView: true))
            XCTAssertFalse(CloudUsageExport.permitsSource(current, current: URL(string: url), expected: expected, mainFrame: true, ownWebView: true))
        }
    }
}
