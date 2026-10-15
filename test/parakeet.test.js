'use strict';

// Parakeet TDT 0.6B v3 (sherpa-onnx): model files UX + the adapter on the
// committed Spanish fixture. The real-model test needs vendor/models/parakeet
// (node scripts/fetch-model.js parakeet-tdt-0.6b-v3); CALLREC_REQUIRE_PARAKEET=1
// turns the skip into a failure (CI).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const parakeetModels = require('../src/lib/parakeet-models');
const catalog = require('../src/lib/model-catalog');
const { ParakeetServer, isAvailable, isParakeetModel } = require('../src/parakeet-stt');
const { createEngine } = require('../src/whisper-stt');
const { readWav } = require('../src/lib/wav');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'callrec-pk-'));
const ID = 'parakeet-tdt-0.6b-v3';
const FIX = path.join(__dirname, 'fixtures');

function fakeFiles() {
  return [{ file: 'a.onnx', data: crypto.randomBytes(300) }, { file: 'tokens.txt', data: Buffer.from('x 0\n') }]
    .map((f) => ({ ...f, bytes: f.data.length, sha256: crypto.createHash('sha256').update(f.data).digest('hex') }));
}

function withFakeEntry(files, fn) {
  const real = parakeetModels.MODELS[ID];
  parakeetModels.MODELS[ID] = { ...real, files, bytes: files.reduce((n, f) => n + f.bytes, 0) };
  return Promise.resolve().then(fn).finally(() => { parakeetModels.MODELS[ID] = real; });
}

const fetchFrom = (files, calls) => async (url) => {
  calls.push(url);
  const f = files.find((x) => url.endsWith(`/${x.file}`));
  return new Response(f.data, { status: 200, headers: { 'content-length': String(f.bytes) } });
};

test('parakeet models: pinned revision URLs, sha256 per file, exact files only (no fallback)', async () => {
  const real = parakeetModels.MODELS[ID];
  assert.equal(real.files.length, 4);
  real.files.forEach((f) => assert.match(f.sha256, /^[0-9a-f]{64}$/));
  assert.match(parakeetModels.BASE_URL, /\/resolve\/[0-9a-f]{40}\/$/);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'ggml-small-q5_1.bin'), Buffer.concat([Buffer.from('lmgg'), Buffer.alloc(8)]));
  const st = catalog.status({ dir, id: ID });
  assert.equal(st.installed, false);
  assert.equal(st.ready, false); // a Whisper file in the folder never stands in for Parakeet
  assert.equal(st.message, 'parakeet-v3 not installed');
  await withFakeEntry(fakeFiles(), async () => {
    const files = parakeetModels.MODELS[ID].files;
    const calls = []; const progress = [];
    const res = await catalog.download({ id: ID, dir, fetchImpl: fetchFrom(files, calls), onProgress: (p) => progress.push(p), baseUrl: 'https://example.test/rev/' });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(calls, files.map((f) => `https://example.test/rev/${f.file}`));
    assert.equal(progress[progress.length - 1], 1);
    assert.equal(catalog.status({ dir, id: ID }).installed, true);
    assert.equal(isParakeetModel(res.path), true);
  });
});

test('parakeet models: a corrupt file is rejected, choose-file imports the whole folder', async () => {
  await withFakeEntry(fakeFiles(), async () => {
    const files = parakeetModels.MODELS[ID].files;
    const bad = files.map((f, i) => (i === 0 ? { ...f, data: crypto.randomBytes(f.bytes) } : f));
    const dir = tmp();
    const res = await parakeetModels.download({ id: ID, dir, fetchImpl: fetchFrom(bad, []), baseUrl: 'https://example.test/' });
    assert.match(res.error, /failed verification/);
    assert.equal(parakeetModels.status({ dir, id: ID }).installed, false);
    const src = tmp();
    assert.match((await parakeetModels.importFile(path.join(src, 'nope.bin'), dir)).error, /not part of/);
    fs.writeFileSync(path.join(src, files[0].file), files[0].data);
    assert.match((await parakeetModels.importFile(path.join(src, files[0].file), dir)).error, /Missing next to it: tokens.txt/);
    fs.writeFileSync(path.join(src, files[1].file), files[1].data);
    const ok = await catalog.importFile(path.join(src, files[0].file), dir, ID);
    assert.equal(ok.ok, true, ok.error);
    assert.equal(parakeetModels.status({ dir, id: ID }).installed, true);
  });
});

test('catalog: live + final pickers mark one recommended model; old whisperModel setting migrates', () => {
  assert.equal(catalog.list({ role: 'live' }).filter((m) => m.recommended).length, 1);
  assert.ok(catalog.list({ role: 'final' }).find((m) => m.id === catalog.FINAL_DEFAULT).label.endsWith('(recommended)'));
  assert.deepEqual(catalog.migrate({ whisperModel: 'small-q5_1' }), { liveModel: 'small-q5_1', finalModel: catalog.FINAL_DEFAULT });
  assert.equal(catalog.runtimeOf('large-v3-q5_0'), 'whisper');
  assert.equal(catalog.runtimeOf(ID), 'parakeet');
});

const MODEL = path.join(__dirname, '..', 'vendor', 'models', 'parakeet-tdt-0.6b-v3-int8');
const missing = !isAvailable() ? 'sherpa-onnx not installed' : !isParakeetModel(MODEL) ? 'vendor/models/parakeet-tdt-0.6b-v3-int8 missing (node scripts/fetch-model.js parakeet-tdt-0.6b-v3)' : false;
const skip = missing && process.env.CALLREC_REQUIRE_PARAKEET !== '1' ? missing : false;

test('parakeet adapter: Spanish fixture through the live engine (per-utterance) and a whole-file decode', { skip, timeout: 300000 }, async () => {
  const words = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const finals = [];
  const engine = createEngine({ idleStopMs: 10 });
  const r = engine.start({ id: 'ME', language: 'mixed', modelPath: MODEL }, (m) => { if (m.type === 'final') finals.push(m); });
  assert.equal(r.ok, true);
  const { samples } = readWav(fs.readFileSync(path.join(FIX, 'spanish.wav')));
  engine.chunk('ME', Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  engine.stop('ME');
  await new Promise((resolve) => { const t = setInterval(() => { if (!engine.sessions.size) { clearInterval(t); resolve(); } }, 50); });
  engine.stopAll();
  const live = words(finals.map((f) => f.text).join(' '));
  for (const w of ['prueba', 'aplicacion', 'grabacion', 'cliente', 'precios', 'propuesta', 'lunes']) assert.ok(live.includes(w), `${w} missing in: ${live}`);
  assert.ok(finals.every((f) => f.end > f.start));
  const srv = new ParakeetServer({ model: MODEL });
  await srv.start();
  const whole = await srv.decode(samples);
  srv.stop();
  assert.ok(words(whole.text).includes('proximo lunes'), whole.text);
  assert.ok(whole.timestamps.length > 10);
});
