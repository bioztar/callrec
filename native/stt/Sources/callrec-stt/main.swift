import AVFoundation
import Foundation
import Speech

// callrec-stt — native macOS speech-to-text helper for callrec.
//
//   callrec-stt               stdin: 4-byte LE length + JSON config, then raw
//                             PCM16LE @ 16 kHz mono until EOF.
//                             stdout: one JSON object per line.
//   callrec-stt --selftest    start the engine with defaults, print the `ready`
//                             (or `error`) line, exit. No audio is read.
//   callrec-stt --locales     print the locales this Mac can transcribe, exit.
//
// Protocol: Protocol.swift (mirrored by src/native-stt.js).

let out = OutputWriter()
let args = Array(CommandLine.arguments.dropFirst())

/// 16 kHz mono signed-16-bit — exactly what src/renderer/pcm-worklet.js already
/// produces for Deepgram. Nothing resamples on the JS side for this provider.
guard let inputFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: 16_000,
    channels: 1,
    interleaved: true
) else {
    out.error(code: "audio-format", message: "could not construct the 16 kHz PCM16 input format", fatal: true)
    out.flushAndWait()
    exit(1)
}

// MARK: - --locales

if args.contains("--locales") {
    var supported = SFSpeechRecognizer.supportedLocales().map { $0.identifier }.sorted()
    var installed: [String] = []

    #if !CALLREC_NO_ANALYZER
    if #available(macOS 26.0, *) {
        let semaphore = DispatchSemaphore(value: 0)
        Task.detached {
            let analyzerSupported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
            let analyzerInstalled = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
            supported = Array(Set(supported).union(analyzerSupported)).sorted()
            installed = analyzerInstalled.sorted()
            semaphore.signal()
        }
        semaphore.wait()
    }
    #endif

    let payload: [String: Any] = [
        "type": "locales",
        "supported": supported,
        // Empty on the SFSpeechRecognizer path: that API exposes no installed
        // list, only `supportsOnDeviceRecognition` for one locale at a time.
        "installed": installed,
    ]
    if var data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
        data.append(0x0A)
        try? FileHandle.standardOutput.write(contentsOf: data)
    }
    exit(0)
}

if args.contains("--check-monotonic") { MonotonicClip.selfCheck() }

if args.contains("--model-status") || args.contains("--download-model") {
    runModelMode(args: args)
}

// MARK: - config

let selftest = args.contains("--selftest")
var config = HelperConfig()

if selftest {
    // Allow `--selftest --locale ru-RU` so a permission/model problem can be
    // reproduced for one language without running the app.
    if let index = args.firstIndex(of: "--locale"), index + 1 < args.count {
        config.locale = args[index + 1]
    }
    if let index = args.firstIndex(of: "--engine"), index + 1 < args.count {
        config.engine = args[index + 1]
    }
} else {
    guard let parsed = Stdin.readConfigHeader() else {
        out.error(code: "bad-header", message: "stdin did not begin with a valid length-prefixed JSON config", fatal: true)
        out.flushAndWait()
        exit(2)
    }
    config = parsed
}

// MARK: - engine

let engine: STTEngine
do {
    engine = try makeEngine(config: config, inputFormat: inputFormat, out: out)
    try engine.start()
} catch let error as EngineError {
    out.error(code: error.code, message: error.message, fatal: true)
    out.flushAndWait()
    exit(3)
} catch {
    out.error(code: "start-failed", message: "\(error)", fatal: true)
    out.flushAndWait()
    exit(3)
}

if selftest {
    out.flushAndWait()
    exit(0)
}

// MARK: - run

let coordinator = Coordinator(config: config, engine: engine, out: out, format: inputFormat)

// Blocks on stdin until the main process closes the pipe, which is how a normal
// "stop live" shutdown reaches us. There is no other exit path in normal use.
Stdin.pumpAudio { data in
    coordinator.feed(data)
}

coordinator.finish()
engine.finish()
out.flushAndWait()
exit(0)
