import SwiftUI

struct DashboardScreen: View {
    @EnvironmentObject private var sessions: SessionStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @StateObject private var model: DashboardModel

    init(sessions: SessionStore) {
        _model = StateObject(wrappedValue: DashboardModel(sessions: sessions))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("TokenTracker")
                .toolbar { ToolbarItem(placement: .topBarTrailing) { accountMenu } }
        }
        .task { await model.refresh() }
        .onChange(of: model.period) { Task { await model.refresh() } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refresh() } }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .cloudAccessRequired(let code):
            CloudAccessRequiredView(code: code) { Task { await model.refresh() } }
        default:
            ScrollView {
                VStack(spacing: 16) {
                    Picker("Period", selection: $model.period) {
                        ForEach(UsagePeriod.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    if case .failed(let message) = model.phase {
                        ErrorBanner(message: message) { Task { await model.refresh() } }
                    }

                    if let snapshot = model.visibleSnapshot {
                        SummaryCard(snapshot: snapshot)
                        if let daily = snapshot.daily { TrendCard(daily: daily) }
                        if snapshot.breakdown != nil {
                            TopModelsCard(models: snapshot.topModels)
                            SourcesCard(sources: snapshot.sources)
                        }
                        if let heatmap = snapshot.heatmap { HeatmapCard(heatmap: heatmap) }
                        Text("Updated \(snapshot.fetchedAt, style: .relative) ago")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if model.phase == .loading || model.phase == .idle {
                        ProgressView().padding(.top, 80)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
                .animation(.default, value: model.visibleSnapshot?.fetchedAt)
            }
            .background(Color(.systemGroupedBackground))
            .refreshable { await model.refresh() }
            .overlay(alignment: .top) {
                if model.phase == .loading && model.visibleSnapshot != nil {
                    ProgressView().padding(.top, 4)
                }
            }
        }
    }

    private var accountMenu: some View {
        Menu {
            if let user = sessions.session?.user {
                Section(user.name ?? user.email ?? "Signed in") {
                    if let email = user.email, user.name != nil { Text(email) }
                }
            }
            Button {
                openURL(CloudConfig.webDashboardURL)
            } label: {
                Label("Open web dashboard", systemImage: "safari")
            }
            Button(role: .destructive) {
                model.reset()
                Task { await sessions.signOut() }
            } label: {
                Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } label: {
            Image(systemName: "person.crop.circle")
        }
    }
}

private struct ErrorBanner: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
            Button("Retry", action: retry).font(.footnote.bold())
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.orange.opacity(0.12)))
    }
}

struct CloudAccessRequiredView: View {
    @EnvironmentObject private var sessions: SessionStore
    let code: String
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("TokenTracker Cloud required", systemImage: "icloud.slash")
        } description: {
            Text(description)
        } actions: {
            // No purchase link here: App Store guideline 3.1.3(f) bars companion
            // apps from pointing to purchases made outside the app.
            Button("Check again", action: retry)
                .buttonStyle(.borderedProminent)
            Button("Sign out", role: .destructive) { Task { await sessions.signOut() } }
        }
    }

    private var description: String {
        switch code {
        case "cloud_read_only_expired":
            return "This account's Cloud access has ended, so its synced history can no longer be read here."
        default:
            return "The iPhone app reads the usage your computers sync to TokenTracker Cloud. This account doesn't have an active Cloud membership or trial."
        }
    }
}
