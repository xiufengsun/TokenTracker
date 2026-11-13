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
                .tint(BrandPalette.emerald)
        }
    }
}

struct RootContainerView: View {
    @EnvironmentObject private var sessions: SessionStore
    @EnvironmentObject private var prefs: PhonePreferences
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var workspace: WorkspaceModel

    @State private var showPairCLISheet = false
    @State private var isLocked = false

    var body: some View {
        ZStack {
            if sessions.isSignedIn {
                authenticatedShell
            } else {
                SignInView()
            }

            // App-switcher privacy shield & optional biometric lock
            if sessions.isSignedIn && ((scenePhase != .active && prefs.hideSwitcherSnapshot) || isLocked) {
                privacyOverlay
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: sessions.isSignedIn)
        .sheet(isPresented: $showPairCLISheet) {
            PairCLIDeviceSheet(workspace: workspace)
        }
        .onChange(of: sessions.session?.user.id) { _, newId in
            if newId == nil {
                workspace.reset()
                isLocked = false
            } else {
                Task { await workspace.refresh() }
            }
        }
        .onChange(of: scenePhase) { oldPhase, newPhase in
            guard sessions.isSignedIn else { return }
            if newPhase == .background && prefs.requireBiometricUnlock {
                isLocked = true
            }
            if newPhase == .active {
                if isLocked {
                    Task {
                        if await prefs.authenticateWithBiometrics() {
                            isLocked = false
                        }
                    }
                }
                if oldPhase == .background {
                    Task { await workspace.refresh() }
                }
            }
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
            AtmosphericGlassCanvas()
            Rectangle()
                .fill(.ultraThinMaterial)
                .ignoresSafeArea()

            VStack(spacing: 18) {
                BoltIcon(size: 32, color: BrandPalette.emerald)
                    .frame(width: 68, height: 68)
                    .glassEffect(.regular.tint(BrandPalette.emerald.opacity(0.22)), in: Circle())

                Text("TokenTracker Locked")
                    .font(.title3.weight(.bold))

                if isLocked {
                    Button {
                        Task {
                            if await prefs.authenticateWithBiometrics() {
                                isLocked = false
                            }
                        }
                    } label: {
                        Label("Unlock with Face ID", systemImage: "faceid")
                            .fontWeight(.semibold)
                            .padding(.horizontal, 12)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                }
            }
        }
    }
}
