'use strict';

// NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0, 25 European languages, automatic
// language identification) as sherpa-onnx int8 ONNX files. Same UX as the
// Whisper models: sha256-pinned download from a fixed Hugging Face revision,
// or the files copied in by hand ("Choose model file…" picks any one of them).
// Never falls back to another model: ready means these exact files.

const fs = require('fs');
const path = require('path');
const whisperModels = require('./whisper-models');

const REVISION = '2bda32ec70b097a55adaa07d9a7173915b43cc78';
const BASE_URL = `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/${REVISION}/`;

const MODELS = {
  'parakeet-tdt-0.6b-v3': {
    runtime: 'parakeet',
    folder: 'parakeet-tdt-0.6b-v3-int8',
    short: 'parakeet-v3',
    label: 'Parakeet TDT 0.6B v3, 25 European languages (670 MB)',
    files: [
      { file: 'encoder.int8.onnx', bytes: 652184281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
      { file: 'decoder.int8.onnx', bytes: 11845275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
      { file: 'joiner.int8.onnx', bytes: 6355277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
      { file: 'tokens.txt', bytes: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
    ],
  },
};
for (const m of Object.values(MODELS)) m.bytes = m.files.reduce((n, f) => n + f.bytes, 0);

function sizeOk(file, bytes) {
  try { return fs.statSync(file).size === bytes; } catch { return false; }
}

/// True when `folder` holds every file of `entry` with the published size.
function isComplete(folder, entry) {
  return entry.files.every((f) => sizeOk(path.join(folder, f.file), f.bytes));
}

function status({ dir, id }) {
  const entry = MODELS[id];
  if (!entry) return { engine: 'parakeet', installed: false, ready: false, message: `Unknown model "${id}"` };
  const folder = path.join(dir, entry.folder);
  const installed = isComplete(folder, entry);
  return {
    engine: 'parakeet',
    runtime: 'parakeet',
    installed,
    ready: installed,
    usingFallback: false,
    path: installed ? folder : '',
    name: installed ? entry.folder : '',
    short: entry.short,
    wanted: entry.short,
    source: installed ? 'catalogue' : '',
    message: installed ? `Using ${entry.short} (${entry.folder})` : `${entry.short} not installed`,
    dir: folder,
    id,
    expected: entry.files.map((f) => f.file).join(', '),
    bytes: entry.bytes,
    url: BASE_URL,
  };
}

/// Downloads every file (sha256-checked, atomic per file). Progress is over all bytes.
async function download({ id, dir, fetchImpl, onProgress = () => {}, signal, stallMs, baseUrl = BASE_URL }) {
  const entry = MODELS[id];
  if (!entry) return { error: `Unknown model "${id}"` };
  const folder = path.join(dir, entry.folder);
  let done = 0;
  for (const f of entry.files) {
    if (sizeOk(path.join(folder, f.file), f.bytes)) { done += f.bytes; continue; }
    const res = await whisperModels.download({
      dir: folder, entry: f, baseUrl, fetchImpl, signal, stallMs,
      onProgress: (fraction) => onProgress((done + fraction * f.bytes) / entry.bytes),
    });
    if (res.error) return res;
    done += f.bytes;
  }
  onProgress(1);
  return { ok: true, path: folder, name: entry.folder };
}

/// "Choose model file…": any one of the model's files; the others must sit next to it.
async function importFile(src, dir, id = 'parakeet-tdt-0.6b-v3') {
  const entry = MODELS[id];
  const from = path.dirname(src);
  if (!entry.files.some((f) => f.file === path.basename(src))) {
    return { error: `${path.basename(src)} is not part of ${entry.short} — pick ${entry.files[0].file} (with ${entry.files.slice(1).map((f) => f.file).join(', ')} in the same folder)` };
  }
  const missing = entry.files.filter((f) => !fs.existsSync(path.join(from, f.file))).map((f) => f.file);
  if (missing.length) return { error: `Missing next to it: ${missing.join(', ')}` };
  for (const f of entry.files) {
    if (await whisperModels.sha256File(path.join(from, f.file)) !== f.sha256) return { error: `${f.file} does not match the published checksum (corrupt or incomplete download)` };
  }
  const folder = path.join(dir, entry.folder);
  fs.mkdirSync(folder, { recursive: true });
  for (const f of entry.files) {
    const dest = path.join(folder, f.file);
    if (path.resolve(path.join(from, f.file)) !== path.resolve(dest)) fs.copyFileSync(path.join(from, f.file), dest);
  }
  return { ok: true, path: folder, name: entry.folder };
}

module.exports = { MODELS, REVISION, BASE_URL, status, download, importFile, isComplete };
