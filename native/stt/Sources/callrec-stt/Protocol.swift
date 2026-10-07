import Foundation

// The wire protocol between this helper and InterG's main process.
// Full description: docs/native-stt-design.md §3.

// MARK: - Config (stdin header)

/// Decoded from the JSON blob that precedes the audio on stdin.
///
/// Every field is optional on the wire; a missing field takes the default here.
/// Swift's synthesised `Decodable` would *reject* a missing key even when the
/// property has a default value, so `init(from:)` is written out by hand.
struct HelperConfig {
    /// 'THEM' (interviewer, system-audio loopback) or 'ME' (microphone).
    /// Used only to label diagnostics; the audio is identical either way.
    var speaker: String = "THEM"
    /// BCP-47 identifier, e.g. "en-US". One locale per helper — neither native
    /// API has a multilingual mode (design doc §7).
    var locale: String = "en-US"
    /// Vocabulary hints. Arrives on stdin, never on argv, because these are
    /// personal proper nouns and argv is readable through `ps`.
    var keyterms: [String] = []
    /// Contiguous silence that closes an utterance. 300 ms matches Deepgram's
    /// `endpointing=300` so the benchmark compares transcription, not policy.
    var endpointSilenceMs: Int = 300
    /// Backstop against the documented one-minute limit on SFSpeechRecognizer
    /// audio duration. Well under 60 s on purpose.
    var maxUtteranceMs: Int = 45_000
    /// "auto" | "analyzer" | "sfspeech".
    var engine: String = "auto"
}

extension HelperConfig: Decodable {
    private enum CodingKeys: String, CodingKey {
        case speaker, locale, keyterms, endpointSilenceMs, maxUtteranceMs, engine
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var out = HelperConfig()
        if let v = try c.decodeIfPresent(String.self, forKey: .speaker) { out.speaker = v }
        if let v = try c.decodeIfPresent(String.self, forKey: .locale), !v.isEmpty { out.locale = v }
        if let v = try c.decodeIfPresent([String].self, forKey: .keyterms) { out.keyterms = v }
        if let v = try c.decodeIfPresent(Int.self, forKey: .endpointSilenceMs) { out.endpointSilenceMs = v }
        if let v = try c.decodeIfPresent(Int.self, forKey: .maxUtteranceMs) { out.maxUtteranceMs = v }
        if let v = try c.decodeIfPresent(String.self, forKey: .engine), !v.isEmpty { out.engine = v }
        self = out
    }

    /// Apple documents a hard limit for both APIs: "Limit the total number of
    /// phrases to no more than 100." Truncating here (rather than letting the
    /// framework drop them silently) is what makes the `ready` line's count
    /// honest.
    var boundedKeyterms: [String] {
        let cleaned = keyterms
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return Array(cleaned.prefix(100))
    }

    var endpointSilenceClamped: Int { min(5_000, max(100, endpointSilenceMs)) }
    var maxUtteranceClamped: Int { min(55_000, max(2_000, maxUtteranceMs)) }
}

// MARK: - Output (stdout lines)

/// Serialises every stdout write onto one queue so lines cannot interleave.
///
/// stdout carries protocol only. Anything else — progress, diagnostics, the
/// asset-download notice — goes to stderr, which the main process collects but
/// never parses.
final class OutputWriter {
    private let queue = DispatchQueue(label: "com.pro7ocol.interg.stt.out")
    private let stdoutHandle = FileHandle.standardOutput
    private let stderrHandle = FileHandle.standardError

    /// Signalled exactly once, when the helper has either reported itself ready
    /// or failed fatally. `--selftest` waits on this; nothing else does.
    let settled = DispatchSemaphore(value: 0)
    private var hasSettled = false
    private let settleLock = NSLock()

    private func emit(_ object: [String: Any]) {
        queue.async {
            guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
            data.append(0x0A) // '\n' — the frame delimiter
            try? self.stdoutHandle.write(contentsOf: data)
        }
    }

    private func settle() {
        settleLock.lock()
        let first = !hasSettled
        hasSettled = true
        settleLock.unlock()
        if first { settled.signal() }
    }

    func ready(engine: String, locale: String, onDevice: Bool, keyterms: Int) {
        // `keyterms` is a COUNT, never the terms. Enough to prove they arrived
        // and to make truncation at 100 visible; not enough to leak vocabulary.
        emit([
            "type": "ready",
            "engine": engine,
            "locale": locale,
            "onDevice": onDevice,
            "keyterms": keyterms,
        ])
        settle()
    }

    func partial(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        emit(["type": "partial", "text": t])
    }

    func final(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        emit(["type": "final", "text": t])
    }

    func error(code: String, message: String, fatal: Bool) {
        emit(["type": "error", "code": code, "message": message, "fatal": fatal])
        if fatal { settle() }
    }

    func log(_ message: String) {
        queue.async {
            if let data = ("callrec-stt: " + message + "\n").data(using: .utf8) {
                try? self.stderrHandle.write(contentsOf: data)
            }
        }
    }

    /// Blocks until every queued line has been written. Called before exit so a
    /// fatal error is never lost to a racing process teardown.
    func flushAndWait() { queue.sync { } }
}
