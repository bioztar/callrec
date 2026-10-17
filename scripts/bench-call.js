#!/usr/bin/env node
'use strict';

// Final-pass benchmark on the 4-minute two-speaker call fixture
// (test/fixtures/call): the real runFinalPass over both channels, as the app
// runs it at "Finalising speed" 100 % (below-normal priority). Whisper runs
// twice: one request per utterance (before) and packed windows + echo
// pre-filter (after). RTF = wall time / call length (1 h call, RTF 1 → 1 h).
//   node scripts/bench-call.js [--models id,id] [--sec 120] [--modes before,after] [--json out.json]

const fs = require('fs');
const os = require('os');
const path = require('path');
const whisperStt = require('../src/whisper-stt');
const catalog = require('../src/lib/model-catalog');
const fp = require('../src/lib/final-pass');
const dial = require('../src/lib/cpu-dial');
const { ChannelRecorder } = require('../src/lib/channel-audio');
const { readWav } = require('../src/lib/wav');
const { wer } = require('../src/lib/wer');

const FIX = path.join(__dirname, '..', 'test', 'fixtures', 'call');
const MODELS = path.join(__dirname, '..', 'vendor', 'models');
const SR = 16000;
const arg = (k, d = '') => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);

function meeting(sec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callrec-bench-'));
  const rec = new ChannelRecorder(dir);
  for (const [spk, f] of [['ME', 'me.wav'], ['THEM', 'them.wav']]) {
    const s = readWav(fs.readFileSync(path.join(FIX, f))).samples.subarray(0, Math.round(sec * SR));
    for (let i = 0; i < s.length; i += SR) rec.add(spk, s.subarray(i, i + SR), 0);
  }
  fp.prepareJob(dir, { meta: { title: 'bench', startedAt: new Date(), durationSec: sec, engine: 'bench', language: 'mixed' }, offsets: rec.close(), language: 'mixed' });
  return dir;
}

(async () => {
  const ref = JSON.parse(fs.readFileSync(path.join(FIX, 'call.json'), 'utf8'));
  const sec = Math.min(Number(arg('--sec', ref.durationSec)), ref.durationSec);
  const lines = ref.lines.filter((l) => l.end <= sec);
  const refText = (spk) => lines.filter((l) => l.speaker === spk).map((l) => l.text).join(' ');
  const want = arg('--models', 'large-v3-turbo-q5_0,large-v3-q5_0,parakeet-tdt-0.6b-v3').split(',');
  const modes = arg('--modes', 'before,after').split(',');
  const threads = dial.threadsFor(100);
  const rows = [];
  console.log(`| model | final pass | RTF (wall / call) | 1 h call takes | requests | windows | echo skipped s | WER Me (es) | WER Them (en) |`);
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const id of want) {
    const st = catalog.status({ dir: MODELS, id });
    if (!st.installed) { console.error(`skip ${id}: not in vendor/models`); continue; }
    const whisper = st.runtime !== 'parakeet';
    for (const mode of whisper ? modes : ['after']) {
      const dir = meeting(sec);
      const tx = fp.adaptiveTranscriber({
        create: (t) => whisperStt.defaultServerFactory({ bin: whisperStt.binaryPath(), model: st.path, threads: t, lowPriority: true }),
        threads: () => threads, level: () => 100,
      });
      // Load + warm up outside the timing (the app keeps the engine for the whole pass).
      await tx.transcribe({ samples: new Int16Array(SR), start: 0, end: 1 }, { language: 'es' });
      tx.stats.requests = 0; tx.stats.threads = [];
      const job = await fp.runFinalPass({ dir, transcriber: tx, label: id, whisper: whisper && mode === 'after' });
      tx.stop();
      const segs = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')).segments;
      const hyp = (spk) => segs.filter((s) => s.speaker === spk).map((s) => s.text).join(' ');
      const s = job.stats;
      const row = { id, mode: whisper ? (mode === 'after' ? 'packed' : 'per utterance') : 'per utterance (unchanged)', threads, ...s, werMe: wer(refText('ME'), hyp('ME')), werThem: wer(refText('THEM'), hyp('THEM')), text: { ME: hyp('ME'), THEM: hyp('THEM') } };
      rows.push(row);
      const pct = (x) => `${(x * 100).toFixed(1)} %`;
      const hours = s.rtf * 60;
      console.log(`| ${st.short || id} | ${row.mode} | **${s.rtf.toFixed(2)}** | ${hours >= 60 ? `${(hours / 60).toFixed(1)} h` : `${Math.round(hours)} min`} | ${s.requests} | ${s.packedWindows ?? '–'} | ${s.echoSkippedSeconds} | ${pct(row.werMe)} | ${pct(row.werThem)} |`);
      fs.rmSync(dir, { recursive: true, force: true });
      if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify({ sec, threads, rows }, null, 2));
    }
  }
  const cpu = os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown CPU';
  const bin = fs.existsSync(path.join(__dirname, '..', 'vendor', 'whisper', 'VERSION')) ? fs.readFileSync(path.join(__dirname, '..', 'vendor', 'whisper', 'VERSION'), 'utf8').trim() : '';
  const machine = `${cpu}, ${os.cpus().length} logical CPUs, ${threads} threads (100 %), ${process.platform}-${process.arch}, ${bin}`;
  console.log(`\n${sec.toFixed(0)} s two-speaker call (test/fixtures/call) · ${machine}`);
  for (const r of rows) console.log(`\n- ${r.id} ${r.mode}: Me: ${r.text.ME}\n  Them: ${r.text.THEM}`);
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ machine, sec, rows }, null, 2));
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
