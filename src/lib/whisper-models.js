'use strict';

// Whisper model files: catalogue (pinned sha256), lookup in the models folder,
// first-use download with progress + verification, and import of a manually
// copied file (for networks that block the download host).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

const MODELS = {
  'base-q5_1': {
    file: 'ggml-base-q5_1.bin',
    bytes: 59707625,
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
    label: 'Whisper base, multilingual (60 MB) — fastest, for CPUs with few cores',
    short: 'base',
  },
  'small-q5_1': {
    file: 'ggml-small-q5_1.bin',
    bytes: 190085487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    label: 'Whisper small, multilingual (190 MB) — recommended',
    short: 'small',
  },
  'large-v3-turbo-q5_0': {
    file: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    label: 'Whisper large-v3-turbo, multilingual (574 MB) — the Whisper pick for the final pass',
    short: 'large-v3-turbo',
  },
  'large-v3-q5_0': {
    file: 'ggml-large-v3-q5_0.bin',
    bytes: 1081140203,
    sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1',
    label: 'Whisper large-v3, multilingual (1.1 GB) — similar accuracy, final pass ≈ 1.2× turbo\'s time',
    short: 'large-v3',
  },
};
const DEFAULT_MODEL = 'small-q5_1';

/// small keeps up with live speech from ~8 logical CPUs; below that base does.
function recommendedModel(logicalCpus) {
  return logicalCpus >= 8 ? DEFAULT_MODEL : 'base-q5_1';
}

function modelsDir(userData) { return path.join(userData, 'models'); }

/// ggml model files start with the magic 0x67676d6c ("lmgg" on disk).
function isGgmlFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    return fs.readSync(fd, b, 0, 4, 0) === 4 && b.readUInt32LE(0) === 0x67676d6c;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/// Short human name of a model file: catalogue `short`, else the file name
/// without `ggml-` / `.bin` / quantisation suffix.
function shortName(file) {
  const known = Object.values(MODELS).find((m) => m.file === file);
  if (known) return known.short;
  return String(file).replace(/^ggml-/, '').replace(/\.bin$/, '').replace(/-q\d_\d$/, '');
}

/// The selected model only: an explicitly chosen file, else the catalogue file
/// for `id` in `dir`. Never another model (that is `fallbackModel`). Null when absent.
function resolveModel({ dir, id = DEFAULT_MODEL, chosenPath = '' }) {
  if (chosenPath && isGgmlFile(chosenPath)) return { path: chosenPath, name: path.basename(chosenPath), source: 'chosen' };
  const entry = MODELS[id] || MODELS[DEFAULT_MODEL];
  const want = path.join(dir, entry.file);
  if (isGgmlFile(want)) return { path: want, name: entry.file, source: 'catalogue' };
  return null;
}

/// Some other ggml model in `dir` to record with while the selected one is not
/// installed (catalogue files first, best first). Null when the folder has none.
function fallbackModel(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^ggml-.*\.bin$/.test(n)); } catch { /* no folder yet */ }
  const rank = (n) => { const i = Object.values(MODELS).findIndex((m) => m.file === n); return i < 0 ? -1 : i; };
  names.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
  for (const n of names) {
    const p = path.join(dir, n);
    if (isGgmlFile(p)) return { path: p, name: n, source: 'fallback' };
  }
  return null;
}

/// `installed`: the selected model itself is on disk (Download has nothing to do).
/// `ready`: something can record — the selected model, else a fallback; `path` /
/// `name` are the file that will actually be loaded and `message` says so plainly.
function status({ dir, id = DEFAULT_MODEL, chosenPath = '' }) {
  const validId = MODELS[id] ? id : DEFAULT_MODEL;
  const entry = MODELS[validId];
  const selected = resolveModel({ dir, id: validId, chosenPath });
  const active = selected || fallbackModel(dir);
  const wanted = selected ? shortName(selected.name) : entry.short;
  let message;
  if (selected) message = `Using ${shortName(selected.name)} (${selected.name})`;
  else if (active) message = `${entry.short} not installed — currently using ${shortName(active.name)}`;
  else message = `${entry.short} not installed — no model yet`;
  return {
    engine: 'whisper',
    installed: Boolean(selected),
    ready: Boolean(active),
    usingFallback: Boolean(active && !selected),
    path: active ? active.path : '',
    name: active ? active.name : '',
    short: active ? shortName(active.name) : '',
    wanted,
    source: active ? active.source : '',
    message,
    dir,
    id: validId,
    expected: entry.file,
    bytes: entry.bytes,
    url: BASE_URL + entry.file,
  };
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject);
  });
  return h.digest('hex');
}

