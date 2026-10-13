import AVFoundation
import Foundation
import Speech

/// SFSpeechRecognizer path — the fallback engine, and the only engine on a Mac
/// older than macOS 26.
///
/// Two things about this API drive the shape of the code below:
///
///  1. It has no `speech_final`. A recognition task emits `isFinal` only when
///     the caller calls `endAudio()`. So one utterance == one task, created on
///     `beginUtterance` and ended on `endUtterance`. That is also why the VAD in
///     Audio.swift exists at all.
///  2. Apple: "Plan for a one-minute limit on audio duration. … the framework
///     stops speech recognition tasks that last longer than one minute." The
///     coordinator's `maxUtteranceMs` backstop keeps every task well inside it.
final class SFEngine: STTEngine {
    let name = "sfspeech"
    let isOnDevice = true // enforced in init; this engine refuses to run otherwise

    private let config: HelperConfig
    private let out: OutputWriter
    private let recognizer: SFSpeechRecognizer
    private let keyterms: [String]
    private let queue = DispatchQueue(label: "com.pro7ocol.callrec.stt.sf")

    /// Per-utterance state. Held by the result closure as well as by `current`,
    /// so a task that is still settling after the VAD has moved on can finish
    /// delivering its final without being confused for the new utterance.
    private final class Utterance {
        let request: SFSpeechAudioBufferRecognitionRequest
        var task: SFSpeechRecognitionTask?
        var lastPartial = ""
        var settled = false
        var timer: DispatchSourceTimer?
        init(request: SFSpeechAudioBufferRecognitionRequest) { self.request = request }
    }

    private var current: Utterance?

    init(config: HelperConfig, out: OutputWriter) throws {
        self.config = config
        self.out = out
        self.keyterms = config.boundedKeyterms

        let locale = Locale(identifier: config.locale)
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            throw EngineError.unsupportedLocale(
                "SFSpeechRecognizer has no support for locale '\(config.locale)' on this Mac.")
        }
        self.recognizer = recognizer

        try requireSpeechAuthorization()

        guard recognizer.isAvailable else {
            throw EngineError.unavailable(
                "SFSpeechRecognizer reports itself unavailable for '\(config.locale)' right now.")
        }

        // The privacy contract of this feature is that audio does not leave the
        // machine. `requiresOnDeviceRecognition` is only honoured when
        // `supportsOnDeviceRecognition` is true; otherwise the framework
        // silently falls back to Apple's servers. Refusing to start is the only
        // honest response — a native provider that quietly uploads interview
        // audio is worse than the disclosed Deepgram it replaced.
        guard recognizer.supportsOnDeviceRecognition else {
            throw EngineError.noOnDeviceRecognition(
                "This Mac has no on-device model for '\(config.locale)'. Download it in System Settings › Keyboard › Dictation (add the language, then wait for the download), or pick another provider. Refusing to start rather than sending audio to Apple's servers.")
        }
    }

    func start() throws {
        out.ready(engine: name, locale: config.locale, onDevice: true, keyterms: keyterms.count)
    }

    func beginUtterance() {
        queue.sync {
            endCurrentLocked(reason: "superseded")

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.requiresOnDeviceRecognition = true
            if !keyterms.isEmpty {
                // The accuracy lever. Deepgram gets the same list via Nova-3
                // `keyterm`; this is the closest native equivalent and the most
                // likely single reason for a score difference on invented words.
                request.contextualStrings = keyterms
            }
            if #available(macOS 13.0, *) {
                request.addsPunctuation = true
            }

            let utterance = Utterance(request: request)
            current = utterance
            utterance.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self else { return }
                self.queue.async {
                    self.handle(utterance: utterance, result: result, error: error)
                }
            }
        }
    }

    func append(_ buffer: AVAudioPCMBuffer, at time: Double) {
        _ = time // SFSpeechAudioBufferRecognitionRequest keeps its own timeline
        queue.sync {
            current?.request.append(buffer)
        }
    }

    func endUtterance() {
        queue.sync {
            guard let utterance = current else { return }
            utterance.request.endAudio()

            // Backstop: if the task never reports `isFinal` (it has been seen to
            // go quiet after endAudio on a no-speech tail), publish the last
            // partial as the final. The contract with the renderer is exactly
            // one final per utterance — the renderer appends one transcript line
            // per final, so a missing one loses a line and a duplicate one doubles it.
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 2.0)
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                self.settle(utterance: utterance, text: utterance.lastPartial)
            }
            timer.resume()
            utterance.timer = timer

            current = nil
        }
    }

    func finish() {
        queue.sync {
            endCurrentLocked(reason: "eof")
        }
        // Give an in-flight task a moment to deliver its final before the
        // process exits; the coordinator has already stopped feeding audio.
        Thread.sleep(forTimeInterval: 0.4)
        queue.sync { }
    }

    // MARK: - private, all on `queue`

    private func endCurrentLocked(reason: String) {
        guard let utterance = current else { return }
        current = nil
        utterance.request.endAudio()
        settle(utterance: utterance, text: utterance.lastPartial)
        utterance.task?.cancel()
        _ = reason
    }

    private func handle(utterance: Utterance, result: SFSpeechRecognitionResult?, error: Error?) {
        if let result {
            let text = result.bestTranscription.formattedString
            if result.isFinal {
                settle(utterance: utterance, text: text)
                return
            }
            utterance.lastPartial = text
            // Only the live utterance may paint the partial line; a stale task
            // still settling would otherwise overwrite the current speaker.
            if current === utterance { out.partial(text) }
            return
        }

        if let error {
            // kAFAssistantErrorDomain 1110 ("No speech detected") is routine —
            // the VAD opened on a door slam. Not worth a protocol-level error.
            let ns = error as NSError
            let isNoSpeech = ns.domain == "kAFAssistantErrorDomain" && (ns.code == 1110 || ns.code == 203)
            if !isNoSpeech {
                out.log("recognition task error: \(ns.domain) \(ns.code) — \(ns.localizedDescription)")
            }
            settle(utterance: utterance, text: utterance.lastPartial)
        }
    }

    /// Emits at most one `final` per utterance, then tears its state down.
    private func settle(utterance: Utterance, text: String) {
        guard !utterance.settled else { return }
        utterance.settled = true
        utterance.timer?.cancel()
        utterance.timer = nil
        out.final(text)
        utterance.lastPartial = ""
    }
}
