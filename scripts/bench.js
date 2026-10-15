#!/usr/bin/env node
'use strict';

// Model benchmark on this machine: every catalogue model present in
// vendor/models (Whisper ggml files, Parakeet folder) over the committed
// fixtures, cut into utterances exactly as the final pass does. Prints WER per
// fixture and real-time factor (inference s / audio s; < 1 = faster than real time).
//   node scripts/bench.js [--json out.json]

const fs = require('fs');
const os = require('os');
const path = require('path');
const whisperStt = require('../src/whisper-stt');
const catalog = require('../src/lib/model-catalog');
const { utterances, serverTranscriber } = require('../src/lib/final-pass');
const { readWav } = require('../src/lib/wav');
const { wer } = require('../src/lib/wer');

const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const dir = path.join(__dirname, '..', 'vendor', 'models');
const ES1 = 'Hola equipo, esta es una prueba de la aplicación de grabación de llamadas.';
const EN = "Let's schedule the follow-up meeting with the engineering team for next Monday.";
const FIXTURES = [
  { file: 'spanish.wav', lang: 'es', ref: `${ES1} El cliente preguntó por los precios y le enviaremos una propuesta el próximo lunes.` },
  { file: 'english.wav', lang: 'en', ref: EN },
  { file: 'mixed.wav', lang: 'mixed', ref: `${ES1} ${EN}` },
];

(async () => {
  const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : '';
  const clips = FIXTURES.map((f) => ({ ...f, segs: utterances(readWav(fs.readFileSync(path.join(FIX, f.file))).samples) }));
  const audioSec = clips.reduce((n, c) => n + c.segs.reduce((m, s) => m + s.end - s.start, 0), 0);
  const rows = [];
  console.log(`| model | runtime | WER es | WER en | WER mixed | mean WER | RTF | slowest utterance s | load s |`);
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const m of catalog.list()) {
    const st = catalog.status({ dir, id: m.id });
    if (!st.installed) continue;
    if (m.runtime === 'whisper' && !whisperStt.binaryPath()) continue;
    const srv = whisperStt.defaultServerFactory({ bin: whisperStt.binaryPath(), model: st.path });
    const t0 = Date.now();
    await srv.start();
    const load = (Date.now() - t0) / 1000;
    const tx = serverTranscriber(srv);
    await tx.transcribe(clips[0].segs[0], { language: 'es' }); // warm-up
    let total = 0; let worst = 0;
    const wers = {}; const texts = {};
    for (const c of clips) {
      const out = [];
      for (const seg of c.segs) {
        const t = Date.now();
        out.push((await tx.transcribe(seg, { language: c.lang })) || '');
        const dt = (Date.now() - t) / 1000;
        total += dt; worst = Math.max(worst, dt);
      }
      texts[c.lang] = out.join(' ');
      wers[c.lang] = wer(c.ref, texts[c.lang]);
    }
    srv.stop();
    const mean = (wers.es + wers.en + wers.mixed) / 3;
    const pct = (x) => `${(x * 100).toFixed(1)} %`;
    const row = { id: m.id, runtime: m.runtime, wer: wers, meanWer: mean, rtf: total / audioSec, worstSec: worst, loadSec: load, texts };
    rows.push(row);
    console.log(`| ${m.short} | ${m.runtime === 'parakeet' ? 'sherpa-onnx int8' : 'whisper.cpp'} | ${pct(wers.es)} | ${pct(wers.en)} | ${pct(wers.mixed)} | **${pct(mean)}** | ${row.rtf.toFixed(2)} | ${worst.toFixed(1)} | ${load.toFixed(1)} |`);
  }
  for (const r of rows) Object.entries(r.texts).forEach(([l, t]) => console.log(`\n- ${r.id} ${l}: ${t}`));
  const cpu = os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown CPU';
  const machine = `${cpu}, ${os.cpus().length} logical CPUs, ${whisperStt.defaultThreads()} threads, ${process.platform}-${process.arch}`;
  console.log(`\n${audioSec.toFixed(1)} s of speech in ${clips.reduce((n, c) => n + c.segs.length, 0)} utterances · ${machine}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ machine, audioSec, rows }, null, 2));
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