/// Downloads model `id` into `dir` via `fetchImpl` (Electron net.fetch in the
/// app, so the system proxy applies). Writes `<file>.part`, checks size and
/// sha256, then renames. `onProgress(fraction)`.
async function download({
  id = DEFAULT_MODEL, dir, fetchImpl, onProgress = () => {}, baseUrl = BASE_URL, entry: override,
  signal, stallMs = 30000,
}) {
  const entry = override || MODELS[id];
  if (!entry) return { error: `Unknown Whisper model "${id}"` };
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, entry.file);
  const part = `${dest}.part`;
  const url = baseUrl + entry.file;
  // Cancel (caller's signal) or no bytes for `stallMs` (a proxy holding the connection) aborts.
  const ctl = new AbortController();
  let why = '';
  const abort = (reason) => { if (!ctl.signal.aborted) { why = reason; ctl.abort(); } };
  const onCancel = () => abort('canceled');
  if (signal) { if (signal.aborted) onCancel(); else signal.addEventListener('abort', onCancel, { once: true }); }
  let stallTimer = null;
  const armStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => abort('stalled'), stallMs); };
  const done = () => { clearTimeout(stallTimer); if (signal) signal.removeEventListener('abort', onCancel); };
  const abortError = () => (why === 'canceled'
    ? { error: 'Download canceled', canceled: true, url }
    : { error: `Download stalled — no data from ${new URL(url).host} for ${Math.round(stallMs / 1000)} s (company proxy?). Download the file elsewhere and use "Choose model file…".`, stalled: true, url });
  let res;
  armStall();
  try { res = await fetchImpl(url, { signal: ctl.signal }); } catch (err) {
    done();
    if (why) return abortError();
    return { error: `Cannot reach ${new URL(url).host} (${err.message}). Download the file elsewhere and use "Choose model file…".`, url };
  }
  if (why) { done(); return abortError(); }
  if (!res.ok || !res.body) { done(); return { error: `Download failed: HTTP ${res.status} from ${new URL(url).host}`, url }; }
  const total = Number(res.headers.get('content-length')) || entry.bytes;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let got = 0;
  let lastTick = 0;
  try {
    const reader = res.body.getReader();
    ctl.signal.addEventListener('abort', () => { reader.cancel().catch(() => {}); }, { once: true });
    for (;;) {
      const { done: end, value } = await reader.read();
      if (why) throw new Error(why);
      if (end) break;
      armStall();
      const chunk = Buffer.from(value);
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (now - lastTick > 150) { lastTick = now; onProgress(Math.min(1, got / total)); }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    done();
    out.destroy();
    fs.rmSync(part, { force: true });
    if (why) return abortError();
    return { error: `Download interrupted: ${err.message}`, url };
  }
  done();
  const digest = hash.digest('hex');
  if (got !== entry.bytes || digest !== entry.sha256) {
    fs.rmSync(part, { force: true });
    return { error: `Downloaded file failed verification (got ${got} bytes, sha256 ${digest.slice(0, 12)}…)`, url };
  }
  fs.renameSync(part, dest);
  onProgress(1);
  return { ok: true, path: dest };
}

/// Copies a user-chosen model file into `dir`. Catalogue files are verified;
/// any other ggml file is accepted as-is (the user picked it on purpose).
async function importFile(src, dir) {
  if (!isGgmlFile(src)) return { error: `${path.basename(src)} is not a whisper.cpp (ggml) model file` };
  const name = path.basename(src);
  const known = Object.values(MODELS).find((m) => m.file === name);
  if (known) {
    const digest = await sha256File(src);
    if (digest !== known.sha256) return { error: `${name} does not match the published checksum (corrupt or incomplete download)` };
  }
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
  return { ok: true, path: dest, name };
}

module.exports = { MODELS, DEFAULT_MODEL, recommendedModel, BASE_URL, modelsDir, isGgmlFile, resolveModel, fallbackModel, shortName, status, download, importFile, sha256File };
