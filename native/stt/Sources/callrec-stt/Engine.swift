import AVFoundation
import Foundation
import Speech

// The seam between the engine-agnostic half of this helper (stdin framing, VAD,
// utterance coordination) and whichever Apple recognizer is actually running.
//
// Both engines are driven by exactly the same call sequence, which is what makes
// the two paths comparable in the benchmark:
//
//   start()                       once, after authorization
//   beginUtterance()              VAD opened an utterance
//   append(buffer, at: seconds)   ~100 ms of audio, monotonic presentation time
//   endUtterance()                VAD closed it — exactly one `final` must follow
//   finish()                      stdin hit EOF; drain and stop

protocol STTEngine: AnyObject {
    /// Reported in the `ready` line. "analyzer" or "sfspeech".
    var name: String { get }
    /// True only when recognition is guaranteed not to leave the machine.
    var isOnDevice: Bool { get }
    func start() throws
    func beginUtterance()
    func append(_ buffer: AVAudioPCMBuffer, at time: Double)
    func endUtterance()
    func finish()
}

enum EngineError: Error {
    case unsupportedLocale(String)
    case notAuthorized(String)
    case noOnDeviceRecognition(String)
    case unavailable(String)
    case assetsUnavailable(String)

    var code: String {
        switch self {
        case .unsupportedLocale: return "unsupported-locale"
        case .notAuthorized: return "not-authorized"
        case .noOnDeviceRecognition: return "no-on-device"
        case .unavailable: return "unavailable"
        case .assetsUnavailable: return "assets-unavailable"
        }
    }

    var message: String {
        switch self {
        case .unsupportedLocale(let m), .notAuthorized(let m), .noOnDeviceRecognition(let m),
             .unavailable(let m), .assetsUnavailable(let m):
            return m
        }
    }
}

/// Blocks until the user has answered the speech-recognition prompt (or until
/// the previously recorded TCC decision is read back, which is immediate).
///
/// This is called before any audio is submitted. The main process holds the
/// opening audio in its existing pending-chunk buffer while we wait, so a slow
/// human at the permission dialog costs words on screen, not words lost.
func requireSpeechAuthorization() throws {
    let semaphore = DispatchSemaphore(value: 0)
    var status: SFSpeechRecognizerAuthorizationStatus = .notDetermined
    SFSpeechRecognizer.requestAuthorization { result in
        status = result
        semaphore.signal()
    }
    // No timeout on purpose: a dialog the user has not answered yet is not an
    // error, and failing early would leave a permission prompt on screen with
    // nothing behind it.
    semaphore.wait()

    switch status {
    case .authorized:
        return
    case .denied:
        throw EngineError.notAuthorized(
            "Speech Recognition permission was denied. Grant it in System Settings › Privacy & Security › Speech Recognition, then restart callrec.")
    case .restricted:
        throw EngineError.notAuthorized("Speech Recognition is restricted on this Mac (device policy).")
    case .notDetermined:
        throw EngineError.notAuthorized("Speech Recognition permission was never resolved.")
    @unknown default:
        throw EngineError.notAuthorized("Speech Recognition returned an unknown authorization status.")
    }
}

/// Picks an engine according to `config.engine` ("auto" | "analyzer" | "sfspeech").
///
/// `auto` prefers SpeechAnalyzer: SFSpeechRecognizer's on-device guarantee is
/// conditional on `supportsOnDeviceRecognition`, and the failure mode of that
/// condition is silently streaming interview audio to Apple — which is the one
/// outcome this whole feature exists to avoid. Reasoning in full:
/// docs/native-stt-design.md §5.
func makeEngine(config: HelperConfig, inputFormat: AVAudioFormat, out: OutputWriter) throws -> STTEngine {
    let wantAnalyzer: Bool
    switch config.engine {
    case "analyzer": wantAnalyzer = true
    case "sfspeech": wantAnalyzer = false
    default: wantAnalyzer = true // "auto"
    }

    #if !INTERG_NO_ANALYZER
    if wantAnalyzer {
        if #available(macOS 26.0, *) {
            do {
                return try AnalyzerEngine(config: config, inputFormat: inputFormat, out: out)
            } catch {
                if config.engine == "analyzer" { throw error }
                let message = (error as? EngineError)?.message ?? "\(error)"
                out.log("SpeechAnalyzer unavailable (\(message)) — falling back to SFSpeechRecognizer")
            }
        } else if config.engine == "analyzer" {
            throw EngineError.unavailable("SpeechAnalyzer needs macOS 26 or later; this Mac is older.")
        } else {
            out.log("macOS is older than 26 — using SFSpeechRecognizer")
        }
    }
    #else
    if config.engine == "analyzer" {
        throw EngineError.unavailable("this helper was built with --no-analyzer; SpeechAnalyzer is not compiled in.")
    }
    #endif

    return try SFEngine(config: config, out: out)
}
