import SwiftUI

@main
struct TokenTrackerPhoneApp: App {
    @StateObject private var sessions: SessionStore
    @StateObject private var preferences: PhonePreferences
    @StateObject private var workspace: WorkspaceModel

    init() {
        let prefs = PhonePreferences()
        #if DEBUG
        if let scenario = SimulatorLaunchScenario.current {
            scenario.configurePreferences(prefs)
            let store = SessionStore(restore: false, initialSession: scenario.initialSession)
            let ws = WorkspaceModel(
                sessions: store,
                client: ScenarioCloudClient(scenario: scenario),
                nowProvider: { scenario.fixedNow }
            )
            ws.selectedTab = scenario.initialTab
            _sessions = StateObject(wrappedValue: store)
            _preferences = StateObject(wrappedValue: prefs)
            _workspace = StateObject(wrappedValue: ws)
            return
        }
        #endif
        let store = SessionStore()
        _sessions = StateObject(wrappedValue: store)
        _preferences = StateObject(wrappedValue: prefs)
        _workspace = StateObject(wrappedValue: WorkspaceModel(sessions: store))
    }

    var body: some Scene {
        WindowGroup {
            RootContainerView(workspace: workspace)
                .environmentObject(sessions)
                .environmentObject(preferences)
                .preferredColorScheme(preferences.appearance.colorScheme)
                .tint(.primary)
        }
    }
}

struct RootContainerView: View {
    @EnvironmentObject private var sessions: SessionStore
    @EnvironmentObject private var prefs: PhonePreferences
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var workspace: WorkspaceModel

    @State private var showPairCLISheet = false
    @State private var unlockedGeneration: Int?
    @State private var lockEpoch = 0
    private var isLocked: Bool {
        PrivacyLockPolicy.isLocked(enabled: prefs.requireBiometricUnlock,
            generation: sessions.sessionGeneration, unlockedGeneration: unlockedGeneration)
    }
    @State private var isAuthenticating = false

    var body: some View {
        ZStack {
            if sessions.isSignedIn {
                authenticatedShell
                    .id(sessions.sessionGeneration)
            } else {
                SignInView()
            }

            // App-switcher privacy shield & optional biometric lock
            if sessions.isSignedIn && ((scenePhase != .active && prefs.hideSwitcherSnapshot) || isLocked) {
                privacyOverlay
            }
        }
        .background {
            PresentationPrivacyGuard(sessions: sessions, contentGeneration: workspace.contentGeneration,
                shielded: sessions.isSignedIn && (isLocked || (scenePhase != .active && (prefs.hideSwitcherSnapshot || prefs.requireBiometricUnlock))),
                protectInactive: sessions.isSignedIn && (prefs.hideSwitcherSnapshot || prefs.requireBiometricUnlock),
                shield: privacyOverlay)
        }
        .sheet(isPresented: $showPairCLISheet) {
            PairCLIDeviceSheet(workspace: workspace)
        }
        .task {
            // A cold launch must honor the lock too, not only a return from background.
            if sessions.isSignedIn && prefs.requireBiometricUnlock {
                unlockedGeneration = nil
                lockEpoch += 1
                await unlock()
            }
        }
        .onChange(of: sessions.sessionGeneration) { _, _ in
            showPairCLISheet = false
            workspace.reset()
            unlockedGeneration = nil
            lockEpoch += 1
            if sessions.isSignedIn {
                Task { await workspace.refresh() }
            }
        }
        .onChange(of: scenePhase) { oldPhase, newPhase in
            guard sessions.isSignedIn else { return }
            if newPhase == .background && prefs.requireBiometricUnlock {
                unlockedGeneration = nil
                lockEpoch += 1
            }
            if newPhase == .active {
                if isLocked {
                    Task { await unlock() }
                }
                if oldPhase == .background {
                    Task { await workspace.refresh() }
                }
            }
        }
    }

    /// One Face ID / passcode prompt at a time; launch and foreground can race.
    private func unlock() async {
        guard isLocked, !isAuthenticating else { return }
        isAuthenticating = true
        defer { isAuthenticating = false }
        let generation = sessions.sessionGeneration
        let epoch = lockEpoch
        if await prefs.authenticateWithBiometrics(), generation == sessions.sessionGeneration, epoch == lockEpoch, scenePhase == .active {
            unlockedGeneration = generation
        }
    }

    @ViewBuilder
    private var authenticatedShell: some View {
        switch workspace.phase {
        case .cloudAccessRequired(let code):
            CloudAccessBlockedView(
                code: code,
                isBusy: workspace.isRefreshing,
                onRetry: { Task { await workspace.refresh() } },
                onPairCLI: { showPairCLISheet = true }
            )
        default:
            TabView(selection: $workspace.selectedTab) {
                Tab("Pulse", systemImage: "waveform.path.ecg", value: .pulse) {
                    PulseView(workspace: workspace) {
                        showPairCLISheet = true
                    }
                }

                Tab("Pacing", systemImage: "gauge.with.dots.needle.67percent", value: .limits) {
                    LimitsPacingView(workspace: workspace)
                }

                Tab("Settings", systemImage: "gearshape", value: .settings) {
                    SettingsView(workspace: workspace) {
                        showPairCLISheet = true
                    }
                }
            }
            .tabBarMinimizeBehavior(.onScrollDown)
            .task {
                if workspace.phase == .idle {
                    await workspace.refresh()
                }
            }
            .task(id: prefs.refreshPolicy) {
                guard let interval = prefs.refreshPolicy.intervalSeconds else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(interval))
                    guard !Task.isCancelled, scenePhase == .active, sessions.isSignedIn else { continue }
                    await workspace.refresh()
                }
            }
            .onChange(of: workspace.horizon) { _, _ in
                Task { await workspace.refresh() }
            }
            .onChange(of: workspace.selectedDeviceId) { _, _ in
                Task { await workspace.refresh() }
            }
        }
    }

    private var privacyOverlay: some View {
        ZStack {
            AppBackground()
            Rectangle()
                .fill(.ultraThinMaterial)
                .ignoresSafeArea()

            VStack(spacing: 18) {
                TokenTrackerMark(size: 72)

                Text(isLocked ? "Token Tracker is locked" : "Token Tracker")
                    .font(.title3.weight(.bold))

                if isLocked {
                    if let error = prefs.authenticationError {
                        Text(error).multilineTextAlignment(.center).padding()
                    }
                    Button("Sign out") { sessions.signOutLocally() }
                    Button {
                        Task { await unlock() }
                    } label: {
                        Label("Unlock", systemImage: "faceid")
                            .fontWeight(.semibold)
                            .padding(.horizontal, 12)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                }
            }
        }
    }
}
