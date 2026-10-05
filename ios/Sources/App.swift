import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: session.role)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}

/// The whole app: one full-screen WKWebView showing the bundled web UI (web/index.html, copied in from the repo's
/// web/ folder). The page lays itself out under the notch and home bar with env(safe-area-inset-*), so the web view
/// itself ignores the safe area. Links to http(s) sites open in Safari; everything else outside web/ is refused.
/// The page talks to the PC through NativeBridge (the token stays native); while pairing, the camera preview sits
/// under the web view and the web view turns transparent.
/// App lock: the bridge starts locked and locks again when the app goes to the background. A plain cover (the launch
/// screen colour) hides the page whenever the app isn't in front (so the app switcher's picture shows nothing) and
/// stays until the page has taken in the lock state; then Face ID comes up by itself.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, BridgeHost {
    private var webView: WKWebView!
    private lazy var bridge = NativeBridge()
    private let cover = UIView()
    /// the page has loaded (so it can draw its lock screen)
    private var pageReady = false
    /// web/ inside the app bundle; nil only if the build left it out
    private let webRoot = Bundle.main.url(forResource: "web", withExtension: nil)
    private let background = UIColor(named: "LaunchBG") ?? .black

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        // the web view keeps nothing on disk (the page stores nothing anyway; pairing lives in the Keychain)
        config.websiteDataStore = .nonPersistent()
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: NativeBridge.name)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // no white flash before the page paints: the web view shows the launch screen colour until then
        webView.isOpaque = false
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        bridge.webView = webView
        bridge.host = self
        bridge.isTrustedPage = { [weak self] url in self?.isInsideWebRoot(url) ?? false }
        let root = UIView()
        root.backgroundColor = background
        cover.backgroundColor = background
        for v in [bridge.scanner.previewView, webView!, cover] as [UIView] {
            v.frame = root.bounds
            v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            root.addSubview(v)
        }
        view = root
    }

    // MARK: - app lock

    @objc private func sceneWillDeactivate() {
        // a Face ID prompt makes the app inactive for a moment too; the owner hasn't left then
        if !bridge.auth.busy { cover.isHidden = false }
    }

    @objc private func sceneDidEnterBackground() {
        cover.isHidden = false
        bridge.lock()
    }

    @objc private func sceneDidActivate() {
        reveal()
    }

    /// In front with a loaded page: let the page take in the lock state, give it a frame to draw it, then lift the
    /// cover and (still locked) bring up Face ID.
    private func reveal() {
        guard pageReady, isInFront else { return }
        bridge.syncLock { [weak self] in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                guard let self, self.pageReady, self.isInFront else { return }
                self.cover.isHidden = true
                self.bridge.autoUnlock()
            }
        }
    }

    private var isInFront: Bool { view.window?.windowScene?.activationState == .foregroundActive }

    // MARK: - BridgeHost

    func setCameraVisible(_ visible: Bool) {
        bridge.scanner.previewView.isHidden = !visible
        let bg: UIColor = visible ? .clear : background
        webView.backgroundColor = bg
        webView.scrollView.backgroundColor = bg
    }

    func presentNative(_ vc: UIViewController) {
        guard canPresent else { return }
        present(vc, animated: true)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(sceneWillDeactivate), name: UIScene.willDeactivateNotification, object: nil)
        nc.addObserver(self, selector: #selector(sceneDidEnterBackground), name: UIScene.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(sceneDidActivate), name: UIScene.didActivateNotification, object: nil)
        loadHome()
    }

    private func loadHome() {
        pageReady = false
        cover.isHidden = false
        bridge.pageWillReload()
        guard let root = webRoot else { return showMissingUI() }
        let index = root.appendingPathComponent("index.html")
        guard FileManager.default.fileExists(atPath: index.path) else { return showMissingUI() }
        webView.loadFileURL(index, allowingReadAccessTo: root)
    }

    private func showMissingUI() {
        webView.loadHTMLString("""
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="background:#121212;color:#eee;font:17px -apple-system;padding:60px 24px">
            GupWorks: the web UI (web/index.html) is missing from this build.</body>
            """, baseURL: nil)
    }

    private func isInsideWebRoot(_ url: URL) -> Bool {
        guard url.isFileURL, let root = webRoot?.standardizedFileURL.path else { return false }
        let path = url.standardizedFileURL.path
        return path == root || path.hasPrefix(root + "/")
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if isInsideWebRoot(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            if navigationAction.targetFrame?.isMainFrame == true, url.scheme != "about" { bridge.pageWillReload() }
            return decisionHandler(.allow)
        }
        // only a link the user tapped leaves the app; the page can't push the phone to another site on its own
        if (url.scheme == "https" || url.scheme == "http"), navigationAction.navigationType == .linkActivated {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        reveal()
    }

    /// iOS can kill the page's process in the background (memory pressure); start it again instead of a blank screen
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loadHome()
    }

    // MARK: - WKUIDelegate

    /// target=_blank links: same rule as above (Safari for http(s), nothing else)
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "https" || url.scheme == "http" {
            UIApplication.shared.open(url)
        }
        return nil
    }

    /// WebKit requires the handler to be called every time; if a dialog is already up, answer straight away
    private var canPresent: Bool { presentedViewController == nil && view.window != nil }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard canPresent else { return completionHandler() }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard canPresent else { return completionHandler(false) }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}
