'use strict';

// Whisper adapter: protocol mapping, segment timing and per-utterance language
// switching against a fake whisper-server, then the real thing on the committed
// fixtures when the whisper-server binary and model are present (CI builds them;
// CALLREC_REQUIRE_WHISPER=1 turns the skip into a failure).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createEngine, binaryPath } = require('../src/whisper-stt');
const protocol = require('../src/lib/whisper-protocol');
const { readWav, pcm16ToWav } = require('../src/lib/wav');
const { status: modelStatus, modelsDir } = require('../src/lib/whisper-models');

const FIX = path.join(__dirname, 'fixtures');
const RATE = 16000;

function feed(engine, id, samples, chunk = 1600) {
  for (let i = 0; i < samples.length; i += chunk) engine.chunk(id, Buffer.from(samples.slice(i, i + chunk).buffer));
}

/// Starts a session, feeds `samples` (+1 s of silence), stops, resolves with all events.
function transcribeWith(engine, { id = 'THEM-1', language, samples, modelPath }) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => reject(new Error(`timeout; events: ${JSON.stringify(events)}`)), 240000);
    const res = engine.start({ id, language, modelPath }, (m) => {
      events.push(m);
      if (m.type === 'ready') {
        feed(engine, id, samples);
        feed(engine, id, new Int16Array(RATE));
        engine.stop(id);
      }
      if (m.type === 'done' || (m.type === 'error' && m.fatal)) { clearTimeout(timer); resolve(events); }
    });
    if (res.error) { clearTimeout(timer); reject(new Error(res.error)); }
  });
}

function tone(sec, amp) {
  const out = new Int16Array(Math.round(sec * RATE));
  for (let i = 0; i < out.length; i += 1) out[i] = amp ? Math.round(Math.sin(i / 7) * amp * 32767 * (0.6 + 0.4 * Math.sin(i / 900))) : 0;
  return out;
}
function concat(parts) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- protocol mapping (pure) ----

test('whisper protocol: language modes', () => {
  assert.equal(protocol.mode('es').request, 'es');
  assert.equal(protocol.mode('en').request, 'en');
  assert.equal(protocol.mode('mixed').request, 'auto');
  assert.equal(protocol.mode('nope').request, 'es');
  assert.equal(protocol.langCode('spanish'), 'es');
  assert.equal(protocol.langCode('English'), 'en');
  assert.equal(protocol.langCode('es'), 'es');
  assert.equal(protocol.langCode(''), '');
});

test('whisper protocol: verbose_json → final with stream timing, cleaned text', () => {
  const reply = { language: 'spanish', text: ' [Música] Hola equipo. ', segments: [
    { text: ' [Música] Hola equipo.', no_speech_prob: 0.01, avg_logprob: -0.2 },
    { text: ' Adiós.', no_speech_prob: 0.02, avg_logprob: -0.3 },
  ] };
  assert.deepEqual(protocol.toFinal(reply, { start: 12.3456, end: 15.0 }), {
    type: 'final', text: 'Hola equipo. Adiós.', start: 12.35, end: 15, lang: 'es',
  });
});

test('whisper protocol: silence, annotations and stock hallucinations are dropped', () => {
  const seg = { start: 0, end: 1.5 };
  assert.equal(protocol.toFinal({ language: 'spanish', text: ' [Música]', segments: [] }, seg), null);
  assert.equal(protocol.toFinal({ language: 'spanish', segments: [{ text: ' ¡Suscríbete!' }] }, seg), null);
  assert.equal(protocol.toFinal({ language: 'english', segments: [{ text: ' Thank you for watching.' }] }, seg), null);
  assert.equal(protocol.toFinal({ language: 'spanish', segments: [{ text: ' hola', no_speech_prob: 0.95, avg_logprob: -1.5 }] }, seg), null);
  assert.equal(protocol.toFinal({ language: 'spanish', segments: [{ text: ' ...' }] }, seg), null);
  // A long clip may really say "gracias".
  assert.equal(protocol.toFinal({ language: 'spanish', segments: [{ text: ' Gracias.' }] }, { start: 0, end: 6 }).text, 'Gracias.');
});

test('whisper protocol: mixed mode retries languages it does not allow', () => {
  assert.equal(protocol.needsRetry({ language: 'catalan' }, 'mixed'), true);
  assert.equal(protocol.needsRetry({ language: 'english' }, 'mixed'), false);
  assert.equal(protocol.needsRetry({ language: 'catalan' }, 'es'), false);
});

// ---- engine against a fake server ----

test('whisper engine: ready → partial at speech start → finals in order with timing → done', async () => {
  const calls = [];
  const engine = createEngine({
    transcribe: async (wav, { language }) => {
      const { samples } = readWav(wav);
      calls.push({ language, sec: samples.length / RATE });
      return { language: 'spanish', segments: [{ text: ` frase ${calls.length}` }] };
    },
  });
  const samples = concat([tone(1, 0), tone(1, 0.3), tone(1, 0), tone(1.5, 0.3), tone(0.5, 0)]);
  const events = await transcribeWith(engine, { language: 'es', samples });
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'ready');
  assert.equal(types[types.length - 1], 'done');
  assert.ok(types.indexOf('partial') < types.indexOf('final'));
  const finals = events.filter((e) => e.type === 'final');
  assert.deepEqual(finals.map((f) => f.text), ['frase 1', 'frase 2']);
  assert.ok(Math.abs(finals[0].start - 0.7) < 0.05 && Math.abs(finals[0].end - 2.2) < 0.05, JSON.stringify(finals[0]));
  assert.ok(Math.abs(finals[1].start - 2.7) < 0.05 && Math.abs(finals[1].end - 4.7) < 0.05, JSON.stringify(finals[1]));
  assert.ok(finals.every((f) => f.lang === 'es' && f.id === 'THEM-1'));
  assert.deepEqual(calls.map((c) => c.language), ['es', 'es']);
});

