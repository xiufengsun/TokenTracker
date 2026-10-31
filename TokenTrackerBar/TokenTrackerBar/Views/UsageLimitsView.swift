import SwiftUI
import AppKit

struct UsageLimitsView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject private var settings = LimitsSettingsStore.shared
    @State private var showSettings = false
    /// Width of the widest visible row label; all label columns match it so
    /// bars align without reserving space for labels that aren't on screen.
    @State private var labelColumnWidth: CGFloat = 0
    /// Width of the widest trailing reset label ("5d", "已过期", …); reset
    /// columns match it so bars also share the same right edge.
    @State private var resetColumnWidth: CGFloat = 0
    /// Provider id whose explanation popover is open. Each provider block is
    /// clickable (CodexBar-style); clicking opens a side popover that explains how
    /// to read its bars. A click toggle — not hover — so nothing reflows/jitters.
    @State private var explainingProvider: String?
    let limits: UsageLimitsResponse?
    var subscriptions: [SubscriptionRecord] = []

    private static let rowColumnSpacing: CGFloat = 5
    private static let percentColumnWidth: CGFloat = 34
    /// Floor for the trailing reset column; it grows with the widest reset
    /// label (see `resetColumnWidth`) but never gets narrower than this.
    private static let relativeResetColumnWidth: CGFloat = 24
    /// Upper bound for the shared label column. A label past it truncates with
    /// an ellipsis (full text stays in the row tooltip) instead of squeezing
    /// every row's bar — model + plan names can run well past this width.
    /// 60pt keeps labels to a short recognizable prefix so long names barely
    /// affect bar width (reporter-chosen value).
    private static let labelColumnMaxWidth: CGFloat = 60

    /// Measured reset-column width with the fixed floor applied. Before the
    /// first measurement lands it equals the old fixed width, so reset rows
    /// lay out exactly as before on the first pass.
    private var effectiveResetColumnWidth: CGFloat {
        max(resetColumnWidth, Self.relativeResetColumnWidth)
    }

    /// Reset-bank rows show one wider trailing column (expiry) where the limit
    /// rows show the percent + reset pair; keeping it equal to that pair's
    /// total width makes every bar in the section share the same right edge.
    private var resetExpiryColumnWidth: CGFloat {
        Self.percentColumnWidth + Self.rowColumnSpacing + effectiveResetColumnWidth
    }

    /// At least one provider is configured and error-free.
    /// Delegates to the model helper (single source of truth for the predicate).
    private func hasAnyAvailable(_ limits: UsageLimitsResponse) -> Bool {
        limits.hasAnyProviderWithoutError
    }

    /// Provider id → the asset name `brandIcon` expects. Mirrors the
    /// per-provider `assetName` arguments in `sectionIfContent`, so a provider
    /// with no usable quota record can still render its own logo.
    private static let providerIconAssetNames: [String: String] = [
        "claude": "ClaudeLogo",
        "codex": "CodexLogo",
        "cursor": "CursorLogo",
        "gemini": "GeminiLogo",
        "kimi": "KimiLogo",
        "kiro": "KiroLogo",
        "grok": "GrokLogo",
        "copilot": "CopilotLogo",
        "antigravity": "AntigravityLogo",
        "zcode": "ZcodeLogo",
        "opencodeGo": "OpenCodeLogo",
        "commandCode": "CommandCodeLogo",
        "qoder": "QoderLogo",
        "qoderCn": "QoderCnLogo",
        "codingPlan": "VolcanoArkLogo",
        "agentPlan": "VolcanoArkLogo",
        "devin": "DevinLogo",
        "workbuddy": "CodeBuddyLogo",
        "workbuddyAi": "CodeBuddyLogo",
    ]

    var body: some View {
        if let limits {
            let visibleGroups = buildVisibleGroups(limits)

            // A response with no usable quota record still has something to
            // show when the user linked a subscription to one of its providers:
            // `visibleGroups` then carries subscription-only sections.
            if hasAnyAvailable(limits) || !visibleGroups.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(title: "\(Strings.usageLimitsTitle) · \(displayModeTitle)") {
                        SettingsGearButton(isPresented: $showSettings) {
                            LimitsSettingsView(store: settings)
                        }
                    }

                    if visibleGroups.isEmpty {
                        // Missing quota content does not mean the user hid it.
                        if LimitsSettingsStore.allProviders.allSatisfy({ !settings.isVisible($0) }) {
                            Text(Strings.allProvidersHidden)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    } else {
                        ForEach(Array(visibleGroups.enumerated()), id: \.offset) { index, group in
                            if index > 0 {
                                Divider()
                                    .opacity(0.4)
                                    .padding(.vertical, 2)
                            }
                            group
                        }
                    }
                }
                .onPreferenceChange(LimitLabelWidthKey.self) { labelColumnWidth = ceil($0) }
                .onPreferenceChange(LimitResetWidthKey.self) { resetColumnWidth = ceil($0) }
            }
        } else {
            LimitsSkeleton()
        }
    }

    // MARK: - Visible Groups (respect settings order + visibility, hide errors)

    /// Append the plan tier to the provider name when known, e.g. "Claude Max".
    private func planTitle(_ base: String, _ label: String?) -> String {
        label.map { "\(base) \($0)" } ?? base
    }

    private var subscriptionByProvider: [String: SubscriptionRecord] {
        guard settings.showSubscriptions else { return [:] }
        let nowMs = Date().timeIntervalSince1970 * 1000.0
        var map: [String: SubscriptionRecord] = [:]
        for sub in subscriptions {
            guard let provider = sub.provider, !provider.isEmpty else { continue }
            guard let endMs = SubscriptionCycle.parseDateMs(sub.nextBillingAt) else { continue }
            guard sub.provider != nil else { continue }
            let existing = map[provider]
            if existing == nil {
                map[provider] = sub
                continue
            }
            guard let existingEnd = SubscriptionCycle.parseDateMs(existing!.nextBillingAt) else {
                map[provider] = sub
                continue
            }
            let upcoming = endMs > nowMs
            let existingUpcoming = existingEnd > nowMs
            if (upcoming && (!existingUpcoming || existingEnd > endMs)) ||
               (!upcoming && !existingUpcoming && endMs > existingEnd) {
                map[provider] = sub
            }
        }
        return map
    }

    private func buildVisibleGroups(_ limits: UsageLimitsResponse) -> [AnyView] {
        settings.providerOrder.compactMap { sectionIfContent(id: $0, limits: limits) }
    }

    /// Builds one provider's section, or nil when it would carry no quota rows
    /// and no manual subscription/reset/status content — an empty heading is
    /// never collected. Shared rule for every provider, not a per-provider
    /// symptom guard.
    private func sectionIfContent(id: String, limits: UsageLimitsResponse) -> AnyView? {
        guard settings.isVisible(id) else { return nil }

        switch id {
        case "claude" where limits.claude.configured && limits.claude.error == nil:
            return toolSection(id: id, title: planTitle("Claude", limits.claude.planLabel), assetName: "ClaudeLogo", toolName: "Claude", specs: claudeSpecs(limits.claude), updatedAtISO: limits.claude.cachedAt, isStale: limits.claude.stale ?? false, retryAtISO: limits.claude.retryAt, serviceStatus: limits.claude.serviceStatus)
        case "codex" where limits.codex.configured && limits.codex.error == nil:
            let resetState = codexResetBankViewData(limits.codex.resetCredits)
            return toolSection(id: id, title: planTitle("Codex", limits.codex.planLabel), assetName: "CodexLogo", toolName: "Codex", specs: codexSpecs(limits.codex), resetRows: resetState.rows, resetStatus: resetState.statusText, updatedAtISO: limits.codex.cachedAt, isStale: limits.codex.stale ?? false)
        case "cursor" where limits.cursor.configured && limits.cursor.error == nil:
            return toolSection(id: id, title: planTitle("Cursor", limits.cursor.planLabel), assetName: "CursorLogo", toolName: "Cursor", specs: cursorSpecs(limits.cursor))
        case "gemini" where limits.gemini.configured && limits.gemini.error == nil:
            return toolSection(id: id, title: planTitle("Gemini", limits.gemini.planLabel), assetName: "GeminiLogo", toolName: "Gemini", specs: geminiSpecs(limits.gemini))
        case "kimi":
            if let kimi = limits.kimi, kimi.configured, kimi.error == nil {
                return toolSection(id: id, title: planTitle("Kimi", kimi.planLabel), assetName: "KimiLogo", toolName: "Kimi", specs: kimiSpecs(kimi), titleSuffix: kimi.parallelLimit.map { "· \(Strings.kimiParallelLabel($0))" })
            }
        case "kiro" where limits.kiro.configured && limits.kiro.error == nil:
            return toolSection(id: id, title: planTitle("Kiro", limits.kiro.planLabel), assetName: "KiroLogo", toolName: "Kiro", specs: kiroSpecs(limits.kiro))
        case "grok":
            if let grok = limits.grok, grok.configured, grok.error == nil {
                return toolSection(id: id, title: planTitle("Grok Build", grok.planLabel), assetName: "GrokLogo", toolName: "Grok Build", specs: grokSpecs(grok))
            }
        case "antigravity" where limits.antigravity.configured && limits.antigravity.error == nil:
            return toolSection(id: id, title: planTitle("Antigravity", limits.antigravity.planLabel), assetName: "AntigravityLogo", toolName: "Antigravity", specs: antigravitySpecs(limits.antigravity))
        case "copilot":
            if let copilot = limits.copilot, copilot.configured, copilot.error == nil {
                return toolSection(id: id, title: planTitle("GitHub Copilot", copilot.planLabel), assetName: "CopilotLogo", toolName: "GitHub Copilot", specs: copilotSpecs(copilot))
            }
        case "zcode":
            if let zcode = limits.zcode, zcode.configured, zcode.error == nil {
                return toolSection(
                    id: id,
                    title: planTitle("ZCode", zcode.planLabel),
                    assetName: "ZcodeLogo",
                    toolName: "ZCode",
                    specs: zcodeSpecs(zcode),
                    zcodeResetCredits: zcode.resetCredits,
                    zcodeStartPlan: zcode.startPlan
                )
            }
        case "opencodeGo":
            if let opencodeGo = limits.opencodeGo, opencodeGo.configured, opencodeGo.error == nil {
                return toolSection(id: id, title: planTitle("OpenCode Go", opencodeGo.planLabel), assetName: "OpenCodeLogo", toolName: "OpenCode Go", specs: opencodeGoSpecs(opencodeGo))
            }
        case "commandCode":
            if let commandCode = limits.commandCode, commandCode.configured, commandCode.error == nil {
                return toolSection(id: id, title: planTitle("Command Code", commandCode.planLabel), assetName: "CommandCodeLogo", toolName: "Command Code", specs: commandCodeSpecs(commandCode), updatedAtISO: commandCode.cachedAt, isStale: commandCode.stale ?? false)
            }
        case "qoder":
            if let qoder = limits.qoder, qoder.configured, qoder.error == nil {
                return toolSection(id: id, title: planTitle("Qoder", qoder.planLabel), assetName: "QoderLogo", toolName: "Qoder", specs: qoderSpecs(qoder), updatedAtISO: qoder.cachedAt, isStale: qoder.stale ?? false)
            }
        case "qoderCn":
            if let qoderCn = limits.qoderCn, qoderCn.configured, qoderCn.error == nil {
                return toolSection(id: id, title: planTitle("Qoder CN", qoderCn.planLabel), assetName: "QoderCnLogo", toolName: "Qoder CN", specs: qoderSpecs(qoderCn), updatedAtISO: qoderCn.cachedAt, isStale: qoderCn.stale ?? false)
            }
        case "codingPlan":
            if let codingPlan = limits.codingPlan, codingPlan.configured, codingPlan.error == nil {
                return toolSection(id: id, title: planTitle("Ark Coding Plan", codingPlan.planLabel), assetName: "VolcanoArkLogo", toolName: "Ark Coding Plan", specs: codingPlanSpecs(codingPlan), updatedAtISO: codingPlan.cachedAt, isStale: codingPlan.stale ?? false)
            }
        case "agentPlan":
            if let agentPlan = limits.agentPlan, agentPlan.configured, agentPlan.error == nil {
                return toolSection(id: id, title: planTitle("Ark Agent Plan", agentPlan.planLabel), assetName: "VolcanoArkLogo", toolName: "Ark Agent Plan", specs: agentPlanSpecs(agentPlan), updatedAtISO: agentPlan.cachedAt, isStale: agentPlan.stale ?? false)
            }
        case "devin":
            if let devin = limits.devin, devin.configured, devin.error == nil {
                return toolSection(id: id, title: planTitle("Devin", devin.planLabel), assetName: "DevinLogo", toolName: "Devin", specs: devinSpecs(devin), updatedAtISO: devin.cachedAt, isStale: devin.stale ?? false)
            }
        case "workbuddy":
            if let workbuddy = limits.workbuddy, workbuddy.configured, workbuddy.error == nil {
                return toolSection(id: id, title: planTitle("WorkBuddy", workbuddy.planLabel), assetName: "CodeBuddyLogo", toolName: "WorkBuddy", specs: workbuddySpecs(workbuddy), updatedAtISO: workbuddy.cachedAt, isStale: workbuddy.stale ?? false)
            }
        case "workbuddyAi":
            if let workbuddyAi = limits.workbuddyAi, workbuddyAi.configured, workbuddyAi.error == nil {
                return toolSection(id: id, title: planTitle("WorkBuddy AI", workbuddyAi.planLabel), assetName: "CodeBuddyLogo", toolName: "WorkBuddy AI", specs: workbuddySpecs(workbuddyAi), updatedAtISO: workbuddyAi.cachedAt, isStale: workbuddyAi.stale ?? false)
            }
        default:
            break
        }
        // No usable quota record for this provider (not connected, subscription
        // inactive, or a fetch error). A subscription the user entered by hand
        // still belongs on the panel: it is manual data, so its bar and date
        // must not disappear because the tool's own quota fetch failed.
        return subscriptionOnlySection(id: id)
    }

    /// Provider heading plus the subscription row, for providers whose quota
    /// data is unavailable. Deliberately carries no quota rows, no explanation
    /// popover and no status line — only the renewal progress the user entered.
    private func subscriptionOnlySection(id: String) -> AnyView? {
        guard let subscription = subscriptionByProvider[id] else { return nil }
        return AnyView(VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                if let assetName = Self.providerIconAssetNames[id] {
                    brandIcon(assetName)
                        .frame(width: 14, height: 14)
                }
                Text(LimitsSettingsStore.displayNames[id] ?? id)
                    .font(.system(.caption, design: .default))
                    .modifier(FontWeightModifier(weight: .medium))
                subscriptionBadge(subscription)
                Spacer()
            }
            VStack(spacing: 4) {
                subscriptionRow(for: subscription)
            }
        })
    }

    /// Auto-renew / stops-at-expiry glyph shown next to a provider's name.
    private func subscriptionBadge(_ subscription: SubscriptionRecord) -> some View {
        Image(systemName: subscription.autoRenew ? "infinity" : "clock")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(subscription.autoRenew ? Color.accentColor : Color.secondary)
            .help(subscription.autoRenew ? Strings.subscriptionAutoRenewBadge : Strings.subscriptionStopsBadge)
            .accessibilityLabel(subscription.autoRenew ? Strings.subscriptionAutoRenewBadge : Strings.subscriptionStopsBadge)
    }

    // MARK: - Tool Section

    private func toolSection(
        id: String,
        title: String,
        assetName: String?,
        toolName: String,
        specs: [LimitWindowSpec],
        resetRows: [CodexResetRowSpec] = [],
        resetStatus: String? = nil,
        zcodeResetCredits: ZcodeResetCredits? = nil,
        zcodeStartPlan: ZcodeStartPlan? = nil,
        /// Inline plan-spec text pinned to the right of the title (e.g. Kimi's
        /// "· Parallel: 20" concurrency cap). Renders caption2/tertiary so it
        /// reads as metadata, not part of the provider name.
        titleSuffix: String? = nil,
        // Provider's own last-fetch stamp (Claude/Codex); nil falls back to the
        // response-level `fetched_at`, which is when every live provider was read.
        updatedAtISO: String? = nil,
        isStale: Bool = false,
        // Active 429 cool-down expiry (Claude), when one is in effect — shown as the
        // "retrying" instant next to stale bars.
        retryAtISO: String? = nil,
        // Active status-page incident (Claude), rendered as a tappable row under the
        // bars so upstream outages explain themselves instead of reading as app bugs.
        serviceStatus: ProviderServiceStatus? = nil
    ) -> AnyView? {
        let subscription = subscriptionByProvider[id]
        let hasZcodeReset = zcodeResetBankHasContent(zcodeResetCredits)
        let hasZcodeStart = zcodeStartPlan?.configured == true
        // No quota rows and no subscription/reset/status content means there is
        // nothing meaningful under the heading — return nil rather than render
        // a bare provider title.
        guard !specs.isEmpty || subscription != nil || !resetRows.isEmpty
            || resetStatus != nil || serviceStatus != nil
            || hasZcodeReset || hasZcodeStart else {
            return nil
        }
        if subscription != nil && SubscriptionSectionPolicy.usesSubscriptionOnly(
            hasQuotaRows: !specs.isEmpty,
            hasResetContent: !resetRows.isEmpty || resetStatus != nil || hasZcodeReset || hasZcodeStart,
            hasServiceStatus: serviceStatus != nil
        ) {
            return subscriptionOnlySection(id: id)
        }
        let isOpen = Binding(
            get: { explainingProvider == id },
            set: { explainingProvider = $0 ? id : nil }
        )
        let updatedAt = resetDate(iso: updatedAtISO ?? limits?.fetchedAt)
        let retryAt = resetDate(iso: retryAtISO)
        return AnyView(VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                if let assetName {
                    brandIcon(assetName)
                        .frame(width: 14, height: 14)
                }
                Text(title)
                    .font(.system(.caption, design: .default))
                    .modifier(FontWeightModifier(weight: .medium))
                if let sub = subscription {
                    subscriptionBadge(sub)
                }
                if let titleSuffix {
                    Text(titleSuffix)
                        .font(.system(.caption2, design: .default))
                        .foregroundStyle(.tertiary)
                }
                Spacer()
            }
            VStack(spacing: 4) {
                ForEach(specs) { spec in
                    // The per-product split is detail: it shows only while this
                    // provider is clicked open; otherwise the bar is the whole pool.
                    let showSegments = explainingProvider == id && !spec.segments.isEmpty
                    limitRow(label: spec.label, pct: spec.pct, reset: spec.resetText, toolName: toolName, windowSeconds: spec.windowSeconds, resetDate: spec.resetDate, segments: spec.segments, showSegments: showSegments, creditsDetail: spec.creditsDetail)
                    if showSegments {
                        segmentLegend(
                            spec.segments,
                            pct: spec.pct,
                            note: settings.displayMode == .remaining && spec.productPool ? Strings.grokSharesAreUsed : nil
                        )
                    }
                }
                if let sub = subscription {
                    subscriptionRow(for: sub)
                }
            }
            if !resetRows.isEmpty || resetStatus != nil {
                resetSection(rows: resetRows, status: resetStatus)
            }
            if hasZcodeReset {
                zcodeResetBankSection(zcodeResetCredits)
            }
            if hasZcodeStart, let startPlan = zcodeStartPlan {
                zcodeStartPlanSection(startPlan, toolName: toolName)
            }
            if let serviceStatus {
                serviceStatusRow(serviceStatus)
            }
        }
        .modifier(ProviderClickableStyle(isActive: explainingProvider == id, isStale: isStale))
        .onTapGesture { explainingProvider = (explainingProvider == id) ? nil : id }
        .popover(isPresented: isOpen, arrowEdge: .trailing) {
            // Keep on one line: codex-reset-bank guardrail tests assert this exact
            // call shape to prove reset-bank rows never leak into the explanation.
            LimitsExplainContent(providerName: title, specs: specs, remainingMode: settings.displayMode == .remaining, updatedAt: updatedAt, isStale: isStale, retryAt: retryAt)
        })
    }

    // MARK: - Service status (status-page incident row)

    /// Incident severity dot color; mirrors Statuspage.io indicator levels.
    private func serviceStatusColor(_ indicator: String) -> Color {
        switch indicator {
        case "critical": return .red
        case "major": return .orange
        default: return .yellow // "minor" (server filters out "none")
        }
    }

    /// One-line incident notice under a provider's bars. Tapping opens the
    /// provider's public status page; a plain Button so the tap doesn't toggle
    /// the section's explain popover.
    private func serviceStatusRow(_ status: ProviderServiceStatus) -> some View {
        Button {
            if let urlString = status.url, let url = URL(string: urlString) {
                NSWorkspace.shared.open(url)
            }
        } label: {
            HStack(spacing: 4) {
                Circle()
                    .fill(serviceStatusColor(status.indicator))
                    .frame(width: 6, height: 6)
                Text(status.description ?? Strings.providerServiceIssue)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .buttonStyle(.plain)
        .help(Strings.providerStatusOpenPage)
    }

    // MARK: - Window specs (one source of truth for rows + the explain popover)

    private func makeSpec(_ label: String, _ pct: Double, windowSeconds: Double? = nil, iso: String?, segments: [LimitSegment] = [], productPool: Bool = false) -> LimitWindowSpec {
        let date = resetDate(iso: iso)
        return LimitWindowSpec(label: label, pct: pct, windowSeconds: windowSeconds, resetDate: date, resetText: date.map(relativeString), segments: segments, productPool: productPool)
    }

    private func makeSpec(_ label: String, _ pct: Double, windowSeconds: Double? = nil, epoch: Int?) -> LimitWindowSpec {
        let date = resetDate(epoch: epoch)
        return LimitWindowSpec(label: label, pct: pct, windowSeconds: windowSeconds, resetDate: date, resetText: date.map(relativeString))
    }

    private func claudeSpecs(_ c: ClaudeLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = c.fiveHour { s.append(makeSpec("5h", w.utilization, windowSeconds: 5 * 3600, iso: w.resetsAt)) }
        if let w = c.sevenDay { s.append(makeSpec("7d", w.utilization, windowSeconds: 7 * 86400, iso: w.resetsAt)) }
        if let w = c.sevenDayOpus { s.append(makeSpec("Opus", w.utilization, windowSeconds: 7 * 86400, iso: w.resetsAt)) }
        for w in c.weeklyScoped ?? [] {
            s.append(makeSpec(w.label, w.utilization, windowSeconds: 7 * 86400, iso: w.resetsAt))
        }
        return s
    }

    private func codexSpecs(_ c: CodexLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = c.primaryWindow { s.append(makeSpec("5h", Double(w.usedPercent), windowSeconds: w.limitWindowSeconds.map(Double.init), epoch: w.resetAt)) }
        if let w = c.secondaryWindow { s.append(makeSpec("7d", Double(w.usedPercent), windowSeconds: w.limitWindowSeconds.map(Double.init), epoch: w.resetAt)) }
        if let w = c.creditWindow { s.append(makeSpec(Strings.codexCreditsLabel, w.usedPercent, epoch: w.resetAt)) }
        if let w = c.sparkPrimaryWindow { s.append(makeSpec("Spark 5h", Double(w.usedPercent), windowSeconds: w.limitWindowSeconds.map(Double.init), epoch: w.resetAt)) }
        if let w = c.sparkSecondaryWindow { s.append(makeSpec("Spark 7d", Double(w.usedPercent), windowSeconds: w.limitWindowSeconds.map(Double.init), epoch: w.resetAt)) }
        return s
    }

    private func codexResetBankViewData(_ resetCredits: CodexLimits.ResetCredits?) -> (rows: [CodexResetRowSpec], statusText: String?) {
        let rows = codexResetRows(resetCredits)
        if !rows.isEmpty {
            return (rows, nil)
        }
        return ([], Strings.codexResetBankPassiveStatus(resetCredits))
    }

    private func codexResetRows(_ resetCredits: CodexLimits.ResetCredits?) -> [CodexResetRowSpec] {
        guard let resetCredits, resetCredits.availableCount != 0 else { return [] }

        return resetCredits.credits
            .filter { $0.status == "available" }
            .enumerated()
            .compactMap { index, credit in
                guard let expiresAt = resetDate(iso: credit.expiresAt) else { return nil }
                let label = Strings.codexResetBankLabel(index + 1)
                let expiry = Strings.codexResetBankExpiryDateTime(expiresAt)
                // Whole days until expiry — hover detail (#248). Matches the web
                // tooltip: floor of the remaining time, 0 → "today".
                let daysLeft = Int(floor(expiresAt.timeIntervalSinceNow / 86400))
                return CodexResetRowSpec(
                    label: label,
                    expiry: expiry,
                    detail: daysLeft < 0 ? nil : Strings.resetCreditExpiryDetail(expiry: expiry, daysLeft: daysLeft),
                    lifetimeRemainingPercent: resetLifetimeRemainingPercent(
                        grantedAt: resetDate(iso: credit.grantedAt),
                        expiresAt: expiresAt
                    ),
                    accessibilityLabel: Strings.resetCreditAccessibility(label: label, expiry: expiry)
                )
            }
    }

    private func cursorSpecs(_ c: CursorLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = c.primaryWindow {
            s.append(makeSpec(
                Strings.cursorPlanLabel,
                w.usedPercent,
                windowSeconds: w.limitWindowSeconds,
                iso: w.resetAt
            ))
        }
        if let w = c.secondaryWindow {
            s.append(makeSpec(
                Strings.cursorAutoLabel,
                w.usedPercent,
                windowSeconds: w.limitWindowSeconds,
                iso: w.resetAt
            ))
        }
        if let w = c.tertiaryWindow {
            s.append(makeSpec(
                "API",
                w.usedPercent,
                windowSeconds: w.limitWindowSeconds,
                iso: w.resetAt
            ))
        }
        if let w = c.quaternaryWindow {
            s.append(makeSpec(
                Strings.cursorGrokBotLabel,
                w.usedPercent,
                windowSeconds: w.limitWindowSeconds,
                iso: w.resetAt
            ))
        }
        return s
    }

    private func geminiSpecs(_ g: GeminiLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = g.primaryWindow { s.append(makeSpec("Pro", w.usedPercent, iso: w.resetAt)) }
        if let w = g.secondaryWindow { s.append(makeSpec("Flash", w.usedPercent, iso: w.resetAt)) }
        if let w = g.tertiaryWindow { s.append(makeSpec("Lite", w.usedPercent, iso: w.resetAt)) }
        return s
    }

    private func kimiSpecs(_ k: KimiLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = k.primaryWindow { s.append(makeSpec(Strings.kimiWeeklyLabel, w.usedPercent, windowSeconds: 7 * 86400, iso: w.resetAt)) }
        if let w = k.secondaryWindow { s.append(makeSpec(Strings.kimiFiveHourLabel, w.usedPercent, windowSeconds: 5 * 3600, iso: w.resetAt)) }
        if let w = k.tertiaryWindow { s.append(makeSpec(Strings.kimiTotalLabel, w.usedPercent, iso: w.resetAt)) }
        return s
    }

    private func kiroSpecs(_ k: KiroLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = k.primaryWindow { s.append(makeSpec(Strings.kiroMonthLabel, w.usedPercent, iso: w.resetAt)) }
        if let w = k.secondaryWindow { s.append(makeSpec(Strings.kiroBonusLabel, w.usedPercent, iso: w.resetAt)) }
        return s
    }

    private func grokSpecs(_ g: GrokLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = g.primaryWindow {
            let windowSeconds: Double? = g.periodType == "weekly" ? 7 * 86400 : (g.periodType == "daily" ? 86400 : nil)
            // Products are shares of this pool, not quotas of their own, so they
            // ride on its bar as slices instead of getting rows.
            let segments: [LimitSegment] = (g.products ?? []).compactMap { entry in
                guard let window = entry.window, window.usedPercent > 0,
                      let product = entry.product, !product.isEmpty else { return nil }
                let label = Strings.grokProductLabel(product: product, fallback: entry.label)
                return label.isEmpty ? nil : LimitSegment(id: product, label: label, pct: window.usedPercent)
            }
            s.append(makeSpec(Strings.grokPrimaryLabel(periodType: g.periodType), w.usedPercent, windowSeconds: windowSeconds, iso: w.resetAt, segments: segments, productPool: true))
        }
        if let w = g.secondaryWindow { s.append(makeSpec(Strings.grokOndemandLabel, w.usedPercent, iso: w.resetAt)) }
        return s
    }

    /// Rows for ZCode: fixed coding-plan windows, labelled start-plan buckets, or the legacy GLM labels.
    private func zcodeSpecs(_ z: ZcodeLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if z.planKind == "coding-plan" {
            if let w = z.primaryWindow { s.append(makeSpec("5h", w.usedPercent, iso: w.resetAt)) }
            if let w = z.secondaryWindow { s.append(makeSpec("Weekly", w.usedPercent, iso: w.resetAt)) }
            if let w = z.tertiaryWindow { s.append(makeSpec("Tools", w.usedPercent, iso: w.resetAt)) }
        } else if let buckets = z.labeledBuckets {
            // One row per balance bucket, labelled by the server (model, plus promotion name for one-time grants).
            for b in buckets { s.append(makeSpec(b.label, b.window.usedPercent, iso: b.window.resetAt)) }
        } else {
            if let w = z.primaryWindow { s.append(makeSpec("GLM-5.2", w.usedPercent, iso: w.resetAt)) }
            if let w = z.secondaryWindow { s.append(makeSpec("GLM-5-Turbo", w.usedPercent, iso: w.resetAt)) }
        }
        return s
    }

    private func opencodeGoSpecs(_ o: OpencodeGoLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = o.primaryWindow { s.append(makeSpec("5h", w.usedPercent, iso: w.resetAt)) }
        if let w = o.secondaryWindow { s.append(makeSpec("Weekly", w.usedPercent, iso: w.resetAt)) }
        if let w = o.tertiaryWindow { s.append(makeSpec("Monthly", w.usedPercent, iso: w.resetAt)) }
        return s
    }

    private func commandCodeSpecs(_ c: CommandCodeLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = c.primaryWindow { s.append(makeSpec("5h", w.usedPercent, windowSeconds: 5 * 3600, iso: w.resetAt)) }
        if let w = c.secondaryWindow { s.append(makeSpec("Weekly", w.usedPercent, windowSeconds: 7 * 86400, iso: w.resetAt)) }
        return s
    }

    private func workbuddySpecs(_ w: WorkbuddyLimits) -> [LimitWindowSpec] {
        var specs: [LimitWindowSpec] = []
        // Empty 0/0 windows (no active plan / no resource credit) have no
        // quota to read and would render as a full bar in remaining mode —
        // drop them like a missing window. An exhausted plan (total > 0,
        // remain 0) stays visible at 100%.
        if let window = w.primaryWindow, window.limitCredits != 0 {
            var spec = makeSpec(Strings.workbuddyPlanLabel, window.usedPercent, iso: window.resetAt)
            spec.creditsDetail = window.creditsDetail
            specs.append(spec)
        }
        if let window = w.secondaryWindow, window.limitCredits != 0 {
            var spec = makeSpec(Strings.workbuddyAddonLabel, window.usedPercent, iso: window.resetAt)
            spec.creditsDetail = window.creditsDetail
            specs.append(spec)
        }
        return specs
    }

    private func devinSpecs(_ d: DevinLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = d.primaryWindow { s.append(makeSpec("Daily", w.usedPercent, windowSeconds: w.limitWindowSeconds ?? 86400, iso: w.resetAt)) }
        if let w = d.secondaryWindow { s.append(makeSpec("Weekly", w.usedPercent, windowSeconds: w.limitWindowSeconds ?? 7 * 86400, iso: w.resetAt)) }
        return s
    }

    private func qoderSpecs(_ q: QoderLimits) -> [LimitWindowSpec] {
        var specs: [LimitWindowSpec] = []
        // Empty 0/0 buckets (no active plan / no add-on pack) have no quota to
        // read and would render as a full bar in remaining mode — drop them
        // like a missing window. Windows without credit fields are kept.
        if let window = q.primaryWindow, window.limitCredits != 0 {
            specs.append(makeSpec(Strings.qoderPlanLabel, window.usedPercent, iso: window.resetAt))
        }
        if let window = q.tertiaryWindow, window.limitCredits != 0 {
            specs.append(makeSpec(Strings.qoderAddonLabel, window.usedPercent, iso: window.resetAt))
        }
        if let window = q.secondaryWindow {
            specs.append(makeSpec(Strings.qoderBonusLabel, window.usedPercent, iso: window.resetAt))
        }
        return specs
    }

    private func codingPlanSpecs(_ c: CodingPlanLimits) -> [LimitWindowSpec] {
        var specs: [LimitWindowSpec] = []
        if let w = c.primaryWindow { specs.append(makeSpec("5h", w.usedPercent, windowSeconds: 5 * 3600, iso: w.resetAt)) }
        if let w = c.secondaryWindow { specs.append(makeSpec("Weekly", w.usedPercent, windowSeconds: 7 * 86400, iso: w.resetAt)) }
        if let w = c.tertiaryWindow { specs.append(makeSpec("Monthly", w.usedPercent, iso: w.resetAt)) }
        return specs
    }

    private func agentPlanSpecs(_ a: AgentPlanLimits) -> [LimitWindowSpec] {
        var specs: [LimitWindowSpec] = []
        if let w = a.primaryWindow { specs.append(makeSpec("5h", w.usedPercent, windowSeconds: 5 * 3600, iso: w.resetAt)) }
        if let w = a.secondaryWindow { specs.append(makeSpec("Weekly", w.usedPercent, windowSeconds: 7 * 86400, iso: w.resetAt)) }
        if let w = a.tertiaryWindow { specs.append(makeSpec("Monthly", w.usedPercent, iso: w.resetAt)) }
        return specs
    }

    private func copilotSpecs(_ c: CopilotLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = c.primaryWindow { s.append(makeSpec("Premium", w.usedPercent, iso: w.resetAt)) }
        if let w = c.secondaryWindow { s.append(makeSpec("Chat", w.usedPercent, iso: w.resetAt)) }
        return s
    }

    /// Quota rows for Antigravity, ordered Gm 5h → Gm 7d → Cl 5h → Cl 7d.
    /// Uses server-supplied `limitWindowSeconds` so only confirmed quota buckets receive pace notches.
    private func antigravitySpecs(_ a: AntigravityLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = a.quaternaryWindow { s.append(makeSpec("Gm 5h", w.usedPercent, windowSeconds: w.limitWindowSeconds, iso: w.resetAt)) }
        if let w = a.tertiaryWindow { s.append(makeSpec("Gm 7d", w.usedPercent, windowSeconds: w.limitWindowSeconds, iso: w.resetAt)) }
        if let w = a.secondaryWindow { s.append(makeSpec("Cl 5h", w.usedPercent, windowSeconds: w.limitWindowSeconds, iso: w.resetAt)) }
        if let w = a.primaryWindow { s.append(makeSpec("Cl 7d", w.usedPercent, windowSeconds: w.limitWindowSeconds, iso: w.resetAt)) }
        return s
    }

    // MARK: - Row

    /// Shared row-label column: every row matches the widest visible label so
    /// bars align. The visible text truncates with an ellipsis once the column
    /// hits `labelColumnMaxWidth` — a long model/plan name must not squeeze
    /// every bar — while a hidden fixed-size copy keeps reporting the label's
    /// natural width so the column still grows with the widest label. The full
    /// text stays reachable through the hover tooltip.
    private func rowLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(.caption, design: .default))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            // Unmeasured first pass renders at natural width (as if fixedSize);
            // from the second pass on, the shared column width applies and
            // truncation kicks in past the cap.
            .fixedSize(horizontal: labelColumnWidth == 0, vertical: false)
            .frame(width: labelColumnWidth > 0 ? min(labelColumnWidth, Self.labelColumnMaxWidth) : nil, alignment: .leading)
            .background(alignment: .topLeading) {
                Text(text)
                    .font(.system(.caption, design: .default))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .opacity(0)
                    .accessibilityHidden(true)
                    .background(GeometryReader { proxy in
                        Color.clear.preference(key: LimitLabelWidthKey.self, value: proxy.size.width)
                    })
            }
            .help(text)
    }

    private func limitRow(
        label: String,
        pct: Double,
        reset: String?,
        toolName: String,
        windowSeconds: Double? = nil,
        resetDate: Date? = nil,
        segments: [LimitSegment] = [],
        showSegments: Bool = false,
        creditsDetail: String? = nil
    ) -> some View {
        let rawClamped = min(max(pct, 0), 100)
        let usedFraction = rawClamped / 100.0
        // The headline follows the selected mode. Product slices are points of
        // the amount used, so they stack only in used mode.
        let remainingMode = settings.displayMode == .remaining
        let displayValue = remainingMode ? (100 - rawClamped) : rawClamped

        // Unified threshold fill (green → amber → red), based on actual usage so
        // the color reads the same in used and remaining modes.
        let fillColor = Color.limitBar(fraction: usedFraction)

        // Time-aware pace mark (CodexBar-style notch). Shown once the window has
        // nonzero usage. Green when on/under pace, red when ahead (deficit). Requires a
        // trusted window length; monthly / billing-cycle windows show no mark.
        var pacePercent: Double?
        var paceOver = false
        if let windowSeconds, windowSeconds > 0, let resetDate {
            let pace = LimitPace.compute(
                usedFraction: usedFraction,
                windowSeconds: windowSeconds,
                secondsUntilReset: resetDate.timeIntervalSinceNow,
                remainingMode: remainingMode
            )
            pacePercent = pace.pacePercent
            paceOver = pace.paceOver
        }

        let accessibilityLabel = Strings.limitAccessibility(
            toolName: toolName,
            label: label,
            percent: Int(displayValue.rounded()),
            reset: reset,
            modeSuffix: remainingMode ? Strings.limitSuffixRemaining : Strings.limitSuffixUsed
        )

        return HStack(spacing: Self.rowColumnSpacing) {
            rowLabel(label)

            UsageLimitBar(
                percent: displayValue,
                fillColor: fillColor,
                pacePercent: pacePercent,
                paceOver: paceOver,
                segments: (showSegments && !remainingMode) ? segments.map(\.pct) : []
            )
            .animation(reduceMotion ? .none : .easeOut(duration: 0.5), value: displayValue)

            Text(displayPercentLabel(displayValue))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: Self.percentColumnWidth, alignment: .trailing)

            if let reset {
                Text(reset)
                    .font(.system(.caption2, design: .default))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    // Never wrap: the column grows to the widest reset label,
                    // so a long "已过期" stays on one line instead of raising
                    // the row height.
                    .fixedSize(horizontal: true, vertical: false)
                    .background(GeometryReader { proxy in
                        Color.clear.preference(key: LimitResetWidthKey.self, value: proxy.size.width)
                    })
                    .frame(width: resetColumnWidth > 0 ? effectiveResetColumnWidth : nil, alignment: .trailing)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([accessibilityLabel, creditsDetail].compactMap { $0 }.joined(separator: ", "))
        .help(creditsDetail ?? "")
    }

    /// Dot + name + share for each slice of a segmented bar, aligned under the
    /// bar. One concatenated Text so entries wrap like the web legend without
    /// `Layout` (macOS 13+); non-breaking spaces keep each entry on one line.
    private func segmentLegend(_ segments: [LimitSegment], pct: Double, note: String? = nil) -> some View {
        let fillColor = Color.limitBar(fraction: min(max(pct, 0), 100) / 100.0)
        let entries = segments.enumerated().map { index, segment -> Text in
            let name = segment.label.replacingOccurrences(of: " ", with: "\u{00A0}")
            return Text("●")
                .font(.system(size: 7))
                .baselineOffset(1)
                .foregroundColor(fillColor.opacity(UsageLimitBar.segmentOpacity(index)))
                + Text("\u{00A0}\(name)\u{00A0}").foregroundColor(.secondary)
                + Text(segmentPercentLabel(segment.pct)).foregroundColor(.primary)
        }
        let legend = entries.dropFirst().reduce(entries.first ?? Text("")) { $0 + Text("   ") + $1 }
        let labelWidth = labelColumnWidth > 0 ? min(labelColumnWidth, Self.labelColumnMaxWidth) : 0
        let sharesLabel = segments.map { "\($0.label) \(segmentPercentLabel($0.pct))" }.joined(separator: ", ")
        return VStack(alignment: .leading, spacing: 2) {
            legend
                .font(.system(.caption2, design: .default))
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let note, !note.isEmpty {
                Text(note)
                    .font(.system(.caption2, design: .default))
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.leading, labelWidth + Self.rowColumnSpacing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(note.map { "\(sharesLabel). \($0)" } ?? sharesLabel)
    }

    private func segmentPercentLabel(_ pct: Double) -> String {
        let rounded = Int(pct.rounded())
        return pct > 0 && rounded == 0 ? "<1%" : "\(rounded)%"
    }

    private func subscriptionRow(for subscription: SubscriptionRecord) -> some View {
        let nowMs = Date().timeIntervalSince1970 * 1000.0
        guard let view = SubscriptionCycle.cycleView(subscription: subscription, nowMs: nowMs) else {
            return AnyView(EmptyView())
        }
        let isNearExpiry = !view.expired && view.endMs - nowMs <= 3 * 86400000
        let fillColor: Color = view.expired ? .red : (isNearExpiry ? .orange : .blue)
        let rawPct = view.progress * 100.0
        let displayPct = view.expired ? 100.0 : (settings.displayMode == .remaining ? 100.0 - rawPct : rawPct)
        let clampedPct = max(0, min(100, displayPct))
        let rounded = Int(clampedPct.rounded())
        let percentLabel: String = (clampedPct > 0 && rounded == 0) ? "<1%" : "\(rounded)%"
        let remaining = SubscriptionCycle.remainingLabel(endMs: view.endMs, nowMs: nowMs)
        let a11y = "\(Strings.subscriptionLabel) \(percentLabel) \(remaining)"
        return AnyView(
            HStack(spacing: Self.rowColumnSpacing) {
                rowLabel(Strings.subscriptionLabel)

                UsageLimitBar(
                    percent: clampedPct,
                    fillColor: fillColor,
                    pacePercent: nil,
                    paceOver: false
                )

                Text(percentLabel)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(width: Self.percentColumnWidth, alignment: .trailing)

                Text(remaining)
                    .font(.system(.caption2, design: .default))
                    .monospacedDigit()
                    .foregroundStyle(view.expired ? AnyShapeStyle(Color.red) : AnyShapeStyle(.tertiary))
                    .lineLimit(1)
                    // Same never-wrap rule as the limit rows' reset column.
                    .fixedSize(horizontal: true, vertical: false)
                    .background(GeometryReader { proxy in
                        Color.clear.preference(key: LimitResetWidthKey.self, value: proxy.size.width)
                    })
                    .frame(width: resetColumnWidth > 0 ? effectiveResetColumnWidth : nil, alignment: .trailing)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(a11y)
        )
    }

    /// True when ZCode reset inventory should occupy space (error banner or any live group).
    private func zcodeResetBankHasContent(_ resetCredits: ZcodeResetCredits?) -> Bool {
        guard let resetCredits else { return false }
        if let error = resetCredits.error, !error.isEmpty { return true }
        return !zcodeResetBankGroups(resetCredits).isEmpty
    }

    private struct ZcodeResetGroupSpec: Identifiable {
        let id: String
        let label: String
        let count: Int
        /// Earliest live card as a fixed-scale countdown: 100 = a whole window
        /// of time left, 0 = expiring now (see the scale constants below).
        let countdownPercent: Double
        let earliest: String?
        let earliestHelp: String?
    }

    /// Fixed countdown scales for the ZCode reset-card bars (#888 R2). ZCode
    /// cards carry only `expires_at` (no grant time), so instead of Codex's
    /// per-card lifetime the bar shows "time until the earliest live card
    /// expires" against a fixed scale of one window per group: cards align to
    /// window boundaries, so the earliest live card is never further out than
    /// this and anything beyond clips at 100%. An oversized scale would pin the
    /// bars near empty and read as false urgency. Keep in sync with the
    /// dashboard (`ZCODE_RESET_COUNTDOWN_SCALES_MS` in UsageLimitsPanel.jsx).
    private static let zcodeFiveHourResetCountdownScale: TimeInterval = 5 * 3600
    private static let zcodeWeeklyResetCountdownScale: TimeInterval = 7 * 86400

    private func zcodeResetBankGroups(_ resetCredits: ZcodeResetCredits, now: Date = Date()) -> [ZcodeResetGroupSpec] {
        let pairs: [(String, String, [ZcodeResetCard]?, TimeInterval)] = [
            ("five_hour", "5h", resetCredits.fiveHour, Self.zcodeFiveHourResetCountdownScale),
            ("weekly", "Weekly", resetCredits.weekly, Self.zcodeWeeklyResetCountdownScale),
        ]
        return pairs.map { id, label, cards, scale in
            let live = (cards ?? []).compactMap { card -> (Date, String)? in
                guard let date = resetDate(iso: card.expiresAt), date > now else { return nil }
                return (date, card.expiresAt)
            }.sorted { $0.0 < $1.0 }
            let earliest = live.first.map { Strings.codexResetBankExpiryDateTime($0.0) }
            // The inventory is issued in batches that share one expiry instant,
            // so the tooltip collapses same-instant repeats into "time ×count".
            let batches = Dictionary(grouping: live, by: { $0.0.timeIntervalSince1970 })
                .sorted { $0.key < $1.key }
            let help = batches.map { instant, group in
                let time = Strings.codexResetBankExpiryDateTime(Date(timeIntervalSince1970: instant))
                return group.count > 1 ? "\(time) ×\(group.count)" : time
            }.joined(separator: "\n")
            let countdown = live.first.map { next in
                min(100, max(0, next.0.timeIntervalSince(now) / scale * 100))
            } ?? 0
            return ZcodeResetGroupSpec(
                id: id,
                label: label,
                count: live.count,
                countdownPercent: countdown,
                earliest: earliest.map { Strings.zcodeResetBankEarliest($0) },
                earliestHelp: help.isEmpty ? nil : help
            )
        }
        // Zero-count windows drop out, matching the Codex reset bank
        // (codexResetRows): a "0 available" row carries no information, and an
        // all-empty inventory lets zcodeResetBankHasContent hide the section.
        .filter { $0.count > 0 }
    }

    @ViewBuilder
    private func zcodeResetBankSection(_ resetCredits: ZcodeResetCredits?) -> some View {
        let groups = resetCredits.map { zcodeResetBankGroups($0) } ?? []
        VStack(alignment: .leading, spacing: 4) {
            Text(Strings.zcodeResetBankSectionTitle)
                .font(.system(.caption2, design: .default))
                .modifier(FontWeightModifier(weight: .medium))
                .foregroundStyle(.tertiary)
            if let error = resetCredits?.error, !error.isEmpty {
                Text(error)
                    .font(.system(.caption2, design: .default))
                    .foregroundStyle(.red)
            } else {
                ForEach(groups) { group in
                    HStack(spacing: Self.rowColumnSpacing) {
                        rowLabel(group.label)
                        Text(Strings.zcodeResetBankCount(group.count))
                            .font(.system(.caption2, design: .default))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Color.primary.opacity(0.06), in: Capsule())
                        UsageLimitBar(
                            percent: group.countdownPercent,
                            fillColor: Color.limitBar(fraction: 0),
                            pacePercent: nil,
                            paceOver: false
                        )
                        if let earliest = group.earliest {
                            Text(earliest)
                                .font(.system(.caption2, design: .default))
                                .monospacedDigit()
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                    }
                    .help(group.earliestHelp ?? "")
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(group.label), \(Strings.zcodeResetBankCount(group.count))\(group.earliest.map { ", \($0)" } ?? "")")
                }
            }
        }
        .padding(.top, 1)
    }

    @ViewBuilder
    private func zcodeStartPlanSection(_ startPlan: ZcodeStartPlan, toolName: String) -> some View {
        let planNames = Array(Set((startPlan.buckets ?? []).compactMap { bucket -> String? in
            guard let name = bucket.planName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
            return name
        })).sorted()
        let title = planNames.isEmpty ? Strings.zcodeStartGrantsTitle : planNames.joined(separator: " · ")
        let specs = zcodeStartPlanSpecs(startPlan)
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(.caption2, design: .default))
                .modifier(FontWeightModifier(weight: .medium))
                .foregroundStyle(.tertiary)
                .padding(.top, 2)
            if let error = startPlan.error, !error.isEmpty {
                Text(error)
                    .font(.system(.caption2, design: .default))
                    .foregroundStyle(.red)
            } else {
                ForEach(specs) { spec in
                    limitRow(
                        label: spec.label,
                        pct: spec.pct,
                        reset: spec.resetText,
                        toolName: toolName,
                        windowSeconds: spec.windowSeconds,
                        resetDate: spec.resetDate,
                        segments: spec.segments,
                        showSegments: false,
                        creditsDetail: spec.creditsDetail
                    )
                }
                ForEach(Array((startPlan.buckets ?? []).enumerated()), id: \.offset) { _, bucket in
                    if let remaining = bucket.remainingUnits, let total = bucket.totalUnits,
                       remaining.isFinite, total.isFinite {
                        Text(Strings.zcodeGrantAmount(
                            remaining: formatZcodeUnits(remaining),
                            total: formatZcodeUnits(total)
                        ))
                        .font(.system(.caption2, design: .default))
                        .foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }

    private func zcodeStartPlanSpecs(_ startPlan: ZcodeStartPlan) -> [LimitWindowSpec] {
        var specs: [LimitWindowSpec] = []
        let labeled = (startPlan.buckets ?? []).compactMap { bucket -> (String, GenericLimitWindow)? in
            guard let label = bucket.label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty,
                  let window = bucket.window else { return nil }
            return (label, window)
        }
        if !labeled.isEmpty {
            var seen = Set<String>()
            for (label, window) in labeled where seen.insert(label).inserted {
                specs.append(makeSpec(label, window.usedPercent, iso: window.resetAt))
            }
        }
        return specs
    }

    private func formatZcodeUnits(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? String(Int(value))
    }

    private func resetSection(rows: [CodexResetRowSpec], status: String?) -> some View {

        VStack(alignment: .leading, spacing: 4) {
            Text(Strings.codexResetBankSectionTitle)
                .font(.system(.caption2, design: .default))
                .modifier(FontWeightModifier(weight: .medium))
                .foregroundStyle(.tertiary)

            if rows.isEmpty, let status {
                Text(status)
                    .font(.system(.caption2, design: .default))
                    .foregroundStyle(.tertiary)
            } else {
                VStack(spacing: 4) {
                    ForEach(rows) { row in
                        resetRow(row)
                    }
                }
            }
        }
        .padding(.top, 1)
    }

    private func resetRow(_ row: CodexResetRowSpec) -> some View {
        HStack(spacing: Self.rowColumnSpacing) {
            rowLabel(row.label)

            UsageLimitBar(
                percent: row.lifetimeRemainingPercent,
                fillColor: Color.limitBar(fraction: 0),
                pacePercent: nil,
                paceOver: false
            )

            Text(row.expiry)
                .font(.system(.caption2, design: .default))
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: resetExpiryColumnWidth, alignment: .trailing)
        }
        .help(row.detail ?? "")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
    }

    private var displayModeTitle: String {
        settings.displayMode == .remaining ? Strings.limitDisplayModeRemaining : Strings.limitDisplayModeUsed
    }

    private func displayPercentLabel(_ value: Double) -> String {
        let rounded = Int(value.rounded())
        return "\(rounded)%"
    }

    // MARK: - Helpers

    private func relativeReset(iso: String?) -> String? {
        resetDate(iso: iso).map(relativeString)
    }

    private func relativeReset(epoch: Int?) -> String? {
        resetDate(epoch: epoch).map(relativeString)
    }

    /// Parsed reset instant — feeds both the relative label and the pace marker.
    private func resetDate(iso: String?) -> Date? {
        guard let iso else { return nil }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fmt.date(from: iso) { return date }
        fmt.formatOptions = [.withInternetDateTime]
        if let date = fmt.date(from: iso) { return date }

        let microseconds = DateFormatter()
        microseconds.locale = Locale(identifier: "en_US_POSIX")
        microseconds.timeZone = TimeZone(secondsFromGMT: 0)
        microseconds.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSSSSXXXXX"
        return microseconds.date(from: iso)
    }

    private func resetDate(epoch: Int?) -> Date? {
        guard let epoch else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(epoch))
    }

    private func relativeString(from date: Date) -> String {
        let s = date.timeIntervalSince(Date())
        guard s > 0 else { return Strings.limitResetNow }
        let h = Int(s) / 3600
        if h > 24 { return "\(h / 24)d" }
        if h > 0 { return "\(h)h" }
        return "\(Int(s) / 60)m"
    }

    private func resetLifetimeRemainingPercent(grantedAt: Date?, expiresAt: Date) -> Double {
        guard let grantedAt else { return 100 }
        let total = expiresAt.timeIntervalSince(grantedAt)
        guard total > 0 else { return 100 }
        let remaining = expiresAt.timeIntervalSince(Date())
        return min(100, max(0, remaining / total * 100))
    }

    @ViewBuilder
    private func brandIcon(_ name: String) -> some View {
        switch name {
        case "CursorLogo", "KimiLogo", "KiroLogo", "GrokLogo", "CopilotLogo", "ZcodeLogo", "OpenCodeLogo", "CommandCodeLogo", "QoderLogo", "QoderCnLogo", "VolcanoArkLogo", "DevinLogo", "CodeBuddyLogo":
            let filename: String = {
                switch name {
                case "CursorLogo": return "cursor.svg"
                case "KimiLogo": return "kimi.svg"
                case "KiroLogo": return "kiro.svg"
                case "GrokLogo": return "grok.svg"
                case "ZcodeLogo": return "zcode.svg"
                case "OpenCodeLogo": return "opencode.svg"
                case "CommandCodeLogo": return "commandcode.svg"
                case "QoderLogo": return "qoder.svg"
                case "QoderCnLogo": return "qoder-cn.svg"
                case "VolcanoArkLogo": return "volcano-ark.svg"
                case "DevinLogo": return "devin.svg"
                case "CodeBuddyLogo": return "codebuddy.svg"
                default: return "copilot.svg"
                }
            }()
            if let image = bundledSVGIcon(
                named: filename,
                replacingCurrentColorWith: colorScheme == .dark ? "#FFFFFF" : "#111111"
            ) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            }
        default:
            Image(name)
                .renderingMode(.original)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
        }
    }

    private func bundledSVGIcon(named filename: String, replacingCurrentColorWith color: String? = nil) -> NSImage? {
        guard let url = Bundle.main.resourceURL?
            .appendingPathComponent("EmbeddedServer/tokentracker/dashboard/dist/brand-logos/\(filename)"),
              var svg = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }

        if let color {
            svg = svg.replacingOccurrences(of: "currentColor", with: color)
        }

        svg = normalizedIconSVG(svg, targetSize: 24)

        guard let data = svg.data(using: .utf8),
              let sourceImage = NSImage(data: data) else {
            return nil
        }

        sourceImage.size = NSSize(width: 24, height: 24)
        sourceImage.isTemplate = false
        return sourceImage
    }

    private func normalizedIconSVG(_ svg: String, targetSize: Int) -> String {
        var normalized = svg
        let widthPattern = #"width\s*=\s*"[^"]*""#
        let heightPattern = #"height\s*=\s*"[^"]*""#

        if normalized.range(of: widthPattern, options: .regularExpression) != nil {
            normalized = normalized.replacingOccurrences(
                of: widthPattern,
                with: #"width="\#(targetSize)""#,
                options: .regularExpression
            )
        } else {
            normalized = normalized.replacingOccurrences(
                of: "<svg",
                with: #"<svg width="\#(targetSize)""#,
                options: .literal,
                range: normalized.range(of: "<svg")
            )
        }

        if normalized.range(of: heightPattern, options: .regularExpression) != nil {
            normalized = normalized.replacingOccurrences(
                of: heightPattern,
                with: #"height="\#(targetSize)""#,
                options: .regularExpression
            )
        } else {
            normalized = normalized.replacingOccurrences(
                of: "<svg",
                with: #"<svg height="\#(targetSize)""#,
                options: .literal,
                range: normalized.range(of: "<svg")
            )
        }

        return normalized
    }
}

// MARK: - Settings Gear Button

private struct SettingsGearButton<Popover: View>: View {
    @Binding var isPresented: Bool
    @State private var isHovered = false
    @ViewBuilder let popover: () -> Popover

    var body: some View {
        Button(action: { isPresented.toggle() }) {
            Image(systemName: "gearshape")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(isHovered || isPresented ? .secondary : .tertiary)
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointingHandCursor()
        .onHover { isHovered = $0 }
        .popover(isPresented: $isPresented, arrowEdge: .trailing) {
            popover()
                .preferredColorScheme(.dark)
                .environment(\.colorScheme, .dark)
        }
    }
}

// MARK: - Skeleton Loading

private struct LimitsSkeleton: View {
    @State private var phase: CGFloat = -1

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: Strings.usageLimitsTitle)

            ForEach(0..<2, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 5) {
                        skeletonRect(width: 14, height: 14, radius: 3)
                        skeletonRect(width: 50, height: 10, radius: 3)
                    }
                    ForEach(0..<2, id: \.self) { _ in
                        HStack(spacing: 5) {
                            skeletonRect(width: 28, height: 8, radius: 2)
                            skeletonRect(height: 5, radius: 2)
                            skeletonRect(width: 28, height: 8, radius: 2)
                        }
                    }
                }
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                phase = 1
            }
        }
    }

    private func skeletonRect(width: CGFloat? = nil, height: CGFloat, radius: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: radius)
            .fill(Color.gray.opacity(phase > 0 ? 0.14 : 0.06))
            .frame(width: width, height: height)
    }
}

