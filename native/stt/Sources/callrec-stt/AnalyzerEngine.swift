#if !INTERG_NO_ANALYZER

import AVFoundation
import CoreMedia
import Foundation
import Speech

// SpeechAnalyzer / SpeechTranscriber path — the preferred engine on macOS 26+.
//
// Chosen over SFSpeechRecognizer because it is on-device by construction (there
// is no server fallback to be silently dropped into), has no documented
// one-minute audio limit, and is the API Apple is actually developing. Full
// reasoning: docs/native-stt-design.md §5.
//
// THIS FILE HAS NEVER BEEN COMPILED. It was written on Linux against Apple's
// published declarations, not against an SDK. If it does not build, the escape
// hatch is `./build.sh --no-analyzer`, which excludes this file entirely and
// leaves a working SFSpeechRecognizer helper speaking the identical protocol.

@available(macOS 26.0, *)
final class AnalyzerEngine: STTEngine {
    let name = "analyzer"
    let isOnDevice = true // SpeechAnalyzer has no server path

    private let config: HelperConfig
    private let out: OutputWriter
    private let keyterms: [String]
    private let inputFormat: AVAudioFormat

    private let transcriber: SpeechTranscriber
    private let analyzer: SpeechAnalyzer
    private let analyzerFormat: AVAudioFormat
    private let converter: AVAudioConverter?

    private let stream: AsyncStream<AnalyzerInput>
    private let continuation: AsyncStream<AnalyzerInput>.Continuation

    private let lock = NSLock()
    private let timerQueue = DispatchQueue(label: "com.pro7ocol.interg.stt.analyzer")

    /// Finalized text accumulated since the last emitted `final`.
    private var finalBuffer = ""
    /// Volatile text after the last finalized segment, for the partial line.
    private var volatileText = ""
    /// Set on `endUtterance`: the sample time we asked the analyzer to finalize
    /// through. A final result whose range reaches this point completes the
    /// utterance. See the flush race note below.
    private var pendingFlushThrough: CMTime?
    private var flushTimer: DispatchSourceTimer?
    private var clockSeconds: Double = 0

