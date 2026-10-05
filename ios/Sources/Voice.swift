import AVFoundation
import Speech

/// Talking to Gup: the microphone into Apple's speech recognizer, ON THE DEVICE ONLY. The request sets
/// `requiresOnDeviceRecognition`, and when this iPhone has no on-device model for its language there is no voice input
/// at all (never a fallback to Apple's servers). The audio is only handed to the recognizer: nothing is recorded,
/// saved or sent anywhere. The page gets the words as they come and decides what to do with them; only text the
/// owner sends goes to the PC.
///
/// One dictation at a time. `start` asks for the two permissions when needed (speech recognition, microphone), then
/// listens until `stop` (the recognizer finishes what it heard, and the final text is handed back), `cancel`, an
/// interruption (a call), its own end (a long pause, an error) or `maxSeconds`.
///
/// Every event carries the page's `tag` for the dictation, so the page can drop anything from an older one:
///     {tag, state: "listening", text}   the words so far (they can still change)
///     {tag, level}                      microphone level 0...1, about 15 times a second, for the waveform
///     {tag, state: "stopped", text, reason: ended | limit | interrupted | no_speech | failed}   it ended by itself
/// Callbacks and events come on the main queue.
final class VoiceInput: NSObject {
    static let maxSeconds: TimeInterval = 120

    var onEvent: (([String: Any]) -> Void)?
    /// a dictation is starting or listening
    var active: Bool { starting || task != nil }

