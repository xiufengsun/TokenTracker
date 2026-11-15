import SwiftUI
import UIKit
import Combine

/// A separate scene window covers the entire presentation stack, including
/// UIActivityViewController and nested sheets. No dismissal animation is relied
/// on for switcher snapshots; willResignActive installs an opaque cover inline.
struct PresentationPrivacyGuard<Shield: View>: UIViewRepresentable {
    let sessions: SessionStore
    let shielded: Bool
    let protectInactive: Bool
    let shield: Shield

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> Anchor {
        let view = Anchor()
        view.attached = { [weak coordinator = context.coordinator] window in
            coordinator?.attach(window)
        }
        context.coordinator.observe(sessions)
        return view
    }
    func updateUIView(_ uiView: Anchor, context: Context) {
        let c = context.coordinator
        c.protectInactive = protectInactive
        c.desired = shielded
        c.host.rootView = AnyView(shield)
        c.attach(uiView.window)
        c.updateVisibility()
    }
    static func dismantleUIView(_ uiView: Anchor, coordinator: Coordinator) {
        coordinator.cover?.isHidden = true
        coordinator.cover = nil
    }

    final class Anchor: UIView {
        var attached: ((UIWindow?) -> Void)?
        override func didMoveToWindow() { super.didMoveToWindow(); attached?(window) }
    }

    @MainActor final class Coordinator {
        var cover: UIWindow?
        weak var source: UIWindow?
        var protectInactive = false
        var desired = false
        var generation = 0
        var transitioning = false
        var inactive = UIApplication.shared.applicationState != .active
        var mustCover: Bool { desired || transitioning || (inactive && protectInactive) }
        let host = UIHostingController(rootView: AnyView(Color(.systemBackground).ignoresSafeArea()))
        var subscriptions = Set<AnyCancellable>()

        func attach(_ window: UIWindow?) {
            guard let window, let scene = window.windowScene else { return }
            source = window
            guard cover == nil else { return }
            let cover = UIWindow(windowScene: scene)
            cover.windowLevel = .alert + 1
            cover.rootViewController = host
            host.view.backgroundColor = .systemBackground
            self.cover = cover
            updateVisibility()
        }

        func showCover() {
            guard let cover, let scene = cover.windowScene else { return }
            let highest = scene.windows.filter { $0 !== cover }.map { $0.windowLevel.rawValue }.max() ?? 0
            cover.windowLevel = UIWindow.Level(rawValue: max(UIWindow.Level.alert.rawValue, highest) + 1)
            cover.isHidden = false
        }

        func updateVisibility() {
            if mustCover { showCover() } else { cover?.isHidden = true }
        }

        func observe(_ sessions: SessionStore) {
            NotificationCenter.default.publisher(for: UIWindow.didBecomeVisibleNotification)
                .sink { [weak self] notification in
                    guard let self, self.mustCover, let window = notification.object as? UIWindow,
                          window !== self.cover, window.windowScene === self.cover?.windowScene else { return }
                    self.showCover()
                }.store(in: &subscriptions)
            NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)
                .sink { [weak self] _ in
                    guard let self else { return }
                    self.inactive = true
                    if self.protectInactive { self.showCover() }
                }.store(in: &subscriptions)
            NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
                .sink { [weak self] _ in
                    // Respect either notification/SwiftUI update ordering;
                    // desired retains the lock until authentication succeeds.
                    self?.inactive = false
                    self?.updateVisibility()
                }.store(in: &subscriptions)
            generation = sessions.sessionGeneration
            sessions.$session.dropFirst().sink { [weak self, weak sessions] _ in
                guard let self, let sessions, self.generation != sessions.sessionGeneration else { return }
                self.generation = sessions.sessionGeneration
                // Published emits before the account changes. Cover first, then
                // dismiss the entire controller chain without animation.
                self.transitioning = true
                self.showCover()
                let reveal = { [weak self] in
                    // Keep the cover through both UIKit dismissal and the
                    // SwiftUI transaction replacing the account's subtree.
                    DispatchQueue.main.async {
                        guard let self else { return }
                        self.transitioning = false
                        self.updateVisibility()
                    }
                }
                if let root = self.source?.rootViewController, root.presentedViewController != nil {
                    root.dismiss(animated: false, completion: reveal)
                } else { reveal() }
            }.store(in: &subscriptions)
        }
    }
}
