import SwiftUI

@main
struct TokenTrackerPhoneApp: App {
    @StateObject private var sessions = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(sessions)
                .tint(.accentColor)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var sessions: SessionStore

    var body: some View {
        Group {
            if sessions.isSignedIn {
                DashboardScreen(sessions: sessions)
            } else {
                SignInView()
            }
        }
        .animation(.default, value: sessions.isSignedIn)
    }
}
