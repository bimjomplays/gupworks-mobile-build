import Foundation
import LocalAuthentication

/// Face ID (or Touch ID) with the device passcode as the fallback: unlocking the app and confirming owner decisions.
///
/// iOS has no "passcode only" prompt: `.deviceOwnerAuthentication` lets iOS try biometrics first and then offers the
/// passcode. So a check runs biometrics-only first (that's the only way to know biometrics was what passed); when the
/// owner taps "Use Passcode", or biometrics is locked out or missing, a second check with `.deviceOwnerAuthentication`
/// follows and the method is reported as "passcode" (never more than what we know).
@MainActor
final class OwnerAuth {
    enum Outcome {
        /// method: face_id | touch_id | passcode (the phone API's confirm methods)
        case passed(method: String)
        case cancelled
        case failed
        /// no passcode set on this iPhone: nothing to check against
        case noPasscode
        /// another check is already on screen
        case busy
    }

    private var current: LAContext?
    private var generation = 0

    /// a check is on screen (its prompt makes the app inactive for a moment; that isn't the owner leaving)
    var busy: Bool { current != nil }

    /// what the lock screen should name: face_id | touch_id | none, and whether a passcode is set at all
    static func capabilities() -> (biometry: String, passcode: Bool) {
        let ctx = LAContext()
        var error: NSError?
        let bio = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        let kind: String
        switch ctx.biometryType {
        case .faceID: kind = "face_id"
        case .touchID: kind = "touch_id"
        default: kind = "none"
        }
        let passcode = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
        // enrolled but locked out still names the sensor; not enrolled at all is "none"
        let enrolled = bio || (error.map { LAError.Code(rawValue: $0.code) == .biometryLockout } ?? false)
        return (enrolled ? kind : "none", passcode)
    }

    /// Stops the check on screen (the app went to the background); it ends as .cancelled.
    func cancel() {
        generation += 1
        current?.invalidate()
        current = nil
    }

    func run(reason: String, passcodeFirst: Bool = false) async -> Outcome {
        guard current == nil else { return .busy }
        generation += 1
        let mine = generation
        defer { if generation == mine { current = nil } }

        let bioCtx = LAContext()
        var bioError: NSError?
        let canBio = bioCtx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &bioError)
        if canBio && !passcodeFirst {
            current = bioCtx
            bioCtx.localizedFallbackTitle = "Use Passcode"
            let method = bioCtx.biometryType == .touchID ? "touch_id" : "face_id"
            do {
                if try await bioCtx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) {
                    return generation == mine ? .passed(method: method) : .cancelled
                }
                return .failed
            } catch let e as LAError {
                guard generation == mine else { return .cancelled }
                switch e.code {
                case .userFallback, .biometryLockout: break          // on to the passcode below
                case .userCancel, .systemCancel, .appCancel: return .cancelled
                case .passcodeNotSet: return .noPasscode
                default: return .failed
                }
            } catch {
                return generation == mine ? .failed : .cancelled
            }
        }

        let ctx = LAContext()
        var error: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return (error.map { LAError.Code(rawValue: $0.code) == .passcodeNotSet } ?? false) ? .noPasscode : .failed
        }
        current = ctx
        do {
            if try await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) {
                return generation == mine ? .passed(method: "passcode") : .cancelled
            }
            return .failed
        } catch let e as LAError {
            guard generation == mine else { return .cancelled }
            switch e.code {
            case .userCancel, .systemCancel, .appCancel: return .cancelled
            case .passcodeNotSet: return .noPasscode
            default: return .failed
            }
        } catch {
            return generation == mine ? .failed : .cancelled
        }
    }
}