    /// a new engine per dictation: a reused one can keep a stale input format after a call or a route change
    private var engine: AVAudioEngine?
    private var sessionActive = false
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapInstalled = false
    /// bumped by every start and cancel: a callback from an earlier dictation counts for nothing
    private var session = 0
    private var tag = 0
    private var starting = false
    private var text = ""
    /// why the audio was ended on purpose (stop, limit, interruption); the recognizer's last answer then counts as the end
    private var endReason: String?
    /// `stop` waits here for the final text
    private var finishing: ((String) -> Void)?
    private var limitTimer: Timer?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)),
                                               name: AVAudioSession.interruptionNotification, object: nil)
    }

    // MARK: - start / stop / cancel

    /// done: {ok, tag, locale, maxSeconds} or {error: busy | speech_denied | mic_denied | restricted | language |
    /// no_on_device | unavailable | audio | cancelled, locale?}
    func start(tag: Int, _ done: @escaping ([String: Any]) -> Void) {
        guard !active else { return done(["error": "busy"]) }
        session += 1
        let id = session
        self.tag = tag
        starting = true
        askPermissions { [weak self] problem in
            guard let self else { return done(["error": "cancelled"]) }
            guard id == self.session, self.starting else { return done(["error": "cancelled"]) }
            self.starting = false
            if let problem { return done(["error": problem]) }
            done(self.begin(id))
        }
    }

    /// Stops listening; done gets the final text once the recognizer has finished what it heard.
    func stop(_ done: @escaping (String) -> Void) {
        guard task != nil else {
            if starting { cancel() }                   // still asking for permission: nothing heard yet
            return done(text)
        }
        if let earlier = finishing { earlier(text) }
        finishing = done
        endAudio(session, reason: "stopped")
    }

    /// Drops the dictation (the page closed it, the app locked, the page reloaded). Nothing more comes from it.
    func cancel() {
        session += 1
        starting = false
        if let done = finishing { finishing = nil; done(text) }
        teardown()
        text = ""
    }

    // MARK: - permissions

    private func askPermissions(_ done: @escaping (String?) -> Void) {
        let audio = AVAudioSession.sharedInstance()
        let mic = {
            switch audio.recordPermission {
            case .granted: done(nil)
            case .denied: done("mic_denied")
            default:
                audio.requestRecordPermission { ok in DispatchQueue.main.async { done(ok ? nil : "mic_denied") } }
            }
        }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: mic()
        case .denied: done("speech_denied")
        case .restricted: done("restricted")
        default:
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    switch status {
                    case .authorized: mic()
                    case .restricted: done("restricted")
                    default: done("speech_denied")
                    }
                }
            }
        }
    }

    // MARK: - listening

    private func begin(_ id: Int) -> [String: Any] {
        // the phone's own language, like the keyboard's dictation
        guard let recognizer = SFSpeechRecognizer() else {
            return ["error": "language", "locale": Locale.current.identifier]
        }
        let locale = recognizer.locale.identifier
        // the whole point: no audio leaves the phone. No on-device model, no voice input.
        guard recognizer.supportsOnDeviceRecognition else { return ["error": "no_on_device", "locale": locale] }
        guard recognizer.isAvailable else { return ["error": "unavailable", "locale": locale] }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true

        let audio = AVAudioSession.sharedInstance()
        do {
            // .record takes no options: duckOthers/mixWithOthers are only for playback, playAndRecord and multiRoute
            try audio.setCategory(.record, mode: .measurement, options: [])
            try audio.setActive(true, options: .notifyOthersOnDeactivation)
            sessionActive = true
        } catch {
            teardown()
            return ["error": "audio", "locale": locale]
        }
        let engine = AVAudioEngine()
        self.engine = engine
        // headphones in or out mid-dictation stop the engine: end it like an interruption, keeping what was heard
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged(_:)),
                                               name: .AVAudioEngineConfigurationChange, object: engine)
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            teardown()
            return ["error": "audio", "locale": locale]
        }
        let tag = self.tag
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tap(request) { [weak self] level in
            DispatchQueue.main.async {
                guard let self, id == self.session, self.task != nil, self.endReason == nil else { return }
                self.onEvent?(["tag": tag, "level": level])
            }
        })
        tapInstalled = true
        engine.prepare()
        do {
            try engine.start()
        } catch {
            teardown()
            return ["error": "audio", "locale": locale]
        }

        self.recognizer = recognizer
        self.request = request
        text = ""
        endReason = nil
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let said = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let noSpeech = (error as NSError?).map { $0.domain == "kAFAssistantErrorDomain" && $0.code == 1110 } ?? false
            DispatchQueue.main.async {
                self?.recognized(id, said: said, isFinal: isFinal, failed: error != nil, noSpeech: noSpeech)
            }
        }
        limitTimer = Timer.scheduledTimer(withTimeInterval: Self.maxSeconds, repeats: false) { [weak self] _ in
            self?.endAudio(id, reason: "limit")
        }
        return ["ok": true, "tag": tag, "locale": locale, "maxSeconds": Int(Self.maxSeconds)]
    }

    private func recognized(_ id: Int, said: String?, isFinal: Bool, failed: Bool, noSpeech: Bool) {
        guard id == session, task != nil else { return }
        if let said {
            text = said
            if !isFinal && endReason == nil { onEvent?(["tag": tag, "state": "listening", "text": said]) }
        }
        guard isFinal || failed else { return }
        // ended on purpose (the recognizer's last answer is the final text), or by itself; an error with nothing heard
        // is silence (the on-device recognizer doesn't always say so with the server's 1110)
        let reason = endReason ?? (isFinal ? "ended" : noSpeech || text.isEmpty ? "no_speech" : "failed")
        finish(id, reason: reason)
    }

    /// No more sound goes in; the recognizer answers once more with what it heard (or the fallback ends it).
    private func endAudio(_ id: Int, reason: String) {
        guard id == session, task != nil, endReason == nil else { return }
        endReason = reason
        stopAudio()
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.finish(id, reason: reason) }
    }

    private func finish(_ id: Int, reason: String) {
        guard id == session, task != nil else { return }
        let said = text
        teardown()
        if let done = finishing {
            finishing = nil
            done(said)
        } else {
            onEvent?(["tag": tag, "state": "stopped", "text": said, "reason": reason])
        }
    }

    @objc private func interrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
        DispatchQueue.main.async { self.endAudio(self.session, reason: "interrupted") }
    }

    @objc private func routeChanged(_ note: Notification) {
        DispatchQueue.main.async {
            guard let engine = note.object as? AVAudioEngine, engine === self.engine else { return }
            self.endAudio(self.session, reason: "interrupted")
        }
    }

    private func stopAudio() {
        guard let engine else { return }
        if engine.isRunning { engine.stop() }
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
    }

    private func teardown() {
        limitTimer?.invalidate()
        limitTimer = nil
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        endReason = nil
        if let engine {
            NotificationCenter.default.removeObserver(self, name: .AVAudioEngineConfigurationChange, object: engine)
            self.engine = nil
        }
        if sessionActive {
            sessionActive = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// The microphone tap (runs on the audio thread): every buffer goes to the recognizer, and about 15 times a
    /// second the loudness goes out for the waveform.
    private static func tap(_ request: SFSpeechAudioBufferRecognitionRequest,
                            level: @escaping (Double) -> Void) -> AVAudioNodeTapBlock {
        let throttle = Throttle()
        return { buffer, _ in
            request.append(buffer)
            let now = ProcessInfo.processInfo.systemUptime
            guard now - throttle.last >= 1.0 / 15, let samples = buffer.floatChannelData?[0] else { return }
            let n = Int(buffer.frameLength)
            guard n > 0 else { return }
            throttle.last = now
            var sum: Float = 0
            for i in 0..<n { sum += samples[i] * samples[i] }
            let db = 10 * log10(max(sum / Float(n), 1e-10))           // RMS loudness in dB
            level(Double(max(0, min(1, (db + 50) / 45))))           // -50 dB (a quiet room) ... -5 dB (loud) -> 0...1
        }
    }
}

/// the level throttle's clock, only touched on the audio thread (a box, so the tap block captures no mutable var)
private final class Throttle: @unchecked Sendable {
    var last: TimeInterval = 0
}
