#if !CALLREC_NO_ANALYZER

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
    private let timerQueue = DispatchQueue(label: "com.pro7ocol.callrec.stt.analyzer")

    /// Finalized text accumulated since the last emitted `final`.
    private var finalBuffer = ""
    /// Results already produced for the utterance AFTER the one being flushed.
    private var nextFinal = ""
    private var nextVolatile = ""
    /// Volatile text after the last finalized segment, for the partial line.
    private var volatileText = ""
    /// Set on `endUtterance`: the sample time we asked the analyzer to finalize
    /// through. A final result whose range reaches this point completes the
    /// utterance. See the flush race note below.
    private var pendingFlushThrough: CMTime?
    private var flushTimer: DispatchSourceTimer?
    private var clockSeconds: Double = 0
    /// End of the last audio yielded to the analyzer; input must never start before it.
    private var lastEnd: Double = 0
    /// Same, in exact analyzer-format samples (see append).
    private var analyzerLastEndSamples: Int64 = 0
    private var debugCount = 0
    private let debugResults = ProcessInfo.processInfo.environment["CALLREC_STT_DEBUG"] != nil
    /// True once finalize(through:) returned for the pending utterance.
    private var finalizeReturned = false
    private var finalizeTask: Task<Void, Never>?

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
            //    Never downloaded here: the app owns that step (Settings button /
            //    prompt with progress, via --download-model) so it is visible.
            guard await SpeechTranscriber.installedLocales.contains(where: {
                $0.identifier(.bcp47) == locale.identifier(.bcp47)
            }) else {
                throw EngineError.assetsUnavailable(
                    "No on-device speech model is installed for '\(config.locale)'.")
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
        let format = self.analyzerFormat
        let started = AnalyzerEngine.runBlocking { () -> Bool in
            // Load the model before the first audio so the opening words are not
            // recognised while it is still warming up.
            try? await analyzer.prepareToAnalyze(in: format)
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

    func append(_ buffer: AVAudioPCMBuffer, at time: Double) { append(buffer, at: time, isPad: false) }

    /// `isPad`: synthetic trailing silence. It is never clipped and does not move
    /// `lastEnd`, so real speech that starts inside the pad window is not trimmed.
    private func append(_ buffer: AVAudioPCMBuffer, at time: Double, isPad: Bool) {
        lock.lock()
        clockSeconds = time + Double(buffer.frameLength) / inputFormat.sampleRate
        lock.unlock()

        // Real audio is clipped against the end of the last REAL audio: the VAD
        // pre-roll is back-dated and can replay the previous utterance's tail.
        lock.lock()
        let clip: MonotonicClip.Result? = isPad
            ? MonotonicClip.Result(start: time, dropFrames: 0, newLastEnd: lastEnd)
            : MonotonicClip.clip(start: time, frames: Int(buffer.frameLength),
                                 lastEnd: lastEnd, rate: inputFormat.sampleRate)
        if let clip, !isPad { lastEnd = clip.newLastEnd }
        lock.unlock()
        guard let clip else { return }

        var input = buffer
        if clip.dropFrames > 0 {
            guard let trimmed = Coordinator.trimmed(buffer, dropping: clip.dropFrames) else { return }
            input = trimmed
        }
        guard let converted = convert(input) else { return }

        // Second guard, in the analyzer's own sample domain: the input-domain clip
        // above is not enough because conversion rounds frame counts and a CMTime
        // built from seconds rounds again, so a back-to-back buffer can still land
        // a hair before the previous one's end. Work in exact analyzer samples with
        // timescale == analyzer rate; the start can then never precede prior end.
        let rate = analyzerFormat.sampleRate
        lock.lock()
        let wantSamples = Int64((clip.start * rate).rounded())
        let startSamples = analyzerLastEndSamples
        analyzerLastEndSamples = startSamples + Int64(converted.frameLength)
        debugCount += 1
        let n = debugCount
        lock.unlock()
        if n <= 20 || debugResults {
            out.log("[\(config.speaker) ts-debug] #\(n) inRate=\(inputFormat.sampleRate) anRate=\(rate) in=[\(time)-\(time + Double(buffer.frameLength) / inputFormat.sampleRate)] clip=[\(clip.start)] anStart=\(startSamples) anEnd=\(startSamples + Int64(converted.frameLength)) shifted=\(startSamples - wantSamples)")
        }
        // Contiguous mode: no explicit bufferStartTime. Explicit start times with
        // the VAD's silent gaps left the analyzer stalling on the last words of
        // a phrase and are what made "timestamp overlaps" possible at all. The
        // analyzer timeline is simply the samples submitted so far
        // (analyzerLastEndSamples), which is also what `through` uses.
        continuation.yield(AnalyzerInput(buffer: converted))
    }

    /// Trailing silence fed after each utterance. finalize(through:) only
    /// completes — and the tail words only become final — once the analyzer has
    /// seen audio PAST the point being finalized; the VAD stops submitting at
    /// the endpoint, so without this the last words of a phrase sat unfinalized
    /// until (and unless) the next utterance arrived.
    private static let padSeconds = 0.6

    func endUtterance() {
        lock.lock()
        let padStart = lastEnd
        lock.unlock()
        let padFrames = Int(Self.padSeconds * inputFormat.sampleRate)
        if let pad = Coordinator.makeBuffer(samples: [Int16](repeating: 0, count: padFrames), format: inputFormat) {
            append(pad, at: padStart, isPad: true)
        }

        lock.lock()
        let through = CMTime(value: analyzerLastEndSamples, timescale: CMTimeScale(analyzerFormat.sampleRate))
        if debugResults { out.log("endUtterance through=\(through.seconds) (input clock \(clockSeconds))") }
        if pendingFlushThrough != nil {
            // Previous utterance not flushed yet: the parked text is part of this one now.
            if !nextFinal.isEmpty { finalBuffer = finalBuffer.isEmpty ? nextFinal : finalBuffer + " " + nextFinal }
            volatileText = nextVolatile
            nextFinal = ""
            nextVolatile = ""
        }
        pendingFlushThrough = through
        finalizeReturned = false
        lock.unlock()

        // Long safety net, armed BEFORE the task so the task's shorter re-arm wins.
        armFlushTimer(after: 8.0)

        let analyzer = self.analyzer
        let task = Task {
            do {
                // `finalize(through:)` returns once the modules have *published*
                // their finals — not once we have *consumed* them. So the
                // utterance is emitted only after the results stream has been
                // quiet for `quietSeconds` (see handle(result:)); emitting on the
                // first final reaching `through` cut off trailing words that
                // were still in flight.
                try await analyzer.finalize(through: through)
                self.lock.lock()
                self.finalizeReturned = true
                self.lock.unlock()
                self.armFlushTimer(after: Self.quietSeconds)
            } catch {
                self.out.log("finalize(through:) failed: \(error)")
                self.flushNow(reason: "finalize-error")
            }
        }
        lock.lock()
        finalizeTask = task
        lock.unlock()
    }

    func finish() {
        // Let the in-flight finalize(through:) finish first (the silence pad gives
        // it the lookahead it needs); bounded so a stuck analyzer cannot hang stop.
        lock.lock()
        let pendingFinalize = finalizeTask
        lock.unlock()
        if let pendingFinalize {
            let done = DispatchSemaphore(value: 0)
            Task { await pendingFinalize.value; done.signal() }
            if done.wait(timeout: .now() + 6) == .timedOut {
                out.log("finalize(through:) did not return in 6s at end of input")
                pendingFinalize.cancel()
            }
        }
        continuation.finish()
        let analyzer = self.analyzer
        _ = AnalyzerEngine.runBlocking { () -> Bool in
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            return true
        }
        // The results stream ends once everything is published; wait for the
        // consumer to drain it so the last sentence's tail is not lost at EOF.
        _ = resultsDone.wait(timeout: .now() + 8)
        flushNow(reason: "eof", force: true)
    }

    private static let quietSeconds = 0.9
    private let resultsDone = DispatchSemaphore(value: 0)

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
            self?.resultsDone.signal()
        }
    }

    private func handle(result: SpeechTranscriber.Result) {
        let text = String(result.text.characters)
        if debugResults {
            out.log("result final=\(result.isFinal) range=[\(result.range.start.seconds)-\(result.range.end.seconds)] text=\(text)")
        }

        lock.lock()
        // Contiguous timeline: a result starting at/after the pending utterance's
        // `through` belongs to the NEXT utterance. Park it so it is neither merged
        // into this flush nor emitted twice.
        if let through = pendingFlushThrough, result.range.start.seconds >= through.seconds - 0.05 {
            if result.isFinal {
                let piece = text.trimmingCharacters(in: .whitespaces)
                if !piece.isEmpty { nextFinal = nextFinal.isEmpty ? piece : nextFinal + " " + piece }
                nextVolatile = ""
            } else {
                nextVolatile = text
            }
            lock.unlock()
            return
        }
        if result.isFinal {
            appendFinalized(text)
            volatileText = ""
        } else {
            volatileText = text
        }
        // Results still arriving after finalize returned: push the flush back.
        let extendQuiet = pendingFlushThrough != nil && finalizeReturned
        let line = (finalBuffer + " " + volatileText).trimmingCharacters(in: .whitespaces)
        lock.unlock()

        if extendQuiet { armFlushTimer(after: Self.quietSeconds) }
        if !result.isFinal { out.partial(line) }
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
    /// `force` (EOF) emits leftover text even when no utterance flush is pending.
    private func flushNow(reason: String, force: Bool = false) {
        lock.lock()
        flushTimer?.cancel()
        flushTimer = nil
        guard pendingFlushThrough != nil || force else { lock.unlock(); return }
        pendingFlushThrough = nil
        let text = (finalBuffer + " " + volatileText).trimmingCharacters(in: .whitespaces)
        // Whatever the next utterance already produced becomes the new buffer.
        finalBuffer = nextFinal
        volatileText = nextVolatile
        nextFinal = ""
        nextVolatile = ""
        lock.unlock()

        if force && text.isEmpty { return }
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
