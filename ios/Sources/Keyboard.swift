import UIKit
import WebKit

/// Lets the Desktop tab bring up the phone keyboard by itself when a PC text field gets focus (remote desktop, cap
/// `focus`: the PC says so over the data channel, there is no tap on the phone).
///
/// WKWebView shows the keyboard only for a focus that comes from the user's own tap; the page's focus() after a
/// message from the PC is ignored, and WKWebView has no public switch for it (UIWebView's
/// keyboardDisplayRequiresUserAction is gone). WebKit asks its input delegate instead (`_WKInputDelegate`,
/// `-_webView:decidePolicyForFocusedElement:`, iOS 12+): a plain optional delegate method, set through the web view's
/// `_inputDelegate` property. No swizzling; a WebKit without it never asks, and the page then shows "tap to type".
///
/// Only one focus is let through, within a second of the page asking for it (op keyboard.allow), so nothing else in
/// the page (the chat box) can pop the keyboard up by itself; every other focus gets WebKit's own rule. The app lock
/// forgets a pending allow. Password fields never get the "strong password" sheet.
@MainActor
final class KeyboardFocus: NSObject {
    /// how long an allow waits for the page's focus() (the page focuses as soon as the reply arrives)
    static let window: TimeInterval = 1.0
    private var allowUntil: Date?
    /// the web view took this object as its input delegate (false: a WebKit without `_inputDelegate`)
    private(set) var installed = false

    /// The web view holds its input delegate weakly: the bridge keeps this object alive.
    func install(on webView: WKWebView) {
        let setter = NSSelectorFromString("_setInputDelegate:")
        guard webView.responds(to: setter) else { return }
        webView.perform(setter, with: self)
        installed = true
    }

    /// The page is about to focus its hidden field for a PC text focus: let that one focus show the keyboard.
    func allowNextFocus() -> Bool {
        guard installed else { return false }
        allowUntil = Date().addingTimeInterval(Self.window)
        return true
    }

    func reset() { allowUntil = nil }

    /// _WKFocusStartsInputSessionPolicy: 0 = auto (WebKit's own rule: a tap shows the keyboard), 1 = allow
    @objc(_webView:decidePolicyForFocusedElement:)
    func webView(_ webView: WKWebView, decidePolicyForFocusedElement info: AnyObject) -> Int {
        guard let until = allowUntil else { return 0 }
        allowUntil = nil                                    // one focus only
        return until > Date() ? 1 : 0
    }

    @objc(_webView:focusRequiresStrongPasswordAssistance:)
    func webView(_ webView: WKWebView, focusRequiresStrongPasswordAssistance info: AnyObject) -> Bool { false }
}
