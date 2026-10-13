#!/usr/bin/env node
'use strict';

// Whisper speed on this machine: every catalogue model present in vendor/models,
// over the committed fixtures cut into utterances by callrec's own VAD.
// Prints per-model real-time factor (inference seconds / audio seconds; < 1 = faster than real time).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { WhisperServer, binaryPath, defaultThreads } = require('../src/whisper-stt');
const { Segmenter } = require('../src/lib/vad');
const { readWav, pcm16ToWav } = require('../src/lib/wav');
const { MODELS } = require('../src/lib/whisper-models');
const protocol = require('../src/lib/whisper-protocol');

const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const dir = path.join(__dirname, '..', 'vendor', 'models');

function utterances(file) {
  const segs = [];
  const s = new Segmenter({ onSegment: (x) => segs.push(x) });
  s.push(readWav(fs.readFileSync(path.join(FIX, file))).samples);
  s.flush();
  return segs;
}

(async () => {
  const bin = binaryPath();
  if (!bin) throw new Error('whisper-server not built');
  const clips = [['spanish.wav', 'es'], ['mixed.wav', 'mixed'], ['english.wav', 'en']]
    .flatMap(([f, lang]) => utterances(f).map((seg) => ({ f, lang, seg })));
  const audioSec = clips.reduce((n, c) => n + c.seg.end - c.seg.start, 0);
  const cpu = os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown CPU';
  console.log(`| model | load s | inference s for ${audioSec.toFixed(1)} s of speech (${clips.length} utterances) | RTF | longest utterance latency s |`);
  console.log('|---|---|---|---|---|');
  for (const m of Object.values(MODELS)) {
    const model = path.join(dir, m.file);
    if (!fs.existsSync(model)) continue;
    const srv = new WhisperServer({ bin, model });
    const t0 = Date.now();
    await srv.start();
    const load = (Date.now() - t0) / 1000;
    await srv.transcribe(pcm16ToWav(clips[0].seg.samples), { language: 'es' }); // warm-up
    let total = 0; let worst = 0; const texts = [];
    for (const c of clips) {
      const t = Date.now();
      const reply = await srv.transcribe(pcm16ToWav(c.seg.samples), { language: protocol.mode(c.lang).request });
      const dt = (Date.now() - t) / 1000;
      total += dt; worst = Math.max(worst, dt);
      texts.push(`${c.f}: ${(protocol.toFinal(reply, c.seg) || {}).text || ''}`);
    }
    srv.stop();
    console.log(`| ${m.file} | ${load.toFixed(1)} | ${total.toFixed(1)} | ${(total / audioSec).toFixed(2)} | ${worst.toFixed(1)} |`);
    texts.forEach((t) => console.log(`    ${t}`));
  }
  console.log(`\n${cpu}, ${os.cpus().length} logical CPUs, ${defaultThreads()} threads, ${process.platform}-${process.arch}`);
})().catch((err) => { console.error(err.message); process.exit(1); });
