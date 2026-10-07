'use strict';

// Offline end-to-end check of the native helper: synthesises Spanish sentences
// with `say -o` (writes a file, plays NOTHING), pipes them to callrec-stt as
// 16 kHz PCM16 in real time, and asserts every sentence's LAST word survives in
// the finals. Skipped when the helper, `say`, the es-ES voice or the model is missing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { helperPath } = require('../src/native-stt');

const SENTENCES = [
  ['Hola equipo, esta es una prueba de la aplicación de grabación de llamadas', 'llamadas'],
  ['El cliente preguntó por los precios y le dije que enviaremos una propuesta detallada antes de que termine la semana', 'semana'],
  ['Recuerda programar la reunión de seguimiento con el equipo de ingeniería para el próximo lunes', 'lunes'],
];
const RATE = 16000;
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function speechPcm(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callrec-e2e-'));
  const aiff = path.join(dir, 's.aiff');
  const wav = path.join(dir, 's.wav');
  execFileSync('say', ['-v', 'Mónica', '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', aiff, wav]);
  const buf = fs.readFileSync(wav);
  const at = buf.indexOf('data');
  return buf.subarray(at + 8);
}

function ready() {
  try {
    execFileSync('say', ['-v', 'Mónica', '-o', path.join(os.tmpdir(), 'callrec-probe.aiff'), 'hola']);
    const bin = helperPath();
    if (!bin) return 'helper not built';
    const st = JSON.parse(execFileSync(bin, ['--model-status', '--locale', 'es-ES'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('{')));
    return st.analyzer === 'installed' ? '' : 'es-ES model not installed';
  } catch (e) { return `unavailable: ${e.message.split('\n')[0]}`; }
}

function runHelper(pcm) {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const finals = [];
    const errors = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.type === 'final' && m.text) finals.push(m.text);
          if (m.type === 'error') errors.push(m.message);
        } catch { /* ignore */ }
      }
    });
    child.stderr.on('data', (d) => { if (process.env.CALLREC_STT_DEBUG) process.stderr.write(d); });
    child.on('exit', () => resolve({ finals, errors }));
    child.on('error', reject);
    const json = Buffer.from(JSON.stringify({ speaker: 'THEM', locale: 'es-ES', keyterms: [], endpointSilenceMs: 300, maxUtteranceMs: 45000, engine: 'auto' }));
    const len = Buffer.alloc(4); len.writeUInt32LE(json.length);
    child.stdin.write(Buffer.concat([len, json]));
    const chunk = RATE / 10 * 2; // 100 ms
    let off = 0;
    const timer = setInterval(() => {
      if (off >= pcm.length) { clearInterval(timer); child.stdin.end(); return; }
      child.stdin.write(pcm.subarray(off, off + chunk));
      off += chunk;
    }, 100);
  });
}

const skip = ready();

// 1.3 s = normal pauses; 0.5 s = fast turn-taking (next phrase starts before the
// previous one has been flushed — must neither merge nor duplicate text).
for (const gapSec of [1.3, 0.5]) test(`every sentence keeps its last word through the native helper (gap ${gapSec}s)`, { skip: skip || false, timeout: 120000 }, async () => {
  const silence = Buffer.alloc(Math.round(RATE * 2 * gapSec / 2) * 2);
  const parts = [silence];
  SENTENCES.forEach(([text]) => parts.push(speechPcm(text), silence));
  const { finals, errors } = await runHelper(Buffer.concat(parts));
  console.error('finals:', JSON.stringify(finals, null, 1));
  assert.deepEqual(errors, []);
  const joined = norm(finals.join(' | '));
  // Each final must END with its sentence's last word, in order.
  SENTENCES.forEach(([, last]) => assert.ok(joined.includes(last), `last word "${last}" missing from: ${joined}`));
  assert.equal(finals.length, SENTENCES.length, `expected one final per sentence, got ${finals.length}`);
  const ends = finals.map((f) => norm(f).split(' ').pop());
  SENTENCES.forEach(([, last]) => assert.ok(ends.includes(last), `no final ends with "${last}"; endings: ${ends.join(', ')}`));
  // ...and START with its first word ("El cliente" must not become "cliente").
  const starts = finals.map((f) => norm(f).split(' ')[0]);
  SENTENCES.forEach(([text]) => {
    const first = norm(text).split(' ')[0];
    assert.ok(starts.includes(first), `no final starts with "${first}"; starts: ${starts.join(', ')}`);
  });
});
