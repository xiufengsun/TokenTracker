import AppKit

/// Animated menu bar icon with five styles (`MenuBarIconStyle`):
/// - `clawd`  — pixel-art Clawd drawn procedurally from clawd-static-base.svg
///              coordinates (idle blink / syncing bounce / disconnected "?")
/// - `cat`    — RunCat-style running cat (5 Apache-2.0 frames from
///              Kyome22/menubar_runcat, see THIRD_PARTY_NOTICES.md); state is
///              expressed through running speed, sleeping curls up
/// - `bot`    — the vector `bot` character, frames pre-rendered at build time and
///              turned into template images by `MenuBarBotFrameProvider`; state is
///              expressed through WHICH clip plays, not through speed
/// - `pet`    — silhouette of the desktop pet selected on the Pet page, frames built
///              by `MenuBarPetFrameProvider` (a vector character routes to `bot`)
/// - `static` — the original lightning-bolt icon, no animation
///
/// Runner styles sprint for `MenuBarRunnerPace.sprintWindow` after
/// `noteActivity()` (queue.jsonl appends — i.e. the AI just burned tokens).
@MainActor
final class MenuBarAnimator {

    enum State: Equatable {
        case idle
        case sleeping
        case syncing
        case disconnected
    }

    // MARK: - Properties

    private weak var button: NSStatusBarButton?
    private var animationTimer: Timer?
    private var blinkTimer: Timer?
    private var sprintTimer: Timer?
    private var frameIndex = 0
    private var loopFrames: [NSImage] = []
    private(set) var currentState: State = .idle
    private var renderedImage: NSImage

    private let petFrameProvider = MenuBarPetFrameProvider()
    private let botFrameProvider = MenuBarBotFrameProvider()
    private var sprintUntil: Date = .distantPast

    /// Static fallback icon (original lightning bolt)
    private let fallbackIcon: NSImage

    // SVG → canvas transform:
    // scale 1.4pt per SVG unit, character top at SVG y=6
    // canvas: 22x22 (matches menu bar height)
    // x offset: (22 - 15*1.4)/2 = 0.5, y offset: (22 - 9*1.4)/2 = 4.7
    private let px: CGFloat = 1.54
    private let svgYBase: CGFloat = 6
    private let offsetX: CGFloat = -0.1
    private let offsetY: CGFloat = 4.07
    private let canvasSize = NSSize(width: 22, height: 22)
    private let catCanvasSize = NSSize(width: 28, height: 18)

    // Pre-rendered frames
    /// The current icon image (for external use, e.g. stats rendering)
    var currentImage: NSImage { renderedImage }
    var onImageUpdated: ((NSImage) -> Void)?
    /// False while the status item is hidden (island-only setup). Frames still
    /// reach `onImageUpdated` for the island; only the invisible button's
    /// `image` set (a status-bar layout pass per tick) is skipped.
    var updatesButton = true

    private lazy var idleFrame = buildFrame(eyesClosed: false, yShift: 0)
    private lazy var blinkFrame = buildFrame(eyesClosed: true, yShift: 0)
    private lazy var syncFrames = buildSyncFrames()
    private lazy var disconnectedFrame = buildDisconnectedFrame()
    private lazy var catFrames = buildCatFrames()
    private lazy var catSleepFrames = buildCatSleepFrames()
    private lazy var catDisconnectedFrame = buildCatDisconnectedFrame()

    /// Persisted icon style (UserDefaults, with legacy toggle migration).
    var iconStyle: MenuBarIconStyle {
        get { MenuBarIconStyle.current() }
        set {
            MenuBarIconStyle.setCurrent(newValue)
            applyCurrentState()
        }
    }

    var isSprinting: Bool { Date() < sprintUntil }

    // MARK: - Init

    init(button: NSStatusBarButton) {
        self.button = button
        let icon = NSImage(named: "MenuBarIcon") ?? NSImage()
        icon.isTemplate = true
        self.fallbackIcon = icon
        self.renderedImage = icon
        applyCurrentState()
    }

    // MARK: - Public

    func setState(_ newState: State) {
        guard newState != currentState else { return }
        currentState = newState
        applyCurrentState()
    }

