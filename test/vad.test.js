'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Segmenter } = require('../src/lib/vad');

const RATE = 16000;

/// Silence and noise bursts: [[seconds, amplitude], …] → Int16Array.
function signal(parts) {
  const total = parts.reduce((n, [sec]) => n + Math.round(sec * RATE), 0);
  const out = new Int16Array(total);
  let o = 0;
  let seed = 7;
  for (const [sec, amp] of parts) {
    const n = Math.round(sec * RATE);
    for (let i = 0; i < n; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out[o + i] = amp ? Math.round(((seed / 0x7fffffff) * 2 - 1) * amp * 32767) : 0;
    }
    o += n;
  }
  return out;
}

function run(samples, opts = {}, chunk = 1600) {
  const segs = [];
  const starts = [];
  const seg = new Segmenter({ onSegment: (s) => segs.push(s), onSpeechStart: (t) => starts.push(t), ...opts });
  for (let i = 0; i < samples.length; i += chunk) seg.push(Buffer.from(samples.slice(i, i + chunk).buffer));
  seg.flush();
  return { segs, starts };
}

const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('vad: two utterances → two segments with stream timing (pre-roll + tail)', () => {
  const { segs, starts } = run(signal([[1, 0], [1, 0.3], [1, 0], [2, 0.3], [1, 0]]));
  assert.equal(segs.length, 2);
  near(segs[0].start, 1 - 0.3); near(segs[0].end, 2 + 0.2);
  near(segs[1].start, 3 - 0.3); near(segs[1].end, 5 + 0.2);
  assert.equal(starts.length, 2);
  near(starts[0], 0.7);
  // samples match the reported span exactly
  segs.forEach((s) => near(s.samples.length / RATE, s.end - s.start, 0.001));
});

test('vad: short pause inside an utterance does not split it', () => {
  const { segs } = run(signal([[0.5, 0], [1, 0.3], [0.3, 0], [1, 0.3], [1, 0]]));
  assert.equal(segs.length, 1);
  near(segs[0].end, 2.8 + 0.2);
});

test('vad: clicks shorter than minSpeechMs are dropped; silence yields nothing', () => {
  assert.equal(run(signal([[1, 0], [0.1, 0.5], [1, 0]])).segs.length, 0);
  assert.equal(run(signal([[3, 0]])).segs.length, 0);
});

test('vad: long speech is force-cut at maxMs and continues', () => {
  const { segs } = run(signal([[0.5, 0], [7, 0.3], [1, 0]]), { maxMs: 3000 });
  assert.ok(segs.length >= 3, `got ${segs.length}`);
  segs.forEach((s) => assert.ok(s.end - s.start <= 3.0 + 0.001));
  near(segs[segs.length - 1].end, 7.5 + 0.2);
});

test('vad: flush emits the open utterance; odd-sized and unaligned chunks are fine', () => {
  const samples = signal([[0.5, 0], [1.5, 0.3]]);
  const bytes = Buffer.from(samples.buffer);
  const segs = [];
  const seg = new Segmenter({ onSegment: (s) => segs.push(s) });
  for (let i = 0; i < bytes.length; i += 3202) {
    const piece = Buffer.alloc(Math.min(3202, bytes.length - i) + 1).subarray(1); // unaligned view
    bytes.copy(piece, 0, i, i + piece.length);
    seg.push(piece);
  }
  seg.flush();
  assert.equal(segs.length, 1);
  near(segs[0].end, 2.0, 0.03);
});

test('vad: adapts to a steady noise floor (fan / hiss is not speech)', () => {
  const { segs } = run(signal([[4, 0.01], [1, 0.2], [2, 0.01]]));
  assert.equal(segs.length, 1);
  near(segs[0].start, 4 - 0.3, 0.1);
});
