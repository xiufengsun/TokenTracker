import Foundation
import Darwin

/// A bounded metadata export, with no caller-selected directory or overwrite mode.
struct CloudUsageExport {
    enum Failure: String, Error { case invalidExport = "invalid_export", saveFailed = "save_failed" }
    static let maximumBytes = 5 * 1024 * 1024
    let requestID: String
    let filename: String
    let format: String
    let bytes: Data

    init(message: [String: Any]) throws {
        guard Set(message.keys) == ["type", "requestId", "filename", "format", "content"],
              message["type"] as? String == "saveCloudUsageExport",
              let requestID = message["requestId"] as? String, UUID(uuidString: requestID) != nil,
              let filename = message["filename"] as? String,
              filename.range(of: "^tokentracker-cloud-[A-Za-z0-9][A-Za-z0-9_-]{0,150}\\.(csv|json)$", options: .regularExpression) != nil,
              let format = message["format"] as? String, ["csv", "json"].contains(format),
              filename.hasSuffix("." + format),
              let content = message["content"] as? String, !content.isEmpty, !content.contains("\0"),
              content.utf8.count <= Self.maximumBytes else {
            throw Failure.invalidExport
        }
        let bytes = Data(content.utf8)
        if format == "json" {
            guard (try? JSONSerialization.jsonObject(with: bytes)) is [String: Any] else { throw Failure.invalidExport }
        }
        self.requestID = requestID
        self.filename = filename
        self.format = format
        self.bytes = bytes
    }

    static func permitsSource(_ source: URL?, current: URL?, expected: URL, mainFrame: Bool, ownWebView: Bool) -> Bool {
        guard mainFrame, ownWebView else { return false }
        return [source, current].allSatisfy { candidate in
            guard let url = candidate else { return false }
            return url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "") &&
                url.host == expected.host && url.port == expected.port && expected.scheme == "http" &&
                url.user == nil && url.password == nil
        }
    }

    func save(in directory: URL) throws -> String {
        let stem = String(filename.dropLast(format.count + 1))
        for suffix in 0..<1000 {
            let name = suffix == 0 ? filename : "\(stem)-\(suffix).\(format)"
            let target = directory.appendingPathComponent(name)
            let descriptor = open(target.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            if descriptor < 0 {
                if errno == EEXIST { continue }
                throw Failure.saveFailed
            }
            var succeeded = false
            defer {
                close(descriptor)
                if !succeeded { try? FileManager.default.removeItem(at: target) }
            }
            let written = bytes.withUnsafeBytes { buffer -> Bool in
                guard let address = buffer.baseAddress else { return false }
                var offset = 0
                while offset < buffer.count {
                    let count = Darwin.write(descriptor, address.advanced(by: offset), buffer.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { return false }
                    offset += count
                }
                return fsync(descriptor) == 0
            }
            guard written else { throw Failure.saveFailed }
            succeeded = true
            return name
        }
        throw Failure.saveFailed
    }
}