/// Reports the widest limit-row label so every row's label column can match it.
private struct LimitLabelWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// Reports the widest trailing reset label ("5d", "已过期", …) so every row's
/// reset column can match it and bars share the same right edge.
private struct LimitResetWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct CodexResetRowSpec: Identifiable {
    var id: String { label }
    let label: String
    let expiry: String
    /// Hover tooltip: expiry instant + days left. Nil once already expired.
    let detail: String?
    let lifetimeRemainingPercent: Double
    let accessibilityLabel: String
}

/// Makes a provider block read as clickable: a rounded hover/active highlight and
/// a pointing-hand cursor. `isActive` keeps the highlight while its popover is open.
private struct ProviderClickableStyle: ViewModifier {
    let isActive: Bool
    /// The provider's data is being served from the stale disk-cache fallback
    /// (e.g. a 429 cool-down froze refreshes). Surface a persistent amber badge so
    /// the staleness is visible at rest, not only after opening the info popover.
    var isStale: Bool = false
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 6)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.primary.opacity(isActive ? 0.08 : (hovering ? 0.05 : 0)))
            )
            // Click affordance: the hover highlight alone doesn't say "clickable",
            // so fade in an info glyph at the title line while hovered / open. When
            // data is stale, an amber "clock" badge takes its place at rest so the
            // user notices without hovering; hovering still reveals the info glyph.
            .overlay(alignment: .topTrailing) {
                ZStack {
                    Image(systemName: "clock.arrow.circlepath")
                        .foregroundStyle(.orange)
                        .opacity(isStale && !(hovering || isActive) ? 1 : 0)
                        .accessibilityLabel(Strings.limitsStaleAccessibility)
                        .accessibilityHidden(!isStale)
                    // Decorative click affordance — the whole block carries the tap
                    // gesture, so keep VoiceOver from announcing the raw symbol name.
                    Image(systemName: "info.circle")
                        .foregroundStyle(.tertiary)
                        .opacity(hovering || isActive ? 1 : 0)
                        .accessibilityHidden(true)
                }
                .font(.system(size: 10, weight: .medium))
                .padding(.top, 6)
                .padding(.trailing, 8)
                .animation(.easeOut(duration: 0.12), value: hovering)
                .allowsHitTesting(false)
            }
            .contentShape(RoundedRectangle(cornerRadius: 8))
            .pointingHandCursor()
            .onHover { hovering in
                self.hovering = hovering
            }
            .padding(.horizontal, -6)
    }
}

