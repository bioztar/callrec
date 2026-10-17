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
function meeting({ offset = 1.5, me = 'spanish.wav', them = '' } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'transcript.md'), DRAFT);
  fs.writeFileSync(path.join(dir, 'transcript.json'), '{"draft":true}\n');
  const rec = new ChannelRecorder(dir);
  const { samples } = readWav(fs.readFileSync(path.join(FIX, me)));
  for (let i = 0; i < samples.length; i += 4000) rec.add('ME', samples.subarray(i, i + 4000), offset);
  if (them) {
    const t = readWav(fs.readFileSync(path.join(FIX, them))).samples;
    for (let i = 0; i < t.length; i += 4000) rec.add('THEM', t.subarray(i, i + 4000), offset + 20);
  }
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

/// Server stand-in whose text depends only on the audio, so any thread count
/// gives the same words; records every spawn.
function fakeServers() {
  const spawned = [];
  const create = (threads) => {
    const srv = { threads, stopped: false, decoded: 0,
      async start() {},
      async transcribe(wav) { srv.decoded += 1; let h = 0; for (const b of wav) h = (h * 31 + b) >>> 0; return { text: `seg ${wav.length}:${h}`, language: '', autoLanguage: true, segments: [] }; },
      stop() { srv.stopped = true; } };
    spawned.push(srv);
    return srv;
  };
  return { spawned, create };
}

const CALL = { me: 'mixed.wav', them: 'english.wav' };

test('final pass: a level change mid-pass re-spawns the engine and yields the same segments as an uninterrupted run', async () => {
  const a = meeting(CALL); const plain = fakeServers();
  const tx1 = fp.adaptiveTranscriber({ create: plain.create, threads: () => 8 });
  await fp.runFinalPass({ dir: a.dir, transcriber: tx1, label: 'x' });
  tx1.stop();
  const want = JSON.parse(fs.readFileSync(path.join(a.dir, 'transcript.json'), 'utf8')).segments;
  assert.ok(want.length >= 2, `fixture should give several segments, got ${want.length}`);
  assert.equal(plain.spawned.length, 1);

  const b = meeting(CALL); const changing = fakeServers();
  let level = 8;
  const tx2 = fp.adaptiveTranscriber({ create: changing.create, threads: () => level });
  let n = 0;
  await fp.runFinalPass({ dir: b.dir, transcriber: tx2, label: 'x', onProgress: (f) => { if (f > 0 && f < 1) { n += 1; if (n === 1) level = 2; } } });
  tx2.stop();
  const got = JSON.parse(fs.readFileSync(path.join(b.dir, 'transcript.json'), 'utf8')).segments;
  assert.deepEqual(got, want);
  assert.deepEqual(changing.spawned.map((s) => s.threads), [8, 2]);
  assert.equal(changing.spawned[0].stopped, true, 'old engine stopped before the new one');
  const decoded = (f) => f.spawned.reduce((k, s) => k + s.decoded, 0);
  assert.equal(decoded(changing), decoded(plain), 'no segment decoded twice or skipped');
  await assert.rejects(tx2.transcribe({ samples: new Int16Array(160) }, {}), /stopped/); // no re-spawn after quit
});

test('final pass with Parakeet: thread change mid-pass gives the same transcript', { skip, timeout: 600000 }, async () => {
  const run = async (threads) => {
    const { dir } = meeting(CALL);
    const tx = fp.adaptiveTranscriber({ create: (t) => new ParakeetServer({ model: MODEL, threads: t, lowPriority: true }), threads });
    try { await fp.runFinalPass({ dir, transcriber: tx, label: 'parakeet-v3' }); } finally { tx.stop(); }
    return JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')).segments;
  };
  const want = await run(() => 2);
  let calls = 0;
  const got = await run(() => (calls++ < 1 ? 1 : 2)); // 1 thread for the first segment, then 2
  assert.deepEqual(got, want);
});

/// The call fixture as a stopped meeting (both channels, Them 0.5 s after Me).
function callMeeting() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'transcript.md'), DRAFT);
  const rec = new ChannelRecorder(dir);
  for (const [spk, f, off] of [['ME', 'me.wav', 0], ['THEM', 'them.wav', 0]]) {
    const { samples } = readWav(fs.readFileSync(path.join(FIX, 'call', f)));
    for (let i = 0; i < samples.length; i += 16000) rec.add(spk, samples.subarray(i, i + 16000), off);
  }
  fp.prepareJob(dir, { meta: { title: 'Call', startedAt: new Date('2026-10-15T10:00:00Z'), durationSec: 246, engine: 'Whisper small', language: 'mixed' }, offsets: rec.close(), language: 'mixed' });
  return dir;
}

