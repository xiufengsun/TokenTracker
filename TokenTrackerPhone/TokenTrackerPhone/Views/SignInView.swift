import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @EnvironmentObject private var sessions: SessionStore
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @Environment(\.openURL) private var openURL

    @State private var providers: [String] = ["github", "google"]
    @State private var email = ""
    @State private var password = ""
    @State private var showEmailSheet = false
    @State private var busy = false
    @State private var errorMessage: String?

    private let auth = CloudAuthClient()

    var body: some View {
        ZStack {
            AppBackground()

            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    brandHeader
                        .padding(.top, 28)

                    valuePillars

                    authActionsSection

                    if let warning = sessions.signOutError {
                        InlineNoticeBanner(
                            icon: "exclamationmark.triangle.fill",
                            tint: Palette.warning,
                            message: warning
                        )
                    }

                    if let errorMessage {
                        InlineNoticeBanner(
                            icon: "xmark.octagon.fill",
                            tint: Palette.critical,
                            message: errorMessage
                        )
                    }

                    privacyFooter
                }
                .padding(.horizontal, 22)
                .padding(.bottom, 32)
            }
            .scrollDismissesKeyboard(.interactively)
            .disabled(busy)

            if busy {
                ProgressView("Signing in…")
                    .padding(.horizontal, 22)
                    .padding(.vertical, 16)
                    .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
        .sheet(isPresented: $showEmailSheet) {
            emailSignInSheet
        }
        .task {
            await loadProviders()
        }
    }

    private var brandHeader: some View {
        VStack(alignment: .leading, spacing: 16) {
            TokenTrackerMark(size: 64)

            VStack(alignment: .leading, spacing: 8) {
                Text("Token Tracker")
                    .font(.largeTitle.weight(.bold))
                    .tracking(-0.6)

                Text("Your AI coding usage and spend, synced from your computers to TokenTracker Cloud.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var valuePillars: some View {
        TelemetrySurface(padding: 18) {
            VStack(alignment: .leading, spacing: 16) {
                pillarRow(
                    symbol: "chart.bar.xaxis",
                    title: "Usage across every computer",
                    detail: "Estimated cost, tokens, and sessions from Claude Code, Codex, Cursor, Muse Code, and more."
                )

                Divider()

                pillarRow(
                    symbol: "gauge.with.dots.needle.67percent",
                    title: "Pace against your own targets",
                    detail: "Rolling 5-hour, 7-day, and 30-day windows, compared with spend targets you set on this iPhone."
                )

                Divider()

                pillarRow(
                    symbol: "lock.shield",
                    title: "Token counts only",
                    detail: "Prompts, code, and provider keys never leave your computers."
                )
            }
        }
    }

    private func pillarRow(symbol: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.body.weight(.medium))
                .foregroundStyle(.primary)
                .frame(width: 34, height: 34)
                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var authActionsSection: some View {
        GlassEffectContainer(spacing: 12) {
            VStack(spacing: 12) {
                ForEach(providers, id: \.self) { provider in
                    Button {
                        Task { await signInWithOAuth(provider) }
                    } label: {
                        signInLabel {
                            BrandProviderIcon(provider: provider, size: 20)
                        } title: {
                            "Continue with \(providerLabel(provider))"
                        }
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                    .accessibilityIdentifier("signin.oauth.\(provider.lowercased())")
                }

                Button {
                    errorMessage = nil
                    showEmailSheet = true
                } label: {
                    signInLabel {
                        Image(systemName: "envelope")
                            .font(.body.weight(.medium))
                            .frame(width: 20, height: 20)
                    } title: {
                        "Continue with Email"
                    }
                }
                .buttonStyle(.glass)
                .controlSize(.large)
                .accessibilityIdentifier("signin.email")
            }
        }
    }

    /// Icon + title centered together, label ink, same height for every provider.
    private func signInLabel<Icon: View>(
        @ViewBuilder icon: () -> Icon,
        title: () -> String
    ) -> some View {
        HStack(spacing: 10) {
            icon()
            Text(title())
                .font(.body.weight(.semibold))
        }
        .foregroundStyle(.primary)
        .frame(maxWidth: .infinity, minHeight: 30)
    }

    private var privacyFooter: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Requires an account with synced TokenTracker Cloud data from macOS, Windows, Linux, or the CLI.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Button {
                openURL(CloudConfig.privacyPolicyURL)
            } label: {
                Label("Privacy Policy", systemImage: "hand.raised")
                    .font(.caption.weight(.medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.top, 4)
    }

    private var emailSignInSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email address", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .onSubmit {
                            Task { await signInWithPassword() }
                        }
                } footer: {
                    Text("Use the same email and password registered with your TokenTracker account.")
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.circle.fill")
                            .foregroundStyle(Palette.critical)
                            .font(.footnote)
                    }
                }

                Section {
                    Button {
                        Task { await signInWithPassword() }
                    } label: {
                        HStack {
                            Spacer()
                            if busy {
                                ProgressView()
                            } else {
                                Text("Sign In")
                                    .fontWeight(.semibold)
                            }
                            Spacer()
                        }
                    }
                    .disabled(busy || email.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                }
            }
            .navigationTitle("Email Sign-In")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showEmailSheet = false
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - Auth Actions

    private func loadProviders() async {
        guard let config = try? await auth.publicConfig() else { return }
        let supported = config.oAuthProviders.filter { ["github", "google"].contains($0.lowercased()) }
        if !supported.isEmpty {
            providers = supported
        }
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
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces)
        guard !trimmedEmail.isEmpty, !password.isEmpty else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let response = try await auth.signIn(email: trimmedEmail, password: password)
            try sessions.signIn(with: response)
            password = ""
            showEmailSheet = false
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

}
