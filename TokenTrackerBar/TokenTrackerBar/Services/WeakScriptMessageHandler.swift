import Foundation
import WebKit

/// Weak message handler wrapper to break retain cycles with WKUserContentController.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private(set) weak var handler: WKScriptMessageHandler?

    init(_ handler: WKScriptMessageHandler) {
        self.handler = handler
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        handler?.userContentController(userContentController, didReceive: message)
    }
}