    /// The queue file just grew — the AI is actively burning tokens right now.
    /// Runner styles speed up for a sprint window; each new append extends it.
    func noteActivity() {
        let wasSprinting = isSprinting
        sprintUntil = Date().addingTimeInterval(MenuBarRunnerPace.sprintWindow)
        sprintTimer?.invalidate()
        sprintTimer = Timer.scheduledTimer(
            withTimeInterval: MenuBarRunnerPace.sprintWindow + 0.1,
            repeats: false
        ) { [weak self] _ in
            Task { @MainActor in self?.applyCurrentState() }
        }
        if !wasSprinting { applyCurrentState() }
    }

    func applyCurrentState() {
        frameIndex = 0
        stopAnimation()
        cancelBlink()

        switch iconStyle {
        case .static:
            setButtonImage(fallbackIcon)
        case .clawd:
            applyClawd()
        case .cat:
            applyCat()
        case .bot:
            applyBot()
        case .pet:
            applyPet()
        }
    }

    // MARK: - Clawd (procedural pixel character)

    private func applyClawd() {
        if reduceMotion {
            setButtonImage(idleFrame)
            return
        }

        switch currentState {
        case .idle, .sleeping:
            // Clawd has no sleeping pose; idle blink covers both.
            setButtonImage(idleFrame)
            scheduleNextBlink()
        case .syncing:
            startAnimation(frames: syncFrames, interval: 0.15)
        case .disconnected:
            setButtonImage(disconnectedFrame)
        }
    }

    // MARK: - Cat (RunCat-style runner)

    private func applyCat() {
        guard !catFrames.isEmpty else {
            applyClawd()
            return
        }

        switch currentState {
        case .disconnected:
            setButtonImage(catDisconnectedFrame)
        case .sleeping where !isSprinting:
            if reduceMotion || catSleepFrames.count < 2 {
                setButtonImage(catSleepFrames.first ?? catFrames[0])
            } else {
                startAnimation(frames: catSleepFrames, interval: catInterval)
            }
        default:
            if reduceMotion {
                setButtonImage(catFrames[0])
            } else {
                startAnimation(frames: catFrames, interval: catInterval)
            }
        }
    }

    private var catInterval: TimeInterval {
        MenuBarRunnerPace.frameInterval(style: .cat, motion: runnerMotion)
    }

    // MARK: - Pet (desktop pet silhouette)

    private func applyPet() {
        // "My pet" with a vector character: route to the vector provider instead of
        // falling through to Clawd. The atlas provider correctly returns nil for a
        // character with no sheet, but that made a working renderer unreachable.
        if PetCharacterStore.shared.character.renderer == .vector {
            applyBot()
            return
        }
        guard let frames = petFrameProvider.frames(for: PetCharacterStore.shared.character) else {
            // Clawd is selected (no atlas) or the atlas failed to load.
            applyClawd()
            return
        }

        if reduceMotion {
            setButtonImage(frames.idle[0])
            return
        }

        switch currentState {
        case .disconnected:
            setButtonImage(frames.disconnected)
        case .sleeping where !isSprinting:
            startAnimation(frames: frames.sleeping, interval: petInterval)
        case .syncing:
            startAnimation(frames: frames.active, interval: petInterval)
        case .idle, .sleeping:
            startAnimation(
                frames: isSprinting ? frames.active : frames.idle,
                interval: petInterval
            )
        }
    }

    private var petInterval: TimeInterval {
        MenuBarRunnerPace.frameInterval(style: .pet, motion: runnerMotion)
    }

    // MARK: - Bot (vector morphing character)

    /// Same shape as `applyPet`, but every tier is a real clip rather than one still:
    /// `bot` expresses state by WHICH clip plays, so `disconnected` animates too.
    private func applyBot() {
        guard let frames = botFrameProvider.frames() else {
            // BotFrames.json missing or schema-stale — run gen:bot-frames.
            applyClawd()
            return
        }

        if reduceMotion {
            setButtonImage(frames.idle[0])
            return
        }

        switch currentState {
        case .disconnected:
            startAnimation(frames: frames.disconnected, interval: botInterval)
        case .sleeping where !isSprinting:
            startAnimation(frames: frames.sleeping, interval: botInterval)
        case .syncing:
            startAnimation(frames: frames.active, interval: botInterval)
        case .idle, .sleeping:
            startAnimation(
                frames: isSprinting ? frames.active : frames.idle,
                interval: botInterval
            )
        }
    }

    private var botInterval: TimeInterval {
        MenuBarRunnerPace.frameInterval(style: .bot, motion: runnerMotion)
    }

