import Foundation
import Speech

// One-shot maintenance modes so the app can check / fetch an on-device speech
// model itself (Settings button and the automatic prompt), instead of the model
// silently downloading in the middle of a recording.
//
//   callrec-stt --model-status   --locale es-ES   -> {"type":"model-status",...}
//   callrec-stt --download-model --locale es-ES   -> {"type":"progress","fraction":0.4} ... {"type":"model-done"}
//
// Both exit 0 on success. Failures are {"type":"error","fatal":true,...} + exit 3.

private func emitLine(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    data.append(0x0A)
    try? FileHandle.standardOutput.write(contentsOf: data)
}

private func fail(_ message: String) -> Never {
    emitLine(["type": "error", "code": "model-download", "message": message, "fatal": true])
    exit(3)
}

/// SFSpeechRecognizer's view: true when this locale can run on-device.
private func sfOnDevice(_ localeId: String) -> Bool {
    SFSpeechRecognizer(locale: Locale(identifier: localeId))?.supportsOnDeviceRecognition ?? false
}

func runModelMode(args: [String]) -> Never {
    var localeId = "en-US"
    if let index = args.firstIndex(of: "--locale"), index + 1 < args.count { localeId = args[index + 1] }
    let download = args.contains("--download-model")

    #if CALLREC_NO_ANALYZER
    emitLine(["type": "model-status", "locale": localeId, "analyzer": "unavailable", "sf": sfOnDevice(localeId)])
    exit(0)
    #else
    guard #available(macOS 26.0, *) else {
        emitLine(["type": "model-status", "locale": localeId, "analyzer": "unavailable", "sf": sfOnDevice(localeId)])
        exit(0)
    }
    let semaphore = DispatchSemaphore(value: 0)
    Task.detached {
        let locale = Locale(identifier: localeId)
        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        let status = await AssetInventory.status(forModules: [transcriber])
        let label: String
        switch status {
        case .installed: label = "installed"
        case .supported: label = "supported"
        case .downloading: label = "downloading"
        case .unsupported: label = "unsupported"
        @unknown default: label = "unknown"
        }
        if !download {
            emitLine(["type": "model-status", "locale": localeId, "analyzer": label, "sf": sfOnDevice(localeId)])
            semaphore.signal()
            return
        }
        if label == "unsupported" { fail("The on-device engine does not support '\(localeId)'.") }
        do {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                let progress = request.progress
                let poller = Task.detached {
                    while !Task.isCancelled {
                        emitLine(["type": "progress", "fraction": progress.fractionCompleted])
                        try? await Task.sleep(nanoseconds: 500_000_000)
                    }
                }
                try await request.downloadAndInstall()
                poller.cancel()
            }
            emitLine(["type": "progress", "fraction": 1.0])
            emitLine(["type": "model-done", "locale": localeId])
        } catch {
            fail("Model download failed: \(error.localizedDescription)")
        }
        semaphore.signal()
    }
    semaphore.wait()
    exit(0)
    #endif
}
