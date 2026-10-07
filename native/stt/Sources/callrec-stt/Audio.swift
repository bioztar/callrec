import AVFoundation
import Foundation

// stdin framing, energy VAD, and the coordinator that turns a byte stream into
// utterances. All of this is engine-agnostic on purpose: whichever recognizer
// is in use, this is the part that decides where one utterance ends and the
// next begins, and it is shared so both engines produce identical granularity.

// MARK: - stdin

enum Stdin {
    private static let handle = FileHandle.standardInput

    /// Reads exactly `count` bytes, or returns nil at EOF / on error.
    static func readExactly(_ count: Int) -> Data? {
        var out = Data()
        out.reserveCapacity(count)
        while out.count < count {
            guard let chunk = try? handle.read(upToCount: count - out.count), !chunk.isEmpty else {
                return nil
            }
            out.append(chunk)
        }
        return out
    }

    /// Reads the length-prefixed config header: a little-endian UInt32 byte
    /// count followed by that many bytes of UTF-8 JSON.
    ///
    /// Length-prefixed rather than newline-terminated because the audio that
    /// follows on the same descriptor is arbitrary binary that certainly
    /// contains 0x0A bytes.
    static func readConfigHeader() -> HelperConfig? {
        guard let lengthBytes = readExactly(4) else { return nil }
        let b = [UInt8](lengthBytes)
        let length = UInt32(b[0]) | (UInt32(b[1]) << 8) | (UInt32(b[2]) << 16) | (UInt32(b[3]) << 24)
        guard length > 0, length <= 1 << 20 else { return nil }
        guard let json = readExactly(Int(length)) else { return nil }
        return try? JSONDecoder().decode(HelperConfig.self, from: json)
    }

    /// Blocking pump: hands every chunk of audio to `sink` until EOF.
    static func pumpAudio(_ sink: (Data) -> Void) {
        while true {
            guard let chunk = try? handle.read(upToCount: 16 * 1024), !chunk.isEmpty else { return }
            sink(chunk)
        }
    }
}

// MARK: - VAD

/// Energy-based voice activity detection over 20 ms frames of 16 kHz PCM16.
///
/// This exists because neither native API gives us Deepgram's `speech_final`:
/// SFSpeechRecognizer only finalises when the caller ends the request, and
/// SpeechTranscriber finalises on its own cadence rather than on utterance
/// boundaries. See docs/native-stt-design.md §4.
final class EnergyVAD {
    enum Event {
        case speechStart
        case endpoint      // trailing silence closed the utterance
        case forcedCut     // utterance hit maxUtteranceMs and was rotated
    }

    static let frameSamples = 320            // 20 ms @ 16 kHz
    private static let frameMs = 20
    private static let openAfterSpeechMs = 60

    private let endpointSilenceMs: Int
    private let maxUtteranceMs: Int

    /// Adapts to the room: an EMA over frames classified as silence, so a noisy
    /// café and a quiet study both work without a tuning knob.
    private var noiseFloor: Double = 200
    private var inSpeech = false
    private var speechRunMs = 0
    private var silenceRunMs = 0
    private var utteranceMs = 0

    init(endpointSilenceMs: Int, maxUtteranceMs: Int) {
        self.endpointSilenceMs = endpointSilenceMs
        self.maxUtteranceMs = maxUtteranceMs
    }

    /// `frame` must be exactly `frameSamples` long.
    func feed(frame: ArraySlice<Int16>) -> Event? {
        var sum = 0.0
        for sample in frame {
            let v = Double(sample)
            sum += v * v
        }
        let rms = (sum / Double(frame.count)).squareRoot()
        // Absolute floor stops a dead-silent input (noiseFloor decaying toward
        // zero) from classifying its own hiss as speech.
        let threshold = max(noiseFloor * 3.0, 350.0)

        if rms > threshold {
            silenceRunMs = 0
            speechRunMs += Self.frameMs
            if inSpeech { utteranceMs += Self.frameMs }
            if !inSpeech && speechRunMs >= Self.openAfterSpeechMs {
                inSpeech = true
                utteranceMs = speechRunMs
                return .speechStart
            }
            if inSpeech && utteranceMs >= maxUtteranceMs {
                // Rotate rather than run into the documented one-minute limit.
                inSpeech = false
                speechRunMs = 0
                utteranceMs = 0
                return .forcedCut
            }
            return nil
        }

        noiseFloor = (noiseFloor * 0.95) + (rms * 0.05)
        speechRunMs = 0
        silenceRunMs += Self.frameMs
        if inSpeech {
            utteranceMs += Self.frameMs
            if silenceRunMs >= endpointSilenceMs {
                inSpeech = false
                utteranceMs = 0
                return .endpoint
            }
        }
        return nil
    }

    var isInSpeech: Bool { inSpeech }
}

// MARK: - Coordinator

/// Turns the raw stdin byte stream into `beginUtterance` / `append` /
/// `endUtterance` calls on whichever engine is active.
final class Coordinator {
    private let engine: STTEngine
    private let out: OutputWriter
    private let vad: EnergyVAD
    private let format: AVAudioFormat

