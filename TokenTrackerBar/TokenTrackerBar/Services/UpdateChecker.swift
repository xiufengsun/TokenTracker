import AppKit
import Foundation

@MainActor
final class UpdateChecker {

    static let shared = UpdateChecker()

    private let repo = "xiufengsun/TokenTracker"
    private let releaseURL: String = "https://github.com/xiufengsun/TokenTracker/releases/latest"

    /// Observable status for menu item display
    private(set) var statusText: String? = nil {
        didSet { postStatusDidChangeNotification() }
    }

    private(set) var isBusy = false {
        didSet { postStatusDidChangeNotification() }
    }

    /// Retain delegate until download completes (URLSession holds weak ref only)
    private var activeDownloadDelegate: ResumableDownloader?

    /// Native progress panel, present only during user-initiated (non-silent) updates
    private var progressPanel: UpdateProgressPanelController?

    /// Cached app icon for alerts (capture before activationPolicy changes)
    private lazy var appIcon: NSImage? = NSApp.applicationIconImage

    private func postStatusDidChangeNotification() {
        NotificationCenter.default.post(name: .updateCheckerStatusDidChange, object: self)
    }

    // MARK: - Public

    /// Whether launch-time silent checks may run (and thereby auto-download/install).
    /// Storage lives in `AutoUpdatePolicy` (GitHub discussion #424); manual
    /// "Check for Updates" (non-silent) is never gated.
    var autoUpdateEnabled: Bool {
        get { AutoUpdatePolicy.isEnabled() }
        set { UserDefaults.standard.set(newValue, forKey: AutoUpdatePolicy.enabledKey) }
    }

    func check(silent: Bool = false) {
        guard !isBusy else { return }

        // Auto-update toggle: silent checks are exclusively launch-time background
        // checks whose success path downloads and installs without prompting, so the
        // toggle short-circuits them before any network call. Manual (non-silent)
        // checks stay available regardless of the toggle.
        if silent, !AutoUpdatePolicy.isEnabled() {
            Swift.print("[UpdateChecker] Skipping silent update check: auto-update is disabled")
            return
        }

        // Developer / Debug path guard:
        // Skip automatic silent background checks if the application is running from outside
        // the standard Applications directories (e.g., from Xcode DerivedData).
        // This prevents developer builds from being replaced by official App Store/GitHub releases.
        if silent {
            let path = Bundle.main.bundlePath
            let inStandardApps = path.hasPrefix("/Applications/") || path.hasPrefix("/Users/\(NSUserName())/Applications/")
            if !inStandardApps {
                Swift.print("[UpdateChecker] Skipping silent update check: running from non-standard path \(path)")
                return
            }
        }

        isBusy = true
        statusText = Strings.updateChecking

        Task.detached { [self] in
            let result: Result<GitHubRelease, Error>
            do {
                result = .success(try await self.fetchLatestRelease())
            } catch {
                result = .failure(error)
            }

            await MainActor.run {
                self.handleResult(result, silent: silent)
            }
        }
    }

    // MARK: - GitHub API (URLSession — respects system proxy)

    private struct GitHubRelease: Decodable {
        let tag_name: String
        let name: String?
        let body: String?
        let html_url: String
        let assets: [Asset]

        struct Asset: Decodable {
            let name: String
            let browser_download_url: String
            let size: Int
        }

        var tagVersion: String {
            tag_name.hasPrefix("v") ? String(tag_name.dropFirst()) : tag_name
        }

        var dmgAsset: Asset? {
            let isArm64: Bool = {
                var sysinfo = utsname()
                uname(&sysinfo)
                let machine = withUnsafePointer(to: &sysinfo.machine) {
                    $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
                }
                return machine == "arm64"
            }()
            let suffix = isArm64 ? "arm64.dmg" : "x64.dmg"
            // Prefer arch-specific DMG, fall back to any .dmg
            return assets.first { $0.name.hasSuffix(suffix) }
                ?? assets.first { $0.name.hasSuffix(".dmg") }
        }
    }

