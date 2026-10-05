import Foundation
import Security

/// The paired PC: its base URL and the device token. Lives ONLY in the iOS Keychain (this device only, readable while
/// unlocked): never UserDefaults, files, logs or the web page. The page gets the host's short name and the pairing
/// date, nothing else (NativeBridge does every request itself).
struct Pairing: Codable, Equatable {
    var baseURL: URL
    var token: String
    var pairedAt: Date
    /// A rotated token (POST /v1/auth/rotate) the PC hasn't seen in use yet. Requests use it; the first answer that
    /// isn't a 401 makes it the token. The old one keeps working on the PC until then, so a lost answer can't lock
    /// the phone out.
    var pendingToken: String?

    /// The machine name only (first label of the host), for the UI.
    var shortHost: String { String((baseURL.host ?? "").split(separator: ".").first ?? "") }
}

enum PairingStore {
    enum StoreError: Error { case unavailable(OSStatus) }

    private static let service = "app.gupworks.mobile.pairing"
    private static let account = "pc"

    private static var item: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    /// nil = not paired. Throws when the Keychain can't be read right now (e.g. the phone is locked).
    static func load() throws -> Pairing? {
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw StoreError.unavailable(status) }
        // an item this build can't read (older format, damaged) counts as not paired
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    @discardableResult
    static func save(_ pairing: Pairing) -> Bool {
        guard let data = try? JSONEncoder().encode(pairing) else { return false }
        let attrs: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(item as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(item.merging(attrs) { $1 } as CFDictionary, nil)
        }
        return status == errSecSuccess
    }

    static func clear() {
        SecItemDelete(item as CFDictionary)
    }
}

/// The pairing QR (docs/phone-api.md in the gupworks repo):
///     gupworks://pair?v=1&url=<percent-encoded base URL>&token=<device token>
/// The base URL must be a Tailscale HTTPS address (a MagicDNS name: the last two labels are `ts` and `net`), so a
/// code can't point the app at an ordinary internet host. That alone doesn't prove it's the OWNER's tailnet (another
/// tailnet's Funnel name has the same shape), which is why the full host name is shown on This phone.
struct PairLink {
    let baseURL: URL
    let token: String

    enum Problem: Error {
        case notOurs, newerVersion, badAddress, badToken

        var title: String {
            switch self {
            case .notOurs: return "not a GupWorks code"
            case .newerVersion: return "code from a newer GupWorks"
            case .badAddress: return "not a Tailscale address"
            case .badToken: return "damaged code"
            }
        }
        var message: String {
            switch self {
            case .notOurs: return "Point the camera at the code in GupWorks › Settings › Phone › Pair a phone."
            case .newerVersion: return "The PC made a code this app doesn't know yet. Update the app, then scan again."
            case .badAddress: return "The code's PC address isn't a Tailscale HTTPS name, so the app won't use it."
            case .badToken: return "The key in the code is cut off or damaged. Make a new code on the PC."
            }
        }
    }

    static func parse(_ text: String) -> Result<PairLink, Problem> {
        guard let c = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              c.scheme?.lowercased() == "gupworks", c.host?.lowercased() == "pair",
              c.path.isEmpty || c.path == "/", let items = c.queryItems else { return .failure(.notOurs) }
        var q: [String: String] = [:]
        for it in items {
            // a field twice is a crafted code, not one the PC made
            guard q[it.name] == nil else { return .failure(.notOurs) }
            q[it.name] = it.value ?? ""
        }
        guard let v = q["v"].flatMap(Int.init) else { return .failure(.notOurs) }
        guard v == 1 else { return .failure(v > 1 ? .newerVersion : .notOurs) }
        guard let raw = q["url"], let url = tailnetBaseURL(raw) else { return .failure(.badAddress) }
        guard let token = q["token"], isToken(token) else { return .failure(.badToken) }
        return .success(PairLink(baseURL: url, token: token))
    }

    /// https://<machine>.<tailnet>.<ts>.<net>[:port][/] with nothing else (no user, path, query or fragment)
    static func tailnetBaseURL(_ raw: String) -> URL? {
        guard let c = URLComponents(string: raw), c.scheme?.lowercased() == "https",
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/", let host = c.host?.lowercased() else { return nil }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let ok = CharacterSet.ascii(upper: false, plus: "-")
        guard labels.count >= 4, labels.suffix(2) == ["ts", "net"],
              labels.allSatisfy({ !$0.isEmpty && $0.count <= 63 && $0.unicodeScalars.allSatisfy(ok.contains) }) else { return nil }
        var out = URLComponents()
        out.scheme = "https"
        out.host = host
        out.port = c.port
        return out.url
    }

    /// base64url without padding; the PC makes 43 characters (32 bytes)
    static func isToken(_ s: String) -> Bool {
        let ok = CharacterSet.ascii(plus: "-_")
        return (43...128).contains(s.count) && s.unicodeScalars.allSatisfy(ok.contains)
    }
}

extension CharacterSet {
    /// ASCII digits and letters (lower case, and upper case unless upper is false) plus the characters in `plus`.
    /// Not .alphanumerics: that also takes letters from every other script.
    static func ascii(upper: Bool = true, plus: String) -> CharacterSet {
        var set = CharacterSet(charactersIn: "0"..."9")
        set.formUnion(CharacterSet(charactersIn: "a"..."z"))
        if upper { set.formUnion(CharacterSet(charactersIn: "A"..."Z")) }
        set.insert(charactersIn: plus)
        return set
    }
}
