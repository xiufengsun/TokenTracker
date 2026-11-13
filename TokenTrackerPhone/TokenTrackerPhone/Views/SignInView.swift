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
            AtmosphericGlassCanvas()

            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    brandHeader
                        .padding(.top, 28)

                    valuePillars

                    authActionsSection

                    if let warning = sessions.signOutError {
                        InlineNoticeBanner(
                            icon: "exclamationmark.triangle.fill",
                            tint: BrandPalette.amber,
                            message: warning
                        )
                    }

                    if let errorMessage {
                        InlineNoticeBanner(
                            icon: "xmark.octagon.fill",
                            tint: BrandPalette.coral,
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
            BoltIcon(size: 30, color: BrandPalette.emerald)
                .frame(width: 60, height: 60)
                .glassEffect(.regular.tint(BrandPalette.emerald.opacity(0.22)), in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            VStack(alignment: .leading, spacing: 8) {
                Text("TokenTracker")
                    .font(.largeTitle.weight(.bold))
                    .tracking(-0.6)

                Text("Your AI coding usage, spend velocity, and rolling windows — synced from your computers.")
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
                    symbol: "chart.xyaxis.line",
                    tint: BrandPalette.emerald,
                    title: "Today's Spend & Token Pulse",
                    detail: "See cross-device costs, cache efficiency, and active coding sessions across Claude, Codex, Cursor, Muse, and more."
                )

                Divider()

                pillarRow(
                    symbol: "gauge.with.dots.needle.67percent",
                    tint: BrandPalette.amber,
                    title: "Rolling Windows & Burn Pace",
                    detail: "Track 5-hour bursts, 7-day rolling windows, and personal spend targets before hitting rate caps."
                )

                Divider()

                pillarRow(
                    symbol: "lock.shield",
                    tint: .teal,
                    title: "Privacy-First Companion",
                    detail: "Token counts only — prompts, code, and local API keys never leave your computers."
                )
            }
        }
    }

    private func pillarRow(symbol: String, tint: Color, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 34, height: 34)
                .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

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
                        HStack(spacing: 10) {
                            BrandProviderIcon(provider: provider)
                            Text("Continue with \(providerLabel(provider))")
                                .font(.body.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                    .accessibilityIdentifier("signin.oauth.\(provider.lowercased())")
                }

                Button {
                    errorMessage = nil
                    showEmailSheet = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "envelope")
                            .font(.body.weight(.medium))
                        Text("Sign in with Email")
                            .font(.body.weight(.medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.glass)
                .controlSize(.large)
                .accessibilityIdentifier("signin.email")
            }
        }
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
                            .foregroundStyle(BrandPalette.coral)
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