test('whisper final pass: packed windows, Them first, echo skipped before decoding, stats + ETA', async () => {
  const dir = callMeeting();
  const order = []; const wins = [];
  let clock = 0;
  const tx = {
    stats: { requests: 0, threads: [{ atSec: 0, threads: 8, level: 100 }] },
    async transcribe() { throw new Error('Whisper path must use packed windows'); },
    async transcribeWindow(w) {
      tx.stats.requests += 1; clock += 4000;
      wins.push(w.samples.length / 16000);
      return w.parts.map((p) => { order.push(p.start); const k = order.length; return { index: p.index, text: `alfa${k} beta${k} gamma${k}` }; });
    },
  };
  const progress = []; const logs = [];
  const job = await fp.runFinalPass({ dir, transcriber: tx, label: 'Whisper large-v3-turbo', whisper: true, now: () => clock, log: (m) => logs.push(m), onProgress: (f, i) => progress.push([f, i.etaSec]) });
  const ref = JSON.parse(fs.readFileSync(path.join(FIX, 'call', 'call.json'), 'utf8'));
  const segs = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')).segments;
  assert.ok(wins.every((s) => s <= 28));
  // Every real line comes back once, from the right speaker, at its own time.
  // (Lines the VAD itself never cut out, e.g. a 0.4 s "Vale.", are not the packer's business.)
  const cut = { ME: fp.utterances(readWav(fs.readFileSync(path.join(FIX, 'call', 'me.wav'))).samples), THEM: fp.utterances(readWav(fs.readFileSync(path.join(FIX, 'call', 'them.wav'))).samples) };
  const heard = (l) => cut[l.speaker].some((u) => u.start < l.end && u.end > l.start);
  for (const l of ref.lines.filter((x) => !x.overlap && heard(x))) {
    const hit = segs.filter((s) => s.speaker === l.speaker && s.start < l.end && s.end > l.start);
    assert.ok(hit.length >= 1, `${l.speaker} ${l.start}: ${l.text}`);
  }
  const texts = segs.map((s) => `${s.speaker} ${s.text}`);
  assert.equal(new Set(texts).size, texts.length, 'no duplicates');
  // The PCM pre-filter is deliberately conservative: a few echo clips (too short
  // to trust, or with any frame louder than the echo would be) still get decoded
  // and are left to the text-level isEcho, which this mock's invented text can't trigger.
  const realMe = (s) => ref.lines.some((l) => l.speaker === 'ME' && s.start < l.end && s.end > l.start);
  const leaked = segs.filter((s) => s.speaker === 'ME' && !realMe(s));
  assert.ok(leaked.length <= 6, `Me echo lines decoded: ${leaked.length}`);
  const st = job.stats;
  assert.equal(fp.readJob(dir).stats.packedWindows, wins.length);
  assert.equal(st.requests, wins.length);
  assert.ok(st.echoSkipped >= 30 && st.echoSkippedSeconds > 60, JSON.stringify(st));
  assert.equal(st.audioSeconds, 245.98);
  assert.equal(st.wallSeconds, wins.length * 4);
  assert.equal(st.rtf, Math.round((st.wallSeconds / st.audioSeconds) * 1000) / 1000);
  assert.deepEqual(st.threads, [{ atSec: 0, threads: 8, level: 100 }]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /final pass done: Whisper large-v3-turbo · 245\.98 s audio .* RTF [\d.]+ · \d+ requests \/ \d+ windows for \d+ utterances · threads 8 \(100%\) · echo skipped [\d.]+ s/);
  assert.equal(progress[0][1], null);
  assert.ok(progress.some(([, eta]) => eta > 0), 'an ETA once there is a measured rate');
  assert.deepEqual(progress[progress.length - 1], [1, 0]);
  // Them's windows were decoded before any of Me's.
  const firstMe = segs.find((s) => s.speaker === 'ME');
  assert.ok(order.indexOf(firstMe.start) > order.indexOf(segs.filter((s) => s.speaker === 'THEM').pop().start));
});

test('parakeet final pass is unchanged: one request per utterance, no pre-echo skip', async () => {
  const dir = callMeeting();
  let n = 0;
  const job = await fp.runFinalPass({ dir, transcriber: { async transcribe() { n += 1; return `frase ${n}`; } }, label: 'Parakeet' });
  assert.equal(job.stats.packedWindows, null);
  assert.equal(job.stats.echoSkipped, 0);
  assert.equal(n, job.stats.utterances);
});
