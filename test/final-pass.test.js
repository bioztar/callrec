'use strict';

// Two-pass transcription: Stop → per-channel audio re-transcribed by the Final
// model → transcript.md replaced, live draft kept as transcript.draft.md, and an
// interrupted pass resumes from the persisted queue.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChannelRecorder, readChannel } = require('../src/lib/channel-audio');
const fp = require('../src/lib/final-pass');
const { readWav } = require('../src/lib/wav');
const { ParakeetServer, isAvailable, isParakeetModel } = require('../src/parakeet-stt');

const FIX = path.join(__dirname, 'fixtures');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'callrec-fp-'));
const DRAFT = '# Draft\n\n[00:01] Me: borrador en vivo\n';

/// A stopped meeting: live draft on disk + the mic channel from the Spanish fixture.
function meeting({ offset = 1.5 } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'transcript.md'), DRAFT);
  fs.writeFileSync(path.join(dir, 'transcript.json'), '{"draft":true}\n');
  const rec = new ChannelRecorder(dir);
  const { samples } = readWav(fs.readFileSync(path.join(FIX, 'spanish.wav')));
  for (let i = 0; i < samples.length; i += 4000) rec.add('ME', samples.subarray(i, i + 4000), offset);
  const offsets = rec.close();
  fp.prepareJob(dir, { meta: { title: 'Prueba', startedAt: new Date('2026-10-15T10:00:00Z'), durationSec: 12, engine: 'Whisper small', language: 'mixed' }, offsets, language: 'mixed' });
  return { dir, samples };
}

const fake = (calls = []) => ({ transcribe: async (seg, opts) => { calls.push(opts.language); return `frase ${calls.length}`; } });

test('channel audio: header patched on close; a crash-truncated file is still readable', () => {
  const { dir, samples } = meeting();
  assert.equal(readChannel(path.join(dir, 'audio-me.wav')).length, samples.length);
  assert.deepEqual(readWav(fs.readFileSync(path.join(dir, 'audio-me.wav'))).samples.length, samples.length);
  const rec = new ChannelRecorder(dir);
  rec.add('THEM', new Int16Array([1, 2, 3]), 0);
  assert.deepEqual([...readChannel(path.join(dir, 'audio-them.wav'))], [1, 2, 3]); // not closed yet
});

test('final pass: fixture → final transcript written, draft preserved, timings on the meeting clock, audio removed', async () => {
  const { dir } = meeting();
  const progress = []; const calls = [];
  const job = await fp.runFinalPass({ dir, transcriber: fake(calls), label: 'parakeet-v3', onProgress: (f) => progress.push(f) });
  assert.equal(job.status, 'done');
  assert.ok(calls.length >= 1 && calls.every((l) => l === 'mixed'));
  assert.equal(fs.readFileSync(path.join(dir, 'transcript.draft.md'), 'utf8'), DRAFT);
  assert.equal(fs.readFileSync(path.join(dir, 'transcript.draft.json'), 'utf8'), '{"draft":true}\n');
  const md = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8');
  assert.match(md, /Engine: parakeet-v3 \(final pass; live draft: Whisper small\)/);
  assert.match(md, /\] Me: frase 1/);
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8'));
  assert.ok(json.segments.every((s) => s.speaker === 'ME' && s.start >= 1.5));
  assert.equal(fs.existsSync(path.join(dir, 'audio-me.wav')), false);
  assert.equal(progress[0], 0);
  assert.equal(progress[progress.length - 1], 1);
  assert.ok(progress.some((f) => f > 0 && f < 1));
});

test('final queue: quitting mid-pass keeps the draft and the next launch resumes the pass', async () => {
  const { dir } = meeting();
  const qfile = path.join(tmp(), 'final-queue.json');
  const states = [];
  const crashing = { transcribe: async () => { throw new Error('app quit'); } };
  const q1 = fp.createFinalQueue({ file: qfile, run: (d, onProgress) => fp.runFinalPass({ dir: d, transcriber: crashing, label: 'x', onProgress }), onState: (s) => states.push(s) });
  await q1.add(dir);
  assert.deepEqual(q1.pending(), [dir]);
  assert.equal(fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8'), DRAFT); // untouched
  assert.equal(fp.readJob(dir).status, 'pending');
  assert.ok(fs.existsSync(path.join(dir, 'audio-me.wav')));
  assert.equal(states[states.length - 1], null);
  // Next launch: a new queue reads the same file.
  const done = [];
  const q2 = fp.createFinalQueue({ file: qfile, run: (d, onProgress) => fp.runFinalPass({ dir: d, transcriber: fake(), label: 'parakeet-v3', onProgress }), onDone: (d) => done.push(d) });
  await q2.kick();
  assert.deepEqual(done, [dir]);
  assert.deepEqual(q2.pending(), []);
  assert.equal(fp.readJob(dir).attempts, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'transcript.draft.md'), 'utf8'), DRAFT);
  assert.match(fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8'), /final pass/);
});

test('final queue: gives up after maxAttempts and leaves the draft as the transcript', async () => {
  const { dir } = meeting();
  const q = fp.createFinalQueue({ file: path.join(tmp(), 'q.json'), maxAttempts: 1, run: () => Promise.reject(new Error('no model')) });
  await q.add(dir);
  await q.kick();
  assert.deepEqual(q.pending(), []);
  assert.equal(fp.readJob(dir).status, 'failed');
  assert.equal(fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8'), DRAFT);
});

const MODEL = path.join(__dirname, '..', 'vendor', 'models', 'parakeet-tdt-0.6b-v3-int8');
const missing = !isAvailable() || !isParakeetModel(MODEL) ? 'Parakeet model not fetched' : false;
const skip = missing && process.env.CALLREC_REQUIRE_PARAKEET !== '1' ? missing : false;

test('final pass with Parakeet on the Spanish fixture', { skip, timeout: 300000 }, async () => {
  const { dir } = meeting();
  const server = new ParakeetServer({ model: MODEL });
  await server.start();
  try {
    await fp.runFinalPass({ dir, transcriber: fp.serverTranscriber(server), label: 'parakeet-v3' });
  } finally { server.stop(); }
  const md = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const w of ['prueba', 'grabacion', 'precios', 'propuesta', 'lunes']) assert.ok(md.includes(w), `${w} missing:\n${md}`);
});
