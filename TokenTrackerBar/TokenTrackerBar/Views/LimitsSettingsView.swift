import SwiftUI
import AppKit

struct LimitsSettingsView: View {
    @ObservedObject var store: LimitsSettingsStore
    @Environment(\.colorScheme) private var colorScheme
    @State private var draggingId: String?
    @AppStorage(WeeklyLimitResetDetector.toastEnabledKey) private var toastOnReset = WeeklyLimitResetDetector.toastEnabledDefault
    @AppStorage(WeeklyLimitResetDetector.confettiEnabledKey) private var confettiOnReset = WeeklyLimitResetDetector.confettiEnabledDefault

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(Strings.limitsDisplayTitle)
                .font(.system(.headline, design: .default))
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 6)

            HStack(spacing: 10) {
                Text(Strings.limitDisplayModeRemaining)
                    .font(.system(.body, design: .default))
                    .foregroundStyle(.primary)
                Spacer()
                Toggle("", isOn: Binding(
                    get: { store.displayMode == .remaining },
                    set: { store.setDisplayModeFromMenu($0 ? .remaining : .used) }
                ))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .accessibilityLabel(Strings.limitDisplayModeRemaining)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            // Workaround for Xcode 16 SwiftUICore linking bug
            Text("")
                .tag(0)
                .frame(width: 0, height: 0)

            HStack(spacing: 10) {
                Text(Strings.toastOnResetLabel)
                    .font(.system(.body, design: .default))
                    .foregroundStyle(.primary)
                Spacer()
                Toggle("", isOn: $toastOnReset)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .labelsHidden()
                    .accessibilityLabel(Strings.toastOnResetLabel)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            HStack(spacing: 10) {
                Text(Strings.confettiOnResetLabel)
                    .font(.system(.body, design: .default))
                    .foregroundStyle(.primary)
                Spacer()
                Toggle("", isOn: $confettiOnReset)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .labelsHidden()
                    .accessibilityLabel(Strings.confettiOnResetLabel)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            HStack(spacing: 10) {
                Text(Strings.showSubscriptionsLabel)
                    .font(.system(.body, design: .default))
                    .foregroundStyle(.primary)
                Spacer()
                Toggle("", isOn: Binding(
                    get: { store.showSubscriptions },
                    set: { store.setShowSubscriptionsFromMenu($0) }
                ))
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .labelsHidden()
                    .accessibilityLabel(Strings.showSubscriptionsLabel)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Divider()
                .opacity(0.35)
                .padding(.bottom, 2)

            VStack(spacing: 0) {
                ForEach(store.providerOrder, id: \.self) { id in
                    providerRow(id: id)
                        .opacity(draggingId == id ? 0.4 : 1)
                        .onDrag {
                            draggingId = id
                            return NSItemProvider(object: id as NSString)
                        }
                        .onDrop(of: [.text], delegate: ReorderDropDelegate(
                            targetId: id,
                            store: store,
                            draggingId: $draggingId
                        ))
                }
            }
            .padding(.bottom, 6)
        }
        .frame(width: 240)
    }

    private func providerRow(id: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "line.3.horizontal")
                .font(.caption)
                .foregroundStyle(.tertiary)

            providerIcon(id: id)
                .frame(width: 14, height: 14)

            Text(LimitsSettingsStore.displayNames[id] ?? id)
                .font(.system(.body, design: .default))

            Spacer()

            Toggle("", isOn: Binding(
                get: { store.isVisible(id) },
                set: { store.setProviderVisibilityFromMenu(id, isVisible: $0) }
            ))
            .toggleStyle(.switch)
            .controlSize(.mini)
            .labelsHidden()
            .accessibilityLabel(LimitsSettingsStore.displayNames[id] ?? id)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .onHover { hovering in
            if hovering {
                NSCursor.openHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }

    // MARK: - Provider Icon (handles both asset catalog and bundled SVG)

    @ViewBuilder
    private func providerIcon(id: String) -> some View {
        switch id {
        case "cursor", "kimi", "kiro", "grok", "copilot", "zcode", "opencodeGo", "commandCode", "qoder", "qoderCn", "codingPlan", "agentPlan", "devin", "workbuddy", "workbuddyAi", "doubao":
            let filename: String = {
                switch id {
                case "cursor": return "cursor.svg"
                case "kimi": return "kimi.svg"
                case "kiro": return "kiro.svg"
                case "grok": return "grok.svg"
                case "zcode": return "zcode.svg"
                case "opencodeGo": return "opencode.svg"
                case "commandCode": return "commandcode.svg"
                case "qoder": return "qoder.svg"
                case "qoderCn": return "qoder-cn.svg"
                case "codingPlan": return "volcano-ark.svg"
                case "agentPlan": return "volcano-ark.svg"
                case "devin": return "devin.svg"
                case "workbuddy": return "codebuddy.svg"
                case "workbuddyAi": return "codebuddy.svg"
                case "doubao": return "doubao.svg"
                default: return "copilot.svg"
                }
            }()
            if let image = bundledSVGIcon(named: filename, color: colorScheme == .dark ? "#FFFFFF" : "#111111") {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                Color.clear
            }
        default:
            if let iconName = LimitsSettingsStore.iconNames[id] {
                Image(iconName)
                    .renderingMode(.original)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                Color.clear
            }
        }
    }

    private func bundledSVGIcon(named filename: String, color: String) -> NSImage? {
        guard let url = Bundle.main.resourceURL?
            .appendingPathComponent("EmbeddedServer/tokentracker/dashboard/dist/brand-logos/\(filename)"),
              var svg = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        svg = svg.replacingOccurrences(of: "currentColor", with: color)

        // Normalize width/height to 24
        let widthPattern = #"width\s*=\s*"[^"]*""#
        let heightPattern = #"height\s*=\s*"[^"]*""#
        svg = svg.replacingOccurrences(of: widthPattern, with: #"width="24""#, options: .regularExpression)
        svg = svg.replacingOccurrences(of: heightPattern, with: #"height="24""#, options: .regularExpression)

        guard let data = svg.data(using: .utf8),
              let image = NSImage(data: data) else { return nil }
        image.size = NSSize(width: 24, height: 24)
        image.isTemplate = false
        return image
    }
}

// MARK: - Smooth Reorder via DropDelegate

private struct ReorderDropDelegate: DropDelegate {
    let targetId: String
    let store: LimitsSettingsStore
    @Binding var draggingId: String?

    func dropEntered(info: DropInfo) {
        guard let dragging = draggingId,
              dragging != targetId,
              let from = store.providerOrder.firstIndex(of: dragging),
              let to = store.providerOrder.firstIndex(of: targetId) else { return }

        withAnimation(.easeInOut(duration: 0.2)) {
            store.moveProviderFromMenu(from: IndexSet(integer: from), to: to > from ? to + 1 : to)
        }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }

    func performDrop(info: DropInfo) -> Bool {
        draggingId = nil
        return true
    }

    func dropExited(info: DropInfo) {}

    func validateDrop(info: DropInfo) -> Bool { true }
}
