// swift-tools-version:5.9
//
// callrec-stt — native macOS speech-to-text helper for callrec.
// Reads a length-prefixed JSON config plus raw PCM16 on stdin, writes one JSON
// object per line on stdout.
//
// Tools version is 5.9 (not 6.0) deliberately: the --no-analyzer fallback build
// has to work on any reasonably recent toolchain, not only on the Xcode 26 that
// the SpeechAnalyzer path needs. Language mode is pinned to Swift 5 so that
// strict-concurrency diagnostics stay warnings — this source has never been
// compiled, and a warning that can be read is worth more than an error that
// stops the build on the day it is first needed.

import PackageDescription

let package = Package(
    name: "callrec-stt",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "callrec-stt", path: "Sources/callrec-stt"),
    ],
    swiftLanguageVersions: [.v5]
)
