import UIKit
import WebKit

/// What the bridge needs from the screen that hosts the web view.
@MainActor
protocol BridgeHost: AnyObject {
    /// show the camera under a transparent web view (pairing), or hide it again
    func setCameraVisible(_ visible: Bool)
    func presentNative(_ vc: UIViewController)
}

/// A confirm block this bridge handed out after Face ID / the passcode passed. POST /v1/waiting/act only goes to the
/// PC with one of these, once, within its time: the page can't make up a confirmation, or reuse one.
private struct IssuedConfirm {
    let key: String
    let action: String
    let method: String
    let at: String
    let text: String
    let expires: Date
}

/// The web UI's way to the PC and to the pairing. The page calls
///     window.webkit.messageHandlers.gup.postMessage({op, ...})  -> Promise (web/native.js wraps it)
/// and gets events back through GupNative._event(name, data).
///
/// The PC address and the token stay in here and in the Keychain: the page asks for API calls by path, this class
/// adds the base URL and the bearer token, does the request with URLSession and hands back {status, body}. The page
/// never sees the token, so nothing in JavaScript (or web storage, or a web inspector) can leak it.
///
/// The app lock (Face ID slice): the bridge starts locked and locks again whenever the app goes to the background.
/// While locked only hello / unlock / lock.peek / cancel / settings answer; every PC request is refused. Owner
/// decisions need a fresh Face ID (or passcode) check each time: `confirm` runs it and hands out a one-time confirm
/// block, and a POST /v1/waiting/act without such a block never leaves the phone.
///
/// ops: hello · request {id, method, path, query, body, timeoutMs} · cancel {id} · pair.start · pair.stop ·
///      pair.torch {on} · pair.enter · pair.forget · settings · unlock {passcode} · lock.peek ·
///      confirm {key, action, label, title, clockOffsetMs}
/// events: pair {state: checking | paired | failed, ...} ·
///         lock {locked, state: idle | checking | cancelled | failed | no_passcode, biometry, passcode}
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "gup"

    weak var webView: WKWebView?
    weak var host: BridgeHost?
    let scanner = QRScanner()
    /// true when a message comes from the app's own page (main frame, a file inside the bundled web/)
    var isTrustedPage: (URL) -> Bool = { _ in false }

    private var pairing: Pairing?
    private var tasks: [Int: (serial: Int, task: Task<Void, Never>)] = [:]
    private var taskSerial = 0
    /// bumped by every pair.start / pair.stop, so a camera start that finishes late can't undo a stop
    private var scanGeneration = 0
    private var scanning = false
    private var checking = false
    /// the "enter code instead" field, closed when the app locks
    private weak var codeAlert: UIAlertController?
    private var rejected: (text: String, until: Date)?

    let auth = OwnerAuth()
    private(set) var locked = true
    /// Face ID came up by itself once for this lock; after a cancel the owner taps to try again
    private var autoPrompted = false
    /// bumped by every lock(): a check that finishes after the app was locked again counts for nothing
    private var lockGeneration = 0
    private var lockState = "idle"
    private var issued: [IssuedConfirm] = []
    private static let confirmLife: TimeInterval = 90          // the PC takes confirmations up to 2 min old
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral          // no cookies, cache or credentials on disk
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.waitsForConnectivity = false
        c.httpMaximumConnectionsPerHost = 6
        return URLSession(configuration: c, delegate: NoRedirects(), delegateQueue: nil)
    }()

    override init() {
        super.init()
        scanner.onCode = { [weak self] text in self?.handleCode(text, fromCamera: true) }
    }

    // MARK: - messages from the page

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, isTrustedPage(url),
              let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return replyHandler(nil, "refused")
        }
        if locked && !["hello", "unlock", "lock.peek", "cancel", "settings"].contains(op) {
            return op == "request" ? replyHandler(["error": "locked"], nil) : replyHandler(nil, "locked")
        }
        switch op {
        case "hello":
            replyHandler(hello(), nil)
        case "unlock":
            Task { replyHandler(await self.unlock(passcodeFirst: (body["passcode"] as? Bool) ?? false), nil) }
        case "lock.peek":
            Task { replyHandler(await self.peek(), nil) }
        case "confirm":
            guard let key = body["key"] as? String, let action = body["action"] as? String,
                  !key.isEmpty, key.count <= 200, !action.isEmpty, action.count <= 64 else {
                return replyHandler(["error": "bad_request"], nil)
            }
            // the answer text is part of the decision: the block only goes out with exactly this text
            let text = ((body["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let title = String(((body["title"] as? String) ?? key).prefix(120))
            let offset = max(-86_400_000, min(86_400_000, (body["clockOffsetMs"] as? Double) ?? 0))
            // the prompt names the action the block is for (not a label the page picked); Face ID shows no text,
            // the passcode and Touch ID sheets do
            let reason = "\(action) · \(title)"
            Task {
                replyHandler(await self.confirm(key: key, action: action, text: text, reason: reason,
                                                offsetMs: offset), nil)
            }
        case "request":
            guard let id = body["id"] as? Int else { return replyHandler(nil, "bad request") }
            tasks[id]?.task.cancel()
            taskSerial += 1
            let serial = taskSerial
            let task = Task { [weak self] in
                guard let self else { return replyHandler(["error": "aborted"], nil) }
                let result = await self.request(body)
                if self.tasks[id]?.serial == serial { self.tasks[id] = nil }
                replyHandler(result, nil)
            }
            tasks[id] = (serial, task)
        case "cancel":
            if let id = body["id"] as? Int { tasks[id]?.task.cancel() }
            replyHandler(nil, nil)
        case "pair.start":
            startScanning { replyHandler($0, nil) }
        case "pair.stop":
            stopScanning()
            replyHandler(nil, nil)
        case "pair.torch":
            replyHandler(["on": scanner.setTorch((body["on"] as? Bool) ?? false)], nil)
        case "pair.enter":
            askForCode()
            replyHandler(nil, nil)
        case "pair.forget":
            cancelAll()
            PairingStore.clear()
            pairing = nil
            replyHandler(["paired": false], nil)
        case "settings":
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            replyHandler(nil, nil)
        default:
            replyHandler(nil, "unknown op")
        }
    }

    /// the page was reloaded or its process died: nothing in flight belongs to anyone anymore
    func pageWillReload() {
        cancelAll()
        stopScanning()
    }

    private func cancelAll() {
        tasks.values.forEach { $0.task.cancel() }
        tasks.removeAll()
    }

    private func hello() -> [String: Any] {
        if locked { return lockInfo() }
        do {
            pairing = try PairingStore.load()
        } catch {
            return ["native": 1, "paired": false, "keychain": "locked"]
        }
        guard let p = pairing else { return ["native": 1, "paired": false] }
        return ["native": 1, "locked": false, "paired": true, "host": p.shortHost, "fqdn": p.baseURL.host ?? "",
                "pairedAt": iso(p.pairedAt)]
    }

    // MARK: - app lock

    private func lockInfo() -> [String: Any] {
        let caps = OwnerAuth.capabilities()
        return ["native": 1, "locked": locked, "state": lockState, "biometry": caps.biometry, "passcode": caps.passcode]
    }

    private func setLockState(_ state: String) {
        lockState = state
        emit("lock", lockInfo())
    }

    /// The app went to the background: lock, stop everything in flight, forget unused confirmations.
    func lock() {
        lockGeneration += 1
        auth.cancel()
        autoPrompted = false
        issued.removeAll()
        codeAlert?.dismiss(animated: false)
        if !locked {
            locked = true
            cancelAll()
            stopScanning()
        }
        setLockState("idle")
    }

    /// Tells the page the lock state again; done runs once the page has taken it in.
    func syncLock(_ done: @escaping () -> Void) {
        emit("lock", lockInfo(), done: done)
    }

    /// The app is on screen and locked: Face ID comes up by itself, once per lock.
    func autoUnlock() {
        guard locked, !autoPrompted, !auth.busy else { return }
        Task { _ = await unlock(passcodeFirst: false) }
    }

    private func unlock(passcodeFirst: Bool) async -> [String: Any] {
        guard locked else { return ["unlocked": true] }
        guard !auth.busy else { return ["unlocked": false, "reason": "busy"] }
        autoPrompted = true
        let generation = lockGeneration
        setLockState("checking")
        let out = await auth.run(reason: "Unlock GupWorks", passcodeFirst: passcodeFirst)
        guard generation == lockGeneration, locked else { return ["unlocked": !locked] }
        let state: String
        switch out {
        case .passed:
            locked = false
            setLockState("idle")
            return ["unlocked": true]
        case .cancelled, .busy: state = "cancelled"
        case .failed: state = "failed"
        case .noPasscode: state = "no_passcode"
        }
        setLockState(state)
        return ["unlocked": false, "reason": state]
    }

    /// The lock screen's one line about the PC: how many things wait on the owner (a number, nothing else).
    private func peek() async -> [String: Any] {
        guard let p = try? PairingStore.load() else { return [:] }
        let out = await send(base: p.baseURL, token: p.pendingToken ?? p.token, method: "GET", path: "/v1/status",
                             query: [:], body: nil, timeout: 10)
        guard out.status == 200, let body = out.body,
              let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let waiting = json["waiting"] as? Int else { return [:] }
        return ["waiting": waiting]
    }

    // MARK: - owner decisions

    /// Face ID (or the passcode) for exactly this decision, then a confirm block the request gate takes once.
    private func confirm(key: String, action: String, text: String, reason: String,
                         offsetMs: Double) async -> [String: Any] {
        let generation = lockGeneration
        let out = await auth.run(reason: reason)
        guard generation == lockGeneration, !locked else { return ["error": "cancelled"] }
        switch out {
        case .passed(let method):
            // the contract's own form (docs/phone-api.md): seconds, +00:00
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "UTC")
            f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssxxxxx"
            let at = f.string(from: Date().addingTimeInterval(offsetMs / 1000))
            issued.removeAll { $0.expires < Date() }
            issued.append(IssuedConfirm(key: key, action: action, method: method, at: at, text: text,
                                        expires: Date().addingTimeInterval(Self.confirmLife)))
            return ["confirm": ["key": key, "action": action, "method": method, "at": at]]
        case .cancelled: return ["error": "cancelled"]
        case .failed: return ["error": "failed"]
        case .noPasscode: return ["error": "no_passcode"]
        case .busy: return ["error": "busy"]
        }
    }

    /// POST /v1/waiting/act: only a body whose key, action, text and confirm block match a confirmation this bridge
    /// handed out (which is then used up). Returns the body to send, built again from exactly what was checked (so
    /// the PC can't read a different decision out of the same bytes), or nil.
    private func takeConfirmation(_ body: Data?) -> Data? {
        guard let body, let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let key = json["key"] as? String, let action = json["action"] as? String,
              let c = json["confirm"] as? [String: Any], c.count == 4,
              c["key"] as? String == key, c["action"] as? String == action,
              let method = c["method"] as? String, let at = c["at"] as? String else { return nil }
        if json["text"] != nil && !(json["text"] is String) { return nil }
        let text = ((json["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        issued.removeAll { $0.expires < Date() }
        guard let i = issued.firstIndex(where: {
            $0.key == key && $0.action == action && $0.method == method && $0.at == at && $0.text == text
        }) else { return nil }
        issued.remove(at: i)
        var out: [String: Any] = ["key": key, "action": action,
                                  "confirm": ["key": key, "action": action, "method": method, "at": at]]
        if !text.isEmpty { out["text"] = text }
        return try? JSONSerialization.data(withJSONObject: out)
    }

    // MARK: - API requests

    private func request(_ a: [String: Any]) async -> [String: Any] {
        guard let p = pairing else { return ["error": "not_paired"] }
        guard let method = a["method"] as? String, method == "GET" || method == "POST",
              let path = a["path"] as? String, Self.isApiPath(path) else { return ["error": "bad_request"] }
        let query = (a["query"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
        var body = (a["body"] as? String).map { Data($0.utf8) }
        if let body, body.count > 64 * 1024 { return ["error": "bad_request"] }
        if path == "/v1/waiting/act" {
            // never sent: an owner decision without this phone's own Face ID check for exactly it
            guard method == "POST", let checked = takeConfirmation(body) else {
                return ["status": 428,
                        "body": #"{"error":{"code":"confirmation_required","message":"Confirm this decision with Face ID first."}}"#]
            }
            body = checked
        }
        let timeout = max(1, min(120, ((a["timeoutMs"] as? Double) ?? 15000) / 1000))

        let rotating = method == "POST" && path == "/v1/auth/rotate"
        let usedPending = p.pendingToken != nil
        var out = await send(base: p.baseURL, token: p.pendingToken ?? p.token, method: method, path: path,
                             query: query, body: body, timeout: timeout)
        if usedPending, var now = pairing, now.pendingToken == p.pendingToken, let status = out.status {
            if (200..<300).contains(status) {
                // first success with the new token: from now on it's the only one the PC accepts
                now.token = p.pendingToken!
                now.pendingToken = nil
                pairing = now
                PairingStore.save(now)
            } else if status == 401 {
                // the PC doesn't take the rotated token (expired, or revoked): drop it and go on with the old one
                now.pendingToken = nil
                pairing = now
                PairingStore.save(now)
                if Task.isCancelled { return ["error": "aborted"] }
                out = await send(base: p.baseURL, token: p.token, method: method, path: path, query: query,
                                 body: body, timeout: timeout)
            }
        }
        if rotating, out.status == 200 { return keepRotatedToken(out.body, for: p) }
        return out.reply
    }

    /// POST /v1/auth/rotate answered with a new token: keep it in the Keychain as pending and give the page the
    /// answer without it.
    private func keepRotatedToken(_ body: Data?, for asked: Pairing) -> [String: Any] {
        guard !Task.isCancelled, pairing?.baseURL == asked.baseURL, pairing?.pairedAt == asked.pairedAt else {
            return ["error": "aborted"]
        }
        guard let body, let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let token = json["token"] as? String, PairLink.isToken(token), var now = pairing else {
            return ["status": 502, "body": #"{"error":{"code":"server_error","message":"The PC sent no usable token"}}"#]
        }
        now.pendingToken = token
        guard PairingStore.save(now) else {
            return ["status": 500, "body": #"{"error":{"code":"server_error","message":"Couldn't save the new key"}}"#]
        }
        pairing = now
        let created = (json["created_at"] as? String) ?? ""
        let safe = (try? JSONSerialization.data(withJSONObject: ["rotated": true, "created_at": created] as [String: Any])) ?? Data()
        return ["status": 200, "body": String(decoding: safe, as: UTF8.self)]
    }

    private struct Outcome {
        var status: Int?
        var body: Data?
        var error: String?
        var reply: [String: Any] {
            if let status { return ["status": status, "body": String(decoding: body ?? Data(), as: UTF8.self)] }
            return ["error": error ?? "unreachable"]
        }
    }

    private func send(base: URL, token: String, method: String, path: String, query: [String: String], body: Data?,
                      timeout: Double) async -> Outcome {
        guard var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return Outcome(error: "bad_request") }
        c.percentEncodedPath = path
        if !query.isEmpty {
            c.percentEncodedQuery = query.sorted { $0.key < $1.key }
                .map { Self.encode($0.key) + "=" + Self.encode($0.value) }.joined(separator: "&")
        }
        guard let url = c.url else { return Outcome(error: "bad_request") }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { return Outcome(error: "unreachable") }
            return Outcome(status: http.statusCode, body: data)
        } catch let e as URLError {
            switch e.code {
            case .cancelled: return Outcome(error: "aborted")
            case .timedOut: return Outcome(error: "timeout")
            default: return Outcome(error: "unreachable")
            }
        } catch {
            return Outcome(error: Task.isCancelled ? "aborted" : "unreachable")
        }
    }

    /// only the API's own paths: /v1/ plus plain segments (no dots, escapes, query or fragment)
    static func isApiPath(_ path: String) -> Bool {
        let ok = CharacterSet.ascii(plus: "/_-")
        return path.hasPrefix("/v1/") && path.count < 200 && !path.contains("//") && !path.hasSuffix("/")
            && path.unicodeScalars.allSatisfy(ok.contains)
    }

    private static func encode(_ s: String) -> String {
        let ok = CharacterSet.ascii(plus: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: ok) ?? ""
    }

    // MARK: - pairing

    private func startScanning(_ reply: @escaping ([String: Any]) -> Void) {
        checking = false
        rejected = nil
        scanGeneration += 1
        let generation = scanGeneration
        scanner.start { [weak self] result in
            guard let self else { return }
            guard generation == self.scanGeneration else {
                // stopped (or started again) while the camera was coming up
                if result == .running && !self.scanning { self.scanner.stop() }
                return reply(["error": "stopped"])
            }
            switch result {
            case .running:
                self.scanning = true
                self.host?.setCameraVisible(true)
                reply(["ok": true])
            case .denied: reply(["error": "denied"])
            case .noCamera: reply(["error": "no_camera"])
            }
        }
    }

    private func stopScanning() {
        scanGeneration += 1
        scanning = false
        scanner.stop()
        host?.setCameraVisible(false)
    }

    /// "enter code instead": the pairing link pasted into a native field, so it never passes through the page
    private func askForCode() {
        let alert = UIAlertController(title: "Pairing link",
                                      message: "Paste the pairing link (gupworks://pair?…) the PC gave you.",
                                      preferredStyle: .alert)
        alert.addTextField { f in
            f.placeholder = "gupworks://pair?…"
            f.autocorrectionType = .no
            f.autocapitalizationType = .none
            f.spellCheckingType = .no
            f.keyboardType = .URL
            f.textContentType = .none
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Pair", style: .default) { [weak self, weak alert] _ in
            if let text = alert?.textFields?.first?.text, !text.isEmpty { self?.handleCode(text, fromCamera: false) }
        })
        codeAlert = alert
        host?.presentNative(alert)
    }

    private func handleCode(_ text: String, fromCamera: Bool) {
        if locked || (fromCamera && !scanning) { return }
        guard !checking else { return }
        // the same failed code stays in view: say it once, then give the owner a moment before trying it again
        if fromCamera, let r = rejected, r.text == text, Date() < r.until { return }
        switch PairLink.parse(text) {
        case .failure(let problem):
            reject(text, title: problem.title, message: problem.message)
        case .success(let link):
            checking = true
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            let short = String(link.baseURL.host?.split(separator: ".").first ?? "")
            emit("pair", ["state": "checking", "host": short])
            Task { await self.check(link, code: text, host: short) }
        }
    }

    /// The new token's first request (GET /v1/status). It tells the PC the phone has it (the PC's window says
    /// "Paired"), and only a token the PC accepts is saved.
    private func check(_ link: PairLink, code: String, host: String) async {
        let t0 = Date()
        let out = await send(base: link.baseURL, token: link.token, method: "GET", path: "/v1/status", query: [:],
                             body: nil, timeout: 15)
        let rtt = Int(Date().timeIntervalSince(t0) * 1000)
        defer { checking = false }
        guard let status = out.status else {
            return reject(code, title: "can't reach \(host)",
                          message: "Is Tailscale on on this phone, and the PC awake? Then scan again.")
        }
        guard status == 200, let body = out.body,
              let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any], json["api"] != nil else {
            if status == 401 {
                return reject(code, title: "code not valid anymore",
                              message: "It was replaced or revoked on the PC. Make a new one there and scan it.")
            }
            return reject(code, title: "the PC said no (HTTP \(status))", message: "Try a new code from the PC.")
        }
        let p = Pairing(baseURL: link.baseURL, token: link.token, pairedAt: Date(), pendingToken: nil)
        guard PairingStore.save(p) else {
            return reject(code, title: "couldn't save the key", message: "The iPhone Keychain refused it. Unlock the phone and try again.")
        }
        cancelAll()                                   // anything still running used the old pairing
        pairing = p
        scanning = false
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        emit("pair", ["state": "paired", "host": host, "fqdn": link.baseURL.host ?? "", "rtt": rtt,
                      "pairedAt": iso(p.pairedAt)])
    }

    private func reject(_ code: String, title: String, message: String) {
        rejected = (code, Date().addingTimeInterval(4))
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        emit("pair", ["state": "failed", "title": title, "message": message])
    }

    // MARK: - events to the page

    private func emit(_ name: String, _ data: [String: Any], done: (() -> Void)? = nil) {
        guard let json = try? JSONSerialization.data(withJSONObject: data),
              let name = try? JSONSerialization.data(withJSONObject: [name]), let webView else { done?(); return }
        // `; true`: the script's value must be something WebKit can hand back, or the completion reports an error
        let js = "window.GupNative && GupNative._event(\(String(decoding: name, as: UTF8.self))[0], \(String(decoding: json, as: UTF8.self))); true"
        webView.evaluateJavaScript(js) { _, _ in done?() }
    }

    private func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: d)
    }
}

/// The API never redirects; a redirect would mean something between the phone and the PC is wrong, so it's not
/// followed (the 3xx goes to the page as an error answer).
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
