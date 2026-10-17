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

/// Best Pearson correlation of `a` with `b` delayed by 0..MAX_LAG frames → { corr, lag }.
function bestLag(a, b) {
  let best = { corr: -1, lag: 0 };
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
    if (va > 0 && vb > 0 && num / Math.sqrt(va * vb) > best.corr) best = { corr: num / Math.sqrt(va * vb), lag };
  }
  return best;
}

function envelopeCorrelation(a, b) { return bestLag(a, b).corr; }

/// Share of mic frames clearly louder (> `db` dB) than THEM's envelope predicts
/// at the echo's level: speech of the user's own on top of the echo.
function excess(me, ref, lag, { dbOver = 6, rangeDb = 30 } = {}) {
  const n = Math.min(me.length - lag, ref.length);
  if (n <= 0) return 1;
  let mePeak = -Infinity; let refPeak = -Infinity;
  for (let i = 0; i < n; i += 1) { mePeak = Math.max(mePeak, me[i + lag]); refPeak = Math.max(refPeak, ref[i]); }
  const floor = mePeak - rangeDb; // quieter mic frames are room noise, not speech
  // Echo level: median mic − THEM over frames where both carry speech.
  const d = [];
  for (let i = 0; i < n; i += 1) if (me[i + lag] > floor && ref[i] > refPeak - rangeDb) d.push(me[i + lag] - ref[i]);
  if (!d.length) return 1;
  d.sort((x, y) => x - y);
  const level = d[Math.floor(d.length / 2)];
  let active = 0; let over = 0;
  for (let i = 0; i < n; i += 1) {
    if (me[i + lag] <= floor) continue;
    active += 1;
    if (me[i + lag] - Math.max(ref[i] + level, floor) > dbOver) over += 1;
  }
  return active ? over / active : 0;
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
function preEcho(me, them, themSpans, { minOverlap = 0.8, marginDb = 10, minCorr = 0.9, minSec = 1, maxExcess = 0 } = {}) {
  const cover = overlap(me.start, me.end, themSpans);
  if (cover < minOverlap) return { echo: false, cover };
  // Too few envelope frames to trust a correlation: decode it.
  if (me.end - me.start < minSec) return { echo: false, cover };
  const i0 = Math.max(0, Math.round((me.start - them.offset) * SR));
  const ref = them.samples.subarray(i0, i0 + me.samples.length);
  const gapDb = db(rms(ref)) - db(rms(me.samples));
  if (gapDb < marginDb) return { echo: false, cover, gapDb };
  const a = envelope(me.samples); const b = envelope(ref);
  const { corr, lag } = bestLag(a, b);
  if (corr < minCorr) return { echo: false, cover, gapDb, corr };
  const extra = excess(a, b, lag);
  return { echo: extra <= maxExcess, cover, gapDb, corr, extra };
}

module.exports = { rms, db, envelope, envelopeCorrelation, bestLag, excess, overlap, preEcho };
