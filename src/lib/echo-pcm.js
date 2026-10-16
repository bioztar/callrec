'use strict';

// Node-only (final pass): echo check on the audio itself, before decoding.
// A mic utterance that only re-hears the other side is (a) almost entirely
// inside THEM speech, (b) clearly quieter than THEM, and (c) follows THEM's
// loudness envelope (same syllables, a few ms late). All three must hold, so
// real speech over the other side (louder, own rhythm) is still decoded.

const SR = 16000;
const FRAME = 160; // 10 ms
const MAX_LAG = 30; // frames: up to 300 ms of speaker → mic delay

function rms(samples) {
  if (!samples.length) return 0;
  let s = 0;
  for (let i = 0; i < samples.length; i += 1) s += samples[i] * samples[i];
  return Math.sqrt(s / samples.length);
}

const db = (x) => 20 * Math.log10(Math.max(x, 1e-3));

function envelope(samples) {
  const n = Math.floor(samples.length / FRAME);
  const out = new Float64Array(n);
  for (let f = 0; f < n; f += 1) out[f] = db(rms(samples.subarray(f * FRAME, (f + 1) * FRAME)));
  return out;
}

/// Best Pearson correlation of `a` with `b` delayed by 0..MAX_LAG frames.
function envelopeCorrelation(a, b) {
  let best = -1;
  for (let lag = 0; lag <= MAX_LAG; lag += 1) {
    const n = Math.min(a.length - lag, b.length);
    if (n < 20) break;
    let sa = 0; let sb = 0;
    for (let i = 0; i < n; i += 1) { sa += a[i + lag]; sb += b[i]; }
    const ma = sa / n; const mb = sb / n;
    let num = 0; let va = 0; let vb = 0;
    for (let i = 0; i < n; i += 1) {
      const x = a[i + lag] - ma; const y = b[i] - mb;
      num += x * y; va += x * x; vb += y * y;
    }
    if (va > 0 && vb > 0) best = Math.max(best, num / Math.sqrt(va * vb));
  }
  return best;
}

/// Fraction of [start, end] covered by `spans` (merged first).
function overlap(start, end, spans) {
  const len = end - start;
  if (len <= 0) return 0;
  let covered = 0;
  let at = start;
  for (const s of [...spans].sort((x, y) => x.start - y.start)) {
    const a = Math.max(at, s.start); const b = Math.min(end, s.end);
    if (b > a) { covered += b - a; at = b; }
  }
  return covered / len;
}

/// `me`: mic utterance on the call clock ({ start, end, samples });
/// `them`: { samples, offset } of the whole THEM channel; `themSpans`: THEM
/// utterances that produced text, on the call clock. → { echo, ... } (why).
function preEcho(me, them, themSpans, { minOverlap = 0.8, marginDb = 10, minCorr = 0.5 } = {}) {
  const cover = overlap(me.start, me.end, themSpans);
  if (cover < minOverlap) return { echo: false, cover };
  const i0 = Math.max(0, Math.round((me.start - them.offset) * SR));
  const ref = them.samples.subarray(i0, i0 + me.samples.length);
  const gapDb = db(rms(ref)) - db(rms(me.samples));
  if (gapDb < marginDb) return { echo: false, cover, gapDb };
  const corr = envelopeCorrelation(envelope(me.samples), envelope(ref));
  return { echo: corr >= minCorr, cover, gapDb, corr };
}

module.exports = { rms, db, envelope, envelopeCorrelation, overlap, preEcho };