/// One usage window's data — the single source of truth for both the rendered
/// row and the explanation popover, so the two never drift.
private struct LimitWindowSpec: Identifiable {
    var id: String { label }
    let label: String
    let pct: Double
    let windowSeconds: Double?
    let resetDate: Date?
    let resetText: String?
    /// Shares of `pct` drawn as one stacked bar plus a legend (Grok products).
    var segments: [LimitSegment] = []
    /// These slices are points of one shared cap. The headline still follows
    /// used/remaining; the stack is drawn only while the mode is used.
    var productPool: Bool = false
    var creditsDetail: String? = nil
}

/// One slice of a pooled window, e.g. a Grok product's points of the weekly cap.
private struct LimitSegment: Identifiable {
    let id: String
    let label: String
    let pct: Double
}

/// Side popover with this provider's live per-window numbers (used %, even-pace %,
/// ahead/on-track, reset) plus a short note on how to read the bars.
private struct LimitsExplainContent: View {
    let providerName: String
    let specs: [LimitWindowSpec]
    let remainingMode: Bool
    /// When this provider's data was last successfully fetched, and whether it is a
    /// stale disk-cache fallback. Drives the "Updated Xm ago" footer.
    var updatedAt: Date? = nil
    var isStale: Bool = false
    /// Active 429 cool-down expiry, shown as "Retrying <time>" beneath the updated
    /// line so the user knows when the panel will next attempt a refresh.
    var retryAt: Date? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(providerName)
                .font(.system(.subheadline, design: .default).weight(.semibold))

