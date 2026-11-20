import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @EnvironmentObject private var sessions: SessionStore
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    @State private var providers: [String] = ["github", "google"]
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var errorMessage: String?

    private let auth = CloudAuthClient()

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                header

                VStack(spacing: 12) {
                    ForEach(providers, id: \.self) { provider in
                        Button {
                            Task { await signInWithOAuth(provider) }
                        } label: {
                            Label("Continue with \(providerLabel(provider))", systemImage: providerSymbol(provider))
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    }
                }

                if !providers.isEmpty { divider }

                VStack(spacing: 12) {
                    TextField("Email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .onSubmit { Task { await signInWithPassword() } }
                }
                .textFieldStyle(.roundedBorder)

                Button {
                    Task { await signInWithPassword() }
                } label: {
                    Text("Sign in").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(email.isEmpty || password.isEmpty)

                if let warning = sessions.signOutError {
                    Text(warning)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .multilineTextAlignment(.center)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }

                Text("Shows usage synced to TokenTracker Cloud. Requires an active Cloud membership.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(24)
            .disabled(busy)
            .overlay { if busy { ProgressView() } }
        }
        .scrollDismissesKeyboard(.interactively)
        .task { await loadProviders() }
    }

    private var header: some View {
        VStack(spacing: 12) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 72, height: 72)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.black.gradient))
            Text("TokenTracker")
                .font(.largeTitle.bold())
            Text("Sign in with your TokenTracker Cloud account")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 40)
    }

    private var divider: some View {
        HStack {
            Rectangle().frame(height: 1).foregroundStyle(.quaternary)
            Text("or").font(.footnote).foregroundStyle(.secondary)
            Rectangle().frame(height: 1).foregroundStyle(.quaternary)
        }
    }

    // MARK: - Actions

    /// The server's list wins, even when empty. GitHub + Google is only the
    /// fallback for when the config can't be fetched.
    private func loadProviders() async {
        guard let config = try? await auth.publicConfig() else { return }
        providers = config.oAuthProviders.filter { ["github", "google"].contains($0.lowercased()) }
    }

    private func signInWithOAuth(_ provider: String) async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let pkce = PKCE.generate()
            let authorizeURL = try await auth.oauthAuthorizeURL(provider: provider, pkce: pkce)
            let callback = try await webAuthenticationSession.authenticate(
                using: authorizeURL,
                callbackURLScheme: CloudConfig.oauthCallbackScheme,
                preferredBrowserSession: .shared
            )
            let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
            guard let code = items.first(where: { $0.name == "insforge_code" || $0.name == "code" })?.value else {
                let reason = items.first(where: { $0.name == "error_description" || $0.name == "error" })?.value
                throw CloudError.server(status: 400, code: nil, message: reason ?? "Sign-in was not completed.")
            }
            try sessions.signIn(with: try await auth.exchangeOAuthCode(code, pkce: pkce))
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func signInWithPassword() async {
        guard !email.isEmpty, !password.isEmpty else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let response = try await auth.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password)
            try sessions.signIn(with: response)
            password = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func providerLabel(_ provider: String) -> String {
        switch provider.lowercased() {
        case "github": return "GitHub"
        case "google": return "Google"
        default: return provider.capitalized
        }
    }

    private func providerSymbol(_ provider: String) -> String {
        switch provider.lowercased() {
        case "github": return "chevron.left.forwardslash.chevron.right"
        case "google": return "globe"
        default: return "person.crop.circle"
        }
    }
}
