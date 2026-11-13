import SwiftUI

/// Official provider marks for sign-in buttons.
/// Do not substitute SF Symbols (e.g. `globe` or `chevron.left.forwardslash.chevron.right`) —
/// those look like knockoffs. These assets match the dashboard LoginCard marks:
/// GitHub's official Mark and Google's official four-color G.
struct BrandProviderIcon: View {
    let provider: String
    var size: CGFloat = 18

    var body: some View {
        icon
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var icon: some View {
        switch provider.lowercased() {
        case "github":
            Image("GitHubMark")
                .resizable()
                .renderingMode(.template)
                .aspectRatio(contentMode: .fit)
        case "google":
            Image("GoogleG")
                .resizable()
                .renderingMode(.original)
                .aspectRatio(contentMode: .fit)
        default:
            Image(systemName: "person.crop.circle")
                .resizable()
                .scaledToFit()
        }
    }
}
