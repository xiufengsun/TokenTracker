import SwiftUI

/// Shown inside the Dashboard window when the WKWebView cannot reach the local
/// server after every retry. Without it the loading overlay stays up forever and
/// the only way out is quitting the app (issue #557).
struct DashboardLoadFailureView: View {
    let reason: String
    let onRetry: () -> Void

    @ObservedObject private var localization = LocalizationObserver.shared

    init(reason: String, onRetry: @escaping () -> Void) {
        self.reason = reason
        self.onRetry = onRetry
    }

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "bolt.trianglebadge.exclamationmark")
                .font(.system(size: 34))
                .foregroundStyle(.secondary)
            Text(Strings.dashboardLoadFailedTitle)
                .font(.headline)
            Text(Strings.dashboardLoadFailedReason(reason))
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            Text(Strings.dashboardLoadFailedProxyHint)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
            Button(Strings.retryButton) {
                onRetry()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.top, 4)
        }
        .padding(.horizontal, 48)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .id(localization.revision)
    }
}