test('whisper engine: mixed language switches per utterance; disallowed language is redone in Spanish', async () => {
  const replies = [{ language: 'spanish', text: 'hola equipo' }, { language: 'english', text: 'next Monday' }, { language: 'catalan', text: 'bon dia' }, { language: 'spanish', text: 'buen día' }];
  const asked = [];
  const engine = createEngine({ transcribe: async (_wav, { language }) => { asked.push(language); return replies.shift(); } });
  const samples = concat([tone(0.5, 0), tone(1, 0.3), tone(1, 0), tone(1, 0.3), tone(1, 0), tone(1, 0.3), tone(1, 0)]);
  const events = await transcribeWith(engine, { language: 'mixed', samples });
  const finals = events.filter((e) => e.type === 'final');
  assert.deepEqual(finals.map((f) => [f.lang, f.text]), [['es', 'hola equipo'], ['en', 'next Monday'], ['es', 'buen día']]);
  assert.deepEqual(asked, ['auto', 'auto', 'auto', 'es']);
});

test('whisper engine: transcription failure is a non-fatal error and the session still drains', async () => {
  let n = 0;
  const engine = createEngine({ transcribe: async () => { n += 1; if (n === 1) throw new Error('boom'); return { language: 'english', text: 'ok' }; } });
  const events = await transcribeWith(engine, { language: 'en', samples: concat([tone(1, 0.3), tone(1, 0), tone(1, 0.3)]) });
  assert.deepEqual(events.filter((e) => e.type === 'error').map((e) => [e.fatal, e.message]), [[false, 'boom']]);
  assert.deepEqual(events.filter((e) => e.type === 'final').map((e) => e.text), ['ok']);
  assert.equal(events[events.length - 1].type, 'done');
});

test('whisper engine: missing model or binary is reported up front, not mid-call', () => {
  const engine = createEngine();
  assert.equal(engine.start({ id: 'x', language: 'es' }, () => {}).code, 'model-missing');
});

test('wav: round trip', () => {
  const s = tone(0.1, 0.5);
  const back = readWav(pcm16ToWav(s, RATE));
  assert.equal(back.sampleRate, RATE);
  assert.deepEqual(Array.from(back.samples), Array.from(s));
});

// ---- the real whisper-server on committed fixtures ----

function realSetup() {
  const bin = binaryPath();
  const modelPath = process.env.CALLREC_WHISPER_MODEL
    || modelStatus({ dir: path.join(__dirname, '..', 'vendor', 'models') }).path
    || modelStatus({ dir: modelsDir(path.join(require('os').homedir(), '.callrec-test')) }).path;
  if (!bin) return { skip: 'whisper-server not built (npm run build:whisper)' };
  if (!modelPath) return { skip: 'no Whisper model (npm run fetch:model)' };
  return { bin, modelPath };
}
const real = realSetup();
const skip = real.skip && process.env.CALLREC_REQUIRE_WHISPER !== '1' ? real.skip : false;
const norm = protocol.normalize;

test('whisper real: Spanish fixture → expected words, Spanish, timings inside the clip', { skip }, async (t) => {
  assert.ok(!real.skip, real.skip);
  const engine = createEngine({ log: (m) => t.diagnostic(m) });
  const { samples } = readWav(fs.readFileSync(path.join(FIX, 'spanish.wav')));
  const t0 = Date.now();
  const events = await transcribeWith(engine, { language: 'es', samples, modelPath: real.modelPath });
  const wall = (Date.now() - t0) / 1000;
  engine.stopAll();
  const finals = events.filter((e) => e.type === 'final');
  const text = norm(finals.map((f) => f.text).join(' '));
  t.diagnostic(`model ${path.basename(real.modelPath)}: ${(samples.length / RATE).toFixed(1)} s audio in ${wall.toFixed(1)} s (incl. load) → "${text}"`);
  assert.equal(events.filter((e) => e.type === 'error').length, 0, JSON.stringify(events));
  for (const w of ['equipo', 'prueba', 'llamadas', 'cliente', 'precios', 'propuesta', 'lunes']) assert.ok(text.includes(w), `missing "${w}" in "${text}"`);
  assert.ok(finals.length >= 2, 'one final per sentence');
  finals.forEach((f) => { assert.equal(f.lang, 'es'); assert.ok(f.start >= 0 && f.end > f.start && f.end <= samples.length / RATE + 0.01); });
});

test('whisper real: mixed fixture switches Spanish → English between utterances', { skip }, async (t) => {
  assert.ok(!real.skip, real.skip);
  const engine = createEngine({ log: (m) => t.diagnostic(m) });
  const { samples } = readWav(fs.readFileSync(path.join(FIX, 'mixed.wav')));
  const events = await transcribeWith(engine, { language: 'mixed', samples, modelPath: real.modelPath });
  engine.stopAll();
  const finals = events.filter((e) => e.type === 'final');
  t.diagnostic(finals.map((f) => `[${f.lang} ${f.start}-${f.end}] ${f.text}`).join(' | '));
  assert.deepEqual(finals.map((f) => f.lang), ['es', 'en']);
  assert.ok(norm(finals[0].text).includes('llamadas'));
  assert.ok(norm(finals[1].text).includes('engineering'));
  assert.ok(norm(finals[1].text).includes('monday'));
});