            VStack(alignment: .leading, spacing: 6) {
                ForEach(specs) { spec in
                    Text(line(for: spec))
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if hasPaceMarker {
                Divider().opacity(0.5)

                Text(Strings.limitsExplainBody(remaining: footnoteRemaining))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let updatedLabel {
                VStack(alignment: .leading, spacing: 2) {
                    Text(updatedLabel)
                        .fixedSize(horizontal: false, vertical: true)
                    if let retryLabel {
                        Text(retryLabel)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .font(.caption2)
                .foregroundStyle(isStale ? Color.orange : Color.secondary)
            }
        }
        .padding(14)
        .frame(width: 256)
        .preferredColorScheme(.dark)
        .environment(\.colorScheme, .dark)
    }

    /// "Updated 2h ago · 7/7 10:26" — relative age (matches the reset rows' style)
    /// plus the exact local instant the user asked to see. Amber when stale.
    private var updatedLabel: String? {
        guard let updatedAt else { return nil }
        let seconds = max(0, Date().timeIntervalSince(updatedAt))
        let relative = Strings.limitsUpdatedRelative(secondsAgo: seconds)
        let exact = Strings.codexResetBankExpiryDateTime(updatedAt)
        return "\(relative) · \(exact)"
    }

    /// "Retrying 7/7 11:11" — when the panel will next attempt a refresh, shown only
    /// while a 429 cool-down is actually pending (so the data is known-stale).
    private var retryLabel: String? {
        guard isStale, let retryAt, retryAt.timeIntervalSinceNow > 0 else { return nil }
        return Strings.limitsRetryingAt(retryAt)
    }

    private var hasPaceMarker: Bool {
        specs.contains { pace(for: $0).pacePercent != nil }
    }

    /// The footnote explains the pace mark, so it follows the rows that draw one.
    private var footnoteRemaining: Bool {
        remainingMode && hasPaceMarker
    }

    private func pace(for spec: LimitWindowSpec) -> LimitPace.Result {
        guard let windowSeconds = spec.windowSeconds, let resetDate = spec.resetDate else {
            return LimitPace.Result()
        }
        return LimitPace.compute(
            usedFraction: min(max(spec.pct, 0), 100) / 100.0,
            windowSeconds: windowSeconds,
            secondsUntilReset: resetDate.timeIntervalSinceNow,
            remainingMode: remainingMode
        )
    }

    /// Live pace numbers + current-rate projection for one window, via the shared
    /// `LimitPace.compute` (same source of truth the bar uses).
    private func line(for spec: LimitWindowSpec) -> String {
        let usedFraction = min(max(spec.pct, 0), 100) / 100.0
        let used = Int((usedFraction * 100).rounded())
        let pace = pace(for: spec)
        var text = Strings.limitWindowExplainLine(
            label: spec.label, used: used, expected: pace.expectedPercent, over: pace.paceOver,
            runsOutEta: pace.runsOutEta, projectedEnd: pace.projectedEnd, remainingMode: remainingMode
        )
        // Exact local reset instant (#248) — the row itself only shows a compact
        // relative countdown, so the popover carries the precise time.
        if let resetDate = spec.resetDate {
            text += " · " + Strings.limitResetsAt(resetDate)
        }
        if let detail = spec.creditsDetail { text += "\n" + detail }
        return text
    }
}
