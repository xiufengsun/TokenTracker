import CoreTransferable
import SwiftUI
import UniformTypeIdentifiers

/// iPhone counterpart of dashboard/src/ui/share/ShareModal.tsx: preview the
/// poster, pick Neon or Broadsheet, edit the display name, then hand a PNG
/// rendered on this iPhone to the system share sheet (Save Image, Copy, X, …).
struct ShareCardSheet: View {
    @Environment(\.dismiss) private var dismiss
    let data: ShareCardData
    let caption: String
    let profileURL: URL
    var initialVariant: ShareCardVariant = .neon

    @State private var variant: ShareCardVariant = .neon
    @State private var handle = ""
    @State private var rendered: SharePNG?

    private var cardData: ShareCardData {
        var copy = data
        let trimmed = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { copy.handle = trimmed }
        return copy
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                preview
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                GlassSegmentedControl(
                    items: ShareCardVariant.allCases,
                    selection: $variant,
                    label: \.label,
                    identifierPrefix: "share.variant"
                )

                TextField("Display name", text: $handle)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                shareButton

                Text("Generated on this iPhone. Not uploaded.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
            .background(Color(.systemGroupedBackground).ignoresSafeArea())
            .navigationTitle("Share")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .onAppear {
                variant = initialVariant
                if handle.isEmpty { handle = data.handle }
            }
            .task(id: RenderKey(variant: variant, handle: handle)) {
                // Debounced so typing a name does not re-render a 2160 px poster per keystroke.
                try? await Task.sleep(for: .milliseconds(rendered == nil ? 0 : 250))
                guard !Task.isCancelled else { return }
                rendered = ShareCardRenderer.render(cardData, variant: variant)
            }
        }
        .presentationDragIndicator(.visible)
    }

    private struct RenderKey: Hashable {
        let variant: ShareCardVariant
        let handle: String
    }

    @ViewBuilder
    private var preview: some View {
        if let rendered, rendered.variant == variant {
            Image(uiImage: rendered.image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
                .accessibilityLabel("\(variant.label) share card")
        } else {
            ProgressView()
        }
    }

    @ViewBuilder
    private var shareButton: some View {
        if let rendered, rendered.variant == variant {
            ShareLink(
                item: rendered,
                subject: Text("Token Tracker"),
                message: Text("\(caption) \(profileURL.absoluteString)"),
                preview: SharePreview("Token Tracker", image: Image(uiImage: rendered.image))
            ) {
                Label("Share", systemImage: "square.and.arrow.up")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .primaryGlassButton()
            .controlSize(.large)
            .accessibilityIdentifier("share.send")
        } else {
            Button {} label: {
                Label("Share", systemImage: "square.and.arrow.up")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .primaryGlassButton()
            .controlSize(.large)
            .disabled(true)
        }
    }
}

/// The PNG handed to the share sheet.
struct SharePNG: Transferable, Equatable {
    let variant: ShareCardVariant
    let image: UIImage
    let png: Data

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .png) { $0.png }
            .suggestedFileName("tokentracker-share.png")
    }

    static func == (lhs: SharePNG, rhs: SharePNG) -> Bool {
        lhs.variant == rhs.variant && lhs.png == rhs.png
    }
}

enum ShareCardRenderer {
    /// Renders the poster at 2× its canvas, the dashboard's capture pixel ratio.
    @MainActor
    static func render(_ data: ShareCardData, variant: ShareCardVariant, scale: CGFloat = 2) -> SharePNG? {
        let renderer = ImageRenderer(content: card(data, variant: variant))
        renderer.scale = scale
        renderer.proposedSize = ProposedViewSize(variant.size)
        renderer.isOpaque = true
        guard let image = renderer.uiImage, let png = image.pngData() else { return nil }
        return SharePNG(variant: variant, image: image, png: png)
    }

    @ViewBuilder
    static func card(_ data: ShareCardData, variant: ShareCardVariant) -> some View {
        switch variant {
        case .neon: NeonShareCard(data: data)
        case .broadsheet: BroadsheetShareCard(data: data)
        }
    }
}
