#!/usr/bin/env node
'use strict';

// Downloads a catalogue Whisper model (sha256-verified) into vendor/models/ for
// tests and benchmarks. The app itself downloads into the user's app-data folder.
//   node scripts/fetch-model.js [small-q5_1|large-v3-turbo-q5_0]

const path = require('path');
const models = require('../src/lib/whisper-models');

const id = process.argv[2] || models.DEFAULT_MODEL;
const dir = path.join(__dirname, '..', 'vendor', 'models');
const st = models.status({ dir, id });
if (st.ready && st.source === 'catalogue') { console.log(`${st.path} already present`); process.exit(0); }
let last = -1;
models.download({
  id, dir, fetchImpl: fetch,
  onProgress: (f) => { const p = Math.floor(f * 10); if (p !== last) { last = p; process.stdout.write(`${p * 10}% `); } },
}).then((res) => {
  if (res.error) { console.error(`\n${res.error}`); process.exit(1); }
  console.log(`\n${res.path}`);
});