    nonisolated private func fetchLatestRelease() async throws -> GitHubRelease {
        let urlString = "https://api.github.com/repos/\(repo)/releases/latest"
        guard let url = URL(string: urlString) else { throw UpdateError.emptyResponse }

        var request = URLRequest(url: url, timeoutInterval: 15)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw UpdateError.curlFailed((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        guard !data.isEmpty else { throw UpdateError.emptyResponse }
        return try JSONDecoder().decode(GitHubRelease.self, from: data)
    }

    // MARK: - Result Handling

    private func handleResult(_ result: Result<GitHubRelease, Error>, silent: Bool) {
        switch result {
        case .success(let release):
            let current = currentVersion()
            if compareVersions(current, release.tagVersion) == .orderedAscending {
                if silent, let dmg = release.dmgAsset {
                    // Loop guard: if we just silently installed this exact release but
                    // the app still reports itself as older, the downloaded DMG's
                    // Info.plist is out of sync with the git tag (issue #34 / 0.5.77).
                    // Reinstalling would copy the same broken DMG on every relaunch
                    // forever — skip instead and surface the problem via statusText.
                    if isRecentlyInstalled(release.tagVersion) {
                        finishUpdate()
                        statusText = Strings.updateSkipped(target: release.tagVersion, current: current)
                        Swift.print("[UpdateChecker] Silent install loop averted: target=\(release.tagVersion), current=\(current)")
                        return
                    }
                    // Silent auto-update: download and install without prompting
                    startDownloadAndInstall(dmg, targetVersion: release.tagVersion, interactive: false)
                } else {
                    promptUpdate(release: release, currentVersion: current)
                }
            } else {
                finishUpdate()
                if !silent {
                    showAlert(title: Strings.upToDateTitle, message: Strings.upToDateMessage(current), style: .informational)
                }
            }
        case .failure(let error):
            finishUpdate()
            if !silent {
                showAlert(
                    title: Strings.updateCheckFailedTitle,
                    message: "\(error.localizedDescription)\n\n\(Strings.manualCheckHint)",
                    style: .warning,
                    showReleasePage: true
                )
            }
        }
    }

    private func finishUpdate() {
        isBusy = false
        statusText = nil
        progressPanel?.close()
        progressPanel = nil
    }

    // MARK: - Version

    func currentVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    private func compareVersions(_ a: String, _ b: String) -> ComparisonResult {
        let pa = a.split(separator: ".").compactMap { Int($0) }
        let pb = b.split(separator: ".").compactMap { Int($0) }
        let count = max(pa.count, pb.count)
        for i in 0..<count {
            let va = i < pa.count ? pa[i] : 0
            let vb = i < pb.count ? pb[i] : 0
            if va < vb { return .orderedAscending }
            if va > vb { return .orderedDescending }
        }
        return .orderedSame
    }

    // MARK: - Loop Protection

    /// Persisted identity of the most recent DMG that `mountCopyRelaunch` finished
    /// copying into `/Applications`. The silent `check()` path consults this to
    /// detect an install loop: if the tag it just fetched matches what we freshly
    /// installed *and* the app still reports an older `CFBundleShortVersionString`,
    /// the DMG's Info.plist MARKETING_VERSION is out of sync with the git tag
    /// (root cause of issue #34 / 0.5.77) and reinstalling would loop forever.
    private static let lastInstalledVersionKey = "UpdateChecker.lastInstalledVersion"
    private static let lastInstalledAtKey = "UpdateChecker.lastInstalledAt"

    /// How long after a successful install we treat "please install the same
    /// version again" as a loop rather than a legitimate reinstall request.
    /// Long enough to survive the next launch's silent check, short enough that
    /// a deliberate reinstall hours later still goes through.
    private let loopGuardWindow: TimeInterval = 10 * 60

    private func recordInstalledVersion(_ version: String) {
        let d = UserDefaults.standard
        d.set(version, forKey: Self.lastInstalledVersionKey)
        d.set(Date().timeIntervalSince1970, forKey: Self.lastInstalledAtKey)
    }

    private func isRecentlyInstalled(_ version: String) -> Bool {
        let d = UserDefaults.standard
        guard let last = d.string(forKey: Self.lastInstalledVersionKey), last == version else {
            return false
        }
        let at = d.double(forKey: Self.lastInstalledAtKey)
        guard at > 0 else { return false }
        return (Date().timeIntervalSince1970 - at) < loopGuardWindow
    }

    // MARK: - UI

    private func promptUpdate(release: GitHubRelease, currentVersion: String) {
        isBusy = false
        statusText = nil

        let alert = NSAlert()
        alert.messageText = Strings.newVersionTitle(release.tagVersion)
        // Keep the prompt lean: version + size only. Release notes are markdown,
        // which NSAlert can't render — intentionally omitted.
        alert.informativeText = buildUpdateMessage(release: release, currentVersion: currentVersion)
        alert.alertStyle = .informational
        alert.icon = appIcon
        alert.addButton(withTitle: release.dmgAsset != nil ? Strings.downloadInstallButton : Strings.viewOnGitHubButton)
        alert.addButton(withTitle: Strings.laterButton)

        presentAlert(alert) { response in
            if response == .alertFirstButtonReturn {
                if let dmg = release.dmgAsset {
                    self.startDownloadAndInstall(dmg, targetVersion: release.tagVersion, interactive: true)
                } else if let url = URL(string: release.html_url) {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    private func buildUpdateMessage(release: GitHubRelease, currentVersion: String) -> String {
        var lines = [Strings.updateCurrentLine(current: currentVersion, target: release.tagVersion)]
        if let dmg = release.dmgAsset {
            lines.append(Strings.updateSize(String(format: "%.1f", Double(dmg.size) / 1_048_576)))
        }
        return lines.joined(separator: "\n")
    }

    // MARK: - Download + Install (URLSession for proxy support)

    private func startDownloadAndInstall(_ asset: GitHubRelease.Asset, targetVersion: String, interactive: Bool) {
        isBusy = true
        let totalSize = Int64(asset.size)
        let totalMB = Double(totalSize) / 1_048_576
        statusText = Strings.downloadingPercent(0)

        if interactive {
            let panel = UpdateProgressPanelController()
            panel.show(title: Strings.updateProgressTitle(targetVersion))
            panel.setProgress(percent: 0, detail: Strings.downloadingPercent(0))
            progressPanel = panel
        }

        // Download into the app's own data directory rather than ~/Downloads/.
        // Downloads is TCC-protected on macOS, so writing there triggers a
        // "TokenTrackerBar wants to access files in your Downloads folder"
        // prompt every time silent auto-update fires — particularly noisy
        // for ad-hoc-signed builds where TCC grants don't persist across
        // re-installs. Application Support is owned by the user and not
        // gated by TCC, so the silent updater stays silent.
        let supportDir = (try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ))?.appendingPathComponent("TokenTrackerBar/updates", isDirectory: true)
            ?? FileManager.default.temporaryDirectory
        if !FileManager.default.fileExists(atPath: supportDir.path) {
            try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        }
        let safeVersion = targetVersion.map { character -> Character in
            character.isLetter || character.isNumber || character == "." || character == "-" ? character : "_"
        }
        let destURL = supportDir.appendingPathComponent("\(String(safeVersion))-\(asset.name)")
        let retainedNames = Set([
            destURL.lastPathComponent,
            destURL.appendingPathExtension("part").lastPathComponent,
            destURL.appendingPathExtension("resume.json").lastPathComponent,
        ])
        if let staleFiles = try? FileManager.default.contentsOfDirectory(
            at: supportDir,
            includingPropertiesForKeys: nil
        ) {
            for staleFile in staleFiles where !retainedNames.contains(staleFile.lastPathComponent) {
                try? FileManager.default.removeItem(at: staleFile)
            }
        }

        guard let url = URL(string: asset.browser_download_url) else {
            finishUpdate()
            showAlert(
                title: Strings.downloadFailedTitle,
                message: Strings.invalidDownloadURL,
                style: .warning,
                showReleasePage: true
            )
            return
        }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 900

        let delegate = ResumableDownloader(
            destinationURL: destURL,
            expectedSize: totalSize,
            configuration: config,
            onProgress: { [weak self] received, expected in
                guard let self else { return }
                let denom = expected > 0 ? expected : totalSize
                guard denom > 0 else {
                    self.statusText = Strings.downloadingUnknown
                    self.progressPanel?.setIndeterminate(detail: Strings.downloadingUnknown)
                    return
                }
                let fraction = Double(received) / Double(denom) * 100
                let pct = min(Int(fraction), 99)
                let receivedMB = Double(received) / 1_048_576
                let progressText = Strings.downloadingProgress(
                    pct: pct,
                    receivedMB: String(format: "%.0f", receivedMB),
                    totalMB: String(format: "%.0f", totalMB)
                )
                self.statusText = progressText
                self.progressPanel?.setProgress(percent: fraction, detail: progressText)
            },
            onRetry: { attempt, error in
                Swift.print("[UpdateChecker] Download retry \(attempt): \(error.localizedDescription)")
            },
            onComplete: { [weak self] result in
                guard let self else { return }
                self.activeDownloadDelegate = nil
                switch result {
                case .success(let dmgURL):
                    self.statusText = Strings.installing
                    self.progressPanel?.setIndeterminate(detail: Strings.installing)
                    self.performInstallAsync(dmgURL, targetVersion: targetVersion)
                case .failure(let error):
                    self.finishUpdate()
                    self.showAlert(
                        title: Strings.downloadFailedTitle,
                        message: "\(error.localizedDescription)\n\n\(Strings.manualDownloadHint)",
                        style: .warning,
                        showReleasePage: true
                    )
                }
            }
        )
        activeDownloadDelegate = delegate

        delegate.start(url: url)
    }

    private func performInstallAsync(_ dmgURL: URL, targetVersion: String) {
        let dmgPath = dmgURL.path
        Task.detached { [self] in
            let result: Result<URL, Error>
            do {
                result = .success(try self.mountCopyRelaunch(dmgPath: dmgPath))
            } catch {
                result = .failure(error)
            }

            await MainActor.run {
                switch result {
                case .success(let appURL):
                    self.recordInstalledVersion(targetVersion)
                    self.statusText = Strings.restarting
                    self.progressPanel?.setIndeterminate(detail: Strings.restarting)
                    self.relaunch(appURL: appURL)
                case .failure(let error):
                    self.finishUpdate()
                    if FileManager.default.fileExists(atPath: dmgPath) {
                        NSWorkspace.shared.open(dmgURL)
                    }
                    self.showAlert(
                        title: Strings.installationFailedTitle,
                        message: "\(error.localizedDescription)\n\n\(Strings.manualInstallHint)",
                        style: .warning
                    )
                }
            }
        }
    }

    // MARK: - Install Logic

    nonisolated private func mountCopyRelaunch(dmgPath: String) throws -> URL {
        // 1. Mount
        let mount = Process()
        mount.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        mount.arguments = ["attach", dmgPath, "-nobrowse", "-mountrandom", "/tmp"]
        let mountPipe = Pipe()
        mount.standardOutput = mountPipe
        mount.standardError = Pipe()
        try mount.run()
        mount.waitUntilExit()
        guard mount.terminationStatus == 0 else { throw UpdateError.installFailed("Failed to mount DMG") }

        let mountOutput = String(data: mountPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let mountPoint = mountOutput.split(separator: "\n").last?.split(separator: "\t").last?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !mountPoint.isEmpty, FileManager.default.fileExists(atPath: mountPoint) else {
            throw UpdateError.installFailed("Mount point not found")
        }

        defer {
            let detach = Process()
            detach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
            detach.arguments = ["detach", mountPoint, "-quiet", "-force"]
            detach.standardOutput = Pipe()
            detach.standardError = Pipe()
            try? detach.run()
            detach.waitUntilExit()
        }

        // 2. Find .app
        let fm = FileManager.default
        let contents = try fm.contentsOfDirectory(atPath: mountPoint)
        guard let appName = contents.first(where: { $0.hasSuffix(".app") }) else {
            throw UpdateError.installFailed("No .app found in DMG")
        }

        let appsDir = URL(fileURLWithPath: "/Applications", isDirectory: true)
        let sourceApp = URL(fileURLWithPath: mountPoint).appendingPathComponent(appName)
        let destApp = appsDir.appendingPathComponent(appName)

        // 3. Stage the new bundle next to the old one, then swap.
        //
        // Never delete the installed app before its replacement is fully on disk.
        // The previous code removed /Applications/TokenTracker.app and copied into
        // that same path, so a copy that died partway destroyed the install: one
        // such failure on macOS 27 left 15 of 671 files behind, and the only way
        // out was downloading the DMG and dragging it by hand.
        //
        // The staging name carries no `.app` extension, so the destination is not
        // a recognisable app bundle until every file has landed. The swap is then
        // one directory-entry rewrite in /Applications instead of 671 writes into
        // a path the system already treats as an installed, running application.
        let stagingName = ".\((appName as NSString).deletingPathExtension)-update-\(ProcessInfo.processInfo.processIdentifier)"
        let stagingURL = appsDir.appendingPathComponent(stagingName)
        Self.removeStaleStagingDirectories(in: appsDir, appName: appName, keeping: stagingName)
        try? fm.removeItem(at: stagingURL)

        do {
            try fm.copyItem(at: sourceApp, to: stagingURL)
        } catch {
            try? fm.removeItem(at: stagingURL)
            throw UpdateError.installFailed(Self.describe(error))
        }

        do {
            if fm.fileExists(atPath: destApp.path) {
                _ = try fm.replaceItemAt(destApp, withItemAt: stagingURL)
            } else {
                try fm.moveItem(at: stagingURL, to: destApp)
            }
        } catch {
            try? fm.removeItem(at: stagingURL)
            throw UpdateError.installFailed(Self.describe(error))
        }

        // 4. Cleanup DMG
        try? fm.removeItem(atPath: dmgPath)

        return destApp
    }

    /// Clears staging directories orphaned by an earlier crash, so a failed install
    /// cannot leave a few hundred MB behind in /Applications.
    nonisolated private static func removeStaleStagingDirectories(
        in appsDir: URL,
        appName: String,
        keeping currentName: String
    ) {
        let prefix = ".\((appName as NSString).deletingPathExtension)-update-"
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: appsDir,
            includingPropertiesForKeys: nil,
            options: [.skipsSubdirectoryDescendants]
        ) else { return }
        for entry in entries where entry.lastPathComponent.hasPrefix(prefix)
            && entry.lastPathComponent != currentName {
            try? FileManager.default.removeItem(at: entry)
        }
    }

    /// Keeps the error domain, code and underlying POSIX errno in the message.
    /// Without them a permission denial and a disk-full failure are indistinguishable
    /// in a user's screenshot — both read only as "X couldn't be copied to Y".
    nonisolated private static func describe(_ error: Error) -> String {
        let nsError = error as NSError
        var parts = [nsError.localizedDescription]
        if let reason = nsError.localizedFailureReason { parts.append(reason) }
        var code = "\(nsError.domain) \(nsError.code)"
        if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError {
            code += " / \(underlying.domain) \(underlying.code)"
        }
        parts.append("[\(code)]")
        let message = parts.joined(separator: " ")
        Swift.print("[UpdateChecker] Install failed: \(message)")
        return message
    }

    private func relaunch(appURL: URL) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-n", appURL.path]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { AppDelegate.requestQuit() }
        } catch {
            finishUpdate()
            showAlert(title: Strings.updateCompleteTitle, message: Strings.updateCompleteMessage, style: .informational)
        }
    }

    // MARK: - Helpers

    private func showAlert(title: String, message: String, style: NSAlert.Style, showReleasePage: Bool = false) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = style
        alert.icon = appIcon
        if showReleasePage {
            alert.addButton(withTitle: Strings.openReleasesPageButton)
            alert.addButton(withTitle: Strings.okButton)
        } else {
            alert.addButton(withTitle: Strings.okButton)
        }
        presentAlert(alert) { response in
            if showReleasePage && response == .alertFirstButtonReturn {
                if let url = URL(string: self.releaseURL) {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    /// 更新提示必须压过菜单栏 Popover（NSPanel）；仅用 sheet 仍可能被 Popover 挡住，故统一 `runModal` 并把模态窗提到高层级。
    /// 注意：不要在这里 order front 仪表盘窗口——靠下方的 level bump 已足够置顶，强开仪表盘会打扰用户。
    private func presentAlert(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        let previousActivationPolicy = NSApp.activationPolicy()
        NSApp.setActivationPolicy(.regular)
        StatusBarController.prepareForSystemAlert()
        NSApp.activate(ignoringOtherApps: true)

        var bumpTimer: Timer?
        let bumpAttempts = BumpAttempts()
        bumpTimer = Timer(timeInterval: 0.02, repeats: true) { t in
            bumpAttempts.count += 1
            if bumpAttempts.count > 250 {
                t.invalidate()
                return
            }
            guard let modal = NSApp.modalWindow else { return }
            modal.level = .popUpMenu
            modal.orderFrontRegardless()
            t.invalidate()
        }
        if let timer = bumpTimer {
            RunLoop.current.add(timer, forMode: .common)
            RunLoop.current.add(timer, forMode: .modalPanel)
        }

        let response = alert.runModal()
        bumpTimer?.invalidate()
        NSApp.setActivationPolicy(previousActivationPolicy)
        completion(response)
    }

    private final class BumpAttempts {
        var count = 0
    }

    private enum UpdateError: LocalizedError {
        case curlFailed(Int)
        case emptyResponse
        case installFailed(String)
        case noRelease

        var errorDescription: String? {
            switch self {
            case .curlFailed(let code): return Strings.networkRequestFailed(code: code)
            case .emptyResponse: return Strings.emptyServerResponse
            case .installFailed(let reason): return Strings.installFailed(reason)
            case .noRelease: return Strings.noReleaseAvailable
            }
        }
    }
}

extension Notification.Name {
    /// Posted when `UpdateChecker.shared.statusText` or `isBusy` changes (menu bar can refresh without polling).
    static let updateCheckerStatusDidChange = Notification.Name("UpdateCheckerStatusDidChange")
}