    /// A PCM16 sample is two bytes; a chunk boundary can land between them.
    private var strayByte: UInt8?
    private var frameBuffer: [Int16] = []

    /// Audio captured just before the VAD opened an utterance. Without it the
    /// first phoneme of every sentence is clipped, which reads as an accuracy
    /// problem but is really a framing one.
    private var preroll: [[Int16]] = []
    private static let prerollFrames = 30    // 600 ms (300 ms still clipped soft Spanish onsets like "El")

    private var utteranceOpen = false
    private var pending: [Int16] = []
    /// Sample clock over ALL input, including silence that is never submitted,
    /// so presentation timestamps stay monotonic across the gaps.
    private var clockSamples: Int64 = 0
    private var pendingStartSamples: Int64 = 0

    private static let flushSamples = 1600   // 100 ms

    init(config: HelperConfig, engine: STTEngine, out: OutputWriter, format: AVAudioFormat) {
        self.engine = engine
        self.out = out
        self.format = format
        self.vad = EnergyVAD(
            endpointSilenceMs: config.endpointSilenceClamped,
            maxUtteranceMs: config.maxUtteranceClamped
        )
    }

    func feed(_ data: Data) {
        var bytes = [UInt8](data)
        if let stray = strayByte {
            bytes.insert(stray, at: 0)
            strayByte = nil
        }
        if bytes.count % 2 == 1 {
            strayByte = bytes.removeLast()
        }
        guard !bytes.isEmpty else { return }

        var samples = [Int16]()
        samples.reserveCapacity(bytes.count / 2)
        var index = 0
        while index + 1 < bytes.count {
            // Little-endian, matching pcm-worklet.js's Int16Array output.
            let value = UInt16(bytes[index]) | (UInt16(bytes[index + 1]) << 8)
            samples.append(Int16(bitPattern: value))
            index += 2
        }

        frameBuffer.append(contentsOf: samples)
        var offset = 0
        while offset + EnergyVAD.frameSamples <= frameBuffer.count {
            let frame = frameBuffer[offset ..< offset + EnergyVAD.frameSamples]
            process(frame: frame)
            offset += EnergyVAD.frameSamples
        }
        if offset > 0 { frameBuffer.removeFirst(offset) }
    }

    private func process(frame: ArraySlice<Int16>) {
        let event = vad.feed(frame: frame)
        let frameStart = clockSamples
        clockSamples += Int64(frame.count)

        switch event {
        case .speechStart:
            utteranceOpen = true
            engine.beginUtterance()
            // Submit the pre-roll first, back-dated so its timestamps precede
            // this frame's.
            let prerollSamples = Int64(preroll.reduce(0) { $0 + $1.count })
            pendingStartSamples = max(0, frameStart - prerollSamples)
            pending = preroll.flatMap { $0 }
            preroll.removeAll(keepingCapacity: true)
            pending.append(contentsOf: frame)

        case .endpoint, .forcedCut:
            if utteranceOpen {
                pending.append(contentsOf: frame)
                flushPending()
                utteranceOpen = false
                engine.endUtterance()
            }
            preroll.removeAll(keepingCapacity: true)
            if event == .forcedCut {
                out.log("utterance hit the duration cap — rotating the recognizer")
            }

        case nil:
            if utteranceOpen {
                if pending.isEmpty { pendingStartSamples = frameStart }
                pending.append(contentsOf: frame)
            } else {
                preroll.append(Array(frame))
                if preroll.count > Self.prerollFrames { preroll.removeFirst() }
            }
        }

        if pending.count >= Self.flushSamples { flushPending() }
    }

    private func flushPending() {
        guard !pending.isEmpty else { return }
        let samples = pending
        let startSeconds = Double(pendingStartSamples) / format.sampleRate
        pending.removeAll(keepingCapacity: true)
        guard let buffer = Coordinator.makeBuffer(samples: samples, format: format) else { return }
        engine.append(buffer, at: startSeconds)
    }

    /// Called once stdin reaches EOF: commit whatever is still open rather than
    /// dropping the last sentence of the call.
    func finish() {
        flushPending()
        if utteranceOpen {
            utteranceOpen = false
            engine.endUtterance()
        }
    }

    /// Copy of `buffer` without its first `count` frames (nil if nothing is left).
    static func trimmed(_ buffer: AVAudioPCMBuffer, dropping count: Int) -> AVAudioPCMBuffer? {
        let keep = Int(buffer.frameLength) - count
        guard keep > 0, let src = buffer.int16ChannelData,
              let out = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: AVAudioFrameCount(keep)),
              let dst = out.int16ChannelData else { return nil }
        out.frameLength = AVAudioFrameCount(keep)
        dst[0].update(from: src[0] + count, count: keep)
        return out
    }

    static func makeBuffer(samples: [Int16], format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.int16ChannelData else { return nil }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            guard let base = source.baseAddress else { return }
            channel[0].update(from: base, count: samples.count)
        }
        return buffer
    }
}