    private var runnerMotion: MenuBarRunnerMotion {
        if isSprinting { return .sprinting }
        switch currentState {
        case .sleeping: return .sleeping
        case .syncing: return .syncing
        case .idle, .disconnected: return .idle
        }
    }

    // MARK: - Animation Loop

    private func startAnimation(frames: [NSImage], interval: TimeInterval) {
        loopFrames = frames
        tick()
        animationTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func stopAnimation() {
        animationTimer?.invalidate()
        animationTimer = nil
        loopFrames = []
    }

    private func tick() {
        guard !loopFrames.isEmpty else { return }
        setButtonImage(loopFrames[frameIndex % loopFrames.count])
        frameIndex += 1
    }

    // MARK: - Idle Blink

    private func scheduleNextBlink() {
        cancelBlink()
        let delay = TimeInterval.random(in: 3...6)
        blinkTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.playBlink() }
        }
    }

    private func cancelBlink() {
        blinkTimer?.invalidate()
        blinkTimer = nil
    }

    private func playBlink() {
        guard currentState == .idle || currentState == .sleeping,
              !reduceMotion, iconStyle == .clawd else { return }
        setButtonImage(blinkFrame)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self, self.currentState == .idle || self.currentState == .sleeping,
                  self.iconStyle == .clawd else { return }
            self.setButtonImage(self.idleFrame)
            self.scheduleNextBlink()
        }
    }

    // MARK: - Sync Frames

    /// Bounce animation: character hops up 1pt every other frame, with a blink mid-cycle.
    private func buildSyncFrames() -> [NSImage] {
        [
            buildFrame(eyesClosed: false, yShift: 0),
            buildFrame(eyesClosed: false, yShift: -1),
            buildFrame(eyesClosed: false, yShift: 0),
            buildFrame(eyesClosed: false, yShift: -1),
            buildFrame(eyesClosed: true,  yShift: 0),
            buildFrame(eyesClosed: true,  yShift: -1),
            buildFrame(eyesClosed: false, yShift: 0),
            buildFrame(eyesClosed: false, yShift: -1),
        ]
    }

    // MARK: - Cat Frames

    private func buildCatFrames() -> [NSImage] {
        (0..<5).compactMap { n in
            guard let named = NSImage(named: "RunnerCat\(n)"),
                  let image = named.copy() as? NSImage else { return nil }
            image.size = catCanvasSize
            image.isTemplate = true
            return image
        }
    }

    /// Curled-up sleeping cat, drawn procedurally (the RunCat set only ships
    /// running poses). Two frames make a slow breathing loop; the second one
    /// carries a tiny "z".
    private func buildCatSleepFrames() -> [NSImage] {
        [buildCatSleepFrame(exhale: false), buildCatSleepFrame(exhale: true)]
    }

    private func buildCatSleepFrame(exhale: Bool) -> NSImage {
        let img = NSImage(size: catCanvasSize, flipped: true) { [self] _ in
            NSColor.black.setFill()

            // Body: a curled bun, slightly flatter on the exhale frame.
            let squash: CGFloat = exhale ? 1 : 0
            let body = NSBezierPath(
                ovalIn: NSRect(x: 6, y: 6 + squash, width: 17, height: 11 - squash)
            )
            body.fill()

            // Head resting on the right side of the bun.
            let head = NSBezierPath(
                ovalIn: NSRect(x: 16.5, y: 4.5 + squash, width: 8.5, height: 8)
            )
            head.fill()

            // Ears: two small triangles.
            let earA = NSBezierPath()
            earA.move(to: NSPoint(x: 18, y: 6 + squash))
            earA.line(to: NSPoint(x: 19.2, y: 2.6 + squash))
            earA.line(to: NSPoint(x: 21, y: 5.4 + squash))
            earA.close()
            earA.fill()
            let earB = NSBezierPath()
            earB.move(to: NSPoint(x: 21.6, y: 5.2 + squash))
            earB.line(to: NSPoint(x: 23.4, y: 2.8 + squash))
            earB.line(to: NSPoint(x: 24.6, y: 6 + squash))
            earB.close()
            earB.fill()

            // Tail wrapped around the front of the bun.
            let tail = NSBezierPath()
            tail.move(to: NSPoint(x: 7, y: 15.4))
            tail.curve(
                to: NSPoint(x: 3.4, y: 9.6),
                controlPoint1: NSPoint(x: 3.6, y: 15.6),
                controlPoint2: NSPoint(x: 2.6, y: 12.4)
            )
            tail.lineWidth = 2.2
            tail.lineCapStyle = .round
            NSColor.black.setStroke()
            tail.stroke()

            // Tiny "z" while exhaling.
            if exhale {
                let font = NSFont.systemFont(ofSize: 5, weight: .bold)
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: font,
                    .foregroundColor: NSColor.black.withAlphaComponent(0.8),
                ]
                NSAttributedString(string: "z", attributes: attrs)
                    .draw(at: NSPoint(x: catCanvasSize.width - 5, y: 0))
            }

            return true
        }
        img.isTemplate = true
        return img
    }

    /// Dimmed cat with a "?" — mirrors Clawd's disconnected treatment.
    private func buildCatDisconnectedFrame() -> NSImage {
        let img = NSImage(size: catCanvasSize, flipped: false) { [weak self] rect in
            guard let self, let base = self.catFrames.first else { return false }
            base.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 0.5)

            let font = NSFont.systemFont(ofSize: 7, weight: .bold)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: NSColor.black.withAlphaComponent(0.7),
            ]
            let str = NSAttributedString(string: "?", attributes: attrs)
            let strSize = str.size()
            str.draw(at: NSPoint(
                x: (rect.width - strSize.width) / 2,
                y: rect.height - strSize.height
            ))
            return true
        }
        img.isTemplate = true
        return img
    }

    // MARK: - Disconnected Frame (dimmed character with ?)

    private func buildDisconnectedFrame() -> NSImage {
        let img = NSImage(size: canvasSize, flipped: true) { [self] _ in
            guard NSGraphicsContext.current?.cgContext != nil else { return false }

            NSColor.black.withAlphaComponent(0.5).setFill()

            svgRect(2, 6, 11, 7).fill()     // torso
            svgRect(0, 9, 2, 2).fill()      // left arm
            svgRect(13, 9, 2, 2).fill()     // right arm
            svgRect(3, 13, 1, 2).fill()
            svgRect(5, 13, 1, 2).fill()
            svgRect(9, 13, 1, 2).fill()
            svgRect(11, 13, 1, 2).fill()

            // "?" mark above head
            let font = NSFont.systemFont(ofSize: 7, weight: .bold)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: NSColor.black.withAlphaComponent(0.7),
            ]
            let str = NSAttributedString(string: "?", attributes: attrs)
            let strSize = str.size()
            let qx = (canvasSize.width - strSize.width) / 2
            str.draw(at: NSPoint(x: qx, y: 0))

            return true
        }
        img.isTemplate = true
        return img
    }

    // MARK: - Frame Drawing (exact SVG geometry)

    /// Convert SVG coordinates to canvas rect
    private func svgRect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
        NSRect(
            x: x * px + offsetX,
            y: (y - svgYBase) * px + offsetY,
            width: w * px,
            height: h * px
        )
    }

    private func buildFrame(eyesClosed: Bool, yShift: CGFloat) -> NSImage {
        let img = NSImage(size: canvasSize, flipped: true) { [self] _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }

            // Vertical shift for bounce animation
            if yShift != 0 { ctx.translateBy(x: 0, y: yShift) }

            // --- Draw body (all parts from clawd-static-base.svg) ---
            NSColor.black.setFill()

            svgRect(2, 6, 11, 7).fill()     // torso
            svgRect(0, 9, 2, 2).fill()      // left arm
            svgRect(13, 9, 2, 2).fill()     // right arm
            svgRect(3, 13, 1, 2).fill()     // outer-left-leg
            svgRect(5, 13, 1, 2).fill()     // inner-left-leg
            svgRect(9, 13, 1, 2).fill()     // inner-right-leg
            svgRect(11, 13, 1, 2).fill()    // outer-right-leg

            // --- Cut out eyes (transparent holes) unless blinking ---
            if !eyesClosed {
                ctx.setBlendMode(.clear)
                NSColor.clear.setFill()
                svgRect(4, 8, 1, 2).fill()  // left eye
                svgRect(10, 8, 1, 2).fill() // right eye
            }

            return true
        }
        img.isTemplate = true
        return img
    }

    // MARK: - Helpers

    private func setButtonImage(_ image: NSImage) {
        renderedImage = image
        if updatesButton { button?.image = image }
        onImageUpdated?(image)
    }

    private var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }
}
