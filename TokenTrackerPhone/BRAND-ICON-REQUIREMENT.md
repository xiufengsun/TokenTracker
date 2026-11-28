# Sign-in button icons (do not regress)

The original PR #1114 used incorrect SF Symbol stand-ins on the login buttons:

- GitHub: `chevron.left.forwardslash.chevron.right` (generic code brackets)
- Google: `globe` (generic globe)

These look fake and must not be used.

Use the official brand marks already shipped in the Token Tracker dashboard `LoginCard.jsx`:

- GitHub: official GitHub Mark (octocat silhouette), asset `GitHubMark`, template-tinted to the button label color
- Google: official four-color G, asset `GoogleG`, always rendered in original colors (never tinted, never replaced with a globe or "G" glyph)
- Email: system `envelope` is fine, because email is not a brand logo

Swift helper: `BrandProviderIcon`. If you rewrite `SignInView`, keep `BrandProviderIcon` (or the same asset images). Do not go back to `providerSymbol` / `Image(systemName:)`.
