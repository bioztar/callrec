'use strict';

// Pre-decode echo filter on the call fixture: the mic re-hears Them at -18 dB,
// and Me says one real backchannel over Them. Echo is skipped, real speech is not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { preEcho, overlap } = require('../src/lib/echo-pcm');
const { utterances } = require('../src/lib/final-pass');
const { readWav } = require('../src/lib/wav');

const DIR = path.join(__dirname, 'fixtures', 'call');
const read = (f) => readWav(fs.readFileSync(path.join(DIR, f))).samples;
const ref = JSON.parse(fs.readFileSync(path.join(DIR, 'call.json'), 'utf8'));

test('overlap: fraction covered by merged spans', () => {
  assert.equal(overlap(0, 10, [{ start: 2, end: 6 }, { start: 5, end: 8 }]), 0.6);
  assert.equal(overlap(0, 10, [{ start: -5, end: 20 }]), 1);
  assert.equal(overlap(0, 10, []), 0);
});

test('preEcho on the call fixture: echo-only mic clips skipped, every real Me line kept', () => {
  const me = read('me.wav');
  const themSamples = read('them.wav');
  const thems = utterances(themSamples);
  const mine = utterances(me);
  const them = { samples: themSamples, offset: 0 };
  const realMe = ref.lines.filter((l) => l.speaker === 'ME');
  const isReal = (u) => realMe.some((l) => Math.min(u.end, l.end) - Math.max(u.start, l.start) > 0.3);
  const res = mine.map((u) => ({ u, real: isReal(u), r: preEcho(u, them, thems) }));
  const lostReal = res.filter((x) => x.real && x.r.echo);
  assert.deepEqual(lostReal.map((x) => [x.u.start, x.r]), [], 'real speech must never be skipped');
  const echoes = res.filter((x) => !x.real);
  assert.ok(echoes.length > 5, `${echoes.length} echo-only clips in the fixture`);
  const skipped = echoes.filter((x) => x.r.echo).length;
  assert.ok(skipped / echoes.length >= 0.8, `${skipped}/${echoes.length} echo clips skipped`);
  // The backchannel is inside Them speech but louder and on its own rhythm.
  const bc = ref.lines.find((l) => l.overlap);
  const hit = res.find((x) => x.u.start <= bc.start + 0.3 && x.u.end >= bc.end - 0.3);
  assert.ok(hit && !hit.r.echo);
});

test('preEcho: quiet mic speech NOT following Them is kept (energy alone is not enough)', () => {
  const themSamples = read('them.wav');
  const thems = utterances(themSamples);
  const t = thems[3];
  // Me's own Spanish, 20 dB down (a far-away mic), placed fully inside a Them utterance.
  const meOwn = utterances(read('me.wav')).find((u) => u.end - u.start > 2 && u.end - u.start < t.end - t.start);
  const samples = Int16Array.from(meOwn.samples, (x) => Math.round(x / 10));
  const r = preEcho({ start: t.start, end: t.start + samples.length / 16000, samples }, { samples: themSamples, offset: 0 }, thems);
  assert.equal(r.echo, false, JSON.stringify(r));
});

test('preEcho: real speech over an echo clip is kept, even well below the echo level', () => {
  const me = read('me.wav');
  const themSamples = read('them.wav');
  const thems = utterances(themSamples);
  const them = { samples: themSamples, offset: 0 };
  const realMe = ref.lines.filter((l) => l.speaker === 'ME');
  const mine = utterances(me);
  const echoes = mine.filter((u) => !realMe.some((l) => u.start < l.end && u.end > l.start) && preEcho(u, them, thems).echo);
  assert.ok(echoes.length > 5);
  // Me's own words (a real ME line) mixed on top of each skipped echo clip.
  const own = mine.filter((u) => realMe.some((l) => u.start < l.end && u.end > l.start) && u.end - u.start > 3)
    .map((u) => u.samples);
  const peak = own.reduce((m, s) => s.reduce((k, x) => Math.max(k, Math.abs(x)), m), 0);
  for (const dB of [-6, -12, -16, -20, -24]) {
    const g = 10 ** (dB / 20) * 32767 / peak;
    const kept = echoes.filter((e, i) => {
      const o = own[i % own.length];
      const x = Int16Array.from(e.samples, (v, j) => Math.max(-32768, Math.min(32767, Math.round(v + g * (o[j % o.length] || 0)))));
      return !preEcho({ ...e, samples: x }, them, thems).echo;
    });
    assert.equal(kept.length, echoes.length, `${dB} dB: ${echoes.length - kept.length}/${echoes.length} mixed clips wrongly skipped`);
  }
});

test('preEcho: clips under 1 s are never skipped (too few frames to trust a correlation)', () => {
  const themSamples = read('them.wav');
  const thems = utterances(themSamples);
  const t = thems.find((u) => u.end - u.start > 2);
  const i0 = Math.round(t.start * 16000);
  const echo = Int16Array.from(themSamples.subarray(i0, i0 + 14000), (x) => Math.round(x / 8)); // 0.875 s, -18 dB
  const r = preEcho({ start: t.start, end: t.start + 0.875, samples: echo }, { samples: themSamples, offset: 0 }, thems);
  assert.equal(r.echo, false, JSON.stringify(r));
  const long = Int16Array.from(themSamples.subarray(i0, i0 + 32000), (x) => Math.round(x / 8)); // the same echo, 2 s
  assert.equal(preEcho({ start: t.start, end: t.start + 2, samples: long }, { samples: themSamples, offset: 0 }, thems).echo, true);
});
