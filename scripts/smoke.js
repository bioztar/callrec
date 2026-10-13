#!/usr/bin/env node
'use strict';

// Packaged-app smoke test (CI). Launches the built app with the autorun hook in a
// throw-away profile, lets it record CALLREC_AUTORUN_SEC seconds, and checks:
//   - it exits 0 on its own,
//   - the meeting folder has audio.webm, transcript.md, transcript.json,
//   - with Whisper + a fake mic playing test/fixtures/spanish.wav, the transcript contains the expected words,
//   - "Them" lines are reported (they need real system audio playing; --require-them makes them mandatory).
//
//   node scripts/smoke.js <path-to-app-exe> [--model file] [--seconds 25] [--drain 600] [--require-them]

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const exe = args[0];
const seconds = Number(opt('--seconds', '25'));
const drainSec = Number(opt('--drain', '600')); // slow runners need minutes to finish the Whisper queue
const model = opt('--model', path.join(__dirname, '..', 'vendor', 'models', 'ggml-small-q5_1.bin'));
const requireThem = args.includes('--require-them');
if (!exe || !fs.existsSync(exe)) { console.error(`usage: smoke.js <app exe>  (got ${exe})`); process.exit(2); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'callrec-smoke-'));
const userData = path.join(root, 'profile');
const out = path.join(root, 'meetings');
const report = path.join(root, 'report.json');
fs.mkdirSync(path.join(userData, 'models'), { recursive: true });
fs.copyFileSync(model, path.join(userData, 'models', path.basename(model)));
const { MODELS } = require('../src/lib/whisper-models');
const whisperModel = Object.keys(MODELS).find((id) => MODELS[id].file === path.basename(model));
if (!whisperModel) { console.error(`smoke: ${model} is not a catalogue model`); process.exit(2); }
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ outputRoot: out, engine: 'whisper', language: 'es', whisperModel }));

const env = {
  ...process.env,
  CALLREC_AUTORUN_SEC: String(seconds),
  CALLREC_AUTORUN_DRAIN_SEC: String(drainSec),
  CALLREC_AUTORUN_REPORT: report,
  CALLREC_USER_DATA: userData,
  CALLREC_FAKE_MIC_WAV: path.resolve(__dirname, '..', 'test', 'fixtures', 'spanish.wav'),
};
console.log(`smoke: ${exe}\n  profile ${userData}\n  output  ${out}`);
const t0 = Date.now();
const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
child.stderr.on('data', (d) => process.stderr.write(d));
const killer = setTimeout(() => { console.error('smoke: timeout, killing app'); child.kill(); }, (seconds + drainSec + 60) * 1000);

child.on('exit', (code, signal) => {
  clearTimeout(killer);
  const fail = (msg) => { console.error(`SMOKE FAIL: ${msg}`); process.exit(1); };
  console.log(`smoke: app exited code=${code} signal=${signal} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (code !== 0) fail(`exit code ${code}`);
  // A transcription error means queued speech was lost (e.g. the server stopped before the backlog drained).
  if (/"code":"transcribe"/.test(stdout)) fail('Whisper transcription errors in the app log');
  if (!fs.existsSync(report)) fail('no autorun report (app quit before finishing the meeting?)');
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  if (!r.dir) fail(`no meeting folder; renderer log:\n${(r.log || []).join('\n')}`);
  for (const f of ['audio.webm', 'transcript.md', 'transcript.json']) {
    const p = path.join(r.dir, f);
    if (!fs.existsSync(p) || !fs.statSync(p).size) fail(`${f} missing or empty`);
  }
  const t = JSON.parse(fs.readFileSync(path.join(r.dir, 'transcript.json'), 'utf8'));
  const segs = t.segments || [];
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const said = (who) => norm(segs.filter((s) => s.speaker === who).map((s) => s.text).join(' '));
  const audioBytes = fs.statSync(path.join(r.dir, 'audio.webm')).size;
  console.log(`smoke: audio.webm ${audioBytes} bytes, ${segs.length} segments`);
  console.log(fs.readFileSync(path.join(r.dir, 'transcript.md'), 'utf8'));
  // Chromium's fake device may also feed the loopback track, in which case echo
  // dedupe correctly drops the Me copy, so the fixture words may sit under either speaker.
  const me = said('ME');
  const them = said('THEM');
  const hits = ['equipo', 'prueba', 'llamadas', 'cliente', 'precios', 'lunes'].filter((w) => `${me} ${them}`.includes(w));
  if (hits.length < 3) fail(`transcript lacks the spanish.wav words (Me "${me}", Them "${them}")`);
  console.log(`smoke: fixture words ${hits.join(',')} · Me ${me ? `"${me.slice(0, 120)}"` : '(none)'} · Them ${them ? `"${them.slice(0, 120)}"` : '(none)'}`);
  if (requireThem && !them) fail('no Them lines (system audio loopback heard nothing)');
  console.log('SMOKE OK');
});
