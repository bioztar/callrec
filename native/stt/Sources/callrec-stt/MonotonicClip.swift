import Foundation

/// Keeps audio submitted to SpeechAnalyzer strictly time-ordered: buffers that
/// end at/before the last submitted end are dropped, partially overlapping ones
/// lose their overlapping head, and the start never precedes `lastEnd`.
enum MonotonicClip {
    struct Result {
        let start: Double
        let dropFrames: Int
        let newLastEnd: Double
    }

    static func clip(start: Double, frames: Int, lastEnd: Double, rate: Double) -> Result? {
        guard frames > 0 else { return nil }
        let end = start + Double(frames) / rate
        if end <= lastEnd { return nil }
        if start >= lastEnd { return Result(start: start, dropFrames: 0, newLastEnd: end) }
        let drop = Int(((lastEnd - start) * rate).rounded(.up))
        if drop >= frames { return nil }
        let newStart = start + Double(drop) / rate
        return Result(start: newStart, dropFrames: drop, newLastEnd: end)
    }

    /// `--check-monotonic`: feeds overlapping/back-dated buffers and prints the
    /// accepted ranges as JSON; used by test/monotonic.test.js.
    static func selfCheck() -> Never {
        let rate = 16_000.0
        // (start seconds, frames): in order, exact overlap, back-dated pre-roll,
        // fully-before, gap, partial overlap.
        let inputs: [(Double, Int)] = [(0, 1600), (0.1, 1600), (0.05, 1600), (0.0, 800), (0.5, 1600), (0.55, 1600), (0.7, 1600)]
        var last = 0.0
        var accepted: [[String: Double]] = []
        for (start, frames) in inputs {
            guard let r = clip(start: start, frames: frames, lastEnd: last, rate: rate) else { continue }
            last = r.newLastEnd
            accepted.append(["start": r.start, "end": r.newLastEnd])
        }
        if var data = try? JSONSerialization.data(withJSONObject: ["accepted": accepted], options: [.sortedKeys]) {
            data.append(0x0A)
            try? FileHandle.standardOutput.write(contentsOf: data)
        }
        exit(0)
    }
}
