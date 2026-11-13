import SwiftUI

// MARK: - Cloud Access Required State (App Store 3.1.3(f) Compliant)

struct CloudAccessBlockedView: View {
    @EnvironmentObject private var sessions: SessionStore
    let code: String
    let isBusy: Bool
    let onRetry: () -> Void
    var onPairCLI: (() -> Void)? = nil

    var body: some View {
        ZStack {
            AppBackground()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 14) {
                        TokenTrackerMark(size: 60)
                            .overlay(alignment: .bottomTrailing) {
                                Image(systemName: iconName)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(.primary)
                                    .frame(width: 30, height: 30)
                                    .glassEffect(.regular, in: Circle())
                                    .offset(x: 8, y: 8)
                            }

                        Text(headline)
                            .font(.title.weight(.bold))

                        Text(explanation)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 20)

                    TelemetrySurface(padding: 18) {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("How TokenTracker on iPhone Works")
                                .font(.subheadline.weight(.semibold))

                            stepRow(
                                number: "1",
                                title: "Computers Track Locally",
                                body: "TokenTracker CLI or the desktop app parses token usage on macOS, Windows, or Linux."
                            )

                            Divider()

                            stepRow(
                                number: "2",
                                title: "Cloud Sync Aggregates Devices",
                                body: "Accounts with active Cloud access sync hourly token and model summaries across machines."
                            )

                            Divider()

                            stepRow(
                                number: "3",
                                title: "iPhone Reads Your Synced Ledger",
                                body: "Sign in with an enabled Cloud account—or switch accounts below—to view usage and pacing here."
                            )
                        }
                    }

