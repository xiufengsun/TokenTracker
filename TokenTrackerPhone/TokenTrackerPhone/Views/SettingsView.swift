import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var sessions: SessionStore
    @EnvironmentObject private var prefs: PhonePreferences
    @Environment(\.openURL) private var openURL
    @ObservedObject var workspace: WorkspaceModel
    let onPairCLI: () -> Void

    @State private var copiedUserId = false
    @State private var busyMachineId: String?
    @State private var renamingDevice: AccountDeviceRow?
    @State private var renameText = ""
    @State private var editingProfileSheet = false
    @State private var actionNotice: String?
    @State private var actionError: String?
    @State private var confirmSignOut = false
    @State private var pausingMachine: CloudMachineItem?

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
            List {
                accountSection

                cloudStatusSection

                syncedComputersSection

                privacyAndSecuritySection

                appearanceAndUnitsSection

                sessionAndRefreshSection

                aboutSection

                signOutSection
            }
            .listStyle(.insetGrouped)
            .scenarioScrollAnchor(proxy)
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .task {
                await workspace.loadPublicProfileIfNeeded()
            }
            .sheet(isPresented: $editingProfileSheet) {
                if let current = workspace.publicProfile {
                    PublicProfileEditorSheet(initial: current, workspace: workspace)
                }
            }
            .alert("Rename Computer", isPresented: Binding(
                get: { renamingDevice != nil },
                set: { if !$0 { renamingDevice = nil } }
            )) {
                TextField("Computer name", text: $renameText)
                Button("Cancel", role: .cancel) { renamingDevice = nil }
                Button("Save") {
                    guard let target = renamingDevice else { return }
                    let trimmed = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                    renamingDevice = nil
                    guard !trimmed.isEmpty else { return }
                    Task {
                        do {
                            try await workspace.renameDevice(target.id, name: trimmed)
                            actionNotice = "Renamed computer to \(trimmed)."
                        } catch {
                            actionError = error.localizedDescription
                        }
                    }
                }
            } message: {
                Text("The new name shows on every device signed in to this account.")
            }
            .confirmationDialog(
                "Sign out of TokenTracker?",
                isPresented: $confirmSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign Out", role: .destructive) {
                    // RootContainerView resets the workspace when the session clears.
                    Task { await sessions.signOut() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Removes your Cloud session token from this iPhone's Keychain. Synced Cloud history stays intact on your account.")
            }
        }
    }

    // MARK: - 1. Account Identity

    private var accountSection: some View {
        Section {
            if let user = sessions.session?.user {
                HStack(spacing: 14) {
                    Text(initials(for: user))
                        .font(.headline.weight(.bold))
                        .foregroundStyle(Color(.systemBackground))
                        .frame(width: 46, height: 46)
                        .background(Color.primary, in: Circle())

                    VStack(alignment: .leading, spacing: 3) {
                        Text(workspace.publicProfile?.displayName ?? user.name ?? user.email ?? "TokenTracker User")
                            .font(.headline)
                        if let email = user.email {
                            Text(email)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.vertical, 4)

                Button {
                    UIPasteboard.general.string = user.id
                    copiedUserId = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copiedUserId = false
                    }
                } label: {
                    HStack {
                        Text("Account ID")
                            .foregroundStyle(.primary)
                        Spacer()
                        Text(shortUserId(user.id))
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)
                        Image(systemName: copiedUserId ? "checkmark.circle.fill" : "doc.on.doc")
                            .font(.footnote)
                            .foregroundStyle(copiedUserId ? Color.primary : Color.secondary)
                    }
                }
            }

            if let actionNotice {
                Label(actionNotice, systemImage: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let actionError {
                Label(actionError, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Palette.critical)
            }
        } header: {
            Text("Account")
        }
    }

    // MARK: - 2. Cloud Status (Informational Only — App Store 3.1.3(f) Compliant)

    private var cloudStatusSection: some View {
        let membership = workspace.snapshot?.cloudAccount?.membership
        return Section {
            HStack {
                Label("Status", systemImage: "icloud")
                Spacer()
                Text(membership?.displayStatusTitle ?? "Cloud Connected")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(membership?.canReadCloud == false ? Palette.warning : Color.secondary)
            }

            if let endISO = membership?.relevantEndDateISO,
               let formatted = formatISODate(endISO) {
                LabeledContent(
                    membership?.status == "expired" ? "Read Window Until" : "Current Term Ends",
                    value: formatted
                )
            }

            if let membership {
                let mins = max(1, membership.syncIntervalSeconds / 60)
                LabeledContent("Cloud Sync Cadence", value: membership.syncIntervalSeconds == 0 ? "Instant" : "Every \(mins) min")
                if let hourlyDays = membership.hourlyHistoryDays, let dailyMonths = membership.dailyHistoryMonths {
                    LabeledContent("Cloud Retention", value: "\(hourlyDays)d hourly · \(dailyMonths)m daily")
                }
            }

            Button(action: onPairCLI) {
                Label("Approve CLI Pairing Code…", systemImage: "terminal")
            }
            .accessibilityIdentifier("settings.pairCLI")
        } header: {
            Text("TokenTracker Cloud")
        } footer: {
            Text("TokenTracker on iPhone reads usage synced from your computers. No prompts, code, or provider keys are uploaded to Cloud.")
        }
    }

    // MARK: - 3. Synced Computers

    /// Machines come from `tokentracker-billing?action=devices` (Cloud sync slots,
    /// pause / resume). Rename goes through `tokentracker-device-rename`, which is
    /// keyed by the device id from `tokentracker-account-devices`, so a machine is
    /// renameable only when exactly one device row carries its name.
    @ViewBuilder
    private var syncedComputersSection: some View {
        let machineList = workspace.snapshot?.cloudMachines
        let machines = machineList?.machines ?? []
        let deviceRows = workspace.snapshot?.accountDevices?.devices ?? []

        Section {
            if machines.isEmpty {
                Text(deviceRows.isEmpty ? "No computers are syncing to Cloud yet." : "Cloud sync slots couldn't load. Pull down on Pulse to refresh.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(machines) { machine in
                    machineRow(machine, renameTarget: renameTarget(for: machine, in: deviceRows))
                }
            }
        } header: {
            HStack {
                Text("Synced Computers")
                Spacer()
                if let count = machineList?.machineCount {
                    if let limit = machineList?.machineLimit {
                        Text("\(count) of \(limit) slots")
                    } else {
                        Text("\(count) active")
                    }
                }
            }
        } footer: {
            Text(machineList?.overMachineLimit == true
                 ? "This account has more computers than sync slots. Pause one so the others can keep syncing."
                 : "Pausing frees the computer's sync slot and stops new uploads. Its history stays in Cloud, and you can resume it here.")
        }
        .id("computers")
        .confirmationDialog(
            "Pause Cloud sync for \(pausingMachine?.displayName ?? "this computer")?",
            isPresented: Binding(get: { pausingMachine != nil }, set: { if !$0 { pausingMachine = nil } }),
            titleVisibility: .visible,
            presenting: pausingMachine
        ) { machine in
            Button("Pause Sync", role: .destructive) { toggleMachine(machine) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("New uploads stop and its sync slot is freed. Local data and Cloud history stay. The computer signs in again after you resume it.")
        }
    }

    private func renameTarget(for machine: CloudMachineItem, in rows: [AccountDeviceRow]) -> AccountDeviceRow? {
        let matches = rows.filter { $0.displayName == machine.displayName }
        return matches.count == 1 ? matches.first : nil
    }

    private func machineRow(_ machine: CloudMachineItem, renameTarget: AccountDeviceRow?) -> some View {
        HStack(spacing: 12) {
            Image(systemName: machine.platformSymbol)
                .font(.body.weight(.medium))
                .foregroundStyle(machine.isPaused ? Color.secondary : Color.primary)
                .frame(width: 26)

            VStack(alignment: .leading, spacing: 2) {
                Text(machine.displayName)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(machineSubtitle(machine))
                    .font(.caption)
                    .foregroundStyle(machine.isPaused ? Palette.warning : Color.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            if busyMachineId == machine.machineId {
                ProgressView()
            } else {
                Button(machine.isPaused ? "Resume" : "Pause") {
                    if machine.isPaused {
                        toggleMachine(machine)
                    } else {
                        pausingMachine = machine
                    }
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityLabel("\(machine.isPaused ? "Resume" : "Pause") \(machine.displayName)")
            }
        }
        .padding(.vertical, 2)
        .contextMenu {
            if let renameTarget {
                Button {
                    renameText = renameTarget.displayName
                    renamingDevice = renameTarget
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if let renameTarget {
                Button {
                    renameText = renameTarget.displayName
                    renamingDevice = renameTarget
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
                .tint(.gray)
            }
        }
    }

    private func machineSubtitle(_ machine: CloudMachineItem) -> String {
        var parts = [machine.platformLabel]
        if machine.isPaused {
            parts.append("Paused")
        } else if let seen = machine.lastSeenAt, let formatted = formatRelativeOrShort(seen) {
            parts.append("Synced \(formatted)")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: - 4. Privacy & Phone Security

    private var privacyAndSecuritySection: some View {
        Section {
            Toggle(isOn: $prefs.discreteAmounts) {
                Label("Mask Cost Figures", systemImage: "eye.slash")
            }
            .id("privacy")

            Toggle(isOn: $prefs.hideSwitcherSnapshot) {
                Label("Privacy Blur in App Switcher", systemImage: "rectangle.portrait.slash")
            }

            Toggle(isOn: $prefs.requireBiometricUnlock) {
                Label("Require Face ID / Passcode", systemImage: "faceid")
            }

            if let profile = workspace.publicProfile {
                Button {
                    editingProfileSheet = true
                } label: {
                    HStack {
                        Label("Public Leaderboard Profile", systemImage: "trophy")
                            .foregroundStyle(.primary)
                        Spacer()
                        Text(profile.enabled ? (profile.anonymous ? "Anonymous" : "Public") : "Private")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        } header: {
            Text("Privacy & Security")
        } footer: {
            Text("Mask Cost Figures hides dollar totals when checking usage in public. Leaderboard visibility syncs directly with your TokenTracker account.")
        }
    }

    // MARK: - 5. Appearance & Number Formatting

    private var appearanceAndUnitsSection: some View {
        Section {
            Picker(selection: $prefs.appearance) {
                ForEach(AppAppearanceMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            } label: {
                Label("Appearance", systemImage: "circle.lefthalf.filled")
            }

            Picker(selection: $prefs.currency) {
                ForEach(PhoneCurrency.allCases) { curr in
                    Text(curr.displayLabel).tag(curr)
                }
            } label: {
                Label("Display Currency", systemImage: "dollarsign.circle")
            }

            Picker(selection: $prefs.tokenNumberFormat) {
                ForEach(TokenNumberFormat.allCases) { fmt in
                    Text(fmt.label).tag(fmt)
                }
            } label: {
                Label("Token Numbers", systemImage: "number")
            }

            if prefs.tokenNumberFormat == .compact {
                Picker(selection: $prefs.tokenUnitScale) {
                    ForEach(TokenUnitScale.allCases) { scale in
                        Text(scale.label).tag(scale)
                    }
                } label: {
                    Label("Compact Units", systemImage: "scalemass")
                }
            }

            Picker(selection: $prefs.windowMeterStyle) {
                ForEach(WindowMeterStyle.allCases) { style in
                    Text(style.label).tag(style)
                }
            } label: {
                Label("Limit & Target Bars", systemImage: "chart.bar.xaxis")
            }
        } header: {
            Text("Appearance & Units")
        } footer: {
            if prefs.currency != .usd {
                Text("Converted from USD estimates at 1 USD = \(String(format: "%.2f", prefs.currency.defaultRate)) \(prefs.currency.rawValue).")
            }
        }
    }

    // MARK: - 6. Session & Refresh Cadence

    private var sessionAndRefreshSection: some View {
        Section {
            Picker(selection: $prefs.refreshPolicy) {
                ForEach(BackgroundRefreshPolicyOption.allCases) { option in
                    Text(option.label).tag(option)
                }
            } label: {
                Label("Auto-Refresh", systemImage: "arrow.triangle.2.circlepath")
            }

            Button {
                Task {
                    actionNotice = nil
                    await workspace.refresh()
                    if workspace.phase == .loaded && workspace.warningBanner == nil {
                        actionNotice = "Updated from Cloud."
                    }
                }
            } label: {
                HStack {
                    Label("Refresh Cloud Data Now", systemImage: "arrow.clockwise")
                    Spacer()
                    if workspace.isRefreshing {
                        ProgressView()
                    }
                }
            }
            .disabled(workspace.isRefreshing)
        } header: {
            Text("Session & Sync")
        }
    }

    // MARK: - 7. About

    private var aboutSection: some View {
        Section("About") {
            LabeledContent(
                "Version",
                value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
            )

            Button {
                openURL(CloudConfig.privacyPolicyURL)
            } label: {
                Label("Privacy Policy", systemImage: "hand.raised")
            }

            Button {
                openURL(CloudConfig.githubRepoURL)
            } label: {
                Label {
                    Text("Source Code on GitHub")
                } icon: {
                    BrandProviderIcon(provider: "github", size: 20)
                }
            }
        }
    }

    // MARK: - 8. Sign Out

    private var signOutSection: some View {
        Section {
            Button(role: .destructive) {
                confirmSignOut = true
            } label: {
                HStack {
                    Spacer()
                    Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                        .fontWeight(.semibold)
                    Spacer()
                }
            }
            .accessibilityIdentifier("settings.signOut")
        }
    }

    // MARK: - Helpers

    private func toggleMachine(_ machine: CloudMachineItem) {
        busyMachineId = machine.machineId
        actionError = nil
        actionNotice = nil
        Task {
            defer { busyMachineId = nil }
            do {
                try await workspace.setMachinePaused(machine.machineId, paused: !machine.isPaused)
                actionNotice = machine.isPaused
                    ? "Resumed \(machine.displayName). It reconnects on its next sync."
                    : "Paused \(machine.displayName)."
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    private func initials(for user: CloudUser) -> String {
        let source = workspace.publicProfile?.displayName ?? user.name ?? user.email ?? "TT"
        let words = source.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        if words.count >= 2 {
            return "\(words[0].prefix(1))\(words[1].prefix(1))".uppercased()
        }
        return String(source.prefix(2)).uppercased()
    }

    private func shortUserId(_ id: String) -> String {
        guard id.count > 14 else { return id }
        return "\(id.prefix(8))…\(id.suffix(4))"
    }

    private func formatISODate(_ iso: String) -> String? {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fmt.date(from: iso) {
            return d.formatted(date: .abbreviated, time: .omitted)
        }
        fmt.formatOptions = [.withInternetDateTime]
        if let d = fmt.date(from: iso) {
            return d.formatted(date: .abbreviated, time: .omitted)
        }
        return nil
    }

    private func formatRelativeOrShort(_ iso: String) -> String? {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fmt.date(from: iso) ?? {
            fmt.formatOptions = [.withInternetDateTime]
            return fmt.date(from: iso)
        }()
        guard let date else { return nil }
        let seconds = max(0, (workspace.snapshot?.now ?? Date()).timeIntervalSince(date))
        if seconds < 3600 { return "\(max(1, Int(seconds / 60)))m ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h ago" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

// MARK: - Public Leaderboard Profile Privacy Sheet

private struct PublicProfileEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    let initial: PublicVisibilityState
    @ObservedObject var workspace: WorkspaceModel

    @State private var enabled: Bool
    @State private var anonymous: Bool
    @State private var displayName: String
    @State private var githubHandle: String
    @State private var showGithub: Bool
    @State private var saving = false
    @State private var errorMessage: String?

    init(initial: PublicVisibilityState, workspace: WorkspaceModel) {
        self.initial = initial
        self.workspace = workspace
        _enabled = State(initialValue: initial.enabled)
        _anonymous = State(initialValue: initial.anonymous)
        _displayName = State(initialValue: initial.displayName ?? "")
        _githubHandle = State(initialValue: initial.githubUrl ?? "")
        _showGithub = State(initialValue: initial.showGithubUrl)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Appear on Public Leaderboard", isOn: $enabled)
                    if enabled {
                        Toggle("Hide Identity (Anonymous Handle)", isOn: $anonymous)
                    }
                } footer: {
                    Text("When off, your token usage and profile page are completely private.")
                }

                if enabled && !anonymous {
                    Section("Public Identity") {
                        TextField("Display name", text: $displayName)
                        Toggle("Link GitHub Profile", isOn: $showGithub)
                        if showGithub {
                            TextField("GitHub username or URL", text: $githubHandle)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(Palette.critical)
                    }
                }
            }
            .navigationTitle("Public Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await save() }
                    }
                    .fontWeight(.semibold)
                    .disabled(saving)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() async {
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            let trimmedGithub = githubHandle.trimmingCharacters(in: .whitespacesAndNewlines)
            let patch = PublicVisibilityPatch(
                enabled: enabled,
                anonymous: anonymous,
                displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
                githubUrl: trimmedGithub.isEmpty ? nil : trimmedGithub,
                clearGithubUrl: trimmedGithub.isEmpty,
                showGithubUrl: showGithub && !trimmedGithub.isEmpty
            )
            try await workspace.updatePublicProfile(patch)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - CLI Pairing Code Sheet (`tokentracker-device-flow-grant`)

struct PairCLIDeviceSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var workspace: WorkspaceModel

    @State private var code = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var approved = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("AB12-CD34", text: $code)
                        .font(.title3.monospaced().weight(.semibold))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .onChange(of: code) { _, newValue in
                            let cleaned = newValue.uppercased().filter { $0.isLetter || $0.isNumber }
                            let capped = String(cleaned.prefix(8))
                            if capped.count > 4 {
                                let formatted = "\(capped.prefix(4))-\(capped.dropFirst(4))"
                                if formatted != newValue { code = formatted }
                            } else if capped != newValue && !newValue.contains("-") {
                                code = capped
                            }
                        }
                } header: {
                    Text("8-Character Pairing Code")
                } footer: {
                    Text("Run `npx tokentracker@latest login` on a Mac, Linux, or Windows terminal and enter the code shown there to link that computer to your Cloud account.")
                }

                if approved {
                    Section {
                        Label("Computer authorized! Your terminal will finish linking within a few seconds.", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.primary)
                            .font(.subheadline)
                    }
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Palette.critical)
                            .font(.footnote)
                    }
                }

                Section {
                    Button {
                        Task { await authorize() }
                    } label: {
                        HStack {
                            Spacer()
                            if isSubmitting {
                                ProgressView()
                            } else {
                                Text(approved ? "Done" : "Authorize Computer")
                                    .fontWeight(.semibold)
                            }
                            Spacer()
                        }
                    }
                    .disabled(isSubmitting || (!approved && CloudAPIClient.normalizeCLICode(code).count != 9))
                }
            }
            .navigationTitle("Approve CLI Login")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func authorize() async {
        if approved {
            dismiss()
            return
        }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await workspace.authorizeCLIDevice(code: code)
            approved = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