    init(config: HelperConfig, inputFormat: AVAudioFormat, out: OutputWriter) throws {
        self.config = config
        self.out = out
        self.inputFormat = inputFormat
        self.keyterms = config.boundedKeyterms

        try requireSpeechAuthorization()

        let locale = Locale(identifier: config.locale)
        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        self.transcriber = transcriber
        self.analyzer = SpeechAnalyzer(modules: [transcriber])

        // Everything below here is async API reached from a synchronous
        // initializer, so it runs on a detached task and this thread waits.
        // The helper has nothing else to do until setup either succeeds or
        // fails, and failing here is what lets `makeEngine` fall back to
        // SFSpeechRecognizer before any audio is accepted.
        let keyterms = self.keyterms
        let analyzer = self.analyzer
        let setup = AnalyzerEngine.runBlocking { () -> AVAudioFormat in
            // 1. The locale's model has to be present on the machine. The first
            //    run on a new Mac downloads it; later runs return nil here.
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                out.log("downloading the on-device model for \(config.locale) — first run only")
                try await request.downloadAndInstall()
            }
            guard await SpeechTranscriber.installedLocales.contains(where: {
                $0.identifier(.bcp47) == locale.identifier(.bcp47)
            }) else {
                throw EngineError.assetsUnavailable(
                    "No on-device speech model is installed for '\(config.locale)' and it could not be downloaded.")
            }

            // 2. Keyterms. Same list Deepgram gets as Nova-3 `keyterm`.
            if !keyterms.isEmpty {
                let context = AnalysisContext()
                context.contextualStrings[.general] = keyterms
                try await analyzer.setContext(context)
            }

            // 3. The analyzer picks the format it wants; we convert into it.
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
                throw EngineError.unavailable("SpeechAnalyzer offered no compatible audio format.")
            }
            return format
        }

        switch setup {
        case .failure(let error):
            throw error
        case .success(let format):
            self.analyzerFormat = format
        }

        if analyzerFormat == inputFormat {
            self.converter = nil
        } else {
            guard let converter = AVAudioConverter(from: inputFormat, to: analyzerFormat) else {
                throw EngineError.unavailable(
                    "cannot convert 16 kHz PCM16 to the analyzer's format (\(analyzerFormat)).")
            }
            converter.primeMethod = .none
            self.converter = converter
        }

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.stream = stream
        self.continuation = continuation
    }

    func start() throws {
        let analyzer = self.analyzer
        let stream = self.stream
        let started = AnalyzerEngine.runBlocking { () -> Bool in
            try await analyzer.start(inputSequence: stream)
            return true
        }
        if case .failure(let error) = started { throw error }

        consumeResults()
        out.ready(engine: name, locale: config.locale, onDevice: true, keyterms: keyterms.count)
    }

    func beginUtterance() {
        // Nothing to do: SpeechAnalyzer is a continuous session. The VAD's
        // utterance boundaries are applied on the way out, in `endUtterance`.
    }

    func append(_ buffer: AVAudioPCMBuffer, at time: Double) {
        lock.lock()
        clockSeconds = time + Double(buffer.frameLength) / inputFormat.sampleRate
        lock.unlock()

        guard let converted = convert(buffer) else { return }
        let startTime = CMTime(seconds: time, preferredTimescale: 48_000)
        continuation.yield(AnalyzerInput(buffer: converted, bufferStartTime: startTime))
    }

    func endUtterance() {
        lock.lock()
        let through = CMTime(seconds: clockSeconds, preferredTimescale: 48_000)
        pendingFlushThrough = through
        lock.unlock()

        let analyzer = self.analyzer
        Task {
            do {
                // `finalize(through:)` returns once the modules have *published*
                // their finals — not necessarily once we have *consumed* them.
                // So this call does not itself emit anything; the results
                // consumer completes the utterance when it sees a final whose
                // range reaches `through`.
                try await analyzer.finalize(through: through)
            } catch {
                self.out.log("finalize(through:) failed: \(error)")
                self.flushNow(reason: "finalize-error")
            }
        }

        // Safety net for the case where no final ever reaches `through` (a
        // module that publishes nothing for a silent tail). One final per
        // utterance is a contract, not a best effort.
        armFlushTimer(after: 1.2)
    }

    func finish() {
        continuation.finish()
        let analyzer = self.analyzer
        _ = AnalyzerEngine.runBlocking { () -> Bool in
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            return true
        }
        flushNow(reason: "eof")
    }

    // MARK: - results

    private func consumeResults() {
        let transcriber = self.transcriber
        Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self else { return }
                    self.handle(result: result)
                }
            } catch {
                self?.out.error(code: "results-stream", message: "\(error)", fatal: false)
            }
        }
    }

    private func handle(result: SpeechTranscriber.Result) {
        let text = String(result.text.characters)

        lock.lock()
        if result.isFinal {
            appendFinalized(text)
            volatileText = ""
        } else {
            volatileText = text
        }
        let shouldFlush: Bool = {
            guard result.isFinal, let through = pendingFlushThrough else { return false }
            return CMTimeCompare(result.range.end, through) >= 0
        }()
        let line = (finalBuffer + " " + volatileText).trimmingCharacters(in: .whitespaces)
        lock.unlock()

        if !result.isFinal {
            out.partial(line)
            return
        }
        if shouldFlush { flushNow(reason: "finalized-through") }
    }

    /// Caller holds `lock`.
    private func appendFinalized(_ text: String) {
        let piece = text.trimmingCharacters(in: .whitespaces)
        guard !piece.isEmpty else { return }
        finalBuffer = finalBuffer.isEmpty ? piece : finalBuffer + " " + piece
    }

    private func armFlushTimer(after seconds: Double) {
        let timer = DispatchSource.makeTimerSource(queue: timerQueue)
        timer.schedule(deadline: .now() + seconds)
        timer.setEventHandler { [weak self] in self?.flushNow(reason: "flush-timeout") }
        lock.lock()
        flushTimer?.cancel()
        flushTimer = timer
        lock.unlock()
        timer.resume()
    }

    /// Emits the accumulated utterance exactly once, whichever path gets here first.
    private func flushNow(reason: String) {
        lock.lock()
        flushTimer?.cancel()
        flushTimer = nil
        guard pendingFlushThrough != nil else { lock.unlock(); return }
        pendingFlushThrough = nil
        let text = (finalBuffer + " " + volatileText).trimmingCharacters(in: .whitespaces)
        finalBuffer = ""
        volatileText = ""
        lock.unlock()

        if reason == "flush-timeout" { out.log("utterance flushed on the safety timer") }
        out.partial("")
        out.final(text)
    }

    // MARK: - audio conversion

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter else { return buffer }

        let ratio = analyzerFormat.sampleRate / inputFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return nil }

        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return buffer
        }

        if status == .error {
            out.log("audio conversion failed: \(error?.localizedDescription ?? "unknown")")
            return nil
        }
        return output.frameLength > 0 ? output : nil
    }

    // MARK: - async bridge

    /// Runs an async throwing body from a synchronous context and waits for it.
    ///
    /// Only ever called from the helper's main thread during setup and teardown,
    /// never from the audio path — so blocking here costs nothing that matters.
    private static func runBlocking<T>(_ body: @escaping () async throws -> T) -> Result<T, Error> {
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Result<T, Error>!
        Task.detached(priority: .userInitiated) {
            do { outcome = .success(try await body()) } catch { outcome = .failure(error) }
            semaphore.signal()
        }
        semaphore.wait()
        return outcome
    }
}

#endif