                    if let user = sessions.session?.user {
                        TelemetrySurface(padding: 14) {
                            HStack(spacing: 12) {
                                Image(systemName: "person.crop.circle.badge.exclamationmark")
                                    .font(.title3)
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(user.name ?? user.email ?? "Signed-in account")
                                        .font(.subheadline.weight(.medium))
                                    if let email = user.email, user.name != nil {
                                        Text(email)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Text(statusBadge)
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(Color.primary.opacity(0.07), in: Capsule())
                            }
                        }
                    }

                    // Strict App Store 3.1.3(f) compliance: no pricing, no upgrade prompt, no external purchase URL.
                    GlassEffectContainer(spacing: 12) {
                        VStack(spacing: 12) {
                            Button(action: onRetry) {
                                HStack(spacing: 8) {
                                    if isBusy {
                                        ProgressView()
                                    } else {
                                        Image(systemName: "arrow.clockwise")
                                    }
                                    Text("Check Access Again")
                                        .fontWeight(.semibold)
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 6)
                            }
                            .primaryGlassButton()
                            .controlSize(.large)
                            .disabled(isBusy)

                            if let onPairCLI {
                                Button(action: onPairCLI) {
                                    Label("Authorize a CLI Pairing Code", systemImage: "terminal")
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 5)
                                }
                                .buttonStyle(.glass)
                                .controlSize(.large)
                            }

                            Button(role: .destructive) {
                                Task { await sessions.signOut() }
                            } label: {
                                Label("Sign Out or Switch Account", systemImage: "rectangle.portrait.and.arrow.right")
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 5)
                            }
                            .buttonStyle(.glass)
                            .controlSize(.large)
                        }
                    }
                }
                .padding(.horizontal, 22)
                .padding(.bottom, 32)
            }
        }
    }

    private var iconName: String {
        code == "cloud_read_only_expired" ? "clock.badge.exclamationmark" : "icloud.slash"
    }

    private var headline: String {
        switch code {
        case "cloud_read_only_expired":
            return "Cloud Read Window Ended"
        case "cloud_history_window_exceeded":
            return "Outside History Window"
        default:
            return "Cloud Sync Access Required"
        }
    }

    private var statusBadge: String {
        code == "cloud_read_only_expired" ? "Expired" : "No Cloud Read"
    }

    private var explanation: String {
        switch code {
        case "cloud_read_only_expired":
            return "This account's Cloud read-only retention window has ended, so synced usage history is not currently readable on iPhone."
        case "cloud_history_window_exceeded":
            return "The selected date range precedes your account's readable Cloud history window."
        default:
            return "TokenTracker for iPhone is a Cloud companion and does not collect data on this device. This account does not currently have active TokenTracker Cloud read access."
        }
    }

    private func stepRow(number: String, title: String, body: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number)
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(.primary)
                .frame(width: 24, height: 24)
                .background(Color.primary.opacity(0.08), in: Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                Text(body)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - Empty Synced Usage State (Cloud Active, 0 Synced Tokens Yet)

struct EmptySyncedDataCard: View {
    let onPairCLI: () -> Void
    let onRefresh: () -> Void

    var body: some View {
        TelemetrySurface(padding: 20) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 46, height: 46)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                    VStack(alignment: .leading, spacing: 3) {
                        Text("Waiting for Your First Sync")
                            .font(.headline)
                        Text("Your Cloud account is ready, with no coding usage uploaded in this window yet.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("On your Mac, Windows, or Linux machine:")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    Text("npx tokentracker@latest init")
                        .font(.footnote.monospaced())
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                    Text("Enable Cloud Sync in the desktop app or run `tokentracker login` in your terminal, then approve the 8-character code right from this phone.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 10) {
                    Button(action: onPairCLI) {
                        Label("Approve CLI Code", systemImage: "terminal")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .primaryGlassButton()

                    Button(action: onRefresh) {
                        Label("Refresh", systemImage: "arrow.clockwise")
                            .font(.subheadline.weight(.medium))
                    }
                    .buttonStyle(.glass)
                }
            }
        }
    }
}

// MARK: - Full-Screen Error Recovery State

struct WorkspaceFailureView: View {
    let message: String
    let isBusy: Bool
    let onRetry: () -> Void
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Spacer(minLength: 40)

            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 32, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 68, height: 68)
                .glassEffect(.regular, in: Circle())

            VStack(spacing: 8) {
                Text("Couldn't Reach TokenTracker Cloud")
                    .font(.title3.weight(.bold))
                    .multilineTextAlignment(.center)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 12)
            }

            GlassEffectContainer(spacing: 12) {
                HStack(spacing: 12) {
                    Button(action: onRetry) {
                        HStack(spacing: 6) {
                            if isBusy { ProgressView() }
                            Text("Try Again")
                                .fontWeight(.semibold)
                        }
                        .padding(.horizontal, 10)
                    }
                    .primaryGlassButton()
                    .controlSize(.large)
                    .disabled(isBusy)

                    Button("Settings", action: onOpenSettings)
                        .buttonStyle(.glass)
                        .controlSize(.large)
                }
            }

            Spacer(minLength: 40)
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Skeleton Loading Shimmer

struct WorkspaceSkeletonView: View {
    var body: some View {
        VStack(spacing: 16) {
            TelemetrySurface(padding: 20) {
                VStack(alignment: .leading, spacing: 14) {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.primary.opacity(0.08))
                        .frame(width: 110, height: 14)
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Color.primary.opacity(0.12))
                        .frame(width: 180, height: 42)
                    HStack(spacing: 16) {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color.primary.opacity(0.08))
                            .frame(height: 38)
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color.primary.opacity(0.08))
                            .frame(height: 38)
                    }
                }
            }

            TelemetrySurface(padding: 18) {
                VStack(alignment: .leading, spacing: 12) {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.primary.opacity(0.08))
                        .frame(width: 140, height: 14)
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color.primary.opacity(0.07))
                        .frame(height: 150)
                }
            }

            TelemetrySurface(padding: 18) {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(0..<3, id: \.self) { _ in
                        HStack {
                            Circle()
                                .fill(Color.primary.opacity(0.09))
                                .frame(width: 28, height: 28)
                            RoundedRectangle(cornerRadius: 6)
                                .fill(Color.primary.opacity(0.08))
                                .frame(width: 120, height: 14)
                            Spacer()
                            RoundedRectangle(cornerRadius: 6)
                                .fill(Color.primary.opacity(0.09))
                                .frame(width: 60, height: 14)
                        }
                    }
                }
            }
        }
        .redacted(reason: .placeholder)
    }
}
