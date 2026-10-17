'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pack, split, toOriginal } = require('../src/lib/whisper-pack');
const { utterances } = require('../src/lib/final-pass');
const { readWav } = require('../src/lib/wav');

const SR = 16000;
const seg = (start, sec) => ({ start, end: start + sec, samples: new Int16Array(Math.round(sec * SR)).fill(1) });

test('pack: windows ≤ 28 s, gaps trimmed to ≤ 0.4 s, every utterance once in order', () => {
  const segs = [seg(0, 5), seg(5.1, 6), seg(13, 8), seg(30, 9), seg(40, 27), seg(70, 2)];
  const wins = pack(segs);
  for (const w of wins) assert.ok(w.samples.length / SR <= 28 + 1e-9, `${w.samples.length / SR} s`);
  assert.deepEqual(wins.flatMap((w) => w.parts.map((p) => p.index)), [0, 1, 2, 3, 4, 5]);
  const [a] = wins;
  assert.equal(a.parts[1].at, 5 + 0.1); // short gap kept as is
  assert.equal(a.parts[2].at, 5.1 + 6 + 0.4); // 2 s gap trimmed to 0.4 s
  assert.equal(a.samples.length, Math.round((5 + 0.1 + 6 + 0.4 + 8) * SR));
  assert.equal(wins.length, 4); // [0,1,2] 19.5 s, [3] (+27 would overflow), [4], [5]
});

test('pack: offsets round-trip (window time → channel time)', () => {
  const segs = [seg(2, 3), seg(9, 4), seg(13.2, 2)];
  const [w] = pack(segs);
  for (const p of w.parts) {
    assert.equal(toOriginal(w, p.at), segs[p.index].start);
    assert.ok(Math.abs(toOriginal(w, p.at + p.len) - segs[p.index].end) < 1e-6);
    assert.ok(Math.abs(toOriginal(w, p.at + 1.25) - (segs[p.index].start + 1.25)) < 1e-6);
  }
});

test('split: each word goes to exactly one utterance by its time', () => {
  const [w] = pack([seg(0, 3), seg(10, 3), seg(20, 3)]); // parts at 0, 3.4, 6.8
  const words = [
    [' hola', 0.2, 0.6], [' equipo', 0.7, 2.9], [' buenos', 3.3, 3.8], [' días', 4, 6.1],
    [' adiós', 6.9, 9.5],
  ];
  const reply = {
    segments: [
      { text: ' hola equipo buenos', start: 0, end: 3.8, words: words.slice(0, 3).map(([word, start, end]) => ({ word, start, end })) },
      { text: ' días adiós', start: 4, end: 9.5, words: words.slice(3).map(([word, start, end]) => ({ word, start, end })) },
      { text: ' ruido', start: 9.5, end: 10.2, no_speech_prob: 0.9, avg_logprob: -2, words: [{ word: ' ruido', start: 9.5, end: 10.2 }] },
    ],
  };
  const out = split(w, reply, { keep: (s) => !(s.no_speech_prob > 0.8 && s.avg_logprob < -1) });
  assert.deepEqual(out, [
    { index: 0, text: 'hola equipo' }, { index: 1, text: 'buenos días' }, { index: 2, text: 'adiós' },
  ]);
  // Without word times a segment goes to the utterance under its midpoint.
  const coarse = split(w, { segments: [{ text: ' uno', start: 0, end: 2 }, { text: ' dos', start: 7, end: 9 }] });
  assert.deepEqual(coarse.map((p) => p.text), ['uno', '', 'dos']);
});

test('pack: the call fixture (no word lost or doubled across windows)', () => {
  const { samples } = readWav(fs.readFileSync(path.join(__dirname, 'fixtures', 'call', 'them.wav')));
  const segs = utterances(samples);
  const wins = pack(segs);
  assert.ok(wins.length < segs.length / 2, `${wins.length} windows for ${segs.length} utterances`);
  const speech = segs.reduce((n, s) => n + s.samples.length, 0);
  const packed = wins.reduce((n, w) => n + w.parts.reduce((m, p) => m + Math.round(p.len * SR), 0), 0);
  assert.equal(packed, speech);
  // One fake "word" per second of each utterance survives the split exactly once.
  const words = [];
  const out = wins.flatMap((w) => {
    const ws = w.parts.flatMap((p) => Array.from({ length: Math.floor(p.len) }, (_, k) => {
      const id = `w${p.index}_${k}`; words.push(id);
      return { word: ` ${id}`, start: p.at + k + 0.2, end: p.at + k + 0.8 };
    }));
    return split(w, { segments: [{ text: '', start: 0, end: 28, words: ws }] });
  });
  const got = out.flatMap((o) => o.text.split(' ').filter(Boolean));
  assert.deepEqual(got, words);
  for (const o of out) assert.ok(o.text.split(' ').filter(Boolean).every((id) => id.startsWith(`w${o.index}_`)));
});

test('packed window: a merged segment without word times → those utterances are re-decoded alone, none comes back empty', async () => {
  const { serverTranscriber } = require('../src/lib/final-pass');
  const { timedWords } = require('../src/lib/whisper-pack');
  const sec = (s) => new Int16Array(Math.round(s * 16000)).fill(1000);
  const segs = [{ samples: sec(2), start: 0, end: 2 }, { samples: sec(3), start: 3, end: 6 }, { samples: sec(2), start: 7, end: 9 }];
  const [win] = require('../src/lib/whisper-pack').pack(segs);
  const calls = [];
  const fake = (merged) => ({
    async transcribe(wav) {
      const sec2 = (wav.length - 44) / 2 / 16000;
      calls.push(sec2);
      if (sec2 > 5) return { language: 'es', segments: merged };
      return { language: 'es', segments: [{ start: 0, end: sec2, text: `solo ${Math.round(sec2)} s` }] };
    },
  });
  // Whisper folded all three utterances into one segment and sent no words.
  const merged = [{ start: 0, end: 7.8, text: 'uno dos tres cuatro cinco seis' }];
  assert.equal(timedWords({ segments: merged }), false);
  const stats = { requests: 0 };
  let out = await serverTranscriber(fake(merged), stats).transcribeWindow(win, { language: 'es' });
  assert.deepEqual(out.map((p) => p.text), ['solo 2 s', 'solo 3 s', 'solo 2 s']);
  assert.equal(stats.soloRedecodes, 3);
  // With word times, words are split by time; an utterance that gets no words is re-decoded.
  calls.length = 0;
  const timed = [{ start: 0, end: 5, text: 'uno dos', words: [{ word: ' uno', start: 0.5, end: 1 }, { word: ' dos', start: 3, end: 3.5 }] }];
  const st2 = { requests: 0 };
  out = await serverTranscriber(fake(timed), st2).transcribeWindow(win, { language: 'es' });
  assert.deepEqual(out.map((p) => p.text), ['uno', 'dos', 'solo 2 s']);
  assert.equal(st2.soloRedecodes, 1);
});
